/**
 * `GET /r/:token/:key` —— 规则集转换端点。
 *
 * ## 为什么不是 `/rules/:key`
 *
 * 规则集 URL 必须能被**客户端直接拉取**，不能走管理员鉴权 —— 所以用订阅
 * token 做凭据。同一个 token 既证明「你能拿到这份订阅」，也限定了
 * 「你只能拿到这份订阅里声明过的规则集」。
 *
 * ## 为什么 key 必须在编排里查，而不是从 URL 里带
 *
 * 如果接受 `?url=https://...`，这个端点就是一个**开放代理**：任何人可以用
 * 我们的服务器去请求任意地址，包括内网。所以只认编排里声明过的 provider key。
 * 顺带的好处是 SSRF 面为零。
 *
 * ## 失败时怎么办
 *
 * 转换不出来（源站挂了 / 返回 HTML / 格式不认识）就 302 到上游原始 URL。
 * 客户端会跟随重定向，最差情况等于「没有这层转换」，绝不会因为没有转换层
 * 而整份配置拉不到规则。
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { AppContext } from '../../context.js';
import { resolveEffectiveOrchestration } from '../../services/render.js';

interface RuleParams {
  token: string;
  key: string;
}

const MAX_KEY_LENGTH = 64;

export function createRuleRoutes(ctx: AppContext): FastifyPluginAsync {
  return async function ruleRoutes(app: FastifyInstance): Promise<void> {
    app.get<{ Params: RuleParams }>(
      '/:token/:key',
      {
        // 和订阅端点同一层保护：它同样是公开的，而且每次未命中缓存都要出网。
        config: {
          rateLimit: {
            max: ctx.config.subRateLimit,
            timeWindow: '1 minute',
          },
        },
      },
      async (req, reply) => {
        const { token, key } = req.params;

        const check = ctx.tokens.check(token);
        if (!check.valid) {
          return reply.code(404).type('text/plain; charset=utf-8').send('订阅链接不存在');
        }

        const profile = ctx.profiles.get(check.token.profileId);
        if (!profile) {
          return reply.code(404).type('text/plain; charset=utf-8').send('配置文件不存在');
        }

        if (!key || key.length > MAX_KEY_LENGTH) {
          return reply.code(404).type('text/plain; charset=utf-8').send('规则集不存在');
        }

        const orchestration = resolveEffectiveOrchestration(profile, ctx.settings);
        const providers = orchestration.providers ?? {};

        // 用 hasOwnProperty 而不是真值判断：`__proto__` 这类键会命中原型链，
        // 拿到一个不是 provider 的对象。
        if (!Object.prototype.hasOwnProperty.call(providers, key)) {
          ctx.logger.warn('规则集请求未命中编排声明', {
            profile: profile.name,
            key,
          });
          return reply.code(404).type('text/plain; charset=utf-8').send('规则集不存在');
        }

        const provider = providers[key];
        if (!provider) {
          return reply.code(404).type('text/plain; charset=utf-8').send('规则集不存在');
        }

        const cached = await ctx.ruleCache.get(provider.url, provider.behavior);

        if (!cached) {
          // 转换不出来就把它交还给上游。多一次 302，但不会多一个新故障点。
          return reply.redirect(provider.url, 302);
        }

        reply.header('cache-control', 'public, max-age=3600');
        reply.header('x-subagg-rule-count', String(cached.count));
        reply.header('x-subagg-rule-behavior', provider.behavior);
        if (cached.stale) reply.header('x-subagg-rule-stale', '1');

        return reply.type('text/plain; charset=utf-8').send(cached.body);
      },
    );
  };
}
