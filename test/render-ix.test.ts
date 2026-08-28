import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, type Db } from '../src/db/index.js';
import { IxMappingRepo, IxProviderRepo, type IxProvider } from '../src/db/repo/ix.js';
import { NodeRepo } from '../src/db/repo/nodes.js';
import { TrafficRepo } from '../src/db/repo/subscriptions.js';
import type { Profile } from '../src/db/repo/profiles.js';
import type { ProxyNode } from '../src/core/types.js';
import { deriveKey, encryptSecret } from '../src/core/secret.js';
import type { Config } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { IxService } from '../src/services/ix.js';
import { NodeCatalog } from '../src/services/node-catalog.js';
import { renderProfile } from '../src/services/render.js';
import { createContext } from '../src/context.js';
import { buildApp } from '../src/server/app.js';
import { makeNode } from './helpers.js';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };
const ADMIN_TOKEN = 'test-admin-token-0123456789';
const KEY = deriveKey(ADMIN_TOKEN);
const ENTRY_HOST = 'entry.relay.example';

function makeConfig(over: Partial<Config> = {}): Config {
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
    logLevel: 'info',
    ...over,
  } as Config;
}

function originNode(): ProxyNode {
  return makeNode({
    type: 'trojan',
    name: 'bwg-ssr',
    server: 'landing.example',
    port: 443,
    password: 'pw',
    tls: { enabled: true },
    transport: { network: 'ws', ws: { path: '/ray' } },
  });
}

function profile(pick: string[]): Profile {
  return {
    id: 'p',
    name: 'IX only',
    description: '',
    icon: '📦',
    rule: { pick, pickMode: 'only', useDefaultExclude: false },
    defaultTarget: 'clash.meta',
    userinfoMode: 'off',
    updateInterval: 12,
    createdAt: 1,
    updatedAt: 1,
  };
}

let db: Db;
let nodes: NodeRepo;
let mappings: IxMappingRepo;
let provider: IxProvider;
let ix: IxService;
let catalog: NodeCatalog;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, logger);
  db.prepare("INSERT INTO subscriptions (id, name, url, created_at) VALUES ('s1', '测试源', 'https://sub.test/x', 1)").run();
  nodes = new NodeRepo(db);
  mappings = new IxMappingRepo(db);
  const providers = new IxProviderRepo(db);
  provider = providers.create({
    name: 'IX A',
    baseUrl: 'https://relay.test/api',
    username: 'relay-user',
    passwordEnc: encryptSecret('secret-password', KEY),
  });
  ix = new IxService({
    config: makeConfig(),
    logger,
    providers,
    mappings,
    nodes,
    secretKey: KEY,
    createClient: () => {
      throw new Error('catalog read path must not create an outbound client');
    },
  });
  catalog = new NodeCatalog(nodes, ix);
});

afterEach(() => db.close());

function seedActiveRelay(): { origin: ProxyNode; relayFingerprint: string } {
  const origin = originNode();
  nodes.replaceForSubscription('s1', [origin], 10);
  mappings.upsert({
    providerId: provider.id,
    fingerprint: origin.fingerprint,
    targetHost: origin.server,
    targetPort: origin.port,
    remotePortId: 230,
    entryHost: ENTRY_HOST,
    entryPort: 52_001,
    state: 'active',
  }, 11);
  const relay = ix.relayViews()[0];
  if (!relay) throw new Error('relay fixture missing');
  return { origin, relayFingerprint: relay.fingerprint };
}

describe('IX relay catalog and profile rendering', () => {
  it('原节点与 IX 节点并存，profile 直接选择 IX 指纹且不输出原地址', () => {
    const { origin, relayFingerprint } = seedActiveRelay();
    const entries = catalog.list();
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.name)).toEqual(['bwg-ssr', 'IX_bwg-ssr']);
    expect(entries[1]).toMatchObject({
      kind: 'ix-relay',
      usable: true,
      server: ENTRY_HOST,
      port: 52_001,
      originFingerprint: origin.fingerprint,
      relayState: 'active',
    });

    const rendered = renderProfile({ catalog, traffic: new TrafficRepo(db) }, profile([relayFingerprint]));
    expect(rendered.nodeCount).toBe(1);
    expect(rendered.nodes[0]).toMatchObject({ fingerprint: relayFingerprint, server: ENTRY_HOST, port: 52_001 });
    expect(rendered.nodes[0]?.server).not.toBe(origin.server);
    expect(rendered.body).toContain(`server: ${ENTRY_HOST}`);
    expect(rendered.body).toContain(`sni: ${origin.server}`);
  });

  it('入口批量更新后地址刷新但 IX 指纹保持稳定', () => {
    const { origin, relayFingerprint } = seedActiveRelay();
    mappings.update(provider.id, origin.fingerprint, { entryHost: 'new-entry.example', entryPort: 53_001 }, 20);
    const relay = ix.relayViews()[0];
    expect(relay).toMatchObject({ fingerprint: relayFingerprint, server: 'new-entry.example', port: 53_001 });
  });

  it('不可用 IX 节点保留在目录，但不进入订阅且不回退原节点', () => {
    const { origin, relayFingerprint } = seedActiveRelay();
    mappings.update(provider.id, origin.fingerprint, { suspended: true }, 20);
    const relay = catalog.get(relayFingerprint);
    expect(relay).toMatchObject({ kind: 'ix-relay', usable: false, relayState: 'unavailable' });

    const rendered = renderProfile({ catalog, traffic: new TrafficRepo(db) }, profile([relayFingerprint]));
    expect(rendered.nodeCount).toBe(0);
    expect(rendered.nodes).toEqual([]);
    expect(rendered.warnings.join(' ')).toContain('未输出');
  });
});

describe('admin node API resolves IX relay fingerprints', () => {
  it('节点列表显示双行，IX URI 使用入口地址', async () => {
    const ctx = createContext(makeConfig(), logger);
    try {
      ctx.db.prepare("INSERT INTO subscriptions (id, name, url, created_at) VALUES ('s1', '测试源', 'https://sub.test/x', 1)").run();
      const origin = originNode();
      ctx.nodes.replaceForSubscription('s1', [origin], 10);
      const provider = ctx.ixProviders.create({
        name: 'IX A',
        baseUrl: 'https://relay.test/api',
        username: 'relay-user',
        passwordEnc: encryptSecret('secret-password', KEY),
      });
      ctx.ixMappings.upsert({
        providerId: provider.id,
        fingerprint: origin.fingerprint,
        targetHost: origin.server,
        targetPort: origin.port,
        remotePortId: 230,
        entryHost: ENTRY_HOST,
        entryPort: 52_001,
        state: 'active',
      }, 11);
      const relayFingerprint = ctx.ix.relayViews()[0]!.fingerprint;
      ctx.nodePing.pingNode = async (node) => ({
        fingerprint: node.fingerprint,
        checkedAt: 30,
        ok: true,
        latencyMs: 12,
        name: node.name,
        host: node.server,
        port: node.port,
      });
      const app = await buildApp(ctx);
      const headers = { authorization: `Bearer ${ADMIN_TOKEN}` };
      const list = await app.inject({ method: 'GET', url: '/api/nodes', headers });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'bwg-ssr', kind: 'source' }),
        expect.objectContaining({ name: 'IX_bwg-ssr', kind: 'ix-relay', originFingerprint: origin.fingerprint }),
      ]));
      const uri = await app.inject({ method: 'GET', url: `/api/nodes/${relayFingerprint}/uri`, headers });
      expect(uri.statusCode).toBe(200);
      expect(uri.json().uri).toContain(`${ENTRY_HOST}:52001`);
      const qr = await app.inject({ method: 'GET', url: `/api/nodes/${relayFingerprint}/qrcode`, headers });
      expect(qr.statusCode).toBe(200);
      const ping = await app.inject({ method: 'GET', url: `/api/nodes/${relayFingerprint}/ping`, headers });
      expect(ping.statusCode).toBe(200);
      expect(ping.json()).toMatchObject({ fingerprint: relayFingerprint, host: ENTRY_HOST, port: 52_001 });
      const history = await app.inject({
        method: 'GET',
        url: `/api/nodes/${relayFingerprint}/ping/history`,
        headers,
      });
      expect(history.statusCode).toBe(200);
      expect(history.json().fingerprint).toBe(relayFingerprint);
      ctx.ixMappings.update(provider.id, origin.fingerprint, { suspended: true }, 20);
      const unavailable = await app.inject({
        method: 'GET',
        url: `/api/nodes/${relayFingerprint}/uri`,
        headers,
      });
      expect(unavailable.statusCode).toBe(409);
      expect(unavailable.json().error).toContain('挂起');
      await app.close();
    } finally {
      ctx.db.close();
    }
  });
});
