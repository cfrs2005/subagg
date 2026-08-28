import type { Config } from '../config.js';
import type { ProxyNode } from '../core/types.js';
import type { PingHistoryRepo, PingSnapshot } from '../db/repo/ping-history.js';
import type { Logger } from '../logger.js';
import { pingHostPort } from './tcpPing.js';

export interface NodePingResult extends PingSnapshot {
  name: string;
  host: string;
  port: number;
}

export class NodePingService {
  private running = false;

  constructor(private readonly options: {
    config: Config;
    logger: Logger;
    nodes: { listAll(): ProxyNode[] };
    history: PingHistoryRepo;
  }) {}

  async pingNode(node: ProxyNode): Promise<NodePingResult> {
    const result = await pingHostPort(node.server, node.port);
    const snapshot = this.options.history.record({
      fingerprint: node.fingerprint,
      checkedAt: Date.now(),
      ...result,
    });
    return { ...snapshot, name: node.name, host: node.server, port: node.port };
  }

  pruneHistory(before: number): number {
    return this.options.history.prune(before);
  }

  /** 每 12 小时只测一次；新节点或服务重启后没有历史时会在下一轮补测。 */
  async pingDue(now = Date.now()): Promise<{ total: number; online: number; offline: number }> {
    if (this.running) return { total: 0, online: 0, offline: 0 };
    this.running = true;
    try {
      const intervalMs = this.options.config.nodePingIntervalHours * 3600_000;
      const latest = this.options.history.latestAll();
      const unique = new Map(this.options.nodes.listAll().map((node) => [node.fingerprint, node]));
      const targets = [...unique.values()].filter((node) => {
        const previous = latest.get(node.fingerprint);
        return !previous || now - previous.checkedAt >= intervalMs;
      });

      let next = 0;
      let online = 0;
      let offline = 0;
      const workers = Array.from({ length: Math.min(8, targets.length) }, async () => {
        while (next < targets.length) {
          const node = targets[next++];
          if (!node) break;
          try {
            const result = await this.pingNode(node);
            if (result.ok) online += 1;
            else offline += 1;
          } catch (err) {
            offline += 1;
            this.options.history.record({
              fingerprint: node.fingerprint,
              checkedAt: Date.now(),
              ok: false,
              latencyMs: null,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      });
      await Promise.all(workers);
      return { total: targets.length, online, offline };
    } finally {
      this.running = false;
    }
  }
}
