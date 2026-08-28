import type { ProxyNode, ProxyType } from '../core/types.js';
import type { NodeRepo } from '../db/repo/nodes.js';
import type { IxRelayState, IxService } from './ix.js';

export type NodeKind = 'source' | 'ix-relay';

export interface NodeCatalogEntry {
  fingerprint: string;
  name: string;
  type: ProxyType;
  server: string;
  port: number;
  region: string | null;
  sourceId: string;
  sourceName: string;
  tags: string[];
  firstSeen: number;
  lastSeen: number;
  kind: NodeKind;
  usable: boolean;
  originFingerprint?: string;
  providerId?: string;
  relayState?: IxRelayState;
  relayError?: string | null;
  node?: ProxyNode;
}

/** Unified read model for source nodes and IX relay projections. */
export class NodeCatalog {
  constructor(
    private readonly nodes: NodeRepo,
    private readonly ix: IxService,
  ) {}

  list(): NodeCatalogEntry[] {
    const sources: NodeCatalogEntry[] = this.nodes.listAll().map((node) => ({
      fingerprint: node.fingerprint,
      name: node.name,
      type: node.type,
      server: node.server,
      port: node.port,
      region: node.meta.region ?? null,
      sourceId: node.meta.sourceId,
      sourceName: node.meta.sourceName,
      tags: node.meta.tags,
      firstSeen: node.firstSeen,
      lastSeen: node.lastSeen,
      kind: 'source',
      usable: true,
      node,
    }));
    const relays: NodeCatalogEntry[] = this.ix.relayViews().map((relay) => ({
      ...relay,
      kind: 'ix-relay',
      usable: relay.node !== undefined,
    }));
    return [...sources, ...relays];
  }

  listAll(): ProxyNode[] {
    return this.list().flatMap((entry) => (entry.node ? [entry.node] : []));
  }

  get(fingerprint: string): NodeCatalogEntry | undefined {
    return this.list().find((entry) => entry.fingerprint === fingerprint);
  }

  warningsForPick(fingerprints: readonly string[] | undefined): string[] {
    if (!fingerprints?.length) return [];
    const wanted = new Set(fingerprints);
    return this.list()
      .filter((entry) => wanted.has(entry.fingerprint) && entry.kind === 'ix-relay' && !entry.usable)
      .map((entry) => `${entry.name} 未输出：${entry.relayError ?? 'IX 节点当前不可用'}`);
  }
}
