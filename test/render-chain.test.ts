import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, type Db } from '../src/db/index.js';
import type { Profile } from '../src/db/repo/profiles.js';
import { TrafficRepo } from '../src/db/repo/subscriptions.js';
import type { ProxyNode } from '../src/core/types.js';
import type { Logger } from '../src/logger.js';
import { renderProfile } from '../src/services/render.js';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };

function node(fingerprint: string, name: string, server: string): ProxyNode {
  return {
    type: 'ss', fingerprint, name, server, port: 443, cipher: 'aes-128-gcm', password: 'secret',
    meta: { sourceId: 's', sourceName: 'source', tags: [], region: 'US' },
  };
}

describe('profile rendering with independent chain roles', () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, logger);
  });

  afterEach(() => db.close());

  it('keeps three direct picks and adds two-by-three chain pairs', () => {
    const direct = [
      node('d1', 'Direct 1', 'direct1.example'),
      node('d2', 'Direct 2', 'direct2.example'),
      node('d3', 'Direct 3', 'direct3.example'),
    ];
    const entries = [
      node('e1', 'Entry 1', 'entry1.example'),
      node('e2', 'Entry 2', 'entry2.example'),
    ];
    const landings = [
      node('l1', 'Landing 1', 'landing1.example'),
      node('l2', 'Landing 2', 'landing2.example'),
      node('l3', 'Landing 3', 'landing3.example'),
    ];
    const all = [...direct, ...entries, ...landings];
    const profile: Profile = {
      id: 'p',
      name: 'chain',
      description: '',
      icon: 'C',
      rule: {
        pick: direct.map((item) => item.fingerprint),
        pickMode: 'only',
        chain: {
          enabled: true,
          entry: { pick: entries.map((item) => item.fingerprint) },
          landing: { pick: landings.map((item) => item.fingerprint) },
        },
      },
      defaultTarget: 'shadowrocket',
      userinfoMode: 'off',
      updateInterval: 12,
      createdAt: 1,
      updatedAt: 1,
    };

    const rendered = renderProfile({
      catalog: { listAll: () => all },
      traffic: new TrafficRepo(db),
    }, profile, { base64: false });

    expect(rendered.filterStats.output).toBe(3);
    expect(rendered.chain).toMatchObject({ entryCount: 2, landingCount: 3, pairCount: 6 });
    expect(rendered.nodeCount).toBe(11);
    expect(rendered.nodes.filter((item) => item.chain)).toHaveLength(6);
    expect(rendered.warnings).toEqual([]);
  });
});
