/**
 * 凭据的对称加解密（AES-256-GCM）。
 *
 * ## 这层加密防什么、不防什么（先把定位说清，免得被当成"凭据已经安全了"）
 *
 * 密钥从 `ADMIN_TOKEN` 派生，与密文躺在**同一台机器**上。所以它防的是
 * **数据库文件被单独带走**：备份同步到了网盘、`data/subagg.db` 被误提交进
 * 仓库、排障时把库文件随手传给别人。这些场景里文件离开了机器，而
 * `ADMIN_TOKEN` 留在 systemd 的 EnvironmentFile / `.env` 里没跟着走。
 *
 * 它**不防主机沦陷**：能读到库文件的攻击者通常也能读到 `.env`。
 * 这层加密只是把泄露门槛从"拿到文件"抬到"拿到文件 + 拿到环境变量"。
 *
 * 代价也要说明白：**轮换 `ADMIN_TOKEN` 之后，已存的密文再也解不开**。
 * 这不是 bug 而是设计的必然结果，调用方必须能识别解密失败
 * （`SecretDecryptError`），把对应 provider 标成"需重新录入凭据"并优雅降级，
 * 而不是让服务崩掉。
 *
 * ## 为什么 core/ 里可以有它（core 零 IO）
 *
 * 与 `fingerprint.ts` 同属既有例外：`node:crypto` 是纯计算。这个模块
 * 不读环境变量、不读文件、不碰时钟、不发请求 —— **密钥当参数传入**，
 * 密钥从哪儿来是 services 层的事。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
/** GCM 的标准 nonce 长度。12 字节是硬件与实现共同优化过的路径，别改成 16。 */
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** 密文的版本前缀。日后换算法就加 `v2`，`v1` 的旧数据仍然解得开。 */
const VERSION = 'v1';
/**
 * 固定 salt。
 *
 * 密钥必须能在每次重启后重新派生出**同一个**值，所以 salt 不能随机 ——
 * 随机就得把 salt 也存下来，而它和密文一样落在同一台机器上，
 * 安全性没有任何提升，只是多了一份要维护的状态。
 */
const KDF_SALT = 'subagg-ix-v1';

/**
 * 解密失败的原因。
 *
 * `auth-failed` 刻意**不区分**"密钥不对"和"密文被改" —— GCM 的校验本身
 * 就区分不了，而且区分了等于给攻击者提示。
 */
export type SecretDecryptReason = 'bad-key' | 'unknown-version' | 'malformed' | 'auth-failed';

/**
 * 可识别的解密失败。
 *
 * 存在的意义是让 services 层能 `catch` 得住并降级：轮换过 `ADMIN_TOKEN` 的
 * 库里，每个 IX provider 的凭据都解不开，此时正确行为是标记"需重新录入"
 * 并回落直连，不是让订阅请求 500。
 *
 * ⚠️ message 里**绝不能**出现明文、密钥或完整密文 —— 它会被打进日志。
 */
export class SecretDecryptError extends Error {
  readonly reason: SecretDecryptReason;

  constructor(reason: SecretDecryptReason, message: string) {
    super(message);
    this.name = 'SecretDecryptError';
    this.reason = reason;
  }
}

export function isSecretDecryptError(err: unknown): err is SecretDecryptError {
  return err instanceof SecretDecryptError;
}

/**
 * 从管理令牌派生 32 字节密钥。
 *
 * 用 `scryptSync` 而不是裸 SHA256：`ADMIN_TOKEN` 虽然是随机串，但派生函数
 * 的选择要按"万一用户填了个弱口令"来定。参数取 Node 默认
 * （N=16384, r=8, p=1），派生只在装配时发生一次，成本可以忽略。
 */
export function deriveKey(adminToken: string): Buffer {
  if (!adminToken) {
    throw new Error('派生加密密钥需要非空的管理令牌');
  }
  return scryptSync(adminToken, KDF_SALT, KEY_BYTES);
}

/**
 * 加密。输出是**自包含**的单个字符串：`v1:<base64url(iv|authTag|ciphertext)>`。
 *
 * 自包含意味着数据库只需要一个 TEXT 列，不必为 iv 和 tag 各开一列 ——
 * 少两列就少两个"忘了一起写进去"的机会。
 *
 * 每次调用都用新的随机 IV：GCM 下 IV 重用会同时毁掉机密性和完整性，
 * 这是它唯一的致命误用方式。
 */
export function encryptSecret(plain: string, key: Buffer): string {
  assertEncryptKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  // 版本前缀留在 base64 之外：日后要分流 v1/v2 时不用先解码就能判断，
  // 而且人眼扫一遍数据库就知道这一列是密文不是明文。
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
}

/**
 * 解密。任何失败都抛 `SecretDecryptError`（带 `reason`），不抛别的类型 ——
 * 调用方只需要 catch 一种错误就能覆盖"密钥换了 / 数据被改 / 版本不认识"。
 */
export function decryptSecret(payload: string, key: Buffer): string {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new SecretDecryptError('bad-key', `解密密钥长度必须为 ${KEY_BYTES} 字节`);
  }

  const separator = payload.indexOf(':');
  const version = separator < 0 ? '' : payload.slice(0, separator);
  if (version !== VERSION) {
    // 只在版本串严格长得像版本号（v + 数字）时才回显它。否则这段就是任意
    // 输入的前缀 —— 某列存的可能其实是明文口令 `hunter2:foo`，一回显就把
    // 口令写进了日志。判据要窄，不能是"看着像标识符"。
    const shown = /^v\d{1,3}$/.test(version) ? `「${version}」` : '（无法识别的前缀）';
    throw new SecretDecryptError('unknown-version', `无法识别的密文版本${shown}，需要重新录入凭据`);
  }

  const raw = Buffer.from(payload.slice(separator + 1), 'base64url');
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new SecretDecryptError('malformed', '密文长度不足，无法取出 iv 与 authTag，需要重新录入凭据');
  }

  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = raw.subarray(IV_BYTES + TAG_BYTES);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // 走到这里说明 GCM 校验没过：密钥不匹配、密文被改、authTag 被改。
    // 三者不可区分，也不该区分。
    throw new SecretDecryptError(
      'auth-failed',
      '凭据解密失败：密钥不匹配或密文已损坏（轮换过 ADMIN_TOKEN 会导致这个结果），需要重新录入凭据',
    );
  }
}

function assertEncryptKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`加密密钥长度必须为 ${KEY_BYTES} 字节，请用 deriveKey() 派生`);
  }
}
