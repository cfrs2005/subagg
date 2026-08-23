/**
 * 节点 → 代理 URI 的序列化。Shadowrocket 与 V2Ray 两个输出目标共用这一层。
 *
 * 与解析层的原则相反：**解析时尽量宽容，生成时严格规范。**
 * 每个字段只输出一种写法 —— 选择依据是"哪种写法被最多客户端认识"。
 *
 * ## 关于百分号编码
 *
 * 这里没有用 `URLSearchParams.toString()` 来拼查询串，尽管那样代码更短。
 * 原因是它按 `application/x-www-form-urlencoded` 规则把空格编码成 `+`，
 * 而部分客户端在解析 URI 查询串时用的是普通的百分号解码，会把 `+` 原样保留 ——
 * 一个 WebSocket 路径里的空格就此变成加号，节点连不上。
 * 改用 `encodeURIComponent`（空格 → `%20`）没有这种歧义。
 *
 * ## 关于字段顺序
 *
 * 查询参数的顺序是固定的。这不影响客户端解析，但能让同样的节点每次生成出
 * 完全相同的字符串 —— 订阅内容因此可以稳定地做 ETag 与缓存比对。
 *
 * 本文件属于 core 纯函数层：无 IO。
 */

import type {
  Hysteria2Node,
  ProxyNode,
  SsNode,
  SsrNode,
  TlsOptions,
  Transport,
  TrojanNode,
  TuicNode,
  VlessNode,
  VmessNode,
} from '../types.js';
import { encodeBase64, encodeBase64Url, formatHostForUri } from '../parse/util.js';

/** 查询参数条目。值为 undefined 表示该参数不输出。 */
type QueryEntry = [key: string, value: string | undefined];

/** Chain parameter is always the final query entry to keep output stable. */
function chainEntries(node: ProxyNode): QueryEntry[] {
  return [['chain', node.chain?.viaName]];
}

/**
 * 拼接查询串。
 *
 * 空字符串会被保留（`sid=` 在 REALITY 里是有意义的合法配置，
 * 表示"使用空 shortId"，与"不配置 shortId"不同）；只有 undefined 才跳过。
 */
function buildQuery(entries: readonly QueryEntry[]): string {
  const parts = entries
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/** 生成 `#节点名` 片段。 */
function fragment(name: string): string {
  return name ? `#${encodeURIComponent(name)}` : '';
}

/** 把传输层配置摊平成查询参数。vless / trojan / hysteria2 等共用。 */
function transportEntries(t: Transport): QueryEntry[] {
  const entries: QueryEntry[] = [['type', t.network]];

  switch (t.network) {
    case 'ws':
      entries.push(['path', t.ws?.path]);
      entries.push(['host', t.ws?.headers?.['Host'] ?? t.ws?.headers?.['host']]);
      if (t.ws?.maxEarlyData !== undefined) entries.push(['ed', String(t.ws.maxEarlyData)]);
      if (t.ws?.earlyDataHeaderName) entries.push(['eh', t.ws.earlyDataHeaderName]);
      break;
    case 'grpc':
      entries.push(['serviceName', t.grpc?.serviceName]);
      entries.push(['mode', t.grpc?.mode]);
      break;
    case 'h2':
      entries.push(['path', t.h2?.path]);
      entries.push(['host', t.h2?.host?.join(',')]);
      break;
    case 'http':
      entries.push(['path', t.http?.path?.join(',')]);
      entries.push(['host', t.http?.headers?.['Host']?.join(',')]);
      break;
    default:
      break;
  }

  return entries;
}

/**
 * 把 TLS 配置摊平成查询参数。
 *
 * @param emitSecurityNone 未启用 TLS 时是否显式输出 `security=none`。
 *   VLESS 需要（不写的话部分客户端会按默认值猜），Trojan 不需要（它必然是 TLS）。
 */
function tlsEntries(tls: TlsOptions | undefined, emitSecurityNone: boolean): QueryEntry[] {
  if (!tls?.enabled) {
    return emitSecurityNone ? [['security', 'none']] : [];
  }

  const entries: QueryEntry[] = [];
  entries.push(['security', tls.reality ? 'reality' : 'tls']);
  entries.push(['sni', tls.sni]);
  entries.push(['alpn', tls.alpn?.length ? tls.alpn.join(',') : undefined]);
  entries.push(['fp', tls.fingerprint]);
  // 只在显式为 true 时输出。省略等于"按客户端默认（校验证书）"，
  // 这是更安全的默认值，不应该由我们替用户放宽。
  entries.push(['allowInsecure', tls.allowInsecure === true ? '1' : undefined]);

  if (tls.reality) {
    entries.push(['pbk', tls.reality.publicKey]);
    entries.push(['sid', tls.reality.shortId]);
    entries.push(['spx', tls.reality.spiderX]);
  }

  return entries;
}

// ─────────────────────────────────────────────────────────────
//  各协议
// ─────────────────────────────────────────────────────────────

/**
 * VMess → `vmess://` + base64(JSON)。
 *
 * 这是 v2rayN 定下的事实标准格式，兼容性最好。字段名全是缩写且值一律用字符串
 * ——后者是刻意的：部分客户端的 JSON 解析对 `port: 443`（数字）处理有问题，
 * 而所有客户端都能正确处理 `"port": "443"`。
 */
function emitVmess(node: VmessNode): string {
  const t = node.transport;

  // vmess JSON 里 `net` 是传输层、`type` 是伪装头类型。
  // HTTP/1.1 伪装的正确表达是 net=tcp + type=http，而不是 net=http。
  const net = t.network === 'http' ? 'tcp' : t.network;
  const headerType = t.network === 'http' ? 'http' : 'none';

  let host: string | undefined;
  let path: string | undefined;
  switch (t.network) {
    case 'ws':
      path = t.ws?.path;
      host = t.ws?.headers?.['Host'] ?? t.ws?.headers?.['host'];
      break;
    case 'grpc':
      // vmess JSON 没有 serviceName 字段，惯例是借用 path
      path = t.grpc?.serviceName;
      break;
    case 'h2':
      path = t.h2?.path;
      host = t.h2?.host?.join(',');
      break;
    case 'http':
      path = t.http?.path?.join(',');
      host = t.http?.headers?.['Host']?.join(',');
      break;
    default:
      break;
  }

  const json: Record<string, string> = {
    v: '2',
    ps: node.name,
    add: node.server,
    port: String(node.port),
    id: node.uuid,
    aid: String(node.alterId),
    scy: node.cipher,
    net,
    type: headerType,
    host: host ?? '',
    path: path ?? '',
    tls: node.tls?.enabled ? 'tls' : '',
  };
  if (node.chain) json['chain'] = node.chain.viaName;

  // 只有启用 TLS 时才写这三个，否则会产生一堆无意义的空字段
  if (node.tls?.enabled) {
    if (node.tls.sni) json['sni'] = node.tls.sni;
    if (node.tls.alpn?.length) json['alpn'] = node.tls.alpn.join(',');
    if (node.tls.fingerprint) json['fp'] = node.tls.fingerprint;
  }

  return `vmess://${encodeBase64(JSON.stringify(json))}`;
}

/** VLESS → `vless://uuid@host:port?…#name` */
function emitVless(node: VlessNode): string {
  const entries: QueryEntry[] = [
    // VLESS 目前只有 none 一种加密，但字段是必需的
    ['encryption', node.encryption ?? 'none'],
    ...tlsEntries(node.tls, true),
    ['flow', node.flow],
    ...transportEntries(node.transport),
    ...chainEntries(node),
  ];
  const auth = encodeURIComponent(node.uuid);
  return `vless://${auth}@${formatHostForUri(node.server)}:${node.port}${buildQuery(entries)}${fragment(node.name)}`;
}

/** Trojan → `trojan://password@host:port?…#name` */
function emitTrojan(node: TrojanNode): string {
  const entries: QueryEntry[] = [
    ...tlsEntries(node.tls, false),
    ...transportEntries(node.transport),
    ...chainEntries(node),
  ];
  const auth = encodeURIComponent(node.password);
  return `trojan://${auth}@${formatHostForUri(node.server)}:${node.port}${buildQuery(entries)}${fragment(node.name)}`;
}

/**
 * Shadowsocks → SIP002 格式。
 *
 * 用 SIP002 而不是更老的"整段 base64"格式，因为前者是现行标准且能携带
 * plugin 参数。所有在维护的客户端都支持它。
 */
function emitSs(node: SsNode): string {
  const userinfo = encodeBase64Url(`${node.cipher}:${node.password}`);

  let pluginPart = '/?';
  if (node.plugin) {
    const segments = [node.plugin.name];
    for (const [k, v] of Object.entries(node.plugin.opts)) {
      // 值为 true 的选项是开关，只写键名（如 `tls`）
      segments.push(v === true ? k : `${k}=${String(v)}`);
    }
    pluginPart += `plugin=${encodeURIComponent(segments.join(';'))}`;
  }
  if (node.chain) pluginPart += `${node.plugin ? '&' : ''}chain=${encodeURIComponent(node.chain.viaName)}`;
  if (!node.plugin && !node.chain) pluginPart = '';

  return `ss://${userinfo}@${formatHostForUri(node.server)}:${node.port}${pluginPart}${fragment(node.name)}`;
}

/**
 * ShadowsocksR → `ssr://` + base64url(主体)。
 *
 * SSR 的查询参数值本身还要再套一层 base64url —— 这个格式定型于 2016 年，
 * 当时没人考虑百分号编码，只能沿用。
 */
function emitSsr(node: SsrNode): string {
  const main = [
    node.server,
    String(node.port),
    node.protocol,
    node.cipher,
    node.obfs,
    encodeBase64Url(node.password),
  ].join(':');

  const params: string[] = [];
  if (node.obfsParam) params.push(`obfsparam=${encodeBase64Url(node.obfsParam)}`);
  if (node.protocolParam) params.push(`protoparam=${encodeBase64Url(node.protocolParam)}`);
  if (node.name) params.push(`remarks=${encodeBase64Url(node.name)}`);

  const body = params.length > 0 ? `${main}/?${params.join('&')}` : main;
  return `ssr://${encodeBase64Url(body)}`;
}

/** Hysteria2 → `hysteria2://password@host:port?…#name` */
function emitHysteria2(node: Hysteria2Node): string {
  const entries: QueryEntry[] = [
    ['sni', node.tls.sni],
    ['alpn', node.tls.alpn?.length ? node.tls.alpn.join(',') : undefined],
    // Hysteria2 的 URI 方言用 `insecure` 而不是 `allowInsecure`
    ['insecure', node.tls.allowInsecure === true ? '1' : undefined],
    ['obfs', node.obfs],
    ['obfs-password', node.obfsPassword],
    ['up', node.up],
    ['down', node.down],
  ];
  // 密码整体做百分号编码：里面若含冒号，不编码的话会被解析成 user:pass 两段
  const auth = encodeURIComponent(node.password);
  return `hysteria2://${auth}@${formatHostForUri(node.server)}:${node.port}${buildQuery(entries)}${fragment(node.name)}`;
}

/** TUIC → `tuic://uuid:password@host:port?…#name` */
function emitTuic(node: TuicNode): string {
  const entries: QueryEntry[] = [
    ['sni', node.tls.sni],
    ['alpn', node.tls.alpn?.length ? node.tls.alpn.join(',') : undefined],
    ['allowInsecure', node.tls.allowInsecure === true ? '1' : undefined],
    ['congestion_control', node.congestionController],
    ['udp_relay_mode', node.udpRelayMode],
  ];
  const auth = `${encodeURIComponent(node.uuid)}:${encodeURIComponent(node.password)}`;
  return `tuic://${auth}@${formatHostForUri(node.server)}:${node.port}${buildQuery(entries)}${fragment(node.name)}`;
}

// ─────────────────────────────────────────────────────────────
//  入口
// ─────────────────────────────────────────────────────────────

/**
 * 把节点序列化成代理 URI。
 *
 * 与 `parseUri` 构成往返对：`parseUri(emitUri(node))` 在语义上必须等于 `node`
 * （meta 与 fingerprint 除外，那两个字段不参与 URI 表达）。
 * 这条不变式由 test/parse/roundtrip.test.ts 锁住 —— 协议方言的坑太多，
 * 靠人眼 review 是发现不了的。
 */
export function emitUri(node: ProxyNode): string {
  switch (node.type) {
    case 'vmess':
      return emitVmess(node);
    case 'vless':
      return emitVless(node);
    case 'trojan':
      return emitTrojan(node);
    case 'ss':
      return emitSs(node);
    case 'ssr':
      return emitSsr(node);
    case 'hysteria2':
      return emitHysteria2(node);
    case 'tuic':
      return emitTuic(node);
  }
}
