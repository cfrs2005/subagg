import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import type { AppContext } from '../../context.js';
import { googleAuthEnabled } from '../../config.js';
import {
  hashAuthValue,
  openAuthValue,
  randomOpaqueToken,
  sealAuthValue,
} from '../../core/auth-crypto.js';
import {
  CSRF_COOKIE,
  getAuthenticatedSession,
  OAUTH_COOKIE,
  requireAdmin,
  SESSION_COOKIE,
} from '../auth.js';

const OAUTH_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;

function callbackUri(ctx: AppContext): string {
  return new URL('/auth/google/callback', ctx.config.publicBaseUrl).toString();
}

function cookieBase(ctx: AppContext) {
  return {
    path: '/',
    secure: ctx.config.sessionCookieSecure,
    sameSite: 'lax' as const,
  };
}

function clearAuthCookies(ctx: AppContext, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, cookieBase(ctx));
  reply.clearCookie(CSRF_COOKIE, cookieBase(ctx));
  reply.clearCookie(OAUTH_COOKIE, cookieBase(ctx));
}

function authFailurePage(message: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>登录失败</title><body style="font:16px/1.6 system-ui;max-width:36rem;margin:12vh auto;padding:0 1.5rem"><h1>无法登录</h1><p>${message}</p><p><a href="/">返回首页</a></p></body></html>`;
}

export function createAuthRoutes(ctx: AppContext): FastifyPluginAsync {
  return async function authRoutes(app: FastifyInstance): Promise<void> {
    app.get('/config', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
      return {
        google: { enabled: googleAuthEnabled(ctx.config) },
        accessMode: 'owner_only',
        devLoginEnabled: ctx.config.appEnv !== 'production' && ctx.config.allowDevLogin,
      };
    });

    app.get('/google/start', async (_req, reply) => {
      if (!ctx.googleOidc || !ctx.config.sessionSecret) {
        return reply.code(503).send({ error: 'Google 登录尚未配置' });
      }

      const now = Date.now();
      ctx.auth.prune(now);
      const authorization = await ctx.googleOidc.createAuthorizationRequest(callbackUri(ctx));
      const attemptToken = randomOpaqueToken();
      ctx.auth.createOAuthAttempt({
        tokenHash: hashAuthValue(attemptToken, ctx.config.sessionSecret),
        stateHash: hashAuthValue(authorization.state, ctx.config.sessionSecret),
        nonce: authorization.nonce,
        codeVerifierEnc: sealAuthValue(authorization.codeVerifier, ctx.config.sessionSecret),
        expiresAt: now + OAUTH_TTL_MS,
        createdAt: now,
      });

      reply
        .setCookie(OAUTH_COOKIE, attemptToken, {
          ...cookieBase(ctx),
          httpOnly: true,
          maxAge: OAUTH_TTL_MS / 1000,
        })
        .header('cache-control', 'no-store');
      return reply.redirect(authorization.url.toString());
    });

    app.get<{
      Querystring: Record<string, string | undefined>;
    }>('/google/callback', async (req, reply) => {
      const secret = ctx.config.sessionSecret;
      const oidc = ctx.googleOidc;
      const attemptToken = req.cookies[OAUTH_COOKIE];
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const now = Date.now();

      reply.clearCookie(OAUTH_COOKIE, cookieBase(ctx)).header('cache-control', 'no-store');
      if (!secret || !oidc || !attemptToken) {
        return reply.code(400).type('text/html').send(authFailurePage('登录请求已失效，请重新开始。'));
      }

      const attempt = ctx.auth.consumeOAuthAttempt(
        hashAuthValue(attemptToken, secret),
        hashAuthValue(state, secret),
        now,
      );
      if (!attempt || !state || typeof req.query.code !== 'string' || req.query.error) {
        return reply.code(400).type('text/html').send(authFailurePage('登录请求已失效，请重新开始。'));
      }

      try {
        const currentUrl = new URL(callbackUri(ctx));
        for (const [key, value] of Object.entries(req.query)) {
          if (typeof value === 'string') currentUrl.searchParams.set(key, value);
        }
        const claims = await oidc.exchangeCallback(currentUrl, {
          callbackUri: callbackUri(ctx),
          state,
          nonce: attempt.nonce,
          codeVerifier: openAuthValue(attempt.codeVerifierEnc, secret),
        });

        const email = claims.email.trim().toLowerCase();
        const allowed = claims.emailVerified && ctx.config.googleAllowedEmails.includes(email);
        if (!claims.sub || !allowed) {
          ctx.logger.warn('Google 登录被访问策略拒绝');
          return reply.code(403).type('text/html').send(authFailurePage('此账号没有访问权限。'));
        }

        const accountId = ctx.auth.upsertGoogleAccount({
          googleSub: claims.sub,
          email,
          displayName: claims.name || email,
          avatarUrl: claims.picture,
          now,
        });
        const sessionToken = randomOpaqueToken();
        const csrfToken = randomOpaqueToken();
        ctx.auth.createSession({
          accountId,
          tokenHash: hashAuthValue(sessionToken, secret),
          csrfHash: hashAuthValue(csrfToken, secret),
          expiresAt: now + SESSION_TTL_MS,
          now,
        });

        reply.setCookie(SESSION_COOKIE, sessionToken, {
          ...cookieBase(ctx),
          httpOnly: true,
          maxAge: SESSION_TTL_MS / 1000,
        });
        reply.setCookie(CSRF_COOKIE, csrfToken, {
          ...cookieBase(ctx),
          httpOnly: false,
          maxAge: SESSION_TTL_MS / 1000,
        });
        return reply.redirect('/');
      } catch {
        ctx.logger.warn('Google 登录回调校验失败');
        return reply.code(400).type('text/html').send(authFailurePage('Google 身份校验失败，请重新登录。'));
      }
    });

    app.get('/me', async (req, reply) => {
      const session = getAuthenticatedSession(ctx, req);
      reply.header('cache-control', 'no-store');
      if (!session) return reply.code(401).send({ error: '未登录' });
      return {
        user: {
          id: session.accountId,
          email: session.email,
          name: session.displayName,
          avatarUrl: session.avatarUrl,
        },
      };
    });

    app.post('/logout', { preHandler: requireAdmin(ctx) }, async (req, reply) => {
      const secret = ctx.config.sessionSecret;
      const token = req.cookies[SESSION_COOKIE];
      if (secret && token) ctx.auth.revokeSession(hashAuthValue(token, secret), Date.now());
      clearAuthCookies(ctx, reply);
      reply.header('cache-control', 'no-store');
      return { ok: true };
    });
  };
}
