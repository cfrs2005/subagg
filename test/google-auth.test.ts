import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/** 白名单不再由代码写死，测试自带一个占位 owner。 */
const OWNER_EMAIL = 'owner@example.com';
import { createContext, type AppContext } from '../src/context.js';
import { closeDatabase } from '../src/db/index.js';
import type { Logger } from '../src/logger.js';
import { buildApp } from '../src/server/app.js';
import { CSRF_COOKIE, OAUTH_COOKIE, SESSION_COOKIE } from '../src/server/auth.js';
import { GoogleOidcService } from '../src/services/google-oidc.js';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-client-secret';
const SESSION_SECRET = 'test-session-secret-with-more-than-thirty-two-characters';

interface IssuerHarness {
  issuer: URL;
  setAuthorization(input: { nonce: string; codeChallenge: string }): void;
  close(): Promise<void>;
}

interface AuthTestApp {
  app: Awaited<ReturnType<typeof buildApp>>;
  ctx: AppContext;
  logs: string[];
  close(): Promise<void>;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function signJwt(privateKey: KeyObject, claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function startIssuer(): Promise<IssuerHarness> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' });
  let issuer = '';
  let expectedNonce = '';
  let expectedCodeChallenge = '';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer || 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');

    if (url.pathname === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      }));
      return;
    }

    if (url.pathname === '/jwks') {
      res.end(JSON.stringify({ keys: [{ ...publicJwk, kid: 'test-key', use: 'sig', alg: 'RS256' }] }));
      return;
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      const code = params.get('code') ?? '';
      const verifier = params.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (challenge !== expectedCodeChallenge) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const email = code === 'other' ? 'other@example.com'
        : code === 'plus' ? 'owner+tag@example.com'
          : code === 'dot' ? 'own.er@example.com'
            : code === 'normalized' ? ' OWNER@EXAMPLE.COM '
              : OWNER_EMAIL;
      const claims: Record<string, unknown> = {
        iss: code === 'wrong-issuer' ? 'https://issuer.invalid' : issuer,
        aud: code === 'wrong-audience' ? 'wrong-client' : CLIENT_ID,
        exp: code === 'expired' ? now - 30 : now + 300,
        iat: now,
        sub: code === 'new-sub' ? 'google-sub-2' : 'google-sub-owner',
        email,
        email_verified: code !== 'unverified',
        name: code === 'renamed' ? 'Owner Renamed' : 'Owner',
        picture: 'https://images.example/avatar.png',
        nonce: code === 'wrong-nonce' ? 'wrong-nonce' : expectedNonce,
      };
      if (code === 'missing-verification') delete claims.email_verified;
      res.end(JSON.stringify({
        access_token: 'google-access-token-must-not-persist',
        refresh_token: 'google-refresh-token-must-not-persist',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: signJwt(privateKey, claims),
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${address.port}`;

  return {
    issuer: new URL(issuer),
    setAuthorization(input) {
      expectedNonce = input.nonce;
      expectedCodeChallenge = input.codeChallenge;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve())),
  };
}

function setCookies(response: { headers: OutgoingHttpHeaders }): string[] {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.map(String) : value ? [String(value)] : [];
}

function cookieFrom(response: { headers: OutgoingHttpHeaders }, name: string): string {
  const line = setCookies(response).find((value) => value.startsWith(`${name}=`));
  if (!line) throw new Error(`Missing cookie ${name}`);
  return line.slice(name.length + 1).split(';')[0]!;
}

function makeLogger(logs: string[]): Logger {
  const write = (message: string, context?: Record<string, unknown>): void => {
    logs.push(JSON.stringify({ message, context }));
  };
  const logger: Logger = {
    debug: write,
    info: write,
    warn: write,
    error: write,
    child: () => logger,
  };
  return logger;
}

function productionConfig() {
  return loadConfig({
    APP_ENV: 'production',
    ADMIN_TOKEN: 'test-admin-token-0123456789',
    IP_HASH_SALT: 'test-ip-salt',
    PUBLIC_BASE_URL: 'https://site.example',
    WEB_APP_URL: 'https://site.example',
    DB_PATH: ':memory:',
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_ALLOWED_EMAILS: OWNER_EMAIL,
    SESSION_SECRET,
    SESSION_COOKIE_SECURE: 'true',
    ALLOW_DEV_LOGIN: 'false',
    SCHEDULER_INTERVAL_MIN: '0',
  });
}

let issuerHarness: IssuerHarness;

beforeAll(async () => {
  issuerHarness = await startIssuer();
});

afterAll(async () => {
  await issuerHarness.close();
});

async function setup(): Promise<AuthTestApp> {
  const logs: string[] = [];
  const ctx = createContext(productionConfig(), makeLogger(logs));
  ctx.googleOidc = new GoogleOidcService(CLIENT_ID, CLIENT_SECRET, issuerHarness.issuer, true);
  const app = await buildApp(ctx);
  return {
    app,
    ctx,
    logs,
    async close() {
      await app.close();
      closeDatabase(ctx.db);
    },
  };
}

async function begin(authApp: AuthTestApp) {
  const response = await authApp.app.inject({ method: 'GET', url: '/auth/google/start' });
  expect(response.statusCode).toBe(302);
  const location = new URL(response.headers.location!);
  expect(location.origin).toBe(issuerHarness.issuer.origin);
  expect(location.searchParams.get('redirect_uri')).toBe('https://site.example/auth/google/callback');
  expect(location.searchParams.get('scope')).toBe('openid email profile');
  expect(location.searchParams.get('state')).toBeTruthy();
  expect(location.searchParams.get('nonce')).toBeTruthy();
  expect(location.searchParams.get('code_challenge_method')).toBe('S256');
  issuerHarness.setAuthorization({
    nonce: location.searchParams.get('nonce')!,
    codeChallenge: location.searchParams.get('code_challenge')!,
  });
  return {
    attemptCookie: cookieFrom(response, OAUTH_COOKIE),
    state: location.searchParams.get('state')!,
  };
}

async function callback(authApp: AuthTestApp, flow: Awaited<ReturnType<typeof begin>>, code: string) {
  return authApp.app.inject({
    method: 'GET',
    url: `/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(flow.state)}`,
    cookies: { [OAUTH_COOKIE]: flow.attemptCookie },
  });
}

describe('Google OIDC owner-only authentication', () => {
  it('uses the exact callback, validates a signed ID token, and stores only hashed app secrets', async () => {
    const authApp = await setup();
    try {
      const flow = await begin(authApp);
      const response = await callback(authApp, flow, 'owner');
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/');

      const session = cookieFrom(response, SESSION_COOKIE);
      const csrf = cookieFrom(response, CSRF_COOKIE);
      const cookieLines = setCookies(response).join('\n');
      expect(cookieLines).toContain('HttpOnly');
      expect(cookieLines).toContain('Secure');
      expect(cookieLines).toContain('SameSite=Lax');

      const me = await authApp.app.inject({ method: 'GET', url: '/auth/me', cookies: { [SESSION_COOKIE]: session } });
      expect(me.statusCode).toBe(200);
      expect(me.json().user.email).toBe(OWNER_EMAIL);

      const stored = authApp.ctx.db.prepare('SELECT token_hash, csrf_hash FROM web_sessions').get() as Record<string, string>;
      expect(stored.token_hash).not.toContain(session);
      expect(stored.csrf_hash).not.toContain(csrf);
      expect(JSON.stringify(authApp.ctx.db.prepare('SELECT * FROM web_sessions').all())).not.toMatch(/google-(access|refresh)-token/);
      expect(authApp.ctx.auth.counts()).toMatchObject({ accounts: 1, sessions: 1 });
    } finally {
      await authApp.close();
    }
  });

  it('consumes a wrong-state attempt and rejects replay', async () => {
    const authApp = await setup();
    try {
      const flow = await begin(authApp);
      const wrong = await authApp.app.inject({
        method: 'GET',
        url: `/auth/google/callback?code=owner&state=wrong-state`,
        cookies: { [OAUTH_COOKIE]: flow.attemptCookie },
      });
      expect(wrong.statusCode).toBe(400);
      expect(await callback(authApp, flow, 'owner')).toHaveProperty('statusCode', 400);
      expect(authApp.ctx.auth.counts()).toMatchObject({ accounts: 0, sessions: 0 });
    } finally {
      await authApp.close();
    }
  });

  it.each(['other', 'unverified', 'missing-verification', 'plus', 'dot'])(
    'denies %s before creating an account or session',
    async (code) => {
      const authApp = await setup();
      try {
        const response = await callback(authApp, await begin(authApp), code);
        expect(response.statusCode).toBe(403);
        expect(response.body).not.toContain(OWNER_EMAIL);
        expect(authApp.ctx.auth.counts()).toMatchObject({ accounts: 0, sessions: 0 });
      } finally {
        await authApp.close();
      }
    },
  );

  it('normalizes case and surrounding whitespace but keys the account by Google sub', async () => {
    const authApp = await setup();
    try {
      expect((await callback(authApp, await begin(authApp), 'normalized')).statusCode).toBe(302);
      expect((await callback(authApp, await begin(authApp), 'renamed')).statusCode).toBe(302);
      const rows = authApp.ctx.db.prepare('SELECT google_sub, email, display_name FROM google_accounts').all();
      expect(rows).toEqual([{ google_sub: 'google-sub-owner', email: OWNER_EMAIL, display_name: 'Owner Renamed' }]);
    } finally {
      await authApp.close();
    }
  });

  it.each(['wrong-audience', 'wrong-issuer', 'expired', 'wrong-nonce'])(
    'rejects a signed token with invalid %s claims',
    async (code) => {
      const authApp = await setup();
      try {
        const response = await callback(authApp, await begin(authApp), code);
        expect(response.statusCode).toBe(400);
        expect(authApp.ctx.auth.counts()).toMatchObject({ accounts: 0, sessions: 0 });
      } finally {
        await authApp.close();
      }
    },
  );

  it('requires CSRF for unsafe cookie requests and revokes the session on logout', async () => {
    const authApp = await setup();
    try {
      const login = await callback(authApp, await begin(authApp), 'owner');
      const session = cookieFrom(login, SESSION_COOKIE);
      const csrf = cookieFrom(login, CSRF_COOKIE);
      const cookies = { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf };

      const missingCsrf = await authApp.app.inject({ method: 'POST', url: '/auth/logout', cookies });
      expect(missingCsrf.statusCode).toBe(403);
      const logout = await authApp.app.inject({
        method: 'POST',
        url: '/auth/logout',
        cookies,
        headers: { 'x-csrf-token': csrf },
      });
      expect(logout.statusCode).toBe(200);
      const me = await authApp.app.inject({ method: 'GET', url: '/auth/me', cookies: { [SESSION_COOKIE]: session } });
      expect(me.statusCode).toBe(401);
    } finally {
      await authApp.close();
    }
  });

  it('returns complete subscription URLs in the admin state for display and copy', async () => {
    const authApp = await setup();
    try {
      authApp.ctx.db
        .prepare("INSERT INTO profiles (id, name, created_at, updated_at) VALUES ('copy-profile','Copy profile',1,1)")
        .run();
      const token = authApp.ctx.tokens.create({ profileId: 'copy-profile' });
      const login = await callback(authApp, await begin(authApp), 'owner');
      const session = cookieFrom(login, SESSION_COOKIE);

      const response = await authApp.app.inject({
        method: 'GET',
        url: '/api/state',
        cookies: { [SESSION_COOKIE]: session },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().tokens).toContainEqual(
        expect.objectContaining({
          token: token.token,
          url: `https://site.example/sub/${token.token}`,
        }),
      );
    } finally {
      await authApp.close();
    }
  });

  it('rejects an expired application session', async () => {
    const authApp = await setup();
    try {
      const login = await callback(authApp, await begin(authApp), 'owner');
      const session = cookieFrom(login, SESSION_COOKIE);
      authApp.ctx.db.prepare('UPDATE web_sessions SET expires_at = ?').run(Date.now() - 1);
      const me = await authApp.app.inject({ method: 'GET', url: '/auth/me', cookies: { [SESSION_COOKIE]: session } });
      expect(me.statusCode).toBe(401);
    } finally {
      await authApp.close();
    }
  });

  it('disables production ADMIN_TOKEN fallback and exposes no provider secrets', async () => {
    const authApp = await setup();
    try {
      const api = await authApp.app.inject({
        method: 'GET',
        url: '/api/meta',
        headers: { authorization: `Bearer ${productionConfig().adminToken}` },
      });
      expect(api.statusCode).toBe(401);
      const config = await authApp.app.inject({ method: 'GET', url: '/auth/config' });
      expect(config.statusCode).toBe(200);
      expect(config.body).not.toContain(CLIENT_ID);
      expect(config.body).not.toContain(CLIENT_SECRET);
      expect(config.json()).toMatchObject({ google: { enabled: true }, accessMode: 'owner_only', devLoginEnabled: false });
    } finally {
      await authApp.close();
    }
  });

  it('never logs callback code, state, access token, or refresh token', async () => {
    const authApp = await setup();
    try {
      const flow = await begin(authApp);
      await callback(authApp, flow, 'wrong-audience');
      const logs = authApp.logs.join('\n');
      expect(logs).not.toContain(flow.state);
      expect(logs).not.toContain('wrong-audience');
      expect(logs).not.toContain('google-access-token');
      expect(logs).not.toContain('google-refresh-token');
    } finally {
      await authApp.close();
    }
  });
});
