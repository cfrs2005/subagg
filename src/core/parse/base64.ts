/**
 * V2Ray 风格订阅的解析：一堆 URI，每行一条，整体再套一层 base64。
 *
 * 这是最古老也最通用的订阅格式，v2rayN / Shadowrocket / NekoBox 都吃它。
 * 格式极其简单，但有两个实践中的坑：
 *
 * 1. **不是所有订阅都真的做了 base64**。有些机场直接返回明文 URI 列表。
 *    所以要先嗅探再决定是否解码。
 * 2. **单条解析失败不能拖垮整体**。订阅里混入一条格式错误的 URI 是常态，
 *    正确做法是跳过它并记录，而不是整个订阅报错。
 */

import type { ParseIssue, ParseResult, ProxyNodeDraft } from '../types.js';
import { parseUri } from './uri.js';
import { decodeBase64, looksLikeBase64, truncate } from './util.js';

/**
 * 解析 URI 列表形式的订阅内容。
 *
 * 自动处理"整体 base64"与"明文列表"两种情况。
 *
 * @param raw 订阅响应体原文
 */
export function parseUriList(raw: string): ParseResult {
  const text = unwrapBase64(raw);

  const nodes: ProxyNodeDraft[] = [];
  const issues: ParseIssue[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    // 跳过空行与注释行。部分机场会在订阅顶部加 `#` 开头的公告。
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    const outcome = parseUri(trimmed);
    if (outcome.ok) {
      nodes.push(outcome.node);
    } else {
      issues.push({ raw: truncate(trimmed), reason: outcome.reason });
    }
  }

  return { nodes, issues };
}

/**
 * 如果内容整体是 base64 就解开，否则原样返回。
 *
 * 判断依据不只是字符集 —— 一条明文的 `ss://YWVzLTI1Ni1nY206…` 也可能通过字符集检查。
 * 所以额外要求：内容里不含 `://`（明文 URI 列表必然含有），且解码结果里出现了 `://`。
 */
function unwrapBase64(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('://')) return trimmed;
  if (!looksLikeBase64(trimmed)) return trimmed;

  const decoded = decodeBase64(trimmed);
  // 解码后必须看起来像 URI 列表，否则说明我们猜错了，回退到原文
  return decoded && decoded.includes('://') ? decoded : trimmed;
}
