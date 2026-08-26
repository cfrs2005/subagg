/**
 * `/sub/:token` 三层限流的响应契约。
 *
 * 三层（IP / token / 滚动配额）都返回 429，此前**在响应里无法区分**，
 * 日志里也留不下痕迹 —— 于是"客户端说它收到 429"这种报障只能靠猜。
 * 这个文件把区分手段钉死：`X-Subagg-Limit` 的取值、响应体类型、
 * 以及哪些情况**不该**带这个头。
 *
 * 用 `app.inject()` 而不是真的监听端口：不占端口、不发真实网络请求，
 * 也能拿到完整的响应头。scheduler 只构造不 start（它的构造函数不做 IO）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../src/config.js';
import { createContext, type AppContext } from '../../src/context.js';
import type { Logger } from '../../src/logger.js';
import { buildApp } from '../../src/server/app.js';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    adminToken: 'test-admin-token-0123456789',
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

let open: { app: FastifyInstance; ctx: AppContext } | null = null;

async function setup(over: Partial<Config> = {}) {
  const ctx = createContext(makeConfig(over), logger);
  ctx.db
    .prepare("INSERT INTO profiles (id, name, created_at, updated_at) VALUES ('p','p',1,1)")
    .run();
  const app = await buildApp(ctx);
  open = { app, ctx };
  return { app, ctx };
}

afterEach(async () => {
  if (open) {
    await open.app.close();
    open.ctx.db.close();
    open = null;
  }
});

describe('/sub 限流分层', () => {
  it('IP 层：429 带 x-subagg-limit: ip 与 text/plain', async () => {
    const { app, ctx } = await setup({ subRateLimit: 2 });

    // 用**不存在**的 token：它在 token 限流器之前就 404 返回了，
    // 所以只消耗 IP 桶 —— 正好把三层拆开单独测。
    const codes: number[] = [];
    let last;
    for (let i = 0; i < 3; i++) {
      last = await app.inject({ method: 'GET', url: `/sub/nope-${i}` });
      codes.push(last.statusCode);
    }

    expect(codes).toEqual([404, 404, 429]);
    expect(last?.headers['x-subagg-limit']).toBe('ip');
    expect(String(last?.headers['content-type'])).toMatch(/^text\/plain/);
    expect(last?.headers['retry-after']).toBeDefined();
    expect(last?.headers['cache-control']).toBe('no-store');
    // 中文提示要真的送到客户端，而不是被塑形成 JSON
    expect(last?.body).toContain('请求过于频繁');
    expect(ctx.limitStats.snapshot().ip).toBe(1);
  });

  it('token 层：429 带 x-subagg-limit: token，且不暴露桶容量', async () => {
    const { app, ctx } = await setup({ subTokenRateLimit: 2 });
    const t = ctx.tokens.create({ profileId: 'p' });

    const codes: number[] = [];
    let last;
    for (let i = 0; i < 3; i++) {
      last = await app.inject({ method: 'GET', url: `/sub/${t.token}` });
      codes.push(last.statusCode);
    }

    expect(codes).toEqual([200, 200, 429]);
    expect(last?.headers['x-subagg-limit']).toBe('token');
    expect(last?.headers['retry-after']).toBeDefined();
    // 刻意不给 token 层补自己的 x-ratelimit-*：那会把**token 桶**的容量与
    // 剩余次数告诉持链接的人。响应里出现的 x-ratelimit-limit 是 IP 层插件
    // 给每个请求都加的，值恒为 IP 层配置（这里 1000），与 token 层的 2 无关 ——
    // 这条断言正是在守"token 桶容量不外泄"。
    expect(String(last?.headers['x-ratelimit-limit'])).toBe('1000');
    expect(String(last?.headers['x-ratelimit-limit'])).not.toBe('2');
    expect(ctx.limitStats.snapshot().token).toBe(1);
  });

  it('配额层（滚动）：429 带 x-subagg-limit: quota', async () => {
    const { app, ctx } = await setup();
    const t = ctx.tokens.create({ profileId: 'p', maxAccess: 1, quotaWindowHours: 24 });

    const first = await app.inject({ method: 'GET', url: `/sub/${t.token}` });
    const second = await app.inject({ method: 'GET', url: `/sub/${t.token}` });

    expect(first.statusCode).toBe(200);
    expect(first.headers['x-subagg-limit']).toBeUndefined();

    expect(second.statusCode).toBe(429);
    expect(second.headers['x-subagg-limit']).toBe('quota');
    expect(second.headers['retry-after']).toBeDefined();
    expect(second.body).toContain('上限');
    expect(ctx.limitStats.snapshot().quota).toBe(1);
  });

  it('配额层（累计）：耗尽是 404，不带 Retry-After —— 永久状态不能撒谎说稍后重试', async () => {
    const { app, ctx } = await setup();
    const t = ctx.tokens.create({ profileId: 'p', maxAccess: 1, quotaWindowHours: null });

    expect((await app.inject({ method: 'GET', url: `/sub/${t.token}` })).statusCode).toBe(200);
    const second = await app.inject({ method: 'GET', url: `/sub/${t.token}` });

    expect(second.statusCode).toBe(404);
    expect(second.headers['retry-after']).toBeUndefined();
    expect(second.headers['x-subagg-limit']).toBeUndefined();
  });

  it('限流顺序：无效 token 不得挤占真实链接的 token 桶', async () => {
    // sub.ts 里"token 限流必须在 check() 之后"那条注释的唯一有效守卫。
    // 顺序反了的话，随机无效 token 会灌满限流器的 LRU，
    // 把真实分享链接的桶顶掉。
    const { app, ctx } = await setup({ subTokenRateLimit: 2 });
    const t = ctx.tokens.create({ profileId: 'p' });

    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'GET', url: `/sub/bogus-${i}` });
    }

    expect((await app.inject({ method: 'GET', url: `/sub/${t.token}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/sub/${t.token}` })).statusCode).toBe(200);
  });

  it('正常 200 不带任何限流头', async () => {
    const { app, ctx } = await setup();
    const t = ctx.tokens.create({ profileId: 'p' });

    const res = await app.inject({ method: 'GET', url: `/sub/${t.token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-subagg-limit']).toBeUndefined();
    expect(res.headers['retry-after']).toBeUndefined();
    expect(ctx.limitStats.snapshot()).toMatchObject({ ip: 0, token: 0, quota: 0 });
  });
});
