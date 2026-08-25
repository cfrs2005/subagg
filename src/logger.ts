/**
 * 日志。
 *
 * ## 为什么要自己写脱敏，而不是直接用 pino / winston
 *
 * 这个服务处理的每一样东西都是敏感的：订阅 URL 里带着机场给你的 token，
 * 节点配置里是 UUID 和密码，我们自己发出去的订阅链接里是 `/sub/:token`。
 *
 * 一旦这些进了 `journalctl` 或者日志文件，就等于把凭据以明文形式复制了一份，
 * 而且是复制到一个**权限通常比数据库文件宽松**的地方。用户排查问题时把日志
 * 贴到 issue 里，就直接泄漏了。
 *
 * 所以脱敏不是可选的附加功能，而是日志层的默认行为 —— 必须在写出去之前发生，
 * 不能指望调用方每次记得手动处理。
 */

import type { Config } from './config.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// ─────────────────────────────────────────────────────────────
//  脱敏
// ─────────────────────────────────────────────────────────────

/**
 * 需要脱敏的字段名。
 *
 * 匹配是**大小写不敏感的子串匹配**，所以 `password` 能覆盖 `obfsPassword`、
 * `plugin_password` 等一系列变体。宁可多脱一点。
 */
const SENSITIVE_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'uuid',
  'auth',
  'key',
  'credential',
  'cookie',
  'authorization',
];

/** 值太短就不打码了 —— 打出来的星号数量本身会泄漏长度信息。 */
function mask(value: string): string {
  if (value.length <= 8) return '***';
  // 保留头尾各 3 位，便于在多条日志之间对照"是不是同一个值"，
  // 同时又不足以还原原值
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

/**
 * 对 URL 脱敏。
 *
 * 订阅 URL 的敏感部分几乎总在两个位置：查询参数（`?token=xxx`）
 * 和路径段（`/feed/6c84f9a37e7cd725ed2b/clash/hpb1qd10op94kgm0`）。
 * 后者尤其容易被忽略 —— 只处理查询参数是不够的。
 *
 * 保留 host 是刻意的：排查问题时需要知道是哪个机场出了状况，
 * 而 host 本身通常不构成凭据。
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    redactSearchParams(url);
    url.pathname = redactPathname(url.pathname);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    // 连 URL 都解析不了的字符串，无法判断哪部分敏感 —— 整体打码
    return mask(raw);
  }
}

/** 查询参数一律打码（不逐个判断键名 —— 机场的参数名五花八门）。 */
function redactSearchParams(url: URL): void {
  for (const key of [...url.searchParams.keys()]) {
    const value = url.searchParams.get(key);
    if (value) url.searchParams.set(key, mask(value));
  }
}

/** 路径里长度可疑的段视为 token。 */
function redactPathname(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => (seg.length >= 12 ? mask(seg) : seg))
    .join('/');
}

/**
 * 对**相对路径**脱敏，例如 `/api/tokens/<43 字符 token>/revoke`。
 *
 * 单独一个函数是必要的：`redact()` 对裸字符串只在它以 `http(s)://` 开头时才
 * 走 `redactUrl`，而 `req.url` 拿到的是相对路径 —— 于是
 * `{ path: '/api/tokens/<明文 token>/revoke' }` 这样的日志会**原样落盘**。
 * 鉴权失败的分支恰好就这么记，等于把订阅凭据写进了 journald。
 *
 * 脱敏放在 logger 层而不是各个调用点，是因为"记得手动脱敏"这件事
 * 迟早会有人忘 —— 而忘掉的代价是凭据泄漏。
 */
export function redactPath(raw: string): string {
  try {
    // 相对路径没有 origin，给一个丢弃用的 base 才能借 URL 解析 query
    const url = new URL(raw, 'http://placeholder.invalid');
    redactSearchParams(url);
    return redactPathname(url.pathname) + url.search;
  } catch {
    return mask(raw);
  }
}

/**
 * 递归脱敏任意结构。
 *
 * @param depth 递归深度上限，防止环形引用导致栈溢出。
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[深度超限]';

  if (typeof value === 'string') {
    // 字符串里如果是个 URL，走 URL 脱敏
    return /^https?:\/\//i.test(value) ? redactUrl(value) : value;
  }

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1));
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (SENSITIVE_KEYS.some((s) => lower.includes(s))) {
        out[key] = typeof v === 'string' ? mask(v) : '***';
      } else if (lower === 'url' && typeof v === 'string') {
        out[key] = redactUrl(v);
      } else if (lower === 'path' && typeof v === 'string' && v.startsWith('/')) {
        // `path` 字段几乎总是 req.url，里面常带明文 token（`/sub/xxx`、
        // `/api/tokens/xxx/revoke`）。它不以 http:// 开头，走不进上面那条分支。
        out[key] = redactPath(v);
      } else {
        out[key] = redact(v, depth + 1);
      }
    }
    return out;
  }

  return value;
}

// ─────────────────────────────────────────────────────────────
//  Logger
// ─────────────────────────────────────────────────────────────

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  /** 派生一个带固定上下文的子 logger，例如绑定某个订阅源 id。 */
  child(ctx: Record<string, unknown>): Logger;
}

/** 输出为单行 JSON，便于 journalctl / Loki 之类的工具直接消费。 */
function write(level: LogLevel, msg: string, ctx: Record<string, unknown>): void {
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(Object.keys(ctx).length > 0 ? { ctx: redact(ctx) } : {}),
  };
  const line = JSON.stringify(record);
  // 错误走 stderr，其余走 stdout —— 这样 systemd 能正确分流
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function createLogger(level: LogLevel, base: Record<string, unknown> = {}): Logger {
  const threshold = LEVEL_ORDER[level];

  const log = (lvl: LogLevel, msg: string, ctx?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    write(lvl, msg, { ...base, ...ctx });
  };

  return {
    debug: (msg, ctx) => log('debug', msg, ctx),
    info: (msg, ctx) => log('info', msg, ctx),
    warn: (msg, ctx) => log('warn', msg, ctx),
    error: (msg, ctx) => log('error', msg, ctx),
    child: (ctx) => createLogger(level, { ...base, ...ctx }),
  };
}

export function createLoggerFromConfig(config: Config): Logger {
  return createLogger(config.logLevel);
}

/** 把异常转成可安全记录的结构。 */
export function errorContext(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      error: err.message,
      // 只在 debug 级别有意义，但堆栈里可能含有路径信息，不含凭据，可以记
      stack: err.stack?.split('\n').slice(0, 5).join('\n'),
    };
  }
  return { error: String(err) };
}
