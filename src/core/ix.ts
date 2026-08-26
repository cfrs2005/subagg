/**
 * IX 中转改写：把节点的拨号地址换成中转入口，协议参数一律不动。
 *
 * ## 这一趟 pass 存在的理由
 *
 * L4 端口转发不解 TLS、不改流量。所以「客户端往哪拨号」和「跟谁握手、装成谁」
 * 是两件事 —— 而统一模型里这两件事有 **4 处**是靠"缺省回落到 `server`"隐式绑在
 * 一起的：`tls.sni`（types.ts 里那行注释明写）、`ws.headers.Host`、`h2.host`、
 * `http.headers.Host`。
 *
 * **改 `server` 就是在偷偷改这 4 个值。**所以改写地址时必须把原 server 显式写进
 * 这几个位置 —— 这不是新增语义，而是把改写前已经生效的隐式默认值固化下来。
 *
 * ## 管线位置：applyFilter → applyIx → expandChain → emit
 *
 * - 必须在 `applyFilter` **之后**：`dedupeKey(node,'server-port')` 返回
 *   `${server}:${port}`。若改写发生在去重前，所有节点都指向同一个入口域名，
 *   `dedupe: 'server-port'` 会把它们折叠成一个 —— 用户勾选的节点凭空消失，
 *   而且没有任何报错。同理 `field:'server'` 的筛选与 `{server}` 重命名占位符
 *   都应该看到原始值：用户的规则是针对原节点写的。
 * - 必须在 `expandChain` **之前**：映射按原指纹匹配，此时派生节点还没生成，
 *   命中率 100%；派生节点会自然继承已改写的入口，语义正确。
 *
 * 与 chain.ts 同层、同构、同返回形状：派生只在渲染期发生、**绝不进数据库**，
 * 并且**保留原指纹**。指纹是全系统主键（nodes 表 PK、`FilterRule.pick`、
 * ping 历史、chain 的 `viaFingerprint`、三个 `/api/nodes/:fingerprint/*` 路由），
 * 落库前或改写时重算 server/port 会让用户的勾选、ping 历史、映射关系一起炸。
 *
 * 本文件属于 core 纯函数层：无 IO，不读环境变量，不看时钟。
 */

import { normalizeHost } from './fingerprint.js';
import type { ChainSelector, FilterRule } from './filter.js';
import type {
  H2Options,
  HttpOptions,
  IxLink,
  ProxyNode,
  ProxyType,
  TlsOptions,
  Transport,
  VlessNode,
  VmessNode,
  WsOptions,
} from './types.js';

// ─────────────────────────────────────────────────────────────
//  映射条目
// ─────────────────────────────────────────────────────────────

export type IxPortStatus = 'active' | 'suspended' | 'expired' | 'pending' | 'unknown';

export interface IxEntry {
  entryHost: string;
  entryPort: number;
  /** 刻意必填：默认成 active 会把平台上已停用的端口静默当可用，症状是整批节点连不上。 */
  status: IxPortStatus;
  /**
   * 中转端口转不转 UDP。与 `BaseNode.udp` 不是一回事（那是节点支不支持 UDP）。
   *
   * 三态：`true` 转、`false` 不转、`undefined` 事实未知。core 零 IO 查不到平台状态，
   * 所以"转不转"这个**事实**由 services 传入，"未知时怎么办"这个**策略**走
   * {@link IxOptions.udpPolicy}。
   */
  udp?: boolean;
  /** 线路 / 端口的展示名，只用于把警告和跳过原因写得能归因。 */
  label?: string;
}

/** key = **原节点**指纹。改写保留原指纹，所以刷新与改名都不会让映射失配。 */
export type IxEntryMap = ReadonlyMap<string, IxEntry>;

// ─────────────────────────────────────────────────────────────
//  选项
// ─────────────────────────────────────────────────────────────

/**
 * 未改写节点的处置。
 *
 * `'drop'` 不是可选装饰：降级输出裸落地节点会让人以为走了中转、实际直连，
 * **暴露真实落地 IP**（docs/20260825-429-归因与-clashx-meta-误判.md 记过同一条原则）。
 * 默认 `'direct'`（可用性优先），隐私敏感场景必须能选 `'drop'`。
 */
export type IxFallback = 'direct' | 'drop';

export interface IxOptions {
  /** 是否把原 server 补进 SNI / ws-Host / h2-host / http-Host。默认 true。 */
  fillOriginHost?: boolean;
  /** 没有映射时怎么办。默认 `'direct'`。 */
  onMissing?: IxFallback;
  /** 入口地址非法或状态不可用（含 UDP 转发不了）时怎么办。默认 `'direct'`。 */
  onUnusable?: IxFallback;
  /**
   * 保守拒绝清单命中时怎么办。默认 `'direct'`。
   *
   * `'force'` 是逃生阀：改写地址但**不替用户猜任何伪装参数**
   * （REALITY 的 sni、ss 的 obfs-host 一律原样不动），并留 warning。
   */
  onUnsafe?: IxFallback | 'force';
  /** 协议本体跑 UDP 而入口 UDP 能力未知时：`'lenient'` 照改+警告（默认），`'strict'` 拒绝。 */
  udpPolicy?: 'lenient' | 'strict';
  /** 入口不转 UDP 时，把 TCP 系节点的 `udp: true` 如实降级为 false。默认 true。 */
  downgradeUdp?: boolean;
  /** 中转商 / 线路展示名，出现在 warnings 里，多 provider 时用于归因。 */
  tag?: string;
}

interface ResolvedOptions {
  fillOriginHost: boolean;
  onMissing: IxFallback;
  onUnusable: IxFallback;
  onUnsafe: IxFallback | 'force';
  udpPolicy: 'lenient' | 'strict';
  downgradeUdp: boolean;
  tag: string;
}

function resolveOptions(options: IxOptions): ResolvedOptions {
  return {
    fillOriginHost: options.fillOriginHost ?? true,
    onMissing: options.onMissing ?? 'direct',
    onUnusable: options.onUnusable ?? 'direct',
    onUnsafe: options.onUnsafe ?? 'direct',
    udpPolicy: options.udpPolicy ?? 'lenient',
    downgradeUdp: options.downgradeUdp ?? true,
    tag: options.tag ?? '',
  };
}

// ─────────────────────────────────────────────────────────────
//  结果
// ─────────────────────────────────────────────────────────────

export type IxSkipReason =
  | 'no-mapping'
  | 'entry-invalid'
  | 'entry-unusable'
  | 'already-rewritten'
  | 'reality-without-sni'
  | 'ss-plugin'
  | 'ssr-obfs-param'
  | 'grpc-without-tls'
  | 'udp-not-forwarded';

export interface IxSkip {
  fingerprint: string;
  name: string;
  type: ProxyType;
  reason: IxSkipReason;
  /** 中文说明 + 可操作的下一步（照 qrcode.ts 的口径：给原因也给出路）。 */
  detail: string;
  /** 该节点最终仍以直连输出，还是被彻底丢弃。 */
  outcome: 'direct' | 'dropped';
}

/**
 * 分四类。口径照 `FilterStats`：这些数字存在的唯一目的是回答
 * "为什么我的节点没走中转"。
 */
export interface IxStats {
  // ── 成功 ──
  /** 地址被换成中转入口的节点数。 */
  rewritten: number;
  /** 其中补写了 `tls.sni` 的节点数。 */
  filledSni: number;
  /** 其中补写了 ws / h2 / http Host 的节点数。 */
  filledHost: number;
  /** 本趟 pass 未改动、原样输出的节点数（= `skipped` 里 outcome 为 direct 的条数）。 */
  unchanged: number;
  // ── 降级 ──
  /** `node.udp` 被如实降级为 false 的节点数。 */
  udpDowngraded: number;
  // ── 跳过 ──
  skippedNoMapping: number;
  skippedEntryUnusable: number;
  skippedUnsafe: number;
  skippedUdp: number;
  /** 被彻底丢弃（不出现在 nodes 里）的节点数。 */
  dropped: number;
  // ── 映射体检 ──
  /** 映射有、这批节点里没出现 —— 多半是规则改了忘删。 */
  unusedEntries: number;
  /** 多个节点指向同一 `host:port`：一个转发端口只能有一个目的地，必然是配错。 */
  duplicateEntries: number;
}

export interface IxOutcome {
  /** 保持输入顺序 —— 顺序是 API 的一部分（chain.ts 的先例）。 */
  nodes: ProxyNode[];
  stats: IxStats;
  warnings: string[];
  skipped: IxSkip[];
}

function emptyStats(): IxStats {
  return {
    rewritten: 0,
    filledSni: 0,
    filledHost: 0,
    unchanged: 0,
    udpDowngraded: 0,
    skippedNoMapping: 0,
    skippedEntryUnusable: 0,
    skippedUnsafe: 0,
    skippedUdp: 0,
    dropped: 0,
    unusedEntries: 0,
    duplicateEntries: 0,
  };
}

// ─────────────────────────────────────────────────────────────
//  跳过原因的文案（原因 + 下一步）
// ─────────────────────────────────────────────────────────────

const STATUS_LABEL: Readonly<Record<IxPortStatus, string>> = {
  active: '可用',
  suspended: '已挂起',
  expired: '已过期',
  pending: '尚未就绪',
  unknown: '状态未知',
};

const DETAIL_NO_MAPPING =
  '该节点没有对应的中转端口映射，本次按原始直连地址输出。' +
  '下一步：到「IX 中转」页勾选该节点，认领或新建一个转发端口；' +
  '若不希望它以直连形式出现（会暴露真实落地地址），把 onMissing 设为 drop。';

const DETAIL_REALITY =
  'REALITY 的 sni 是**伪装目标域名**（如 www.microsoft.com），不是节点自己的域名，' +
  '必须命中服务端的 serverNames；补写原落地地址几乎必然不在其中，' +
  '而猜错的表现是握手被静默丢弃 —— 与被墙一模一样，用户无从归因。' +
  '下一步：让上游在订阅里给出 sni（有 sni 的 REALITY 节点可以正常中转），' +
  '或把该节点从中转勾选里去掉。';

const DETAIL_SS_PLUGIN =
  'obfs-local 缺省的 obfs-host 是插件**硬编码的域名**（www.bing.com 一类），不是 server；' +
  '照 TLS 的 SNI 规则补写会把本来能用的节点改坏。且插件参数的方言键名不统一' +
  '（Clash 侧 host、SIP002 侧 obfs-host），模型按约定原样保留、不做归一化，' +
  '无法可靠判断该往哪写。' +
  '下一步：改用同机的无插件节点，或在上游把 obfs-host 显式写出来后再勾选；' +
  '确认自己清楚后果时可用 onUnsafe=force（届时插件参数一字不动）。';

const DETAIL_SSR_OBFS =
  '该 obfs 需要一个混淆 Host，而 obfsParam 为空时用的是客户端内置的域名列表/派生值 ——' +
  '"缺失"并不等于"回落到 server"，补写会改变实际发出的 Host。' +
  '下一步：在上游给该节点写明 obfs-param，或改用 obfs=plain / random_head 的节点' +
  '（那两种不使用 host，可以正常中转）。';

const DETAIL_GRPC_NO_TLS =
  '明文 gRPC 的 :authority 会跟着入口域名走，而统一模型里没有任何字段能表达 gRPC 的 ' +
  'authority（GrpcOptions 只有 serviceName / mode），补不出来。' +
  '下一步：让该节点启用 TLS（此时 sni 可补，gRPC 即可中转），或改用 ws / tcp 传输的节点。';

const DETAIL_UDP_DEAD =
  '该协议的本体跑在 UDP 上（hysteria2 / tuic / QUIC 传输），而这个中转端口不转发 UDP ——' +
  '改写后输出的是一个必然连不上的死节点，且症状是"半坏"（TCP 通、UDP 黑洞），最难归因。' +
  '下一步：在中转平台给该端口开启 UDP 转发后重新同步，或让这类节点保持直连。';

const DETAIL_UDP_UNKNOWN_STRICT =
  '该协议的本体跑在 UDP 上，而这个中转端口**转不转 UDP 未知**（平台未回报），' +
  '当前 udpPolicy=strict 要求宁缺勿滥。' +
  '下一步：跑一次 IX 状态同步把端口的 UDP 能力补上，或改用 udpPolicy=lenient' +
  '（照改并留下警告）。';

function detailEntryInvalid(entry: IxEntry): string {
  return (
    `中转入口「${entry.entryHost}:${entry.entryPort}」不是合法地址` +
    '（主机名不能为空，端口须为 1-65535 的整数）。' +
    '继续改写会产出 port: 0 一类被客户端直接拒绝的配置，因此保持原样。' +
    '下一步：到「IX 中转」页重新同步该映射，或删掉这条映射让节点回落直连。'
  );
}

function detailEntryUnusable(entry: IxEntry): string {
  const where = entry.label ? `${entry.label}（${entry.entryHost}:${entry.entryPort}）` : `${entry.entryHost}:${entry.entryPort}`;
  return (
    `中转入口 ${where} 当前${STATUS_LABEL[entry.status]}，把流量指过去连不上。` +
    '下一步：到中转平台恢复或重建该端口，再跑一次 IX 状态同步；' +
    '暂时用不了就先让该节点直连。'
  );
}

function detailAlreadyRewritten(link: IxLink): string {
  return (
    `节点已带 IX 标记（${link.originServer}:${link.originPort} → ${link.entryHost}:${link.entryPort}），本轮不再改写。` +
    '二次改写会把 SNI / Host 补成**中转入口域名**，产出一个"看起来配全了、实际必然握手失败"' +
    '的节点，比不改写危险得多。' +
    '下一步：这是正常结果，无需处理；若看到同一节点被改写两次，说明管线里 applyIx 被调了两遍。'
  );
}

// ─────────────────────────────────────────────────────────────
//  保守拒绝清单
// ─────────────────────────────────────────────────────────────

/**
 * 会使用混淆 Host 的 SSR obfs 列表。
 *
 * 只有这些 obfs 才需要一个 Host；`plain` / `random_head` 不用，可以正常改写。
 * `_compatible` 变体是同一混淆的兼容模式，行为一致，必须一并收进来。
 */
const SSR_HOST_OBFS: ReadonlySet<string> = new Set([
  'http_simple',
  'http_simple_compatible',
  'http_post',
  'http_post_compatible',
  'tls1.2_ticket_auth',
  'tls1.2_ticket_auth_compatible',
]);

type IxSafety = { ok: true } | { ok: false; reason: IxSkipReason; detail: string };

const SAFE: IxSafety = { ok: true };

/**
 * 保守优先：判不准的组合一律不改写，并给出可读原因 + 下一步。
 *
 * 这里每一条都是"补写救不了"的情形，详细理由见各 DETAIL_* 文案。
 * 注意判据不是"这个协议奇怪"，而是"改了地址之后，某个隐式回落到 server 的值
 * 会被我们改错，且错法是静默的"。
 */
export function checkIxSafety(node: ProxyNode): IxSafety {
  const tls = 'tls' in node ? node.tls : undefined;
  if (tls?.reality && !tls.sni) {
    return { ok: false, reason: 'reality-without-sni', detail: DETAIL_REALITY };
  }
  if ('transport' in node && node.transport.network === 'grpc' && tls?.enabled !== true) {
    return { ok: false, reason: 'grpc-without-tls', detail: DETAIL_GRPC_NO_TLS };
  }
  if (node.type === 'ss' && node.plugin) {
    return { ok: false, reason: 'ss-plugin', detail: DETAIL_SS_PLUGIN };
  }
  if (node.type === 'ssr' && SSR_HOST_OBFS.has(node.obfs.toLowerCase()) && !node.obfsParam) {
    return { ok: false, reason: 'ssr-obfs-param', detail: DETAIL_SSR_OBFS };
  }
  return SAFE;
}

// ─────────────────────────────────────────────────────────────
//  UDP 三态
// ─────────────────────────────────────────────────────────────

/** 协议本体是否跑在 UDP 上 —— 这类节点在不转 UDP 的入口后面是彻底死的。 */
function runsOverUdp(node: ProxyNode): boolean {
  if (node.type === 'hysteria2' || node.type === 'tuic') return true;
  return 'transport' in node && node.transport.network === 'quic';
}

type UdpDecision =
  | { action: 'proceed' }
  | { action: 'downgrade' }
  | { action: 'reject'; detail: string };

const UDP_PROCEED: UdpDecision = { action: 'proceed' };

function decideUdp(node: ProxyNode, entry: IxEntry, opts: ResolvedOptions, tally: Tally): UdpDecision {
  if (runsOverUdp(node)) return decideUdpNative(entry, opts, tally);
  // TCP 系协议：UDP 只是附加能力，入口不转就如实降级 ——
  // 客户端看到 udp: false 会走直连或直接拒绝，而不是把 UDP 流量丢进黑洞。
  if (entry.udp === false && node.udp === true) {
    if (opts.downgradeUdp) return { action: 'downgrade' };
    tally.udpKept++;
  }
  return UDP_PROCEED;
}

function decideUdpNative(entry: IxEntry, opts: ResolvedOptions, tally: Tally): UdpDecision {
  if (entry.udp === true) return UDP_PROCEED;
  if (entry.udp === false) return { action: 'reject', detail: DETAIL_UDP_DEAD };
  if (opts.udpPolicy === 'strict') return { action: 'reject', detail: DETAIL_UDP_UNKNOWN_STRICT };
  // 默认对"未知"取宽松：多数人不会去维护这个字段，一上线就挡掉全部 hy2/tuic
  // 会让功能显得是坏的，而警告已经保住了可归因性。
  tally.udpUnknown++;
  return UDP_PROCEED;
}

// ─────────────────────────────────────────────────────────────
//  补写（把隐式回落显式固化）
// ─────────────────────────────────────────────────────────────

interface FillContext {
  /** 关掉时整个补写行为停用（逃生阀），地址照改。 */
  readonly enabled: boolean;
  /** 原始 server —— 补写进 SNI / Host 的唯一来源。 */
  readonly origin: string;
  filledSni: boolean;
  filledHost: boolean;
}

/**
 * 补 `tls.sni`。
 *
 * 三条不许动的红线：
 * - `tls` 为 undefined 或 `enabled !== true` 时**绝不凭空创建/启用 TLS** ——
 *   把明文节点变成 TLS 节点是纯破坏。
 * - 已有 sni 一律保留（那可能是刻意的前置 / CDN 域名）。
 * - `allowInsecure` 绝不改动，尤其不置 true —— "改写后握手失败就加 skip-cert-verify"
 *   是把功能变成安全事故的一行。
 */
function pinnedTls(tls: TlsOptions, fill: FillContext): TlsOptions {
  if (!fill.enabled || tls.enabled !== true || tls.sni) return tls;
  // REALITY 的 sni 是伪装目标域名而非自己的域名，猜错的症状与被墙一致。
  // 正常路径已由 checkIxSafety 拦下；这里再挡一次，是为了让 onUnsafe='force'
  // 逃生阀也不会替用户编一个伪装域名出来。
  if (tls.reality) return tls;
  fill.filledSni = true;
  return { ...tls, sni: fill.origin };
}

/**
 * 找出 headers 里表示 Host 的键，**大小写不敏感**。
 *
 * 这不是洁癖：Clash 上游的 headers 键名原样透传（parse/clash.ts 不规范化，
 * emit/clash.ts 直接输出）。只查 `'Host'` 会给已有小写 `host` 的节点再加一个
 * `Host` —— Clash 侧于是带两个 Host 头，而 URI 侧按 emit/uri.ts 的取值顺序
 * （`Host` 优先）拿到新加的那个，**同一个节点对象在两种输出格式里表达不一致**。
 */
function findHostKey(headers: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (!headers) return undefined;
  return Object.keys(headers).find((key) => key.toLowerCase() === 'host');
}

/** ws 的 Host 是单个字符串。空值等同缺失，但必须写回**同一个键**。 */
function pinnedWsHeaders(
  headers: Record<string, string> | undefined,
  fill: FillContext,
): Record<string, string> {
  const key = findHostKey(headers) ?? 'Host';
  if (headers?.[key]) return headers;
  fill.filledHost = true;
  return { ...headers, [key]: fill.origin };
}

function pinnedWs(ws: WsOptions | undefined, fill: FillContext): WsOptions {
  const headers = pinnedWsHeaders(ws?.headers, fill);
  if (ws && headers === ws.headers) return ws;
  return { ...ws, headers };
}

/**
 * h2 的 host 是 `string[]`（写成字符串会被 emitter `.join(',')` 变成逐字符逗号串）。
 *
 * 已有值时**不往数组里追加** —— 那是候选轮换列表，追加会把请求发到原站不认的 Host。
 */
function pinnedH2(h2: H2Options | undefined, fill: FillContext): H2Options {
  if (h2?.host?.length) return h2;
  fill.filledHost = true;
  return { ...h2, host: [fill.origin] };
}

/** http 伪装的 `headers.Host` 是 `string[]`，与 ws 的字符串不是一回事。 */
function pinnedHttp(http: HttpOptions | undefined, fill: FillContext): HttpOptions {
  const key = findHostKey(http?.headers) ?? 'Host';
  if (http?.headers?.[key]?.length) return http;
  fill.filledHost = true;
  return { ...http, headers: { ...http?.headers, [key]: [fill.origin] } };
}

/**
 * 把传输层里隐式回落到 server 的 Host 固化下来。
 *
 * 不变则返回原对象（同一引用），让"没改动"在输出里也是真的没换对象。
 * tcp / grpc / quic 没有可承载 Host 的字段，原样返回。
 */
function pinnedTransport(t: Transport, fill: FillContext): Transport {
  if (!fill.enabled) return t;
  switch (t.network) {
    case 'ws': {
      const ws = pinnedWs(t.ws, fill);
      return ws === t.ws ? t : { ...t, ws };
    }
    case 'h2': {
      const h2 = pinnedH2(t.h2, fill);
      return h2 === t.h2 ? t : { ...t, h2 };
    }
    case 'http': {
      const http = pinnedHttp(t.http, fill);
      return http === t.http ? t : { ...t, http };
    }
    default:
      return t;
  }
}

// ─────────────────────────────────────────────────────────────
//  重建节点
// ─────────────────────────────────────────────────────────────

interface AddressPatch {
  server: string;
  port: number;
  ix: IxLink;
  udp?: boolean;
}

/**
 * 按 `type` **穷尽 switch** 重建节点。这里一个 `as any` / `as ProxyNode` 都不能有。
 *
 * 不是风格问题：`as any` 不会阻止给 ss 节点挂上 `tls`，而 emitter 安静地不读它
 * （emit/clash.ts 的 ss 分支不输出 tls）—— 于是 `filledSni` 计数是真的、节点却没变，
 * "补写成功"变成一句谎话，测试也很难看出来。穷尽 switch 同时是给未来第 8 个协议
 * 留的绊线：新增协议时这里编译不过，必须回答"它的 Host 藏在哪"。
 *
 * `fingerprint` / `meta` / `name` 一律不动（region 是出口地区，重算会把香港节点
 * 标成 CN；name 由 filter 的 rename 负责）。
 */
function rebuild(node: ProxyNode, patch: AddressPatch, fill: FillContext): ProxyNode {
  switch (node.type) {
    case 'vmess': {
      const next: VmessNode = { ...node, ...patch, transport: pinnedTransport(node.transport, fill) };
      if (node.tls) next.tls = pinnedTls(node.tls, fill);
      return next;
    }
    case 'vless': {
      const next: VlessNode = { ...node, ...patch, transport: pinnedTransport(node.transport, fill) };
      if (node.tls) next.tls = pinnedTls(node.tls, fill);
      return next;
    }
    case 'trojan':
      return { ...node, ...patch, tls: pinnedTls(node.tls, fill), transport: pinnedTransport(node.transport, fill) };
    case 'ss':
      // ss / ssr 没有 tls / transport 字段，所以这里只改地址。
      // 需要 Host 的那些形态（obfs 插件 / SSR 混淆）已由 checkIxSafety 拒绝。
      return { ...node, ...patch };
    case 'ssr':
      return { ...node, ...patch };
    case 'hysteria2':
      return { ...node, ...patch, tls: pinnedTls(node.tls, fill) };
    case 'tuic':
      return { ...node, ...patch, tls: pinnedTls(node.tls, fill) };
  }
}

// ─────────────────────────────────────────────────────────────
//  逐节点判定
// ─────────────────────────────────────────────────────────────

/** 需要汇总成 warning 的计数（逐节点的细节走 `skipped`，warnings 只给概览）。 */
interface Tally {
  ipOrigin: number;
  udpUnknown: number;
  udpKept: number;
  forced: number;
  directFallback: number;
}

type NodeVerdict =
  | { kind: 'rewrite'; node: ProxyNode; filledSni: boolean; filledHost: boolean; downgraded: boolean }
  | { kind: 'skip'; reason: IxSkipReason; detail: string; fallback: IxFallback };

function skipVerdict(reason: IxSkipReason, detail: string, fallback: IxFallback): NodeVerdict {
  return { kind: 'skip', reason, detail, fallback };
}

function validateEntry(entry: IxEntry): { host: string; port: number } | { error: string } {
  const host = normalizeHost(entry.entryHost);
  const port = entry.entryPort;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: detailEntryInvalid(entry) };
  }
  return { host, port };
}

function judge(
  node: ProxyNode,
  entry: IxEntry | undefined,
  opts: ResolvedOptions,
  tally: Tally,
): NodeVerdict {
  // 幂等第一关：已带 ix 标记的节点绝不二次改写。
  if (node.ix) return skipVerdict('already-rewritten', detailAlreadyRewritten(node.ix), 'direct');
  if (!entry) return skipVerdict('no-mapping', DETAIL_NO_MAPPING, opts.onMissing);
  const address = validateEntry(entry);
  if ('error' in address) return skipVerdict('entry-invalid', address.error, opts.onUnusable);
  if (entry.status !== 'active') return skipVerdict('entry-unusable', detailEntryUnusable(entry), opts.onUnusable);

  const safety = checkIxSafety(node);
  if (!safety.ok) {
    if (opts.onUnsafe !== 'force') return skipVerdict(safety.reason, safety.detail, opts.onUnsafe);
    tally.forced++;
  }

  const udp = decideUdp(node, entry, opts, tally);
  if (udp.action === 'reject') return skipVerdict('udp-not-forwarded', udp.detail, opts.onUnusable);

  return rewrite(node, address, udp, opts, tally);
}

function rewrite(
  node: ProxyNode,
  address: { host: string; port: number },
  udp: UdpDecision,
  opts: ResolvedOptions,
  tally: Tally,
): NodeVerdict {
  const fill: FillContext = {
    enabled: opts.fillOriginHost,
    origin: node.server,
    filledSni: false,
    filledHost: false,
  };
  const patch: AddressPatch = {
    server: address.host,
    port: address.port,
    ix: {
      entryHost: address.host,
      entryPort: address.port,
      originServer: node.server,
      originPort: node.port,
    },
  };
  // 只在真要降级时才写这个键：写 `udp: undefined` 会把节点原有的 udp 抹掉。
  if (udp.action === 'downgrade') patch.udp = false;

  const next = rebuild(node, patch, fill);
  if (fill.filledSni && isIpLiteral(node.server)) tally.ipOrigin++;
  return {
    kind: 'rewrite',
    node: next,
    filledSni: fill.filledSni,
    filledHost: fill.filledHost,
    downgraded: udp.action === 'downgrade',
  };
}

/** 原地址是 IP 字面量时，补出来的 SNI 也是 IP —— 证书通常不含 IP，需要提醒。 */
function isIpLiteral(host: string): boolean {
  return /^[\d.]+$/.test(host) || host.includes(':');
}

// ─────────────────────────────────────────────────────────────
//  映射体检
// ─────────────────────────────────────────────────────────────

function auditEntries(nodes: readonly ProxyNode[], entries: IxEntryMap, stats: IxStats): void {
  const present = new Set(nodes.map((node) => node.fingerprint));
  const seen = new Set<string>();
  for (const [fingerprint, entry] of entries) {
    if (!present.has(fingerprint)) stats.unusedEntries++;
    const key = `${normalizeHost(entry.entryHost)}:${entry.entryPort}`;
    if (seen.has(key)) stats.duplicateEntries++;
    else seen.add(key);
  }
}

// ─────────────────────────────────────────────────────────────
//  警告汇总
// ─────────────────────────────────────────────────────────────

function buildWarnings(stats: IxStats, tally: Tally, opts: ResolvedOptions): string[] {
  const w: string[] = [];
  const p = opts.tag ? `IX 中转（${opts.tag}）` : 'IX 中转';
  if (stats.skippedNoMapping > 0) {
    w.push(`${p}：${stats.skippedNoMapping} 个节点没有中转映射，请到「IX 中转」页勾选并建端口`);
  }
  if (stats.skippedEntryUnusable > 0) {
    w.push(`${p}：${stats.skippedEntryUnusable} 个节点的入口不可用（地址非法 / 已挂起 / 已过期 / 未就绪）`);
  }
  if (stats.skippedUnsafe > 0) {
    w.push(`${p}：${stats.skippedUnsafe} 个节点因参数无法安全改写被跳过，逐条原因见跳过清单`);
  }
  if (stats.skippedUdp > 0) {
    w.push(`${p}：${stats.skippedUdp} 个 UDP 系节点（hysteria2 / tuic / QUIC）所用入口不转发 UDP，已跳过`);
  }
  if (stats.dropped > 0) {
    w.push(`${p}：${stats.dropped} 个未能改写的节点已按配置丢弃，不会出现在订阅里`);
  }
  if (tally.directFallback > 0) {
    w.push(`${p}：${tally.directFallback} 个节点以直连输出，会暴露真实落地地址；隐私敏感场景请改用 drop`);
  }
  return [...w, ...buildDetailWarnings(stats, tally, p)];
}

function buildDetailWarnings(stats: IxStats, tally: Tally, p: string): string[] {
  const w: string[] = [];
  if (stats.udpDowngraded > 0) {
    w.push(`${p}：${stats.udpDowngraded} 个节点的 UDP 能力已如实降级为 false（入口不转发 UDP）`);
  }
  if (tally.udpKept > 0) {
    w.push(`${p}：${tally.udpKept} 个节点的入口不转发 UDP，但 downgradeUdp 已关闭，UDP 流量会进黑洞`);
  }
  if (tally.udpUnknown > 0) {
    w.push(`${p}：${tally.udpUnknown} 个 UDP 系节点所用入口的 UDP 转发能力未知，已照改；如连不上请核对端口配置`);
  }
  if (tally.ipOrigin > 0) {
    w.push(`${p}：${tally.ipOrigin} 个节点的原地址是 IP 字面量，已作为 SNI 补写；若服务端证书不含该 IP，握手会失败`);
  }
  if (tally.forced > 0) {
    w.push(`${p}：${tally.forced} 个节点经 onUnsafe=force 强行改写，伪装参数一字未动，请自行验证可用性`);
  }
  if (stats.unusedEntries > 0) {
    w.push(`${p}：${stats.unusedEntries} 条映射在本次节点集里没有对应节点（多半是规则改了忘删）`);
  }
  if (stats.duplicateEntries > 0) {
    w.push(`${p}：${stats.duplicateEntries} 条映射与别人共用同一个 host:port —— 一个转发端口只能有一个目的地，请检查配置`);
  }
  return w;
}

function countSkip(stats: IxStats, reason: IxSkipReason): void {
  switch (reason) {
    case 'no-mapping':
      stats.skippedNoMapping++;
      break;
    case 'entry-invalid':
    case 'entry-unusable':
      stats.skippedEntryUnusable++;
      break;
    case 'udp-not-forwarded':
      stats.skippedUdp++;
      break;
    case 'reality-without-sni':
    case 'ss-plugin':
    case 'ssr-obfs-param':
    case 'grpc-without-tls':
      stats.skippedUnsafe++;
      break;
    case 'already-rewritten':
      // 幂等跳过不是异常，只体现在 unchanged 里，不进任何 skipped* 计数。
      break;
  }
}

// ─────────────────────────────────────────────────────────────
//  入口
// ─────────────────────────────────────────────────────────────

/**
 * 把有映射的节点改写成经中转入口拨号的形态。
 *
 * @param nodes 已过 `applyFilter`、尚未 `expandChain` 的节点。输出顺序与输入一致。
 * @param entries key 为**原节点指纹**的映射表，由 services 层从本地 SQLite 同步读出
 *   （渲染热路径绝不调用中转商 API，否则订阅拉取会被外部超时和限流拖挂）。
 *
 * 每一个未被改写的节点都会进 `skipped`，一个都不静默通过 —— 用户看到"节点还是直连"
 * 时必须能查到原因。输入数组与输入节点对象都不会被修改。
 */
export function applyIx(
  nodes: readonly ProxyNode[],
  entries: IxEntryMap,
  options: IxOptions = {},
): IxOutcome {
  const opts = resolveOptions(options);
  const stats = emptyStats();
  const tally: Tally = { ipOrigin: 0, udpUnknown: 0, udpKept: 0, forced: 0, directFallback: 0 };
  const skipped: IxSkip[] = [];
  const out: ProxyNode[] = [];

  auditEntries(nodes, entries, stats);

  for (const node of nodes) {
    const verdict = judge(node, entries.get(node.fingerprint), opts, tally);
    if (verdict.kind === 'rewrite') {
      out.push(verdict.node);
      stats.rewritten++;
      if (verdict.filledSni) stats.filledSni++;
      if (verdict.filledHost) stats.filledHost++;
      if (verdict.downgraded) stats.udpDowngraded++;
      continue;
    }
    countSkip(stats, verdict.reason);
    const outcome = verdict.fallback === 'drop' ? 'dropped' : 'direct';
    skipped.push({
      fingerprint: node.fingerprint,
      name: node.name,
      type: node.type,
      reason: verdict.reason,
      detail: verdict.detail,
      outcome,
    });
    if (outcome === 'dropped') {
      stats.dropped++;
      continue;
    }
    stats.unchanged++;
    if (verdict.reason !== 'already-rewritten') tally.directFallback++;
    out.push(node);
  }

  return { nodes: out, stats, warnings: buildWarnings(stats, tally, opts), skipped };
}

// ─────────────────────────────────────────────────────────────
//  规则层面的交互隐患
// ─────────────────────────────────────────────────────────────

/**
 * 报三处只能在规则层面看出来的隐患。
 *
 * 这三条 `applyIx` 看不到（它拿不到 `FilterRule`），`applyFilter` 也管不了
 * （它不知道 ix 开没开），所以单独一个纯函数，由 render 层与 filter/chain
 * 的 warnings 一起汇总。
 */
export function ixRuleInteractionWarnings(rule: FilterRule): string[] {
  if (rule.ix?.enabled !== true) return [];
  const warnings: string[] = [];

  // 1. rename 在 filter 内、早于 ix，`{server}`/`{port}` 展开的是**原始**地址 ——
  //    等于把要藏起来的落地域名印在客户端的节点名上。
  if (rule.rename?.some((r) => /\{server\}|\{port\}/.test(r.replace))) {
    warnings.push(
      '重命名模板里的 {server} / {port} 展开的是原始落地地址（重命名早于 IX 改写），' +
        '相当于把要藏起来的落地域名印在客户端的节点名上；建议改用 {region} / {regionZh} / {index}',
    );
  }

  if (rule.chain?.enabled !== true) return warnings;

  // 2. ix 必须早于 expandChain（派生节点的指纹由 deriveChainFingerprint 算出、
  //    不在映射表里，chain 之后再改写永远匹配不上，且原指纹已丢失）。
  //    这个交互**不能靠调顺序解决**，只能上报。
  if (usesServerField(rule.chain.entry) || usesServerField(rule.chain.landing)) {
    warnings.push(
      '链式选择器用 field:"server" 匹配，而 IX 改写必须早于链式展开，' +
        '这些条件看到的是中转入口地址而不是原落地地址；建议改用 pick / region / name',
    );
  }

  // 3. 一个 ProxyNode 只有一个 server，"一份走中转、一份走直连"在当前模型里不可表达。
  if (rule.chain.keepLandingDirect === true) {
    warnings.push(
      'keepLandingDirect 与 IX 中转同时开启时，保留下来的"直连"副本与链式副本来自同一个' +
        '已改写的节点对象，两份都走中转 —— 当前模型无法表达"同一节点直连版 + 中转版并存"；' +
        '想同时要两份请建两个 profile（一个开 IX、一个关）',
    );
  }

  return warnings;
}

function usesServerField(selector: ChainSelector): boolean {
  const exprs = [...(selector.include ?? []), ...(selector.exclude ?? [])];
  return exprs.some((expr) => expr.field === 'server');
}
