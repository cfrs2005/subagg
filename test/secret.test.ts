import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  deriveKey,
  encryptSecret,
  isSecretDecryptError,
  SecretDecryptError,
} from '../src/core/secret.js';

const key = deriveKey('admin-token-for-tests-0123456789');
const otherKey = deriveKey('a-different-admin-token-987654321');

/** 把密文的 base64url 主体解出来，改一个字节再编回去 —— 模拟"密文被改过"。 */
function tamper(payload: string, byteOffset: number): string {
  const [version, body] = payload.split(':') as [string, string];
  const raw = Buffer.from(body, 'base64url');
  raw[byteOffset] = raw[byteOffset]! ^ 0xff;
  return `${version}:${raw.toString('base64url')}`;
}

describe('core/secret 密钥派生', () => {
  it('同一个管理令牌派生出同一把 32 字节密钥，不同令牌派生出不同密钥', () => {
    expect(key).toHaveLength(32);
    expect(deriveKey('admin-token-for-tests-0123456789').equals(key)).toBe(true);
    expect(otherKey.equals(key)).toBe(false);
  });

  it('拒绝空令牌', () => {
    expect(() => deriveKey('')).toThrow(/非空/);
  });
});

describe('core/secret 往返', () => {
  it('明文原样回来', () => {
    const plain = 'zf-account-password-!@#$%^&*()';
    expect(decryptSecret(encryptSecret(plain, key), key)).toBe(plain);
  });

  it('空字符串也往返（凭据可能被清空成空串，不能因此抛）', () => {
    expect(decryptSecret(encryptSecret('', key), key)).toBe('');
  });

  it('中文与 emoji 往返（UTF-8 不能在 Buffer 边界上被切坏）', () => {
    const plain = '腾讯上海P 线路凭据 🔐 密码：口令一二三';
    expect(decryptSecret(encryptSecret(plain, key), key)).toBe(plain);
  });

  it('超长明文往返（JWT 拼起来能上几 KB）', () => {
    const plain = 'x'.repeat(64 * 1024) + '尾';
    expect(decryptSecret(encryptSecret(plain, key), key)).toBe(plain);
  });

  it('带版本前缀，且前缀之后是 base64url（不含 + / =，可直接进 URL 与 JSON）', () => {
    const payload = encryptSecret('secret', key);
    expect(payload.startsWith('v1:')).toBe(true);
    expect(payload.slice(3)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('密文里不出现明文（最基本的一条：别把加密写成了编码）', () => {
    const plain = 'PLAINTEXT-NEEDLE-abcdef';
    const payload = encryptSecret(plain, key);
    expect(payload).not.toContain(plain);
    expect(Buffer.from(payload.slice(3), 'base64url').toString('latin1')).not.toContain(plain);
  });

  it('同一明文两次加密结果不同（IV 必须每次重随机 —— GCM 下 IV 重用是致命误用）', () => {
    const a = encryptSecret('same-plaintext', key);
    const b = encryptSecret('same-plaintext', key);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe('same-plaintext');
    expect(decryptSecret(b, key)).toBe('same-plaintext');
  });
});

describe('core/secret 解密失败', () => {
  it('错的密钥必抛，且是可识别的 SecretDecryptError', () => {
    const payload = encryptSecret('secret', key);
    let caught: unknown;
    try {
      decryptSecret(payload, otherKey);
    } catch (err) {
      caught = err;
    }
    expect(isSecretDecryptError(caught)).toBe(true);
    expect((caught as SecretDecryptError).reason).toBe('auth-failed');
    // 这条错误会一路走进日志与界面 —— 必须给出下一步动作。
    expect((caught as SecretDecryptError).message).toContain('重新录入凭据');
  });

  it('改一个字节的密文体必抛（GCM 完整性）', () => {
    const payload = encryptSecret('secret-payload', key);
    // 12 字节 iv + 16 字节 tag 之后才是密文体
    expect(() => decryptSecret(tamper(payload, 30), key)).toThrow(SecretDecryptError);
  });

  it('改 authTag 必抛', () => {
    const payload = encryptSecret('secret-payload', key);
    expect(() => decryptSecret(tamper(payload, 12), key)).toThrow(SecretDecryptError);
  });

  it('改 IV 必抛', () => {
    const payload = encryptSecret('secret-payload', key);
    expect(() => decryptSecret(tamper(payload, 0), key)).toThrow(SecretDecryptError);
  });

  it('不认识的版本前缀必抛 unknown-version', () => {
    const payload = encryptSecret('secret', key);
    const bumped = `v2:${payload.slice(3)}`;
    let caught: unknown;
    try {
      decryptSecret(bumped, key);
    } catch (err) {
      caught = err;
    }
    expect((caught as SecretDecryptError).reason).toBe('unknown-version');
  });

  it('完全不是密文的输入（比如某列里其实是明文口令）必抛，且错误消息不回显那段明文', () => {
    let caught: unknown;
    try {
      decryptSecret('hunter2:my-airport-password', key);
    } catch (err) {
      caught = err;
    }
    expect((caught as SecretDecryptError).reason).toBe('unknown-version');
    expect((caught as SecretDecryptError).message).not.toContain('hunter2');
    expect((caught as SecretDecryptError).message).not.toContain('my-airport-password');
  });

  it('没有分隔符的输入必抛 unknown-version', () => {
    expect(() => decryptSecret('not-a-payload-at-all', key)).toThrow(SecretDecryptError);
  });

  it('长度不足以容纳 iv+tag 的密文抛 malformed', () => {
    let caught: unknown;
    try {
      decryptSecret(`v1:${Buffer.alloc(8).toString('base64url')}`, key);
    } catch (err) {
      caught = err;
    }
    expect((caught as SecretDecryptError).reason).toBe('malformed');
  });

  it('密钥长度不对时也走可识别错误（services 只需 catch 一种类型就能降级）', () => {
    const payload = encryptSecret('secret', key);
    let caught: unknown;
    try {
      decryptSecret(payload, Buffer.alloc(16));
    } catch (err) {
      caught = err;
    }
    expect((caught as SecretDecryptError).reason).toBe('bad-key');
  });

  it('加密时密钥长度不对直接抛（这是编程错误，不该被当成数据问题吞掉）', () => {
    expect(() => encryptSecret('secret', Buffer.alloc(16))).toThrow(/32 字节/);
    expect(() => encryptSecret('secret', Buffer.alloc(16))).not.toThrow(SecretDecryptError);
  });
});
