/**
 * 应用上下文：把配置、数据库、仓储、服务组装成一个对象，向下传递。
 *
 * 这是一种最朴素的依赖注入 —— 没有 DI 容器，没有装饰器，就是一个显式构造的
 * 对象。对这个规模的项目，容器带来的间接性远大于收益；而显式传递让
 * "这个函数依赖什么"在签名上一目了然，也让测试时替换某个仓储变得毫不费力。
 */

import type { Config } from './config.js';
import { openDatabase, type Db } from './db/index.js';
import { NodeRepo } from './db/repo/nodes.js';
import { PingHistoryRepo } from './db/repo/ping-history.js';
import { ProfileRepo } from './db/repo/profiles.js';
import { AccessLogRepo, FriendRepo, TokenRepo } from './db/repo/sharing.js';
import { SubscriptionRepo, TrafficRepo } from './db/repo/subscriptions.js';
import type { Logger } from './logger.js';
import { LimitStats } from './services/limit-stats.js';
import { Scheduler } from './services/scheduler.js';
import { NodePingService } from './services/node-ping.js';
import { SyncService } from './services/sync.js';

export interface AppContext {
  config: Config;
  logger: Logger;
  db: Db;

  subscriptions: SubscriptionRepo;
  nodes: NodeRepo;
  profiles: ProfileRepo;
  traffic: TrafficRepo;
  friends: FriendRepo;
  tokens: TokenRepo;
  accessLog: AccessLogRepo;
  pingHistory: PingHistoryRepo;

  sync: SyncService;
  nodePing: NodePingService;
  scheduler: Scheduler;
  /** 限流命中计数。进程内，重启清零 —— 展示时必须带上 since。 */
  limitStats: LimitStats;
}

/** 构建上下文。会打开数据库并执行迁移。 */
export function createContext(config: Config, logger: Logger): AppContext {
  const db = openDatabase(config.dbPath, logger);

  const subscriptions = new SubscriptionRepo(db);
  const nodes = new NodeRepo(db);
  const profiles = new ProfileRepo(db);
  const traffic = new TrafficRepo(db);
  const friends = new FriendRepo(db);
  const tokens = new TokenRepo(db);
  const accessLog = new AccessLogRepo(db);
  const pingHistory = new PingHistoryRepo(db);

  const limitStats = new LimitStats();
  const sync = new SyncService({ config, logger, subscriptions, nodes, traffic });
  const nodePing = new NodePingService({ config, logger, nodes, history: pingHistory });
  const scheduler = new Scheduler({
    intervalMinutes: config.schedulerIntervalMin,
    logger,
    sync,
    accessLog,
    accessLogRetentionDays: config.accessLogRetentionDays,
    nodePing,
  });

  return {
    config,
    logger,
    db,
    subscriptions,
    nodes,
    profiles,
    traffic,
    friends,
    tokens,
    accessLog,
    pingHistory,
    sync,
    nodePing,
    scheduler,
    limitStats,
  };
}
