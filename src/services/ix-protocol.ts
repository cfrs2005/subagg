/**
 * relay.example.com 转发平台（IX）的**线缆契约**：响应字段的形状、错误类型，
 * 以及不出站就能算清的那几件事（`page_size` 白名单校正、JWT 到期解析、
 * 凭据短引用、`mod_port` 全量 body 组装）。
 *
 * 定位：`services/ix-client.ts` 的下层。本文件**不发任何请求**、不碰 DB、
 * 不看时钟 —— 于是这里的每个函数都能被单测直接钉住（见 `test/ix-client.test.ts`），
 * 而客户端那边只剩"怎么发、怎么重试、怎么重登"。
 *
 * 字段名与类型全部照真实响应抄，不凭想象。
 */

import type { Logger } from '../logger.js';

// ─────────────────────────────────────────────────────────────
//  平台数据结构
// ─────────────────────────────────────────────────────────────

/** `POST /login` 的响应是**裸**对象，不是 `{success, data}` 包裹。 */
export interface IxLoginResponse {
  jwt: string;
  session_id: string;
}

/**
 * 一次登录换来的凭据。
 *
 * `expiresAt` 为 `null` 表示 JWT 的 `exp` 解不出来（格式变了）——
 * 此时放弃主动刷新，退化为"401 再重登"。刻意不猜一个默认有效期：
 * 猜短了白登、猜长了每个请求都先吃一发 401。
 */
export interface IxSession {
  jwt: string;
  sessionId: string;
  /** epoch 毫秒。来自 JWT payload 的 `exp`（实测 = 签发后 7 天）。 */
  expiresAt: number | null;
}

export interface IxPagination {
  current_page: number;
  page_size: number;
  total_items: number;
  total_pages: number;
}

export interface IxLatencySummary {
  sample_at: string;
  avg_latency_us: number;
  stddev_latency_us: number;
  packet_loss_rate: number;
  samples_count: number;
}

/** 该账号 `allow_forward:false`，所以只可能是 `direct`（见 `IX_FORWARD_DIRECT`）。 */
export interface IxForwardConfig {
  mode: string;
}

/**
 * 一个转发端口。真实响应有 57 个键，这里只把用得上的列成具名字段。
 *
 * 索引签名不是偷懒：`patchPort` 的 read-modify-write 要把**未知字段原样回填**
 * 才能不被 `mod_port` 的全量覆盖清空。平台日后加字段时，
 * 不改这里也不会造成数据丢失。代价是拼错的键名编译期查不出来——
 * 所以补丁走 `IxPortPatch`（无索引签名），拼错会报错。
 */
export interface IxPort {
  id: number;
  display_name: string;
  /** 入口主机名（`entry.relay.example`）。与 `port_v4` 一起构成中转入口。 */
  ip_addr: string;
  /** 入口端口，由平台在线路端口段内分配（`expected_port` 留空即自动分配）。 */
  port_v4: number;
  outbound_endpoint_id: number;
  line_name: string;
  target_address_list: string[];
  target_select_mode: number;
  test_method: number;
  forward_config: IxForwardConfig;
  enable_udp: boolean;
  exclude_from_subscription: boolean;
  is_suspended: boolean;
  tags: string[];
  traffic_in: number;
  traffic_out: number;
  current_latency_summary: IxLatencySummary | null;
  sync_error_message: string | null;
  sync_error_at: string | null;
  synced_to_worker_at: string | null;
  suspend_type: number | null;
  suspended_at: string | null;
  resume_at: string | null;
  period_traffic: number | null;
  period_traffic_limit_mode: number | null;
  allow_ip_num: number | null;
  allow_conn_num: number | null;
  expire_at: string | null;
  accept_proxy_protocol: boolean;
  send_proxy_protocol_version: number | null;
  custom_config: unknown;
  [key: string]: unknown;
}

export interface IxPortPage {
  ports: IxPort[];
  pagination: IxPagination;
}

/** `subscription.lines[]`：**端口配额在这一层**（`max_ports_number`），不是账户级。 */
export interface IxSubscriptionLine {
  id: number;
  display_name: string;
  ip_addr: string;
  is_online: boolean;
  port_start: number;
  port_end: number;
  allow_forward: boolean;
  allow_inbound_proxy: boolean;
  is_suspended: boolean;
  traffic_scale: number;
  /** 该线路允许的端口数上限。配额预检必须 per-line 算，账户顶层没有这个字段。 */
  max_ports_number: number;
  [key: string]: unknown;
}

/**
 * `GET /subscription` 的裸对象。
 *
 * 注意单位不一致：`traffic_used` 是**字节**，`traffic_total` 是 **GiB**
 * —— 实测 4967037106 字节 ≈ 4.63 GiB，对应 total 100。**直接相减是错的**，
 * 换算必须用 1024³（`services/ix-probe.ts` 的 `GIB` 就是这个值）；按 1000³ 算会
 * 让"已用/总量"凭空差出 7%，而这种偏差小到不会有人怀疑是单位错了。
 */
export interface IxSubscriptionInfo {
  id: number;
  username: string;
  valid_until: string;
  last_reset: string | null;
  next_reset: string | null;
  traffic_used: number;
  traffic_total: number;
  is_expired: boolean;
  is_admin: boolean;
  permissions: string[];
  allow_forward_endpoint: boolean;
  lines: IxSubscriptionLine[];
  [key: string]: unknown;
}

export interface IxLineDetail {
  line_id: number;
  line_name: string;
  entry_ip: string;
  traffic_scale: number;
  traffic_limit: number | null;
  used_traffic: number;
  /** 该线路当前已占用的端口数。与 `max_ports_number` 配对做配额预检。 */
  port_count: number;
  [key: string]: unknown;
}

/** 写操作（create / delete / suspend / …）的响应形状未实测，如实用宽类型。 */
export interface IxMutationResult {
  id?: number;
  message?: string;
  [key: string]: unknown;
}

/** `GET /test_latency` 的响应形状未实测（同步真实探测，可能很慢）。 */
export interface IxLatencyProbe {
  avg_latency_us?: number;
  packet_loss_rate?: number;
  samples_count?: number;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────
//  page_size 白名单
// ─────────────────────────────────────────────────────────────

/**
 * 服务端唯一接受的四个 `page_size`。传别的值**静默回落 20**、不报错。
 *
 * 后果：调用方以为一页 30 条、只读第一页，就静默漏掉后面的端口，
 * 而"漏掉"在认领链路上等于**重复创建**——30 个配额浪费不起。
 *
 * 导出给界面用：下拉框只应给这四个选项，而不是让用户随手填一个数字。
 */
export const IX_PAGE_SIZES = [20, 50, 100, 200] as const;
export type IxPageSize = (typeof IX_PAGE_SIZES)[number];

/**
 * 把任意数字校正到合法 `page_size`：取**不小于**请求值的最小合法值。
 *
 * 为什么是运行时校正而不是只靠联合类型：这个值常常来自配置、DB 或界面
 * （都是 `number`），编译期约束挡不住它们；而服务端的回落是静默的，
 * 一旦发生就表现为"分页少了几条"，排查起来毫无线索。
 *
 * 取"不小于"是为了不让实际页大小小于调用方的预期（少拿一页 = 多翻一页，
 * 无害；多拿几条 = 无害）。
 */
export function coerceIxPageSize(value: number | undefined, logger?: Logger): IxPageSize {
  if (value === undefined) return 20;
  const wanted = Math.trunc(value);
  if (!Number.isFinite(wanted)) return 20;

  let chosen: IxPageSize = 200;
  for (const size of IX_PAGE_SIZES) {
    if (wanted <= size) {
      chosen = size;
      break;
    }
  }
  if (chosen !== wanted) {
    logger?.warn('IX：page_size 不在白名单内，已校正', {
      requested: wanted,
      applied: chosen,
      allowed: [...IX_PAGE_SIZES],
    });
  }
  return chosen;
}

// ─────────────────────────────────────────────────────────────
//  错误
// ─────────────────────────────────────────────────────────────

/**
 * 404 的两种语义。**状态码本身区分不了**，只能看服务端文案：
 *
 * - `'permission'`：路由级隐藏式拒绝（`requiresAdmin` 挡下来），
 *   实测 body 是 `{"message":"Not Found","error_code":"404 Not Found"}`。
 *   结论应该是"当前账号没权限"，**不是**"平台没这个端点"。
 * - `'resource'`：资源不存在，或存在但不属于本人，
 *   实测 body 形如 `{"message":"Port not found or unauthorized",...}`。
 */
export type IxNotFoundKind = 'permission' | 'resource';

/**
 * 平台调用失败。`retryable` 的判据与 `FetchError` 完全一致：
 * 5xx / 429 / 网络抖动值得重试，4xx 是请求本身的问题，重试只会更快被限流。
 */
export class IxApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    /** 服务端 `error_code`，如 `"404 Not Found"`。HTTP 语义层。 */
    readonly errorCode?: string,
    /** 服务端 `api_error_code`，如 `RATE_LIMITED`。**业务码，供上层判断分支。** */
    readonly apiErrorCode?: string,
    readonly errorParams?: Record<string, unknown>,
    /** 仅 404 时有值。见 `IxNotFoundKind`。 */
    readonly notFoundKind?: IxNotFoundKind,
  ) {
    super(message);
    this.name = 'IxApiError';
  }
}

export interface IxErrorBody {
  message?: unknown;
  error_code?: unknown;
  api_error_code?: unknown;
  error_params?: unknown;
}

/**
 * 服务端 404 是"没有"还是"不给你看"。
 *
 * 判据：路由级拒绝给的是一模一样的通用文案 `Not Found`；资源级 404 会带上
 * 资源名（`Port not found or unauthorized`）。判不准时倒向 `'resource'`——
 * 那是更常见、也更无害的解释（重建一次即可；判成权限问题会让人白跑一趟
 * 去申请权限）。
 */
export function classifyNotFound(body: IxErrorBody | undefined): IxNotFoundKind {
  const message = typeof body?.message === 'string' ? body.message.trim().toLowerCase() : '';
  return message === '' || message === 'not found' ? 'permission' : 'resource';
}

/**
 * 404 文案里必须带的那句歧义说明。
 *
 * 平台**权限不足也返回 404 而非 403**（隐藏式拒绝）：把 404 当"端点不存在"
 * 会得出"平台没这个功能"的错误结论，实际是当前账号没权限
 * （`is_admin:false` 时 `/admin/*` 一律 404）。
 */
export const NOT_FOUND_HINT =
  '注意：该平台对权限不足也返回 404（隐藏式拒绝），所以这既可能是"资源不存在"，' +
  '也可能是"当前账号无权访问该端点，或该资源不属于本人"。';

// ─────────────────────────────────────────────────────────────
//  JWT
// ─────────────────────────────────────────────────────────────

/**
 * 从 JWT 里读出到期时间（epoch 毫秒）。
 *
 * **刻意不验签**：签名校验是服务端的事，我们手里没有密钥，也不需要——
 * 我们读 `exp` 只为了决定"要不要提前重登"，读错的唯一后果是多登一次或
 * 吃一发 401（两者都有兜底）。假装能验签反而会诱人写出"验过签所以可信"
 * 的逻辑。
 *
 * 实测 payload 只有 `{token_id, exp, sid}`，`exp` = 签发后 7 天。
 */
export function parseJwtExpiry(jwt: string): number | null {
  const parts = jwt.split('.');
  const payload = parts.length === 3 ? parts[1] : undefined;
  if (!payload) return null;

  try {
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const exp = (parsed as { exp?: unknown }).exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
    return exp * 1000;
  } catch {
    return null;
  }
}

/**
 * 凭据引用：取前 8 字符，用于在日志里指认"是哪一份凭据"。
 *
 * 与 `db/repo/sharing.ts` 的 `tokenRef()` 同口径。**字段名必须叫 `ref`**：
 * `logger.ts` 的 `SENSITIVE_KEYS` 是大小写不敏感子串匹配，叫 `apiKey`/`jwt`/
 * `ixToken` 会命中 `key`/`token` 被打成 `'***'`，日志就白记了。
 */
export function credentialRef(value: string): string {
  return value.slice(0, 8);
}

// ─────────────────────────────────────────────────────────────
//  mod_port 的全量 body
// ─────────────────────────────────────────────────────────────

/**
 * 唯一允许的 `forward_config`。
 *
 * 该账号 `allow_forward:false`、线路 `allow_forward:false`、
 * `allow_inbound_proxy:false` → relay / chain / tot / 入站代理一概不可用
 * （`/api/forward_endpoints` 实测直接 500）。所以这里写死，不开参数——
 * 开了参数只会让调用方去踩一个必然失败的分支。
 */
export const IX_FORWARD_DIRECT: Readonly<IxForwardConfig> = { mode: 'direct' };

/**
 * read-modify-write 时要**剔除**的字段：全是服务端计算/统计出来的，
 * 回填它们没有意义，还可能被服务端当成"想改状态"（例如 `is_suspended`）。
 *
 * 除此之外的字段（含平台日后新增的未知字段）一律原样回填 ——
 * `mod_port` 是全量覆盖，漏一个就清一个。
 */
const DERIVED_PORT_FIELDS: ReadonlySet<string> = new Set([
  'ip_addr',
  'port_v4',
  'line_name',
  'is_suspended',
  'suspend_type',
  'suspended_at',
  'traffic_in',
  'traffic_out',
  'entry_traffic_scale',
  'out_traffic_scale',
  'current_latency_summary',
  'last_edited_at',
  'updated_at',
  'synced_to_worker_at',
  'sync_error_message',
  'sync_error_at',
  'synced_server_names',
  'unsynced_server_names',
  'period_used_traffic',
  'period_used_traffic_in',
  'period_used_traffic_out',
]);

/**
 * 把一个完整 port 对象变成 `mod_port` 的 body：剔掉服务端计算字段，
 * 其余（含未知字段）原样回填。
 *
 * "原样回填未知字段"是刻意的：`mod_port` 全量覆盖，平台日后新增一个
 * 我们不认识的字段时，白名单式实现会静默把它清空，而回填式实现不会。
 */
export function modBodyFromPort(port: IxPort): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(port)) {
    if (DERIVED_PORT_FIELDS.has(key)) continue;
    body[key] = value;
  }
  body['id'] = port.id;
  return body;
}
