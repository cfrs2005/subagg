/**
 * 订阅格式嗅探与分发。
 *
 * 用户添加订阅时只给一条 URL，不会告诉我们里面是什么格式 —— 而且同一个机场的
 * 同一条链接，按不同 User-Agent 请求还会返回不同格式。所以必须能自动识别。
 *
 * 识别顺序按"信号强度"排列，强信号优先：
 *   1. 含 `proxies:` 的 YAML → Clash
 *   2. 含 `://` 的文本 → URI 列表（明文）
 *   3. 整块 base64 → 解码后回到第 1 步重新判断
 *
 * 允许调用方传入 `hint` 显式指定格式，跳过嗅探。当自动识别出错时，
 * 用户可以在界面上手动指定，这是必要的逃生舱。
 */

import type { ParseResult } from '../types.js';
import { parseUriList } from './base64.js';
import { parseClashYaml } from './clash.js';
import { decodeBase64, looksLikeBase64, truncate } from './util.js';

/** 已支持的订阅格式。`auto` 表示交给嗅探器判断。 */
export type SubscriptionFormat = 'clash' | 'uri-list' | 'auto';

export interface SubscriptionParseResult extends ParseResult {
  /** 实际使用的解析器。UI 上回显给用户，便于排查"节点数不对"的问题。 */
  detected: 'clash' | 'uri-list';
}

/**
 * 解析订阅响应体。
 *
 * @param raw 订阅响应体原文
 * @param hint 格式提示。`auto`（默认）走自动嗅探。
 */
export function parseSubscription(raw: string, hint: SubscriptionFormat = 'auto'): SubscriptionParseResult {
  if (hint === 'clash') {
    return { ...parseClashYaml(raw), detected: 'clash' };
  }
  if (hint === 'uri-list') {
    return { ...parseUriList(raw), detected: 'uri-list' };
  }

  const text = raw.trim();

  if (text.length === 0) {
    return {
      nodes: [],
      issues: [{ raw: '', reason: '订阅内容为空' }],
      detected: 'uri-list',
    };
  }

  // ── 1. Clash YAML ────────────────────────────────────
  // 用正则而不是简单的 includes('proxies')：后者会把 URI 列表里恰好含有
  // "proxies" 字样的节点名误判成 YAML。要求它出现在行首且后跟冒号。
  if (/^proxies\s*:/m.test(text)) {
    return { ...parseClashYaml(text), detected: 'clash' };
  }

  // ── 2. 明文 URI 列表 ─────────────────────────────────
  if (text.includes('://')) {
    return { ...parseUriList(text), detected: 'uri-list' };
  }

  // ── 3. 整块 base64 ───────────────────────────────────
  if (looksLikeBase64(text)) {
    const decoded = decodeBase64(text);
    if (decoded) {
      // 解码后可能是 Clash YAML（少见但存在），也可能是 URI 列表（常见）。
      // 递归一次即可 —— 解码结果里不会再套一层 base64。
      if (/^proxies\s*:/m.test(decoded)) {
        return { ...parseClashYaml(decoded), detected: 'clash' };
      }
      if (decoded.includes('://')) {
        return { ...parseUriList(decoded), detected: 'uri-list' };
      }
    }
  }

  // ── 无法识别 ─────────────────────────────────────────
  // 给出足够具体的失败原因。这里最常见的真实情况是：机场挂了，
  // 返回了一个 HTTP 200 的 HTML 错误页 / Cloudflare 挑战页。
  const looksLikeHtml = /^\s*<(!doctype|html)/i.test(text);
  return {
    nodes: [],
    issues: [
      {
        raw: truncate(text, 200),
        reason: looksLikeHtml
          ? '响应是 HTML 页面而非订阅内容（订阅链接可能已失效，或被人机验证拦截）'
          : '无法识别订阅格式（既不是 Clash YAML，也不是 URI 列表或 base64）',
      },
    ],
    detected: 'uri-list',
  };
}

export { parseUri, type UriParseOutcome } from './uri.js';
export { parseClashYaml, parseClashProxy } from './clash.js';
export { parseUriList } from './base64.js';
