import type { Db } from '../index.js';

export interface PingSnapshot {
  fingerprint: string;
  checkedAt: number;
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

interface PingRow {
  fingerprint: string;
  ts: number;
  ok: number;
  latency_ms: number | null;
  error: string | null;
}

function toSnapshot(row: PingRow): PingSnapshot {
  return {
    fingerprint: row.fingerprint,
    checkedAt: row.ts,
    ok: row.ok === 1,
    latencyMs: row.latency_ms,
    ...(row.error ? { error: row.error } : {}),
  };
}

/** 持久化节点 TCP 探测结果，供节点列表的最新状态和详情趋势图使用。 */
export class PingHistoryRepo {
  constructor(private readonly db: Db) {}

  record(snapshot: PingSnapshot): PingSnapshot {
    const checkedAt = snapshot.checkedAt || Date.now();
    const error = snapshot.error?.slice(0, 500) ?? null;
    this.db.prepare(
      'INSERT INTO node_ping_history (fingerprint, ts, ok, latency_ms, error) VALUES (?, ?, ?, ?, ?)',
    ).run(snapshot.fingerprint, checkedAt, snapshot.ok ? 1 : 0, snapshot.latencyMs, error);
    return { ...snapshot, checkedAt, ...(error ? { error } : {}) };
  }

  latestAll(): Map<string, PingSnapshot> {
    const rows = this.db.prepare(`
      SELECT h.fingerprint, h.ts, h.ok, h.latency_ms, h.error
      FROM node_ping_history h
      INNER JOIN (
        SELECT fingerprint, MAX(id) AS id
        FROM node_ping_history
        GROUP BY fingerprint
      ) latest ON latest.id = h.id
    `).all() as PingRow[];
    return new Map(rows.map((row) => [row.fingerprint, toSnapshot(row)]));
  }

  history(fingerprint: string, since: number, limit = 500): PingSnapshot[] {
    const rows = this.db.prepare(`
      SELECT fingerprint, ts, ok, latency_ms, error
      FROM node_ping_history
      WHERE fingerprint = ? AND ts >= ?
      ORDER BY ts ASC
      LIMIT ?
    `).all(fingerprint, since, limit) as PingRow[];
    return rows.map(toSnapshot);
  }

  prune(before: number): number {
    return this.db.prepare('DELETE FROM node_ping_history WHERE ts < ?').run(before).changes;
  }
}
