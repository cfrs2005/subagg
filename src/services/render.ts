/**
 * 渲染：把一个配置文件变成一份可以直接交给客户端的订阅内容。
 *
 * 这是 `/sub/:token` 的核心逻辑，把 core 层的几块能力串起来：
 *
 * ```
 * 全部节点（含 IX 派生节点） ──filter──> 直选节点 ────────┐
 *                  └──────────────> 链式角色节点 ──chain──> emit ──> 订阅内容
 *                                                                    │
 *                                 各源流量 ──aggregate──> 流量头 ─────┘
 * ```
 *
 * 单独抽成一个服务而不是写在路由里，是为了让「预览」功能能复用同一条路径 ——
 * Web 界面上点"预览"看到的内容，必须与客户端真正拉到的**完全一致**，
 * 否则预览就失去了意义。
 */

import { emit, resolveTarget, type EmitTarget, type SkippedNode } from '../core/emit/index.js';
import { applyFilter, type FilterStats } from '../core/filter.js';
import { expandChain, type ChainStats } from '../core/chain.js';
import type { Orchestration } from '../core/orchestrate.js';
import { IOS_MIGRATED } from '../core/orchestrate-presets.js';
import type { ProxyNode, TrafficInfo } from '../core/types.js';
import { aggregateUserinfo, formatUserinfo } from '../core/userinfo.js';
import type { Profile } from '../db/repo/profiles.js';
import type { TrafficRepo } from '../db/repo/subscriptions.js';

export interface RenderDeps {
  /** Unified source + usable IX relay catalog. Must remain synchronous and local-only. */
  catalog: {
    listAll(): ProxyNode[];
    warningsForPick?(fingerprints: readonly string[] | undefined): string[];
  };
  traffic: TrafficRepo;
  /**
   * 站点级设置。全局默认编排从这里读：
   * profile 没写编排时用它，再没有才落到代码内置模板。
   */
  settings?: {
    getDefaultOrchestration(): Orchestration | null;
  };
}

export interface RenderOptions {
  /** 请求里的 `target` 查询参数，优先级最高。 */
  explicitTarget?: string | undefined;
  /** 请求的 User-Agent，用于自动判定输出格式。 */
  userAgent?: string | undefined;
  /** URI 列表是否 base64 编码。预览时传 false 便于人工核对。 */
  base64?: boolean;
  /** 覆盖 profile 的 limit。用于预览时只渲染前若干个节点。 */
  limitOverride?: number;
  /**
   * 覆盖 profile 的 Clash 编排。用于预览"还没保存的编排"。
   *
   * 三态是刻意的：`undefined` = 用 profile 上的；`null` = 明确不用编排
   * （回退内置模板）；对象 = 用这份临时编排。
   */
  orchestration?: Orchestration | null;
  /** 本订阅的节点列表 URL。写进 .conf 头部注释，方便对照添加订阅。 */
  subUrl?: string;
  /** .conf 输出自己的 URL，写进 [General] update-url 供 App 检查更新。 */
  confUrl?: string;
}

export interface RenderResult {
  body: string;
  contentType: string;
  target: EmitTarget;
  /** 目标格式的判定来源：显式参数 / UA 嗅探 / 配置默认值。 */
  targetSource: 'query' | 'ua' | 'default';
  /** 识别出的客户端名，写进访问日志。 */
  client: string;
  /** 实际写入配置的节点数。 */
  nodeCount: number;
  /** 因目标格式不支持而被跳过的节点。**必须呈现给用户，不能静默丢弃。** */
  skipped: SkippedNode[];
  /** 过滤各阶段的统计，用于回答"为什么我的节点少了"。 */
  filterStats: FilterStats;
  /** 规则本身的问题（写坏的正则等）与格式兼容性提示。 */
  warnings: string[];
  /** 聚合后的流量信息。undefined 表示不应输出该响应头。 */
  userinfo?: TrafficInfo;
  /** 已格式化的 Subscription-Userinfo 头值。 */
  userinfoHeader?: string;
  chain?: ChainStats;
  nodes: ProxyNode[];
}

/**
 * 渲染一个配置文件。
 *
 * @param profile 要渲染的配置文件
 */
export function renderProfile(
  deps: RenderDeps,
  profile: Profile,
  options: RenderOptions = {},
): RenderResult {
  // ── 1. 判定输出格式 ──────────────────────────────────
  const resolved = resolveTarget(
    options.explicitTarget,
    options.userAgent,
    profile.defaultTarget,
  );

  // ── 2. 过滤 ─────────────────────────────────────────
  const all: ProxyNode[] = deps.catalog.listAll();
  const rule =
    options.limitOverride !== undefined
      ? { ...profile.rule, limit: Math.min(profile.rule.limit || Number.POSITIVE_INFINITY, options.limitOverride) }
      : profile.rule;
  const filtered = applyFilter(all, rule);
  // Direct selection and chain-role selection are independent UI concepts.
  // Chain entries/landings therefore resolve against the full usable catalog,
  // while the direct output remains constrained by the profile filter.
  const chained = expandChain(filtered.nodes, rule.chain, all);

  // ── 3. 生成 ─────────────────────────────────────────
  //
  // 编排的生效顺序（对 Clash 与 .conf 两个目标一致）：
  //   本次请求的临时编排（预览用）
  //   > profile 自己的编排
  //   > 全局默认（settings 表，可在系统设置页改）
  //   > 代码里的 IOS_MIGRATED 预设 —— 站点所有者的长期策略，天然就是这里的默认值。
  // 改一次全局默认，所有没写专属编排的 profile 一起生效。
  const orchestration =
    options.orchestration === undefined
      ? (profile.orchestration ??
        deps.settings?.getDefaultOrchestration() ??
        IOS_MIGRATED)
      : options.orchestration;
  const emitOptions = {
    ...(options.base64 === undefined ? {} : { base64: options.base64 }),
    // 不相关目标的 emitter 会忽略这些键；传 undefined 也不会改变默认模板。
    ...(orchestration ? { clash: { orchestration } } : {}),
    ...(resolved.target === 'shadowrocket.conf'
      ? {
          shadowrocketConf: {
            ...(orchestration ? { orchestration } : {}),
            ...(options.confUrl ? { confUrl: options.confUrl } : {}),
            ...(options.subUrl ? { subUrl: options.subUrl } : {}),
          },
        }
      : {}),
  };
  const emitted = emit(chained.nodes, resolved.target, emitOptions);

  // ── 4. 聚合流量信息 ──────────────────────────────────
  //
  // 注意这里用的是**全部订阅源**的流量，而不是"本配置文件用到的订阅源"。
  // 这是刻意的：流量配额属于订阅源，与你怎么筛节点无关。一个只选了香港节点的
  // 配置文件，它背后消耗的仍然是整个机场的配额。
  // TrafficSnapshot 结构上就是 TrafficInfo 的超集（多了 subscriptionId 与 ts），
  // 所以这个 Map 可以直接喂给 aggregateUserinfo，不需要再重建一遍
  const userinfo = aggregateUserinfo(deps.traffic.latestAll(), profile.userinfoMode);

  // ── 5. 汇总提示 ─────────────────────────────────────
  const warnings = [
    ...filtered.warnings,
    ...(deps.catalog.warningsForPick?.(rule.pick) ?? []),
    ...chained.warnings,
    ...(emitted.warnings ?? []),
  ];
  if (resolved.warning) warnings.push(resolved.warning);
  if (emitted.skipped.length > 0) {
    warnings.push(
      `${emitted.skipped.length} 个节点因目标格式不支持而被跳过（详见 X-Subagg-Skipped 响应头）`,
    );
  }

  const result: RenderResult = {
    body: emitted.body,
    contentType: emitted.contentType,
    target: resolved.target,
    targetSource: resolved.source,
    client: resolved.client,
    nodeCount: emitted.nodeCount,
    skipped: emitted.skipped,
    filterStats: filtered.stats,
    warnings,
    chain: chained.stats.pairCount > 0 || rule.chain?.enabled ? chained.stats : undefined,
    nodes: chained.nodes,
  };

  if (userinfo) {
    result.userinfo = userinfo;
    result.userinfoHeader = formatUserinfo(userinfo);
  }

  return result;
}
