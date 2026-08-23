/**
 * 进程入口。
 *
 * 职责顺序：加载配置 → 打开数据库并迁移 → 起 HTTP 服务 → 启动调度器
 * → 注册优雅退出。
 *
 * 任何一步失败都直接退出，不进入服务循环。对一个持有代理凭据的服务来说，
 * "带病启动"比"启动失败"危险得多 —— 后者你会立刻发现，前者可能几周后
 * 才在某个奇怪的场景下暴露。
 */

import { loadConfigWithDotenv } from './config.js';
import { createContext } from './context.js';
import { closeDatabase } from './db/index.js';
import { createLoggerFromConfig, errorContext } from './logger.js';
import { buildApp } from './server/app.js';

async function main(): Promise<void> {
  // ── 配置 ──────────────────────────────────────────────
  // 放在最前：ADMIN_TOKEN 缺失时应当在做任何其他事情之前就失败
  const config = loadConfigWithDotenv();
  const logger = createLoggerFromConfig(config);

  logger.info('subagg 启动中', {
    host: config.host,
    port: config.port,
    dbPath: config.dbPath,
    trustProxy: config.trustProxy,
  });
  if (!config.trustProxy) {
    logger.warn('TRUST_PROXY 未开启：反向代理后的来源 IP 与来源数统计不可用，请仅在可信反代后开启');
  }

  // ── 上下文（含数据库迁移）──────────────────────────────
  const ctx = createContext(config, logger);

  // ── HTTP 服务 ─────────────────────────────────────────
  const app = await buildApp(ctx);
  await app.listen({ host: config.host, port: config.port });

  logger.info('HTTP 服务已就绪', { url: `http://${config.host}:${config.port}` });

  if (config.host === '0.0.0.0') {
    // 值得单独提醒：这个服务的数据库里是代理凭据，
    // 直接暴露到公网而不做防护是危险的
    logger.warn(
      '正在监听 0.0.0.0。请确认已配置 HTTPS 反向代理，并限制 /api 的访问来源（详见 SECURITY.md）',
    );
  }

  // ── 定时同步 ──────────────────────────────────────────
  ctx.scheduler.start();

  // ── 优雅退出 ──────────────────────────────────────────
  //
  // 必须做的是关数据库：SQLite 在 WAL 模式下，未正常关闭会留下 -wal 文件，
  // 虽然下次启动能恢复，但正常关闭更干净，也能避免备份到一个不完整的状态。
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return; // 连按两次 Ctrl+C 时避免重复执行
    shuttingDown = true;

    logger.info('收到退出信号，正在关闭', { signal });
    ctx.scheduler.stop();

    try {
      await app.close();
      closeDatabase(ctx.db);
      logger.info('已安全退出');
      process.exit(0);
    } catch (err) {
      logger.error('退出过程中出错', errorContext(err));
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  // 此时 logger 可能还没建起来（配置校验失败就属于这种情况），
  // 所以直接写 stderr。配置错误的提示本身已经包含了修复步骤。
  process.stderr.write(`\n启动失败：\n${err instanceof Error ? err.message : String(err)}\n\n`);
  process.exit(1);
});
