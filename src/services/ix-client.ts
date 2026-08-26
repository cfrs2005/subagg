/**
 * relay.example.com 转发平台（IX）API 客户端。
 *
 * 定位：services 层唯一与 zf 平台通信的出口。**渲染热路径绝不调用它** ——
 * `/sub/:token` 只读本地映射表，平台挂了订阅照常出。
 *
 * 全部约定照抄 `services/fetcher.ts`（超时用 `AbortSignal.timeout`、
 * `retryable` 区分"重试有用/无用"、指数退避 `1000 * 2 ** attempt`、
 * 流式读取 + 响应体上限）。零新增依赖，用 Node 20+ 原生 `fetch`。
 *
 * 本文件只管**怎么发**（认证、翻页、重试、重登、传输）。平台响应的形状、
 * `IxApiError`、以及不出站就能算清的纯逻辑（`page_size` 校正、JWT `exp` 解析、
 * `mod_port` 全量 body 组装）都在 `ix-protocol.ts` —— 那些是能被单测直接钉住的部分。
 *
 * ## 三个已实测的平台坑（改代码前先读，别"优化"掉）
 *
 * 1. **`page_size` 只接受 `{20,50,100,200}`**，其他值服务端**静默回落 20**、
 *    不报错。后果：调用方以为一页 30 条、只读第一页，就静默漏掉后面的端口，
 *    而"漏掉"在认领链路上等于**重复创建**——30 个配额浪费不起。
 *    所以本客户端**永远显式发送 page_size**，并在发送前把它校正到合法值。
 *
 * 2. **权限不足返回 404 而非 403**（隐藏式拒绝）。后果：把 404 当"端点不存在"
 *    会得出"平台没这个功能"的错误结论，实际是当前账号没权限（`is_admin:false`
 *    时 `/admin/*` 一律 404）。本客户端把 404 分成两种语义
 *    （见 `IxNotFoundKind`），并在错误文案里把歧义写清楚。
 *
 * 3. **`POST /mod_port` 是全量覆盖**。后果：只想改 `display_name` 却直接发
 *    `{id, display_name}`，会把 `tags` / `period_traffic` / `allow_ip_num` /
 *    `expire_at` / `inbound_proxy` 全部清空——而且服务端不会报错。
 *    所以本客户端**不提供"发部分字段"的入口**：`modPort()` 只吃完整对象，
 *    需要改一个字段就用 `patchPort()`，它内部强制 read-modify-write。
 *    这个陷阱必须封在 API 里，不能留给调用方记性。
 *
 * ## 一条附带的安全约定
 *
 * `redirect: 'manual'`（与 fetcher.ts 的 `'follow'` 刻意不同）。机场订阅确实
 * 常 302，但 API 不该 302；而 `fetch` 跨 origin 重定向时**不会**剥掉自定义头，
 * 于是 `X-API-Key` 会被原样送到重定向目标。API 侧宁可报错让人去修 baseUrl。
 */

import type { Logger } from '../logger.js';
import {
  classifyNotFound,
  coerceIxPageSize,
  credentialRef,
  IxApiError,
  IX_FORWARD_DIRECT,
  modBodyFromPort,
  NOT_FOUND_HINT,
  parseJwtExpiry,
  type IxErrorBody,
  type IxLatencyProbe,
  type IxLineDetail,
  type IxLoginResponse,
  type IxMutationResult,
  type IxPort,
  type IxPortPage,
  type IxSession,
  type IxSubscriptionInfo,
} from './ix-protocol.js';

// ─────────────────────────────────────────────────────────────
//  JWT 的过期策略
// ─────────────────────────────────────────────────────────────

/**
 * 提前多久把 JWT 视为过期。刚好卡在到期线上发出去的请求会在路上超时。
 *
 * 只有"提前多久"这条策略留在客户端；`exp` 怎么读出来是纯计算，
 * 在 `ix-protocol.ts` 的 `parseJwtExpiry`。
 */
const JWT_EXPIRY_SKEW_MS = 5 * 60_000;

// ─────────────────────────────────────────────────────────────
//  客户端
// ─────────────────────────────────────────────────────────────

/**
 * 认证双模。两者在同一批端点上互为替代：
 *
 * - `'api-key'`：管理员发的长期 Key，走 `X-API-Key`。长期方案。
 * - `'login'`：账号密码换 7 天 JWT，走 `Authorization: Bearer`。
 *   实测账号 `is_admin:false` 拿不到 Key，所以这是当前唯一可用方案。
 */
export type IxAuth =
  | { mode: 'api-key'; apiKey: string }
  | {
      mode: 'login';
      username: string;
      password: string;
      /**
       * 上次持久化下来的会话（有就直接用，不必先登一次）。
       *
       * 为什么是"构造参数 + 回调"而不是 `loadCachedJwt()` 钩子：加载是**一次性**
       * 的（构造时给一次就够），保存是**事件性**的（只在登录成功时发生）。
       * 若做成每次请求都调 `loadCachedJwt()`，就等于把一次同步 DB 读放进了
       * 每个出站请求的热路径上，还得处理"DB 里的比内存里的新"这种伪问题。
       * 客户端自己**绝不碰 DB**——持久化是调用方（`services/ix.ts`）的职责。
       */
      session?: IxSession | null;
      /** 拿到新 JWT 时回调，供调用方加密落库。抛异常不影响本次请求。 */
      onSession?: (session: IxSession) => void;
    };

export interface IxClientOptions {
  /** 形如 `https://relay.example.com/api`（末尾斜杠会被去掉）。 */
  baseUrl: string;
  auth: IxAuth;
  logger?: Logger;
  /** 普通请求超时。 */
  timeoutMs?: number;
  /** `GET /test_latency` 是**同步真实探测**，可能很慢，单独给一个宽超时。 */
  latencyTimeoutMs?: number;
  retries?: number;
  maxBytes?: number;
  userAgent?: string;
  /** 退避基数。默认 1000（与 fetcher.ts 一致）；测试里调小以免空等。 */
  backoffBaseMs?: number;
  /** 注入时钟，便于测"距 exp 不足 5 分钟"这类边界。 */
  now?: () => number;
}

export interface IxListPortsQuery {
  page?: number;
  /** 非法值会被 `coerceIxPageSize` 校正——服务端的静默回落挡不住。 */
  pageSize?: number;
  /**
   * 目标地址筛选。**服务端是子串模糊匹配**：查 `landing-a.example` 会同时返回
   * `:2002` 和 `:2004`。要精确认领必须用 `findPortByTarget()`。
   */
  target?: string;
}

export interface IxCreatePortInput {
  displayName: string;
  /** 线路 id（= `subscription.lines[].id` = `line_details[].line_id`）。 */
  outboundEndpointId: number;
  /** `["host:port"]`，支持域名与 `[ipv6]:port`。 */
  targetAddressList: readonly string[];
  /** 留空（null）= 平台在线路端口段内自动分配。默认 null。 */
  expectedPort?: number | null;
  enableUdp?: boolean;
  tags?: readonly string[];
  excludeFromSubscription?: boolean;
  expireAt?: string | null;
}

/**
 * `patchPort` 的补丁。**刻意没有索引签名**：这里拼错键名必须编译期报错，
 * 否则拼错的键会被当作"新字段"发出去，而真正想改的字段一动不动。
 */
export interface IxPortPatch {
  display_name?: string;
  outbound_endpoint_id?: number;
  target_address_list?: string[];
  target_select_mode?: number;
  test_method?: number;
  enable_udp?: boolean;
  exclude_from_subscription?: boolean;
  accept_proxy_protocol?: boolean;
  send_proxy_protocol_version?: number | null;
  tags?: string[];
  custom_config?: unknown;
  period_traffic?: number | null;
  period_traffic_limit_mode?: number | null;
  allow_ip_num?: number | null;
  allow_conn_num?: number | null;
  expire_at?: string | null;
}

/** 翻页上限。防止服务端 `total_pages` 异常时把客户端拖进死循环。 */
const MAX_PAGES = 50;

interface RequestSpec {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  search?: URLSearchParams;
  body?: unknown;
  /** `false` = 不带认证头（只有 `/login` 用）。 */
  auth?: boolean;
  timeoutMs?: number;
}

export class IxClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly latencyTimeoutMs: number;
  private readonly retries: number;
  private readonly maxBytes: number;
  private readonly userAgent: string;
  private readonly backoffBaseMs: number;
  private readonly now: () => number;
  private readonly logger?: Logger;
  private readonly auth: IxAuth;

  private session: IxSession | null;
  /** 并发去重：多个请求同时发现 JWT 过期时只登一次，别把账号打死。 */
  private loginInFlight: Promise<IxSession> | null = null;

  constructor(options: IxClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.latencyTimeoutMs = options.latencyTimeoutMs ?? 60_000;
    this.retries = options.retries ?? 2;
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    this.userAgent = options.userAgent ?? 'subagg/0.1';
    this.backoffBaseMs = options.backoffBaseMs ?? 1000;
    this.now = options.now ?? (() => Date.now());
    this.auth = options.auth;
    if (options.logger) this.logger = options.logger;
    this.session = options.auth.mode === 'login' ? (options.auth.session ?? null) : null;
  }

  /** 当前内存里的会话。调用方可用它决定要不要落库。 */
  currentSession(): IxSession | null {
    return this.session;
  }

  // ── 认证 ────────────────────────────────────────────

  /**
   * 换一份新 JWT。
   *
   * `POST /login` 返回**裸** `{jwt, session_id}` —— 不是 `{success, data}` 包裹，
   * 别照别的端点的样子去解。
   */
  async login(): Promise<IxSession> {
    if (this.auth.mode !== 'login') {
      throw new IxApiError('当前是 API Key 模式，无需登录（也拿不到 JWT）', false);
    }
    if (this.loginInFlight) return this.loginInFlight;

    const { username, password, onSession } = this.auth;
    const task = (async (): Promise<IxSession> => {
      const res = await this.request<IxLoginResponse>({
        method: 'POST',
        path: '/login',
        body: { username, password },
        auth: false,
      });
      if (!res || typeof res.jwt !== 'string' || res.jwt === '') {
        throw new IxApiError('登录响应里没有 jwt 字段（平台契约可能变了）', false);
      }
      const session: IxSession = {
        jwt: res.jwt,
        sessionId: typeof res.session_id === 'string' ? res.session_id : '',
        expiresAt: parseJwtExpiry(res.jwt),
      };
      this.session = session;
      this.logger?.info('IX：登录成功', {
        ref: credentialRef(session.sessionId),
        expiresAt: session.expiresAt,
      });
      try {
        onSession?.(session);
      } catch (err) {
        // 持久化失败不该让这次业务请求失败 —— 内存里已经有可用 JWT
        this.logger?.warn('IX：会话持久化回调抛异常，已忽略', {
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      return session;
    })();

    this.loginInFlight = task;
    try {
      return await task;
    } finally {
      this.loginInFlight = null;
    }
  }

  /** 会话是否已（提前 5 分钟）过期。`expiresAt` 为 null 时当作没过期，靠 401 兜底。 */
  private sessionExpired(session: IxSession): boolean {
    if (session.expiresAt === null) return false;
    return this.now() >= session.expiresAt - JWT_EXPIRY_SKEW_MS;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (this.auth.mode === 'api-key') {
      return { 'X-API-Key': this.auth.apiKey };
    }
    const current = this.session;
    const session = current && !this.sessionExpired(current) ? current : await this.login();
    return { Authorization: `Bearer ${session.jwt}` };
  }

  // ── 端点 ────────────────────────────────────────────

  /** 账户额度 / 到期 / 线路能力。端口配额在 `lines[].max_ports_number`。 */
  async subscriptionInfo(): Promise<IxSubscriptionInfo> {
    return this.requireBody(await this.request<IxSubscriptionInfo>({ method: 'GET', path: '/subscription' }), '/subscription');
  }

  /** 线路清单（含实时 `port_count`，配额预检要用）。 */
  async lineDetails(): Promise<IxLineDetail[]> {
    const res = await this.request<{ line_details?: IxLineDetail[] }>({ method: 'GET', path: '/line_details' });
    return res?.line_details ?? [];
  }

  /** 端口列表。响应是裸 `{ports, pagination}`。 */
  async listPorts(query: IxListPortsQuery = {}): Promise<IxPortPage> {
    const search = new URLSearchParams();
    const page = query.page !== undefined && Number.isFinite(query.page) ? Math.max(1, Math.trunc(query.page)) : 1;
    // page_size 永远显式发送：省略它 = 依赖服务端默认值，而服务端对非法值的
    // 回落是静默的，两件事叠在一起就没人能解释"为什么少了几条"。
    search.set('page', String(page));
    search.set('page_size', String(coerceIxPageSize(query.pageSize, this.logger)));
    if (query.target !== undefined) search.set('target', query.target);

    const res = await this.request<IxPortPage>({ method: 'GET', path: '/ports', search });
    return {
      ports: res?.ports ?? [],
      pagination: res?.pagination ?? { current_page: page, page_size: 20, total_items: 0, total_pages: 0 },
    };
  }

  /** 翻完所有页。`page_size` 固定 200（合法上限），少翻几次是少几次限流风险。 */
  async *iteratePorts(query: Omit<IxListPortsQuery, 'page' | 'pageSize'> = {}): AsyncGenerator<IxPort> {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await this.listPorts({ ...query, page, pageSize: 200 });
      for (const port of result.ports) yield port;
      if (result.ports.length === 0 || page >= result.pagination.total_pages) return;
    }
    this.logger?.warn('IX：端口翻页触达上限，可能还有未读取的端口', { maxPages: MAX_PAGES });
  }

  async listAllPorts(query: Omit<IxListPortsQuery, 'page' | 'pageSize'> = {}): Promise<IxPort[]> {
    const out: IxPort[] = [];
    for await (const port of this.iteratePorts(query)) out.push(port);
    return out;
  }

  /**
   * 按 id 取单个端口。
   *
   * 平台**没有** `GET /ports/:id`（端点清单里没有），只能翻页找。
   * `patchPort` 依赖它做 read-modify-write，所以这条路虽然笨，但必须有。
   */
  async getPort(id: number): Promise<IxPort> {
    for await (const port of this.iteratePorts()) {
      if (port.id === id) return port;
    }
    throw new IxApiError(
      `端口 ${id} 不在当前账号的端口列表里。${NOT_FOUND_HINT}`,
      false,
      404,
      undefined,
      undefined,
      undefined,
      'resource',
    );
  }

  /**
   * 建端口。
   *
   * body 发**全量**：前端也是这么做的，缺省字段会被服务端当 null 处理，
   * 而 null 与"默认值"在这个平台上不是一回事（例如 `enable_udp`）。
   */
  async createPort(input: IxCreatePortInput): Promise<IxMutationResult> {
    const body = {
      display_name: input.displayName,
      outbound_endpoint_id: input.outboundEndpointId,
      target_address_list: [...input.targetAddressList],
      // null = 平台自动分配。写死一个具体端口只会撞上"已被占用"
      expected_port: input.expectedPort ?? null,
      target_select_mode: 0,
      test_method: 0,
      forward_config: { ...IX_FORWARD_DIRECT },
      enable_udp: input.enableUdp ?? true,
      accept_proxy_protocol: false,
      send_proxy_protocol_version: null,
      exclude_from_subscription: input.excludeFromSubscription ?? false,
      custom_config: null,
      tags: input.tags ? [...input.tags] : [],
      period_traffic_limit_mode: 0,
      expire_at: input.expireAt ?? null,
    };
    const res = await this.request<IxMutationResult>({ method: 'POST', path: '/ports', body });
    this.logger?.info('IX：已创建转发端口', {
      line: input.outboundEndpointId,
      target: body.target_address_list.join(','),
      portId: res?.id,
    });
    return res ?? {};
  }

  /**
   * 改端口。**只吃完整对象** —— 这是刻意的：`mod_port` 是全量覆盖，
   * 开一个"只发几个字段"的入口就等于开一个静默清空 `tags`/`expire_at`/
   * `period_traffic`/`allow_ip_num`/`inbound_proxy` 的口子。
   *
   * 只想改一两个字段请用 `patchPort()`。
   */
  async modPort(port: IxPort): Promise<IxMutationResult> {
    const res = await this.request<IxMutationResult>({
      method: 'POST',
      path: '/mod_port',
      body: modBodyFromPort(port),
    });
    return res ?? {};
  }

  /**
   * 改端口的若干字段：**内部先 GET 回完整对象再合并**。
   *
   * 这就是把"全量覆盖"这个陷阱强制封在 API 里的地方。调用方不需要知道
   * `mod_port` 会清空什么，也就不可能忘。
   */
  async patchPort(id: number, patch: IxPortPatch): Promise<IxMutationResult> {
    const current = await this.getPort(id);
    const body = { ...modBodyFromPort(current), ...patch };
    const res = await this.request<IxMutationResult>({ method: 'POST', path: '/mod_port', body });
    this.logger?.info('IX：已更新转发端口', { portId: id, fields: Object.keys(patch) });
    return res ?? {};
  }

  /** 删端口。**DELETE 带 body `{id}`** —— 不是 `/ports/:id`。 */
  async deletePort(id: number): Promise<IxMutationResult> {
    const res = await this.request<IxMutationResult>({ method: 'DELETE', path: '/ports', body: { id } });
    this.logger?.info('IX：已删除转发端口', { portId: id });
    return res ?? {};
  }

  /** 批量触发/查询同步状态。 */
  async portsSyncStatus(portIds: readonly number[]): Promise<IxMutationResult> {
    const res = await this.request<IxMutationResult>({
      method: 'POST',
      path: '/ports_sync_status',
      body: { port_ids: [...portIds] },
    });
    return res ?? {};
  }

  /** 同步真实探测，可能很慢 —— 走 `latencyTimeoutMs` 而不是普通超时。 */
  async testLatency(portId: number): Promise<IxLatencyProbe> {
    const search = new URLSearchParams({ port_id: String(portId) });
    const res = await this.request<IxLatencyProbe>({
      method: 'GET',
      path: '/test_latency',
      search,
      timeoutMs: this.latencyTimeoutMs,
    });
    return res ?? {};
  }

  async suspendPort(id: number, options: { suspendType?: number | null; resumeAt?: string | null } = {}): Promise<IxMutationResult> {
    const body: Record<string, unknown> = { id };
    if (options.suspendType !== undefined) body['suspend_type'] = options.suspendType;
    if (options.resumeAt !== undefined) body['resume_at'] = options.resumeAt;
    const res = await this.request<IxMutationResult>({ method: 'POST', path: '/suspend_port', body });
    return res ?? {};
  }

  async resumePort(id: number): Promise<IxMutationResult> {
    const res = await this.request<IxMutationResult>({ method: 'POST', path: '/resume_port', body: { id } });
    return res ?? {};
  }

  /**
   * 幂等认领的基石：找出**恰好**转发到 `host:port` 的那个端口。
   *
   * **绝不能直接信服务端的筛选结果** —— `target` 是子串模糊匹配，
   * 实测查 `landing-a.example` 会同时返回 `:2002` 和 `:2004`，查 `landing-a.example:200`
   * 会同时误命中 `:2002` / `:2004`。若把第一条命中当成"已存在"直接认领，
   * 就会把 A 节点的流量指到 B 节点的落地上——一个不会报错、只会"莫名连错机器"
   * 的故障。所以拿到候选后必须在客户端逐个精确比对 `target_address_list`。
   *
   * 比对忽略大小写：主机名本身大小写不敏感，端口是数字，不影响精确性。
   */
  async findPortByTarget(target: string): Promise<IxPort | undefined> {
    const wanted = target.trim().toLowerCase();
    if (wanted === '') return undefined;

    let candidates = 0;
    for await (const port of this.iteratePorts({ target })) {
      candidates += 1;
      const exact = port.target_address_list?.some((addr) => addr.trim().toLowerCase() === wanted);
      if (exact) return port;
    }
    if (candidates > 0) {
      this.logger?.debug('IX：target 模糊命中但无精确匹配，视为未认领', { target, candidates });
    }
    return undefined;
  }

  // ── 传输 ────────────────────────────────────────────

  /**
   * 发一次请求，按需重试 / 重登。
   *
   * 401 的处理是本方法唯一的特殊分支：JWT 过期或被服务端主动失效时重登
   * **恰好一次**再重试原请求。第二次仍 401 就抛错，**不再重登** ——
   * 无限重登会把账号打死（平台一旦启用风控/验证码，这条链路就彻底废了）。
   * 重登不占用重试预算：它不是"再试试看"，而是修正了一个确定的原因。
   */
  private async request<T>(spec: RequestSpec): Promise<T | undefined> {
    const canReauth = spec.auth !== false && this.auth.mode === 'login';
    let reauthed = false;
    let attempt = 0;

    for (;;) {
      try {
        return await this.attempt<T>(spec);
      } catch (err) {
        const error = toIxApiError(err);

        if (error.status === 401 && canReauth && !reauthed) {
          reauthed = true;
          this.session = null;
          // 字段名是 `endpoint` 而不是 `path`：`redact` 会对 `path` 字段套
          // `redactPath()`，而它把长度 ≥ 12 的路径段当 token 打码 ——
          // `/subscription` 会被记成 `/sub***ion`，日志白记（见 logger.ts:146）。
          this.logger?.warn('IX：收到 401，重新登录一次后重试', { endpoint: spec.path });
          await this.login();
          continue;
        }

        if (!error.retryable || attempt >= this.retries) throw error;
        await sleep(this.backoffBaseMs * 2 ** attempt);
        attempt += 1;
      }
    }
  }

  private async attempt<T>(spec: RequestSpec): Promise<T | undefined> {
    const query = spec.search && [...spec.search.keys()].length > 0 ? `?${spec.search.toString()}` : '';
    const url = `${this.baseUrl}${spec.path}${query}`;
    const timeoutMs = spec.timeoutMs ?? this.timeoutMs;

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: 'application/json',
    };
    if (spec.auth !== false) Object.assign(headers, await this.authHeaders());

    let payload: string | undefined;
    if (spec.body !== undefined) {
      payload = JSON.stringify(spec.body);
      headers['Content-Type'] = 'application/json';
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: spec.method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        // 见文件头：API 不该 302，而跨 origin 重定向不会剥掉 X-API-Key
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new IxApiError(isTimeout ? `请求超时（${timeoutMs}ms）` : `网络错误：${reason}`, true);
    }

    // `redirect: 'manual'` 下 undici 按规范返回 opaqueredirect（status 0、无 body），
    // 而不是原始的 3xx —— 两种形态都要认，否则会变成一条看不懂的 "HTTP 0"。
    if (res.type === 'opaqueredirect' || res.status === 0 || (res.status >= 300 && res.status < 400)) {
      throw new IxApiError(
        `平台返回了重定向（HTTP ${res.status || '3xx'}）。baseUrl 可能配错了；` +
          '本客户端刻意不跟随重定向，以免把凭据头送到别的域名。',
        false,
        res.status || 302,
      );
    }

    const text = await readWithLimit(res, this.maxBytes);
    const parsed = parseJsonBody(text);

    if (!res.ok) throw this.toHttpError(res.status, res.statusText, parsed, text, spec);

    return parsed as T | undefined;
  }

  private toHttpError(
    status: number,
    statusText: string,
    parsed: unknown,
    raw: string,
    spec: RequestSpec,
  ): IxApiError {
    const body: IxErrorBody | undefined = parsed && typeof parsed === 'object' ? (parsed as IxErrorBody) : undefined;
    const message = typeof body?.message === 'string' ? body.message : '';
    const errorCode = typeof body?.error_code === 'string' ? body.error_code : undefined;
    const apiErrorCode = typeof body?.api_error_code === 'string' ? body.api_error_code : undefined;
    const errorParams =
      body?.error_params && typeof body.error_params === 'object'
        ? (body.error_params as Record<string, unknown>)
        : undefined;

    // 判据与 fetcher.ts:96-101 完全一致
    const retryable = status >= 500 || status === 429;
    const detail = message || raw.slice(0, 80) || statusText || '（无响应体）';

    if (status === 404) {
      const kind = classifyNotFound(body);
      // `endpoint` 而不是 `path`，理由同 request() 里那条注释
      this.logger?.warn('IX：请求被 404 拒绝', { endpoint: spec.path, kind, code: errorCode });
      return new IxApiError(
        `zf 返回 404：${detail}。${NOT_FOUND_HINT}`,
        false,
        404,
        errorCode,
        apiErrorCode,
        errorParams,
        kind,
      );
    }

    return new IxApiError(
      `zf 返回 HTTP ${status}：${detail}`,
      retryable,
      status,
      errorCode,
      apiErrorCode,
      errorParams,
    );
  }

  /** 端点契约要求必有响应体时用它，把"空响应"变成一条可读错误而不是运行时崩。 */
  private requireBody<T>(value: T | undefined, path: string): T {
    if (value === undefined || value === null) {
      throw new IxApiError(`${path} 返回了空响应体（平台契约可能变了）`, false);
    }
    return value;
  }
}

// ─────────────────────────────────────────────────────────────
//  辅助
// ─────────────────────────────────────────────────────────────

function toIxApiError(err: unknown): IxApiError {
  if (err instanceof IxApiError) return err;
  return new IxApiError(err instanceof Error ? err.message : String(err), false);
}

function parseJsonBody(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // 非 JSON 响应（HTML 错误页、人机验证、反代的 502 页面）在成功路径上
    // 也可能出现，交给上层按状态码判断，这里不抛。
    return undefined;
  }
}

/**
 * 边读边计数，超限立即断开。
 *
 * 与 `fetcher.ts:128` 同一份逻辑（那边未导出，此处不改别人的文件）。
 * 不用 `res.text()` 的原因同上：那样上限来不及生效，内存已经被吃掉了。
 */
async function readWithLimit(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new IxApiError(
          `响应体超过上限（> ${Math.round(maxBytes / 1024)} KiB），已中断。` +
            '这通常意味着该地址返回的不是 zf 平台的 API 响应。',
          false,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
