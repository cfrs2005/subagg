/**
 * 共享管理：好友、订阅 token、访问日志。
 *
 * ## 关于"好友用了多少流量"这个问题
 *
 * **我们测不到，也不假装能测到。**
 *
 * 好友的代理流量是从他的设备直连代理服务器的，根本不经过 subagg。
 * 我们唯一能观测到的，是他的客户端**来拉订阅链接**这个动作。
 *
 * 所以这里记录的全部是真实可采集的数据：
 *   - 什么时候来拉的、拉了多少次
 *   - 用的什么客户端（从 UA 识别）
 *   - 来源 IP 的哈希（用于区分是不是同一个人，不存明文）
 *   - 那次返回了多少个节点、多少字节
 *
 * 界面上不会出现任何"本月估算用量 18.6 GB"之类的数字 —— 那种数字只能是
 * 编出来的，而一个编出来的数字比没有数字更糟：用户会拿它当真去做决策。
 * 真要精确计量，只能看代理服务商的后台。
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { EmitTarget } from '../../core/emit/index.js';
import type { Db } from '../index.js';

// ─────────────────────────────────────────────────────────────
//  好友
// ─────────────────────────────────────────────────────────────

export interface Friend {
  id: string;
  name: string;
  note: string;
  color: string;
  createdAt: number;
}

interface FriendRow {
  id: string;
  name: string;
  note: string;
  color: string;
  created_at: number;
}

const toFriend = (row: FriendRow): Friend => ({
  id: row.id,
  name: row.name,
  note: row.note,
  color: row.color,
  createdAt: row.created_at,
});

export class FriendRepo {
  constructor(private readonly db: Db) {}

  list(): Friend[] {
    const rows = this.db.prepare('SELECT * FROM friends ORDER BY created_at ASC').all() as FriendRow[];
    return rows.map(toFriend);
  }

  get(id: string): Friend | undefined {
    const row = this.db.prepare('SELECT * FROM friends WHERE id = ?').get(id) as FriendRow | undefined;
    return row ? toFriend(row) : undefined;
  }

  create(input: { name: string; note?: string; color?: string }): Friend {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO friends (id, name, note, color, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.name, input.note ?? '', input.color ?? '#6366f1', Date.now());
    const created = this.get(id);
    if (!created) throw new Error('好友创建后立即读取失败');
    return created;
  }

  update(id: string, patch: Partial<Pick<Friend, 'name' | 'note' | 'color'>>): Friend | undefined {
    const columns: Record<string, unknown> = {};
    if (patch.name !== undefined) columns['name'] = patch.name;
    if (patch.note !== undefined) columns['note'] = patch.note;
    if (patch.color !== undefined) columns['color'] = patch.color;

    const keys = Object.keys(columns);
    if (keys.length > 0) {
      const assignments = keys.map((k) => `${k} = ?`).join(', ');
      this.db
        .prepare(`UPDATE friends SET ${assignments} WHERE id = ?`)
        .run(...keys.map((k) => columns[k]), id);
    }
    return this.get(id);
  }

  /**
   * 删除好友。
   *
   * 关联 token 的 friend_id 会被置为 NULL（ON DELETE SET NULL）而不是删除 token
   * ——这是刻意的：删好友是"不再跟踪这个人"，不等于"立即吊销他手里的链接"。
   * 想吊销要显式调用 `TokenRepo.revoke`，避免误操作造成对方突然断网而不知道原因。
   */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM friends WHERE id = ?').run(id).changes > 0;
  }
}

// ─────────────────────────────────────────────────────────────
//  订阅 token
// ─────────────────────────────────────────────────────────────

export interface Token {
  token: string;
  profileId: string;
  friendId: string | null;
  label: string;
  revoked: boolean;
  expiresAt: number | null;
  createdAt: number;
  lastAccessAt: number | null;
  accessCount: number;
  maxAccess: number | null;
  quotaWindowHours: number | null;
  sourceLimit: number | null;
}

interface TokenRow {
  token: string;
  profile_id: string;
  friend_id: string | null;
  label: string;
  revoked: number;
  expires_at: number | null;
  created_at: number;
  last_access_at: number | null;
  access_count: number;
  max_access: number | null;
  quota_window_hours: number | null;
  source_limit: number | null;
}

const toToken = (row: TokenRow): Token => ({
  token: row.token,
  profileId: row.profile_id,
  friendId: row.friend_id,
  label: row.label,
  revoked: row.revoked === 1,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  lastAccessAt: row.last_access_at,
  accessCount: row.access_count,
  maxAccess: row.max_access ?? null,
  quotaWindowHours: row.quota_window_hours ?? null,
  sourceLimit: row.source_limit ?? null,
});

/**
 * 生成订阅 token。
 *
 * 32 字节密码学随机数，编码成 URL-safe base64（43 个字符）。
 *
 * 长度不是随便定的：这个 token 是**唯一**的访问凭证，任何拿到链接的人都能
 * 取走全部节点配置。它会出现在 URL 里，可能被贴进聊天记录、被浏览器历史记录下来，
 * 所以必须长到无法被枚举。256 位熵在任何可预见的算力下都是安全的。
 */
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** token 的可用性判定结果。区分原因是为了给出准确的 HTTP 状态与提示。 */
export type TokenCheck =
  | { valid: true; token: Token }
  | { valid: false; reason: 'not-found' | 'revoked' | 'expired' };

export interface TokenUsage {
  used: number;
  distinctSources: number;
  oldest: number | null;
}

export type TokenState =
  | { state: 'valid' }
  | { state: 'revoked' | 'expired' }
  | { state: 'quota'; rolling: boolean; retryAfterMs: number | null };

export class TokenRepo {
  constructor(private readonly db: Db) {}

  listByProfile(profileId: string): Token[] {
    const rows = this.db
      .prepare('SELECT * FROM tokens WHERE profile_id = ? ORDER BY created_at DESC')
      .all(profileId) as TokenRow[];
    return rows.map(toToken);
  }

  listAll(): Token[] {
    const rows = this.db.prepare('SELECT * FROM tokens ORDER BY created_at DESC').all() as TokenRow[];
    return rows.map(toToken);
  }

  listByFriend(friendId: string): Token[] {
    const rows = this.db
      .prepare('SELECT * FROM tokens WHERE friend_id = ? ORDER BY created_at DESC')
      .all(friendId) as TokenRow[];
    return rows.map(toToken);
  }

  create(input: {
    profileId: string;
    friendId?: string | null;
    label?: string;
    expiresAt?: number | null;
    maxAccess?: number | null;
    quotaWindowHours?: number | null;
    sourceLimit?: number | null;
  }): Token {
    if (input.expiresAt === 0) throw new Error('expiresAt 必须为正数或 null');
    if (input.maxAccess === 0 || (input.maxAccess !== undefined && input.maxAccess !== null && input.maxAccess < 1)) {
      throw new Error('maxAccess 必须为正数或 null');
    }
    if (input.quotaWindowHours !== undefined && input.quotaWindowHours !== null && input.quotaWindowHours < 1) {
      throw new Error('quotaWindowHours 必须为正数或 null');
    }
    const token = generateToken();
    this.db
      .prepare(
        `INSERT INTO tokens (token, profile_id, friend_id, label, revoked, expires_at, created_at, access_count,
          max_access, quota_window_hours, source_limit)
         VALUES (?, ?, ?, ?, 0, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        token,
        input.profileId,
        input.friendId ?? null,
        input.label ?? '',
        input.expiresAt ?? null,
        Date.now(),
        input.maxAccess ?? null,
        input.quotaWindowHours ?? null,
        input.sourceLimit ?? null,
      );
    const created = this.get(token);
    if (!created) throw new Error('token 创建后立即读取失败');
    return created;
  }

  get(token: string): Token | undefined {
    const row = this.db.prepare('SELECT * FROM tokens WHERE token = ?').get(token) as
      | TokenRow
      | undefined;
    return row ? toToken(row) : undefined;
  }

  /**
   * 校验 token 是否可用。
   *
   * 区分 not-found / revoked / expired 三种原因：吊销和过期应当告诉用户
   * "这个链接失效了"，而不存在则应当是一个无差别的 404 ——
   * 否则就把"哪些 token 存在"这个信息泄漏给了枚举者。
   * 具体如何映射到 HTTP 响应由路由层决定。
   */
  check(token: string, now = Date.now()): TokenCheck {
    const found = this.get(token);
    if (!found) return { valid: false, reason: 'not-found' };
    if (found.revoked) return { valid: false, reason: 'revoked' };
    // expiresAt is inclusive: the final valid instant is exactly expiresAt.
    if (found.expiresAt !== null && found.expiresAt < now) {
      return { valid: false, reason: 'expired' };
    }
    return { valid: true, token: found };
  }

  /** 吊销。保留记录而不是删除，这样访问日志里的历史仍能关联到它。 */
  revoke(token: string): boolean {
    return this.db.prepare('UPDATE tokens SET revoked = 1 WHERE token = ?').run(token).changes > 0;
  }

  /**
   * 轮换：吊销旧 token 并生成一个继承其归属的新 token。
   *
   * 这是"我怀疑链接被转发了"时的标准动作 —— 一步完成，
   * 而不是让用户手动"删旧的、建新的"再重新填一遍归属信息。
   */
  rotate(oldToken: string, opts: { expiresInDays?: number | null } = {}): Token | undefined {
    const existing = this.get(oldToken);
    if (!existing) return undefined;

    const rotated = this.db.transaction(() => {
      this.revoke(oldToken);
      return this.create({
        profileId: existing.profileId,
        friendId: existing.friendId,
        label: existing.label,
        expiresAt:
          opts.expiresInDays === undefined
            ? existing.expiresAt
            : opts.expiresInDays === null
              ? null
              : Date.now() + opts.expiresInDays * 86400_000,
        maxAccess: existing.maxAccess,
        quotaWindowHours: existing.quotaWindowHours,
        sourceLimit: existing.sourceLimit,
      });
    });

    return rotated();
  }

  update(
    token: string,
    patch: Partial<Pick<Token, 'label' | 'friendId' | 'expiresAt' | 'maxAccess' | 'quotaWindowHours' | 'sourceLimit'>>,
  ): Token | undefined {
    if (patch.expiresAt === 0) throw new Error('expiresAt 必须为正数或 null');
    if (patch.maxAccess === 0 || (patch.maxAccess !== undefined && patch.maxAccess !== null && patch.maxAccess < 1)) {
      throw new Error('maxAccess 必须为正数或 null');
    }
    const columns: Record<string, unknown> = {};
    if (patch.label !== undefined) columns['label'] = patch.label;
    if (patch.friendId !== undefined) columns['friend_id'] = patch.friendId;
    if (patch.expiresAt !== undefined) columns['expires_at'] = patch.expiresAt;
    if (patch.maxAccess !== undefined) columns['max_access'] = patch.maxAccess;
    if (patch.quotaWindowHours !== undefined) columns['quota_window_hours'] = patch.quotaWindowHours;
    if (patch.sourceLimit !== undefined) columns['source_limit'] = patch.sourceLimit;
    const keys = Object.keys(columns);
    if (keys.length > 0) {
      const assignments = keys.map((key) => `${key} = ?`).join(', ');
      this.db.prepare(`UPDATE tokens SET ${assignments} WHERE token = ?`).run(...keys.map((key) => columns[key]), token);
    }
    return this.get(token);
  }

  /** Count access events and distinct sources using the existing covering index. */
  usageForToken(token: string, since: number | null = null): TokenUsage {
    const where = since === null ? 'token = ?' : 'token = ? AND ts >= ?';
    const args = since === null ? [token] : [token, since];
    const row = this.db.prepare(`SELECT COUNT(*) AS used, COUNT(DISTINCT ip_hash) AS sources, MIN(ts) AS oldest FROM access_log WHERE ${where}`).get(...args) as { used: number; sources: number; oldest: number | null };
    return { used: row.used, distinctSources: row.sources, oldest: row.oldest };
  }

  tokenState(token: Token, usage: TokenUsage, now = Date.now()): TokenState {
    if (token.revoked) return { state: 'revoked' };
    if (token.expiresAt !== null && token.expiresAt < now) return { state: 'expired' };
    if (token.maxAccess === null) return { state: 'valid' };
    if (usage.used < token.maxAccess) return { state: 'valid' };
    if (token.quotaWindowHours !== null) {
      const windowMs = token.quotaWindowHours * 3600_000;
      const retryAfterMs = usage.oldest === null ? windowMs : Math.max(1, usage.oldest + windowMs - now);
      return { state: 'quota', rolling: true, retryAfterMs };
    }
    return { state: 'quota', rolling: false, retryAfterMs: null };
  }

  delete(token: string): boolean {
    return this.db.prepare('DELETE FROM tokens WHERE token = ?').run(token).changes > 0;
  }

  /** 记录一次访问。与写 access_log 配合使用。 */
  touch(token: string, now = Date.now()): void {
    this.db
      .prepare('UPDATE tokens SET last_access_at = ?, access_count = access_count + 1 WHERE token = ?')
      .run(now, token);
  }
}

// ─────────────────────────────────────────────────────────────
//  访问日志
// ─────────────────────────────────────────────────────────────

export interface AccessEntry {
  id: number;
  token: string;
  profileId: string;
  friendId: string | null;
  ts: number;
  client: string;
  userAgent: string;
  ipHash: string;
  target: string;
  nodeCount: number;
  bytes: number;
}

interface AccessRow {
  id: number;
  token: string;
  profile_id: string;
  friend_id: string | null;
  ts: number;
  client: string;
  user_agent: string;
  ip_hash: string;
  target: string;
  node_count: number;
  bytes: number;
}

const toAccess = (row: AccessRow): AccessEntry => ({
  id: row.id,
  token: row.token,
  profileId: row.profile_id,
  friendId: row.friend_id,
  ts: row.ts,
  client: row.client,
  userAgent: row.user_agent,
  ipHash: row.ip_hash,
  target: row.target,
  nodeCount: row.node_count,
  bytes: row.bytes,
});

/**
 * 对 IP 做加盐哈希。
 *
 * 我们需要区分"是不是同一个来源"（判断链接有没有被转发给多个人），
 * 但不需要知道具体 IP。存明文 IP 只会平添一份需要保护的个人数据。
 *
 * 用 HMAC 而不是裸 SHA256：IPv4 只有 43 亿种可能，裸哈希可以在几分钟内
 * 彩虹表反查出来，加盐（作为 HMAC 密钥）才真正不可逆。
 *
 * 截断到 16 个十六进制字符：足够区分不同来源，又进一步限制了信息量。
 */
export function hashIp(ip: string, salt: string): string {
  return createHmac('sha256', salt).update(ip).digest('hex').slice(0, 16);
}

/**
 * 取 token 的短标识，用于日志里指认"是哪条链接"。
 *
 * token 是 32 字节随机数的 base64url（43 字符）。露出头 8 个字符约 48 bit，
 * 剩下的 ~208 bit 依然不可爆破 —— 而 `logger.ts` 的 `mask()` 对长值本来
 * 就保留头 3 尾 3，这里并不比既有姿态更宽松。
 *
 * 用前缀而不是 HMAC，是为了能直接回查：
 *   SELECT label, friend_id FROM tokens WHERE token LIKE 'Ab3xY9_q%'
 * HMAC 得先把全表算一遍才能对上，排查时这点摩擦是致命的。
 *
 * ⚠️ **拿它当日志字段时，字段名不能含 token / key / auth 等字样。**
 * `logger.ts` 的 `SENSITIVE_KEYS` 是**大小写不敏感的子串**匹配，
 * `tokenRef` 会命中 `token`、`limitKey` 会命中 `key`，双双被打成 `'***'`；
 * 而 `mask()` 对长度 ≤ 8 的值直接返回 `'***'`，打码后信息量为零。
 * 统一叫 `ref`。
 */
export function tokenRef(token: string): string {
  return token.slice(0, 8);
}

export interface RecordAccessInput {
  token: string;
  profileId: string;
  friendId: string | null;
  client: string;
  userAgent: string;
  ipHash: string;
  target: EmitTarget;
  nodeCount: number;
  bytes: number;
}

export class AccessLogRepo {
  constructor(private readonly db: Db) {}

  record(input: RecordAccessInput, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO access_log
           (token, profile_id, friend_id, ts, client, user_agent, ip_hash, target, node_count, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.token,
        input.profileId,
        input.friendId,
        now,
        input.client,
        // UA 可能很长（也可能被构造得极长），截断以免日志表膨胀
        input.userAgent.slice(0, 256),
        input.ipHash,
        input.target,
        input.nodeCount,
        input.bytes,
      );
  }

  listByToken(token: string, limit = 50): AccessEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM access_log WHERE token = ? ORDER BY ts DESC LIMIT ?')
      .all(token, limit) as AccessRow[];
    return rows.map(toAccess);
  }

  listByFriend(friendId: string, limit = 50): AccessEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM access_log WHERE friend_id = ? ORDER BY ts DESC LIMIT ?')
      .all(friendId, limit) as AccessRow[];
    return rows.map(toAccess);
  }

  listRecent(limit = 100): AccessEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM access_log ORDER BY ts DESC LIMIT ?')
      .all(limit) as AccessRow[];
    return rows.map(toAccess);
  }

  usageForToken(token: string, since: number | null = null): TokenUsage {
    const where = since === null ? 'token = ?' : 'token = ? AND ts >= ?';
    const args = since === null ? [token] : [token, since];
    const row = this.db
      .prepare(`SELECT COUNT(*) AS used, COUNT(DISTINCT ip_hash) AS sources, MIN(ts) AS oldest FROM access_log WHERE ${where}`)
      .get(...args) as { used: number; sources: number; oldest: number | null };
    return { used: row.used, distinctSources: row.sources, oldest: row.oldest };
  }

  /**
   * 某位好友的访问概况。
   *
   * `distinctSources` 是这里最有信息量的一个指标：如果一个人的链接
   * 出现了 5 个不同的 IP 来源，很可能他把链接转发给别人了。
   * 这是我们能提供的、关于"链接是否被滥用"的**唯一真实**信号。
   */
  summaryForFriend(friendId: string, since: number): {
    total: number;
    lastAccessAt: number | null;
    distinctSources: number;
    clients: string[];
  } {
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS total, MAX(ts) AS last_ts, COUNT(DISTINCT ip_hash) AS sources
         FROM access_log WHERE friend_id = ? AND ts >= ?`,
      )
      .get(friendId, since) as { total: number; last_ts: number | null; sources: number };

    const clients = this.db
      .prepare(
        'SELECT DISTINCT client FROM access_log WHERE friend_id = ? AND ts >= ? ORDER BY client',
      )
      .all(friendId, since) as { client: string }[];

    return {
      total: agg.total,
      lastAccessAt: agg.last_ts,
      distinctSources: agg.sources,
      clients: clients.map((c) => c.client),
    };
  }

  /** 清理旧日志。表会无限增长，需要一个可调用的清理入口。 */
  prune(olderThan: number): number {
    return this.db.prepare('DELETE FROM access_log WHERE ts < ?').run(olderThan).changes;
  }
}
