/**
 * 上游订阅抓取。
 *
 * 看起来只是"发个 GET"，但机场订阅接口的实际表现相当不讲究，
 * 下面每一条防护都对应一种真实会遇到的情况：
 *
 * | 情况 | 防护 |
 * |------|------|
 * | 接口挂起不返回 | 超时（AbortSignal） |
 * | 返回一个几百 MB 的东西 | 响应体大小上限 + 流式读取 |
 * | 偶发的 5xx / 网络抖动 | 指数退避重试 |
 * | 按 UA 返回不同格式，默认 UA 拿到残缺内容 | 可配置的 UA 伪装 |
 * | 内容没变但每次都要重新下载 | ETag 条件请求 |
 * | 302 跳到别的域名 | 跟随重定向（有上限） |
 *
 * 特别说明**流式读取**：如果用 `res.text()`，Node 会先把整个响应读进内存
 * 再交给我们，此时大小上限已经形同虚设 —— 内存已经被吃掉了。
 * 必须边读边计数，超限立即断开。
 */

import { parseUserinfo } from '../core/userinfo.js';
import type { TrafficInfo } from '../core/types.js';

export interface FetchOptions {
  timeoutMs: number;
  maxBytes: number;
  retries: number;
  userAgent: string;
  /** 上次抓取拿到的 ETag。传入则发起条件请求。 */
  etag?: string | null;
}

export interface FetchOutcome {
  /** 上游返回 304，内容未变更。此时 `body` 为空字符串。 */
  notModified: boolean;
  body: string;
  /** 解析出的流量信息。多数机场会给，免费订阅通常没有。 */
  userinfo?: TrafficInfo;
  etag?: string;
  /**
   * 上游声明的建议更新间隔（小时），来自 `profile-update-interval` 响应头。
   * 可用于提示用户把同步间隔调整到与机场建议一致。
   */
  updateIntervalHours?: number;
  status: number;
}

/** 抓取失败。`retryable` 用于区分"重试可能有用"与"重试没有意义"。 */
export class FetchError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

/** 单次请求。重试逻辑在外层。 */
async function fetchOnce(url: string, options: FetchOptions): Promise<FetchOutcome> {
  const headers: Record<string, string> = {
    'User-Agent': options.userAgent,
    // 明确表示接受任意内容：部分机场会根据 Accept 头切换返回格式
    Accept: '*/*',
    // 不要缓存 —— 我们自己用 ETag 做条件请求，中间层缓存只会添乱
    'Cache-Control': 'no-cache',
  };
  if (options.etag) {
    headers['If-None-Match'] = options.etag;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (err) {
    // 超时与网络错误都值得重试
    const reason = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new FetchError(isTimeout ? `请求超时（${options.timeoutMs}ms）` : `网络错误：${reason}`, true);
  }

  // ── 304：内容未变更 ──────────────────────────────────
  if (res.status === 304) {
    const outcome: FetchOutcome = { notModified: true, body: '', status: 304 };
    // 即使内容没变，流量头通常还是新的 —— 用掉的流量一直在增长
    const userinfo = parseUserinfo(res.headers.get('subscription-userinfo'));
    if (userinfo) outcome.userinfo = userinfo;
    return outcome;
  }

  if (!res.ok) {
    // 4xx 是订阅本身的问题（链接失效、被封号），重试没有意义；
    // 5xx 与 429 是服务端临时状态，值得重试。
    const retryable = res.status >= 500 || res.status === 429;
    throw new FetchError(`上游返回 HTTP ${res.status} ${res.statusText}`, retryable, res.status);
  }

  // ── 流式读取并限制大小 ───────────────────────────────
  const body = await readWithLimit(res, options.maxBytes);

  const outcome: FetchOutcome = { notModified: false, body, status: res.status };

  const userinfo = parseUserinfo(res.headers.get('subscription-userinfo'));
  if (userinfo) outcome.userinfo = userinfo;

  const etag = res.headers.get('etag');
  if (etag) outcome.etag = etag;

  const interval = res.headers.get('profile-update-interval');
  if (interval) {
    const hours = Number.parseInt(interval, 10);
    if (Number.isFinite(hours) && hours > 0) outcome.updateIntervalHours = hours;
  }

  return outcome;
}

/**
 * 边读边计数，超过上限立即断开连接。
 *
 * 不用 `res.text()` 的原因见文件头部：那样大小上限根本来不及生效。
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
        throw new FetchError(
          `响应体超过上限（> ${Math.round(maxBytes / 1024)} KiB），已中断。` +
            '这通常意味着该地址返回的不是订阅内容。',
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

/**
 * 抓取订阅，失败时按指数退避重试。
 *
 * 只对 `retryable` 的失败重试。对 404 这类确定性错误反复重试，
 * 只会让本来就可能限流的机场更快把我们拉黑。
 */
export async function fetchSubscription(
  url: string,
  options: FetchOptions,
): Promise<FetchOutcome> {
  let lastError: FetchError | undefined;

  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      return await fetchOnce(url, options);
    } catch (err) {
      const fetchErr =
        err instanceof FetchError
          ? err
          : new FetchError(err instanceof Error ? err.message : String(err), false);

      lastError = fetchErr;
      if (!fetchErr.retryable || attempt === options.retries) break;

      // 1s、2s、4s…… 给上游一点恢复时间，也避免我们自己变成压测工具
      await sleep(1000 * 2 ** attempt);
    }
  }

  throw lastError ?? new FetchError('抓取失败（原因未知）', false);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
