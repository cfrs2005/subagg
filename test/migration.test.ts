import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import type { Logger } from '../src/logger.js';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };

describe('database migrations', () => {
  it('upgrades a v1 database without changing existing rows', () => {
    const db = new Database(':memory:');
    migrate(db, logger, [MIGRATIONS[0]!]);
    db.prepare("INSERT INTO profiles (id, name, created_at, updated_at) VALUES ('p', 'p', 1, 1)").run();
    db.prepare("INSERT INTO tokens (token, profile_id, created_at) VALUES ('legacy', 'p', 1)").run();
    const before = db.prepare('SELECT COUNT(*) AS n FROM tokens').get() as { n: number };
    migrate(db, logger, MIGRATIONS);
    const columns = db.prepare('PRAGMA table_info(tokens)').all() as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['max_access', 'quota_window_hours', 'source_limit']));
    expect((db.prepare('SELECT COUNT(*) AS n FROM tokens').get() as { n: number }).n).toBe(before.n);
    expect(db.prepare('SELECT max_access, quota_window_hours, source_limit FROM tokens WHERE token = ?').get('legacy')).toEqual({ max_access: null, quota_window_hours: null, source_limit: null });
    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(3);
    const pingTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'node_ping_history'").get();
    expect(pingTable).toBeTruthy();
    migrate(db, logger, MIGRATIONS);
    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(3);
    db.close();
  });
});
