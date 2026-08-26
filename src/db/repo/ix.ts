/**
 * IX 中转的仓储：服务商账号 + 节点↔远端端口映射。
 *
 * 这一层是**纯 DAO**：只做 SQL ↔ 领域对象的映射，不认识 `core/ix.ts` 的
 * `IxEntry`，也不做任何编排。把 `IxMapping` 转成渲染管线要的 `IxEntry`
 * 是 services 层的职责 —— 那里才知道"state 是 active 但 suspended=1 时
 * 该怎么算"这类策略。
 *
 * 两个仓储放同一个文件，理由与 `subscriptions.ts` 把流量快照放进去一样：
 * 映射没有独立生命周期，provider 删掉映射就该一起消失
 * （由 schema 的 ON DELETE CASCADE 保证）。
 */

import { randomUUID } from 'node:crypto';
import type { Db } from '../index.js';

// ─────────────────────────────────────────────────────────────
//  服务商
// ─────────────────────────────────────────────────────────────

/** `api-key` 是长期方案；当前账号拿不到 Key，MVP 走 `login`。 */
export type IxAuthMode = 'api-key' | 'login';

const AUTH_MODES = ['api-key', 'login'] as const satisfies readonly IxAuthMode[];

export interface IxProvider {
  id: string;
  name: string;
  /** API 基址，如 `https://relay.example.com/api`。 */
  baseUrl: string;
  authMode: IxAuthMode;
  /**
   * ⚠️ 密文，不是明文。`core/secret.ts` 的 `v1:<base64url>` 形态。
   * 想拿明文得用 `decryptSecret()`，且必须处理 `SecretDecryptError`
   * （轮换 ADMIN_TOKEN 后一定解不开）。
   */
  apiKeyEnc: string | null;
  username: string | null;
  /** ⚠️ 密文。见 `apiKeyEnc`。 */
  passwordEnc: string | null;
  /** ⚠️ 密文。登录换来的 JWT，缓存下来避免每次同步都重登。 */
  jwtEnc: string | null;
  jwtExpiresAt: number | null;
  defaultLineId: number | null;
  /**
   * **只是建端口时的请求参数**（`createPort` 的 `enable_udp`），不是任何端口的现状。
   *
   * 渲染判定一律看 `IxMapping.entryUdp`（平台回报的端口事实）。拿这个值去当事实，
   * 用户在平台上手工关掉某个端口的 UDP 时我们完全看不到。
   */
  enableUdp: boolean;
  /** 全局总闸。关掉后所有 profile 一起回落直连。 */
  enabled: boolean;
  lastProbeAt: number | null;
  lastError: string | null;
  /** 平台返回的额度/线路快照原文 JSON。原样存、原样展示，不做推导。 */
  quotaJson: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  auth_mode: string;
  api_key_enc: string | null;
  username: string | null;
  password_enc: string | null;
  jwt_enc: string | null;
  jwt_expires_at: number | null;
  default_line_id: number | null;
  enable_udp: number;
  enabled: number;
  last_probe_at: number | null;
  last_error: string | null;
  quota_json: string | null;
  created_at: number;
  updated_at: number;
}

function toProvider(row: ProviderRow): IxProvider {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    // schema 里没有 CHECK 约束（既有表都没这先例），收窄在这里做。
    // 手工改过库或旧版本写入的怪值，兜底成能力最弱的那个模式。
    authMode: AUTH_MODES.includes(row.auth_mode as IxAuthMode) ? (row.auth_mode as IxAuthMode) : 'login',
    apiKeyEnc: row.api_key_enc,
    username: row.username,
    passwordEnc: row.password_enc,
    jwtEnc: row.jwt_enc,
    jwtExpiresAt: row.jwt_expires_at,
    defaultLineId: row.default_line_id,
    // SQLite 没有布尔类型，存的是 0/1
    enableUdp: row.enable_udp === 1,
    enabled: row.enabled === 1,
    lastProbeAt: row.last_probe_at,
    lastError: row.last_error,
    quotaJson: row.quota_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateIxProviderInput {
  name: string;
  baseUrl: string;
  authMode?: IxAuthMode;
  /** 已加密的密文。仓储层不做加密 —— 密钥在 services 层。 */
  apiKeyEnc?: string | null;
  username?: string | null;
  passwordEnc?: string | null;
  defaultLineId?: number | null;
  enableUdp?: boolean;
  enabled?: boolean;
}

/** 可部分更新的列。凭据与会话字段也在内 —— JWT 轮换走的就是这条路。 */
export type IxProviderPatch = Partial<
  Pick<
    IxProvider,
    | 'name'
    | 'baseUrl'
    | 'authMode'
    | 'apiKeyEnc'
    | 'username'
    | 'passwordEnc'
    | 'jwtEnc'
    | 'jwtExpiresAt'
    | 'defaultLineId'
    | 'enableUdp'
    | 'enabled'
    | 'lastProbeAt'
    | 'lastError'
    | 'quotaJson'
  >
>;

export class IxProviderRepo {
  constructor(private readonly db: Db) {}

  list(): IxProvider[] {
    const rows = this.db
      .prepare('SELECT * FROM ix_providers ORDER BY created_at ASC')
      .all() as ProviderRow[];
    return rows.map(toProvider);
  }

  get(id: string): IxProvider | undefined {
    const row = this.db.prepare('SELECT * FROM ix_providers WHERE id = ?').get(id) as
      | ProviderRow
      | undefined;
    return row ? toProvider(row) : undefined;
  }

  /** 只取开着总闸的 provider。渲染与调度都只该看这批。 */
  listEnabled(): IxProvider[] {
    const rows = this.db
      .prepare('SELECT * FROM ix_providers WHERE enabled = 1 ORDER BY created_at ASC')
      .all() as ProviderRow[];
    return rows.map(toProvider);
  }

  create(input: CreateIxProviderInput, now = Date.now()): IxProvider {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO ix_providers
           (id, name, base_url, auth_mode, api_key_enc, username, password_enc,
            default_line_id, enable_udp, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.baseUrl,
        input.authMode ?? 'login',
        input.apiKeyEnc ?? null,
        input.username ?? null,
        input.passwordEnc ?? null,
        input.defaultLineId ?? null,
        (input.enableUdp ?? true) ? 1 : 0,
        (input.enabled ?? true) ? 1 : 0,
        now,
        now,
      );
    const created = this.get(id);
    if (!created) throw new Error('IX 服务商创建后立即读取失败');
    return created;
  }

  /**
   * 部分更新。
   *
   * 只写传入的字段 —— 前端可能只是拨了一下 `enabled` 总闸，
   * 全量覆盖会把 JWT 缓存、额度快照一起清空，下一轮同步就得重登。
   */
  update(id: string, patch: IxProviderPatch, now = Date.now()): IxProvider | undefined {
    const columns: Record<string, unknown> = {};
    if (patch.name !== undefined) columns['name'] = patch.name;
    if (patch.baseUrl !== undefined) columns['base_url'] = patch.baseUrl;
    if (patch.authMode !== undefined) columns['auth_mode'] = patch.authMode;
    if (patch.apiKeyEnc !== undefined) columns['api_key_enc'] = patch.apiKeyEnc;
    if (patch.username !== undefined) columns['username'] = patch.username;
    if (patch.passwordEnc !== undefined) columns['password_enc'] = patch.passwordEnc;
    if (patch.jwtEnc !== undefined) columns['jwt_enc'] = patch.jwtEnc;
    if (patch.jwtExpiresAt !== undefined) columns['jwt_expires_at'] = patch.jwtExpiresAt;
    if (patch.defaultLineId !== undefined) columns['default_line_id'] = patch.defaultLineId;
    if (patch.enableUdp !== undefined) columns['enable_udp'] = patch.enableUdp ? 1 : 0;
    if (patch.enabled !== undefined) columns['enabled'] = patch.enabled ? 1 : 0;
    if (patch.lastProbeAt !== undefined) columns['last_probe_at'] = patch.lastProbeAt;
    if (patch.lastError !== undefined) columns['last_error'] = patch.lastError;
    if (patch.quotaJson !== undefined) columns['quota_json'] = patch.quotaJson;

    const keys = Object.keys(columns);
    if (keys.length > 0) {
      const assignments = keys.map((key) => `${key} = ?`).join(', ');
      this.db
        .prepare(`UPDATE ix_providers SET ${assignments}, updated_at = ? WHERE id = ?`)
        .run(...keys.map((key) => columns[key]), now, id);
    }

    return this.get(id);
  }

  delete(id: string): boolean {
    // 映射由 ON DELETE CASCADE 连带删除（openDatabase 已开 foreign_keys）。
    return this.db.prepare('DELETE FROM ix_providers WHERE id = ?').run(id).changes > 0;
  }
}

// ─────────────────────────────────────────────────────────────
//  节点 ↔ 远端端口映射
// ─────────────────────────────────────────────────────────────

/**
 * - `pending`  已登记但远端端口还没建/还没认领，`entryHost/entryPort` 为空
 * - `active`   远端端口就绪，可以参与渲染改写
 * - `error`    最近一次操作或同步失败，`lastError` 有原因
 * - `orphan`   节点已从上游消失（`missingCount` 累到阈值）。只标记，不自动删远端
 */
export type IxMappingState = 'pending' | 'active' | 'error' | 'orphan';

const MAPPING_STATES = ['pending', 'active', 'error', 'orphan'] as const satisfies readonly IxMappingState[];

export interface IxMapping {
  providerId: string;
  /** 原节点指纹。改写发生在渲染期且保留原指纹，所以这里永远是原始节点的。 */
  fingerprint: string;
  remotePortId: number | null;
  /** 中转入口。端口由平台分配，建成前是 null（不用 0 —— 那是能混进配置的假值）。 */
  entryHost: string | null;
  entryPort: number | null;
  /**
   * 这个**中转端口**转不转 UDP（平台 port 的 `enable_udp`）。
   *
   * 三态，`null` 是"还没同步过、事实未知"，与 `false`（明确不转）不是一回事：
   * 渲染层据此决定 hysteria2 / tuic / QUIC 节点能不能改写，把未知当成 false
   * 会白挡掉一批节点，把未知当成 true 会输出 UDP 黑洞的死节点。
   * 唯一的写入来源是平台返回的 port，**不是** `IxProvider.enableUdp`。
   */
  entryUdp: boolean | null;
  /** 冗余存的原节点地址，用于认领时精确比对与"映射还指向这个节点吗"的校验。 */
  targetHost: string;
  targetPort: number;
  lineId: number | null;
  lineName: string | null;
  state: IxMappingState;
  lastError: string | null;
  /** 微秒（平台原始口径）。是「中转入口 → 原落地」那一段，不是端到端。 */
  latencyUs: number | null;
  lossRate: number | null;
  /** 字节。 */
  trafficIn: number | null;
  trafficOut: number | null;
  suspended: boolean;
  /** 平台把配置下发给转发节点时的错误，与 `lastError`（我们调 API 的错误）不同。 */
  syncError: string | null;
  missingCount: number;
  remoteSyncedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface MappingRow {
  provider_id: string;
  fingerprint: string;
  remote_port_id: number | null;
  entry_host: string | null;
  entry_port: number | null;
  entry_udp: number | null;
  target_host: string;
  target_port: number;
  line_id: number | null;
  line_name: string | null;
  state: string;
  last_error: string | null;
  latency_us: number | null;
  loss_rate: number | null;
  traffic_in: number | null;
  traffic_out: number | null;
  suspended: number;
  sync_error: string | null;
  missing_count: number;
  remote_synced_at: number | null;
  created_at: number;
  updated_at: number;
}

function toMapping(row: MappingRow): IxMapping {
  return {
    providerId: row.provider_id,
    fingerprint: row.fingerprint,
    remotePortId: row.remote_port_id,
    entryHost: row.entry_host,
    entryPort: row.entry_port,
    // 三态必须原样透出：NULL 就是 NULL，绝不 `=== 1` 一刀切成 false ——
    // 那会把"没同步过"伪装成"平台明说了不转 UDP"。
    entryUdp: row.entry_udp === null ? null : row.entry_udp === 1,
    targetHost: row.target_host,
    targetPort: row.target_port,
    lineId: row.line_id,
    lineName: row.line_name,
    // 认不出的状态兜底成 error 而不是 active：把未知当可用会让平台上
    // 已停用的端口被静默拿去改写，症状是整批节点连不上、且无从归因。
    state: MAPPING_STATES.includes(row.state as IxMappingState) ? (row.state as IxMappingState) : 'error',
    lastError: row.last_error,
    latencyUs: row.latency_us,
    lossRate: row.loss_rate,
    trafficIn: row.traffic_in,
    trafficOut: row.traffic_out,
    suspended: row.suspended === 1,
    syncError: row.sync_error,
    missingCount: row.missing_count,
    remoteSyncedAt: row.remote_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 可写字段。`upsert` 与 `update` 共用一套列映射，免得两处各写一遍漏字段。 */
export type IxMappingPatch = Partial<
  Pick<
    IxMapping,
    | 'remotePortId'
    | 'entryHost'
    | 'entryPort'
    | 'entryUdp'
    | 'targetHost'
    | 'targetPort'
    | 'lineId'
    | 'lineName'
    | 'state'
    | 'lastError'
    | 'latencyUs'
    | 'lossRate'
    | 'trafficIn'
    | 'trafficOut'
    | 'suspended'
    | 'syncError'
    | 'missingCount'
    | 'remoteSyncedAt'
  >
>;

export type UpsertIxMappingInput = IxMappingPatch & {
  providerId: string;
  fingerprint: string;
  targetHost: string;
  targetPort: number;
};

/** camelCase patch → snake_case 列。只收 `!== undefined` 的键。 */
function mappingColumns(patch: IxMappingPatch): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  if (patch.remotePortId !== undefined) columns['remote_port_id'] = patch.remotePortId;
  if (patch.entryHost !== undefined) columns['entry_host'] = patch.entryHost;
  if (patch.entryPort !== undefined) columns['entry_port'] = patch.entryPort;
  // 三态各有各的写法：`undefined` = 这次不动这一列（沿用库里的旧事实），
  // `null` = 显式写回"未知"（例如平台不再回报这个字段），
  // `true/false` = 平台回报的事实。三者不能合并成一个 `? 1 : 0`。
  if (patch.entryUdp !== undefined) {
    columns['entry_udp'] = patch.entryUdp === null ? null : patch.entryUdp ? 1 : 0;
  }
  if (patch.targetHost !== undefined) columns['target_host'] = patch.targetHost;
  if (patch.targetPort !== undefined) columns['target_port'] = patch.targetPort;
  if (patch.lineId !== undefined) columns['line_id'] = patch.lineId;
  if (patch.lineName !== undefined) columns['line_name'] = patch.lineName;
  if (patch.state !== undefined) columns['state'] = patch.state;
  if (patch.lastError !== undefined) columns['last_error'] = patch.lastError;
  if (patch.latencyUs !== undefined) columns['latency_us'] = patch.latencyUs;
  if (patch.lossRate !== undefined) columns['loss_rate'] = patch.lossRate;
  if (patch.trafficIn !== undefined) columns['traffic_in'] = patch.trafficIn;
  if (patch.trafficOut !== undefined) columns['traffic_out'] = patch.trafficOut;
  if (patch.suspended !== undefined) columns['suspended'] = patch.suspended ? 1 : 0;
  if (patch.syncError !== undefined) columns['sync_error'] = patch.syncError;
  if (patch.missingCount !== undefined) columns['missing_count'] = patch.missingCount;
  if (patch.remoteSyncedAt !== undefined) columns['remote_synced_at'] = patch.remoteSyncedAt;
  return columns;
}

/**
 * SQLite 的绑定参数上限（`SQLITE_MAX_VARIABLE_NUMBER`）在旧构建里是 999。
 * 按指纹批量查时分块，别让"节点多了就突然报错"成为一个惊喜。
 */
const IN_CHUNK = 400;

export class IxMappingRepo {
  constructor(private readonly db: Db) {}

  get(providerId: string, fingerprint: string): IxMapping | undefined {
    const row = this.db
      .prepare('SELECT * FROM ix_port_mappings WHERE provider_id = ? AND fingerprint = ?')
      .get(providerId, fingerprint) as MappingRow | undefined;
    return row ? toMapping(row) : undefined;
  }

  /** 列出映射。不传 providerId 就是全部（管理界面的映射列表）。 */
  list(providerId?: string): IxMapping[] {
    const rows = (
      providerId === undefined
        ? this.db.prepare('SELECT * FROM ix_port_mappings ORDER BY created_at ASC').all()
        : this.db
            .prepare('SELECT * FROM ix_port_mappings WHERE provider_id = ? ORDER BY created_at ASC')
            .all(providerId)
    ) as MappingRow[];
    return rows.map(toMapping);
  }

  listByProvider(providerId: string): IxMapping[] {
    return this.list(providerId);
  }

  /**
   * 渲染热路径专用：一条 SQL 取回该 provider 的全部映射，key 为指纹。
   *
   * `renderProfile` 是同步函数、每次订阅拉取都会走，所以这里**必须**一次拿全 ——
   * 按节点逐个查就是 N+1，几十个节点几十次 prepare/step。
   * 走复合主键的前导列 `provider_id`，是索引扫描。
   */
  mapForProvider(providerId: string): Map<string, IxMapping> {
    const rows = this.db
      .prepare('SELECT * FROM ix_port_mappings WHERE provider_id = ?')
      .all(providerId) as MappingRow[];
    return new Map(rows.map((row) => [row.fingerprint, toMapping(row)]));
  }

  /**
   * 批量按指纹查（认领/创建前的查重、界面按勾选集显示状态）。
   *
   * 一次 `IN (...)` 拿全，不做逐个查询。参数超过上限时分块。
   */
  listByFingerprints(providerId: string, fingerprints: readonly string[]): IxMapping[] {
    if (fingerprints.length === 0) return [];
    const result: IxMapping[] = [];
    for (let offset = 0; offset < fingerprints.length; offset += IN_CHUNK) {
      const chunk = fingerprints.slice(offset, offset + IN_CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT * FROM ix_port_mappings
           WHERE provider_id = ? AND fingerprint IN (${placeholders})`,
        )
        .all(providerId, ...chunk) as MappingRow[];
      result.push(...rows.map(toMapping));
    }
    return result;
  }

  /** 跨 provider 按指纹反查（节点详情页要显示"这个节点走哪个中转"）。 */
  findByFingerprint(fingerprint: string): IxMapping[] {
    const rows = this.db
      .prepare('SELECT * FROM ix_port_mappings WHERE fingerprint = ? ORDER BY created_at ASC')
      .all(fingerprint) as MappingRow[];
    return rows.map(toMapping);
  }

  /** 按状态筛（孤儿高亮、待创建队列）。走 idx_ix_map_state。 */
  listByState(state: IxMappingState, providerId?: string): IxMapping[] {
    const rows = (
      providerId === undefined
        ? this.db
            .prepare('SELECT * FROM ix_port_mappings WHERE state = ? ORDER BY created_at ASC')
            .all(state)
        : this.db
            .prepare(
              'SELECT * FROM ix_port_mappings WHERE state = ? AND provider_id = ? ORDER BY created_at ASC',
            )
            .all(state, providerId)
    ) as MappingRow[];
    return rows.map(toMapping);
  }

  /** 本地映射数。配额预检要用（本地数 + 远端 port_count vs max_ports_number）。 */
  count(providerId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM ix_port_mappings WHERE provider_id = ?')
      .get(providerId) as { n: number };
    return row.n;
  }

  /**
   * 幂等写入。
   *
   * `ON CONFLICT DO UPDATE` 只覆盖**本次传了的**字段 —— 所以补一次延迟数据
   * 不会把 `state` 打回 'pending'，而 `created_at` 与 `missing_count`
   * 不在覆盖列表里，天然保住（同 `nodes` 表保 `first_seen` 的理由）。
   */
  upsert(input: UpsertIxMappingInput, now = Date.now()): IxMapping {
    const { providerId, fingerprint, ...patch } = input;
    // targetHost / targetPort 在 UpsertIxMappingInput 里是必填，所以它们一定
    // 出现在 mappingColumns 的结果里 —— 不必再单独拼一遍。
    const columns = mappingColumns(patch);
    const keys = Object.keys(columns);
    const insertColumns = ['provider_id', 'fingerprint', ...keys, 'created_at', 'updated_at'];
    const placeholders = insertColumns.map(() => '?').join(', ');
    const assignments = [...keys.map((key) => `${key} = excluded.${key}`), 'updated_at = excluded.updated_at'].join(', ');

    this.db
      .prepare(
        `INSERT INTO ix_port_mappings (${insertColumns.join(', ')})
         VALUES (${placeholders})
         ON CONFLICT(provider_id, fingerprint) DO UPDATE SET ${assignments}`,
      )
      .run(providerId, fingerprint, ...keys.map((key) => columns[key]), now, now);

    const saved = this.get(providerId, fingerprint);
    if (!saved) throw new Error('IX 映射写入后立即读取失败');
    return saved;
  }

  /** 部分更新（远端状态、延迟、流量、错误…）。返回 undefined 表示该映射不存在。 */
  update(
    providerId: string,
    fingerprint: string,
    patch: IxMappingPatch,
    now = Date.now(),
  ): IxMapping | undefined {
    const columns = mappingColumns(patch);
    const keys = Object.keys(columns);
    if (keys.length > 0) {
      const assignments = keys.map((key) => `${key} = ?`).join(', ');
      this.db
        .prepare(
          `UPDATE ix_port_mappings SET ${assignments}, updated_at = ?
           WHERE provider_id = ? AND fingerprint = ?`,
        )
        .run(...keys.map((key) => columns[key]), now, providerId, fingerprint);
    }
    return this.get(providerId, fingerprint);
  }

  /**
   * 「这轮同步又没见到这个节点」计数 +1，返回新值。
   *
   * 在 SQL 里自增而不是读出来加一再写回：同步任务与手动刷新可能同时跑，
   * read-modify-write 会丢计数。
   */
  bumpMissing(providerId: string, fingerprint: string, now = Date.now()): number {
    this.db
      .prepare(
        `UPDATE ix_port_mappings SET missing_count = missing_count + 1, updated_at = ?
         WHERE provider_id = ? AND fingerprint = ?`,
      )
      .run(now, providerId, fingerprint);
    return this.get(providerId, fingerprint)?.missingCount ?? 0;
  }

  /**
   * 节点又回来了：清零计数。
   *
   * 必须是"见到就清零"而不是只在标孤儿时清 —— 机场偶发返回不完整列表很常见，
   * 不清零的话计数只会单调累加，健康节点迟早被误标成孤儿。
   */
  resetMissing(providerId: string, fingerprint: string, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE ix_port_mappings SET missing_count = 0, updated_at = ?
         WHERE provider_id = ? AND fingerprint = ? AND missing_count <> 0`,
      )
      .run(now, providerId, fingerprint);
  }

  delete(providerId: string, fingerprint: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM ix_port_mappings WHERE provider_id = ? AND fingerprint = ?')
        .run(providerId, fingerprint).changes > 0
    );
  }
}
