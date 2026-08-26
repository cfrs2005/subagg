/**
 * IX 中转在渲染管线里的接线。
 *
 * 端到端：真实内存 SQLite + 真实仓储 + 真实 `IxService` + 真实 `renderProfile`。
 * 唯一的替身是"造 zf 客户端"这个工厂 —— 它被换成一个**一被调用就抛**的函数，
 * 于是"渲染热路径绝不出站"这条设计前提有了真守卫：平台挂了、限流了、
 * 凭据过期了，订阅都必须照常出。
 *
 * 最后一条用例走完整 HTTP 栈（`app.inject()`），因为 `X-Subagg-IX` 与中文警告
 * 头能不能真的送出去，只有让 Node 亲自写一遍响应头才能知道
 * （HTTP 头值只能是 latin1，中文没转义会让整个响应失败）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { migrate, type Db } from '../src/db/index.js';
import {
  IxMappingRepo,
  IxProviderRepo,
  type IxProvider,
  type UpsertIxMappingInput,
} from '../src/db/repo/ix.js';
import { NodeRepo } from '../src/db/repo/nodes.js';
import { TrafficRepo } from '../src/db/repo/subscriptions.js';
import type { Profile } from '../src/db/repo/profiles.js';
import type { FilterRule } from '../src/core/filter.js';
import type { ProxyNode } from '../src/core/types.js';
import { deriveKey, encryptSecret } from '../src/core/secret.js';
import type { Config } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { IxService } from '../src/services/ix.js';
import { renderProfile, type RenderDeps } from '../src/services/render.js';
import { createContext, type AppContext } from '../src/context.js';
import { buildApp } from '../src/server/app.js';
import { makeNode } from './helpers.js';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };

const ADMIN_TOKEN = 'test-admin-token-0123456789';
const KEY = deriveKey(ADMIN_TOKEN);
const ENTRY_HOST = 'shzf.pb.test.xyz';
const ENTRY_PORT = 51_221;
const ORIGIN_HOST = 'landing-a.example';

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    adminToken: ADMIN_TOKEN,
    ipHashSalt: 'test-salt',
    host: '127.0.0.1',
    port: 0,
    trustProxy: false,
    publicBaseUrl: 'http://127.0.0.1:8787',
    dbPath: ':memory:',
    fetchTimeoutMs: 15_000,
    fetchMaxBytes: 8_388_608,
    fetchRetries: 0,
    fetchUserAgent: 'test',
    schedulerIntervalMin: 0,
    nodePingIntervalHours: 12,
    ixSyncIntervalHours: 0,
    ixTimeoutMs: 15_000,
    ixOrphanThreshold: 5,
    subRateLimit: 1000,
    subTokenRateLimit: 1000,
    shareSourceAlert: 0,
    accessLogRetentionDays: 0,
    logLevel: 'info',
    ...over,
  } as Config;
}

/** 带 ws 传输的 trojan：SNI 与 ws-Host 两处补写都能在同一个节点上看到。 */
function trojanNode(): ProxyNode {
  return makeNode({
    type: 'trojan',
    name: '香港 01',
    server: ORIGIN_HOST,
    port: 2002,
    password: 'pw',
    tls: { enabled: true },
    transport: { network: 'ws', ws: { path: '/ray' } },
  });
}

function ssNode(name: string, server: string, port: number): ProxyNode {
  return makeNode({ type: 'ss', name, server, port, cipher: 'aes-128-gcm', password: 'pw' });
}

/** hysteria2：协议**本体**跑在 UDP 上，入口不转 UDP 时它是彻底死的。 */
function hysteria2Node(): ProxyNode {
  return makeNode({
    type: 'hysteria2',
    name: '香港 HY2',
    server: ORIGIN_HOST,
    port: 8443,
    password: 'pw-hy2',
    tls: { enabled: true },
  });
}

function profileWith(rule: FilterRule): Profile {
  return {
    id: 'p',
    name: '配置',
    description: '',
    icon: '📦',
    rule,
    defaultTarget: 'clash.meta',
    // 关掉流量头：这份测试只关心节点与 IX 统计
    userinfoMode: 'off',
    updateInterval: 12,
    createdAt: 1,
    updatedAt: 1,
  };
}

// ─────────────────────────────────────────────────────────────
//  夹具
// ─────────────────────────────────────────────────────────────

let db: Db;
let providers: IxProviderRepo;
let mappings: IxMappingRepo;
let nodes: NodeRepo;
let deps: RenderDeps;
let provider: IxProvider;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, logger);
  db.prepare(
    "INSERT INTO subscriptions (id, name, url, created_at) VALUES ('s1', '测试源', 'https://sub.test/x', 1)",
  ).run();

  providers = new IxProviderRepo(db);
  mappings = new IxMappingRepo(db);
  nodes = new NodeRepo(db);
  provider = providers.create({
    name: 'zf',
    baseUrl: 'https://zf.test/api',
    username: 'relay-user',
    passwordEnc: encryptSecret('secret-password', KEY),
  });

  const ix = new IxService({
    config: makeConfig(),
    logger,
    providers,
    mappings,
    nodes,
    secretKey: KEY,
    // 渲染路径一旦出站，这个测试就该红
    createClient: () => {
      throw new Error('渲染热路径不得构造中转平台客户端');
    },
  });
  deps = { nodes, traffic: new TrafficRepo(db), ix };
});

afterEach(() => {
  db.close();
});

function mapNode(node: ProxyNode, over: Partial<UpsertIxMappingInput> = {}) {
  return mappings.upsert({
    providerId: provider.id,
    fingerprint: node.fingerprint,
    targetHost: node.server,
    targetPort: node.port,
    entryHost: ENTRY_HOST,
    entryPort: ENTRY_PORT,
    lineName: '腾讯上海P',
    state: 'active',
    ...over,
  });
}

const IX_ON: FilterRule = { ix: { enabled: true } };

// ─────────────────────────────────────────────────────────────
//  用例
// ─────────────────────────────────────────────────────────────

describe('renderProfile + IX', () => {
  it('映射可用时改写拨号地址，并把原 server 固化进 SNI 与 ws-Host', () => {
    const node = trojanNode();
    nodes.replaceForSubscription('s1', [node]);
    mapNode(node);

    const result = renderProfile(deps, profileWith(IX_ON));

    expect(result.ix).toMatchObject({ rewritten: 1, filledSni: 1, filledHost: 1, unchanged: 0 });
    const rendered = result.nodes[0]!;
    expect(rendered.server).toBe(ENTRY_HOST);
    expect(rendered.port).toBe(ENTRY_PORT);
    // 指纹是全系统主键，改写**保留**它 —— 勾选、ping 历史、映射都挂在它上面
    expect(rendered.fingerprint).toBe(node.fingerprint);
    expect(rendered.ix).toEqual({
      entryHost: ENTRY_HOST,
      entryPort: ENTRY_PORT,
      originServer: ORIGIN_HOST,
      originPort: 2002,
    });
    // 改了 server 就等于偷偷改了这两个隐式回落值，所以必须显式固化
    expect(rendered.type === 'trojan' && rendered.tls.sni).toBe(ORIGIN_HOST);
    expect(rendered.type === 'trojan' && rendered.transport.ws?.headers?.['Host']).toBe(ORIGIN_HOST);
    // 输出里两个地址各就各位
    expect(result.body).toContain(ENTRY_HOST);
    expect(result.body).toContain(ORIGIN_HOST);
  });

  it('state=active 但 suspended=1 的映射**不被采用**（只看 state 会把停用端口当可用）', () => {
    const node = trojanNode();
    nodes.replaceForSubscription('s1', [node]);
    mapNode(node, { suspended: true });

    const result = renderProfile(deps, profileWith(IX_ON));

    expect(result.ix).toMatchObject({ rewritten: 0, unchanged: 1, skippedEntryUnusable: 1 });
    // 症状本来会是"整批节点连不上且无从归因"，所以这条断言是那条约束的守卫
    expect(result.nodes[0]?.server).toBe(ORIGIN_HOST);
    expect(result.nodes[0]?.ix).toBeUndefined();
    expect(result.ixSkipped?.[0]).toMatchObject({ reason: 'entry-unusable', outcome: 'direct' });
    expect(result.ixSkipped?.[0]?.detail).toContain('已挂起');
    expect(result.warnings.join(' | ')).toContain('入口不可用');
  });

  it('端口 enable_udp=false 时 hysteria2 拒绝改写、保持直连并进 skipped（整条链路的价值证明）', () => {
    const node = hysteria2Node();
    nodes.replaceForSubscription('s1', [node]);
    // 平台回报这个端口不转 UDP —— 这个事实是 refresh 从 port.enable_udp 同步来的
    mapNode(node, { entryUdp: false });

    const result = renderProfile(deps, profileWith(IX_ON));

    expect(result.ix).toMatchObject({ rewritten: 0, unchanged: 1, skippedUdp: 1 });
    // 改写它就是输出一个 TCP 通、UDP 黑洞的死节点，症状是"半坏"、最难归因
    expect(result.nodes[0]?.server).toBe(ORIGIN_HOST);
    expect(result.nodes[0]?.ix).toBeUndefined();
    expect(result.ixSkipped?.[0]).toMatchObject({
      reason: 'udp-not-forwarded',
      outcome: 'direct',
    });
    expect(result.ixSkipped?.[0]?.detail).toContain('不转发 UDP');
    expect(result.warnings.join(' | ')).toContain('不转发 UDP');
  });

  it('端口 UDP 能力未知（entry_udp = NULL）时照改 hysteria2，但必须留下"未知"警告', () => {
    const node = hysteria2Node();
    nodes.replaceForSubscription('s1', [node]);
    // 没同步过这一列 —— provider 的 enableUdp 是 true，但那不是事实，
    // 所以这里必须走"未知"分支：改写 + 警告，而不是静默当成已确认可用
    mapNode(node);
    expect(providers.get(provider.id)?.enableUdp).toBe(true);
    expect(mappings.get(provider.id, node.fingerprint)?.entryUdp).toBeNull();

    const result = renderProfile(deps, profileWith(IX_ON));

    expect(result.ix).toMatchObject({ rewritten: 1, skippedUdp: 0 });
    expect(result.nodes[0]?.server).toBe(ENTRY_HOST);
    // 这条 warning 是"我们还不知道"的唯一出口。回落 provider 默认值会把它吞掉
    expect(result.warnings.join(' | ')).toContain('UDP 转发能力未知');
  });

  it('端口 enable_udp=false 时把 TCP 系节点的 udp 如实降级为 false', () => {
    const node = makeNode({
      type: 'ss',
      name: '香港 SS',
      server: ORIGIN_HOST,
      port: 8388,
      cipher: 'aes-128-gcm',
      password: 'pw',
      udp: true,
    });
    nodes.replaceForSubscription('s1', [node]);
    mapNode(node, { entryUdp: false });

    const result = renderProfile(deps, profileWith(IX_ON));

    expect(result.ix).toMatchObject({ rewritten: 1, udpDowngraded: 1 });
    // 客户端看到 udp: false 会走直连或直接拒绝，而不是把 UDP 流量丢进黑洞
    expect(result.nodes[0]?.udp).toBe(false);
    expect(result.warnings.join(' | ')).toContain('已如实降级为 false');
  });

  it('per-profile 开关关闭时，输出与直连**逐字节一致**，且不带 ix 统计', () => {
    const node = trojanNode();
    nodes.replaceForSubscription('s1', [node]);
    mapNode(node);

    const off = renderProfile(deps, profileWith({}));
    const explicitlyOff = renderProfile(deps, profileWith({ ix: { enabled: false } }));
    const on = renderProfile(deps, profileWith(IX_ON));

    expect(explicitlyOff.body).toBe(off.body);
    expect(explicitlyOff.ix).toBeUndefined();
    expect(explicitlyOff.ixSkipped).toBeUndefined();
    expect(explicitlyOff.warnings).toEqual(off.warnings);
    // 开着的那份必须真的不一样，否则上面的"一致"是假绿
    expect(on.body).not.toBe(off.body);
  });

  it('全局总闸关闭时所有 profile 一起回直连，并留下可归因的警告', () => {
    const node = trojanNode();
    nodes.replaceForSubscription('s1', [node]);
    mapNode(node);
    const direct = renderProfile(deps, profileWith({}));

    providers.update(provider.id, { enabled: false });

    // 规则点名了这个 provider：拿得到它，但总闸关着 → 不改写
    const named = renderProfile(deps, profileWith({ ix: { enabled: true, providerId: provider.id } }));
    expect(named.body).toBe(direct.body);
    expect(named.ix).toBeUndefined();
    // 拨了开关却还是直连，头里必须有线索
    expect(named.warnings.join(' | ')).toContain('全局总闸已关闭');

    // 规则没点名：listEnabled() 空了，同样回直连（这才是"所有 profile 一起回落"）
    const implicit = renderProfile(deps, profileWith(IX_ON));
    expect(implicit.body).toBe(direct.body);
    expect(implicit.ix).toBeUndefined();
    expect(implicit.warnings.join(' | ')).toContain('没有启用的中转商');
  });

  it('没有映射的节点保持直连，并警告会暴露真实落地地址', () => {
    const mapped = trojanNode();
    const bare = ssNode('日本 02', 'jp.example.com', 8443);
    nodes.replaceForSubscription('s1', [mapped, bare]);
    mapNode(mapped);

    const result = renderProfile(deps, profileWith(IX_ON));

    expect(result.ix).toMatchObject({ rewritten: 1, unchanged: 1, skippedNoMapping: 1 });
    expect(result.ixSkipped).toHaveLength(1);
    expect(result.ixSkipped?.[0]).toMatchObject({ reason: 'no-mapping', outcome: 'direct' });
    const warnings = result.warnings.join(' | ');
    expect(warnings).toContain('1 个节点没有中转映射');
    expect(warnings).toContain('暴露真实落地地址');
    // provider 名进 tag，多 provider 时才能归因
    expect(warnings).toContain('IX 中转（zf）');
  });

  it('规则层面的交互隐患一并上报（rename 的 {server} / chain 的 field:server / keepLandingDirect）', () => {
    const node = trojanNode();
    const relay = ssNode('中转 A', 'relay.example.com', 8388);
    nodes.replaceForSubscription('s1', [node, relay]);
    mapNode(node);

    const result = renderProfile(
      deps,
      profileWith({
        ix: { enabled: true },
        rename: [{ pattern: '香港', replace: '{server}:{port}' }],
        chain: {
          enabled: true,
          entry: { pick: [relay.fingerprint] },
          landing: { include: [{ field: 'server', op: 'contains', value: ORIGIN_HOST }] },
          keepLandingDirect: true,
        },
      }),
    );

    const warnings = result.warnings.join(' | ');
    expect(warnings).toContain('{server} / {port} 展开的是原始落地地址');
    expect(warnings).toContain('field:"server"');
    expect(warnings).toContain('keepLandingDirect');
  });

  it('规则指定的 provider 不存在时回直连并说清原因', () => {
    const node = trojanNode();
    nodes.replaceForSubscription('s1', [node]);
    mapNode(node);

    const result = renderProfile(deps, profileWith({ ix: { enabled: true, providerId: 'gone' } }));

    expect(result.ix).toBeUndefined();
    expect(result.nodes[0]?.server).toBe(ORIGIN_HOST);
    expect(result.warnings.join(' | ')).toContain('不存在');
  });

  it('没装 IX 编排模块时也不炸，只警告', () => {
    const node = trojanNode();
    nodes.replaceForSubscription('s1', [node]);
    const bare: RenderDeps = { nodes, traffic: new TrafficRepo(db) };

    const result = renderProfile(bare, profileWith(IX_ON));
    expect(result.ix).toBeUndefined();
    expect(result.warnings.join(' | ')).toContain('没有装配 IX 编排模块');
  });

  it('fillOriginHost=false 时地址照改、但不补 SNI（逃生阀）', () => {
    const node = trojanNode();
    nodes.replaceForSubscription('s1', [node]);
    mapNode(node);

    const result = renderProfile(deps, profileWith({ ix: { enabled: true, fillOriginHost: false } }));

    expect(result.ix).toMatchObject({ rewritten: 1, filledSni: 0, filledHost: 0 });
    const rendered = result.nodes[0]!;
    expect(rendered.server).toBe(ENTRY_HOST);
    expect(rendered.type === 'trojan' && rendered.tls.sni).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
//  全栈：响应头
// ─────────────────────────────────────────────────────────────

describe('/sub 的 X-Subagg-IX 响应头', () => {
  let open: { app: FastifyInstance; ctx: AppContext } | null = null;

  afterEach(async () => {
    if (open) {
      await open.app.close();
      open.ctx.db.close();
      open = null;
    }
  });

  it('给出改写/回落/丢弃三个数字，且所有响应头都是合法 latin1', async () => {
    const ctx = createContext(makeConfig(), logger);
    ctx.db
      .prepare(
        "INSERT INTO subscriptions (id, name, url, created_at) VALUES ('s1', '测试源', 'https://sub.test/x', 1)",
      )
      .run();

    const mapped = trojanNode();
    const bare = ssNode('日本 02', 'jp.example.com', 8443);
    ctx.nodes.replaceForSubscription('s1', [mapped, bare]);

    const p = ctx.ixProviders.create({
      name: 'zf',
      baseUrl: 'https://zf.test/api',
      username: 'relay-user',
      passwordEnc: encryptSecret('secret-password', deriveKey(ADMIN_TOKEN)),
    });
    ctx.ixMappings.upsert({
      providerId: p.id,
      fingerprint: mapped.fingerprint,
      targetHost: mapped.server,
      targetPort: mapped.port,
      entryHost: ENTRY_HOST,
      entryPort: ENTRY_PORT,
      state: 'active',
    });

    const profile = ctx.profiles.create({ name: '配置', rule: { ix: { enabled: true } } });
    const token = ctx.tokens.create({ profileId: profile.id });

    const app = await buildApp(ctx);
    open = { app, ctx };

    // base64=0：拿明文 URI 列表，便于直接断言改写后的地址
    const res = await app.inject({ method: 'GET', url: `/sub/${token.token}?base64=0` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-subagg-ix']).toBe('rewritten=1; direct=1; dropped=0');
    expect(res.headers['x-subagg-ix-reason']).toBe('no-mapping');
    // 中文警告必须过 toHeaderValue()：不转义会让 Node 抛错、整个响应失败，
    // 一条诊断信息把主功能搞挂
    const warning = String(res.headers['x-subagg-warning']);
    expect(warning).toContain('IX');
    for (const [name, value] of Object.entries(res.headers)) {
      if (typeof value !== 'string') continue;
      // eslint-disable-next-line no-control-regex
      expect(value, `响应头 ${name} 含非 latin1 字符`).toMatch(/^[\x09\x20-\x7e]*$/);
    }
    // 改写真的落进了下发内容
    expect(res.body).toContain(ENTRY_HOST);
  });
});
