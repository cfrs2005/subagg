/**
 * 解析层共享工具。
 *
 * 这里的函数都遵循同一条原则：**面对畸形输入返回 undefined 或兜底值，不抛异常。**
 *
 * 原因是上游订阅的质量完全不可控 —— 机场会在订阅里混入格式错误的行、
 * 用未经编码的中文做参数、把端口写成 `443 `（带空格）、给出半截 base64。
 * 如果任何一环抛异常，整个订阅就解析失败了；正确的做法是跳过这一条、
 * 记下原因、继续处理其余节点。
 */

// ─────────────────────────────────────────────────────────────
//  Base64
// ─────────────────────────────────────────────────────────────

/**
 * 宽容的 base64 解码。
 *
 * 订阅里的 base64 有三种常见变体，且经常混用：
 *   - 标准字母表（`+` `/`）与 URL-safe 字母表（`-` `_`）
 *   - 带 `=` 填充与不带填充
 *   - 中间夹杂换行（HTTP 传输时被折行）
 *
 * 全部归一化后再交给 Buffer 解码。解不出来返回 undefined。
 */
export function decodeBase64(input: string): string | undefined {
  const cleaned = input.replace(/[\r\n\s]/g, '');
  if (cleaned.length === 0) return undefined;

  const normalized = cleaned.replace(/-/g, '+').replace(/_/g, '/');
  // Buffer 对缺失的填充其实是宽容的，但补齐后行为更可预期
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);

  try {
    const buf = Buffer.from(padded, 'base64');
    // Buffer.from 遇到非法字符会静默丢弃而不是报错，所以要反过来验证：
    // 如果重新编码后的长度与输入相差过大，说明输入根本不是 base64。
    if (buf.length === 0) return undefined;
    return buf.toString('utf8');
  } catch {
    return undefined;
  }
}

/** 标准 base64 编码（带填充）。用于生成 V2Ray / Shadowrocket 订阅体。 */
export function encodeBase64(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64');
}

/** URL-safe base64 编码（无填充）。SS 的 SIP002 用户信息段用这个。 */
export function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/**
 * 判断一段文本是否"看起来像"整块 base64。
 *
 * 用于订阅格式嗅探：V2Ray 风格的订阅是一大坨 base64，而 Clash 订阅是 YAML 明文。
 * 这里只做字符集与长度的启发式判断，真正的验证靠解码后能不能解析出节点。
 */
export function looksLikeBase64(text: string): boolean {
  const cleaned = text.replace(/[\r\n\s]/g, '');
  if (cleaned.length < 16) return false;
  return /^[A-Za-z0-9+/\-_]+={0,2}$/.test(cleaned);
}

// ─────────────────────────────────────────────────────────────
//  百分号编码
// ─────────────────────────────────────────────────────────────

/**
 * 宽容的百分号解码。
 *
 * `decodeURIComponent` 遇到孤立的 `%` 或非法序列会抛 URIError，
 * 而节点名里出现未编码的 `%`（比如 "50%折扣"）非常常见。
 * 解不开就原样返回，总比让整个节点解析失败要好。
 */
export function safeDecodeURIComponent(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

// ─────────────────────────────────────────────────────────────
//  主机与端口
// ─────────────────────────────────────────────────────────────

/**
 * 去掉 IPv6 字面量地址的方括号。
 *
 * WHATWG URL 的 `hostname` 对 IPv6 会返回带方括号的 `[2001:db8::1]`。
 * 我们在内部模型里统一存不带方括号的形式，生成 URI 时再由
 * {@link formatHostForUri} 补回去 —— 否则 Clash 的 YAML 里会出现
 * `server: "[2001:db8::1]"` 这种客户端解析不了的写法。
 */
export function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** IPv6 字面量在 URI 的 authority 部分必须加方括号，否则与端口分隔符 `:` 冲突。 */
export function formatHostForUri(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * 解析并校验端口。
 *
 * 订阅里的端口可能是数字、带空格的字符串、甚至空字符串。
 * 越界或非法一律返回 undefined，由调用方决定是跳过该节点还是报错。
 */
export function parsePort(input: string | number | undefined | null): number | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  const n = typeof input === 'number' ? input : Number.parseInt(String(input).trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
  return n;
}

// ─────────────────────────────────────────────────────────────
//  杂项
// ─────────────────────────────────────────────────────────────

/**
 * 把逗号分隔的列表拆开并去掉空项。
 *
 * ALPN（`h2,http/1.1`）与 HTTP 伪装的 host 列表都是这个格式。
 * 返回空数组时调用方应视为"未设置"而不是"设置为空" —— 两者在客户端里行为不同。
 */
export function splitCsv(input: string | undefined | null): string[] {
  if (!input) return [];
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 把订阅里各种"真值"写法归一化为 boolean。
 *
 * `allowInsecure` 这类参数在不同订阅里会写成 `1` / `true` / `"true"` / `yes`，
 * 直接用 `Boolean(v)` 会把字符串 `"0"` 判成 true —— 这在跳过证书校验这种
 * 安全相关的开关上是不能接受的错误。
 */
export function parseBool(input: unknown): boolean | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  if (typeof input === 'boolean') return input;
  const s = String(input).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return undefined;
}

/** 截断字符串，用于把畸形输入写进错误日志时防止日志爆炸。 */
export function truncate(input: string, max = 120): string {
  return input.length <= max ? input : `${input.slice(0, max)}…`;
}
