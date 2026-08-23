import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/index.js';
import { TokenRepo } from '../../src/db/repo/sharing.js';
import type { Logger } from '../../src/logger.js';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };

function setup() {
  const db = openDatabase(':memory:', logger);
  db.prepare("INSERT INTO profiles (id, name, created_at, updated_at) VALUES ('p', 'p', 1, 1)").run();
  return { db, tokens: new TokenRepo(db) };
}

describe('token quota state', () => {
  it('keeps expiresAt inclusive and distinguishes cumulative exhaustion', () => {
    const { db, tokens } = setup();
    const token = tokens.create({ profileId: 'p', expiresAt: 1000, maxAccess: 1, quotaWindowHours: null });
    expect(tokens.check(token.token, 1000).valid).toBe(true);
    expect(tokens.check(token.token, 1001)).toEqual({ valid: false, reason: 'expired' });
    expect(tokens.tokenState(token, { used: 1, distinctSources: 0, oldest: 0 }, 1000)).toEqual({ state: 'quota', rolling: false, retryAfterMs: null });
    expect(() => tokens.update(token.token, { expiresAt: 0 })).toThrow();
    db.close();
  });

  it('returns a rolling retry duration and rolls over at the window boundary', () => {
    const { db, tokens } = setup();
    const token = tokens.create({ profileId: 'p', maxAccess: 2, quotaWindowHours: 1 });
    expect(tokens.tokenState(token, { used: 2, distinctSources: 0, oldest: 1000 }, 1000 + 60_000)).toEqual({ state: 'quota', rolling: true, retryAfterMs: 3_540_000 });
    expect(tokens.tokenState(token, { used: 1, distinctSources: 0, oldest: 3_500_000 }, 3_600_000)).toEqual({ state: 'valid' });
    db.close();
  });
});
