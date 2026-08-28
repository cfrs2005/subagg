import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { hashAuthValue, safeEqual } from '../core/auth-crypto.js';
import type { AuthenticatedSession } from '../db/repo/auth.js';

export const SESSION_COOKIE = 'subagg_session';
export const CSRF_COOKIE = 'subagg_csrf';
export const OAUTH_COOKIE = 'subagg_oauth';

const SESSION_TOUCH_INTERVAL_MS = 5 * 60_000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function extractAdminToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  const custom = req.headers['x-admin-token'];
  return typeof custom === 'string' && custom.length > 0 ? custom : undefined;
}

function sessionSecret(ctx: AppContext): string | null {
  return ctx.config.sessionSecret ?? null;
}

function currentSession(ctx: AppContext, req: FastifyRequest): AuthenticatedSession | null {
  const secret = sessionSecret(ctx);
  const token = req.cookies[SESSION_COOKIE];
  if (!secret || !token) return null;

  const now = Date.now();
  const tokenHash = hashAuthValue(token, secret);
  const session = ctx.auth.getSession(tokenHash, now);
  if (!session) return null;

  const email = session.email.trim().toLowerCase();
  if (!session.emailVerified || !ctx.config.googleAllowedEmails.includes(email)) {
    ctx.auth.revokeSession(tokenHash, now);
    return null;
  }

  if (now - session.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
    ctx.auth.touchSession(session.sessionId, now);
  }
  return session;
}

function validCsrf(ctx: AppContext, req: FastifyRequest, session: AuthenticatedSession): boolean {
  const secret = sessionSecret(ctx);
  const header = req.headers['x-csrf-token'];
  const cookie = req.cookies[CSRF_COOKIE];
  if (!secret || typeof header !== 'string' || !cookie || !safeEqual(header, cookie)) return false;
  return safeEqual(hashAuthValue(header, secret), session.csrfHash);
}

export function getAuthenticatedSession(
  ctx: AppContext,
  req: FastifyRequest,
): AuthenticatedSession | null {
  return currentSession(ctx, req);
}

/**
 * Prefer revocable Google application sessions. ADMIN_TOKEN remains a compatibility
 * path only in explicit development mode, which production validation rejects.
 */
export function requireAdmin(ctx: AppContext) {
  return async function preHandler(req: FastifyRequest, reply: FastifyReply) {
    const session = currentSession(ctx, req);
    if (session) {
      if (!SAFE_METHODS.has(req.method) && !validCsrf(ctx, req, session)) {
        return reply.code(403).send({ error: 'CSRF 校验失败' });
      }
      return undefined;
    }

    if (ctx.config.allowDevLogin) {
      const provided = extractAdminToken(req);
      if (provided && safeEqual(provided, ctx.config.adminToken)) return undefined;
    }

    ctx.logger.warn('管理 API 鉴权失败', {
      path: req.url,
      method: req.method,
    });
    return reply.code(401).send({ error: '未授权' });
  };
}
