/**
 * IX 中转的管理 API（`/api/ix/*`）。
 *
 * 全栈 `app.inject()`：真实内存 SQLite、真实仓储、真实鉴权与错误处理链。
 * 只有**会出站的那四个动作**（probe / ensureMappings / refresh / removeMapping
 * 带删远端）在需要时被换成替身 —— 测试绝不真打 zf 平台。
 *
 * 这份测试守三件事，按重要性排：
 *
 * 1. **凭据不外泄。** 明文与密文都不许出现在任何响应里。手段是"键集合精确
 *    相等"而不是"没找到那串明文"：后者只能证明这一次没漏，前者能拦住
 *    未来某次顺手写的 `...provider` spread。
 * 2. **契约逐字一致。** 前端与后端是并行开发的，字段名对不上的表现是界面
 *    上一片 `undefined`，而两边的测试各自都绿。所以这里把字段名写死。
 * 3. **日志字段名不含敏感子串。** `redact` 的敏感键判定是大小写不敏感的
 *    **子串**匹配，`authMode` 命中 'auth'、`hasCredentials` 命中 'credential'
 *    —— 打成 '***' 之后日志白记；`path` 更阴：它会被 `redactPath()` 处理，
 *    长度 ≥ 12 的路径段当 token 打码，`'/subscription'` 落盘成 `/sub***ion`。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../src/config.js';
import { createContext, type AppContext } from '../src/context.js';
import { deriveKey, encryptSecret } from '../src/core/secret.js';
import type { Logger } from '../src/logger.js';
import { buildApp } from '../src/server/app.js';
import type { IxEnsureResult, IxProbeResult, IxRemoveResult } from '../src/services/ix.js';
import { makeNode } from './helpers.js';

// ─────────────────────────────────────────────────────────────
//  夹具
// ─────────────────────────────────────────────────────────────

const ADMIN_TOKEN = 'test-admin-token-0123456789';
const AUTH = { authorization: `Bearer ${ADMIN_TOKEN}` };

/** 真的会被写进库的明文。测试要证明它既不落明文、也不出响应。 */
const API_KEY = 'super-secret-zf-api-key-9f3a';
const PASSWORD = 'relay-user-plaintext-password';

interface LogRecord {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

let logs: LogRecord[] = [];

const logger: Logger = {
  debug(msg, fields) {
    logs.push({ level: 'debug', msg, fields: fields ?? {} });
  },
  info(msg, fields) {
    logs.push({ level: 'info', msg, fields: fields ?? {} });
  },
  warn(msg, fields) {
    logs.push({ level: 'warn', msg, fields: fields ?? {} });
  },
  error(msg, fields) {
    logs.push({ level: 'error', msg, fields: fields ?? {} });
  },
  child: () => logger,
};

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
    ixSyncIntervalHours: 6,
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

let open: { app: FastifyInstance; ctx: AppContext } | null = null;

async function setup(over: Partial<Config> = {}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const ctx = createContext(makeConfig(over), logger);
  ctx.db
    .prepare(
      "INSERT INTO subscriptions (id, name, url, created_at) VALUES ('s1', '测试源', 'https://sub.test/x', 1)",
    )
    .run();
  const app = await buildApp(ctx);
  open = { app, ctx };
  return { app, ctx };
}

beforeEach(() => {
  logs = [];
});

afterEach(async () => {
  if (open) {
    await open.app.close();
    open.ctx.db.close();
    open = null;
  }
});

/** inject 的响应体。局部接口把契约写死，字段名对不上就编译不过。 */
function body<T>(res: { json: () => unknown }): T {
  return res.json() as T;
}

interface ProviderView {
  id: string;
  name: string;
  baseUrl: string;
  authMode: 'api-key' | 'login';
  enabled: boolean;
  enableUdp: boolean;
  defaultLineId: number | null;
  username: string | null;
  hasCredentials: boolean;
  credentialBroken: boolean;
  lastProbeAt: number | null;
  lastError: string | null;
  quota: unknown;
  mappingCount: number;
  createdAt: number;
  updatedAt: number;
}

/** `GET /api/ix/providers` 每个元素**恰好**这些键。多一个都算泄漏面。 */
const PROVIDER_KEYS = [
  'id',
  'name',
  'baseUrl',
  'authMode',
  'enabled',
  'enableUdp',
  'defaultLineId',
  'username',
  'hasCredentials',
  'credentialBroken',
  'lastProbeAt',
  'lastError',
  'quota',
  'mappingCount',
  'createdAt',
  'updatedAt',
].sort();

/** `GET /api/ix/mappings` 每个元素恰好这些键（= IxMapping 全字段 + nodeName）。 */
const MAPPING_KEYS = [
  'providerId',
  'fingerprint',
  'nodeName',
  'remotePortId',
  'entryHost',
  'entryPort',
  // 端口级 UDP 能力（三态，NULL = 未知）。列在契约里是刻意的：
  // 界面要能显示"这个端口转不转 UDP / 还不知道"，否则用户看到
  // hysteria2 节点没走中转时无从归因。
  'entryUdp',
  'targetHost',
  'targetPort',
  'lineId',
  'lineName',
  'state',
  'suspended',
  'latencyUs',
  'lossRate',
  'trafficIn',
  'trafficOut',
  'syncError',
  'lastError',
  'missingCount',
  'remoteSyncedAt',
  'createdAt',
  'updatedAt',
].sort();

async function createProvider(
  app: FastifyInstance,
  payload: Record<string, unknown> = {},
): Promise<ProviderView> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/ix/providers',
    headers: AUTH,
    payload: {
      name: 'zf 中转',
      baseUrl: 'https://zf.test/api',
      authMode: 'login',
      username: 'relay-user',
      password: PASSWORD,
      ...payload,
    },
  });
  expect(res.statusCode).toBe(201);
  return body<{ provider: ProviderView }>(res).provider;
}

function ssNode(name: string, server: string, port: number) {
  return makeNode({ type: 'ss', name, server, port, cipher: 'aes-128-gcm', password: 'pw' });
}

// ─────────────────────────────────────────────────────────────
//  鉴权
// ─────────────────────────────────────────────────────────────

const ROUTES: ReadonlyArray<{ method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string }> = [
  { method: 'GET', url: '/api/ix/providers' },
  { method: 'POST', url: '/api/ix/providers' },
  { method: 'PATCH', url: '/api/ix/providers/some-id' },
  { method: 'DELETE', url: '/api/ix/providers/some-id' },
  { method: 'POST', url: '/api/ix/providers/some-id/probe' },
  { method: 'GET', url: '/api/ix/mappings' },
  { method: 'POST', url: '/api/ix/mappings' },
  { method: 'DELETE', url: '/api/ix/mappings/abc123' },
  { method: 'POST', url: '/api/ix/refresh' },
];

describe('/api/ix 鉴权', () => {
  it('九个路由无 Bearer 一律 401，且不泄漏任何细节', async () => {
    const { app } = await setup();
    for (const route of ROUTES) {
      const res = await app.inject({ method: route.method, url: route.url, payload: {} });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(body<{ error: string }>(res).error).toBe('未授权');
    }
  });

  it('错误的 Bearer 与正确的 Bearer 区分开来', async () => {
    const { app } = await setup();
    const bad = await app.inject({
      method: 'GET',
      url: '/api/ix/providers',
      headers: { authorization: 'Bearer wrong-token-0123456789' },
    });
    expect(bad.statusCode).toBe(401);

    const good = await app.inject({ method: 'GET', url: '/api/ix/providers', headers: AUTH });
    expect(good.statusCode).toBe(200);
    expect(body<{ providers: ProviderView[] }>(good).providers).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
//  provider CRUD 与凭据
// ─────────────────────────────────────────────────────────────

describe('/api/ix/providers CRUD', () => {
  it('创建 → 列表 → 修改 → 删除 一条往返', async () => {
    const { app } = await setup();

    const created = await createProvider(app, { defaultLineId: 20, enableUdp: false });
    expect(created).toMatchObject({
      name: 'zf 中转',
      baseUrl: 'https://zf.test/api',
      authMode: 'login',
      username: 'relay-user',
      enabled: true,
      enableUdp: false,
      defaultLineId: 20,
      hasCredentials: true,
      credentialBroken: false,
      quota: null,
      mappingCount: 0,
      lastProbeAt: null,
      lastError: null,
    });

    const listed = body<{ providers: ProviderView[] }>(
      await app.inject({ method: 'GET', url: '/api/ix/providers', headers: AUTH }),
    ).providers;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(created.id);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/ix/providers/${created.id}`,
      headers: AUTH,
      payload: { name: '改名了', enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(body<{ provider: ProviderView }>(patched).provider).toMatchObject({
      name: '改名了',
      enabled: false,
      // 只拨总闸不该动凭据
      hasCredentials: true,
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/ix/providers/${created.id}`,
      headers: AUTH,
    });
    expect(deleted.statusCode).toBe(200);
    expect(body<{ deleted: boolean }>(deleted).deleted).toBe(true);

    expect(
      body<{ providers: ProviderView[] }>(
        await app.inject({ method: 'GET', url: '/api/ix/providers', headers: AUTH }),
      ).providers,
    ).toEqual([]);
  });

  it('响应体里没有凭据：明文没有、密文没有、键名也没有', async () => {
    const { app, ctx } = await setup();
    const created = await createProvider(app, { authMode: 'api-key', apiKey: API_KEY });

    const res = await app.inject({ method: 'GET', url: '/api/ix/providers', headers: AUTH });
    const payload = res.payload;

    // 先证明我们确实在看一份 provider 响应，免得下面几条断言空过
    expect(payload).toContain('hasCredentials');
    expect(payload).toContain('zf 中转');
    // 明文
    expect(payload).not.toContain(API_KEY);
    expect(payload).not.toContain(PASSWORD);
    // 密文（`v1:` 是 core/secret.ts 的版本前缀）。密文出门与"解得开吗"无关：
    // 它是凭据的可离线爆破形态。
    expect(payload).not.toContain('v1:');
    // 键名
    expect(payload).not.toMatch(/apiKeyEnc|passwordEnc|jwtEnc|api_key_enc|password_enc|jwt_enc/);

    // 键集合**精确**相等 —— 这一条才是真正的守卫：将来谁顺手写了
    // `...provider` spread，密文键会立刻让它红。
    const provider = body<{ providers: ProviderView[] }>(res).providers[0]!;
    expect(Object.keys(provider).sort()).toEqual(PROVIDER_KEYS);

    // 库里存的必须是密文，不是明文
    const row = ctx.db
      .prepare('SELECT api_key_enc FROM ix_providers WHERE id = ?')
      .get(created.id) as { api_key_enc: string };
    expect(row.api_key_enc.startsWith('v1:')).toBe(true);
    expect(row.api_key_enc).not.toContain(API_KEY);
  });

  it('hasCredentials 只看该模式对应的那一列', async () => {
    const { app, ctx } = await setup();

    // 没录任何凭据
    const bare = await createProvider(app, { username: null, password: null });
    expect(bare).toMatchObject({ hasCredentials: false, credentialBroken: false });

    // api-key 模式却只有 password：Key 那列是空的，就得说 false ——
    // 否则界面会显示"已配置"，用户到 probe 时才发现平台压根没收到 Key
    ctx.ixProviders.update(bare.id, {
      authMode: 'api-key',
      passwordEnc: encryptSecret(PASSWORD, deriveKey(ADMIN_TOKEN)),
    });
    const listed = body<{ providers: ProviderView[] }>(
      await app.inject({ method: 'GET', url: '/api/ix/providers', headers: AUTH }),
    ).providers[0]!;
    expect(listed).toMatchObject({ authMode: 'api-key', hasCredentials: false });
  });

  it('credentialBroken：存了但解不开（轮换过 ADMIN_TOKEN 的库就是这样）', async () => {
    const { app, ctx } = await setup();
    const created = await createProvider(app);
    expect(created.credentialBroken).toBe(false);

    // 模拟"密钥换了"：密文还在，但这把密钥解不开
    ctx.ixProviders.update(created.id, { passwordEnc: 'v1:bm90LWEtcmVhbC1jaXBoZXJ0ZXh0' });
    const after = body<{ providers: ProviderView[] }>(
      await app.inject({ method: 'GET', url: '/api/ix/providers', headers: AUTH }),
    ).providers[0]!;
    expect(after).toMatchObject({ hasCredentials: true, credentialBroken: true });

    // GET 是只读的：不该因为解密失败而写库（否则列表接口每刷新一次就写一行）
    expect(ctx.ixProviders.get(created.id)?.lastError).toBeNull();
  });

  it('PATCH 换身份会丢掉缓存的 JWT —— 旧账号的会话不能拿来建新端口', async () => {
    const { app, ctx } = await setup();
    const created = await createProvider(app);
    ctx.ixProviders.update(created.id, {
      jwtEnc: encryptSecret('fake.jwt.value', deriveKey(ADMIN_TOKEN)),
      jwtExpiresAt: 999,
    });
    expect(ctx.ixProviders.get(created.id)?.jwtEnc).not.toBeNull();

    // 只改名：JWT 必须留着（否则每次改个显示名都要重登一次）
    await app.inject({
      method: 'PATCH',
      url: `/api/ix/providers/${created.id}`,
      headers: AUTH,
      payload: { name: '只改名' },
    });
    expect(ctx.ixProviders.get(created.id)?.jwtEnc).not.toBeNull();

    // 改账号：JWT 必须清掉
    await app.inject({
      method: 'PATCH',
      url: `/api/ix/providers/${created.id}`,
      headers: AUTH,
      payload: { username: 'another-account' },
    });
    expect(ctx.ixProviders.get(created.id)?.jwtEnc).toBeNull();
    expect(ctx.ixProviders.get(created.id)?.jwtExpiresAt).toBeNull();
  });

  it('PATCH 的 null 是"清空凭据"，undefined 是"不动那一列"', async () => {
    const { app, ctx } = await setup();
    const created = await createProvider(app);

    await app.inject({
      method: 'PATCH',
      url: `/api/ix/providers/${created.id}`,
      headers: AUTH,
      payload: { password: null },
    });
    expect(ctx.ixProviders.get(created.id)?.passwordEnc).toBeNull();

    const res = await app.inject({ method: 'GET', url: '/api/ix/providers', headers: AUTH });
    expect(body<{ providers: ProviderView[] }>(res).providers[0]!.hasCredentials).toBe(false);
  });

  it('不存在的 provider：PATCH/DELETE/probe 都是 404', async () => {
    const { app } = await setup();
    for (const route of [
      { method: 'PATCH' as const, url: '/api/ix/providers/nope', payload: { name: 'x' } },
      { method: 'DELETE' as const, url: '/api/ix/providers/nope', payload: undefined },
      { method: 'POST' as const, url: '/api/ix/providers/nope/probe', payload: {} },
    ]) {
      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: AUTH,
        payload: route.payload,
      });
      expect(res.statusCode, route.url).toBe(404);
      expect(body<{ error: string }>(res).error).toContain('中转商');
    }
  });

  it('删掉 provider 时如实告知：远端端口不会被自动删，仍占配额', async () => {
    const { app, ctx } = await setup();
    const created = await createProvider(app);
    ctx.ixMappings.upsert({
      providerId: created.id,
      fingerprint: 'a'.repeat(40),
      targetHost: 'bwg.example.com',
      targetPort: 2002,
      remotePortId: 230,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/ix/providers/${created.id}`,
      headers: AUTH,
    });
    const payload = body<{ deleted: boolean; warning?: string }>(res);
    expect(payload.deleted).toBe(true);
    expect(payload.warning).toContain('配额');
    // 本地映射被 ON DELETE CASCADE 带走
    expect(ctx.ixMappings.list()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
//  校验
// ─────────────────────────────────────────────────────────────

describe('/api/ix 参数校验', () => {
  it('provider 表单的四类坏输入都是 400 且带 issues', async () => {
    const { app } = await setup();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['缺 name', { baseUrl: 'https://zf.test/api', authMode: 'login' }],
      ['baseUrl 不是 URL', { name: 'x', baseUrl: 'zf.test', authMode: 'login' }],
      ['authMode 不认识', { name: 'x', baseUrl: 'https://zf.test/api', authMode: 'oauth' }],
      // 空串刻意不当成"清空"：让手滑提交的空输入框落到校验失败上
      ['password 空串', { name: 'x', baseUrl: 'https://zf.test/api', authMode: 'login', password: '' }],
    ];
    for (const [label, payload] of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/ix/providers', headers: AUTH, payload });
      expect(res.statusCode, label).toBe(400);
      const parsed = body<{ error: string; details: string[] }>(res);
      expect(parsed.error).toBe('请求参数校验失败');
      expect(parsed.details.length, label).toBeGreaterThan(0);
    }
  });

  it(`fingerprints 超过 ${50} 个 → 400；正好 50 个放行`, async () => {
    const { app, ctx } = await setup();
    const fingerprints = Array.from({ length: 51 }, (_, i) => `fp-${i}`);

    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/ix/mappings',
      headers: AUTH,
      payload: { fingerprints },
    });
    expect(tooMany.statusCode).toBe(400);
    expect(body<{ details: string[] }>(tooMany).details.join()).toMatch(/fingerprints/);

    // 上限内：换掉会出站的 ensureMappings，只验证路由把参数原样交下去
    let seen: readonly string[] = [];
    ctx.ix.ensureMappings = async (_providerId, fps): Promise<IxEnsureResult> => {
      seen = fps;
      return {
        ok: true,
        providerId: 'p1',
        items: fps.map((fingerprint) => ({
          fingerprint,
          name: fingerprint,
          outcome: 'created' as const,
          detail: '已新建端口',
        })),
        warnings: [],
      };
    };
    const ok = await app.inject({
      method: 'POST',
      url: '/api/ix/mappings',
      headers: AUTH,
      payload: { fingerprints: fingerprints.slice(0, 50) },
    });
    expect(ok.statusCode).toBe(200);
    expect(seen).toHaveLength(50);
    expect(body<{ results: unknown[] }>(ok).results).toHaveLength(50);
  });

  it('fingerprints 空数组也是 400（"什么都没勾"该说出来，不是静默成功）', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ix/mappings',
      headers: AUTH,
      payload: { fingerprints: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('deleteRemote 写错值 → 400，绝不静默当成 false', async () => {
    // 静默当 false 的后果：用户以为端口删了，实际它继续占着线路配额，
    // 而界面上再也看不到那条映射。
    const { app } = await setup();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/ix/mappings/abc?deleteRemote=yes',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(body<{ details: string[] }>(res).details.join()).toMatch(/deleteRemote/);
  });
});

// ─────────────────────────────────────────────────────────────
//  profile 规则里的 ix 字段
// ─────────────────────────────────────────────────────────────

describe('profile 规则里的 ix', () => {
  it('POST 一个带 ix 的 profile，GET 回来三个字段原样保留', async () => {
    // 这是最容易漏的一处：zod schema 不认识的键会被**静默丢掉**，
    // 表现是界面上配好的 IX 开关消失、订阅还是直连，而日志里什么都没有。
    const { app } = await setup();
    const ix = { enabled: true, providerId: 'provider-uuid-1', fillOriginHost: false };

    const created = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: AUTH,
      payload: { name: '走中转', rule: { ix, regions: ['HK'] } },
    });
    expect(created.statusCode).toBe(201);
    expect(body<{ rule: { ix: unknown } }>(created).rule.ix).toEqual(ix);

    const listed = body<Array<{ rule: { ix: unknown } }>>(
      await app.inject({ method: 'GET', url: '/api/profiles', headers: AUTH }),
    );
    expect(listed[0]!.rule.ix).toEqual(ix);
  });

  it('字段名是 fillOriginHost 而不是 fillSni —— 写错名字必须被丢掉而非静默生效', async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: AUTH,
      payload: { name: '拼错了', rule: { ix: { enabled: true, fillSni: false } } },
    });
    expect(created.statusCode).toBe(201);
    // zod 剥掉未知键：存下来的只有 enabled。断言它是为了钉住"名字就是
    // fillOriginHost"，将来谁把 core 的字段改名，这条会红。
    expect(body<{ rule: { ix: Record<string, unknown> } }>(created).rule.ix).toEqual({ enabled: true });
  });

  it('/api/preview 也接受带 ix 的规则', async () => {
    const { app, ctx } = await setup();
    ctx.nodes.replaceForSubscription('s1', [ssNode('香港 01', 'hk.example.com', 8443)]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/preview',
      headers: AUTH,
      payload: { rule: { ix: { enabled: true, fillOriginHost: true } }, target: 'clash.meta' },
    });
    expect(res.statusCode).toBe(200);
    // 没有 provider 时 IX 那趟必须给出可读原因，而不是悄悄不干活
    const parsed = body<{ warnings: string[]; ix: unknown }>(res);
    expect(parsed.warnings.join()).toContain('中转商');
  });
});

// ─────────────────────────────────────────────────────────────
//  映射
// ─────────────────────────────────────────────────────────────

describe('/api/ix/mappings', () => {
  it('列表带上 nodeName，键集合与契约逐字一致', async () => {
    const { app, ctx } = await setup();
    const node = ssNode('香港 01', 'hk.example.com', 8443);
    ctx.nodes.replaceForSubscription('s1', [node]);
    const provider = await createProvider(app);
    ctx.ixMappings.upsert({
      providerId: provider.id,
      fingerprint: node.fingerprint,
      targetHost: node.server,
      targetPort: node.port,
      remotePortId: 230,
      entryHost: 'shzf.pb.test.xyz',
      entryPort: 51_221,
      lineName: '腾讯上海P',
      state: 'active',
    });

    const res = await app.inject({ method: 'GET', url: '/api/ix/mappings', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const parsed = body<{ mappings: Array<Record<string, unknown>>; warnings: string[] }>(res);
    expect(parsed.mappings).toHaveLength(1);
    expect(Object.keys(parsed.mappings[0]!).sort()).toEqual(MAPPING_KEYS);
    expect(parsed.mappings[0]).toMatchObject({
      providerId: provider.id,
      fingerprint: node.fingerprint,
      nodeName: '香港 01',
      entryHost: 'shzf.pb.test.xyz',
      entryPort: 51_221,
      state: 'active',
      suspended: false,
    });
    expect(parsed.warnings).toEqual([]);
  });

  it('节点已消失 → nodeName 为 null，孤儿有可读 warning', async () => {
    const { app, ctx } = await setup();
    const provider = await createProvider(app);
    ctx.ixMappings.upsert({
      providerId: provider.id,
      fingerprint: 'b'.repeat(40),
      targetHost: 'gone.example.com',
      targetPort: 443,
      state: 'orphan',
      missingCount: 5,
    });

    const parsed = body<{ mappings: Array<{ nodeName: string | null }>; warnings: string[] }>(
      await app.inject({ method: 'GET', url: '/api/ix/mappings', headers: AUTH }),
    );
    expect(parsed.mappings[0]!.nodeName).toBeNull();
    expect(parsed.warnings.join()).toContain('孤儿');
    expect(parsed.warnings.join()).toContain('配额');
  });

  it('providerId 过滤：能筛、不存在的 id 是 404', async () => {
    const { app, ctx } = await setup();
    const a = await createProvider(app, { name: 'A' });
    const b = await createProvider(app, { name: 'B' });
    for (const [provider, fingerprint] of [
      [a, 'a'.repeat(40)],
      [b, 'b'.repeat(40)],
    ] as const) {
      ctx.ixMappings.upsert({
        providerId: provider.id,
        fingerprint,
        targetHost: 'x.example.com',
        targetPort: 443,
      });
    }

    const filtered = body<{ mappings: Array<{ providerId: string }> }>(
      await app.inject({ method: 'GET', url: `/api/ix/mappings?providerId=${a.id}`, headers: AUTH }),
    );
    expect(filtered.mappings).toHaveLength(1);
    expect(filtered.mappings[0]!.providerId).toBe(a.id);

    const all = body<{ mappings: unknown[] }>(
      await app.inject({ method: 'GET', url: '/api/ix/mappings', headers: AUTH }),
    );
    expect(all.mappings).toHaveLength(2);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/ix/mappings?providerId=nope',
      headers: AUTH,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('POST：整体失败时带原因返回 400，不给一个"点了没反应"的空 results', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ix/mappings',
      headers: AUTH,
      payload: { fingerprints: ['a'.repeat(40)] },
    });
    expect(res.statusCode).toBe(400);
    const parsed = body<{ error: string; results: unknown[]; warnings: string[] }>(res);
    expect(parsed.error).toContain('中转商');
    // 契约字段仍在，前端不必为错误分支写第二套解析
    expect(parsed.results).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it('POST：逐节点结果按契约映射（detail → reason）', async () => {
    const { app, ctx } = await setup();
    ctx.ix.ensureMappings = async (): Promise<IxEnsureResult> => ({
      ok: false,
      providerId: 'p1',
      items: [
        {
          fingerprint: 'a'.repeat(40),
          name: '香港 01',
          outcome: 'created',
          detail: '已新建端口 231，入口 shzf.pb.test.xyz:51222。',
          remotePortId: 231,
          entryHost: 'shzf.pb.test.xyz',
          entryPort: 51_222,
        },
        {
          fingerprint: 'b'.repeat(40),
          name: '日本 02',
          outcome: 'failed',
          detail: '线路配额已用满。下一步：到中转平台删掉不用的端口。',
        },
      ],
      warnings: ['当前有 2 个启用中的中转商，已取最早的'],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/ix/mappings',
      headers: AUTH,
      payload: { fingerprints: ['a'.repeat(40), 'b'.repeat(40)] },
    });
    expect(res.statusCode).toBe(200);
    const parsed = body<{
      results: Array<Record<string, unknown>>;
      warnings: string[];
    }>(res);
    expect(parsed.results[0]).toEqual({
      fingerprint: 'a'.repeat(40),
      outcome: 'created',
      remotePortId: 231,
      entryHost: 'shzf.pb.test.xyz',
      entryPort: 51_222,
      reason: '已新建端口 231，入口 shzf.pb.test.xyz:51222。',
    });
    // 失败条目只有 fingerprint / outcome / reason —— 没建成的端口不该编出入口地址
    expect(parsed.results[1]).toEqual({
      fingerprint: 'b'.repeat(40),
      outcome: 'failed',
      reason: '线路配额已用满。下一步：到中转平台删掉不用的端口。',
    });
    expect(parsed.warnings).toHaveLength(1);
  });

  it('DELETE 不删远端：本地映射消失，warning 说清端口还占着配额', async () => {
    // 走**真实** IxService：deleteRemote 为假时它压根不构造客户端，所以不出站。
    const { app, ctx } = await setup();
    const provider = await createProvider(app);
    const fingerprint = 'c'.repeat(40);
    ctx.ixMappings.upsert({
      providerId: provider.id,
      fingerprint,
      targetHost: 'hk.example.com',
      targetPort: 8443,
      remotePortId: 230,
      state: 'active',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/ix/mappings/${fingerprint}?providerId=${provider.id}&deleteRemote=false`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const parsed = body<{ removed: boolean; remoteDeleted: boolean; warning?: string }>(res);
    expect(parsed).toMatchObject({ removed: true, remoteDeleted: false });
    expect(parsed.warning).toContain('230');
    expect(parsed.warning).toContain('配额');
    expect(ctx.ixMappings.get(provider.id, fingerprint)).toBeUndefined();
  });

  it('DELETE 删远端：deleteRemote=true 真的传到 service', async () => {
    const { app, ctx } = await setup();
    const provider = await createProvider(app);
    let seen: { fingerprint?: string; deleteRemote?: boolean } = {};
    ctx.ix.removeMapping = async (_providerId, fingerprint, options): Promise<IxRemoveResult> => {
      seen = { fingerprint, deleteRemote: options?.deleteRemote };
      return { ok: true, removedLocal: true, remoteDeleted: true, warnings: [] };
    };

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/ix/mappings/dead-beef?providerId=${provider.id}&deleteRemote=true`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual({ fingerprint: 'dead-beef', deleteRemote: true });
    expect(body<{ removed: boolean; remoteDeleted: boolean; warning?: string }>(res)).toEqual({
      removed: true,
      remoteDeleted: true,
    });
  });

  it('DELETE：远端删失败要如实上报，不能表现成一次干净的删除', async () => {
    const { app, ctx } = await setup();
    const provider = await createProvider(app);
    ctx.ix.removeMapping = async (): Promise<IxRemoveResult> => ({
      ok: false,
      removedLocal: false,
      remoteDeleted: false,
      remotePortId: 230,
      warnings: [],
      error: '删除远端端口 230 失败：平台 500。本地映射已保留。',
    });

    const parsed = body<{ removed: boolean; remoteDeleted: boolean; warning?: string }>(
      await app.inject({
        method: 'DELETE',
        url: `/api/ix/mappings/x?providerId=${provider.id}&deleteRemote=true`,
        headers: AUTH,
      }),
    );
    expect(parsed).toMatchObject({ removed: false, remoteDeleted: false });
    expect(parsed.warning).toContain('230');
  });

  it('DELETE：一个 provider 都没有时给可读原因（400，不是 500）', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'DELETE', url: '/api/ix/mappings/x', headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(body<{ error: string }>(res).error).toContain('中转商');
  });
});

// ─────────────────────────────────────────────────────────────
//  probe / refresh
// ─────────────────────────────────────────────────────────────

describe('/api/ix probe 与 refresh', () => {
  it('probe 返回 { probe, provider }，且 provider 是探测后重新读的那份', async () => {
    const { app, ctx } = await setup();
    const created = await createProvider(app);

    // 替身模拟真实 probe 的副作用：写额度快照与 last_probe_at
    ctx.ix.probe = async (providerId?: string): Promise<IxProbeResult> => {
      ctx.ixProviders.update(providerId!, {
        quotaJson: JSON.stringify({ probedAt: 1, trafficTotalBytes: 107_374_182_400 }),
        lastProbeAt: 1_700_000_000_000,
        lastError: null,
      });
      return {
        ok: true,
        providerId,
        name: 'zf 中转',
        username: 'relay-user',
        isAdmin: false,
        lines: [
          {
            lineId: 20,
            name: '腾讯上海P',
            entryHost: 'shzf.pb.test.xyz',
            portStart: 50_000,
            portEnd: 55_000,
            maxPorts: 30,
            usedPorts: 3,
            online: true,
            suspended: false,
          },
        ],
        unavailable: ['账号不是管理员：拿不到长期 API Key。'],
        warnings: [],
      };
    };

    const res = await app.inject({
      method: 'POST',
      url: `/api/ix/providers/${created.id}/probe`,
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const parsed = body<{ probe: IxProbeResult; provider: ProviderView }>(res);
    expect(parsed.probe.ok).toBe(true);
    expect(parsed.probe.lines[0]!.maxPorts).toBe(30);
    // 重新读那份：额度快照与探测时间必须是刚写下的，而不是进来时的旧对象
    expect(parsed.provider.lastProbeAt).toBe(1_700_000_000_000);
    expect(parsed.provider.quota).toEqual({ probedAt: 1, trafficTotalBytes: 107_374_182_400 });
    // 探测结果里只有平台侧用户名，没有任何凭据
    expect(res.payload).not.toContain(PASSWORD);
    expect(res.payload).not.toContain('v1:');
    expect(Object.keys(parsed.provider).sort()).toEqual(PROVIDER_KEYS);

    // 前端的 api.post 在没有 body 时**不发** Content-Type（public/app.js 的
    // request()），probe 与 refresh 都是这么调的 —— 路由必须照样能处理，
    // 否则界面上的「测试连接」按钮一按就是 400。
    const noBody = await app.inject({
      method: 'POST',
      url: `/api/ix/providers/${created.id}/probe`,
      headers: AUTH,
    });
    expect(noBody.statusCode).toBe(200);
  });

  it('refresh 指定 provider：包一层数组返回；id 不存在是 404', async () => {
    const { app, ctx } = await setup();
    const created = await createProvider(app);

    // 一条映射都没有时，真实 refresh 提前返回，不构造客户端、不出站
    const res = await app.inject({
      method: 'POST',
      url: '/api/ix/refresh',
      headers: AUTH,
      payload: { providerId: created.id },
    });
    expect(res.statusCode).toBe(200);
    const parsed = body<{ results: Array<{ ok: boolean; checked: number }>; warnings: string[] }>(res);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]).toMatchObject({ ok: true, checked: 0, providerId: created.id });
    expect(parsed.warnings).toEqual([]);

    const missing = await app.inject({
      method: 'POST',
      url: '/api/ix/refresh',
      headers: AUTH,
      payload: { providerId: 'nope' },
    });
    expect(missing.statusCode).toBe(404);
    expect(ctx.ixProviders.list()).toHaveLength(1);
  });

  it('refresh 不指定 provider 且一个启用的都没有 → 空 results + 可读 warning', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/ix/refresh', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(200);
    const parsed = body<{ results: unknown[]; warnings: string[] }>(res);
    expect(parsed.results).toEqual([]);
    expect(parsed.warnings.join()).toContain('总闸');

    // 完全不带 body 也必须能走（前端不传参时就是这样）
    const noBody = await app.inject({ method: 'POST', url: '/api/ix/refresh', headers: AUTH });
    expect(noBody.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────
//  /meta、凭据出口、日志
// ─────────────────────────────────────────────────────────────

describe('/api/meta 的 IX 常量', () => {
  it('暴露 ixAuthModes / ixStates / 三个数字', async () => {
    const { app } = await setup({ ixSyncIntervalHours: 8, ixOrphanThreshold: 3 });
    const meta = body<{
      ixAuthModes: Array<{ value: string; label: string }>;
      ixStates: Array<{ value: string; label: string }>;
      ixSyncIntervalHours: number;
      ixOrphanThreshold: number;
      ixMaxFingerprints: number;
    }>(await app.inject({ method: 'GET', url: '/api/meta', headers: AUTH }));

    expect(meta.ixAuthModes.map((m) => m.value)).toEqual(['api-key', 'login']);
    expect(meta.ixAuthModes.every((m) => m.label.length > 0)).toBe(true);
    expect(meta.ixStates.map((s) => s.value)).toEqual(['pending', 'active', 'error', 'orphan']);
    expect(meta.ixSyncIntervalHours).toBe(8);
    expect(meta.ixOrphanThreshold).toBe(3);
    // 前端拿它做同一份预检，别再硬编码一份
    expect(meta.ixMaxFingerprints).toBe(50);
  });
});

describe('凭据出口的缓存头', () => {
  it('GET /api/nodes/:fingerprint/uri 带 cache-control: no-store', async () => {
    // CLAUDE.md 声称三个凭据出口都带这个头，而这个出口以前漏了 ——
    // 文档对、代码错，顺手补上并用断言钉住。
    const { app, ctx } = await setup();
    const node = ssNode('香港 01', 'hk.example.com', 8443);
    ctx.nodes.replaceForSubscription('s1', [node]);

    const res = await app.inject({
      method: 'GET',
      url: `/api/nodes/${node.fingerprint}/uri`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(body<{ uri: string }>(res).uri).toContain('hk.example.com');
  });
});

describe('IX 写操作的日志字段名', () => {
  it('没有任何字段名会被 redact 打成 ***，也没有叫 path 的字段', async () => {
    const { app, ctx } = await setup();
    const created = await createProvider(app, { authMode: 'api-key', apiKey: API_KEY });
    ctx.ix.probe = async (providerId?: string): Promise<IxProbeResult> => ({
      ok: false,
      providerId,
      lines: [],
      unavailable: [],
      warnings: [],
      error: '连接失败',
    });

    await app.inject({
      method: 'PATCH',
      url: `/api/ix/providers/${created.id}`,
      headers: AUTH,
      payload: { name: '改名', password: 'another-password' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/ix/providers/${created.id}/probe`,
      headers: AUTH,
      payload: {},
    });
    await app.inject({ method: 'POST', url: '/api/ix/refresh', headers: AUTH, payload: {} });
    await app.inject({
      method: 'DELETE',
      url: `/api/ix/mappings/x?providerId=${created.id}`,
      headers: AUTH,
    });
    await app.inject({
      method: 'DELETE',
      url: `/api/ix/providers/${created.id}`,
      headers: AUTH,
    });

    const ixLogs = logs.filter((entry) => entry.msg.startsWith('IX：'));
    // 先证明确实记了日志，否则下面的循环是空过
    expect(ixLogs.length).toBeGreaterThanOrEqual(5);

    // 与 logger.ts 的 SENSITIVE_KEYS 一致（大小写不敏感的**子串**匹配）
    const sensitive = /password|passwd|secret|token|uuid|auth|key|credential|cookie/i;
    for (const entry of ixLogs) {
      for (const [field, value] of Object.entries(entry.fields)) {
        expect(field, `${entry.msg} 的字段 ${field} 会被打码成 ***`).not.toMatch(sensitive);
        // path 会被 redactPath() 处理：长度 ≥ 12 的路径段当 token 打码，
        // '/subscription' 会落盘成 '/sub***ion'。记端点名用 endpoint。
        expect(field, `${entry.msg} 用了 path 字段`).not.toBe('path');
        // 顺带保证没人把明文塞进日志值里
        if (typeof value === 'string') {
          expect(value).not.toContain(API_KEY);
          expect(value).not.toContain('another-password');
        }
      }
    }
    // endpoint 是我们约定的替代品，至少得真的在用
    expect(ixLogs.some((entry) => typeof entry.fields['endpoint'] === 'string')).toBe(true);
  });
});
