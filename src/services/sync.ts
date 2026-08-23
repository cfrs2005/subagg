/**
 * 订阅同步：抓取 → 解析 → 入库 → 记录流量快照。
 *
 * ## 一条贯穿全文件的原则：失败时保留旧数据
 *
 * 机场临时抽风（返回 502、返回人机验证页、DNS 解析失败）是常态。
 * 这时候最糟糕的反应是把用户的节点清空 —— 用户的客户端下次拉订阅会拿到
 * 一份空配置，直接断网，而且他不会知道是机场的问题还是 subagg 的问题。
 *
 * 正确反应是：**记下错误，保留上一次成功同步的节点继续服务**，
 * 并在界面上把故障状态显示出来。这样至少网还是通的。
 */

import { detectRegion } from '../core/region.js';
import { finalizeNode } from '../core/fingerprint.js';
import { parseSubscription } from '../core/parse/index.js';
import type { NodeMeta, ParseIssue, ProxyNode, ProxyNodeDraft } from '../core/types.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { errorContext } from '../logger.js';
import type { NodeRepo } from '../db/repo/nodes.js';
import type { Subscription, SubscriptionRepo, TrafficRepo } from '../db/repo/subscriptions.js';
import { fetchSubscription } from './fetcher.js';

export interface SyncResult {
  subscriptionId: string;
  name: string;
  ok: boolean;
  /** 本次入库的节点数。304（内容未变）时为 undefined。 */
  nodeCount?: number;
  /** 未能解析的条目。呈现给用户，不静默丢弃。 */
  issues: ParseIssue[];
  /** 上游内容未变更，跳过了解析与入库。 */
  notModified?: boolean;
  error?: string;
}

export interface SyncDeps {
  config: Config;
  logger: Logger;
  subscriptions: SubscriptionRepo;
  nodes: NodeRepo;
  traffic: TrafficRepo;
}

/**
 * 给节点打自动标签。
 *
 * 这些标签供过滤规则匹配使用（`{field: 'name'}` 之外的补充维度）。
 * 只打**从配置本身能确定推导出**的标签，不做任何猜测 ——
 * 一个错误的标签会让基于它的过滤规则悄悄失效。
 */
function autoTags(node: ProxyNodeDraft): string[] {
  // 参数类型必须是 ProxyNodeDraft（分配式 Omit 的结果）而不是
  // Omit<ProxyNode, ...>。后者会把联合塌缩成只有公共字段的对象，
  // 下面的 `'tls' in node` 之类的收窄就拿不到 tls 的真实类型了。
  const tags: string[] = [];

  if ('tls' in node && node.tls?.reality) tags.push('reality');
  if ('flow' in node && node.flow) tags.push('xtls');
  if ('transport' in node && node.transport.network !== 'tcp') {
    tags.push(node.transport.network);
  }
  if (node.type === 'hysteria2' || node.type === 'tuic') tags.push('quic-based');

  return tags;
}

export class SyncService {
  constructor(private readonly deps: SyncDeps) {}

  /**
   * 同步单个订阅源。
   *
   * 无论成功失败都返回 `SyncResult` 而不抛异常 —— 批量同步时，
   * 一个订阅的失败不该中断其余订阅。
   */
  async syncOne(sub: Subscription): Promise<SyncResult> {
    const { config, logger, subscriptions, nodes, traffic } = this.deps;
    const log = logger.child({ subscriptionId: sub.id, subscription: sub.name });

    try {
      const outcome = await fetchSubscription(sub.url, {
        timeoutMs: config.fetchTimeoutMs,
        maxBytes: config.fetchMaxBytes,
        retries: config.fetchRetries,
        userAgent: sub.userAgent ?? config.fetchUserAgent,
        etag: sub.etag,
      });

      // 流量信息与内容是否变更无关，两条路径都要记录
      if (outcome.userinfo) {
        traffic.record(sub.id, outcome.userinfo);
      }

      // ── 内容未变更 ──────────────────────────────────
      if (outcome.notModified) {
        log.debug('订阅内容未变更（ETag 命中），跳过解析');
        subscriptions.markSynced(sub.id, sub.nodeCount, sub.etag);
        return {
          subscriptionId: sub.id,
          name: sub.name,
          ok: true,
          notModified: true,
          issues: [],
        };
      }

      // ── 解析 ────────────────────────────────────────
      const parsed = parseSubscription(outcome.body, sub.format);

      if (parsed.nodes.length === 0) {
        // 解析出 0 个节点几乎总是上游出了问题（错误页、人机验证、订阅到期）。
        // 绝不清空已有节点 —— 见文件头的说明。
        const reason = parsed.issues[0]?.reason ?? '未解析出任何节点';
        log.warn('同步未得到任何节点，保留现有节点', { reason, keptNodes: sub.nodeCount });
        subscriptions.markFailed(sub.id, reason);
        return {
          subscriptionId: sub.id,
          name: sub.name,
          ok: false,
          issues: parsed.issues,
          error: reason,
        };
      }

      // ── 补齐元信息 ──────────────────────────────────
      const finalized: ProxyNode[] = parsed.nodes.map((draft) => {
        const meta: NodeMeta = {
          sourceId: sub.id,
          sourceName: sub.name,
          tags: autoTags(draft),
        };
        // 地区推断不出时不写该字段，而不是填一个 'UNKNOWN' 占位 ——
        // 占位值会污染地区筛选器的选项列表
        const region = detectRegion(draft.name, draft.server);
        if (region) meta.region = region;
        return finalizeNode(draft, meta);
      });

      nodes.replaceForSubscription(sub.id, finalized);
      subscriptions.markSynced(sub.id, finalized.length, outcome.etag ?? null);

      // 日志字段名用英文：这些是给机器消费的（grep / Loki 查询），
      // 面向人的说明放在 msg 里
      log.info('订阅同步完成', {
        nodeCount: finalized.length,
        skippedEntries: parsed.issues.length,
        detectedFormat: parsed.detected,
      });

      return {
        subscriptionId: sub.id,
        name: sub.name,
        ok: true,
        nodeCount: finalized.length,
        issues: parsed.issues,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('订阅同步失败', errorContext(err));
      subscriptions.markFailed(sub.id, message);
      return {
        subscriptionId: sub.id,
        name: sub.name,
        ok: false,
        issues: [],
        error: message,
      };
    }
  }

  /**
   * 同步全部启用的订阅源。
   *
   * 并发执行：订阅之间互不依赖，串行只会让总耗时等于所有订阅耗时之和。
   * 用 `allSettled` 而不是 `all` —— 虽然 `syncOne` 已经吞掉了异常，
   * 但多一层保险不会有坏处。
   */
  async syncAll(): Promise<SyncResult[]> {
    const targets = this.deps.subscriptions.list().filter((s) => s.enabled);
    return this.syncMany(targets);
  }

  /** 同步到期的订阅源。供调度器调用。 */
  async syncDue(now = Date.now()): Promise<SyncResult[]> {
    const targets = this.deps.subscriptions.dueForSync(now);
    if (targets.length === 0) return [];
    this.deps.logger.debug('调度器：发现到期订阅', { count: targets.length });
    return this.syncMany(targets);
  }

  private async syncMany(targets: readonly Subscription[]): Promise<SyncResult[]> {
    const settled = await Promise.allSettled(targets.map((sub) => this.syncOne(sub)));

    return settled.map((result, i) => {
      if (result.status === 'fulfilled') return result.value;
      const sub = targets[i];
      return {
        subscriptionId: sub?.id ?? 'unknown',
        name: sub?.name ?? 'unknown',
        ok: false,
        issues: [],
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      };
    });
  }
}
