/**
 * IX 中转改写的单测。
 *
 * 零 mock：core 是纯函数，测试只需构造输入、断言输出。指纹相关一律走
 * `test/helpers.ts` 的 `makeNode`（内部调 `finalizeNode`），保证指纹口径与生产一致。
 *
 * 这份测试里最重要的两组是 **G 顺序护栏** 与 **I 幂等**：它们锁住的不是某个函数的
 * 返回值，而是两个"错了也不报错、只是静默产出坏配置"的设计决定。
 */

import { describe, expect, it } from 'vitest';
import { expandChain } from '../src/core/chain.js';
import { emit } from '../src/core/emit/index.js';
import { applyFilter } from '../src/core/filter.js';
import { computeFingerprint } from '../src/core/fingerprint.js';
import { applyIx, buildIxRelayNode, type IxEntry } from '../src/core/ix.js';
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
} from '../src/core/types.js';
import { makeNode, stripDerived } from './helpers.js';

// ─────────────────────────────────────────────────────────────
//  夹具
// ─────────────────────────────────────────────────────────────

const ENTRY_HOST = 'shzf.pb.example';
const ENTRY_PORT = 51221;
const ORIGIN = 'landing.example';

type Draft<T> = Partial<Omit<T, 'type' | 'fingerprint' | 'meta'>>;

function vmess(over: Draft<VmessNode> = {}): ProxyNode {
  return makeNode({
    type: 'vmess',
    name: 'VM',
    server: ORIGIN,
    port: 443,
    uuid: '11111111-1111-1111-1111-111111111111',
    alterId: 0,
    cipher: 'auto',
    transport: { network: 'tcp' },
    ...over,
  });
}

function vless(over: Draft<VlessNode> = {}): ProxyNode {
  return makeNode({
    type: 'vless',
    name: 'VL',
    server: ORIGIN,
    port: 443,
    uuid: '22222222-2222-2222-2222-222222222222',
    transport: { network: 'tcp' },
    tls: { enabled: true },
    ...over,
  });
}

function trojan(over: Draft<TrojanNode> = {}): ProxyNode {
  return makeNode({
    type: 'trojan',
    name: 'TJ',
    server: ORIGIN,
    port: 443,
    password: 'pw-trojan',
    transport: { network: 'tcp' },
    tls: { enabled: true },
    ...over,
  });
}

function ss(over: Draft<SsNode> = {}): ProxyNode {
  return makeNode({
    type: 'ss',
    name: 'SS',
    server: ORIGIN,
    port: 8388,
    cipher: 'aes-128-gcm',
    password: 'pw-ss',
    ...over,
  });
}

function ssr(over: Draft<SsrNode> = {}): ProxyNode {
  return makeNode({
    type: 'ssr',
    name: 'SSR',
    server: ORIGIN,
    port: 8389,
    cipher: 'aes-256-cfb',
    password: 'pw-ssr',
    protocol: 'auth_aes128_md5',
    obfs: 'plain',
    ...over,
  });
}

function hy2(over: Draft<Hysteria2Node> = {}): ProxyNode {
  return makeNode({
    type: 'hysteria2',
    name: 'HY2',
    server: ORIGIN,
    port: 8443,
    password: 'pw-hy2',
    tls: { enabled: true },
    ...over,
  });
}

function tuic(over: Draft<TuicNode> = {}): ProxyNode {
  return makeNode({
    type: 'tuic',
    name: 'TUIC',
    server: ORIGIN,
    port: 8444,
    uuid: '33333333-3333-3333-3333-333333333333',
    password: 'pw-tuic',
    tls: { enabled: true },
    ...over,
  });
}

function entry(over: Partial<IxEntry> = {}): IxEntry {
  return { entryHost: ENTRY_HOST, entryPort: ENTRY_PORT, status: 'active', ...over };
}

function mapOf(...pairs: readonly (readonly [ProxyNode, IxEntry])[]): Map<string, IxEntry> {
  return new Map(pairs.map(([node, e]) => [node.fingerprint, e] as const));
}

/** 单节点走一趟，最常用的形态。 */
function once(node: ProxyNode, e: IxEntry = entry(), options = {}) {
  return applyIx([node], mapOf([node, e]), options);
}

function tlsOf(node: ProxyNode): TlsOptions | undefined {
  return 'tls' in node ? node.tls : undefined;
}

function transportOf(node: ProxyNode): Transport | undefined {
  return 'transport' in node ? node.transport : undefined;
}

// ─────────────────────────────────────────────────────────────
//  A 身份守卫
// ─────────────────────────────────────────────────────────────

describe('A 身份守卫：改写绝不动指纹与身份字段', () => {
  const nodes = [
    trojan({ server: 'a.example', name: 'A' }),
    vmess({ server: 'b.example', name: 'B' }),
    ss({ server: 'c.example', name: 'C' }),
  ];
  const entries = mapOf(
    [nodes[0]!, entry({ entryPort: 51221 })],
    [nodes[1]!, entry({ entryPort: 51222 })],
    [nodes[2]!, entry({ entryPort: 51223, udp: true })],
  );

  it('逐节点保留原指纹，且输出顺序与输入一致', () => {
    const out = applyIx(nodes, entries);
    expect(out.stats.rewritten).toBe(3);
    expect(out.nodes.map((n) => n.fingerprint)).toEqual(nodes.map((n) => n.fingerprint));
    expect(out.nodes.map((n) => n.name)).toEqual(['A', 'B', 'C']);
    expect(out.nodes.map((n) => n.server)).toEqual([ENTRY_HOST, ENTRY_HOST, ENTRY_HOST]);
    expect(out.nodes.map((n) => n.port)).toEqual([51221, 51222, 51223]);
  });

  it('刻意不重算指纹 —— 改写后的内容算出来的指纹与保留的那个不相等', () => {
    // 这条断言存在的唯一目的是拦住"顺手修正一下"的好意：重算指纹会让
    // FilterRule.pick、ping 历史、映射表一起失配。
    const rewritten = applyIx(nodes, entries).nodes[0]!;
    expect(computeFingerprint(stripDerived(rewritten))).not.toBe(rewritten.fingerprint);
    expect(rewritten.fingerprint).toBe(nodes[0]!.fingerprint);
  });

  it('meta 与凭据一字不动，ix 标记记下原地址', () => {
    const out = applyIx(nodes, entries);
    expect(out.nodes[0]!.meta).toEqual(nodes[0]!.meta);
    expect((out.nodes[0] as TrojanNode).password).toBe('pw-trojan');
    expect((out.nodes[1] as VmessNode).uuid).toBe('11111111-1111-1111-1111-111111111111');
    expect(out.nodes[0]!.ix).toEqual({
      entryHost: ENTRY_HOST,
      entryPort: 51221,
      originServer: 'a.example',
      originPort: 443,
    });
  });
});

// ─────────────────────────────────────────────────────────────
//  B SNI
// ─────────────────────────────────────────────────────────────

describe('B SNI 补写：把隐式回落固化，绝不越界', () => {
  it('三个 TLS 必填协议缺 sni 时都补成原 server', () => {
    expect(tlsOf(once(trojan()).nodes[0]!)?.sni).toBe(ORIGIN);
    expect(tlsOf(once(hy2(), entry({ udp: true })).nodes[0]!)?.sni).toBe(ORIGIN);
    expect(tlsOf(once(tuic(), entry({ udp: true })).nodes[0]!)?.sni).toBe(ORIGIN);
  });

  it('已有 sni 一律保留（可能是刻意的前置 / CDN 域名）', () => {
    const out = once(trojan({ tls: { enabled: true, sni: 'front.cdn.example' } }));
    expect(tlsOf(out.nodes[0]!)?.sni).toBe('front.cdn.example');
    expect(out.stats.filledSni).toBe(0);
  });

  it('没有 tls 的 vmess 改写后仍然没有 tls —— 绝不凭空创建', () => {
    const out = once(vmess());
    expect(tlsOf(out.nodes[0]!)).toBeUndefined();
    expect(out.stats.rewritten).toBe(1);
    expect(out.stats.filledSni).toBe(0);
  });

  it('tls.enabled 为 false 时不补 sni —— 明文节点不能被改成 TLS 节点', () => {
    const out = once(vmess({ tls: { enabled: false } }));
    expect(tlsOf(out.nodes[0]!)).toEqual({ enabled: false });
  });

  it('allowInsecure / certFingerprint / alpn / reality 前后全等', () => {
    const tls: TlsOptions = {
      enabled: true,
      sni: 'keep.example',
      alpn: ['h2', 'http/1.1'],
      fingerprint: 'chrome',
      certFingerprint: 'aa:bb',
      allowInsecure: false,
    };
    const out = once(trojan({ tls }));
    expect(tlsOf(out.nodes[0]!)).toEqual(tls);
  });

  it('原地址是 IP 字面量时仍补写，但要给出警告', () => {
    const out = once(trojan({ server: '203.0.113.7' }));
    expect(tlsOf(out.nodes[0]!)?.sni).toBe('203.0.113.7');
    expect(out.stats.filledSni).toBe(1);
    expect(out.warnings.join(' ')).toContain('IP 字面量');
  });

  it('fillOriginHost 关掉时地址照改但不补任何东西', () => {
    const out = once(trojan(), entry(), { fillOriginHost: false });
    expect(out.nodes[0]!.server).toBe(ENTRY_HOST);
    expect(tlsOf(out.nodes[0]!)?.sni).toBeUndefined();
    expect(out.stats.filledSni).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
//  C Host
// ─────────────────────────────────────────────────────────────

describe('C Host 补写：键名大小写不敏感，写回同一个键', () => {
  it('ws 没有 headers 时补出 Host', () => {
    const out = once(trojan({ transport: { network: 'ws', ws: { path: '/p' } } }));
    expect(transportOf(out.nodes[0]!)?.ws).toEqual({ path: '/p', headers: { Host: ORIGIN } });
    expect(out.stats.filledHost).toBe(1);
  });

  it('ws 已有小写 host 时值不变，且键集合仍只有一个 —— 绝不造出重复 Host 头', () => {
    // 只查 'Host' 的写法会在这里再塞一个 'Host'：Clash 侧带两个 Host 头，
    // 而 URI 侧（emit/uri.ts 的取值顺序是 Host 优先）拿到新加的那个 ——
    // 同一个节点对象在两种输出格式里表达不一致。
    const out = once(trojan({ transport: { network: 'ws', ws: { headers: { host: 'lower.example' } } } }));
    const headers = transportOf(out.nodes[0]!)?.ws?.headers ?? {};
    expect(Object.keys(headers)).toHaveLength(1);
    expect(headers['host']).toBe('lower.example');
    expect(out.stats.filledHost).toBe(0);
  });

  it('Host 为空字符串时写回同一个键，而不是新增一个', () => {
    const upper = once(trojan({ transport: { network: 'ws', ws: { headers: { Host: '' } } } }));
    expect(transportOf(upper.nodes[0]!)?.ws?.headers).toEqual({ Host: ORIGIN });
    const lower = once(trojan({ transport: { network: 'ws', ws: { headers: { host: '' } } } }));
    const headers = transportOf(lower.nodes[0]!)?.ws?.headers ?? {};
    expect(Object.keys(headers)).toEqual(['host']);
    expect(headers['host']).toBe(ORIGIN);
  });

  it('ws 子对象整体缺失时生成出来', () => {
    const out = once(trojan({ transport: { network: 'ws' } }));
    expect(transportOf(out.nodes[0]!)?.ws).toEqual({ headers: { Host: ORIGIN } });
  });

  it('h2 的 host 是数组：缺失或空数组补一项，已有值不追加', () => {
    const missing = once(vmess({ transport: { network: 'h2', h2: { path: '/h2' } } }));
    expect(transportOf(missing.nodes[0]!)?.h2?.host).toEqual([ORIGIN]);
    const empty = once(vmess({ transport: { network: 'h2', h2: { host: [] } } }));
    expect(transportOf(empty.nodes[0]!)?.h2?.host).toEqual([ORIGIN]);
    // 已有的是候选轮换列表，追加会把请求发到原站不认的 Host
    const present = once(vmess({ transport: { network: 'h2', h2: { host: ['a.example'] } } }));
    expect(transportOf(present.nodes[0]!)?.h2?.host).toEqual(['a.example']);
  });

  it('http 伪装的 headers.Host 必须是数组', () => {
    const out = once(vmess({ transport: { network: 'http', http: { path: ['/'] } } }));
    const host = transportOf(out.nodes[0]!)?.http?.headers?.['Host'];
    expect(Array.isArray(host)).toBe(true);
    expect(host).toEqual([ORIGIN]);
  });

  it('grpc + TLS 只补 sni，serviceName 不动', () => {
    const out = once(vless({ transport: { network: 'grpc', grpc: { serviceName: 'svc', mode: 'gun' } } }));
    expect(tlsOf(out.nodes[0]!)?.sni).toBe(ORIGIN);
    expect(transportOf(out.nodes[0]!)?.grpc).toEqual({ serviceName: 'svc', mode: 'gun' });
    expect(out.stats.filledHost).toBe(0);
  });

  it('tcp + TLS 时 transport 内容不变', () => {
    const out = once(trojan({ transport: { network: 'tcp' } }));
    expect(transportOf(out.nodes[0]!)).toEqual({ network: 'tcp' });
  });
});

// ─────────────────────────────────────────────────────────────
//  D 保守拒绝
// ─────────────────────────────────────────────────────────────

describe('D 保守拒绝：补写救不了的形态一律不改写', () => {
  it('REALITY 缺 sni → 拒绝改写并给出原因', () => {
    const node = vless({ tls: { enabled: true, reality: { publicKey: 'pbk' } } });
    const out = once(node);
    expect(out.nodes[0]!.server).toBe(ORIGIN);
    expect(out.nodes[0]!.ix).toBeUndefined();
    expect(out.skipped[0]!.reason).toBe('reality-without-sni');
    expect(out.skipped[0]!.outcome).toBe('direct');
    expect(out.stats.skippedUnsafe).toBe(1);
  });

  it('REALITY 有 sni → 正常改写，伪装域名一字不动', () => {
    const node = vless({
      tls: { enabled: true, sni: 'www.microsoft.com', reality: { publicKey: 'pbk', shortId: '' } },
    });
    const out = once(node);
    expect(out.nodes[0]!.server).toBe(ENTRY_HOST);
    expect(tlsOf(out.nodes[0]!)?.sni).toBe('www.microsoft.com');
    expect(tlsOf(out.nodes[0]!)?.reality).toEqual({ publicKey: 'pbk', shortId: '' });
  });

  it('ss 带插件 → 拒绝；force 逃生阀下改写但插件参数一字不动', () => {
    const node = ss({ plugin: { name: 'obfs-local', opts: { obfs: 'http' } } });
    const rejected = once(node);
    expect(rejected.skipped[0]!.reason).toBe('ss-plugin');
    expect(rejected.nodes[0]!.server).toBe(ORIGIN);

    const forced = once(node, entry(), { onUnsafe: 'force' });
    expect(forced.nodes[0]!.server).toBe(ENTRY_HOST);
    expect((forced.nodes[0] as SsNode).plugin).toEqual({ name: 'obfs-local', opts: { obfs: 'http' } });
    expect(forced.warnings.join(' ')).toContain('force');
  });

  it('ss 无插件 → 正常改写', () => {
    const out = once(ss());
    expect(out.nodes[0]!.server).toBe(ENTRY_HOST);
    expect(out.skipped).toHaveLength(0);
  });

  it('ssr 三态：需要 host 的 obfs 缺 param 拒绝，plain 与有 param 都改写', () => {
    const bare = once(ssr({ obfs: 'http_simple' }));
    expect(bare.skipped[0]!.reason).toBe('ssr-obfs-param');
    const plain = once(ssr({ obfs: 'plain' }));
    expect(plain.nodes[0]!.server).toBe(ENTRY_HOST);
    const withParam = once(ssr({ obfs: 'tls1.2_ticket_auth', obfsParam: 'cloudflare.com' }));
    expect(withParam.nodes[0]!.server).toBe(ENTRY_HOST);
    expect((withParam.nodes[0] as SsrNode).obfsParam).toBe('cloudflare.com');
    // _compatible 变体是同一混淆的兼容模式，必须一并拦下
    expect(once(ssr({ obfs: 'http_post_compatible' })).skipped[0]!.reason).toBe('ssr-obfs-param');
  });

  it('明文 gRPC → 拒绝（模型里没有能表达 authority 的字段）', () => {
    const out = once(vmess({ transport: { network: 'grpc', grpc: { serviceName: 'svc' } } }));
    expect(out.skipped[0]!.reason).toBe('grpc-without-tls');
    expect(out.nodes[0]!.server).toBe(ORIGIN);
  });

  it('每条跳过记录都给出可操作的下一步', () => {
    const cases = [
      once(vless({ tls: { enabled: true, reality: { publicKey: 'p' } } })),
      once(ss({ plugin: { name: 'obfs-local', opts: {} } })),
      once(ssr({ obfs: 'http_simple' })),
      once(vmess({ transport: { network: 'grpc' } })),
      once(hy2(), entry({ udp: false })),
      applyIx([ss()], new Map()),
      once(ss(), entry({ status: 'suspended' })),
    ];
    for (const out of cases) {
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0]!.detail).toContain('下一步');
    }
  });
});

// ─────────────────────────────────────────────────────────────
//  E 映射与状态
// ─────────────────────────────────────────────────────────────

describe('E 映射与入口状态', () => {
  it('没有映射 → 保持原值、进 skipped、留警告', () => {
    const node = ss();
    const out = applyIx([node], new Map());
    expect(out.nodes[0]).toBe(node);
    expect(out.stats.skippedNoMapping).toBe(1);
    expect(out.stats.unchanged).toBe(1);
    expect(out.skipped[0]!.reason).toBe('no-mapping');
    expect(out.skipped[0]!.outcome).toBe('direct');
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  it('非 active 状态一律不可用', () => {
    for (const status of ['suspended', 'expired', 'pending', 'unknown'] as const) {
      const out = once(ss(), entry({ status }));
      expect(out.nodes[0]!.server).toBe(ORIGIN);
      expect(out.skipped[0]!.reason).toBe('entry-unusable');
      expect(out.stats.skippedEntryUnusable).toBe(1);
    }
  });

  it('onMissing=drop 时节点被丢弃，但仍然留下记录', () => {
    const out = applyIx([ss()], new Map(), { onMissing: 'drop' });
    expect(out.nodes).toHaveLength(0);
    expect(out.stats.dropped).toBe(1);
    expect(out.skipped[0]!.outcome).toBe('dropped');
  });

  it('入口地址非法时绝不输出 port: 0 之类的配置', () => {
    for (const bad of [entry({ entryPort: 0 }), entry({ entryPort: 70000 }), entry({ entryHost: '' })]) {
      const out = once(ss(), bad);
      expect(out.skipped[0]!.reason).toBe('entry-invalid');
      expect(out.nodes[0]!.port).toBe(8388);
      expect(out.nodes[0]!.server).toBe(ORIGIN);
    }
  });

  it('入口主机名过 normalizeHost，输出一律小写', () => {
    const out = once(ss(), entry({ entryHost: 'SHZF.PB.Example.' }));
    expect(out.nodes[0]!.server).toBe(ENTRY_HOST);
    expect(out.nodes[0]!.ix?.entryHost).toBe(ENTRY_HOST);
  });

  it('两个节点指向同一 host:port → duplicateEntries 报出来', () => {
    const a = ss({ server: 'a.example' });
    const b = ss({ server: 'b.example' });
    const out = applyIx([a, b], mapOf([a, entry()], [b, entry()]));
    expect(out.stats.duplicateEntries).toBe(1);
    expect(out.warnings.join(' ')).toContain('同一个 host:port');
  });

  it('用不到的映射 → unusedEntries 报出来', () => {
    const node = ss();
    const ghost = ss({ server: 'ghost.example' });
    const out = applyIx([node], mapOf([node, entry()], [ghost, entry({ entryPort: 51299 })]));
    expect(out.stats.unusedEntries).toBe(1);
  });

  it('映射全空不抛异常', () => {
    expect(() => applyIx([ss(), vmess()], new Map())).not.toThrow();
    expect(applyIx([], new Map()).nodes).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
//  F UDP 三态
// ─────────────────────────────────────────────────────────────

describe('F UDP：事实由 services 传入，策略走选项', () => {
  it('协议本体跑 UDP 而入口明确不转 → 拒绝（输出它就是输出一个死节点）', () => {
    const out = once(hy2(), entry({ udp: false }));
    expect(out.skipped[0]!.reason).toBe('udp-not-forwarded');
    expect(out.stats.skippedUdp).toBe(1);
    expect(out.nodes[0]!.server).toBe(ORIGIN);
  });

  it('入口 UDP 能力未知：lenient 照改并警告，strict 拒绝', () => {
    const lenient = once(tuic());
    expect(lenient.nodes[0]!.server).toBe(ENTRY_HOST);
    expect(lenient.warnings.join(' ')).toContain('未知');
    const strict = once(tuic(), entry(), { udpPolicy: 'strict' });
    expect(strict.skipped[0]!.reason).toBe('udp-not-forwarded');
  });

  it('quic 传输的 vmess 同样按 UDP 系判定', () => {
    const out = once(vmess({ transport: { network: 'quic' } }), entry({ udp: false }));
    expect(out.skipped[0]!.reason).toBe('udp-not-forwarded');
  });

  it('TCP 系节点的 udp 能力如实降级，而不是留个黑洞', () => {
    const node = ss({ udp: true });
    const out = once(node, entry({ udp: false }));
    expect(out.nodes[0]!.udp).toBe(false);
    expect(out.stats.udpDowngraded).toBe(1);
    expect(out.warnings.join(' ')).toContain('降级');
  });

  it('关掉 downgradeUdp 则保持 true，但必须明说 UDP 会进黑洞', () => {
    const out = once(ss({ udp: true }), entry({ udp: false }), { downgradeUdp: false });
    expect(out.nodes[0]!.udp).toBe(true);
    expect(out.stats.udpDowngraded).toBe(0);
    expect(out.warnings.join(' ')).toContain('黑洞');
  });

  it('入口明确转 UDP 时不产生任何 UDP 相关警告', () => {
    const out = once(hy2(), entry({ udp: true }));
    expect(out.nodes[0]!.server).toBe(ENTRY_HOST);
    expect(out.warnings).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
//  G 顺序护栏
// ─────────────────────────────────────────────────────────────

describe('G 顺序护栏：applyFilter → applyIx 的顺序是正确性要求', () => {
  const nodes = [
    ss({ server: 'a.example', name: 'A' }),
    ss({ server: 'b.example', name: 'B' }),
    ss({ server: 'c.example', name: 'C' }),
  ];
  /** 三个节点指向同一个转发端口 —— 现实里是配错，但正是它暴露顺序问题。 */
  const sameEntry = mapOf([nodes[0]!, entry()], [nodes[1]!, entry()], [nodes[2]!, entry()]);
  const distinctEntry = mapOf(
    [nodes[0]!, entry({ entryPort: 51221 })],
    [nodes[1]!, entry({ entryPort: 51222 })],
    [nodes[2]!, entry({ entryPort: 51223 })],
  );

  it('applyIx 必须在 applyFilter 之后 —— 反过来会静默折叠成 1 个', () => {
    // 正序：去重看到的是原始地址，三个节点各自留下，随后才换成入口地址。
    const right = applyIx(applyFilter(nodes, { dedupe: 'server-port' }).nodes, sameEntry);
    expect(right.nodes).toHaveLength(3);
    expect(right.stats.rewritten).toBe(3);

    // 反序：改写先跑，dedupeKey(node,'server-port') 看到的三个键完全一样，
    // 于是被折叠成一个。留下哪个由输入顺序决定（filter.ts 的去重是"先到先留"），
    // 用户勾选的另外两个节点凭空消失，而且没有任何报错。
    const wrong = applyFilter(applyIx(nodes, sameEntry).nodes, { dedupe: 'server-port' });
    expect(wrong.nodes).toHaveLength(1);
    expect(wrong.stats.droppedByDedupe).toBe(2);
  });

  it('同域名不同端口不会被 server-port 去重折叠', () => {
    const out = applyFilter(applyIx(nodes, distinctEntry).nodes, { dedupe: 'server-port' });
    expect(out.nodes).toHaveLength(3);
    expect(out.stats.droppedByDedupe).toBe(0);
  });

  it('保留原指纹同时保住了 fingerprint 去重语义：改写前后节点数一致', () => {
    const before = applyFilter(nodes, { dedupe: 'fingerprint' }).nodes.length;
    const after = applyFilter(applyIx(nodes, sameEntry).nodes, { dedupe: 'fingerprint' }).nodes.length;
    expect(after).toBe(before);
    expect(after).toBe(3);
  });

  it('rename 把名字全改掉之后，映射依然全部命中（改名不改指纹）', () => {
    const renamed = applyFilter(nodes, { rename: [{ replace: '香港 {index2}' }] });
    expect(renamed.nodes.map((n) => n.name)).toEqual(['香港 01', '香港 02', '香港 03']);
    const out = applyIx(renamed.nodes, distinctEntry);
    expect(out.stats.rewritten).toBe(3);
    expect(out.skipped).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
//  H 与 chain / emit 协同
// ─────────────────────────────────────────────────────────────

describe('H 与 chain / emit 协同', () => {
  const entryNode = ss({ server: 'entry.example', name: 'Entry' });
  const landing = trojan({
    server: ORIGIN,
    name: 'Landing',
    transport: { network: 'ws', ws: { path: '/ws' } },
  });
  const entries = mapOf(
    [entryNode, entry({ entryPort: 51221, udp: true })],
    [landing, entry({ entryPort: 51222 })],
  );
  const chainRule = {
    enabled: true,
    entry: { pick: [entryNode.fingerprint] },
    landing: { pick: [landing.fingerprint] },
  };

  it('filter → ix → chain：派生节点的 server 是入口、sni 是原地址', () => {
    const ixOut = applyIx(applyFilter([entryNode, landing], {}).nodes, entries);
    const chained = expandChain(ixOut.nodes, chainRule);
    const derived = chained.nodes.find((n) => n.chain)!;
    expect(derived.server).toBe(ENTRY_HOST);
    expect(derived.port).toBe(51222);
    expect(tlsOf(derived)?.sni).toBe(ORIGIN);
    // 链式引用指向的入口节点仍在输出里，否则 emit 会丢掉整条链
    expect(chained.nodes.some((n) => n.fingerprint === derived.chain!.viaFingerprint)).toBe(true);
  });

  it('ix 开与关，链式派生指纹完全相同', () => {
    const withIx = expandChain(applyIx([entryNode, landing], entries).nodes, chainRule);
    const without = expandChain([entryNode, landing], chainRule);
    const fps = (nodes: readonly ProxyNode[]) => nodes.filter((n) => n.chain).map((n) => n.fingerprint);
    expect(fps(withIx.nodes)).toEqual(fps(without.nodes));
    expect(fps(withIx.nodes)).toHaveLength(1);
  });

  it('四种输出格式横向守卫：server 是入口，sni / Host 是原地址（emitter 一行没改）', () => {
    const node = applyIx([landing], mapOf([landing, entry()])).nodes[0]!;
    for (const target of ['clash', 'clash.meta'] as const) {
      const yaml = emit([node], target).body;
      expect(yaml).toContain(`server: ${ENTRY_HOST}`);
      expect(yaml).toContain(`sni: ${ORIGIN}`);
      expect(yaml).toContain(`Host: ${ORIGIN}`);
      expect(yaml).not.toContain(`server: ${ORIGIN}`);
    }
    for (const target of ['shadowrocket', 'v2ray'] as const) {
      const uri = emit([node], target, { base64: false }).body;
      expect(uri).toContain(`@${ENTRY_HOST}:${ENTRY_PORT}`);
      expect(uri).toContain(`sni=${ORIGIN}`);
      expect(uri).toContain(`host=${ORIGIN}`);
      expect(uri).not.toContain(`@${ORIGIN}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────
//  I 幂等
// ─────────────────────────────────────────────────────────────

describe('I 幂等：第二遍绝不能把 SNI 补成中转入口域名', () => {
  const node = trojan({ transport: { network: 'ws' } });
  const entries = mapOf([node, entry()]);

  it('第二遍全部进 skipped，且节点逐字段与第一遍相同', () => {
    const first = applyIx([node], entries);
    const second = applyIx(first.nodes, entries);
    expect(second.stats.rewritten).toBe(0);
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0]!.reason).toBe('already-rewritten');
    expect(second.nodes).toEqual(first.nodes);
  });

  it('第二遍不会把 sni / Host 改成入口域名（最坏的破坏形态）', () => {
    const twice = applyIx(applyIx([node], entries).nodes, entries);
    const out = twice.nodes[0]!;
    expect(tlsOf(out)?.sni).toBe(ORIGIN);
    expect(transportOf(out)?.ws?.headers?.['Host']).toBe(ORIGIN);
    expect(out.ix?.originServer).toBe(ORIGIN);
    expect(out.server).toBe(ENTRY_HOST);
  });

  it('幂等跳过不算故障：不进 skipped* 计数，也不算"暴露落地地址"的直连回落', () => {
    const twice = applyIx(applyIx([node], entries).nodes, entries);
    expect(twice.stats.skippedNoMapping + twice.stats.skippedUnsafe + twice.stats.skippedUdp).toBe(0);
    expect(twice.stats.unchanged).toBe(1);
    expect(twice.warnings).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
//  J 纯度
// ─────────────────────────────────────────────────────────────

describe('J 纯度：输入数组与输入节点（含嵌套对象）都不被修改', () => {
  it('调用前后深比对相等，且未改写的节点原样返回同一引用', () => {
    const nodes = [
      trojan({ transport: { network: 'ws', ws: { path: '/p', headers: {} } } }),
      ss({ plugin: { name: 'obfs-local', opts: { obfs: 'tls' } } }),
      hy2({ udp: true }),
    ];
    const before = structuredClone(nodes);
    const out = applyIx(nodes, mapOf([nodes[0]!, entry()], [nodes[2]!, entry({ udp: false })]));
    expect(nodes).toEqual(before);
    expect(nodes).toHaveLength(3);
    // ss 带插件被拒绝，原对象原样返回
    expect(out.nodes[1]).toBe(nodes[1]);
    // 被改写的必须是新对象，否则说明动了输入
    expect(out.nodes[0]).not.toBe(nodes[0]);
  });

  it('嵌套的 ws.headers 不被就地写入', () => {
    const node = trojan({ transport: { network: 'ws', ws: { headers: {} } } });
    const headers = transportOf(node)!.ws!.headers!;
    applyIx([node], mapOf([node, entry()]));
    expect(headers).toEqual({});
  });
});

describe('buildIxRelayNode', () => {
  it('生成稳定 IX 身份，入口更新不改变指纹，协议凭据与握手字段保持不变', () => {
    const origin = trojan({
      name: 'bwg-ssr',
      tls: { enabled: true },
      transport: { network: 'ws', ws: { path: '/relay' } },
    });
    const first = buildIxRelayNode(origin, { id: 'provider-a', name: 'IX A' }, entry());
    const second = buildIxRelayNode(
      origin,
      { id: 'provider-a', name: 'IX A' },
      entry({ entryHost: 'new-entry.example', entryPort: 53001 }),
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.node.name).toBe('IX_bwg-ssr');
    expect(first.node.fingerprint).toBe(second.node.fingerprint);
    expect(first.node.fingerprint).not.toBe(origin.fingerprint);
    expect(first.node.server).toBe(ENTRY_HOST);
    expect(second.node.server).toBe('new-entry.example');
    expect(first.node.type).toBe('trojan');
    if (first.node.type !== 'trojan' || origin.type !== 'trojan') return;
    expect(first.node.password).toBe(origin.password);
    expect(first.node.transport).toMatchObject({ network: 'ws', ws: { path: '/relay' } });
    expect(first.node.tls.sni).toBe(origin.server);
    expect(first.node.ix).toMatchObject({
      providerId: 'provider-a',
      originFingerprint: origin.fingerprint,
      originServer: origin.server,
    });
  });

  it('VLESS 与 SSR 派生节点保留原协议身份字段', () => {
    const vl = vless({ name: 'bwg-vless' });
    const sr = ssr({ name: 'bwg-ssr', obfsParam: 'cdn.example' });
    const vlRelay = buildIxRelayNode(vl, { id: 'provider-a', name: 'IX A' }, entry());
    const srRelay = buildIxRelayNode(sr, { id: 'provider-a', name: 'IX A' }, entry());
    expect(vlRelay.ok).toBe(true);
    expect(srRelay.ok).toBe(true);
    if (!vlRelay.ok || !srRelay.ok) return;
    expect(vlRelay.node).toMatchObject({
      type: 'vless',
      name: 'IX_bwg-vless',
      server: ENTRY_HOST,
      uuid: '22222222-2222-2222-2222-222222222222',
    });
    expect(srRelay.node).toMatchObject({
      type: 'ssr',
      name: 'IX_bwg-ssr',
      server: ENTRY_HOST,
      cipher: 'aes-256-cfb',
      password: 'pw-ssr',
      protocol: 'auth_aes128_md5',
      obfs: 'plain',
      obfsParam: 'cdn.example',
    });
  });
});
