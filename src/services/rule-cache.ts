/**
 * 规则集抓取与缓存。
 *
 * ## 为什么规则集要经过我们自己的服务器
 *
 * 客户端只认一种格式，而源站有四五种。让每个客户端各自去猜，就是把
 * 一次性的格式问题放大到每一台设备上；更糟的是猜错时**不会报错**——
 * 规则集变成空集，流量悄悄走错路。所以转换放在服务端做一次，客户端只拿
 * 干净的目标格式。
 *
 * ## 缓存策略
 *
 * - 磁盘缓存，按 `URL + behavior` 取哈希做文件名，重启不丢。
 * - 12 小时内直接命中，不发请求。规则集本来就不需要准实时。
 * - 抓取失败但存在过期缓存时**返回过期内容并标记 `stale`**：
 *   一份 12 小时前的国内域名列表，远好过没有。
 * - 抓不到又没有缓存时返回 `null`，由路由退回上游原始 URL。
 *   转换层永远不该成为新的故障点。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { convertRuleSet, type RuleSetBehavior } from '../core/rule-set.js';
import type { Logger } from '../logger.js';

const DEFAULT_TTL_MS = 12 * 3600_000;
const FETCH_TIMEOUT_MS = 15_000;
/** 11 万行域名约 3 MB；32 MB 是给组合型规则集留的余量。 */
const MAX_BYTES = 32 * 1024 * 1024;

export interface CachedRuleSet {
  body: string;
  /** true 表示这条内容已经过期，是抓取失败后的降级结果。 */
  stale: boolean;
  count: number;
}

export interface RuleCacheOptions {
  /** 缓存目录，通常是 `<data>/rules`。 */
  dir: string;
  logger: Logger;
  ttlMs?: number;
  /** 测试注入点。 */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class RuleCache {
  private readonly dir: string;
  private readonly logger: Logger;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** 同一 key 的并发请求只发一次上游：客户端刷新时往往会同时拉好几个规则集。 */
  private readonly inflight = new Map<string, Promise<CachedRuleSet | null>>();

  constructor(options: RuleCacheOptions) {
    this.dir = options.dir;
    this.logger = options.logger;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private cachePath(url: string, behavior: RuleSetBehavior): string {
    const hash = createHash('sha256').update(`${behavior}\n${url}`).digest('hex').slice(0, 32);
    return path.join(this.dir, `${hash}.${behavior}.txt`);
  }

  async get(url: string, behavior: RuleSetBehavior): Promise<CachedRuleSet | null> {
    const key = `${behavior}\n${url}`;
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const task = this.load(url, behavior).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  private async readCache(
    file: string,
  ): Promise<{ body: string; fresh: boolean; count: number } | undefined> {
    try {
      const info = await stat(file);
      const body = await readFile(file, 'utf8');
      if (!body.trim()) return undefined;
      const fresh = this.now() - info.mtimeMs < this.ttlMs;
      const count = body.split('\n').filter((line) => line.trim().length > 0).length;
      return { body, fresh, count };
    } catch {
      return undefined;
    }
  }

  private async load(url: string, behavior: RuleSetBehavior): Promise<CachedRuleSet | null> {
    const file = this.cachePath(url, behavior);
    const cached = await this.readCache(file);
    if (cached?.fresh) return { body: cached.body, stale: false, count: cached.count };

    try {
      const text = await this.fetchText(url);
      const converted = convertRuleSet(text, behavior);
      if (!converted) {
        this.logger.warn('规则集无法转换为目标格式，已放弃', {
          url,
          behavior,
          bytes: text.length,
        });
        return cached ? { body: cached.body, stale: true, count: cached.count } : null;
      }

      await this.write(file, converted.body);
      this.logger.info('规则集已转换并缓存', {
        url,
        behavior,
        format: converted.format,
        count: converted.count,
        dropped: converted.dropped,
      });
      return { body: converted.body, stale: false, count: converted.count };
    } catch (err) {
      this.logger.warn('规则集抓取失败', {
        url,
        behavior,
        error: err instanceof Error ? err.message : String(err),
        fallback: cached ? 'stale-cache' : 'upstream-redirect',
      });
      return cached ? { body: cached.body, stale: true, count: cached.count } : null;
    }
  }

  private async fetchText(url: string): Promise<string> {
    const response = await this.fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'user-agent': 'subagg-rulecache/1.0',
        accept: '*/*',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_BYTES) {
      throw new Error(`响应体超过 ${MAX_BYTES} 字节`);
    }
    return buffer.toString('utf8');
  }

  private async write(file: string, body: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // 先写临时文件再 rename：并发读到半截文件会把截断的内容当成完整规则集。
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, file);
  }
}
