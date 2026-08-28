import { describe, expect, it } from 'vitest';
import { expandChain } from '../src/core/chain.js';
import { emit } from '../src/core/emit/index.js';
import type { ProxyNode } from '../src/core/types.js';

function node(fingerprint: string, name: string, server: string): ProxyNode {
  return {
    type: 'ss', fingerprint, name, server, port: 443, cipher: 'aes-128-gcm', password: 'secret',
    meta: { sourceId: 's', sourceName: 'source', tags: [], region: 'HK' },
  };
}

describe('chain expansion', () => {
  it('keeps entries before derived nodes and shares final names', () => {
    const entries = [node('e1', 'Entry', 'entry.example'), node('e2', 'Entry', 'entry2.example')];
    const landing = [node('l1', 'Landing', 'landing.example')];
    const outcome = expandChain([...entries, ...landing], {
      enabled: true, entry: { pick: ['e1', 'e2'] }, landing: { pick: ['l1'] },
    });
    expect(outcome.stats.pairCount).toBe(2);
    expect(outcome.nodes.slice(0, 2).map((n) => n.name)).toEqual(['Entry', 'Entry 2']);
    expect(outcome.nodes.slice(2).every((n) => n.chain)).toBe(true);
    expect(outcome.nodes.slice(2).map((n) => n.chain?.viaName)).toEqual(['Entry', 'Entry 2']);
    const lines = emit(outcome.nodes, 'shadowrocket', { base64: false }).body.split('\n');
    expect(lines.slice(0, 2).every((line) => !line.includes('chain='))).toBe(true);
    expect(lines.slice(2).every((line) => line.includes('chain=Entry'))).toBe(true);
  });

  it('does not create a full cartesian product for an empty selector', () => {
    const outcome = expandChain([node('e', 'Entry', 'e.example')], {
      enabled: true, entry: {}, landing: { pick: ['e'] },
    });
    expect(outcome.stats.pairCount).toBe(0);
    expect(outcome.warnings.join(' ')).toContain('为空');
  });

  it('resolves chain roles outside the direct-node selection', () => {
    const direct = node('d1', 'Direct', 'direct.example');
    const entries = [node('e1', 'Entry 1', 'entry1.example'), node('e2', 'Entry 2', 'entry2.example')];
    const landings = [
      node('l1', 'Landing 1', 'landing1.example'),
      node('l2', 'Landing 2', 'landing2.example'),
      node('l3', 'Landing 3', 'landing3.example'),
    ];
    const outcome = expandChain([direct], {
      enabled: true,
      entry: { pick: entries.map((entry) => entry.fingerprint) },
      landing: { pick: landings.map((landing) => landing.fingerprint) },
    }, [direct, ...entries, ...landings]);

    expect(outcome.stats).toMatchObject({ entryCount: 2, landingCount: 3, pairCount: 6 });
    expect(outcome.nodes.filter((item) => item.chain)).toHaveLength(6);
    expect(outcome.nodes.some((item) => item.fingerprint === direct.fingerprint)).toBe(true);
    expect(outcome.nodes).toHaveLength(9);
    expect(outcome.warnings).toEqual([]);
  });

  it('adds out-of-filter landings as direct nodes only when requested', () => {
    const direct = node('d1', 'Direct', 'direct.example');
    const entry = node('e1', 'Entry', 'entry.example');
    const landing = node('l1', 'Landing', 'landing.example');
    const outcome = expandChain([direct], {
      enabled: true,
      entry: { pick: [entry.fingerprint] },
      landing: { pick: [landing.fingerprint] },
      keepLandingDirect: true,
    }, [direct, entry, landing]);

    expect(outcome.stats).toMatchObject({ pairCount: 1, removedDirectLanding: 0 });
    expect(outcome.nodes.map((item) => item.fingerprint)).toEqual([
      entry.fingerprint,
      direct.fingerprint,
      landing.fingerprint,
      expect.any(String),
    ]);
  });

  it('uses a manual short name and keeps multiple pairs unique', () => {
    const entries = [node('e1', 'Very long entry 1', 'entry1.example'), node('e2', 'Very long entry 2', 'entry2.example')];
    const landing = node('l1', 'US-DLOS-SS2022', 'landing.example');
    const outcome = expandChain([...entries, landing], {
      enabled: true,
      entry: { pick: entries.map((entry) => entry.fingerprint) },
      landing: { pick: [landing.fingerprint] },
      nameTemplate: '美国中转',
    });

    expect(outcome.nodes.filter((item) => item.chain).map((item) => item.name)).toEqual(['美国中转', '美国中转 2']);
  });
});
