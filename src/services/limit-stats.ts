/**
 * 限流命中计数器。
 *
 * 存在的理由很具体：三层限流的 429 此前**在任何地方都留不下痕迹** ——
 * IP 层混在 `setErrorHandler` 的 `level:"error"` 里，token 层与配额层
 * 既不写日志、也不写 `access_log`（被拒的请求走不到 `record()`）。
 * 于是"我怀疑客户端收到了 429"这种问题只能靠猜。
 *
 * ## 为什么不落库
 *
 * **绝不能写进 `access_log`**：`usageForToken()` 直接 `COUNT(*)` 那张表来判定配额，
 * 多出来的 429 行会让**被拒的请求也扣配额** —— 一次限流风暴就能把一条链接的
 * 额度烧光、把 429 变成永久 404；`COUNT(DISTINCT ip_hash)` 也会被污染，
 * 让"链接被转发"的告警变成假阳性。
 *
 * 单开一张表则要付一次迁移、一个仓储、一条清理任务。而眼下要回答的问题
 * 是"到底有没有发生"——**存在性**问题，一个进程内计数器加一条结构化日志就够了。
 *
 * ## 代价，要如实讲
 *
 * 进程重启即清零。所以对外展示时**必须带上 `since`**，说清这是"自本次启动以来"，
 * 不能假装成历史统计。
 *
 * 如果修好配额与 trustProxy 之后 `ip` 计数仍持续非零，说明存在需要按时间、
 * 按链接归因的真实滥用 —— 那才是加 `rate_limit_log` 表（独立表，
 * **绝不复用 `access_log`**）的时机。
 */

/** 限流层次。与 `X-Subagg-Limit` 响应头的取值一一对应。 */
export type LimitLayer = 'ip' | 'token' | 'quota';

export interface LimitStatsSnapshot {
  /** 计数起点（毫秒时间戳）。即进程启动时刻。 */
  since: number;
  ip: number;
  token: number;
  quota: number;
}

export class LimitStats {
  readonly #since: number;
  readonly #counts: Record<LimitLayer, number> = { ip: 0, token: 0, quota: 0 };

  /** 时钟从外部传入，保持可测试性（与 core/ 的"要时间就当参数传"同源）。 */
  constructor(now: number = Date.now()) {
    this.#since = now;
  }

  hit(layer: LimitLayer): void {
    this.#counts[layer] += 1;
  }

  snapshot(): LimitStatsSnapshot {
    return {
      since: this.#since,
      ip: this.#counts.ip,
      token: this.#counts.token,
      quota: this.#counts.quota,
    };
  }
}
