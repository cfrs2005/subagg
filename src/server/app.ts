/**
 * Fastify 应用装配。
 *
 * 路由分成三块，边界很清楚：
 *
 * - `/sub/*`  —— **公开**。代理客户端拉订阅的地方，靠 token 鉴权，带限流。
 * - `/api/*`  —— **管理**。全量 Bearer 鉴权。
 * - `/`       —— 静态前端。
 *
 * 这条边界值得写下来，因为它决定了安全模型：`/sub` 必须能被公网访问
 * （否则客户端拉不到订阅），而 `/api` 一旦被访问到就等于全盘失守。
 * 所以生产部署时应当在反代层进一步限制 `/api` 的来源（见 SECURITY.md）。
 */

import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
import type { AppContext } from '../context.js';
import { createAdminRoutes } from './routes/admin.js';
import { createSubRoutes } from './routes/sub.js';

/**
 * 前端静态资源目录。
 *
 * `../../public` 相对于本文件：开发时是 `src/server/` → `<root>/public`，
 * 构建后是 `dist/server/` → `<root>/public`。两条路径都指向同一处，
 * 所以 tsx 与 node 两种运行方式无需区别对待。
 */
const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url));

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    // 用我们自己的 logger：Fastify 内置的 pino 不会对订阅 URL 与凭据脱敏，
    // 而这个服务的每条请求 URL 里都可能带着 token
    logger: false,
    // 只有确实部署在反代之后才信任 X-Forwarded-For。
    // 直接暴露时开启，等于允许任何人伪造来源 IP 绕过限流。
    trustProxy: ctx.config.trustProxy,
    // 订阅体可能不小（几百个节点的 Clash YAML 能到几百 KB），
    // 但请求体没有大到需要放宽的场景，保持默认的 1 MiB 上限
  });

  // ── 限流 ──────────────────────────────────────────────
  // global: false —— 只在显式声明了 config.rateLimit 的路由上生效。
  // 管理 API 有鉴权，不需要限流；限流只用于保护公开的 /sub 端点。
  await app.register(rateLimit, {
    global: false,
    // 达到上限时返回中文提示，而不是 Fastify 默认的英文对象
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `请求过于频繁，请在 ${Math.ceil(context.ttl / 1000)} 秒后重试`,
    }),
  });

  // ── 健康检查 ──────────────────────────────────────────
  // 无需鉴权：它不泄漏任何信息，而 Docker HEALTHCHECK 与外部监控都需要它。
  app.get('/healthz', async () => ({ ok: true }));

  // ── 路由 ──────────────────────────────────────────────
  await app.register(createSubRoutes(ctx), { prefix: '/sub' });
  await app.register(createAdminRoutes(ctx), { prefix: '/api' });

  // ── 静态前端 ──────────────────────────────────────────
  // 注册在最后：这样 /sub 与 /api 的路由优先匹配，
  // 静态服务只接管剩下的路径。
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
    index: ['index.html'],
  });

  // ── 错误处理 ──────────────────────────────────────────
  app.setErrorHandler(async (error, req, reply) => {
    const errorRecord = error as { message?: unknown; statusCode?: unknown };
    const message = typeof errorRecord.message === 'string' ? errorRecord.message : 'Unknown error';
    const statusCode = typeof errorRecord.statusCode === 'number' ? errorRecord.statusCode : undefined;

    ctx.logger.error('请求处理出错', {
      method: req.method,
      // req.url 里可能含有订阅 token，交给 logger 的脱敏逻辑处理
      url: req.url,
      error: message,
      statusCode,
    });

    const status = statusCode ?? 500;
    // 5xx 不回显内部错误信息 —— 那可能包含文件路径、SQL 片段之类的实现细节。
    // 4xx 是调用方的问题，回显具体原因才能帮他改对。
    await reply.code(status).send({
      error: status >= 500 ? '服务器内部错误' : message,
    });
  });

  app.setNotFoundHandler(async (req, reply) => {
    await reply.code(404).send({ error: `找不到 ${req.method} ${req.url}` });
  });

  return app;
}
