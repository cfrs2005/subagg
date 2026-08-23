import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/index.js';
import { PingHistoryRepo } from '../src/db/repo/ping-history.js';
import type { Logger } from '../src/logger.js';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };

describe('node ping history', () => {
  it('returns the newest persisted result and an ordered history', () => {
    const db = new Database(':memory:');
    migrate(db, logger);
    const history = new PingHistoryRepo(db);

    history.record({ fingerprint: 'node-a', checkedAt: 1_000, ok: true, latencyMs: 42 });
    history.record({ fingerprint: 'node-a', checkedAt: 2_000, ok: false, latencyMs: null, error: 'timeout' });
    history.record({ fingerprint: 'node-b', checkedAt: 1_500, ok: true, latencyMs: 19 });

    expect(history.latestAll().get('node-a')).toMatchObject({ checkedAt: 2_000, ok: false, latencyMs: null, error: 'timeout' });
    expect(history.history('node-a', 0)).toEqual([
      { fingerprint: 'node-a', checkedAt: 1_000, ok: true, latencyMs: 42 },
      { fingerprint: 'node-a', checkedAt: 2_000, ok: false, latencyMs: null, error: 'timeout' },
    ]);
    expect(history.prune(1_500)).toBe(1);
    expect(history.history('node-a', 0)).toHaveLength(1);
    db.close();
  });
});
