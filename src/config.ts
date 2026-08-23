/**
 * 运行配置：环境变量的读取与校验。
 *
 * 核心原则是**启动即失败**（fail fast）：配置有问题就在进程启动时报错退出，
 * 而不是等到第一个请求进来才暴露。对一个持有代理凭据的服务来说，
 * "先跑起来再说"是危险的默认姿态。
 *
 * 尤其是 `ADMIN_TOKEN` —— 本项目**不提供默认口令**。没有默认值意味着
 * 不存在"忘记改默认密码"这个经典漏洞。
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────
//  .env 加载
// ─────────────────────────────────────────────────────────────

/**
 * 极简 .env 解析。
 *
 * 没有引入 dotenv 依赖：这个功能只需要二十来行，而少一个依赖就少一处
 * 需要跟进的供应链风险 —— 何况这个文件里装的是管理口令。
 *
 * 支持：`KEY=value`、`#` 注释、`export KEY=value`、单/双引号包裹。
 * 不支持：变量插值、多行值。需要这些的话请改用系统环境变量。
 *
 * **已存在的环境变量优先**，不会被 .env 覆盖 —— systemd / Docker 传入的值
 * 应当压过文件里的值。
 */
function loadDotenv(path = '.env'): void {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return; // 没有 .env 是正常情况（生产环境常用系统环境变量）
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();

    // 去掉包裹的引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  Schema
// ─────────────────────────────────────────────────────────────

const MIN_SECRET_LENGTH = 16;

const ConfigSchema = z.object({
  /**
   * 管理 API 的 Bearer Token。**必填，无默认值。**
   *
   * 最小长度限制是刻意的：一个 8 位口令在暴露到公网时几小时就能被爆破，
   * 而这个 token 背后是你全部的代理凭据。
   */
  adminToken: z
    .string({ required_error: '缺少 ADMIN_TOKEN' })
    .min(MIN_SECRET_LENGTH, `ADMIN_TOKEN 至少需要 ${MIN_SECRET_LENGTH} 个字符`),

  /** 访问日志中 IP 哈希的盐。我们不存明文 IP。 */
  ipHashSalt: z
    .string({ required_error: '缺少 IP_HASH_SALT' })
    .min(8, 'IP_HASH_SALT 至少需要 8 个字符'),

  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65535).default(8787),

  /**
   * 是否信任 `X-Forwarded-For` 等反代头来判定客户端 IP。
   *
   * 默认关闭。**只有在确实部署于反向代理之后时才应开启** ——
   * 直接暴露的服务开启它，等于允许任何人通过伪造头部把自己伪装成任意 IP，
   * 从而绕过限流、污染访问日志里的来源统计。
   */
  trustProxy: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  /** 对外基础 URL，用于在界面上拼接可分享的订阅链接。 */
  publicBaseUrl: z.string().default('http://127.0.0.1:8787'),

  dbPath: z.string().default('./data/subagg.db'),

  fetchTimeoutMs: z.coerce.number().int().min(1000).max(120000).default(15000),
  /** 上游响应体大小上限。防止异常的上游把内存吃满。 */
  fetchMaxBytes: z.coerce.number().int().min(1024).default(8 * 1024 * 1024),
  fetchRetries: z.coerce.number().int().min(0).max(5).default(2),
  /** 抓取时伪装的 UA。部分机场按 UA 返回不同格式，装成 Clash 通常拿到的最完整。 */
  fetchUserAgent: z.string().default('clash-verge/v2.0.0'),

  /** 调度器检查间隔（分钟）。0 表示禁用自动同步。 */
  schedulerIntervalMin: z.coerce.number().int().min(0).max(1440).default(5),

  /** 节点 TCP 探测的最短间隔。每个节点每隔该时长最多自动测试一次。 */
  nodePingIntervalHours: z.coerce.number().int().min(1).max(168).default(12),

  /** /sub 端点每 IP 每分钟的请求上限。 */
  subRateLimit: z.coerce.number().int().min(1).default(60),
  /** /sub 端点每个有效 token 每分钟的突发上限。 */
  subTokenRateLimit: z.coerce.number().int().min(1).default(20),
  /** 好友来源数达到该值时告警；0 关闭。 */
  shareSourceAlert: z.coerce.number().int().min(0).default(3),
  /** 访问日志保留天数；0 表示不清理，最短 30 天。 */
  accessLogRetentionDays: z.coerce.number().int().refine((v) => v === 0 || v >= 30, 'ACCESS_LOG_RETENTION_DAYS 必须为 0 或至少 30').default(90),

  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

// ─────────────────────────────────────────────────────────────
//  加载
// ─────────────────────────────────────────────────────────────

/**
 * 读取并校验配置。校验失败时抛出带有可操作提示的错误。
 *
 * 由 `src/index.ts` 在启动时调用一次。失败即退出，不进入服务循环。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    adminToken: env['ADMIN_TOKEN'],
    ipHashSalt: env['IP_HASH_SALT'],
    host: env['HOST'],
    port: env['PORT'],
    trustProxy: env['TRUST_PROXY'],
    publicBaseUrl: env['PUBLIC_BASE_URL'],
    dbPath: env['DB_PATH'],
    fetchTimeoutMs: env['FETCH_TIMEOUT_MS'],
    fetchMaxBytes: env['FETCH_MAX_BYTES'],
    fetchRetries: env['FETCH_RETRIES'],
    fetchUserAgent: env['FETCH_USER_AGENT'],
    schedulerIntervalMin: env['SCHEDULER_INTERVAL_MIN'],
    nodePingIntervalHours: env['NODE_PING_INTERVAL_HOURS'],
    subRateLimit: env['SUB_RATE_LIMIT'],
    subTokenRateLimit: env['SUB_TOKEN_RATE_LIMIT'],
    shareSourceAlert: env['SHARE_SOURCE_ALERT'],
    accessLogRetentionDays: env['ACCESS_LOG_RETENTION_DAYS'],
    logLevel: env['LOG_LEVEL'],
  });

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(根)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `配置校验失败：\n${details}\n\n` +
        '请复制 .env.example 为 .env 并填写必填项：\n' +
        '  cp .env.example .env\n' +
        '  echo "ADMIN_TOKEN=$(openssl rand -hex 32)" >> .env\n' +
        '  echo "IP_HASH_SALT=$(openssl rand -hex 16)" >> .env\n',
    );
  }

  return parsed.data;
}

/** 先加载 .env 再读取配置。这是 `src/index.ts` 使用的入口。 */
export function loadConfigWithDotenv(envFile = '.env'): Config {
  loadDotenv(envFile);
  return loadConfig();
}
