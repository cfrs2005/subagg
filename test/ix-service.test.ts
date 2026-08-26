/**
 * IX 中转编排层测试。
 *
 * 用**鸭子类型替身**替掉 `IxClient`（仿 `test/node-ping-service.test.ts` 的
 * `as unknown as NodeRepo`），但数据库是真的 —— 内存 SQLite + 真实迁移 + 真实仓储。
 * 理由：这一层的 bug 几乎全在"状态往哪一列落、下一趟同步读回来还对不对"，
 * mock 掉仓储恰好把这些都绕过去了。
 *
 * 替身记录每一次出站调用（`calls`），于是"**认领优先于创建**"这类
 * "不该发某个请求"的断言才有得可断 —— 只看结果的话，认领和创建都会得到一条
 * 可用映射，看不出 30 个配额被白烧掉了。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, type Db } from '../src/db/index.js';
import { IxMappingRepo, IxProviderRepo, type UpsertIxMappingInput } from '../src/db/repo/ix.js';
import { NodeRepo } from '../src/db/repo/nodes.js';
import { deriveKey, encryptSecret } from '../src/core/secret.js';
import type { ProxyNode } from '../src/core/types.js';
import type { Config } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { IxService, type IxPlatformClient } from '../src/services/ix.js';
import type { IxCreatePortInput } from '../src/services/ix-client.js';
import {
  IxApiError,
  type IxLineDetail,
  type IxPort,
  type IxSubscriptionInfo,
} from '../src/services/ix-protocol.js';
import { makeNode } from './helpers.js';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };

const ADMIN_TOKEN = 'test-admin-token-0123456789';
/** scrypt 刻意很慢，整份测试只派生一次。 */
const KEY = deriveKey(ADMIN_TOKEN);
const OTHER_KEY = deriveKey('another-admin-token-987654321');

const LINE_ID = 20;
const LINE_NAME = '腾讯上海P';
const ENTRY_HOST = 'shzf.pb.test.xyz';

// ─────────────────────────────────────────────────────────────
//  替身
// ─────────────────────────────────────────────────────────────

let nextPortId = 200;
let nextEntryPort = 50001;

/** 造一个平台端口。真实响应有 57 个键，这里把客户端类型要求的都填上。 */
function makePort(target: string, over: Partial<IxPort> = {}): IxPort {
  const id = over.id ?? nextPortId++;
  return {
    id,
    display_name: `port-${id}`,
    ip_addr: ENTRY_HOST,
    port_v4: nextEntryPort++,
    outbound_endpoint_id: LINE_ID,
    line_name: LINE_NAME,
    target_address_list: [target],
    target_select_mode: 0,
    test_method: 0,
    forward_config: { mode: 'direct' },
    enable_udp: true,
    exclude_from_subscription: false,
    is_suspended: false,
    tags: [],
    traffic_in: 0,
    traffic_out: 0,
    current_latency_summary: null,
    sync_error_message: null,
    sync_error_at: null,
    synced_to_worker_at: null,
    suspend_type: null,
    suspended_at: null,
    resume_at: null,
    period_traffic: null,
    period_traffic_limit_mode: null,
    allow_ip_num: null,
    allow_conn_num: null,
    expire_at: null,
    accept_proxy_protocol: false,
    send_proxy_protocol_version: null,
    custom_config: null,
    ...over,
  };
}

class FakeClient implements IxPlatformClient {
  /** 每一次出站调用。断言"没发 create"靠它。 */
  readonly calls: string[] = [];
  ports: IxPort[] = [];
  /** 线路级配额上限（subscription.lines[].max_ports_number）。 */
  maxPorts = 30;
  /** 平台侧实时占用（line_details[].port_count）。 */
  portCount = 0;
  /** 对这些 target 的 create 抛错，用来测"单节点失败不影响其余"。 */
  failCreateFor = new Set<string>();
  /** false = create 之后回读不到（模拟端口建了但列表还没同步出来）。 */
  readbackAfterCreate = true;
  failDelete = false;

  async subscriptionInfo(): Promise<IxSubscriptionInfo> {
    this.calls.push('subscriptionInfo');
    return {
      id: 1,
      username: 'relay-user',
      valid_until: '2026-11-17',
      last_reset: null,
      next_reset: null,
      // 单位不一致是平台事实：used 是字节，total 是 GiB
      traffic_used: 4_967_037_106,
      traffic_total: 100,
      is_expired: false,
      is_admin: false,
      permissions: [],
      allow_forward_endpoint: false,
      lines: [
        {
          id: LINE_ID,
          display_name: LINE_NAME,
          ip_addr: ENTRY_HOST,
          is_online: true,
          port_start: 50_000,
          port_end: 55_000,
          allow_forward: false,
          allow_inbound_proxy: false,
          is_suspended: false,
          traffic_scale: 1,
          max_ports_number: this.maxPorts,
        },
      ],
    };
  }

  async lineDetails(): Promise<IxLineDetail[]> {
    this.calls.push('lineDetails');
    return [
      {
        line_id: LINE_ID,
        line_name: LINE_NAME,
        entry_ip: ENTRY_HOST,
        traffic_scale: 1,
        traffic_limit: null,
        used_traffic: 0,
        port_count: this.portCount,
      },
    ];
  }

  async listAllPorts(): Promise<IxPort[]> {
    this.calls.push('listAllPorts');
    return [...this.ports];
  }

  async findPortByTarget(target: string): Promise<IxPort | undefined> {
    this.calls.push(`findPortByTarget:${target}`);
    const wanted = target.toLowerCase();
    return this.ports.find((port) =>
      port.target_address_list.some((addr) => addr.toLowerCase() === wanted),
    );
  }

  async createPort(input: IxCreatePortInput): Promise<{ id: number }> {
    const target = input.targetAddressList[0] ?? '';
    this.calls.push(`createPort:${target}`);
    if (this.failCreateFor.has(target)) {
      throw new IxApiError('zf 返回 HTTP 400：测试注入的创建失败', false, 400);
    }
    const port = makePort(target);
    this.portCount += 1;
    if (this.readbackAfterCreate) this.ports.push(port);
    return { id: port.id };
  }

  async deletePort(id: number): Promise<{ ok: boolean }> {
    this.calls.push(`deletePort:${id}`);
    if (this.failDelete) throw new IxApiError('zf 返回 HTTP 500：删除失败', true, 500);
    this.ports = this.ports.filter((port) => port.id !== id);
    return { ok: true };
  }

  created(): string[] {
    return this.calls.filter((call) => call.startsWith('createPort:'));
  }
}

// ─────────────────────────────────────────────────────────────
//  夹具
// ─────────────────────────────────────────────────────────────

let db: Db;
let providers: IxProviderRepo;
let mappings: IxMappingRepo;
let nodes: NodeRepo;
let client: FakeClient;

function makeConfig(over: Partial<Config> = {}): Config {
  return { ixTimeoutMs: 15_000, ixOrphanThreshold: 5, ixSyncIntervalHours: 6, ...over } as Config;
}

function makeService(config: Config = makeConfig(), key: Buffer = KEY): IxService {
  return new IxService({
    config,
    logger,
    providers,
    mappings,
    nodes,
    secretKey: key,
    createClient: () => client,
  });
}

function ssNode(name: string, server: string, port: number): ProxyNode {
  return makeNode({ type: 'ss', name, server, port, cipher: 'aes-128-gcm', password: 'pw' });
}

/**
 * 每次播种都推进时钟。
 *
 * `replaceForSubscription` 删的是 `last_seen < now` 的行 —— 同一毫秒内连播两次，
 * 第一批节点不会被删掉，"节点从上游消失"这件事就模拟不出来（而测试会假绿）。
 */
let seedClock = 10_000;

function seed(...list: ProxyNode[]): void {
  seedClock += 1_000;
  nodes.replaceForSubscription('s1', list, seedClock);
}

function makeProvider(over: { name?: string; createdAt?: number; enabled?: boolean } = {}) {
  return providers.create(
    {
      name: over.name ?? 'zf',
      baseUrl: 'https://zf.test/api',
      username: 'relay-user',
      passwordEnc: encryptSecret('secret-password', KEY),
      ...(over.enabled === undefined ? {} : { enabled: over.enabled }),
    },
    over.createdAt ?? 1_000,
  );
}

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
  client = new FakeClient();
  nextPortId = 200;
  nextEntryPort = 50_001;
  seedClock = 10_000;
});

// ─────────────────────────────────────────────────────────────
//  resolveProvider
// ─────────────────────────────────────────────────────────────

describe('resolveProvider', () => {
  it('按 created_at 取最早的启用 provider，多于一个时给出 tie-break 警告', () => {
    const first = makeProvider({ name: '甲', createdAt: 1_000 });
    makeProvider({ name: '乙', createdAt: 2_000 });
    const service = makeService();

    const resolved = service.resolveProvider();
    expect(resolved.provider?.id).toBe(first.id);
    // 静默挑一个的话，用户会看到"有些节点走了中转、有些没走"却查不出原因
    expect(resolved.warnings.join(' ')).toContain('2 个启用中的中转商');
    expect(resolved.warnings.join(' ')).toContain('甲');
  });

  it('单个 provider 不产生噪音警告；指定 id 时精确取它；关掉总闸的也取得到', () => {
    const only = makeProvider({ name: '甲', createdAt: 1_000 });
    const off = makeProvider({ name: '乙', createdAt: 2_000, enabled: false });
    const service = makeService();

    expect(service.resolveProvider().provider?.id).toBe(only.id);
    expect(service.resolveProvider().warnings).toEqual([]);
    // 总闸是渲染路径判的（管理页要能对着一个关掉的 provider 做体检）
    expect(service.resolveProvider(off.id).provider?.id).toBe(off.id);
  });

  it('找不到时给可读原因而不是抛异常', () => {
    const service = makeService();
    expect(service.resolveProvider().reason).toContain('没有启用的中转商');

    makeProvider();
    const missing = service.resolveProvider('11111111-2222-3333-4444-555555555555');
    expect(missing.provider).toBeUndefined();
    expect(missing.reason).toContain('不存在');
    expect(missing.reason).toContain('下一步');
  });
});

// ─────────────────────────────────────────────────────────────
//  凭据
// ─────────────────────────────────────────────────────────────

describe('凭据解密失败', () => {
  it('优雅降级：不抛异常、标记 last_error、三个入口都返回可读原因', async () => {
    const provider = makeProvider();
    // 换一把密钥 = 轮换过 ADMIN_TOKEN 的库
    const service = makeService(makeConfig(), OTHER_KEY);
    seed(ssNode('A', 'a.example.com', 443));

    const resolved = service.clientFor(provider);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.credentialProblem).toBe(true);
      expect(resolved.reason).toContain('重新录入');
    }
    expect(providers.get(provider.id)?.lastError).toContain('无法解密');

    // 订阅请求绝不能因为凭据解不开而 500 —— 这三个入口都必须"返回失败"而不是抛
    await expect(service.probe(provider.id)).resolves.toMatchObject({ ok: false });
    await expect(service.ensureMappings(provider.id, ['x'])).resolves.toMatchObject({ ok: false });
    expect(client.calls).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
//  probe
// ─────────────────────────────────────────────────────────────

describe('probe', () => {
  it('统一流量单位、给出线路占用与不可用能力，并写进 quota_json', async () => {
    const provider = makeProvider();
    client.portCount = 3;
    const result = await makeService().probe(provider.id);

    expect(result.ok).toBe(true);
    expect(result.username).toBe('relay-user');
    expect(result.isAdmin).toBe(false);
    // used 是字节、total 是 GiB —— 换算前直接相减会算出荒谬的剩余量
    expect(result.trafficUsedBytes).toBe(4_967_037_106);
    expect(result.trafficTotalBytes).toBe(100 * 1024 ** 3);
    expect(result.lines).toEqual([
      {
        lineId: LINE_ID,
        name: LINE_NAME,
        entryHost: ENTRY_HOST,
        portStart: 50_000,
        portEnd: 55_000,
        maxPorts: 30,
        usedPorts: 3,
        online: true,
        suspended: false,
      },
    ]);
    // 不明说的话，用户会照着平台文档去配链式转发，试半天才发现权限不给
    const unavailable = result.unavailable.join(' | ');
    expect(unavailable).toContain('allow_forward_endpoint=false');
    expect(unavailable).toContain('is_admin=false');
    expect(unavailable).toContain('allow_forward=false');
    expect(unavailable).toContain('allow_inbound_proxy=false');

    const saved = providers.get(provider.id);
    expect(saved?.lastError).toBeNull();
    expect(saved?.lastProbeAt).not.toBeNull();
    const snapshot = JSON.parse(saved?.quotaJson ?? '{}') as Record<string, unknown>;
    // 快照里存的是已换算的字节，字段名自带单位
    expect(snapshot['trafficTotalBytes']).toBe(100 * 1024 ** 3);
    // 凭据一个都不许出现在快照里
    expect(saved?.quotaJson).not.toContain('secret-password');
  });

  it('平台报错时如实落 last_error 并返回 ok:false', async () => {
    const provider = makeProvider();
    client.subscriptionInfo = async () => {
      throw new IxApiError('zf 返回 HTTP 502：网关错误', true, 502);
    };
    const result = await makeService().probe(provider.id);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('502');
    expect(providers.get(provider.id)?.lastError).toContain('502');
  });
});

// ─────────────────────────────────────────────────────────────
//  ensureMappings
// ─────────────────────────────────────────────────────────────

describe('ensureMappings', () => {
  it('认领优先于创建：远端已有指向同一目标的端口时绝不发 create', async () => {
    const provider = makeProvider();
    const node = ssNode('A', 'landing-a.example', 2002);
    seed(node);
    client.ports = [makePort('landing-a.example:2002', { id: 230, port_v4: 51_221 })];

    const result = await makeService().ensureMappings(provider.id, [node.fingerprint]);

    expect(result.ok).toBe(true);
    expect(result.items[0]).toMatchObject({
      outcome: 'claimed',
      remotePortId: 230,
      entryHost: ENTRY_HOST,
      entryPort: 51_221,
    });
    // 30 个配额浪费不起：认领链路上多发一个 create 就是白烧一个
    expect(client.created()).toEqual([]);

    const mapping = mappings.get(provider.id, node.fingerprint);
    expect(mapping).toMatchObject({
      state: 'active',
      remotePortId: 230,
      entryPort: 51_221,
      targetHost: 'landing-a.example',
      targetPort: 2002,
      lineName: LINE_NAME,
      suspended: false,
      lastError: null,
    });
  });

  it('认领时写入平台回报的 enable_udp，而不是 provider 建端口用的默认值', async () => {
    // provider 的开关是 true（建端口时会这么请求），但平台上这个端口是关的
    const provider = makeProvider();
    expect(providers.get(provider.id)?.enableUdp).toBe(true);
    const node = ssNode('A', 'landing-a.example', 2002);
    seed(node);
    client.ports = [makePort('landing-a.example:2002', { id: 230, enable_udp: false })];

    const service = makeService();
    await service.ensureMappings(provider.id, [node.fingerprint]);

    expect(mappings.get(provider.id, node.fingerprint)?.entryUdp).toBe(false);
    expect(service.entriesFor(provider.id).get(node.fingerprint)?.udp).toBe(false);
  });

  it('回读不到端口时 entry_udp 留 NULL（未知），不拿 provider 默认值填充', async () => {
    const provider = makeProvider();
    const node = ssNode('A', 'a.example.com', 443);
    seed(node);
    client.readbackAfterCreate = false;

    await makeService().ensureMappings(provider.id, [node.fingerprint]);

    // 端口建出来了但读不回来 —— 它转不转 UDP 我们无从得知
    expect(mappings.get(provider.id, node.fingerprint)).toMatchObject({ state: 'pending' });
    expect(mappings.get(provider.id, node.fingerprint)?.entryUdp).toBeNull();
  });

  it('幂等：重复调用不重复建端口', async () => {
    const provider = makeProvider();
    const node = ssNode('A', 'a.example.com', 443);
    seed(node);
    const service = makeService();

    const first = await service.ensureMappings(provider.id, [node.fingerprint]);
    expect(first.items[0]?.outcome).toBe('created');
    expect(client.created()).toHaveLength(1);

    const second = await service.ensureMappings(provider.id, [node.fingerprint, node.fingerprint]);
    expect(second.items).toHaveLength(1); // 入参去重
    expect(second.items[0]?.outcome).toBe('skipped');
    expect(client.created()).toHaveLength(1);
  });

  it('创建后回读 port_v4：端口号由平台分配，create 的响应里没有', async () => {
    const provider = makeProvider();
    const node = ssNode('A', 'a.example.com', 443);
    seed(node);

    const result = await makeService().ensureMappings(provider.id, [node.fingerprint]);
    const created = client.ports[0];

    expect(result.items[0]).toMatchObject({
      outcome: 'created',
      entryHost: ENTRY_HOST,
      entryPort: created?.port_v4,
    });
    expect(mappings.get(provider.id, node.fingerprint)?.entryPort).toBe(created?.port_v4);
    // create 之后必须再查一次才能拿到入口
    expect(client.calls.filter((c) => c.startsWith('findPortByTarget'))).toHaveLength(2);
  });

  it('回读不到时如实上报（配额已被占用），映射记为 pending 而不是假装成功', async () => {
    const provider = makeProvider();
    const node = ssNode('A', 'a.example.com', 443);
    seed(node);
    client.readbackAfterCreate = false;

    const result = await makeService().ensureMappings(provider.id, [node.fingerprint]);

    expect(result.ok).toBe(false);
    expect(result.items[0]?.outcome).toBe('failed');
    expect(result.items[0]?.detail).toContain('配额已经被占用');
    expect(mappings.get(provider.id, node.fingerprint)).toMatchObject({ state: 'pending' });
  });

  it('配额预检按线路算，超限时不发 create', async () => {
    const provider = makeProvider();
    const node = ssNode('A', 'a.example.com', 443);
    seed(node);
    // 线路上限 1，平台已占 1 —— 配额是**线路级**的，账户顶层没有端口数字段
    client.maxPorts = 1;
    client.portCount = 1;

    const result = await makeService().ensureMappings(provider.id, [node.fingerprint]);

    expect(result.ok).toBe(false);
    expect(result.items[0]?.outcome).toBe('failed');
    expect(result.items[0]?.detail).toContain('配额已用满（1/1）');
    expect(result.items[0]?.detail).toContain('下一步');
    // 超限的服务端文案未知，所以本地预检必须挡住，不能等服务端报错
    expect(client.created()).toEqual([]);
    expect(mappings.get(provider.id, node.fingerprint)).toMatchObject({ state: 'error' });
  });

  it('批量创建时逐个扣本轮预算，不会一次把配额建超', async () => {
    const provider = makeProvider();
    const a = ssNode('A', 'a.example.com', 443);
    const b = ssNode('B', 'b.example.com', 443);
    const c = ssNode('C', 'c.example.com', 443);
    seed(a, b, c);
    client.maxPorts = 2;
    client.portCount = 0;

    const result = await makeService().ensureMappings(provider.id, [
      a.fingerprint,
      b.fingerprint,
      c.fingerprint,
    ]);

    expect(result.items.map((i) => i.outcome)).toEqual(['created', 'created', 'failed']);
    expect(client.created()).toHaveLength(2);
  });

  it('单个节点失败不影响其余节点，失败原因落到该映射的 last_error', async () => {
    const provider = makeProvider();
    const a = ssNode('A', 'a.example.com', 443);
    const b = ssNode('B', 'b.example.com', 443);
    seed(a, b);
    client.failCreateFor.add('a.example.com:443');

    const result = await makeService().ensureMappings(provider.id, [a.fingerprint, b.fingerprint]);

    expect(result.ok).toBe(false);
    expect(result.items.map((i) => i.outcome)).toEqual(['failed', 'created']);
    expect(mappings.get(provider.id, a.fingerprint)).toMatchObject({
      state: 'error',
      lastError: expect.stringContaining('400'),
    });
    expect(mappings.get(provider.id, b.fingerprint)).toMatchObject({ state: 'active' });
  });

  it('本地已经没有这个指纹时给可读原因，不去平台上乱建端口', async () => {
    const provider = makeProvider();
    const result = await makeService().ensureMappings(provider.id, ['deadbeef-not-a-node']);

    expect(result.items[0]?.outcome).toBe('failed');
    expect(result.items[0]?.detail).toContain('已经没有这个指纹');
    expect(client.created()).toEqual([]);
  });

  it('默认线路指到一条已下线的线路时，整体失败且给出下一步', async () => {
    const provider = makeProvider();
    providers.update(provider.id, { defaultLineId: 999 });
    const node = ssNode('A', 'a.example.com', 443);
    seed(node);

    const result = await makeService().ensureMappings(provider.id, [node.fingerprint]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('999');
    expect(client.created()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
//  refresh
// ─────────────────────────────────────────────────────────────

describe('refresh', () => {
  it('把入口、延迟、丢包、流量、挂起、下发错误、线路名对齐到本地映射', async () => {
    const provider = makeProvider();
    const node = ssNode('A', 'a.example.com', 443);
    seed(node);
    const service = makeService();
    await service.ensureMappings(provider.id, [node.fingerprint]);

    const port = client.ports[0]!;
    // 平台把端口挂起了，但**这条映射本身是健康的** —— 两件事，两列
    client.ports = [
      makePort('a.example.com:443', {
        id: port.id,
        port_v4: 50_555,
        is_suspended: true,
        traffic_in: 111,
        traffic_out: 222,
        sync_error_message: '下发到转发节点失败',
        current_latency_summary: {
          sample_at: '2026-08-26T00:00:00Z',
          avg_latency_us: 34_567,
          stddev_latency_us: 100,
          packet_loss_rate: 0.02,
          samples_count: 10,
        },
      }),
    ];

    const result = await service.refresh(provider.id);
    expect(result).toMatchObject({ ok: true, checked: 1, updated: 1, missingRemote: 0 });

    const mapping = mappings.get(provider.id, node.fingerprint)!;
    expect(mapping).toMatchObject({
      entryPort: 50_555,
      latencyUs: 34_567,
      lossRate: 0.02,
      trafficIn: 111,
      trafficOut: 222,
      syncError: '下发到转发节点失败',
      lineName: LINE_NAME,
      // ⚠️ 关键：挂起体现在 suspended 那一列，state 仍是 active。
      // 只看 state 就会把已停用的端口当可用拿去改写地址。
      suspended: true,
      state: 'active',
    });

    // 翻译只发生在 entriesFor：state=active + suspended=1 → 'suspended'
    expect(service.entriesFor(provider.id).get(node.fingerprint)).toMatchObject({
      status: 'suspended',
      entryPort: 50_555,
    });
  });

  it('远端端口消失 → state=error 且给可读原因，绝不删本地映射', async () => {
    const provider = makeProvider();
    const node = ssNode('A', 'a.example.com', 443);
    seed(node);
    const service = makeService();
    await service.ensureMappings(provider.id, [node.fingerprint]);

    client.ports = [];
    const result = await service.refresh(provider.id);

    expect(result).toMatchObject({ missingRemote: 1, updated: 0 });
    const mapping = mappings.get(provider.id, node.fingerprint)!;
    expect(mapping.state).toBe('error');
    expect(mapping.lastError).toContain('远端已经没有');
    expect(mapping.lastError).toContain('下一步');
    // state=error → core 拿到 'unknown'，会保守回落直连
    expect(service.entriesFor(provider.id).get(node.fingerprint)?.status).toBe('unknown');
  });

  it('端口被手工删了重建（id 变了但目标不变）时按目标认回来', async () => {
    const provider = makeProvider();
    const node = ssNode('A', 'a.example.com', 443);
    seed(node);
    const service = makeService();
    await service.ensureMappings(provider.id, [node.fingerprint]);

    client.ports = [makePort('a.example.com:443', { id: 900, port_v4: 50_900 })];
    await service.refresh(provider.id);

    expect(mappings.get(provider.id, node.fingerprint)).toMatchObject({
      remotePortId: 900,
      entryPort: 50_900,
      state: 'active',
    });
  });

  it('孤儿：missing_count 累加到阈值才标 orphan，且绝不自动删远端端口', async () => {
    const provider = makeProvider();
    const node = ssNode('A', 'a.example.com', 443);
    const keep = ssNode('B', 'b.example.com', 443);
    seed(node, keep);
    const service = makeService(makeConfig({ ixOrphanThreshold: 3 }));
    await service.ensureMappings(provider.id, [node.fingerprint]);

    // 节点从上游消失（只剩 B）
    seed(keep);

    const first = await service.refresh(provider.id);
    expect(first.orphaned).toBe(0);
    expect(mappings.get(provider.id, node.fingerprint)).toMatchObject({
      missingCount: 1,
      state: 'active',
    });

    await service.refresh(provider.id);
    const third = await service.refresh(provider.id);

    expect(third.orphaned).toBe(1);
    const orphan = mappings.get(provider.id, node.fingerprint)!;
    expect(orphan).toMatchObject({ missingCount: 3, state: 'orphan' });
    expect(orphan.lastError).toContain('没有被自动删除');
    // 用户已明确决策：只标记 + 界面高亮
    expect(client.calls.some((call) => call.startsWith('deletePort'))).toBe(false);
    expect(client.ports).toHaveLength(1);
    // 再同步一次不该把 orphaned 又数一遍
    expect((await service.refresh(provider.id)).orphaned).toBe(0);
  });

  it('节点回来了就清零 missing_count 并恢复 active', async () => {
    const provider = makeProvider();
    const node = ssNode('A', 'a.example.com', 443);
    seed(node);
    const service = makeService(makeConfig({ ixOrphanThreshold: 2 }));
    await service.ensureMappings(provider.id, [node.fingerprint]);

    seed(ssNode('B', 'b.example.com', 443));
    await service.refresh(provider.id);
    await service.refresh(provider.id);
    expect(mappings.get(provider.id, node.fingerprint)).toMatchObject({ state: 'orphan' });

    // 机场偶发返回不完整列表很常见，节点回来必须清零，否则健康节点迟早被误标
    seed(node);
    const back = await service.refresh(provider.id);
    expect(back.recovered).toBe(1);
    expect(mappings.get(provider.id, node.fingerprint)).toMatchObject({
      missingCount: 0,
      state: 'active',
    });
  });

  it('把远端 port 的 enable_udp 写进映射：端口级 UDP 能力的唯一事实来源', async () => {
    const provider = makeProvider();
    const node = ssNode('A', 'a.example.com', 443);
    seed(node);
    const service = makeService();
    await service.ensureMappings(provider.id, [node.fingerprint]);
    // 建端口时用的是 provider 的默认值（true），所以初值是 true
    expect(mappings.get(provider.id, node.fingerprint)?.entryUdp).toBe(true);

    // 用户到平台上把这个端口的 UDP 关了 —— 我们只能靠同步看见
    const port = client.ports[0]!;
    client.ports = [makePort('a.example.com:443', { id: port.id, enable_udp: false })];

    await service.refresh(provider.id);

    expect(mappings.get(provider.id, node.fingerprint)?.entryUdp).toBe(false);
    expect(service.entriesFor(provider.id).get(node.fingerprint)?.udp).toBe(false);
  });

  it('平台不回报 enable_udp 时写 NULL（未知），不猜一个值', async () => {
    const provider = makeProvider();
    const node = ssNode('A', 'a.example.com', 443);
    seed(node);
    const service = makeService();
    await service.ensureMappings(provider.id, [node.fingerprint]);

    const port = client.ports[0]!;
    // 平台某天不再回报这个字段：宁可退回"未知"，也不许沉淀成一个假事实
    const withoutUdp = makePort('a.example.com:443', { id: port.id });
    delete (withoutUdp as { enable_udp?: unknown }).enable_udp;
    client.ports = [withoutUdp];

    await service.refresh(provider.id);

    expect(mappings.get(provider.id, node.fingerprint)?.entryUdp).toBeNull();
    expect(service.entriesFor(provider.id).get(node.fingerprint)?.udp).toBeUndefined();
  });

  it('没有映射时不发任何出站请求', async () => {
    const provider = makeProvider();
    const result = await makeService().refresh(provider.id);
    expect(result).toMatchObject({ ok: true, checked: 0 });
    expect(client.calls).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
//  removeMapping
// ─────────────────────────────────────────────────────────────

describe('removeMapping', () => {
  it('deleteRemote=false：只删本地，并警告远端端口仍在占配额', async () => {
    const provider = makeProvider();
    const node = ssNode('A', 'a.example.com', 443);
    seed(node);
    const service = makeService();
    await service.ensureMappings(provider.id, [node.fingerprint]);

    const result = await service.removeMapping(provider.id, node.fingerprint, { deleteRemote: false });

    expect(result).toMatchObject({ ok: true, removedLocal: true, remoteDeleted: false });
    expect(result.warnings.join(' ')).toContain('占用线路配额');
    expect(mappings.get(provider.id, node.fingerprint)).toBeUndefined();
    expect(client.calls.some((call) => call.startsWith('deletePort'))).toBe(false);
    expect(client.ports).toHaveLength(1);
  });

  it('deleteRemote=true：先删远端再删本地', async () => {
    const provider = makeProvider();
    const node = ssNode('A', 'a.example.com', 443);
    seed(node);
    const service = makeService();
    await service.ensureMappings(provider.id, [node.fingerprint]);
    const portId = client.ports[0]!.id;

    const result = await service.removeMapping(provider.id, node.fingerprint, { deleteRemote: true });

    expect(result).toMatchObject({ ok: true, removedLocal: true, remoteDeleted: true });
    expect(client.calls).toContain(`deletePort:${portId}`);
    expect(client.ports).toEqual([]);
    expect(mappings.get(provider.id, node.fingerprint)).toBeUndefined();
  });

  it('远端删失败时如实上报，且**保留**本地映射（否则配额泄漏再也看不见）', async () => {
    const provider = makeProvider();
    const node = ssNode('A', 'a.example.com', 443);
    seed(node);
    const service = makeService();
    await service.ensureMappings(provider.id, [node.fingerprint]);
    const portId = client.ports[0]!.id;
    client.failDelete = true;

    const result = await service.removeMapping(provider.id, node.fingerprint, { deleteRemote: true });

    expect(result).toMatchObject({
      ok: false,
      removedLocal: false,
      remoteDeleted: false,
      remotePortId: portId,
    });
    const mapping = mappings.get(provider.id, node.fingerprint)!;
    expect(mapping.state).toBe('error');
    expect(mapping.lastError).toContain('本地映射已保留');
  });

  it('映射不存在时返回可读原因而不是假装删掉了', async () => {
    const provider = makeProvider();
    const result = await makeService().removeMapping(provider.id, 'nope', { deleteRemote: true });
    expect(result).toMatchObject({ ok: false, removedLocal: false, remoteDeleted: false });
    expect(result.error).toContain('不存在');
  });
});

// ─────────────────────────────────────────────────────────────
//  entriesFor
// ─────────────────────────────────────────────────────────────

describe('entriesFor', () => {
  it('state + suspended → IxPortStatus 的完整映射，且没有入口地址的不进表', () => {
    const provider = makeProvider();
    const base = { providerId: provider.id, targetHost: 'a.example.com', targetPort: 443 };
    mappings.upsert({ ...base, fingerprint: 'f-active', entryHost: ENTRY_HOST, entryPort: 50_001, state: 'active' });
    mappings.upsert({ ...base, fingerprint: 'f-susp', entryHost: ENTRY_HOST, entryPort: 50_002, state: 'active', suspended: true });
    mappings.upsert({ ...base, fingerprint: 'f-error', entryHost: ENTRY_HOST, entryPort: 50_003, state: 'error' });
    mappings.upsert({ ...base, fingerprint: 'f-orphan', entryHost: ENTRY_HOST, entryPort: 50_004, state: 'orphan' });
    mappings.upsert({ ...base, fingerprint: 'f-pending-addr', entryHost: ENTRY_HOST, entryPort: 50_005, state: 'pending' });
    // 端口还没建成：没有入口地址可言，不该编一个 :0 的假入口出来
    mappings.upsert({ ...base, fingerprint: 'f-no-entry', state: 'pending' });

    const entries = makeService().entriesFor(provider.id);

    expect(entries.get('f-active')?.status).toBe('active');
    expect(entries.get('f-susp')?.status).toBe('suspended');
    expect(entries.get('f-error')?.status).toBe('unknown');
    expect(entries.get('f-orphan')?.status).toBe('expired');
    expect(entries.get('f-pending-addr')?.status).toBe('pending');
    expect(entries.has('f-no-entry')).toBe(false);
    expect(entries.size).toBe(5);
  });

  it('provider 不存在时返回空表而不是抛异常（渲染热路径不许炸）', () => {
    expect(makeService().entriesFor('gone').size).toBe(0);
  });

  /** 一条 active 映射，`entryUdp` 由调用方决定（不传 = 库里是 NULL）。 */
  function mapWith(providerId: string, over: Partial<UpsertIxMappingInput> = {}) {
    mappings.upsert({
      providerId,
      fingerprint: 'f1',
      targetHost: 'a.example.com',
      targetPort: 443,
      entryHost: ENTRY_HOST,
      entryPort: 50_001,
      state: 'active',
      ...over,
    });
  }

  it('守卫：entry_udp 为 NULL 时给 udp: undefined（未知就说未知），绝不回落到 provider.enableUdp', () => {
    const provider = makeProvider();
    // provider 的开关是 true —— 一旦哪天又"顺手回落个默认值"，这里就会变成 true
    expect(providers.get(provider.id)?.enableUdp).toBe(true);
    mapWith(provider.id);

    expect(makeService().entriesFor(provider.id).get('f1')?.udp).toBeUndefined();

    // 反过来也守一遍：provider 关着，未知也还是未知（不是 false）。
    // 填 provider 的值会让 core 以为这是已确认的事实，把"未知"该有的
    // warning 一并吞掉，而 hysteria2 / tuic 则被无谓挡掉或被当成可改写。
    providers.update(provider.id, { enableUdp: false });
    expect(makeService().entriesFor(provider.id).get('f1')?.udp).toBeUndefined();
  });

  it('entry_udp 为 false 时给 udp: false；为 true 时给 true —— 平台事实原样透出', () => {
    const provider = makeProvider();
    mapWith(provider.id, { entryUdp: false });
    expect(makeService().entriesFor(provider.id).get('f1')?.udp).toBe(false);

    mappings.update(provider.id, 'f1', { entryUdp: true });
    expect(makeService().entriesFor(provider.id).get('f1')?.udp).toBe(true);
  });

  it('provider.enableUdp=true 但端口实际 enable_udp=false 时，取端口的 false', () => {
    const provider = makeProvider();
    expect(providers.get(provider.id)?.enableUdp).toBe(true);
    mapWith(provider.id, { entryUdp: false });

    // provider 默认值再也覆盖不了端口事实 —— 这正是本次修补要保住的性质
    expect(makeService().entriesFor(provider.id).get('f1')?.udp).toBe(false);
  });
});
