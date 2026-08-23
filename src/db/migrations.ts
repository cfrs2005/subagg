/**
 * 数据库迁移。
 *
 * ## 为什么 SQL 内联在 TS 里而不是放 .sql 文件
 *
 * 因为 `npm run build` 只跑 `tsc`。如果迁移是独立的 `.sql` 文件，构建时就得
 * 额外加一个拷贝步骤，而这个步骤在 tsx（开发）、tsc（生产）、Docker
 * 三条路径上都得对 —— 一旦漏掉，服务会在启动时因为找不到迁移文件而崩溃，
 * 而且只在生产环境崩。
 *
 * 内联成字符串没有这个风险：迁移跟着代码走，不存在"文件没被打包进去"的可能。
 * 代价是 SQL 少了语法高亮，相对于部署可靠性来说是划算的。
 *
 * ## 迁移规则
 *
 * - 迁移**只增不改**。已发布的迁移不许编辑，要改就追加新的一条。
 * - 每条迁移在一个事务里执行，失败则整体回滚。
 * - `version` 必须连续递增。
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
-- ── 订阅源 ────────────────────────────────────────────────
CREATE TABLE subscriptions (
  id              TEXT PRIMARY KEY,
  name            TEXT    NOT NULL,
  -- 上游订阅 URL。内含机场给的 token，属于凭据。
  url             TEXT    NOT NULL,
  -- 'auto' | 'clash' | 'uri-list'。auto 走格式嗅探。
  format          TEXT    NOT NULL DEFAULT 'auto',
  -- 自动同步间隔（小时）
  update_interval INTEGER NOT NULL DEFAULT 12,
  enabled         INTEGER NOT NULL DEFAULT 1,
  -- 抓取时使用的 UA。留空则用全局配置值。
  -- 个别机场只对特定 UA 返回完整节点列表，所以需要能单独覆盖。
  user_agent      TEXT,
  last_sync_at    INTEGER,
  -- 上次同步的错误信息。非空表示该订阅当前处于故障状态。
  last_error      TEXT,
  -- HTTP ETag，用于条件请求，避免重复下载未变更的内容
  etag            TEXT,
  node_count      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

-- ── 节点 ──────────────────────────────────────────────────
-- 主键是 (subscription_id, fingerprint) 而不是单独的 fingerprint：
-- 同一台服务器可能同时出现在两个订阅源里（机场之间互相转售落地机），
-- 我们要保留两条记录以便展示来源，去重交给过滤引擎按需处理。
CREATE TABLE nodes (
  subscription_id TEXT    NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  fingerprint     TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  type            TEXT    NOT NULL,
  server          TEXT    NOT NULL,
  port            INTEGER NOT NULL,
  region          TEXT,
  -- 完整 ProxyNode 的 JSON。冗余存储 name/type/server/port 是为了能直接
  -- 用 SQL 做筛选与排序，不必把所有节点读进内存再过滤。
  payload         TEXT    NOT NULL,
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, fingerprint)
);
CREATE INDEX idx_nodes_fingerprint ON nodes(fingerprint);
CREATE INDEX idx_nodes_region      ON nodes(region);

-- ── 配置文件（过滤规则集）──────────────────────────────────
CREATE TABLE profiles (
  id             TEXT PRIMARY KEY,
  name           TEXT    NOT NULL,
  description    TEXT    NOT NULL DEFAULT '',
  icon           TEXT    NOT NULL DEFAULT '📦',
  -- FilterRule 的 JSON 序列化
  rule           TEXT    NOT NULL DEFAULT '{}',
  -- UA 认不出客户端时使用的输出格式
  default_target TEXT    NOT NULL DEFAULT 'clash.meta',
  -- 'sum' | 'off' | 'follow:<subscription_id>'
  userinfo_mode  TEXT    NOT NULL DEFAULT 'sum',
  -- 写进 Profile-Update-Interval 响应头，告诉客户端多久来拉一次
  update_interval INTEGER NOT NULL DEFAULT 12,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- ── 共享好友 ──────────────────────────────────────────────
CREATE TABLE friends (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT '#6366f1',
  created_at INTEGER NOT NULL
);

-- ── 订阅 token ────────────────────────────────────────────
-- 每个 token 指向一个 profile，可选地绑定一位好友。
-- 独立 token 意味着可以**单独吊销**某一个人的访问，而不影响其他人。
CREATE TABLE tokens (
  token          TEXT PRIMARY KEY,
  profile_id     TEXT    NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  friend_id      TEXT             REFERENCES friends(id)  ON DELETE SET NULL,
  label          TEXT    NOT NULL DEFAULT '',
  revoked        INTEGER NOT NULL DEFAULT 0,
  expires_at     INTEGER,
  created_at     INTEGER NOT NULL,
  -- 冗余的访问统计。可以从 access_log 聚合出来，但那是每次列表查询都要
  -- 扫一遍日志表；直接维护计数器让"共享管理"页面的加载成本恒定。
  last_access_at INTEGER,
  access_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_tokens_profile ON tokens(profile_id);
CREATE INDEX idx_tokens_friend  ON tokens(friend_id);

-- ── 流量快照 ──────────────────────────────────────────────
-- 每次同步记一条。存历史而非只存当前值，是为了能算出增量
-- （"这周用掉了多少"），单个当前值回答不了这个问题。
CREATE TABLE traffic_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT    NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  ts              INTEGER NOT NULL,
  upload          INTEGER NOT NULL,
  download        INTEGER NOT NULL,
  -- NULL 表示不限量 / 不过期，与 0 的含义不同
  total           INTEGER,
  expire          INTEGER
);
CREATE INDEX idx_traffic_sub_ts ON traffic_snapshots(subscription_id, ts DESC);

-- ── 访问日志 ──────────────────────────────────────────────
-- 这是"共享管理"里**唯一真实**的数据来源。
-- 好友的代理流量直连代理服务器、不经过 subagg，所以我们无法知道对方
-- 用掉了多少 GB；能且只能记录订阅链接的拉取行为。
CREATE TABLE access_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT    NOT NULL,
  profile_id TEXT    NOT NULL,
  friend_id  TEXT,
  ts         INTEGER NOT NULL,
  -- 从 UA 识别出的客户端名，如 'Shadowrocket'
  client     TEXT    NOT NULL,
  user_agent TEXT    NOT NULL,
  -- HMAC-SHA256(salt, ip) 的前若干位。不存明文 IP。
  ip_hash    TEXT    NOT NULL,
  target     TEXT    NOT NULL,
  node_count INTEGER NOT NULL,
  bytes      INTEGER NOT NULL
);
CREATE INDEX idx_access_token_ts  ON access_log(token, ts DESC);
CREATE INDEX idx_access_friend_ts ON access_log(friend_id, ts DESC);
`,
  },
  {
    version: 2,
    name: 'token_quotas',
    sql: `
ALTER TABLE tokens ADD COLUMN max_access INTEGER;
ALTER TABLE tokens ADD COLUMN quota_window_hours INTEGER;
ALTER TABLE tokens ADD COLUMN source_limit INTEGER;
`,
  },
  {
    version: 3,
    name: 'node_ping_history',
    sql: `
-- 每次 TCP 连通性测试留一条快照。fingerprint 不含代理凭据，
-- 不记录完整节点 URI，避免把敏感字段复制到历史表。
CREATE TABLE node_ping_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT    NOT NULL,
  ts         INTEGER NOT NULL,
  ok         INTEGER NOT NULL,
  latency_ms INTEGER,
  error      TEXT
);
CREATE INDEX idx_node_ping_fingerprint_ts ON node_ping_history(fingerprint, ts DESC);
`,
  },
];
