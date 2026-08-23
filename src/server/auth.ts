/**
 * 管理 API 鉴权。
 *
 * 就一件事：校验 `Authorization: Bearer <ADMIN_TOKEN>`。
 * 但有两个细节值得单独写清楚。
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';

/**
 * 时间恒定的字符串比较。
 *
 * 用 `a === b` 比较密钥是有问题的：JS 的字符串比较在遇到第一个不同的字符时
 * 就会返回，耗时与"前多少个字符匹配"成正比。攻击者可以据此逐字符地
 * 把 token 试出来 —— 这就是计时侧信道攻击。
 *
 * `timingSafeEqual` 要求两个 Buffer 长度相同，长度不同时它会抛异常。
 * 所以先比长度 —— 泄漏长度信息是可以接受的（我们的 token 长度是固定的，
 * 本来就不是秘密），泄漏内容不行。
 */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 从请求中取出 Bearer token。也接受 `?token=` 查询参数以便调试。 */
function extractToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  // X-Admin-Token 是给不方便设置 Authorization 头的场景准备的（某些前端框架、
  // 浏览器扩展）。刻意**不**支持 ?token= 查询参数 ——
  // URL 会被记进浏览器历史、反代日志和 Referer 头，把管理口令放进去太危险。
  const custom = req.headers['x-admin-token'];
  if (typeof custom === 'string' && custom.length > 0) return custom;
  return undefined;
}

/**
 * Fastify preHandler：拦截未授权的管理 API 请求。
 *
 * 失败一律返回 401 且不区分"没带 token"与"token 错了" ——
 * 区分这两者不会给合法用户带来任何便利，却会给爆破者提供反馈。
 */
export function requireAdmin(ctx: AppContext) {
  return async function preHandler(req: FastifyRequest, reply: FastifyReply) {
    const provided = extractToken(req);

    if (!provided || !safeCompare(provided, ctx.config.adminToken)) {
      ctx.logger.warn('管理 API 鉴权失败', {
        path: req.url,
        method: req.method,
        // 刻意不记录 provided 的任何内容 —— 那是攻击者尝试的口令，
        // 写进日志等于替他把它落了盘
      });
      // 必须 return reply。在 async 钩子里只调用 reply.send() 而不返回它，
      // Fastify 无法确定生命周期是否应当中止，会继续执行后续处理器。
      return reply.code(401).send({ error: '未授权' });
    }
    return undefined;
  };
}
