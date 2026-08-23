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
});
