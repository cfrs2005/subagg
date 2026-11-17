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
    // 节点不再内联：配置里只有节点源地址，成员由客户端 filter 求值。
    expect(config['proxies']).toBeUndefined();
    expect(config['proxy-providers']).toMatchObject({
      subagg: {
        type: 'http',
        url: `http://127.0.0.1:8787/sub/${token}?target=clash.provider`,
        path: './providers/subagg.yaml',
      },
    });
    expect(config['proxy-groups']).toEqual([
      { name: 'AI-OPENAI', type: 'select', use: ['subagg'], filter: '(?i:GANBEI)' },
      // 无名字约束的选择器 = 全部节点，所以只有 use，没有 filter。
      { name: 'PROXY', type: 'select', use: ['subagg'] },
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

  it('PATCH orchestration=null 后跟随全局默认（无自定义时 = iOS 迁移预设）', async () => {
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
    // 没有自定义全局默认时，站点所有者的长期策略（iOS 迁移预设）就是默认分流。
    expect(groups).toContain('GOOGLE');
    expect(groups).toContain('AI-OPENAI');
    expect(groups).not.toContain('节点选择');
  });

  it('?style=inline 退回自包含配置（逃生舱）', async () => {
    const { app } = await setup();
    const profileId = await createProfile(app);
    const token = await createToken(app, profileId);

    const clash = await app.inject({
      method: 'GET',
      url: `/sub/${token}?style=inline`,
      headers: { 'user-agent': 'clash-verge/v2.2.0' },
    });

    const config = parseYaml(clash.body) as Record<string, unknown>;
    expect(config['proxy-providers']).toBeUndefined();
    expect(Array.isArray(config['proxies'])).toBe(true);
    expect(config['proxy-groups']).toEqual([
      { name: 'AI-OPENAI', type: 'select', proxies: ['GANBEI-VIA-TXSH'] },
      {
        name: 'PROXY',
        type: 'select',
        proxies: ['DMIT-VIA-US-LOS-CG', 'GANBEI-VIA-TXSH'],
      },
    ]);
  });

  it('节点源端点只输出 proxies，且与订阅用同一套过滤', async () => {
    const { app } = await setup();
    const profileId = await createProfile(app);
    const token = await createToken(app, profileId);

    const provider = await app.inject({
      method: 'GET',
      url: `/sub/${token}?target=clash.provider`,
    });
    expect(provider.statusCode).toBe(200);

    const body = parseYaml(provider.body) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['proxies']);
    expect((body['proxies'] as Array<{ name: string }>).map((p) => p.name)).toEqual([
      'DMIT-VIA-US-LOS-CG',
      'GANBEI-VIA-TXSH',
    ]);
  });

  it('告警里出现非 BMP 字符（emoji）时响应头不会把订阅打成 500', async () => {
    const { app } = await setup();

    // 规则指向具体节点 → 节点源模式下会生成「🔒 节点名」分组并产生告警。
    // 逐字符百分号编码会把代理对劈成两半，encodeURIComponent 抛 URI malformed，
    // 整个订阅变 500 —— 一个诊断头把主功能搞挂。
    const created = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: AUTH,
      payload: {
        name: 'emoji 告警',
        rule: { useDefaultExclude: false },
        orchestration: {
          groups: [{ name: 'PROXY', type: 'select', members: [{ kind: 'nodes', select: {} }] }],
          rules: [
            { type: 'DOMAIN-SUFFIX', value: 'drleao.cn', policy: 'DMIT-VIA-US-LOS-CG' },
            { type: 'MATCH', policy: 'PROXY' },
          ],
        },
      },
    });
    const token = await createToken(app, (created.json() as { id: string }).id);

    const clash = await app.inject({
      method: 'GET',
      url: `/sub/${token}`,
      headers: { 'user-agent': 'clash-verge/v2.2.0' },
    });

    expect(clash.statusCode).toBe(200);
    expect(clash.headers['x-subagg-warning']).toContain('%F0%9F%94%92');
  });  it('全局默认编排：设置后对所有未单独编排的 profile 生效，且 profile 优先', async () => {
    const { app } = await setup();
    const profileId = await createProfile(app);
    const token = await createToken(app, profileId);

    // 1. 写入一个极简全局默认。
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/settings/default-orchestration',
      headers: AUTH,
      payload: {
        orchestration: {
          groups: [
            {
              name: 'GLOBAL-DEFAULT',
              type: 'select',
              members: [{ kind: 'nodes', select: { nameRegex: 'GANBEI' } }],
            },
          ],
          rules: [{ type: 'MATCH', policy: 'GLOBAL-DEFAULT' }],
        },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect((saved.json() as { source: string }).source).toBe('custom');

    // 2. profile 没有自己的编排 → 用全局默认。
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/profiles/${profileId}`,
      headers: AUTH,
      payload: { orchestration: null },
    });
    expect(cleared.statusCode).toBe(200);

    const clash = await app.inject({
      method: 'GET',
      url: `/sub/${token}`,
      headers: { 'user-agent': 'clash-verge/v2.2.0' },
    });
    const config = parseYaml(clash.body) as Record<string, unknown>;
    expect(config['rules']).toEqual(['MATCH,GLOBAL-DEFAULT']);
    expect(JSON.stringify(config['proxy-groups'])).toContain('GLOBAL-DEFAULT');

    // 3. profile 自己的编排仍然优先于全局默认。
    const overridden = await app.inject({
      method: 'PATCH',
      url: `/api/profiles/${profileId}`,
      headers: AUTH,
      payload: { orchestration: ORCHESTRATION },
    });
    expect(overridden.statusCode).toBe(200);

    const clashAgain = await app.inject({
      method: 'GET',
      url: `/sub/${token}`,
      headers: { 'user-agent': 'clash-verge/v2.2.0' },
    });
    const configAgain = parseYaml(clashAgain.body) as Record<string, unknown>;
    expect(configAgain['rules']).toContain('MATCH,PROXY');
    expect(JSON.stringify(configAgain['proxy-groups'])).not.toContain('GLOBAL-DEFAULT');

    // 4. 清除全局默认 = 回到内置预设。
    const reset = await app.inject({
      method: 'PUT',
      url: '/api/settings/default-orchestration',
      headers: AUTH,
      payload: { orchestration: null },
    });
    expect((reset.json() as { source: string }).source).toBe('preset');
  });

  it('?target=shadowrocket.conf 输出完整远程配置，节点订阅不受影响', async () => {
    const { app } = await setup();
    const profileId = await createProfile(app);
    const token = await createToken(app, profileId);

    const conf = await app.inject({
      method: 'GET',
      url: `/sub/${token}?target=shadowrocket.conf`,
    });
    expect(conf.statusCode).toBe(200);
    expect(String(conf.headers['content-type'])).toMatch(/^text\/plain/);

    // 分组引用真实节点名；FINAL 由 MATCH 翻译而来；update-url 指回本配置。
    expect(conf.body).toContain('[Proxy Group]');
    expect(conf.body).toContain('AI-OPENAI = select');
    expect(conf.body).toContain('GANBEI-VIA-TXSH');
    expect(conf.body).toContain('DOMAIN-SUFFIX,gs-robot.com,DIRECT');
    // FINAL 是 [Rule] 段的最后一条；其后只允许跟 [Host] 段。
    expect(conf.body).toContain('FINAL,PROXY');
    expect(conf.body.indexOf('GEOIP')).toBe(-1);
    expect(conf.body).toContain(
      `update-url = http://127.0.0.1:8787/sub/${token}?target=shadowrocket.conf`,
    );
    // RULE-SET 必须回填规则集原始 URL，而不是 Clash 的 provider key。
    expect(conf.body).toContain('RULE-SET,https://');

    // 同一条 token 的节点订阅行为不变。
    const sr = await app.inject({
      method: 'GET',
      url: `/sub/${token}`,
      headers: { 'user-agent': 'Shadowrocket/2.2.20 (iPhone; iOS 18.0)' },
    });
    expect(sr.statusCode).toBe(200);
    const decoded = Buffer.from(sr.body, 'base64').toString('utf8');
    expect(decoded).toContain('DMIT-VIA-US-LOS-CG');
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

describe('规则集转换端点', () => {
  it('订阅端点把 rule-providers 指向本站，且用 token 取回转换结果', async () => {
    const { app, ctx } = await setup();
    const profileId = await createProfile(app);
    const token = await createToken(app, profileId);

    // 不打网络：转换本身由 rule-set 单测覆盖，这里只验路由与鉴权。
    ctx.ruleCache.get = async () => ({ body: 'DOMAIN-SUFFIX,openai.com\n', stale: false, count: 1 });

    const clash = await app.inject({
      method: 'GET',
      url: `/sub/${token}`,
      headers: { 'user-agent': 'clash-verge/v2.2.0' },
    });
    const config = parseYaml(clash.body) as Record<string, unknown>;
    expect(config['rule-providers']).toMatchObject({
      openai: { url: `http://127.0.0.1:8787/r/${token}/openai` },
    });

    const rule = await app.inject({ method: 'GET', url: `/r/${token}/openai` });
    expect(rule.statusCode).toBe(200);
    expect(rule.body).toContain('DOMAIN-SUFFIX,openai.com');
    expect(rule.headers['x-subagg-rule-count']).toBe('1');
  });

  it('未声明的 key 与无效 token 都返回 404（不做开放代理）', async () => {
    const { app } = await setup();
    const profileId = await createProfile(app);
    const token = await createToken(app, profileId);

    const unknown = await app.inject({ method: 'GET', url: `/r/${token}/not-declared` });
    expect(unknown.statusCode).toBe(404);

    const badToken = await app.inject({ method: 'GET', url: '/r/nope/openai' });
    expect(badToken.statusCode).toBe(404);
  });
});
