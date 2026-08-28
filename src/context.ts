/**
 * 应用上下文：把配置、数据库、仓储、服务组装成一个对象，向下传递。
 *
 * 这是一种最朴素的依赖注入 —— 没有 DI 容器，没有装饰器，就是一个显式构造的
 * 对象。对这个规模的项目，容器带来的间接性远大于收益；而显式传递让
 * "这个函数依赖什么"在签名上一目了然，也让测试时替换某个仓储变得毫不费力。
 */

import { googleAuthEnabled, type Config } from './config.js';
import { deriveKey } from './core/secret.js';
import { openDatabase, type Db } from './db/index.js';
import { IxMappingRepo, IxProviderRepo } from './db/repo/ix.js';
import { AuthRepo } from './db/repo/auth.js';
import { NodeRepo } from './db/repo/nodes.js';
import { PingHistoryRepo } from './db/repo/ping-history.js';
import { ProfileRepo } from './db/repo/profiles.js';
import { AccessLogRepo, FriendRepo, TokenRepo } from './db/repo/sharing.js';
import { SubscriptionRepo, TrafficRepo } from './db/repo/subscriptions.js';
import type { Logger } from './logger.js';
import { IxService } from './services/ix.js';
import { GoogleOidcService } from './services/google-oidc.js';
import { LimitStats } from './services/limit-stats.js';
import { Scheduler } from './services/scheduler.js';
import { NodePingService } from './services/node-ping.js';
import { NodeCatalog } from './services/node-catalog.js';
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
  auth: AuthRepo;
  pingHistory: PingHistoryRepo;
  ixProviders: IxProviderRepo;
  ixMappings: IxMappingRepo;

  sync: SyncService;
  nodePing: NodePingService;
  ix: IxService;
  catalog: NodeCatalog;
  googleOidc: GoogleOidcService | null;
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
  const auth = new AuthRepo(db);
  const pingHistory = new PingHistoryRepo(db);
  const ixProviders = new IxProviderRepo(db);
  const ixMappings = new IxMappingRepo(db);

  const limitStats = new LimitStats();
  const sync = new SyncService({ config, logger, subscriptions, nodes, traffic });
  // 凭据加密密钥在这里派生**一次**：scrypt 是刻意慢的，放进每次加解密就等于
  // 给每个管理请求加上几十毫秒。core/secret.ts 收密钥当参数，正是为了让
  // "密钥从哪来"留在装配层（core 零 IO，不读环境变量）。
  // 代价写在文档里：轮换 ADMIN_TOKEN 后已存的 IX 凭据永久解不开，
  // 届时 provider 会被标成"需重新录入"，关联 IX 节点不可用，服务不会崩。
  const secretKey = deriveKey(config.adminToken);
  const ix = new IxService({
    config,
    logger,
    providers: ixProviders,
    mappings: ixMappings,
    nodes,
    secretKey,
  });
  const catalog = new NodeCatalog(nodes, ix);
  const nodePing = new NodePingService({ config, logger, nodes: catalog, history: pingHistory });
  const googleOidc = googleAuthEnabled(config)
    ? new GoogleOidcService(config.googleClientId!, config.googleClientSecret!)
    : null;
  const scheduler = new Scheduler({
    intervalMinutes: config.schedulerIntervalMin,
    logger,
    sync,
    accessLog,
    accessLogRetentionDays: config.accessLogRetentionDays,
    nodePing,
    ix,
    ixSyncIntervalMinutes: config.ixSyncIntervalMinutes,
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
    auth,
    pingHistory,
    ixProviders,
    ixMappings,
    sync,
    nodePing,
    ix,
    catalog,
    googleOidc,
    scheduler,
    limitStats,
  };
}
