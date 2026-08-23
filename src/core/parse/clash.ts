/**
 * Clash / Clash.Meta(mihomo) YAML 订阅的解析。
 *
 * 我们只关心 `proxies:` 这一段 —— 上游的 `rules:` 与 `proxy-groups:` 是订阅提供方
 * 对**他们自己那批节点**的编排，聚合多个订阅后这些编排必然冲突（两个机场都定义了
 * 名为"自动选择"的分组，规则里互相引用不存在的节点）。所以 v1 的策略是：
 * **只取节点，分组与规则由我们自己按模板生成**。
 *
 * Clash 的字段命名与 URI 方言又是另一套（`servername` 而不是 `sni`，
 * `skip-cert-verify` 而不是 `allowInsecure`），而且新旧版本之间还有差异
 * （老版本用 `ws-path` / `ws-headers`，新版本用 `ws-opts`）。两套都要认。
 */

import { parse as parseYaml } from 'yaml';
import type {
  Hysteria2Node,
  Network,
  ParseIssue,
  ParseResult,
  PluginOptions,
  ProxyNodeDraft,
  SsNode,
  SsrNode,
  TlsOptions,
  Transport,
  TrojanNode,
  TuicNode,
  VlessNode,
  VmessNode,
} from '../types.js';
import { parseBool, parsePort, splitCsv, stripBrackets, truncate } from './util.js';

// ─────────────────────────────────────────────────────────────
//  从 unknown 中安全取值
// ─────────────────────────────────────────────────────────────
//
// YAML 来自外部，结构完全不可信。这几个 helper 承担"把 unknown 收窄成期望类型"的
// 职责，取不到就返回 undefined，绝不抛异常。支持传入多个候选键名，
// 用于吸收 Clash 新旧版本的字段名差异。

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pick(o: Rec, keys: string[]): unknown {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function str(o: Rec, ...keys: string[]): string | undefined {
  const v = pick(o, keys);
  if (v === undefined) return undefined;
  // YAML 会把 `password: 12345678` 解析成数字，但它其实是密码字符串。
  // 这类"看起来像数字的密码"在机场配置里非常常见，必须转回字符串。
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return typeof v === 'string' ? v : undefined;
}

function bool(o: Rec, ...keys: string[]): boolean | undefined {
  return parseBool(pick(o, keys));
}

function rec(o: Rec, ...keys: string[]): Rec | undefined {
  const v = pick(o, keys);
  return isRecord(v) ? v : undefined;
}

/** 取字符串数组。YAML 里可能写成数组，也可能写成逗号分隔的字符串。 */
function strList(o: Rec, ...keys: string[]): string[] | undefined {
  const v = pick(o, keys);
  if (Array.isArray(v)) {
    const list = v.filter((x): x is string => typeof x === 'string');
    return list.length > 0 ? list : undefined;
  }
  if (typeof v === 'string') {
    const list = splitCsv(v);
    return list.length > 0 ? list : undefined;
  }
  return undefined;
}

/** 把 `{Host: "x"}` 这类头部映射收窄成 Record<string,string>。 */
function headerMap(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') out[k] = val;
    else if (Array.isArray(val) && typeof val[0] === 'string') out[k] = val[0];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ─────────────────────────────────────────────────────────────
//  传输层与 TLS
// ─────────────────────────────────────────────────────────────

function networkOf(p: Rec): Network {
  const raw = (str(p, 'network') ?? 'tcp').toLowerCase();
  switch (raw) {
    case 'ws':
      return 'ws';
    case 'grpc':
      return 'grpc';
    case 'h2':
      return 'h2';
    case 'http':
      return 'http';
    case 'quic':
      return 'quic';
    default:
      return 'tcp';
  }
}

function transportOf(p: Rec): Transport {
  const network = networkOf(p);
  const t: Transport = { network };

  switch (network) {
    case 'ws': {
      // 新版：ws-opts: { path, headers, max-early-data }
      // 老版：ws-path / ws-headers（Clash 1.x 早期）—— 仍有订阅在用
      const opts = rec(p, 'ws-opts');
      const path = opts ? str(opts, 'path') : str(p, 'ws-path');
      const headers = headerMap(opts ? opts['headers'] : p['ws-headers']);
      const ws: NonNullable<Transport['ws']> = {};
      if (path) ws.path = path;
      if (headers) ws.headers = headers;
      if (opts) {
        const med = opts['max-early-data'];
        if (typeof med === 'number' && med > 0) ws.maxEarlyData = med;
        const edh = str(opts, 'early-data-header-name');
        if (edh) ws.earlyDataHeaderName = edh;
      }
      if (Object.keys(ws).length > 0) t.ws = ws;
      break;
    }
    case 'grpc': {
      const opts = rec(p, 'grpc-opts');
      const serviceName = opts ? str(opts, 'grpc-service-name', 'serviceName') : undefined;
      if (serviceName) t.grpc = { serviceName };
      break;
    }
    case 'h2': {
      const opts = rec(p, 'h2-opts');
      if (opts) {
        const h2: NonNullable<Transport['h2']> = {};
        const path = str(opts, 'path');
        if (path) h2.path = path;
        const host = strList(opts, 'host');
        if (host) h2.host = host;
        if (Object.keys(h2).length > 0) t.h2 = h2;
      }
      break;
    }
    case 'http': {
      const opts = rec(p, 'http-opts');
      if (opts) {
        const http: NonNullable<Transport['http']> = {};
        const method = str(opts, 'method');
        if (method) http.method = method;
        const path = strList(opts, 'path');
        if (path) http.path = path;
        const headers = opts['headers'];
        if (isRecord(headers)) {
          const out: Record<string, string[]> = {};
          for (const [k, v] of Object.entries(headers)) {
            if (Array.isArray(v)) {
              const list = v.filter((x): x is string => typeof x === 'string');
              if (list.length > 0) out[k] = list;
            } else if (typeof v === 'string') {
              out[k] = [v];
            }
          }
          if (Object.keys(out).length > 0) http.headers = out;
        }
        if (Object.keys(http).length > 0) t.http = http;
      }
      break;
    }
    default:
      break;
  }

  return t;
}

/**
 * 提取 TLS 配置。
 *
 * @param forceEnabled 协议本身以 TLS 为前提时传 true（trojan / hysteria2 / tuic）。
 *   这些协议的 Clash 配置里通常根本不写 `tls: true`，因为那是隐含的。
 */
function tlsOf(p: Rec, forceEnabled = false): TlsOptions | undefined {
  const reality = rec(p, 'reality-opts');
  const enabled = forceEnabled || bool(p, 'tls') === true || reality !== undefined;
  if (!enabled) return undefined;

  const tls: TlsOptions = { enabled: true };

  // Clash 管 SNI 叫 servername（vmess/vless）或 sni（trojan/hysteria2/tuic）
  const sni = str(p, 'servername', 'sni', 'server-name');
  if (sni) tls.sni = sni;

  const alpn = strList(p, 'alpn');
  if (alpn) tls.alpn = alpn;

  const clientFp = str(p, 'client-fingerprint');
  if (clientFp) tls.fingerprint = clientFp;

  // 注意：Clash 里 `fingerprint` 指的是**证书**指纹固定，
  // `client-fingerprint` 才是 uTLS 指纹。两者语义完全不同，不能混。
  const certFp = str(p, 'fingerprint');
  if (certFp) tls.certFingerprint = certFp;

  if (bool(p, 'skip-cert-verify') === true) tls.allowInsecure = true;

  if (reality) {
    const publicKey = str(reality, 'public-key');
    if (publicKey) {
      tls.reality = { publicKey };
      const shortId = str(reality, 'short-id');
      if (shortId != null) tls.reality.shortId = shortId;
    }
  }

  return tls;
}

// ─────────────────────────────────────────────────────────────
//  单个 proxy → ProxyNodeDraft
// ─────────────────────────────────────────────────────────────

type ProxyOutcome = { ok: true; node: ProxyNodeDraft } | { ok: false; reason: string };

/**
 * 把一个 Clash `proxies` 条目转成统一节点模型。
 *
 * 公共字段（name/server/port）先校验，然后按 `type` 分派到各协议分支。
 */
export function parseClashProxy(input: unknown): ProxyOutcome {
  if (!isRecord(input)) return { ok: false, reason: '不是一个对象' };

  const type = (str(input, 'type') ?? '').toLowerCase();
  const serverRaw = str(input, 'server');
  const port = parsePort(pick(input, ['port']) as string | number | undefined);

  if (!serverRaw) return { ok: false, reason: '缺少 server 字段' };
  if (port === undefined) return { ok: false, reason: 'port 字段非法或缺失' };

  const server = stripBrackets(serverRaw.trim());
  const name = (str(input, 'name') ?? '').trim() || `${server}:${port}`;
  const udp = bool(input, 'udp');

  /** 各分支共用的基础字段。 */
  const base = { name, server, port, ...(udp !== undefined ? { udp } : {}) };

  switch (type) {
    case 'vmess': {
      const uuid = str(input, 'uuid');
      if (!uuid) return { ok: false, reason: 'vmess 缺少 uuid' };
      const node: Omit<VmessNode, 'fingerprint' | 'meta'> = {
        ...base,
        type: 'vmess',
        uuid,
        alterId: Number(pick(input, ['alterId', 'alterid']) ?? 0) || 0,
        cipher: str(input, 'cipher') ?? 'auto',
        transport: transportOf(input),
      };
      const tls = tlsOf(input);
      if (tls) node.tls = tls;
      return { ok: true, node };
    }

    case 'vless': {
      const uuid = str(input, 'uuid');
      if (!uuid) return { ok: false, reason: 'vless 缺少 uuid' };
      const node: Omit<VlessNode, 'fingerprint' | 'meta'> = {
        ...base,
        type: 'vless',
        uuid,
        transport: transportOf(input),
      };
      const flow = str(input, 'flow');
      if (flow && flow !== 'none') node.flow = flow;
      // VLESS 在 Clash 里即使不写 tls: true，只要有 reality-opts 就是加密的；
      // tlsOf 已处理这一点。
      const tls = tlsOf(input);
      if (tls) node.tls = tls;
      return { ok: true, node };
    }

    case 'trojan': {
      const password = str(input, 'password');
      if (!password) return { ok: false, reason: 'trojan 缺少 password' };
      const node: Omit<TrojanNode, 'fingerprint' | 'meta'> = {
        ...base,
        type: 'trojan',
        password,
        transport: transportOf(input),
        tls: tlsOf(input, true) ?? { enabled: true },
      };
      return { ok: true, node };
    }

    case 'ss':
    case 'shadowsocks': {
      const cipher = str(input, 'cipher');
      const password = str(input, 'password');
      if (!cipher) return { ok: false, reason: 'ss 缺少 cipher' };
      if (!password) return { ok: false, reason: 'ss 缺少 password' };
      const node: Omit<SsNode, 'fingerprint' | 'meta'> = {
        ...base,
        type: 'ss',
        cipher,
        password,
      };
      const pluginName = str(input, 'plugin');
      if (pluginName) {
        const pluginOpts = rec(input, 'plugin-opts');
        const opts: PluginOptions['opts'] = {};
        if (pluginOpts) {
          for (const [k, v] of Object.entries(pluginOpts)) {
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
              opts[k] = v;
            }
          }
        }
        node.plugin = { name: pluginName, opts };
      }
      return { ok: true, node };
    }

    case 'ssr': {
      const cipher = str(input, 'cipher');
      const password = str(input, 'password');
      const protocol = str(input, 'protocol');
      const obfs = str(input, 'obfs');
      if (!cipher || !password || !protocol || !obfs) {
        return { ok: false, reason: 'ssr 缺少 cipher/password/protocol/obfs 之一' };
      }
      const node: Omit<SsrNode, 'fingerprint' | 'meta'> = {
        ...base,
        type: 'ssr',
        cipher,
        password,
        protocol,
        obfs,
      };
      const protocolParam = str(input, 'protocol-param', 'protocolparam');
      if (protocolParam) node.protocolParam = protocolParam;
      const obfsParam = str(input, 'obfs-param', 'obfsparam');
      if (obfsParam) node.obfsParam = obfsParam;
      return { ok: true, node };
    }

    case 'hysteria2':
    case 'hy2': {
      const password = str(input, 'password', 'auth');
      if (!password) return { ok: false, reason: 'hysteria2 缺少 password' };
      const node: Omit<Hysteria2Node, 'fingerprint' | 'meta'> = {
        ...base,
        type: 'hysteria2',
        password,
        tls: tlsOf(input, true) ?? { enabled: true },
      };
      const obfs = str(input, 'obfs');
      if (obfs && obfs !== 'none') {
        node.obfs = obfs;
        const obfsPassword = str(input, 'obfs-password');
        if (obfsPassword) node.obfsPassword = obfsPassword;
      }
      const up = str(input, 'up');
      if (up) node.up = up;
      const down = str(input, 'down');
      if (down) node.down = down;
      return { ok: true, node };
    }

    case 'tuic': {
      const uuid = str(input, 'uuid');
      const password = str(input, 'password');
      if (!uuid) return { ok: false, reason: 'tuic 缺少 uuid' };
      if (!password) return { ok: false, reason: 'tuic 缺少 password' };
      const node: Omit<TuicNode, 'fingerprint' | 'meta'> = {
        ...base,
        type: 'tuic',
        uuid,
        password,
        tls: tlsOf(input, true) ?? { enabled: true },
      };
      const cc = str(input, 'congestion-controller', 'congestion_control');
      if (cc) node.congestionController = cc;
      const udpMode = str(input, 'udp-relay-mode');
      if (udpMode) node.udpRelayMode = udpMode;
      return { ok: true, node };
    }

    default:
      return { ok: false, reason: `暂不支持的协议：${type || '(未声明)'}` };
  }
}

// ─────────────────────────────────────────────────────────────
//  订阅级入口
// ─────────────────────────────────────────────────────────────

/**
 * 解析 Clash YAML 订阅。
 *
 * 只读 `proxies` 数组。整份 YAML 语法错误会返回一条 issue 而不是抛异常 ——
 * 上游返回 HTML 错误页却带着 200 状态码，是机场挂掉时最常见的表现。
 */
export function parseClashYaml(raw: string): ParseResult {
  const nodes: ProxyNodeDraft[] = [];
  const issues: ParseIssue[] = [];

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    return {
      nodes: [],
      issues: [
        {
          raw: truncate(raw, 200),
          reason: `YAML 解析失败：${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  if (!isRecord(doc)) {
    return { nodes: [], issues: [{ raw: truncate(raw, 200), reason: 'YAML 根节点不是映射' }] };
  }

  const proxies = doc['proxies'];
  if (!Array.isArray(proxies)) {
    return {
      nodes: [],
      issues: [{ raw: truncate(raw, 200), reason: '未找到 proxies 数组' }],
    };
  }

  for (const entry of proxies) {
    const outcome = parseClashProxy(entry);
    if (outcome.ok) {
      nodes.push(outcome.node);
    } else {
      // 用 name 而不是整个对象来标识出错条目：对象序列化后可能含有密码
      const label = isRecord(entry) ? (str(entry, 'name') ?? '(未命名)') : String(entry);
      issues.push({ raw: truncate(label), reason: outcome.reason });
    }
  }

  return { nodes, issues };
}
