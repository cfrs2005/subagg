/**
 * zf 平台客户端测试。
 *
 * 不打真实网络，但也**不 mock fetch** —— 起一个真实的本地 HTTP 服务
 * （仿 `test/node-ping-service.test.ts` 起真实端口的做法）。理由：这个客户端
 * 出错的地方几乎全在真实 HTTP 语义上（DELETE 带 body、query 编码、
 * 401 之后的重发、非 JSON 响应体），mock 掉 fetch 恰好把这些都绕过去了。
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../src/logger.js';
import { redact } from '../src/logger.js';
import { IxClient } from '../src/services/ix-client.js';
import {
  IxApiError,
  coerceIxPageSize,
  modBodyFromPort,
  parseJwtExpiry,
} from '../src/services/ix-protocol.js';
import type { IxPort, IxSession } from '../src/services/ix-protocol.js';

// ─────────────────────────────────────────────────────────────
//  测试替身：真实本地 HTTP 服务
// ─────────────────────────────────────────────────────────────

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown> | undefined;
}

type Handler = (req: Recorded, res: http.ServerResponse) => void;

/** 固定时钟。JWT 过期边界必须可复现，不能靠真实时间。 */
const FIXED_NOW = Date.UTC(2026, 7, 26, 12, 0, 0);

let server: http.Server;
let baseUrl: string;
let recorded: Recorded[];
let routes: Map<string, Handler>;
let loginCount: number;
let warnings: { msg: string; ctx?: Record<string, unknown> }[];
let logger: Logger;

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/**
 * 造一个格式合法、签名是垃圾的 JWT。
 *
 * 客户端刻意不验签，所以签名段随便填即可 —— 这也顺手锁住了"不验签"这个决定：
 * 哪天有人加了验签，这里全部用例会红。
 */
function makeJwt(expSeconds: number): string {
  const b64 = (o: unknown): string =>
    Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ token_id: 7, exp: expSeconds, sid: 'sid-test' })}.not-a-signature`;
}

const FRESH_JWT = makeJwt(FIXED_NOW / 1000 + 7 * 24 * 3600);

function session(expSeconds: number): IxSession {
  const jwt = makeJwt(expSeconds);
  return { jwt, sessionId: 'sess-0000-1111', expiresAt: expSeconds * 1000 };
}

/** 真实 port 对象的形状（键名抄自实测响应），带一个"平台日后新增字段"的替身。 */
function makePort(overrides: Partial<IxPort> = {}): IxPort {
  return {
    id: 230,
    display_name: 'bwg',
    ip_addr: 'entry.relay.example',
    port_v4: 51221,
    outbound_endpoint_id: 20,
    line_name: '腾讯上海P',
    target_address_list: ['landing-a.example:2002'],
    target_select_mode: 0,
    test_method: 0,
    forward_config: { mode: 'direct' },
    enable_udp: true,
    exclude_from_subscription: false,
    is_suspended: false,
    tags: ['claimed', 'subagg'],
    traffic_in: 188159102,
    traffic_out: 33928019,
    current_latency_summary: {
      sample_at: '2026-08-26T12:51:30.017Z',
      avg_latency_us: 141400,
      stddev_latency_us: 0,
      packet_loss_rate: 0,
      samples_count: 5,
    },
    sync_error_message: null,
    sync_error_at: null,
    synced_to_worker_at: '2026-08-26T12:52:39.832+00:00',
    suspend_type: null,
    suspended_at: null,
    resume_at: null,
    period_traffic: 50,
    period_traffic_limit_mode: 0,
    allow_ip_num: 3,
    allow_conn_num: null,
    expire_at: '2026-12-01T00:00:00Z',
    accept_proxy_protocol: false,
    send_proxy_protocol_version: null,
    custom_config: null,
    // 未知字段：read-modify-write 必须原样回填它
    future_flag: 'keep-me',
    ...overrides,
  };
}

function portPage(ports: IxPort[], totalPages = 1, currentPage = 1): unknown {
  return {
    ports,
    pagination: { current_page: currentPage, page_size: 200, total_items: ports.length, total_pages: totalPages },
  };
}

function loginClient(overrides: Partial<ConstructorParameters<typeof IxClient>[0]> = {}): IxClient {
  return new IxClient({
    baseUrl,
    auth: { mode: 'login', username: 'tester', password: 'not-a-real-password' },
    logger,
    retries: 0,
    backoffBaseMs: 1,
    now: () => FIXED_NOW,
    ...overrides,
  });
}

function keyClient(overrides: Partial<ConstructorParameters<typeof IxClient>[0]> = {}): IxClient {
  return new IxClient({
    baseUrl,
    auth: { mode: 'api-key', apiKey: 'testkey-0123456789' },
    logger,
    retries: 0,
    backoffBaseMs: 1,
    now: () => FIXED_NOW,
    ...overrides,
  });
}

function hits(path: string): Recorded[] {
  return recorded.filter((r) => r.path === path);
}

beforeEach(async () => {
  recorded = [];
  routes = new Map();
  warnings = [];
  loginCount = 0;
  logger = {
    debug() {},
    info() {},
    warn(msg, ctx) {
      warnings.push({ msg, ctx });
    },
    error() {},
    child: () => logger,
  };

  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const raw = Buffer.concat(chunks).toString('utf8');
      const entry: Recorded = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body: raw === '' ? undefined : (JSON.parse(raw) as Record<string, unknown>),
      };
      recorded.push(entry);
      const handler = routes.get(`${entry.method} ${entry.path}`);
      if (!handler) {
        reply(res, 404, { message: 'Not Found', error_code: '404 Not Found' });
        return;
      }
      handler(entry, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  routes.set('POST /api/login', (_req, res) => {
    loginCount += 1;
    reply(res, 200, { jwt: FRESH_JWT, session_id: 'sess-fresh-9999' });
  });
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

// ─────────────────────────────────────────────────────────────
//  A 认证双模
// ─────────────────────────────────────────────────────────────

describe('IxClient 认证', () => {
  it('API Key 模式发 X-API-Key，且完全不登录', async () => {
    routes.set('GET /api/subscription', (_req, res) => reply(res, 200, { id: 30, username: 'tester' }));

    await keyClient().subscriptionInfo();

    const [call] = hits('/api/subscription');
    expect(call?.headers['x-api-key']).toBe('testkey-0123456789');
    expect(call?.headers.authorization).toBeUndefined();
    expect(loginCount).toBe(0);
  });

  it('JWT 模式先登录再发 Authorization: Bearer', async () => {
    routes.set('GET /api/subscription', (_req, res) => reply(res, 200, { id: 30 }));

    const client = loginClient();
    await client.subscriptionInfo();

    expect(loginCount).toBe(1);
    expect(hits('/api/subscription')[0]?.headers.authorization).toBe(`Bearer ${FRESH_JWT}`);
    // 登录请求本身不能带认证头
    expect(hits('/api/login')[0]?.headers.authorization).toBeUndefined();
    expect(client.currentSession()?.expiresAt).toBe((FIXED_NOW / 1000 + 7 * 24 * 3600) * 1000);
  });

  it('传入未过期会话时不重新登录', async () => {
    routes.set('GET /api/subscription', (_req, res) => reply(res, 200, { id: 30 }));
    const cached = session(FIXED_NOW / 1000 + 3 * 24 * 3600);

    await loginClient({
      auth: { mode: 'login', username: 'tester', password: 'not-a-real-password', session: cached },
    }).subscriptionInfo();

    expect(loginCount).toBe(0);
    expect(hits('/api/subscription')[0]?.headers.authorization).toBe(`Bearer ${cached.jwt}`);
  });

  it('会话已过期时先登录', async () => {
    routes.set('GET /api/subscription', (_req, res) => reply(res, 200, { id: 30 }));
    const stale = session(FIXED_NOW / 1000 - 60);

    await loginClient({
      auth: { mode: 'login', username: 'tester', password: 'not-a-real-password', session: stale },
    }).subscriptionInfo();

    expect(loginCount).toBe(1);
    expect(hits('/api/subscription')[0]?.headers.authorization).toBe(`Bearer ${FRESH_JWT}`);
  });

  it('距 exp 不足 5 分钟即视为过期（边界）；超过 5 分钟则照旧使用', async () => {
    routes.set('GET /api/subscription', (_req, res) => reply(res, 200, { id: 30 }));

    const almost = session(FIXED_NOW / 1000 + 4 * 60);
    await loginClient({
      auth: { mode: 'login', username: 'tester', password: 'not-a-real-password', session: almost },
    }).subscriptionInfo();
    expect(loginCount).toBe(1);

    const stillGood = session(FIXED_NOW / 1000 + 6 * 60);
    await loginClient({
      auth: { mode: 'login', username: 'tester', password: 'not-a-real-password', session: stillGood },
    }).subscriptionInfo();
    expect(loginCount).toBe(1); // 没有新增登录
    expect(hits('/api/subscription')[1]?.headers.authorization).toBe(`Bearer ${stillGood.jwt}`);
  });

  it('拿到新 JWT 时回调 onSession（供调用方加密落库）', async () => {
    routes.set('GET /api/subscription', (_req, res) => reply(res, 200, { id: 30 }));
    const saved: IxSession[] = [];

    await loginClient({
      auth: {
        mode: 'login',
        username: 'tester',
        password: 'not-a-real-password',
        onSession: (s) => saved.push(s),
      },
    }).subscriptionInfo();

    expect(saved).toHaveLength(1);
    expect(saved[0]?.sessionId).toBe('sess-fresh-9999');
    expect(saved[0]?.expiresAt).toBe((FIXED_NOW / 1000 + 7 * 24 * 3600) * 1000);
  });

  it('收到 401 后重登恰好一次并重试原请求', async () => {
    let calls = 0;
    routes.set('GET /api/subscription', (_req, res) => {
      calls += 1;
      if (calls === 1) reply(res, 401, { message: 'token expired', error_code: '401 Unauthorized' });
      else reply(res, 200, { id: 30, username: 'tester' });
    });

    const info = await loginClient({
      auth: { mode: 'login', username: 'tester', password: 'not-a-real-password', session: session(FIXED_NOW / 1000 + 86_400) },
    }).subscriptionInfo();

    expect(info.username).toBe('tester');
    expect(loginCount).toBe(1);
    expect(calls).toBe(2);
  });

  it('重登后仍 401 就抛错，不再重登（无限重登会把账号打死）', async () => {
    routes.set('GET /api/subscription', (_req, res) =>
      reply(res, 401, { message: 'token expired', error_code: '401 Unauthorized' }),
    );

    const client = loginClient({
      auth: { mode: 'login', username: 'tester', password: 'not-a-real-password', session: session(FIXED_NOW / 1000 + 86_400) },
    });
    await expect(client.subscriptionInfo()).rejects.toThrow(IxApiError);

    expect(loginCount).toBe(1);
    expect(hits('/api/subscription')).toHaveLength(2);
  });

  it('API Key 模式遇 401 不会去登录', async () => {
    routes.set('GET /api/subscription', (_req, res) => reply(res, 401, { message: 'bad key' }));

    await expect(keyClient().subscriptionInfo()).rejects.toThrow(IxApiError);
    expect(loginCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
//  B page_size 白名单
// ─────────────────────────────────────────────────────────────

describe('page_size 白名单', () => {
  it('非法值被校正到合法值并留下 warning（服务端会静默回落 20）', async () => {
    routes.set('GET /api/ports', (_req, res) => reply(res, 200, portPage([])));
    const client = keyClient();

    await client.listPorts({ pageSize: 30 });
    await client.listPorts({ pageSize: 0 });
    await client.listPorts({ pageSize: 1000 });
    await client.listPorts();

    const sizes = hits('/api/ports').map((r) => r.query.get('page_size'));
    expect(sizes).toEqual(['50', '20', '200', '20']);
    // 三次非法输入各留一条 warning；合法/缺省不该刷日志
    expect(warnings.filter((w) => w.msg.includes('page_size'))).toHaveLength(3);
  });

  it('page_size 永远显式发送，page 缺省为 1', async () => {
    routes.set('GET /api/ports', (_req, res) => reply(res, 200, portPage([])));
    await keyClient().listPorts();

    const call = hits('/api/ports')[0];
    expect(call?.query.get('page')).toBe('1');
    expect(call?.query.get('page_size')).toBe('20');
  });

  it('coerceIxPageSize 取不小于请求值的最小合法值', () => {
    expect(coerceIxPageSize(undefined)).toBe(20);
    expect(coerceIxPageSize(20)).toBe(20);
    expect(coerceIxPageSize(30)).toBe(50);
    expect(coerceIxPageSize(0)).toBe(20);
    expect(coerceIxPageSize(-5)).toBe(20);
    expect(coerceIxPageSize(1000)).toBe(200);
    expect(coerceIxPageSize(Number.NaN)).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────
//  C 404 的两种语义
// ─────────────────────────────────────────────────────────────

describe('404 的两种语义', () => {
  it('通用 "Not Found" 判为隐藏式权限拒绝', async () => {
    routes.set('GET /api/subscription', (_req, res) =>
      reply(res, 404, { message: 'Not Found', error_code: '404 Not Found' }),
    );

    const err = await keyClient().subscriptionInfo().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IxApiError);
    const api = err as IxApiError;
    expect(api.status).toBe(404);
    expect(api.notFoundKind).toBe('permission');
    expect(api.retryable).toBe(false);
    // 文案必须把歧义说清楚，不能让人以为"平台没这个端点"
    expect(api.message).toContain('权限不足也返回 404');
    expect(api.errorCode).toBe('404 Not Found');
  });

  it('带资源名的 404 判为资源不存在/不属于本人', async () => {
    routes.set('DELETE /api/ports', (_req, res) =>
      reply(res, 404, {
        message: 'Port not found or unauthorized',
        error_code: '404 Not Found',
        api_error_code: 'PORT_NOT_FOUND',
      }),
    );

    const err = (await keyClient()
      .deletePort(999)
      .catch((e: unknown) => e)) as IxApiError;
    expect(err.notFoundKind).toBe('resource');
    expect(err.apiErrorCode).toBe('PORT_NOT_FOUND');
    expect(err.message).toContain('Port not found or unauthorized');
  });
});

// ─────────────────────────────────────────────────────────────
//  D 重试与超时
// ─────────────────────────────────────────────────────────────

describe('重试与超时', () => {
  it('5xx 会重试，最终成功', async () => {
    let calls = 0;
    routes.set('GET /api/subscription', (_req, res) => {
      calls += 1;
      if (calls < 3) reply(res, 502, { message: 'bad gateway' });
      else reply(res, 200, { id: 30, username: 'tester' });
    });

    const info = await keyClient({ retries: 2 }).subscriptionInfo();
    expect(info.id).toBe(30);
    expect(calls).toBe(3);
  });

  it('4xx 不重试', async () => {
    routes.set('GET /api/subscription', (_req, res) => reply(res, 400, { message: 'bad request' }));

    await expect(keyClient({ retries: 2 }).subscriptionInfo()).rejects.toThrow(IxApiError);
    expect(hits('/api/subscription')).toHaveLength(1);
  });

  it('429 可重试，且业务码 api_error_code 一路保留给上层判断', async () => {
    routes.set('GET /api/subscription', (_req, res) =>
      reply(res, 429, { message: 'slow down', error_code: '429', api_error_code: 'RATE_LIMITED' }),
    );

    const err = (await keyClient({ retries: 1 })
      .subscriptionInfo()
      .catch((e: unknown) => e)) as IxApiError;
    expect(err.retryable).toBe(true);
    expect(err.apiErrorCode).toBe('RATE_LIMITED');
    expect(hits('/api/subscription')).toHaveLength(2);
  });

  it('超时算 retryable，并给出可读原因', async () => {
    routes.set('GET /api/subscription', (_req, res) => {
      // 故意不回应；连接由 afterEach 的 closeAllConnections 收掉
      setTimeout(() => res.end('{}'), 5_000).unref();
    });

    const err = (await keyClient({ retries: 0, timeoutMs: 60 })
      .subscriptionInfo()
      .catch((e: unknown) => e)) as IxApiError;
    expect(err).toBeInstanceOf(IxApiError);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('超时');
  });
});

// ─────────────────────────────────────────────────────────────
//  E mod_port 的 read-modify-write
// ─────────────────────────────────────────────────────────────

describe('mod_port 全量覆盖', () => {
  it('patchPort 先 GET 回完整对象再合并，未改字段一个不丢', async () => {
    routes.set('GET /api/ports', (_req, res) => reply(res, 200, portPage([makePort()])));
    routes.set('POST /api/mod_port', (_req, res) => reply(res, 200, { id: 230 }));

    await keyClient().patchPort(230, { display_name: 'bwg-renamed' });

    // 必须先读后写
    expect(recorded.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/ports', 'POST /api/mod_port']);

    const body = hits('/api/mod_port')[0]?.body ?? {};
    expect(body['display_name']).toBe('bwg-renamed');
    // 下面这些正是"只发部分字段"会被静默清空的字段
    expect(body['tags']).toEqual(['claimed', 'subagg']);
    expect(body['expire_at']).toBe('2026-12-01T00:00:00Z');
    expect(body['period_traffic']).toBe(50);
    expect(body['allow_ip_num']).toBe(3);
    expect(body['enable_udp']).toBe(true);
    expect(body['target_address_list']).toEqual(['landing-a.example:2002']);
    expect(body['id']).toBe(230);
    // 平台日后新增的未知字段也必须原样回填
    expect(body['future_flag']).toBe('keep-me');
  });

  it('modPort 只接受完整对象，回填时剔掉服务端计算字段', () => {
    const body = modBodyFromPort(makePort());
    expect(body['id']).toBe(230);
    expect(body['tags']).toEqual(['claimed', 'subagg']);
    expect(body['future_flag']).toBe('keep-me');
    for (const derived of [
      'ip_addr',
      'port_v4',
      'traffic_in',
      'traffic_out',
      'current_latency_summary',
      'is_suspended',
      'synced_to_worker_at',
      'line_name',
    ]) {
      expect(body[derived]).toBeUndefined();
    }
  });

  it('patchPort 找不到端口时报 404（并带上语义标记）', async () => {
    routes.set('GET /api/ports', (_req, res) => reply(res, 200, portPage([makePort()])));

    const err = (await keyClient()
      .patchPort(999, { display_name: 'x' })
      .catch((e: unknown) => e)) as IxApiError;
    expect(err.status).toBe(404);
    expect(err.notFoundKind).toBe('resource');
    expect(hits('/api/mod_port')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
//  F 认领查重（target 是子串模糊匹配）
// ─────────────────────────────────────────────────────────────

describe('findPortByTarget', () => {
  const fuzzy = [
    makePort({ id: 230, target_address_list: ['landing-a.example:2002'] }),
    makePort({ id: 231, target_address_list: ['landing-a.example:2004'] }),
  ];

  it('服务端返回多条子串命中时只认精确匹配的那条', async () => {
    routes.set('GET /api/ports', (_req, res) => reply(res, 200, portPage(fuzzy)));

    const found = await keyClient().findPortByTarget('landing-a.example:2004');
    expect(found?.id).toBe(231);
    expect(hits('/api/ports')[0]?.query.get('target')).toBe('landing-a.example:2004');
  });

  it('只有前缀命中（无精确匹配）时返回 undefined —— 绝不能认领别人的端口', async () => {
    routes.set('GET /api/ports', (_req, res) => reply(res, 200, portPage(fuzzy)));

    expect(await keyClient().findPortByTarget('landing-a.example:200')).toBeUndefined();
    expect(await keyClient().findPortByTarget('landing-a.example')).toBeUndefined();
  });

  it('主机名大小写不影响精确比对', async () => {
    routes.set('GET /api/ports', (_req, res) => reply(res, 200, portPage(fuzzy)));
    expect((await keyClient().findPortByTarget('LANDING-A.EXAMPLE:2002'))?.id).toBe(230);
  });

  it('空 target 直接返回 undefined，不发请求', async () => {
    expect(await keyClient().findPortByTarget('   ')).toBeUndefined();
    expect(recorded).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
//  G 端点契约
// ─────────────────────────────────────────────────────────────

describe('端点契约', () => {
  it('createPort 发全量 body：forward_config direct + expected_port null', async () => {
    routes.set('POST /api/ports', (_req, res) => reply(res, 200, { id: 233 }));

    const result = await keyClient().createPort({
      displayName: 'subagg-hk-01',
      outboundEndpointId: 20,
      targetAddressList: ['hk.example.invalid:443'],
    });

    expect(result.id).toBe(233);
    const body = hits('/api/ports')[0]?.body ?? {};
    expect(body['forward_config']).toEqual({ mode: 'direct' });
    expect(body['expected_port']).toBeNull();
    expect(body['target_select_mode']).toBe(0);
    expect(body['test_method']).toBe(0);
    expect(body['enable_udp']).toBe(true);
    expect(body['accept_proxy_protocol']).toBe(false);
    expect(body['send_proxy_protocol_version']).toBeNull();
    expect(body['exclude_from_subscription']).toBe(false);
    expect(body['custom_config']).toBeNull();
    expect(body['tags']).toEqual([]);
    expect(body['period_traffic_limit_mode']).toBe(0);
    expect(body['expire_at']).toBeNull();
    expect(body['target_address_list']).toEqual(['hk.example.invalid:443']);
  });

  it('deletePort 用 DELETE 且 body 带 id（不是 /ports/:id）', async () => {
    routes.set('DELETE /api/ports', (_req, res) => reply(res, 200, { message: 'ok' }));

    await keyClient().deletePort(230);
    const call = hits('/api/ports')[0];
    expect(call?.method).toBe('DELETE');
    expect(call?.body).toEqual({ id: 230 });
  });

  it('lineDetails 解开 line_details 包裹；listPorts 返回裸 {ports,pagination}', async () => {
    routes.set('GET /api/line_details', (_req, res) =>
      reply(res, 200, {
        line_details: [
          { line_id: 20, line_name: '腾讯上海P', entry_ip: 'entry.relay.example', traffic_scale: 1, traffic_limit: null, used_traffic: 229907815, port_count: 3 },
        ],
      }),
    );
    routes.set('GET /api/ports', (_req, res) => reply(res, 200, portPage([makePort()])));

    const client = keyClient();
    const lines = await client.lineDetails();
    expect(lines[0]?.port_count).toBe(3);

    const page = await client.listPorts();
    expect(page.ports[0]?.ip_addr).toBe('entry.relay.example');
    expect(page.pagination.total_items).toBe(1);
  });

  it('subscriptionInfo 给出 per-line 端口配额（配额是线路级的）', async () => {
    routes.set('GET /api/subscription', (_req, res) =>
      reply(res, 200, {
        id: 30,
        username: 'tester',
        traffic_used: 4967037106,
        traffic_total: 100,
        is_admin: false,
        permissions: [],
        lines: [{ id: 20, display_name: '腾讯上海P', max_ports_number: 30, allow_forward: false, port_start: 50000, port_end: 55000 }],
      }),
    );

    const info = await keyClient().subscriptionInfo();
    expect(info.lines[0]?.max_ports_number).toBe(30);
    expect(info.is_admin).toBe(false);
  });

  it('portsSyncStatus / testLatency / suspendPort / resumePort 打对路径与形状', async () => {
    routes.set('POST /api/ports_sync_status', (_req, res) => reply(res, 200, { message: 'ok' }));
    routes.set('GET /api/test_latency', (_req, res) => reply(res, 200, { avg_latency_us: 141400 }));
    routes.set('POST /api/suspend_port', (_req, res) => reply(res, 200, { message: 'ok' }));
    routes.set('POST /api/resume_port', (_req, res) => reply(res, 200, { message: 'ok' }));

    const client = keyClient();
    await client.portsSyncStatus([230, 231]);
    const probe = await client.testLatency(230);
    await client.suspendPort(230, { resumeAt: null });
    await client.resumePort(230);

    expect(hits('/api/ports_sync_status')[0]?.body).toEqual({ port_ids: [230, 231] });
    expect(hits('/api/test_latency')[0]?.query.get('port_id')).toBe('230');
    expect(probe.avg_latency_us).toBe(141400);
    expect(hits('/api/suspend_port')[0]?.body).toEqual({ id: 230, resume_at: null });
    expect(hits('/api/resume_port')[0]?.body).toEqual({ id: 230 });
  });

  it('翻页：listAllPorts 按 total_pages 翻完，每页固定 page_size=200', async () => {
    routes.set('GET /api/ports', (req, res) => {
      const page = Number(req.query.get('page'));
      reply(res, 200, portPage([makePort({ id: 200 + page })], 2, page));
    });

    const all = await keyClient().listAllPorts();
    expect(all.map((p) => p.id)).toEqual([201, 202]);
    expect(hits('/api/ports').map((r) => r.query.get('page'))).toEqual(['1', '2']);
    expect(hits('/api/ports').every((r) => r.query.get('page_size') === '200')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
//  H 日志字段名（脱敏层的地雷）
// ─────────────────────────────────────────────────────────────

describe('日志字段名能活着穿过 redact', () => {
  it('客户端实际用的字段名都不会被打成 *** 或被当成 token 截断', async () => {
    routes.set('GET /api/subscription', (_req, res) =>
      reply(res, 404, { message: 'Not Found', error_code: '404 Not Found' }),
    );
    await keyClient().subscriptionInfo().catch(() => undefined);

    const notFound = warnings.find((w) => w.msg.includes('404'));
    const redacted = redact(notFound?.ctx ?? {}) as Record<string, unknown>;
    // `endpoint` 必须原样落盘。若有人把它改回 `path`，redact 会把
    // `/subscription` 记成 `/sub***ion`（长度 ≥ 12 的路径段被当 token 打码），
    // 于是日志里再也看不出是哪个端点被拒了。
    expect(redacted['endpoint']).toBe('/subscription');
    expect(redacted['kind']).toBe('permission');
    expect(redacted['code']).toBe('404 Not Found');
    expect(JSON.stringify(redacted)).not.toContain('***');
  });

  it('登录成功日志用 ref（叫 jwt/apiKey/sessionToken 都会被打成 ***）', async () => {
    const captured: Record<string, unknown>[] = [];
    const capturing: Logger = {
      debug() {},
      info: (_msg, ctx) => captured.push(ctx ?? {}),
      warn() {},
      error() {},
      child: () => capturing,
    };
    routes.set('GET /api/subscription', (_req, res) => reply(res, 200, { id: 30 }));

    await loginClient({ logger: capturing }).subscriptionInfo();

    const redacted = redact(captured[0] ?? {}) as Record<string, unknown>;
    expect(redacted['ref']).toBe('sess-fre');
    expect(JSON.stringify(redacted)).not.toContain('***');
  });
});

// ─────────────────────────────────────────────────────────────
//  I JWT 解析
// ─────────────────────────────────────────────────────────────

describe('parseJwtExpiry', () => {
  it('读出 exp（毫秒），不验签', () => {
    expect(parseJwtExpiry(makeJwt(1_800_000_000))).toBe(1_800_000_000_000);
  });

  it('格式不对时返回 null（退化为靠 401 兜底，而不是猜一个有效期）', () => {
    expect(parseJwtExpiry('not-a-jwt')).toBeNull();
    expect(parseJwtExpiry('a.b.c')).toBeNull();
    expect(
      parseJwtExpiry(`x.${Buffer.from(JSON.stringify({ sid: 'no-exp' }), 'utf8').toString('base64url')}.y`),
    ).toBeNull();
  });

  it('exp 解不出来时不主动重登（靠 401 兜底）', async () => {
    routes.set('GET /api/subscription', (_req, res) => reply(res, 200, { id: 30 }));

    await loginClient({
      auth: {
        mode: 'login',
        username: 'tester',
        password: 'not-a-real-password',
        session: { jwt: 'opaque-jwt', sessionId: 's', expiresAt: null },
      },
    }).subscriptionInfo();

    expect(loginCount).toBe(0);
    expect(hits('/api/subscription')[0]?.headers.authorization).toBe('Bearer opaque-jwt');
  });
});
