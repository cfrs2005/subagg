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
import { sniffClient } from '../core/emit/index.js';
import { hashIp } from '../db/repo/sharing.js';
import { createAdminRoutes } from './routes/admin.js';
import { createSubRoutes } from './routes/sub.js';

/**
 * IP 层限流的私有标记，挂在 **request** 上传给 setErrorHandler。
 *
 * 为什么不挂在抛出的对象上：@fastify/rate-limit 是 `throw builder(...)`
 * 抛一个**普通对象**，而 Fastify 的错误处理链会据它重建一个 Error
 * （只搬 message / statusCode）—— 挂在上面的键，symbol 也好字符串也好，
 * 一律丢失。request 实例在整个请求生命周期不变，才是可靠的传递媒介。
 *
 * 用 Symbol 是为了它绝无可能与 Fastify 或插件的属性撞名。
 */
const SUBAGG_LIMIT_MARK: unique symbol = Symbol('subagg.limitLayer');

/** 挂标记 / 读标记。集中在这两个函数里，断言只写一次。 */
function markLimited(req: object, layer: 'ip'): void {
  (req as Record<symbol, unknown>)[SUBAGG_LIMIT_MARK] = layer;
}
function limitedLayer(req: object): unknown {
  return (req as Record<symbol, unknown>)[SUBAGG_LIMIT_MARK];
}

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
    // 达到上限时返回中文提示，而不是 Fastify 默认的英文对象。
    //
    // ⚠️ **这个返回值是被 `throw` 出去的，不是直接发给客户端的。**
    // @fastify/rate-limit 内部 `throw errorResponseBuilder(...)`，于是它会一路
    // 走到下面的 setErrorHandler 才真正成型。看着像"构造响应体"，实则是"构造异常"——
    // 不写清楚，下次改的人一定会误判。
    //
    // 也正因为如此，IP 层的日志写在这里最省事：这里能拿到 req 和 context.ttl/max，
    // 而 onExceeded 回调**拿不到** ttl/max，且它是同步调用、外面没有 try/catch，
    // 一抛异常就会把 429 变成 500。
    errorResponseBuilder: (req, context) => {
      const retryAfter = Math.ceil(context.ttl / 1000);
      markLimited(req, 'ip');
      ctx.limitStats.hit('ip');
      ctx.logger.warn('订阅请求被限流', {
        layer: 'ip',
        ipHash: hashIp(req.ip, ctx.config.ipHashSalt),
        client: sniffClient(req.headers['user-agent']).client,
        retryAfter,
        limit: context.max,
        // 刻意不记 token：IP 限流跑在 token 校验**之前**，此刻 URL 里那段
        // 是完全未经验证的用户输入，记进日志等于开一个日志注入的口子。
      });
      return {
        statusCode: 429,
        error: 'Too Many Requests',
        message: `请求过于频繁，请在 ${retryAfter} 秒后重试`,
      };
    },
  });

  // ── 错误处理 ──────────────────────────────────────────
  //
  // ⚠️ **必须注册在下面那些 `register()` 之前。**
  // Fastify 的 errorHandler / notFoundHandler 是**按封装上下文**继承的：
  // 子插件只继承它**注册那一刻**父级已有的处理器。放在 register 之后设置，
  // `/sub` 与 `/api` 就会一直用 Fastify 的默认处理 ——
  // 不脱敏、不记日志，5xx 还会把 `error.message` 原样回显给调用方。
  // 这条曾经真的踩过，别再把它挪到下面去。
  app.setErrorHandler(async (error, req, reply) => {
    const errorRecord = error as { message?: unknown; statusCode?: unknown };
    const message = typeof errorRecord.message === 'string' ? errorRecord.message : 'Unknown error';
    const statusCode = typeof errorRecord.statusCode === 'number' ? errorRecord.statusCode : undefined;

    // IP 层限流：上面的 errorResponseBuilder 抛过来的，认标记而不认状态码。
    // 单独接住有两个目的：
    //   1. 它不是故障 —— 不该以 level:"error" 混进真实 5xx 的告警里（日志已在
    //      errorResponseBuilder 里以 warn 记过，这里不重复记）；
    //   2. 响应体要与另外两层对齐成 text/plain。返回 JSON 会让代理客户端
    //      先拿它当 YAML/base64 解析，最后报"配置解析失败"，把人指向完全错误的方向。
    // 判据是 request 上的标记，**不能用 statusCode === 429** ——
    // 否则将来任何来源的 429 都会被贴上 "ip" 标签，诊断信息反而变成误导。
    if (limitedLayer(req) === 'ip') {
      await reply
        .code(429)
        .header('x-subagg-limit', 'ip')
        .header('cache-control', 'no-store')
        .type('text/plain; charset=utf-8')
        .send(message);
      return;
    }

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

  return app;
}
