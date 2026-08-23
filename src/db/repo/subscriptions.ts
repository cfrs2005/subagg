/**
 * 订阅源与流量快照的仓储。
 *
 * 这两者放在一起，是因为流量快照在概念上就是"订阅源的时间序列属性" ——
 * 它没有独立的生命周期，订阅被删除时快照也应当一并消失
 * （由 schema 的 ON DELETE CASCADE 保证）。
 */

import { randomUUID } from 'node:crypto';
import type { Db } from '../index.js';
import type { SubscriptionFormat } from '../../core/parse/index.js';
import type { TrafficInfo } from '../../core/types.js';

export interface Subscription {
  id: string;
  name: string;
  url: string;
  format: SubscriptionFormat;
  /** 自动同步间隔（小时）。 */
  updateInterval: number;
  enabled: boolean;
  /** 抓取时使用的 UA。null 表示使用全局配置值。 */
  userAgent: string | null;
  lastSyncAt: number | null;
  /** 非空表示该订阅当前处于故障状态。 */
  lastError: string | null;
  etag: string | null;
  nodeCount: number;
  createdAt: number;
}

interface SubscriptionRow {
  id: string;
  name: string;
  url: string;
  format: string;
  update_interval: number;
  enabled: number;
  user_agent: string | null;
  last_sync_at: number | null;
  last_error: string | null;
  etag: string | null;
  node_count: number;
  created_at: number;
}

function toSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    // 数据库里可能存着旧版本写入的值，收窄时给个安全兜底
    format: (['auto', 'clash', 'uri-list'] as const).includes(row.format as SubscriptionFormat)
      ? (row.format as SubscriptionFormat)
      : 'auto',
    updateInterval: row.update_interval,
    // SQLite 没有布尔类型，存的是 0/1
    enabled: row.enabled === 1,
    userAgent: row.user_agent,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    etag: row.etag,
    nodeCount: row.node_count,
    createdAt: row.created_at,
  };
}

export interface CreateSubscriptionInput {
  name: string;
  url: string;
  format?: SubscriptionFormat;
  updateInterval?: number;
  userAgent?: string | null;
}

export class SubscriptionRepo {
  constructor(private readonly db: Db) {}

  list(): Subscription[] {
    const rows = this.db
      .prepare('SELECT * FROM subscriptions ORDER BY created_at ASC')
      .all() as SubscriptionRow[];
    return rows.map(toSubscription);
  }

  get(id: string): Subscription | undefined {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as
      | SubscriptionRow
      | undefined;
    return row ? toSubscription(row) : undefined;
  }

  create(input: CreateSubscriptionInput): Subscription {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO subscriptions
           (id, name, url, format, update_interval, enabled, user_agent, node_count, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?)`,
      )
      .run(
        id,
        input.name,
        input.url,
        input.format ?? 'auto',
        input.updateInterval ?? 12,
        input.userAgent ?? null,
        Date.now(),
      );
    const created = this.get(id);
    if (!created) throw new Error('订阅创建后立即读取失败');
    return created;
  }

  /**
   * 部分更新。
   *
   * 只更新传入的字段 —— 前端的编辑表单可能只改了名字，
   * 全量覆盖会把用户没碰过的字段（比如 etag）也一并重置。
   */
  update(
    id: string,
    patch: Partial<Pick<Subscription, 'name' | 'url' | 'format' | 'updateInterval' | 'enabled' | 'userAgent'>>,
  ): Subscription | undefined {
    const columns: Record<string, unknown> = {};
    if (patch.name !== undefined) columns['name'] = patch.name;
    if (patch.url !== undefined) columns['url'] = patch.url;
    if (patch.format !== undefined) columns['format'] = patch.format;
    if (patch.updateInterval !== undefined) columns['update_interval'] = patch.updateInterval;
    if (patch.enabled !== undefined) columns['enabled'] = patch.enabled ? 1 : 0;
    if (patch.userAgent !== undefined) columns['user_agent'] = patch.userAgent;

    const keys = Object.keys(columns);
    if (keys.length > 0) {
      const assignments = keys.map((k) => `${k} = ?`).join(', ');
      this.db
        .prepare(`UPDATE subscriptions SET ${assignments} WHERE id = ?`)
        .run(...keys.map((k) => columns[k]), id);
    }

    // URL 变了就必须清掉 ETag：新地址的内容与旧 ETag 无关，
    // 留着会导致条件请求拿到 304 而永远不更新节点。
    if (patch.url !== undefined) {
      this.db.prepare('UPDATE subscriptions SET etag = NULL WHERE id = ?').run(id);
    }

    return this.get(id);
  }

  delete(id: string): boolean {
    const info = this.db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /** 记录一次成功的同步。 */
  markSynced(id: string, nodeCount: number, etag: string | null): void {
    this.db
      .prepare(
        'UPDATE subscriptions SET last_sync_at = ?, last_error = NULL, node_count = ?, etag = ? WHERE id = ?',
      )
      .run(Date.now(), nodeCount, etag, id);
  }

  /**
   * 记录一次失败的同步。
   *
   * 注意**不清空 node_count，也不删除已有节点** —— 机场临时抽风时，
   * 用旧节点继续服务远好于把用户的订阅变成空的。
   */
  markFailed(id: string, error: string): void {
    this.db
      .prepare('UPDATE subscriptions SET last_sync_at = ?, last_error = ? WHERE id = ?')
      .run(Date.now(), error, id);
  }

  /**
   * 找出到了该同步时间的订阅。
   *
   * @param now 当前时间戳。作为参数传入而非直接读时钟，便于测试。
   */
  dueForSync(now: number): Subscription[] {
    return this.list().filter((sub) => {
      if (!sub.enabled) return false;
      if (sub.lastSyncAt === null) return true; // 从未同步过
      return now - sub.lastSyncAt >= sub.updateInterval * 3600_000;
    });
  }
}

// ─────────────────────────────────────────────────────────────
//  流量快照
// ─────────────────────────────────────────────────────────────

export interface TrafficSnapshot extends TrafficInfo {
  subscriptionId: string;
  ts: number;
}

interface SnapshotRow {
  subscription_id: string;
  ts: number;
  upload: number;
  download: number;
  total: number | null;
  expire: number | null;
}

function toSnapshot(row: SnapshotRow): TrafficSnapshot {
  const snapshot: TrafficSnapshot = {
    subscriptionId: row.subscription_id,
    ts: row.ts,
    upload: row.upload,
    download: row.download,
  };
  // NULL 表示不限量 / 不过期，与 0 含义不同，所以要显式区分
  if (row.total !== null) snapshot.total = row.total;
  if (row.expire !== null) snapshot.expire = row.expire;
  return snapshot;
}

export class TrafficRepo {
  constructor(private readonly db: Db) {}

  /**
   * 记录一次流量快照。
   *
   * 每次同步都记，而不是只保留当前值 —— 存历史才能回答"这周用掉了多少"，
   * 单个当前值回答不了增量类问题。
   */
  record(subscriptionId: string, info: TrafficInfo, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO traffic_snapshots (subscription_id, ts, upload, download, total, expire)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        subscriptionId,
        now,
        Math.round(info.upload),
        Math.round(info.download),
        info.total ?? null,
        info.expire ?? null,
      );
  }

  /** 取某订阅源的最新一条快照。 */
  latest(subscriptionId: string): TrafficSnapshot | undefined {
    const row = this.db
      .prepare('SELECT * FROM traffic_snapshots WHERE subscription_id = ? ORDER BY ts DESC LIMIT 1')
      .get(subscriptionId) as SnapshotRow | undefined;
    return row ? toSnapshot(row) : undefined;
  }

  /** 取全部订阅源的最新快照，key 为订阅源 id。供流量头聚合使用。 */
  latestAll(): Map<string, TrafficSnapshot> {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM traffic_snapshots s
         INNER JOIN (
           SELECT subscription_id, MAX(ts) AS max_ts
           FROM traffic_snapshots GROUP BY subscription_id
         ) latest
         ON s.subscription_id = latest.subscription_id AND s.ts = latest.max_ts`,
      )
      .all() as SnapshotRow[];
    return new Map(rows.map((row) => [row.subscription_id, toSnapshot(row)]));
  }

  /** 取某订阅源的历史快照，用于画趋势图。 */
  history(subscriptionId: string, since: number, limit = 500): TrafficSnapshot[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM traffic_snapshots WHERE subscription_id = ? AND ts >= ? ORDER BY ts ASC LIMIT ?',
      )
      .all(subscriptionId, since, limit) as SnapshotRow[];
    return rows.map(toSnapshot);
  }

  /**
   * 清理过期快照。
   *
   * 每次同步一条，一年下来单个订阅约 700 条 —— 数据量本身不是问题，
   * 但没有上限的表迟早会变成问题，所以提供一个可调用的清理入口。
   */
  prune(olderThan: number): number {
    return this.db.prepare('DELETE FROM traffic_snapshots WHERE ts < ?').run(olderThan).changes;
  }
}
