import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Config } from '../src/config.js';
import type { StoredNode, NodeRepo } from '../src/db/repo/nodes.js';
import { PingHistoryRepo } from '../src/db/repo/ping-history.js';
import { migrate } from '../src/db/index.js';
import type { Logger } from '../src/logger.js';
import { NodePingService } from '../src/services/node-ping.js';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };
let server: net.Server;
let port: number;

beforeAll(async () => {
  server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe('automatic node ping service', () => {
  it('persists one result per interval and skips an early repeat', async () => {
    const db = new Database(':memory:');
    migrate(db, logger);
    const history = new PingHistoryRepo(db);
    const node: StoredNode = {
      fingerprint: 'ping-service-node', name: 'Ping service node', type: 'ss', server: '127.0.0.1', port,
      cipher: 'aes-128-gcm', password: 'test', meta: { sourceId: 'test', sourceName: 'test', tags: [] },
      firstSeen: 1, lastSeen: 1,
    };
    const nodes = { listAll: () => [node] } as unknown as NodeRepo;
    const service = new NodePingService({ config: { nodePingIntervalHours: 12 } as Config, logger, nodes, history });

    const first = await service.pingDue(Date.now());
    expect(first).toEqual({ total: 1, online: 1, offline: 0 });
    expect((await service.pingDue(Date.now())).total).toBe(0);
    expect((await service.pingDue(Date.now() + 12 * 3600_000)).total).toBe(1);
    expect(history.history(node.fingerprint, 0)).toHaveLength(2);
    db.close();
  });
});
