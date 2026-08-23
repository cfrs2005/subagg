/**
 * 输出目标的判定与分发 —— "一条链接，到处能用"就落在这个文件里。
 *
 * ## 为什么是 UA 嗅探而不是一种格式一条链接
 *
 * 朴素做法是给每种客户端发一条链接：`/sub/xxx/clash`、`/sub/xxx/shadowrocket`……
 * 但这在实际使用中很折磨人：
 *
 * - 用户自己要记住"手机上用的是哪条、电脑上用的是哪条"
 * - 分享给朋友时得先问对方用什么客户端
 * - 换客户端就要换链接，之前存的那条失效了
 *
 * 而客户端拉订阅时都会带上自己的 User-Agent。既然信息就在请求里，
 * 那就**一条链接，按 UA 自动返回对应格式**。这也是 Sub-Store / subconverter
 * 的做法，已经是这个生态的事实标准。
 *
 * 显式的 `?target=` 参数优先级高于 UA —— 自动判断总有失灵的时候，
 * 必须留一个逃生舱。
 *
 * 本文件属于 core 纯函数层：无 IO。
 */

import type { ProxyNode } from '../types.js';
import { emitClash, type ClashEmitOptions } from './clash.js';
import { emitShadowrocket, emitV2Ray } from './urilist.js';
import {
  isEmitTarget,
  TARGET_LABELS,
  type EmitResult,
  type EmitTarget,
} from './capability.js';

export {
  EMIT_TARGETS,
  TARGET_LABELS,
  isEmitTarget,
  checkSupport,
  partitionBySupport,
  type EmitTarget,
  type EmitResult,
  type SkippedNode,
  chainMechanismFor,
  type ChainMechanism,
} from './capability.js';
export { emitClash, toClashProxy, type ClashEmitOptions } from './clash.js';
export { emitShadowrocket, emitV2Ray } from './urilist.js';
export { emitUri } from './uri.js';

// ─────────────────────────────────────────────────────────────
//  User-Agent 嗅探
// ─────────────────────────────────────────────────────────────

interface UaPattern {
  re: RegExp;
  /** 客户端展示名，写进访问日志与共享管理界面。 */
  client: string;
  /** 对应的输出目标。undefined 表示识别出了客户端但我们还不支持它的格式。 */
  target?: EmitTarget;
  /** 需要告知用户的说明，会通过 X-Subagg-Warning 响应头返回。 */
  warning?: string;
}

/**
 * UA 匹配表。**顺序即优先级**，从上往下第一条命中的胜出。
 *
 * 顺序上有两个坑必须注意：
 *
 * 1. **Clash.Meta 系必须排在通用 Clash 之前。** `ClashMetaForAndroid` 的 UA
 *    里含有 "Clash"，先匹配到通用规则的话会被当成原版内核，
 *    于是 VLESS / Hysteria2 节点被无谓地跳过。
 * 2. **Stash / Verge 这类不含 "meta" 字样的 Meta 内核客户端要单独列出。**
 *
 * 判不准时宁可判成能力更弱的目标：多跳过几个节点，用户看到提示后能自己改；
 * 而把 VLESS 塞给原版 Clash 会导致**整份配置加载失败**，破坏性大得多。
 */
const UA_PATTERNS: readonly UaPattern[] = [
  // ── Shadowrocket ─────────────────────────────────────
  { re: /shadowrocket/i, client: 'Shadowrocket', target: 'shadowrocket' },

  // ── Clash.Meta / mihomo 系（必须在通用 Clash 之前）────
  {
    re: /mihomo|clash[.\-_ ]?meta|clash-?verge|verge|stash|flclash|nyanpasu|clashmi/i,
    client: 'Clash.Meta',
    target: 'clash.meta',
  },

  // ── 原版 Clash 内核 ───────────────────────────────────
  // ClashX Pro / Clash for Windows / Clash for Android 都基于 Premium 内核，
  // 不支持 VLESS / Hysteria2 / TUIC。
  { re: /clash/i, client: 'Clash', target: 'clash' },

  // ── V2Ray 系（消费 base64 URI 列表）───────────────────
  {
    re: /v2rayn|v2rayng|nekobox|nekoray|karing|v2box|matsuri|sagernet/i,
    client: 'V2Ray 系客户端',
    target: 'v2ray',
  },

  // ── sing-box 系 ───────────────────────────────────────
  // sing-box 原生配置是 JSON，v1 尚未支持。但这些客户端都能导入
  // base64 URI 列表订阅，所以回落到 v2ray 是**真的能用**，不是敷衍。
  {
    re: /sing-box|singbox|hiddify|\bsf[iam]\b/i,
    client: 'sing-box',
    target: 'v2ray',
    warning: 'sing-box 原生 JSON 配置尚未支持，已回落为 base64 URI 列表（可正常导入）',
  },

  // ── 已识别但确实无法服务的客户端 ──────────────────────
  // Surge / Quantumult X 用的是各自的专有配置格式，
  // 回落到任何一种现有格式都不能用。如实告知，不假装成功。
  {
    re: /surge/i,
    client: 'Surge',
    warning: 'Surge 配置格式尚未支持，返回的是该配置的默认格式，Surge 无法直接导入',
  },
  {
    re: /quantumult/i,
    client: 'Quantumult X',
    warning: 'Quantumult X 配置格式尚未支持，返回的是该配置的默认格式',
  },

  // ── 浏览器 ────────────────────────────────────────────
  // 放在最后：很多客户端的 UA 里也含有 Mozilla 字样，先匹配会误判。
  { re: /mozilla|chrome|safari|firefox|edge/i, client: '浏览器' },
];

export interface ClientDetection {
  /** 识别出的客户端展示名。完全认不出时为 `未知客户端`。 */
  client: string;
  /** 建议的输出目标。undefined 表示无法从 UA 推断，应回落到配置的默认值。 */
  target?: EmitTarget;
  /** 需要告知用户的说明。 */
  warning?: string;
}

/**
 * 从 User-Agent 推断客户端与输出目标。
 *
 * 认不出来不是错误 —— curl、wget、以及各种小众客户端都会走到这里，
 * 调用方回落到配置的默认目标即可。
 */
export function sniffClient(ua: string | undefined | null): ClientDetection {
  if (!ua) return { client: '未知客户端' };

  for (const pattern of UA_PATTERNS) {
    if (pattern.re.test(ua)) {
      const result: ClientDetection = { client: pattern.client };
      if (pattern.target) result.target = pattern.target;
      if (pattern.warning) result.warning = pattern.warning;
      return result;
    }
  }

  return { client: '未知客户端' };
}

/** 目标判定的来源，用于日志与界面提示。 */
export type TargetSource = 'query' | 'ua' | 'default';

export interface ResolvedTarget {
  target: EmitTarget;
  source: TargetSource;
  client: string;
  warning?: string;
}

/**
 * 决定最终使用哪种输出格式。
 *
 * 优先级：显式 `?target=` > UA 嗅探 > 配置的默认目标。
 *
 * @param explicit 请求里的 `target` 查询参数（未校验的原始值）
 * @param ua 请求的 User-Agent
 * @param fallback 该 profile 配置的默认目标
 */
export function resolveTarget(
  explicit: string | undefined | null,
  ua: string | undefined | null,
  fallback: EmitTarget,
): ResolvedTarget {
  const detection = sniffClient(ua);

  // 1. 显式指定优先。这是自动判断失灵时的逃生舱，必须最高优先级。
  if (explicit) {
    const normalized = normalizeTargetAlias(explicit);
    if (normalized) {
      return { target: normalized, source: 'query', client: detection.client };
    }
    // 指定了但无法识别：回落，并告知用户他写的值没生效 ——
    // 静默忽略会让用户以为参数起作用了，反而更难排查。
    const result: ResolvedTarget = {
      target: detection.target ?? fallback,
      source: detection.target ? 'ua' : 'default',
      client: detection.client,
      warning: `未知的 target 参数「${explicit}」，已忽略`,
    };
    return result;
  }

  // 2. UA 嗅探
  if (detection.target) {
    const result: ResolvedTarget = {
      target: detection.target,
      source: 'ua',
      client: detection.client,
    };
    if (detection.warning) result.warning = detection.warning;
    return result;
  }

  // 3. 回落到配置默认值
  const result: ResolvedTarget = {
    target: fallback,
    source: 'default',
    client: detection.client,
  };
  if (detection.warning) result.warning = detection.warning;
  return result;
}

/**
 * 归一化用户写的 target 值。
 *
 * 接受一些常见的等价写法 —— 用户不该被迫记住我们内部的精确拼写。
 */
export function normalizeTargetAlias(input: string): EmitTarget | undefined {
  const v = input.trim().toLowerCase();
  switch (v) {
    case 'meta':
    case 'mihomo':
    case 'clashmeta':
    case 'clash-meta':
    case 'clash_meta':
      return 'clash.meta';
    case 'sr':
    case 'rocket':
      return 'shadowrocket';
    case 'v2rayn':
    case 'v2rayng':
    case 'base64':
    case 'uri':
      return 'v2ray';
    default:
      return isEmitTarget(v) ? v : undefined;
  }
}

// ─────────────────────────────────────────────────────────────
//  分发
// ─────────────────────────────────────────────────────────────

export interface EmitOptions {
  /** 传给 Clash emitter 的选项。其他目标忽略。 */
  clash?: Omit<ClashEmitOptions, 'target'>;
  /** URI 列表是否做 base64 编码。预览时传 false 便于人工核对。 */
  base64?: boolean;
}

/**
 * 按目标格式生成订阅内容。
 *
 * 这是整个 emit 层的唯一入口，路由层只需调用它。
 * 新增输出格式时在这里加一个 case，其余代码不用动。
 */
export function emit(
  nodes: readonly ProxyNode[],
  target: EmitTarget,
  options: EmitOptions = {},
): EmitResult {
  switch (target) {
    case 'clash':
    case 'clash.meta':
      return emitClash(nodes, { ...options.clash, target });
    case 'shadowrocket':
      return emitShadowrocket(nodes, options.base64 ?? true);
    case 'v2ray':
      return emitV2Ray(nodes, options.base64 ?? true);
  }
}

/** 目标格式对应的文件扩展名，用于 Content-Disposition。 */
export function fileExtensionFor(target: EmitTarget): string {
  return target === 'clash' || target === 'clash.meta' ? 'yaml' : 'txt';
}

/** 目标格式的展示名。 */
export function targetLabel(target: EmitTarget): string {
  return TARGET_LABELS[target];
}
