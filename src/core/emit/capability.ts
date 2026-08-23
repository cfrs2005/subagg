/**
 * 协议 × 目标格式 能力矩阵。
 *
 * ## 这个文件存在的理由
 *
 * 不是所有客户端都支持所有协议。最典型的：
 *
 * - **原版 Clash**（Dreamacro 的 core，以及基于它的 ClashX / Clash for Windows）
 *   **根本不支持 VLESS**，也不支持 Hysteria2 和 TUIC。
 * - **Clash.Meta（mihomo）** 支持上述全部。
 * - **v2rayN** 早期版本不认 `ssr://`，Hysteria2 / TUIC 也是较新版本才加的。
 *
 * 如果不管三七二十一把所有节点都塞进配置里，结果是客户端加载配置直接报错
 * ——**整份订阅都用不了**，而不只是丢几个节点。
 *
 * 所以生成配置前必须按目标过滤，并且**把跳过的节点如实报告出来**。
 * 静默丢弃是不可接受的：用户看到节点数从 40 变成 25，只会以为订阅坏了，
 * 而真实原因是"你的客户端太老，25 个节点用不了"。
 *
 * 本文件属于 core 纯函数层：无 IO。
 */

import type { ProxyNode, ProxyType } from '../types.js';

/**
 * 输出目标。
 *
 * `clash` 与 `clash.meta` 分开，是因为两者的协议支持差异巨大 ——
 * 这是整个矩阵里最有价值的一条区分。
 */
export type EmitTarget = 'clash' | 'clash.meta' | 'shadowrocket' | 'v2ray';

export const EMIT_TARGETS: readonly EmitTarget[] = [
  'clash',
  'clash.meta',
  'shadowrocket',
  'v2ray',
] as const;

export function isEmitTarget(v: string): v is EmitTarget {
  return (EMIT_TARGETS as readonly string[]).includes(v);
}

/** 目标格式的展示名，用于 UI 与日志。 */
export const TARGET_LABELS: Readonly<Record<EmitTarget, string>> = {
  clash: 'Clash（原版内核）',
  'clash.meta': 'Clash.Meta / mihomo',
  shadowrocket: 'Shadowrocket',
  v2ray: 'V2Ray / v2rayN',
};

/**
 * 各目标支持的协议。
 *
 * 修改此表前请先确认：**漏填会导致节点被无谓地跳过，误填会导致客户端
 * 加载整份配置失败**。后者的破坏性大得多，所以拿不准时应当保守。
 */
const SUPPORTED_TYPES: Readonly<Record<EmitTarget, ReadonlySet<ProxyType>>> = {
  // 原版 Clash 内核：无 VLESS / Hysteria2 / TUIC
  clash: new Set<ProxyType>(['ss', 'ssr', 'vmess', 'trojan']),
  // mihomo：目前支持我们解析的全部协议
  'clash.meta': new Set<ProxyType>(['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic']),
  // Shadowrocket：协议覆盖很全，SSR 也原生支持
  shadowrocket: new Set<ProxyType>([
    'ss',
    'ssr',
    'vmess',
    'vless',
    'trojan',
    'hysteria2',
    'tuic',
  ]),
  // v2rayN / NekoBox 等消费 base64 URI 列表的客户端。
  // 新版本已支持 hysteria2 / tuic；ssr 在部分客户端上缺失，
  // 但 URI 本身是合法的，客户端至多忽略该行而不会整体失败，故予以放行。
  v2ray: new Set<ProxyType>(['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic']),
};

export type ChainMechanism = 'none' | 'shadowrocket-chain' | 'dialer-proxy';
const CHAIN_MECHANISM: Readonly<Record<EmitTarget, ChainMechanism>> = {
  clash: 'none',
  'clash.meta': 'dialer-proxy',
  shadowrocket: 'shadowrocket-chain',
  v2ray: 'none',
};
const CHAINABLE_TYPES: Readonly<Record<EmitTarget, ReadonlySet<ProxyType>>> = {
  clash: new Set(),
  'clash.meta': new Set(['ss', 'ssr', 'vmess', 'vless', 'trojan']),
  shadowrocket: new Set(['ss', 'vmess', 'vless', 'trojan']),
  v2ray: new Set(),
};

export function chainMechanismFor(target: EmitTarget): ChainMechanism {
  return CHAIN_MECHANISM[target];
}

/** 单个节点的支持性判定结果。 */
export type SupportCheck = { supported: true } | { supported: false; reason: string };

/**
 * 判断某节点能否用指定目标格式输出。
 *
 * 除了协议本身，还会检查传输层 —— 一个 `vmess over quic` 的节点，
 * 协议是支持的，但传输层在现代 Clash 内核里已被移除。
 */
export function checkSupport(node: ProxyNode, target: EmitTarget): SupportCheck {
  const allowed = SUPPORTED_TYPES[target];
  if (!allowed.has(node.type)) {
    // 给出可操作的建议，而不是干巴巴一句"不支持"
    const hint =
      target === 'clash'
        ? '原版 Clash 内核不支持该协议，请改用 Clash.Meta（mihomo）内核，如 Clash Verge Rev / Stash'
        : '目标客户端不支持该协议';
    return { supported: false, reason: `${node.type.toUpperCase()}：${hint}` };
  }

  if (node.chain && !CHAINABLE_TYPES[target].has(node.type)) {
    const reason =
      target === 'shadowrocket'
        ? `${node.type.toUpperCase()}：Shadowrocket 链式尚未验证或没有可写入的 chain 参数`
        : target === 'clash.meta'
          ? `${node.type.toUpperCase()}：mihomo 链式尚未验证`
          : '该输出目标不支持链式代理，已跳过以避免静默直连';
    return { supported: false, reason };
  }

  // ── 传输层检查 ──────────────────────────────────────
  if ('transport' in node && node.transport.network === 'quic') {
    if (target === 'clash' || target === 'clash.meta') {
      return {
        supported: false,
        reason: 'QUIC 传输：Clash 内核已移除对 VMess/VLESS over QUIC 的支持',
      };
    }
  }

  // REALITY 只有 Clash.Meta 与 Shadowrocket / 新版 v2rayN 支持，
  // 而原版 Clash 连 VLESS 都不支持，上面的协议检查已经拦下了，这里无需重复判断。

  return { supported: true };
}

/** 被跳过的节点记录。会通过响应头与 Web 界面呈现给用户。 */
export interface SkippedNode {
  name: string;
  type: ProxyType;
  reason: string;
}

/**
 * 所有 emitter 的统一返回结构。
 *
 * `skipped` 是这个结构里最重要的字段 —— 它保证"哪些节点没能输出、为什么"
 * 这个信息不会在生成过程中丢失，而是一路传递到响应头和界面上。
 */
export interface EmitResult {
  /** 订阅响应体。 */
  body: string;
  /** 响应的 Content-Type。 */
  contentType: string;
  /** 实际写入配置的节点数。 */
  nodeCount: number;
  /** 因目标格式不支持而跳过的节点。 */
  skipped: SkippedNode[];
}

/**
 * 按目标格式把节点分成"可用"与"跳过"两组。
 *
 * 所有 emitter 都应先调用它，以保证跳过逻辑与上报口径一致。
 */
export function partitionBySupport(
  nodes: readonly ProxyNode[],
  target: EmitTarget,
): { usable: ProxyNode[]; skipped: SkippedNode[] } {
  const usable: ProxyNode[] = [];
  const skipped: SkippedNode[] = [];

  for (const node of nodes) {
    const check = checkSupport(node, target);
    if (check.supported) {
      usable.push(node);
    } else {
      skipped.push({ name: node.name, type: node.type, reason: check.reason });
    }
  }

  return { usable, skipped };
}
