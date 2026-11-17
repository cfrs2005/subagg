import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../src/config.js';
import { createContext, type AppContext } from '../src/context.js';
import { MANUAL_NODE_SOURCE_ID } from '../src/db/repo/subscriptions.js';
import type { Logger } from '../src/logger.js';
import { buildApp } from '../src/server/app.js';
import { makeNode } from './helpers.js';

const ADMIN_TOKEN = 'test-admin-token-0123456789';
const AUTH = { authorization: `Bearer ${ADMIN_TOKEN}` };
const UUID = '11111111-1111-4111-8111-111111111111';
const URI = `vless://${UUID}@manual.example.com:443?encryption=none&security=tls&type=tcp#URI%20Name`;

interface LogRecord {
  msg: string;
  fields?: Record<string, unknown>;
}

let logs: LogRecord[] = [];
const logger: Logger = {
  debug(msg, fields) { logs.push({ msg, fields }); },
  info(msg, fields) { logs.push({ msg, fields }); },
  warn(msg, fields) { logs.push({ msg, fields }); },
  error(msg, fields) { logs.push({ msg, fields }); },
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
    ixSyncIntervalMinutes: 0,
    ixTimeoutMs: 15_000,
    ixOrphanThreshold: 5,
    subRateLimit: 1000,
    subTokenRateLimit: 1000,
    shareSourceAlert: 0,
    accessLogRetentionDays: 0,
    logLevel: 'info',
  } as Config;
}

let open: { app: FastifyInstance; ctx: AppContext } | null = null;

async function setup(): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const ctx = createContext(makeConfig(), logger);
  const app = await buildApp(ctx);
  open = { app, ctx };
  return open;
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

describe('manual nodes', () => {
  it('adds one node through the normal parse and catalog pipeline without exposing credentials', async () => {
    const { app, ctx } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: AUTH,
      payload: { name: 'My Manual Node', uri: URI },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: 'My Manual Node',
      type: 'vless',
      server: 'manual.example.com',
      port: 443,
      sourceId: MANUAL_NODE_SOURCE_ID,
      sourceName: '手动添加',
      manual: true,
    });
    expect(created.body).not.toContain(UUID);

    const source = ctx.subscriptions.get(MANUAL_NODE_SOURCE_ID);
    expect(source).toMatchObject({ enabled: false, nodeCount: 1, url: 'manual://local' });

    const list = await app.inject({ method: 'GET', url: '/api/nodes', headers: AUTH });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({ name: 'My Manual Node', manual: true });
    expect(list.body).not.toContain(UUID);

    const fingerprint = created.json().fingerprint as string;
    const exported = await app.inject({
      method: 'GET',
      url: `/api/nodes/${fingerprint}/uri`,
      headers: AUTH,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['cache-control']).toBe('no-store');
    expect(exported.json().uri).toContain(UUID);
    expect(JSON.stringify(logs)).not.toContain(UUID);
  });

  it('keeps manual nodes out of remote subscription state and survives sync-all', async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: AUTH,
      payload: { uri: URI },
    });
    expect(created.statusCode).toBe(201);

    const state = await app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    expect(state.json().subscriptions).toEqual([]);
    expect(state.json().totals).toMatchObject({ subscriptions: 0, nodes: 1 });

    const synced = await app.inject({ method: 'POST', url: '/api/sync', headers: AUTH });
    expect(synced.statusCode).toBe(200);
    expect(synced.json()).toMatchObject({
      results: [],
      summary: { total: 0, succeeded: 0, failed: 0 },
    });

    const nodes = await app.inject({ method: 'GET', url: '/api/nodes', headers: AUTH });
    expect(nodes.json()).toHaveLength(1);
    expect(nodes.json()[0].fingerprint).toBe(created.json().fingerprint);
  });

  it('rejects invalid or duplicate input and does not create a local source on parse failure', async () => {
    const { app, ctx } = await setup();
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: AUTH,
      payload: { uri: 'not-a-node' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toContain('不是有效的 URI');
    expect(ctx.subscriptions.get(MANUAL_NODE_SOURCE_ID)).toBeUndefined();

    const multi = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: AUTH,
      payload: { uri: `${URI}\n${URI}` },
    });
    expect(multi.statusCode).toBe(400);

    const first = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: AUTH,
      payload: { name: 'First Name', uri: URI },
    });
    expect(first.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: AUTH,
      payload: { name: 'Different Name', uri: URI },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: '这个手动节点已经存在' });
    expect(ctx.nodes.listAll()).toHaveLength(1);
  });

  it('deletes only the manual copy of a fingerprint', async () => {
    const { app, ctx } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: AUTH,
      payload: { uri: URI },
    });
    const fingerprint = created.json().fingerprint as string;

    const remote = ctx.subscriptions.create({ name: 'Remote', url: 'https://sub.example.com/list' });
    ctx.nodes.replaceForSubscription(remote.id, [
      makeNode(
        {
          type: 'vless',
          name: 'Remote Copy',
          server: 'manual.example.com',
          port: 443,
          uuid: UUID,
          encryption: 'none',
          transport: { network: 'tcp' },
          tls: { enabled: true, sni: 'manual.example.com' },
        },
        { sourceId: remote.id, sourceName: remote.name },
      ),
    ]);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/nodes/${fingerprint}`,
      headers: AUTH,
    });
    expect(deleted.statusCode).toBe(204);
    expect(ctx.subscriptions.get(MANUAL_NODE_SOURCE_ID)?.nodeCount).toBe(0);
    expect(ctx.nodes.listAll()).toHaveLength(1);
    expect(ctx.nodes.listAll()[0]?.meta.sourceId).toBe(remote.id);

    const again = await app.inject({
      method: 'DELETE',
      url: `/api/nodes/${fingerprint}`,
      headers: AUTH,
    });
    expect(again.statusCode).toBe(404);
  });

  it('requires admin authentication for manual node mutation', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { uri: URI },
    });
    expect(response.statusCode).toBe(401);
  });
});
