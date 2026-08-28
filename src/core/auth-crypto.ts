import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function authKey(sessionSecret: string): Buffer {
  return createHash('sha256').update('subagg-auth-v1\0').update(sessionSecret).digest();
}

export function randomOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashAuthValue(value: string, sessionSecret: string): string {
  return createHmac('sha256', sessionSecret)
    .update('subagg-auth-hash-v1\0')
    .update(value)
    .digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sealAuthValue(value: string, sessionSecret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', authKey(sessionSecret), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
}

export function openAuthValue(sealed: string, sessionSecret: string): string {
  const [version, encoded, extra] = sealed.split(':');
  if (version !== VERSION || !encoded || extra !== undefined) {
    throw new Error('不支持的认证密文格式');
  }

  const packed = Buffer.from(encoded, 'base64url');
  if (packed.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error('认证密文已损坏');
  }

  const iv = packed.subarray(0, IV_BYTES);
  const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = packed.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', authKey(sessionSecret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
