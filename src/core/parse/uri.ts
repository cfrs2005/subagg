/**
 * 单条代理 URI 的解析。
 *
 * 这是全项目 bug 密度最高的一块，因为"协议 URI"根本没有统一规范 ——
 * 每个客户端都有自己的方言，同一个字段在不同实现里可能叫 `sni` / `peer` / `host`，
 * 同一个开关可能写成 `allowInsecure=1` / `insecure=true` / `skip-cert-verify=yes`。
 *
 * 应对策略有三条：
 *
 * 1. **读取时尽量宽容**：多个别名都接受，各种真值写法都认。
 * 2. **写出时严格规范**（见 emit/uri.ts）：只生成一种最兼容的写法。
 * 3. **往返测试兜底**：`parseUri(emitUri(node))` 必须在语义上等于 `node`。
 *    协议方言的坑太多，靠人眼 review 是看不出来的，只能靠测试锁住。
 *
 * 本文件属于 core 纯函数层：无 IO。
 */

import type {
  Hysteria2Node,
  PluginOptions,
  ProxyNodeDraft,
  SsNode,
  SsrNode,
  Network,
  Transport,
  TlsOptions,
  TrojanNode,
  TuicNode,
  VlessNode,
  VmessNode,
} from '../types.js';
import {
  decodeBase64,
  parseBool,
  parsePort,
  safeDecodeURIComponent,
  splitCsv,
  stripBrackets,
} from './util.js';

/** 解析结果。失败时带上人类可读的原因，最终会呈现给用户。 */
export type UriParseOutcome =
  | { ok: true; node: ProxyNodeDraft }
  | { ok: false; reason: string };

const fail = (reason: string): UriParseOutcome => ({ ok: false, reason });
const ok = (node: ProxyNodeDraft): UriParseOutcome => ({ ok: true, node });

// ─────────────────────────────────────────────────────────────
//  入口：按 scheme 分发
// ─────────────────────────────────────────────────────────────

/**
 * 解析一条代理 URI。
 *
 * 不认识的 scheme 会返回失败而不是抛异常 —— 订阅里出现未支持的协议是常态，
 * 调用方需要的是"跳过并记录"，而不是"整个订阅解析失败"。
 */
export function parseUri(raw: string): UriParseOutcome {
  const uri = raw.trim();
  if (uri.length === 0) return fail('空行');

  const schemeEnd = uri.indexOf('://');
  if (schemeEnd <= 0) return fail('不是有效的 URI（缺少 scheme）');
  const scheme = uri.slice(0, schemeEnd).toLowerCase();

  switch (scheme) {
    case 'vmess':
      return parseVmessUri(uri);
    case 'vless':
      return parseVlessUri(uri);
    case 'trojan':
    case 'trojan-go': // trojan-go 的基础字段与 trojan 兼容，其扩展字段我们忽略
      return parseTrojanUri(uri);
    case 'ss':
      return parseSsUri(uri);
    case 'ssr':
      return parseSsrUri(uri);
    case 'hysteria2':
    case 'hy2':
      return parseHysteria2Uri(uri);
    case 'tuic':
      return parseTuicUri(uri);
    default:
      return fail(`暂不支持的协议：${scheme}`);
  }
}

// ─────────────────────────────────────────────────────────────
//  共享：传输层与 TLS
// ─────────────────────────────────────────────────────────────

/**
 * 归一化传输层名称。
 *
 * `none` 出现在 vmess 的 `net` 字段里表示"无特殊传输"，等价于裸 TCP。
 * `http` 与 `h2` 必须区分：前者是 HTTP/1.1 伪装（TCP 上套一层 HTTP 头），
 * 后者是真正的 HTTP/2 传输。上游订阅经常把两者写混，但客户端不兼容，
 * 猜错会导致节点连不上。
 */
function normalizeNetwork(raw: string | null | undefined): Network {
  const v = (raw ?? '').trim().toLowerCase();
  switch (v) {
    case 'ws':
    case 'websocket':
      return 'ws';
    case 'grpc':
      return 'grpc';
    case 'h2':
    case 'http/2':
    case 'http2':
      return 'h2';
    case 'http':
      return 'http';
    case 'quic':
      return 'quic';
    case '':
    case 'none':
    case 'tcp':
    case 'raw': // sing-box 把裸 TCP 叫 raw
      return 'tcp';
    default:
      // 不认识的传输一律当 TCP。比起丢弃节点，用最通用的传输试一次更有价值。
      return 'tcp';
  }
}

/** 从查询参数构造传输层配置。vless / trojan / vmess(URI 形态) 共用。 */
function transportFromQuery(q: URLSearchParams): Transport {
  const network = normalizeNetwork(q.get('type') ?? q.get('net'));
  const path = q.get('path') ?? undefined;
  const host = q.get('host') ?? undefined;

  switch (network) {
    case 'ws': {
      const t: Transport = { network };
      const ws: NonNullable<Transport['ws']> = {};
      if (path) ws.path = safeDecodeURIComponent(path);
      if (host) ws.headers = { Host: host };
      const earlyData = q.get('ed');
      if (earlyData) {
        const n = Number.parseInt(earlyData, 10);
        if (Number.isFinite(n) && n > 0) ws.maxEarlyData = n;
      }
      const edHeader = q.get('eh');
      if (edHeader) ws.earlyDataHeaderName = edHeader;
      if (Object.keys(ws).length > 0) t.ws = ws;
      return t;
    }
    case 'grpc': {
      // gRPC 的服务名在不同客户端里有三种写法。v2rayN 用 serviceName，
      // 部分订阅复用了 path 字段（因为早期实现就是这么干的）。
      const serviceName =
        q.get('serviceName') ?? q.get('servicename') ?? q.get('service_name') ?? path;
      const mode = q.get('mode');
      const grpc: NonNullable<Transport['grpc']> = {};
      if (serviceName) grpc.serviceName = safeDecodeURIComponent(serviceName);
      if (mode === 'gun' || mode === 'multi') grpc.mode = mode;
      return Object.keys(grpc).length > 0 ? { network, grpc } : { network };
    }
    case 'h2': {
      const h2: NonNullable<Transport['h2']> = {};
      if (path) h2.path = safeDecodeURIComponent(path);
      const hosts = splitCsv(host);
      if (hosts.length > 0) h2.host = hosts;
      return Object.keys(h2).length > 0 ? { network, h2 } : { network };
    }
    case 'http': {
      const http: NonNullable<Transport['http']> = {};
      const paths = splitCsv(path).map(safeDecodeURIComponent);
      if (paths.length > 0) http.path = paths;
      const hosts = splitCsv(host);
      if (hosts.length > 0) http.headers = { Host: hosts };
      return Object.keys(http).length > 0 ? { network, http } : { network };
    }
    default:
      return { network };
  }
}

/**
 * 从查询参数构造 TLS 配置。
 *
 * @param forceEnabled Trojan / Hysteria2 / TUIC 这类以 TLS 为前提的协议传 true ——
 *   即使 URI 里没写 `security=tls` 也应当启用，因为协议本身就跑在 TLS 上。
 */
function tlsFromQuery(q: URLSearchParams, forceEnabled = false): TlsOptions | undefined {
  const security = (q.get('security') ?? '').trim().toLowerCase();
  const legacyTls = q.get('tls'); // 老式写法：tls=1 或 tls=tls
  const isReality = security === 'reality';
  const enabled =
    forceEnabled ||
    isReality ||
    security === 'tls' ||
    security === 'xtls' ||
    parseBool(legacyTls) === true ||
    legacyTls === 'tls';

  if (!enabled) return undefined;

  const tls: TlsOptions = { enabled: true };

  // SNI 的别名：sni 是主流，peer 来自早期 trojan 客户端，servername 来自 sing-box
  const sni = q.get('sni') ?? q.get('peer') ?? q.get('servername');
  if (sni) tls.sni = sni;

  const alpn = splitCsv(q.get('alpn'));
  if (alpn.length > 0) tls.alpn = alpn;

  // fp 是 uTLS 指纹（伪装成 chrome/firefox 的 TLS 握手特征）
  const fp = q.get('fp') ?? q.get('client-fingerprint');
  if (fp) tls.fingerprint = fp;

  // 这个才是证书指纹固定，与上面的 uTLS 指纹是完全不同的两件事
  const certFp = q.get('pinSHA256') ?? q.get('cert-fingerprint');
  if (certFp) tls.certFingerprint = certFp;

  const insecure = parseBool(
    q.get('allowInsecure') ?? q.get('insecure') ?? q.get('skip-cert-verify'),
  );
  // 只在显式为 true 时写入。默认值交给生成器决定 ——
  // 把"未声明"记成"false"会让我们在输出时误报一个上游并未表态的安全设置。
  if (insecure === true) tls.allowInsecure = true;

  if (isReality) {
    const publicKey = q.get('pbk') ?? q.get('public-key');
    if (publicKey) {
      tls.reality = { publicKey };
      const shortId = q.get('sid') ?? q.get('short-id');
      // 空串与缺省在 REALITY 里含义不同（空 shortId 是合法配置），故用 != null 判断
      if (shortId != null) tls.reality.shortId = shortId;
      const spiderX = q.get('spx') ?? q.get('spider-x');
      if (spiderX) tls.reality.spiderX = safeDecodeURIComponent(spiderX);
    }
  }

  return tls;
}

/** 取 URI 的 fragment 作为节点名；没有就用 `host:port` 兜底，保证名字非空。 */
function nameFromUrl(url: URL, server: string, port: number): string {
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  const decoded = safeDecodeURIComponent(hash).trim();
  return decoded.length > 0 ? decoded : `${server}:${port}`;
}

/** 安全地构造 URL 对象。畸形 URI 返回 undefined 而不是抛异常。 */
function toUrl(uri: string): URL | undefined {
  try {
    return new URL(uri);
  } catch {
    return undefined;
  }
}

/** 从 URL 中取出主机与端口，并做合法性校验。 */
function hostPortFromUrl(url: URL): { server: string; port: number } | undefined {
  const server = stripBrackets(url.hostname);
  const port = parsePort(url.port);
  if (server.length === 0 || port === undefined) return undefined;
  return { server, port };
}

// ─────────────────────────────────────────────────────────────
//  VMess
// ─────────────────────────────────────────────────────────────

/** vmess:// 的 base64-JSON 载荷。字段名是 v2rayN 定下的事实标准，全是缩写。 */
interface VmessJson {
  v?: string | number;
  ps?: string;
  add?: string;
  port?: string | number;
  id?: string;
  aid?: string | number;
  scy?: string;
  net?: string;
  type?: string;
  host?: string;
  path?: string;
  tls?: string;
  sni?: string;
  alpn?: string;
  fp?: string;
}

/**
 * 解析 vmess:// URI。
 *
 * 主流形态是 `vmess://` + base64(JSON)，由 v2rayN 定义并被广泛沿用。
 * JSON 里所有字段都可能是字符串或数字（不同生成器行为不一致），所以一律走宽容转换。
 */
function parseVmessUri(uri: string): UriParseOutcome {
  const payload = uri.slice('vmess://'.length);
  const decoded = decodeBase64(payload);
  if (decoded === undefined) return fail('vmess 载荷不是有效的 base64');

  let json: VmessJson;
  try {
    json = JSON.parse(decoded) as VmessJson;
  } catch {
    // 存在一种少见的旧写法 vmess://base64(cipher:uuid@host:port)，
    // 由早期 Shadowrocket 生成。这里不做支持，但要给出准确的失败原因，
    // 避免用户以为是网络问题。
    return fail('vmess 载荷不是 JSON（可能是不受支持的旧式 vmess URI）');
  }

  const server = (json.add ?? '').trim();
  const port = parsePort(json.port);
  const uuid = (json.id ?? '').trim();
  if (!server) return fail('vmess 缺少服务器地址（add）');
  if (port === undefined) return fail('vmess 端口非法或缺失');
  if (!uuid) return fail('vmess 缺少 UUID（id）');

  // net 是传输层，type 是伪装头类型 —— 这两个字段极易混淆。
  // 只有在 net=tcp 且 type=http 时，实际传输才是 HTTP/1.1 伪装。
  const rawNet = (json.net ?? 'tcp').toLowerCase();
  const headerType = (json.type ?? 'none').toLowerCase();
  const network: Network =
    rawNet === 'tcp' && headerType === 'http' ? 'http' : normalizeNetwork(rawNet);

  const transport: Transport = { network };
  const path = json.path ? String(json.path) : undefined;
  const host = json.host ? String(json.host) : undefined;

  switch (network) {
    case 'ws': {
      const ws: NonNullable<Transport['ws']> = {};
      if (path) ws.path = path;
      if (host) ws.headers = { Host: host };
      if (Object.keys(ws).length > 0) transport.ws = ws;
      break;
    }
    case 'grpc': {
      // vmess JSON 没有专门的 serviceName 字段，惯例是复用 path
      if (path) transport.grpc = { serviceName: path };
      break;
    }
    case 'h2': {
      const h2: NonNullable<Transport['h2']> = {};
      if (path) h2.path = path;
      const hosts = splitCsv(host);
      if (hosts.length > 0) h2.host = hosts;
      if (Object.keys(h2).length > 0) transport.h2 = h2;
      break;
    }
    case 'http': {
      const http: NonNullable<Transport['http']> = {};
      const paths = splitCsv(path);
      if (paths.length > 0) http.path = paths;
      const hosts = splitCsv(host);
      if (hosts.length > 0) http.headers = { Host: hosts };
      if (Object.keys(http).length > 0) transport.http = http;
      break;
    }
    default:
      break;
  }

  const node: Omit<VmessNode, 'fingerprint' | 'meta'> = {
    type: 'vmess',
    name: (json.ps ?? '').trim() || `${server}:${port}`,
    server,
    port,
    uuid,
    alterId: Number.parseInt(String(json.aid ?? 0), 10) || 0,
    cipher: (json.scy ?? 'auto').trim() || 'auto',
    transport,
  };

  const tlsFlag = (json.tls ?? '').trim().toLowerCase();
  if (tlsFlag === 'tls' || tlsFlag === 'xtls' || parseBool(tlsFlag) === true) {
    const tls: TlsOptions = { enabled: true };
    if (json.sni) tls.sni = String(json.sni);
    const alpn = splitCsv(json.alpn);
    if (alpn.length > 0) tls.alpn = alpn;
    if (json.fp) tls.fingerprint = String(json.fp);
    node.tls = tls;
  }

  return ok(node);
}

// ─────────────────────────────────────────────────────────────
//  VLESS
// ─────────────────────────────────────────────────────────────

function parseVlessUri(uri: string): UriParseOutcome {
  const url = toUrl(uri);
  if (!url) return fail('vless URI 格式非法');

  const hp = hostPortFromUrl(url);
  if (!hp) return fail('vless 缺少服务器地址或端口非法');

  const uuid = safeDecodeURIComponent(url.username).trim();
  if (!uuid) return fail('vless 缺少 UUID');

  const q = url.searchParams;
  const node: Omit<VlessNode, 'fingerprint' | 'meta'> = {
    type: 'vless',
    name: nameFromUrl(url, hp.server, hp.port),
    server: hp.server,
    port: hp.port,
    uuid,
    transport: transportFromQuery(q),
  };

  const flow = q.get('flow');
  // flow=none 与不写 flow 等价，统一归一化为"不设置"，避免生成配置时
  // 输出 `flow: none` —— 部分客户端会把它当成一个未知的流控算法而报错。
  if (flow && flow !== 'none') node.flow = flow;

  const encryption = q.get('encryption');
  if (encryption && encryption !== 'none') node.encryption = encryption;

  const tls = tlsFromQuery(q);
  if (tls) node.tls = tls;

  return ok(node);
}

// ─────────────────────────────────────────────────────────────
//  Trojan
// ─────────────────────────────────────────────────────────────

function parseTrojanUri(uri: string): UriParseOutcome {
  const url = toUrl(uri);
  if (!url) return fail('trojan URI 格式非法');

  const hp = hostPortFromUrl(url);
  if (!hp) return fail('trojan 缺少服务器地址或端口非法');

  const password = safeDecodeURIComponent(url.username).trim();
  if (!password) return fail('trojan 缺少密码');

  const q = url.searchParams;
  const node: Omit<TrojanNode, 'fingerprint' | 'meta'> = {
    type: 'trojan',
    name: nameFromUrl(url, hp.server, hp.port),
    server: hp.server,
    port: hp.port,
    password,
    transport: transportFromQuery(q),
    // Trojan 协议本身跑在 TLS 之上，URI 里不写 security=tls 也必须启用
    tls: tlsFromQuery(q, true) ?? { enabled: true },
  };

  return ok(node);
}

// ─────────────────────────────────────────────────────────────
//  Shadowsocks
// ─────────────────────────────────────────────────────────────

/**
 * 判断 base64 解码结果是否真的是一个 `method:password` 凭据。
 *
 * 这个校验不是多余的谨慎。SS 的用户信息段既可能是 base64、也可能是明文
 * （两种写法都在流通），所以要先按 base64 试解。问题在于 Node 的
 * `Buffer.from(s, 'base64')` **不会对非法字符报错，而是静默忽略它们** ——
 * 明文 `aes-256-gcm:password` 也能被"解"出一串二进制乱码。
 *
 * 光检查结果里有没有冒号是不够的：乱码里恰好出现冒号的概率并不低
 * （每字节约 1/256），一旦撞上就会把乱码当成凭据，节点静默变成连不上的错误配置。
 *
 * 所以改为校验**冒号之前那一段**：加密方式名在规范里恒为 ASCII 字母数字与连字符
 * （`aes-256-gcm`、`chacha20-ietf-poly1305`），二进制乱码极难满足。
 *
 * 刻意只校验加密方式而不校验整串 —— 密码是允许含非 ASCII 字符的，
 * 拿整串做 ASCII 检查会让带中文密码的节点解析失败。
 */
function looksLikeCredential(decoded: string): boolean {
  const sep = decoded.indexOf(':');
  if (sep <= 0) return false;
  return /^[a-z0-9][a-z0-9-]*$/i.test(decoded.slice(0, sep));
}

/**
 * 解析 SS 的 plugin 参数。
 *
 * 格式是分号分隔：`obfs-local;obfs=http;obfs-host=www.bing.com`
 * 第一段是插件名，其余是键值对。没有 `=` 的段视为布尔开关（如 `tls`）。
 */
function parseSsPlugin(raw: string): PluginOptions | undefined {
  const decoded = safeDecodeURIComponent(raw).trim();
  if (!decoded) return undefined;

  const segments = decoded.split(';').filter((s) => s.length > 0);
  const name = segments[0];
  if (!name) return undefined;

  const opts: Record<string, string | number | boolean> = {};
  for (const seg of segments.slice(1)) {
    const eq = seg.indexOf('=');
    if (eq === -1) {
      opts[seg] = true;
    } else {
      opts[seg.slice(0, eq)] = seg.slice(eq + 1);
    }
  }
  return { name, opts };
}

/**
 * 解析 ss:// URI。
 *
 * 有两种格式并存，且都还在被广泛使用：
 *
 * - **SIP002**（现行标准）：`ss://<base64url(method:password)>@host:port/?plugin=…#name`
 *   用户信息段也可能是未编码的明文 `method:password`。
 * - **旧式**：`ss://<base64(method:password@host:port)>#name`
 *   整个 authority 都在 base64 里。
 *
 * 区分方式：先看 base64 段外面有没有 `@`。有就是 SIP002，没有就是旧式。
 */
function parseSsUri(uri: string): UriParseOutcome {
  const body = uri.slice('ss://'.length);

  // 先切掉 fragment。注意不能用 URL 解析后再取 hash，因为旧式格式的
  // base64 段里可能含有 `/` 等字符，会被 URL 当成 path 而错位。
  const hashIdx = body.indexOf('#');
  const fragment = hashIdx === -1 ? '' : body.slice(hashIdx + 1);
  const beforeHash = hashIdx === -1 ? body : body.slice(0, hashIdx);
  const nameFromFragment = safeDecodeURIComponent(fragment).trim();

  const atIdx = beforeHash.lastIndexOf('@');

  if (atIdx !== -1) {
    // ── SIP002 ──────────────────────────────────────────
    const userinfo = beforeHash.slice(0, atIdx);
    const rest = beforeHash.slice(atIdx + 1);

    // userinfo 优先按 base64url 解；解不出可信的 `method:password` 就当明文处理
    const decodedUserinfo = decodeBase64(userinfo);
    const credential =
      decodedUserinfo && looksLikeCredential(decodedUserinfo)
        ? decodedUserinfo
        : safeDecodeURIComponent(userinfo);

    const sep = credential.indexOf(':');
    if (sep === -1) return fail('ss 用户信息缺少 method:password 分隔符');
    const cipher = credential.slice(0, sep);
    const password = credential.slice(sep + 1);
    if (!cipher || !password) return fail('ss 加密方式或密码为空');

    // rest 形如 `host:port/?plugin=…`。用一个占位 scheme 交给 URL 解析，
    // 这样 IPv6 方括号、查询参数都能被正确处理。
    const parsed = toUrl(`ss://placeholder@${rest}`);
    if (!parsed) return fail('ss 服务器地址格式非法');
    const hp = hostPortFromUrl(parsed);
    if (!hp) return fail('ss 缺少服务器地址或端口非法');

    const node: Omit<SsNode, 'fingerprint' | 'meta'> = {
      type: 'ss',
      name: nameFromFragment || `${hp.server}:${hp.port}`,
      server: hp.server,
      port: hp.port,
      cipher,
      password,
    };

    const plugin = parsed.searchParams.get('plugin');
    if (plugin) {
      const parsedPlugin = parseSsPlugin(plugin);
      if (parsedPlugin) node.plugin = parsedPlugin;
    }

    return ok(node);
  }

  // ── 旧式：整段 base64 ────────────────────────────────
  const decoded = decodeBase64(beforeHash);
  if (!decoded) return fail('ss 载荷不是有效的 base64');

  const lastAt = decoded.lastIndexOf('@');
  if (lastAt === -1) return fail('ss 载荷缺少 @ 分隔符');
  const credential = decoded.slice(0, lastAt);
  const hostPort = decoded.slice(lastAt + 1);

  const sep = credential.indexOf(':');
  if (sep === -1) return fail('ss 用户信息缺少 method:password 分隔符');
  const cipher = credential.slice(0, sep);
  const password = credential.slice(sep + 1);
  if (!cipher || !password) return fail('ss 加密方式或密码为空');

  const parsed = toUrl(`ss://placeholder@${hostPort}`);
  if (!parsed) return fail('ss 服务器地址格式非法');
  const hp = hostPortFromUrl(parsed);
  if (!hp) return fail('ss 缺少服务器地址或端口非法');

  return ok({
    type: 'ss',
    name: nameFromFragment || `${hp.server}:${hp.port}`,
    server: hp.server,
    port: hp.port,
    cipher,
    password,
  });
}

// ─────────────────────────────────────────────────────────────
//  ShadowsocksR
// ─────────────────────────────────────────────────────────────

/**
 * 解析 ssr:// URI。
 *
 * 格式（整体再套一层 base64url）：
 * `host:port:protocol:method:obfs:base64url(password)/?obfsparam=…&protoparam=…&remarks=…&group=…`
 *
 * 注意查询参数的值本身也是 base64url 编码的 —— SSR 时代还没人考虑百分号编码。
 */
function parseSsrUri(uri: string): UriParseOutcome {
  const decoded = decodeBase64(uri.slice('ssr://'.length));
  if (!decoded) return fail('ssr 载荷不是有效的 base64');

  const queryIdx = decoded.indexOf('/?');
  const main = queryIdx === -1 ? decoded : decoded.slice(0, queryIdx);
  const query = queryIdx === -1 ? '' : decoded.slice(queryIdx + 2);

  const parts = main.split(':');
  if (parts.length < 6) return fail('ssr 主体字段不足 6 段');

  // 末 5 段位置固定；多出来的前缀段属于 host（IPv6 字面量含冒号）。
  const tail = parts.slice(-5);
  const host = parts.slice(0, parts.length - 5).join(':');
  const [portRaw, protocol, method, obfs, passwordB64] = tail as [
    string,
    string,
    string,
    string,
    string,
  ];

  const server = stripBrackets(host);
  const port = parsePort(portRaw);
  if (!server) return fail('ssr 缺少服务器地址');
  if (port === undefined) return fail('ssr 端口非法');

  const password = decodeBase64(passwordB64);
  if (password === undefined) return fail('ssr 密码不是有效的 base64');

  const q = new URLSearchParams(query);
  /** SSR 的查询参数值全部是 base64url，解不开就当没有。 */
  const b64Param = (key: string): string | undefined => {
    const v = q.get(key);
    if (!v) return undefined;
    return decodeBase64(v);
  };

  const node: Omit<SsrNode, 'fingerprint' | 'meta'> = {
    type: 'ssr',
    name: b64Param('remarks')?.trim() || `${server}:${port}`,
    server,
    port,
    cipher: method,
    password,
    protocol,
    obfs,
  };

  const protoParam = b64Param('protoparam');
  if (protoParam) node.protocolParam = protoParam;
  const obfsParam = b64Param('obfsparam');
  if (obfsParam) node.obfsParam = obfsParam;

  return ok(node);
}

// ─────────────────────────────────────────────────────────────
//  Hysteria2
// ─────────────────────────────────────────────────────────────

function parseHysteria2Uri(uri: string): UriParseOutcome {
  const url = toUrl(uri);
  if (!url) return fail('hysteria2 URI 格式非法');

  const hp = hostPortFromUrl(url);
  if (!hp) return fail('hysteria2 缺少服务器地址或端口非法');

  // Hysteria2 的认证信息是单个字符串，但 URI 里既可能写成 `password@host`
  // 也可能写成 `user:pass@host`（此时完整凭据是 `user:pass`）。
  const user = safeDecodeURIComponent(url.username);
  const pass = safeDecodeURIComponent(url.password);
  const password = pass ? `${user}:${pass}` : user;
  if (!password) return fail('hysteria2 缺少认证密码');

  const q = url.searchParams;
  const node: Omit<Hysteria2Node, 'fingerprint' | 'meta'> = {
    type: 'hysteria2',
    name: nameFromUrl(url, hp.server, hp.port),
    server: hp.server,
    port: hp.port,
    password,
    tls: tlsFromQuery(q, true) ?? { enabled: true },
  };

  const obfs = q.get('obfs');
  if (obfs && obfs !== 'none') {
    node.obfs = obfs;
    const obfsPassword = q.get('obfs-password') ?? q.get('obfs_password');
    if (obfsPassword) node.obfsPassword = obfsPassword;
  }

  const up = q.get('up') ?? q.get('upmbps');
  if (up) node.up = up;
  const down = q.get('down') ?? q.get('downmbps');
  if (down) node.down = down;

  return ok(node);
}

// ─────────────────────────────────────────────────────────────
//  TUIC
// ─────────────────────────────────────────────────────────────

function parseTuicUri(uri: string): UriParseOutcome {
  const url = toUrl(uri);
  if (!url) return fail('tuic URI 格式非法');

  const hp = hostPortFromUrl(url);
  if (!hp) return fail('tuic 缺少服务器地址或端口非法');

  // TUIC v5 的凭据是 uuid:password，两者缺一不可
  const uuid = safeDecodeURIComponent(url.username).trim();
  const password = safeDecodeURIComponent(url.password);
  if (!uuid) return fail('tuic 缺少 UUID');
  if (!password) return fail('tuic 缺少密码');

  const q = url.searchParams;
  const node: Omit<TuicNode, 'fingerprint' | 'meta'> = {
    type: 'tuic',
    name: nameFromUrl(url, hp.server, hp.port),
    server: hp.server,
    port: hp.port,
    uuid,
    password,
    tls: tlsFromQuery(q, true) ?? { enabled: true },
  };

  const cc = q.get('congestion_control') ?? q.get('congestion-controller');
  if (cc) node.congestionController = cc;
  const udpMode = q.get('udp_relay_mode') ?? q.get('udp-relay-mode');
  if (udpMode) node.udpRelayMode = udpMode;

  return ok(node);
}
