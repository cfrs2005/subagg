import { describe, expect, it } from 'vitest';
import { googleAuthEnabled, loadConfig } from '../src/config.js';

/** 白名单不再由代码写死，测试自带一个占位 owner。 */
const OWNER_EMAIL = 'owner@example.com';

const BASE = {
  ADMIN_TOKEN: 'test-admin-token-0123456789',
  IP_HASH_SALT: 'test-ip-salt',
};

const PRODUCTION = {
  ...BASE,
  APP_ENV: 'production',
  PUBLIC_BASE_URL: 'https://site.example',
  WEB_APP_URL: 'https://site.example',
  GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_ALLOWED_EMAILS: OWNER_EMAIL,
  SESSION_SECRET: 'session-secret-with-at-least-thirty-two-characters',
  SESSION_COOKIE_SECURE: 'true',
  ALLOW_DEV_LOGIN: 'false',
};

describe('Google auth production config', () => {
  it('enables the exact owner-only secure production configuration', () => {
    const config = loadConfig(PRODUCTION);
    expect(googleAuthEnabled(config)).toBe(true);
    expect(config.googleAllowedEmails).toEqual([OWNER_EMAIL]);
    expect(config.sessionCookieSecure).toBe(true);
    expect(config.allowDevLogin).toBe(false);
  });

  it.each([
    ['missing Google client', { ...PRODUCTION, GOOGLE_CLIENT_ID: '' }],
    ['insecure public URL', { ...PRODUCTION, PUBLIC_BASE_URL: 'http://site.example', WEB_APP_URL: 'http://site.example' }],
    ['insecure cookie', { ...PRODUCTION, SESSION_COOKIE_SECURE: 'false' }],
    ['development login', { ...PRODUCTION, ALLOW_DEV_LOGIN: 'true' }],
    ['extra email', { ...PRODUCTION, GOOGLE_ALLOWED_EMAILS: `${OWNER_EMAIL},other@example.com` }],
    ['empty allowlist', { ...PRODUCTION, GOOGLE_ALLOWED_EMAILS: '' }],
  ])('rejects %s', (_label, env) => {
    expect(() => loadConfig(env)).toThrow(/配置校验失败/);
  });

  it('rejects mismatched fixed public URL aliases', () => {
    expect(() => loadConfig({ ...PRODUCTION, WEB_APP_URL: 'https://other.example' })).toThrow(
      /PUBLIC_BASE_URL 与 WEB_APP_URL 必须完全一致/,
    );
  });
});
