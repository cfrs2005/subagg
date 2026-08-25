/**
 * 限流日志的字段名与路径脱敏。
 *
 * 这个文件守着两件容易在 review 里被放过、但代价是凭据泄漏的事：
 *
 * 1. `redact()` 的敏感键匹配是**大小写不敏感的子串**匹配。给日志字段起名叫
 *    `tokenRef` / `limitKey` 会被整段打码，日志白记。
 * 2. `req.url` 这类相对路径不以 `http://` 开头，走不进 URL 脱敏分支 ——
 *    `{ path: '/api/tokens/<明文 token>/revoke' }` 会原样落盘。
 */

import { describe, expect, it } from 'vitest';
import { redact, redactPath } from '../../src/logger.js';
import { tokenRef } from '../../src/db/repo/sharing.js';

// 43 字符，与 randomBytes(32).toString('base64url') 同形
const FAKE_TOKEN = 'Ab3xY9_qLmNpQrStUvWxYz0123456789AbCdEfGhIjK';

describe('限流日志字段', () => {
  it('正向：限流日志的每个字段都原样保留', () => {
    const out = redact({
      layer: 'quota',
      ref: tokenRef(FAKE_TOKEN),
      ipHash: 'a1b2c3d4e5f60718',
      client: 'Clash.Meta',
      retryAfter: 776,
      limit: 20,
    }) as Record<string, unknown>;

    expect(out['layer']).toBe('quota');
    expect(out['ref']).toBe('Ab3xY9_q');
    expect(out['ipHash']).toBe('a1b2c3d4e5f60718');
    expect(out['client']).toBe('Clash.Meta');
    expect(out['retryAfter']).toBe(776);
    expect(out['limit']).toBe(20);
  });

  it('反向：字段名含 token / key / auth 会被打码，所以不能那样起名', () => {
    // SENSITIVE_KEYS 是子串匹配，这三个名字都会命中。
    // 而 mask() 对长度 ≤ 8 的值直接返回 '***' —— 打码后信息量为零，
    // 日志等于白记。这就是字段统一叫 `ref` 的原因。
    const out = redact({
      tokenRef: 'Ab3xY9_q',
      limitKey: 'Ab3xY9_q',
      authRef: 'Ab3xY9_q',
    }) as Record<string, unknown>;

    expect(out['tokenRef']).toBe('***');
    expect(out['limitKey']).toBe('***');
    expect(out['authRef']).toBe('***');
  });
});

describe('tokenRef', () => {
  it('取前 8 字符，且不等于原值', () => {
    const ref = tokenRef(FAKE_TOKEN);
    expect(ref).toHaveLength(8);
    expect(FAKE_TOKEN.startsWith(ref)).toBe(true);
    expect(ref).not.toBe(FAKE_TOKEN);
  });
});

describe('redactPath', () => {
  it('打码路径里的长 token 段', () => {
    const out = redactPath(`/api/tokens/${FAKE_TOKEN}/revoke`);
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).toContain('/api/tokens/');
    expect(out).toContain('/revoke');
  });

  it('打码订阅路径', () => {
    const out = redactPath(`/sub/${FAKE_TOKEN}`);
    expect(out).not.toContain(FAKE_TOKEN);
  });

  it('打码查询参数，保留短路径段', () => {
    const out = redactPath(`/sub/${FAKE_TOKEN}?target=clash.meta`);
    expect(out).not.toContain(FAKE_TOKEN);
    // 短段不该被误伤，否则日志就没法读了
    expect(redactPath('/api/nodes')).toBe('/api/nodes');
    expect(redactPath('/healthz')).toBe('/healthz');
  });

  it('经 redact 记 path 字段时自动脱敏', () => {
    // auth.ts 鉴权失败时记的就是这个形状。这条断言是该修复的真正守卫：
    // 它证明调用方不需要记得手动脱敏。
    const out = redact({ path: `/api/tokens/${FAKE_TOKEN}/revoke` }) as Record<string, unknown>;
    expect(out['path']).not.toContain(FAKE_TOKEN);
  });
});
