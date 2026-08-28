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
  {
    version: 4,
    name: 'ix_forwarding',
    sql: `
-- ── IX 中转服务商 ─────────────────────────────────────────
-- 一行 = 一个 L4 端口转发平台账号（当前只有 relay.example.com）。
CREATE TABLE ix_providers (
  id              TEXT PRIMARY KEY,
  name            TEXT    NOT NULL,
  -- API 基址，如 https://relay.example.com/api
  base_url        TEXT    NOT NULL,
  -- 'api-key' | 'login'。不加 CHECK 约束：既有表都没有这种先例，
  -- 收窄统一放在仓储的 to* 映射里做（带安全兜底），风格保持一致。
  auth_mode       TEXT    NOT NULL DEFAULT 'login',
  -- ⚠️ 以下三个 *_enc 列存的是 AES-256-GCM 密文（core/secret.ts 的
  -- "v1:<base64url>" 形态），**不是明文**。列名带 _enc 后缀就是为了让
  -- 任何人扫一眼 schema 就知道不能拿去直接用。
  -- 密钥从 ADMIN_TOKEN 派生 —— 轮换 ADMIN_TOKEN 后这些密文解不开，
  -- 届时应把 provider 标成"需重新录入凭据"并让 IX 节点不可用，不是让服务崩。
  api_key_enc     TEXT,
  username        TEXT,
  password_enc    TEXT,
  -- 登录换来的 JWT（实测 7 天过期）。缓存下来避免每次同步都重登。
  jwt_enc         TEXT,
  jwt_expires_at  INTEGER,
  -- 建端口时默认落在哪条线路上。NULL = 用平台返回的第一条。
  default_line_id INTEGER,
  enable_udp      INTEGER NOT NULL DEFAULT 1,
  -- Provider 总闸。关掉后关联 IX 派生节点不可用。
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_probe_at   INTEGER,
  last_error      TEXT,
  -- 平台返回的额度/线路快照原文 JSON。原样存、原样展示，不做任何推导
  -- （项目产品原则：不编造数据）。
  quota_json      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- ── 节点 ↔ 远端转发端口的映射 ──────────────────────────────
-- 主键用 (provider_id, fingerprint)：指纹是全系统节点主键，机场改名、
-- 上游刷新都不会动它，所以映射能跨刷新存活。
--
-- target_host / target_port 冗余存原节点地址，有两个用途：
--   ① 认领远端已有端口时精确比对 target_address_list（服务端的 target
--      筛选是**子串模糊**匹配，landing-a.example:200 会误命中 :2002 和 :2004，
--      必须在客户端再精确比一次）；
--   ② 校验"这条映射指向的还是不是这个节点"。
CREATE TABLE ix_port_mappings (
  provider_id      TEXT    NOT NULL REFERENCES ix_providers(id) ON DELETE CASCADE,
  fingerprint      TEXT    NOT NULL,
  -- 远端端口 id。NULL = 还没建/还没认领（state='pending'）。
  remote_port_id   INTEGER,
  -- 中转入口。端口号由平台分配，所以建成之前是 NULL —— 不给默认 0，
  -- 因为 port 0 是个能一路混进客户端配置的假值。
  entry_host       TEXT,
  entry_port       INTEGER,
  target_host      TEXT    NOT NULL,
  target_port      INTEGER NOT NULL,
  line_id          INTEGER,
  line_name        TEXT,
  -- 'pending' | 'active' | 'error' | 'orphan'
  state            TEXT    NOT NULL DEFAULT 'pending',
  last_error       TEXT,
  -- 平台 current_latency_summary 的原始口径：微秒整数、丢包率浮点。
  -- 注意这是「中转入口 → 原落地」那一段的延迟，不是端到端。
  latency_us       INTEGER,
  loss_rate        REAL,
  -- 字节数，平台原样返回。
  traffic_in       INTEGER,
  traffic_out      INTEGER,
  suspended        INTEGER NOT NULL DEFAULT 0,
  -- 平台侧的下发同步错误（sync_error_message），与 last_error 不是一回事：
  -- 那是我们调用 API 的错误，这是平台把配置推给转发节点时的错误。
  sync_error       TEXT,
  -- 连续几轮同步没在节点集里见到这个指纹。累到阈值即标 orphan。
  -- 按用户决策：只标记 + 界面高亮，绝不自动删远端端口。
  missing_count    INTEGER NOT NULL DEFAULT 0,
  remote_synced_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (provider_id, fingerprint)
);
-- 界面按状态筛（孤儿高亮、待创建列表）走这个索引。
CREATE INDEX idx_ix_map_state ON ix_port_mappings(state);
-- 按指纹跨 provider 反查（节点详情页要显示"这个节点走哪个中转"）。
-- 复合主键的前导列是 provider_id，单查指纹用不上它，得单独建。
CREATE INDEX idx_ix_map_fingerprint ON ix_port_mappings(fingerprint);
`,
  },
  {
    version: 5,
    name: 'ix_port_udp',
    sql: `
-- ── 端口级 UDP 转发能力 ────────────────────────────────────
-- 来源只有一个：GET /ports 里那个 port 的 enable_udp 字段。
--
-- 刻意**可空**，三态：1 = 转、0 = 不转、NULL = 还没同步过、事实未知。
--
-- NULL 绝不许被"顺手填个默认值"抹平。ix_providers.enable_udp 是我们**建端口时**
-- 用的请求参数，不是这个端口**当前**的状态 —— 用户在平台上手工关掉某个端口的
-- UDP，我们只能靠同步看见。拿默认值当事实，等于把"假装知道"当成"知道"：
-- hysteria2 / tuic / QUIC 这类本体跑在 UDP 上的节点会被当成可改写，输出一个
-- TCP 通、UDP 黑洞的死节点（最难归因的那种半坏）。
-- 保持 NULL 则 core 的 udpPolicy 会走"改写 + 留警告"，如实说"我还不知道"。
ALTER TABLE ix_port_mappings ADD COLUMN entry_udp INTEGER;
`,
  },
  {
    version: 6,
    name: 'ix_remote_port_refs',
    sql: `
-- 删除派生 IX 节点前必须确认同一远端端口没有其他本地引用。
CREATE INDEX idx_ix_map_remote_port
  ON ix_port_mappings(provider_id, remote_port_id);
`,
  },
  {
    version: 7,
    name: 'google_oidc_sessions',
    sql: `
-- Google proves identity only. The application owns accounts, sessions, revocation, and CSRF.
CREATE TABLE google_accounts (
  id             TEXT PRIMARY KEY,
  google_sub     TEXT NOT NULL UNIQUE,
  email          TEXT NOT NULL,
  email_verified INTEGER NOT NULL CHECK (email_verified IN (0, 1)),
  display_name   TEXT NOT NULL,
  avatar_url     TEXT,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER NOT NULL
);

CREATE INDEX idx_google_accounts_email ON google_accounts(email);

-- The browser holds high-entropy values; the database stores server-keyed HMAC values only.
CREATE TABLE web_sessions (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES google_accounts(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  csrf_hash    TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at   INTEGER
);

CREATE INDEX idx_web_sessions_account ON web_sessions(account_id);
CREATE INDEX idx_web_sessions_expiry ON web_sessions(expires_at);

-- OAuth attempts are single-use. State is hashed and the short-lived PKCE verifier is encrypted.
CREATE TABLE oauth_login_attempts (
  token_hash        TEXT PRIMARY KEY,
  state_hash        TEXT NOT NULL UNIQUE,
  nonce             TEXT NOT NULL,
  code_verifier_enc TEXT NOT NULL,
  expires_at        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  used_at           INTEGER
);

CREATE INDEX idx_oauth_attempt_expiry ON oauth_login_attempts(expires_at);
`,
  },
];
