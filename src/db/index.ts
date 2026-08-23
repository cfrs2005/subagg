/**
 * SQLite 连接与迁移执行。
 *
 * 选 SQLite 的理由：这是个单用户自托管服务，并发写入几乎不存在，
 * 数据量在几千行量级。跑一个 PostgreSQL 只会增加部署负担。
 * 而且单文件数据库意味着"备份"就是复制一个文件，对自托管用户很友好。
 *
 * 用 better-sqlite3 而不是 node:sqlite 或异步驱动：它是同步 API。
 * 在这个负载下同步查询根本不会阻塞事件循环（微秒级），
 * 而同步 API 让仓储层的代码简单一个数量级 —— 没有 async 传染。
 */

import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../logger.js';
import { MIGRATIONS, type Migration } from './migrations.js';

export type Db = Database.Database;

/**
 * 打开数据库，必要时创建目录与文件，并执行未应用的迁移。
 *
 * @param path 数据库文件路径。传 `:memory:` 用于测试。
 */
export function openDatabase(path: string, logger: Logger): Db {
  const inMemory = path === ':memory:';

  if (!inMemory) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);

  // WAL 模式：读写不互相阻塞。对我们的场景意义在于 ——
  // 后台调度器正在写入同步结果时，前台的订阅请求依然能读。
  db.pragma('journal_mode = WAL');
  // NORMAL 在 WAL 下已经足够安全（断电最多丢最后一个事务），
  // 而 FULL 会让每次写入都 fsync，同步几百个节点时明显变慢。
  db.pragma('synchronous = NORMAL');
  // 外键约束默认是关的。我们的 schema 依赖 ON DELETE CASCADE
  // （删订阅要连带删节点），不开就会留下孤儿数据。
  db.pragma('foreign_keys = ON');

  if (!inMemory) {
    // 数据库里存的是代理凭据，文件权限必须收紧到只有属主可读写。
    // 放在 pragma 之后：此时 WAL 与 shm 文件已经创建出来了。
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        chmodSync(`${path}${suffix}`, 0o600);
      } catch {
        // Windows 或某些文件系统不支持 chmod。不是致命错误，但要提醒。
        logger.warn('无法设置数据库文件权限为 0600，请自行确认文件不可被他人读取', {
          file: `${path}${suffix}`,
        });
      }
    }
  }

  migrate(db, logger);
  return db;
}

/**
 * 执行未应用的迁移。
 *
 * 每条迁移在独立事务里执行 —— 中途失败时已应用的迁移保持生效，
 * 失败的那条整体回滚，不会留下半截 schema。
 */
export function migrate(db: Db, logger: Logger, migrations: readonly Migration[] = MIGRATIONS): void {
  const versions = migrations.map((migration) => migration.version);
  const sorted = [...versions].sort((a, b) => a - b);
  if (new Set(versions).size !== versions.length || sorted.some((version, index) => version !== index + 1)) {
    throw new Error('数据库迁移版本必须从 1 开始连续递增且不能重复');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => (row as { version: number }).version),
  );

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    logger.info('应用数据库迁移', { version: migration.version, name: migration.name });

    const run = db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, Date.now());
    });

    try {
      run();
    } catch (err) {
      throw new Error(
        `迁移 ${migration.version} (${migration.name}) 执行失败：` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** 关闭连接。进程退出前调用，确保 WAL 被正确合并回主文件。 */
export function closeDatabase(db: Db): void {
  db.close();
}
