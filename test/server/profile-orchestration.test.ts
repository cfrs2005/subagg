/**
 * 配置文件编排的全链路：管理 API 写入 → 订阅端点按 UA 输出。
 *
 * 这里守两件在单元测试里看不出来的事：
 *
 * 1. **UA 分流不会被编排破坏。** 同一条 token，Clash.Meta 拿到 YAML，
 *    Shadowrocket 仍然拿到 base64 URI 列表 —— 编排只属于 Clash 侧。
 * 2. **NULL 与\"没有编排\"是同义的。** PATCH 成 null 之后必须回到内置模板，
 *    而不是残留上一次的编排。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parse as parseYaml } from 'yaml';
import type { Config } from '../../src/config.js';
import { createContext, type AppContext } from '../../src/context.js';
import type { Logger } from '../../src/logger.js';
import { buildApp } from '../../src/server/app.js';
import { makeNode } from '../helpers.js';

const ADMIN_TOKEN = 'test-admin-token-0123456789';
const AUTH = { authorization: `Bearer ${ADMIN_TOKEN}` };

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => logger,
};

function makeConfig(): Config {
  return {
    appEnv: 'test',
    allowDevLogin: true,
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
    ixSyncIntervalMinutes: 5,
    ixTimeoutMs: 15_000,
    ixOrphanThreshold: 5,
    subRateLimit: 1000,
    subTokenRateLimit: 1000,
    shareSourceAlert: 0,
    accessLogRetentionDays: 0,
    logLevel: 'error',
  } as Config;
}

let open: { app: FastifyInstance; ctx: AppContext } | null = null;

async function setup(): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const ctx = createContext(makeConfig(), logger);
  ctx.db
    .prepare(
      "INSERT INTO subscriptions (id, name, url, created_at) VALUES ('s1', '测试源', 'https://sub.test/x', 1)",
    )
    .run();
  ctx.nodes.replaceForSubscription('s1', [
    makeNode({
      type: 'ss',
      name: 'DMIT-VIA-US-LOS-CG',
      server: 'dmit.example.com',
      port: 443,
      cipher: 'aes-128-gcm',
      password: 'pw',
    }),
    makeNode({
      type: 'trojan',
      name: 'GANBEI-VIA-TXSH',
      server: 'gb.example.com',
      port: 443,
      password: 'pw',
      transport: { network: 'tcp' },
      tls: { enabled: true, sni: 'gb.example.com' },
    }),
  ]);
  const app = await buildApp(ctx);
  open = { app, ctx };
  return { app, ctx };
}

beforeEach(() => {
  open = null;
});

afterEach(async () => {
  if (open) {
    await open.app.close();
    open.ctx.db.close();
    open = null;
  }
});

const ORCHESTRATION = {
  groups: [
    {
      name: 'AI-OPENAI',
      type: 'select',
      members: [{ kind: 'nodes', select: { nameRegex: 'GANBEI' } }],
    },
    {
      name: 'PROXY',
      type: 'select',
      members: [{ kind: 'nodes', select: {} }],
    },
  ],
  providers: {
    openai: {
      url: 'https://raw.githubusercontent.com/cfrs2005/mantaray/main/rules/openai.list',
      behavior: 'classical',
    },
  },
  rules: [
    { type: 'DOMAIN-SUFFIX', value: 'gs-robot.com', policy: 'DIRECT' },
    { type: 'RULE-SET', value: 'openai', policy: 'AI-OPENAI' },
    { type: 'MATCH', policy: 'PROXY' },
  ],
  dns: {
    nameserver: ['https://doh.pub/dns-query'],
    nameserverPolicy: { '+.gs-robot.com': 'https://doh.pub/dns-query' },
  },
  hosts: { 'doh.pub': '1.12.12.12' },
  ipv6: false,
};

async function createProfile(app: FastifyInstance): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: AUTH,
    payload: {
      name: '编排测试',
      rule: { useDefaultExclude: false },
      orchestration: ORCHESTRATION,
      defaultTarget: 'shadowrocket',
    },
  });
  expect(created.statusCode).toBe(201);
  return (created.json() as { id: string }).id;
}

async function createToken(app: FastifyInstance, profileId: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: AUTH,
    payload: { profileId },
  });
  expect(created.statusCode).toBe(201);
  return (created.json() as { token: string }).token;
}

describe('配置文件编排端到端', () => {
  it('Clash.Meta 拿到编排，Shadowrocket 仍拿到节点列表', async () => {
    const { app } = await setup();
    const profileId = await createProfile(app);
    const token = await createToken(app, profileId);

    const clash = await app.inject({
      method: 'GET',
      url: `/sub/${token}`,
      headers: { 'user-agent': 'clash-verge/v2.2.0' },
    });
    expect(clash.statusCode).toBe(200);

    const config = parseYaml(clash.body) as Record<string, unknown>;
    expect(config['proxy-groups']).toEqual([
      { name: 'AI-OPENAI', type: 'select', proxies: ['GANBEI-VIA-TXSH'] },
      {
        name: 'PROXY',
        type: 'select',
        proxies: ['DMIT-VIA-US-LOS-CG', 'GANBEI-VIA-TXSH'],
      },
    ]);
    expect(config['rules']).toEqual([
      'DOMAIN-SUFFIX,gs-robot.com,DIRECT',
      'RULE-SET,openai,AI-OPENAI',
      'MATCH,PROXY',
    ]);
    expect(config['rule-providers']).toMatchObject({
      openai: { type: 'http', behavior: 'classical' },
    });
    expect(config['dns']).toMatchObject({
      enable: true,
      'nameserver-policy': { '+.gs-robot.com': 'https://doh.pub/dns-query' },
    });
    expect(config['hosts']).toEqual({ 'doh.pub': '1.12.12.12' });
    expect(config['ipv6']).toBe(false);

    const shadowrocket = await app.inject({
      method: 'GET',
      url: `/sub/${token}`,
      headers: { 'user-agent': 'Shadowrocket/2.2.20 (iPhone; iOS 18.0)' },
    });
    expect(shadowrocket.statusCode).toBe(200);
    const decoded = Buffer.from(shadowrocket.body, 'base64').toString('utf8');
    expect(decoded).toContain('DMIT-VIA-US-LOS-CG');
    expect(decoded).toContain('GANBEI-VIA-TXSH');
    // 编排是 Clash 专属，绝不能出现在 URI 列表里。
    expect(decoded).not.toContain('MATCH');
  });

  it('PATCH orchestration=null 回到内置模板', async () => {
    const { app } = await setup();
    const profileId = await createProfile(app);
    const token = await createToken(app, profileId);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/profiles/${profileId}`,
      headers: AUTH,
      payload: { orchestration: null },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { orchestration: unknown }).orchestration).toBeNull();

    const clash = await app.inject({
      method: 'GET',
      url: `/sub/${token}`,
      headers: { 'user-agent': 'clash-verge/v2.2.0' },
    });
    const config = parseYaml(clash.body) as Record<string, unknown>;
    const groups = JSON.stringify(config['proxy-groups']);
    expect(groups).toContain('节点选择');
    expect(groups).not.toContain('AI-OPENAI');
  });

  it('导入接口把 Shadowrocket 配置解析成编排', async () => {
    const { app } = await setup();

    const parsed = await app.inject({
      method: 'POST',
      url: '/api/orchestration/parse',
      headers: AUTH,
      payload: {
        text: [
          '[Proxy Group]',
          'PROXY = select,DMIT-VIA-US-LOS-CG,GANBEI-VIA-TXSH',
          '[Rule]',
          'DOMAIN-SUFFIX,gs-robot.com,DIRECT',
          'FINAL,PROXY',
        ].join('\n'),
      },
    });

    expect(parsed.statusCode).toBe(200);
    const result = parsed.json() as {
      orchestration: { groups: unknown[]; rules: unknown[] };
      warnings: string[];
    };
    expect(result.orchestration.groups).toHaveLength(1);
    expect(result.orchestration.rules.at(-1)).toMatchObject({ type: 'MATCH', policy: 'PROXY' });
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});
