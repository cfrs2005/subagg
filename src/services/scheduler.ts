/**
 * 定时同步调度器。
 *
 * 实现刻意做得很朴素：一个定时器，每隔几分钟醒来一次，看看有没有订阅到期了。
 * 没有用 cron 表达式，也没有引入任务队列 —— 这个场景的需求就是
 * "每 N 小时拉一次"，而每个订阅的 N 各不相同，所以"定期检查是否到期"
 * 比"为每个订阅注册一个定时器"更简单，也更能容忍进程重启
 * （重启后由 `lastSyncAt` 自然恢复节奏，不需要持久化定时器状态）。
 */

import type { Logger } from '../logger.js';
import type { SyncService } from './sync.js';
import type { AccessLogRepo } from '../db/repo/sharing.js';
import type { NodePingService } from './node-ping.js';

export interface SchedulerOptions {
  /** 检查间隔（分钟）。0 表示禁用自动同步。 */
  intervalMinutes: number;
  logger: Logger;
  sync: SyncService;
  accessLog?: AccessLogRepo;
  accessLogRetentionDays?: number;
  nodePing?: NodePingService;
}

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  /**
   * 防重入标记。
   *
   * 抓取十几个订阅源可能耗时超过检查间隔，如果不加这道锁，
   * 上一轮还没跑完下一轮就开始了，同一个订阅会被并发抓取 ——
   * 轻则浪费带宽，重则被机场当成异常流量限流。
   */
  private running = false;
  private lastPruneAt = 0;
  private lastPingHistoryPruneAt = 0;

  constructor(private readonly options: SchedulerOptions) {}

  start(): void {
    const { intervalMinutes, logger } = this.options;

    if (intervalMinutes <= 0) {
      logger.info('自动同步已禁用（SCHEDULER_INTERVAL_MIN=0）');
      return;
    }

    logger.info('启动同步调度器', { intervalMinutes });

    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMinutes * 60_000);

    // unref 让定时器不阻止进程退出 —— 否则 Ctrl+C 之后还要等到下一次触发
    this.timer.unref();

    // 启动后立即检查一次。首次部署时用户不必干等一个周期才看到节点。
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 执行一轮检查。异常在内部消化 —— 调度器绝不能因为一次失败就停摆。 */
  private async tick(): Promise<void> {
    const { logger, sync } = this.options;

    if (this.running) {
      logger.warn('上一轮同步尚未结束，跳过本轮');
      return;
    }

    this.running = true;
    try {
      const retentionDays = this.options.accessLogRetentionDays ?? 0;
      if (this.options.accessLog && retentionDays > 0 && Date.now() - this.lastPruneAt >= 86400_000) {
        try {
          // Retention, quotaWindowHours and the 30-day friend summary are a
          // coupled constraint. Keep retention >= 30 days when changing either.
          const removed = this.options.accessLog.prune(Date.now() - retentionDays * 86400_000);
          this.lastPruneAt = Date.now();
          if (removed > 0) logger.info('访问日志清理完成', { removed, retentionDays });
        } catch (err) {
          // Pruning is maintenance only; it must not stop subscription sync.
          logger.warn('访问日志清理失败', { error: err instanceof Error ? err.message : String(err) });
        }
      }
      const results = await sync.syncDue();
      if (results.length > 0) {
        const failed = results.filter((r) => !r.ok);
        logger.info('定时同步完成', {
          total: results.length,
          failed: failed.length,
        });
        for (const failure of failed) {
          logger.warn('订阅同步失败', {
            subscription: failure.name,
            error: failure.error,
          });
        }
      }

      if (this.options.nodePing) {
        if (Date.now() - this.lastPingHistoryPruneAt >= 86400_000) {
          const removed = this.options.nodePing.pruneHistory(Date.now() - 90 * 86400_000);
          this.lastPingHistoryPruneAt = Date.now();
          if (removed > 0) logger.info('节点延迟历史清理完成', { removed, retentionDays: 90 });
        }
        const result = await this.options.nodePing.pingDue();
        if (result.total > 0) {
          logger.info('自动节点 TCP 测试完成', result);
        }
      }
    } catch (err) {
      logger.error('调度器执行出错', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.running = false;
    }
  }
}
