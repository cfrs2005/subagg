/**
 * Chain expansion between filtering and emit.
 *
 * Parsers intentionally do not read upstream chain fields. This pass creates
 * derived nodes only at render time, so they never enter the database.
 */
import { deriveChainFingerprint } from './fingerprint.js';
import { ensureUniqueNames, selectNodes, type ChainRule } from './filter.js';
import { regionNameZh, regionToFlag } from './region.js';
import type { ProxyNode } from './types.js';

export interface ChainPair {
  entry: ProxyNode;
  landing: ProxyNode;
  node: ProxyNode;
}

export interface ChainStats {
  entryCount: number;
  landingCount: number;
  pairCount: number;
  droppedSelfPair: number;
  droppedByMaxPairs: number;
  removedDirectLanding: number;
  truncated: boolean;
}

export interface ChainOutcome {
  /** Entry nodes, direct nodes, then derived nodes. Order is part of the API. */
  nodes: ProxyNode[];
  pairs: ChainPair[];
  stats: ChainStats;
  warnings: string[];
}

function cleanName(name: string): string {
  return name.replace(/[\r\n\t]/g, ' ').trim();
}

function templateName(template: string, landing: ProxyNode, entry: ProxyNode, seq: number): string {
  const region = landing.meta.region ?? '';
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    switch (key) {
      case 'landing':
      case 'name':
        return landing.name;
      case 'entry':
        return entry.name;
      case 'region':
        return region;
      case 'regionZh':
        return region ? regionNameZh(region) : '';
      case 'flag':
        return region ? regionToFlag(region) : '';
      case 'type':
        return landing.type;
      case 'source':
        return landing.meta.sourceName;
      case 'server':
        return landing.server;
      case 'port':
        return String(landing.port);
      case 'seq':
        return String(seq);
      case 'seq3':
        return String(seq).padStart(3, '0');
      case 'index':
        return String(seq);
      case 'index2':
        return String(seq).padStart(2, '0');
      default:
        return whole;
    }
  });
}

export function expandChain(nodes: readonly ProxyNode[], rule: ChainRule | undefined): ChainOutcome {
  const warnings: string[] = [];
  const stats: ChainStats = {
    entryCount: 0,
    landingCount: 0,
    pairCount: 0,
    droppedSelfPair: 0,
    droppedByMaxPairs: 0,
    removedDirectLanding: 0,
    truncated: false,
  };
  if (!rule || rule.enabled !== true) {
    return { nodes: [...nodes], pairs: [], stats, warnings };
  }

  for (const [role, selector] of [['入口', rule.entry], ['落地', rule.landing]] as const) {
    for (const fingerprint of selector.pick ?? []) {
      if (!nodes.some((node) => node.fingerprint === fingerprint)) {
        warnings.push(`${role}选择了未被主规则选中的节点 ${fingerprint}，请调整主规则的筛选或 limit`);
      }
    }
  }

  const entries = selectNodes(nodes, rule.entry, warnings);
  const landings = selectNodes(nodes, rule.landing, warnings);
  stats.entryCount = entries.length;
  stats.landingCount = landings.length;
  const maxPairs = Math.min(Math.max(rule.maxPairs ?? 200, 1), 1000);
  const pairs: ChainPair[] = [];
  for (const landing of landings) {
    for (const entry of entries) {
      if (landing.fingerprint === entry.fingerprint) {
        stats.droppedSelfPair++;
        continue;
      }
      if (pairs.length >= maxPairs) {
        stats.droppedByMaxPairs++;
        stats.truncated = true;
        continue;
      }
      pairs.push({ entry, landing, node: landing });
    }
  }
  if (stats.truncated) warnings.push(`链式配对超过上限 ${maxPairs}，已截断 ${stats.droppedByMaxPairs} 对`);
  if (entries.length === 0 || landings.length === 0) {
    warnings.push('链式入口或落地没有匹配节点，未生成链式节点');
  }

  const used = new Set<string>();
  const lockedEntries = entries.map((entry) => {
    const cleaned = cleanName(entry.name);
    let name = cleaned || `${entry.server}:${entry.port}`;
    let n = 2;
    while (used.has(name)) name = `${cleaned} ${n++}`;
    used.add(name);
    return name === entry.name ? entry : { ...entry, name };
  });
  const finalByFingerprint = new Map(entries.map((entry, i) => [entry.fingerprint, lockedEntries[i]!] as const));

  const derived: ProxyNode[] = [];
  let seq = 1;
  for (const pair of pairs) {
    const entry = finalByFingerprint.get(pair.entry.fingerprint) ?? pair.entry;
    const viaName = entry.name;
    const rawName = cleanName(templateName(rule.nameTemplate ?? '{entry} -RELAY- {landing}', pair.landing, entry, seq++));
    const derivedNode = {
      ...pair.landing,
      name: rawName || `${pair.landing.name} via ${viaName}`,
      fingerprint: deriveChainFingerprint(pair.landing.fingerprint, pair.entry.fingerprint),
      chain: { viaName, viaFingerprint: pair.entry.fingerprint },
    } as ProxyNode;
    derived.push(derivedNode);
  }
  const uniqueDerived = ensureUniqueNames([...lockedEntries, ...derived]).slice(lockedEntries.length);
  const entryFingerprints = new Set(entries.map((node) => node.fingerprint));
  const direct = rule.keepLandingDirect === true
    ? [...nodes]
    : nodes.filter((node) => {
        if (!landings.some((landing) => landing.fingerprint === node.fingerprint)) return true;
        stats.removedDirectLanding++;
        return entryFingerprints.has(node.fingerprint);
      });

  const output = [...lockedEntries, ...direct.filter((node) => !entryFingerprints.has(node.fingerprint)), ...uniqueDerived];
  const names = new Set(output.map((node) => node.name));
  const safe = output.filter((node) => !node.chain || names.has(node.chain.viaName));
  if (safe.length !== output.length) warnings.push('检测到悬空链式引用，相关节点已丢弃');
  return { nodes: safe, pairs, stats: { ...stats, pairCount: pairs.length }, warnings };
}
