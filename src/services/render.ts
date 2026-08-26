/**
 * 渲染：把一个配置文件变成一份可以直接交给客户端的订阅内容。
 *
 * 这是 `/sub/:token` 的核心逻辑，把 core 层的几块能力串起来：
 *
 * ```
 * 全部节点 ──filter──> 选中的节点 ──ix──> 换成中转入口 ──chain──> ──emit──> 订阅内容
 *                                                                    │
 *                                 各源流量 ──aggregate──> 流量头 ─────┘
 * ```
 *
 * `ix` 那一环是可选的（默认整条 profile 都不开），但它的**位置不可动**：
 * 早于 filter 会让 `dedupe: 'server-port'` 把所有节点折叠成一个，
 * 晚于 chain 则永远匹配不上映射。理由写在 `core/ix.ts` 的文件头。
 *
 * 单独抽成一个服务而不是写在路由里，是为了让「预览」功能能复用同一条路径 ——
 * Web 界面上点"预览"看到的内容，必须与客户端真正拉到的**完全一致**，
 * 否则预览就失去了意义。
 */

import { emit, resolveTarget, type EmitTarget, type SkippedNode } from '../core/emit/index.js';
import { applyFilter, type FilterRule, type FilterStats } from '../core/filter.js';
import { expandChain, type ChainStats } from '../core/chain.js';
import {
  applyIx,
  ixRuleInteractionWarnings,
  type IxEntryMap,
  type IxOptions,
  type IxOutcome,
  type IxSkip,
  type IxStats,
} from '../core/ix.js';
import type { ProxyNode, TrafficInfo } from '../core/types.js';
import { aggregateUserinfo, formatUserinfo } from '../core/userinfo.js';
import type { NodeRepo } from '../db/repo/nodes.js';
import type { Profile } from '../db/repo/profiles.js';
import type { TrafficRepo } from '../db/repo/subscriptions.js';

/**
 * 渲染只需要 provider 的这三个字段：`id` 取映射、`name` 归因、
 * `enabled` 是**全局总闸**（关掉后所有 profile 一起回落直连）。
 *
 * 刻意不直接依赖 `IxProvider`：渲染不该看见凭据密文，测试也不该为了造一个
 * provider 去填十几个与渲染无关的列。
 */
export interface RenderIxProvider {
  id: string;
  name: string;
  enabled: boolean;
}

/**
 * 渲染路径对 IX 编排层的全部需求。
 *
 * 两个方法都必须是**同步、纯本地读**：`renderProfile` 是 `/sub/:token` 的
 * 热路径，一旦在这里发出站请求，中转平台的超时和限流就会把订阅拉取拖挂 ——
 * 而"平台挂了订阅照常出"是这个功能的设计前提。
 */
export interface RenderIxSource {
  resolveProvider(providerId?: string): {
    provider?: RenderIxProvider;
    warnings: string[];
    reason?: string;
  };
  entriesFor(providerId: string): IxEntryMap;
}

export interface RenderDeps {
  nodes: NodeRepo;
  traffic: TrafficRepo;
  /** 省略 = 本部署没装 IX 编排；启用了 IX 的 profile 会带警告回落直连。 */
  ix?: RenderIxSource;
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
  /** IX 中转改写的统计。**只在这趟 pass 真的跑了时才有**（仿 `chain` 的口径）。 */
  ix?: IxStats;
  /**
   * 逐节点的"为什么没走中转"。
   *
   * 它是这个问题的唯一答案，必须一路传到响应头与界面 ——
   * 用户看到节点还是直连时得能查到原因，而不是只看到一个数字变小了。
   */
  ixSkipped?: IxSkip[];
  nodes: ProxyNode[];
}

/** IX pass 的结果：`outcome` 为 undefined 表示这趟 pass 没跑（完全走原路径）。 */
interface IxPassResult {
  outcome?: IxOutcome;
  warnings: string[];
}

/**
 * 跑 IX 改写 pass。
 *
 * 三道门全过才改写，任一不过就**连 `applyIx` 都不调**（省掉映射查询与整趟遍历）：
 * ① 这份 profile 的 `rule.ix.enabled === true`；
 * ② 装了 IX 编排层；
 * ③ 解析到 provider 且它的**全局总闸** `enabled` 为真。
 *
 * 后两道门不过时必须留 warning：否则用户拨了开关却发现还是直连，
 * 而响应头里什么线索都没有。
 */
function runIxPass(deps: RenderDeps, rule: FilterRule, nodes: readonly ProxyNode[]): IxPassResult {
  if (rule.ix?.enabled !== true) return { warnings: [] };

  const source = deps.ix;
  if (!source) {
    return { warnings: ['IX 中转：本 profile 启用了中转，但当前服务没有装配 IX 编排模块，已全部按直连输出'] };
  }

  const resolved = source.resolveProvider(rule.ix.providerId);
  const provider = resolved.provider;
  if (!provider) {
    return {
      warnings: [
        ...resolved.warnings,
        `IX 中转：本次全部按直连输出 —— ${resolved.reason ?? '没有可用的中转商。'}`,
      ],
    };
  }
  if (!provider.enabled) {
    // 全局总闸。故障时一键回全部直连，正是它存在的理由。
    return {
      warnings: [
        ...resolved.warnings,
        `IX 中转：中转商「${provider.name}」的全局总闸已关闭，本次全部按直连输出`,
      ],
    };
  }

  const options: IxOptions = { tag: provider.name };
  if (rule.ix.fillOriginHost !== undefined) options.fillOriginHost = rule.ix.fillOriginHost;
  const outcome = applyIx(nodes, source.entriesFor(provider.id), options);

  return {
    outcome,
    // 规则层面的交互隐患（rename 里的 {server}、chain 用 field:'server'、
    // keepLandingDirect）只有在改写真的发生时才是隐患，所以跟 pass 一起报
    warnings: [...resolved.warnings, ...outcome.warnings, ...ixRuleInteractionWarnings(rule)],
  };
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
  const all: ProxyNode[] = deps.nodes.listAll();
  const rule =
    options.limitOverride !== undefined
      ? { ...profile.rule, limit: Math.min(profile.rule.limit || Number.POSITIVE_INFINITY, options.limitOverride) }
      : profile.rule;
  const filtered = applyFilter(all, rule);
  // IX 改写夹在 filter 与 chain 之间，两侧都是硬约束（理由见 core/ix.ts 文件头）：
  // 早于 filter 会让 dedupe:'server-port' 把所有节点折叠成一个；
  // 晚于 chain 则永远匹配不上映射（派生节点的指纹是另算的，且原指纹已丢失）。
  const ix = runIxPass(deps, rule, filtered.nodes);
  const chained = expandChain(ix.outcome?.nodes ?? filtered.nodes, rule.chain);

  // ── 3. 生成 ─────────────────────────────────────────
  const emitOptions = options.base64 === undefined ? {} : { base64: options.base64 };
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
  // 顺序即管线顺序：filter → ix → chain。用户照着读就知道问题出在哪一环。
  const warnings = [...filtered.warnings, ...ix.warnings, ...chained.warnings];
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

  if (ix.outcome) {
    result.ix = ix.outcome.stats;
    result.ixSkipped = ix.outcome.skipped;
  }

  if (userinfo) {
    result.userinfo = userinfo;
    result.userinfoHeader = formatUserinfo(userinfo);
  }

  return result;
}
