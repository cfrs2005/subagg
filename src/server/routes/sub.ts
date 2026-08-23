/**
 * `GET /sub/:token` —— 对外的核心端点。
 *
 * 这是整个项目唯一一个**面向代理客户端**的接口，也是产品价值的兑现处：
 * 用户把这一条链接填进 Clash / Shadowrocket / v2rayN，各自拿到能用的格式。
 *
 * 除了返回体，响应头同样是功能的一部分：
 *
 * | 响应头 | 作用 |
 * |--------|------|
 * | `Subscription-Userinfo` | 客户端据此显示流量条与到期时间。**不返回它，用户就看不到流量。** |
 * | `Profile-Update-Interval` | 告诉客户端多久来拉一次 |
 * | `Content-Disposition` | 决定客户端里显示的配置名 |
 * | `X-Subagg-*` | 我们自己的诊断信息：节点数、跳过数、判定依据 |
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { AppContext } from '../../context.js';
import { fileExtensionFor } from '../../core/emit/index.js';
import { hashIp } from '../../db/repo/sharing.js';
import { renderProfile } from '../../services/render.js';

/**
 * 把任意字符串变成合法的 HTTP 头部值。
 *
 * HTTP 头部值只能是 latin1。我们的跳过原因、警告信息都是中文，
 * 直接塞进去会让 Node 抛错（`Invalid character in header content`），
 * 整个响应失败 —— 一个诊断信息把主功能搞挂了，得不偿失。
 *
 * 这里只对非 ASCII 字符做百分号编码，ASCII 部分保持可读，
 * 便于用 `curl -I` 直接查看。
 */
function toHeaderValue(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, (ch) => encodeURIComponent(ch));
}

interface SubParams {
  token: string;
}

interface SubQuery {
  /** 显式指定输出格式，压过 UA 判定。 */
  target?: string;
  /** 传 `0` 得到明文 URI 列表而非 base64，便于人工核对。 */
  base64?: string;
}

export function createSubRoutes(ctx: AppContext): FastifyPluginAsync {
  return async function subRoutes(app: FastifyInstance): Promise<void> {
    // This limiter is created once at route registration. Creating it per request
    // would allocate a fresh store and provide no protection.
    const tokenLimiter = app.createRateLimit({
      max: ctx.config.subTokenRateLimit,
      timeWindow: '1 minute',
      keyGenerator: (req) => `tok:${(req.params as SubParams).token}`,
    });
    app.get<{ Params: SubParams; Querystring: SubQuery }>(
      '/:token',
      {
        // 限流只加在这个端点上：它是公开的，且每次请求都要读全部节点并生成配置，
        // 是最值得保护的地方。管理 API 有鉴权，不需要额外限流。
        config: {
          rateLimit: {
            max: ctx.config.subRateLimit,
            timeWindow: '1 minute',
          },
        },
      },
      async (req, reply) => {
        const { token } = req.params;

        // ── 1. 校验 token ──────────────────────────────
        const check = ctx.tokens.check(token);
        if (!check.valid) {
          // 三种失败原因映射到不同提示，但都是 404 ——
          // 用 403 区分"存在但被吊销"会把"哪些 token 存在"泄漏给枚举者。
          const message = {
            'not-found': '订阅链接不存在',
            revoked: '订阅链接已被吊销',
            expired: '订阅链接已过期',
          }[check.reason];

          ctx.logger.info('订阅请求被拒绝', {
            reason: check.reason,
            client: req.headers['user-agent'],
          });
          return reply.code(404).type('text/plain; charset=utf-8').send(message);
        }

        // Run token limiting only after check(): random invalid tokens must not
        // fill the limiter's LRU and evict buckets for real shared links.
        const tokenRate = await tokenLimiter(req);
        // @fastify/rate-limit uses isExceeded for normal limits; isAllowed is
        // reserved for allowList hits and is false for an ordinary request.
        if ('isExceeded' in tokenRate && tokenRate.isExceeded) {
          const retryAfter = Math.max(1, Math.ceil(tokenRate.ttl / 1000));
          reply.header('retry-after', String(retryAfter));
          return reply.code(429).type('text/plain; charset=utf-8').send('订阅链接请求过于频繁');
        }

        const since = check.token.quotaWindowHours === null
          ? null
          : Date.now() - check.token.quotaWindowHours * 3600_000;
        const usage = ctx.tokens.usageForToken(token, since);
        const state = ctx.tokens.tokenState(check.token, usage);
        if (state.state === 'quota') {
          if (state.rolling) {
            reply.header('retry-after', String(Math.max(1, Math.ceil((state.retryAfterMs ?? 60_000) / 1000))));
            return reply.code(429).type('text/plain; charset=utf-8').send('订阅链接在当前时间窗口内已达到拉取次数上限');
          }
          return reply.code(404).type('text/plain; charset=utf-8').send('拉取次数已用尽');
        }

        const profile = ctx.profiles.get(check.token.profileId);
        if (!profile) {
          // token 存在但配置文件没了。理论上被 ON DELETE CASCADE 挡住了，
          // 这里是防御性处理。
          ctx.logger.error('token 指向了不存在的配置文件', {
            profileId: check.token.profileId,
          });
          return reply.code(404).type('text/plain; charset=utf-8').send('配置文件不存在');
        }

        // ── 2. 渲染 ────────────────────────────────────
        const result = renderProfile(ctx, profile, {
          explicitTarget: req.query.target,
          userAgent: req.headers['user-agent'],
          base64: req.query.base64 === '0' ? false : undefined,
        });

        const bytes = Buffer.byteLength(result.body, 'utf8');

        // ── 3. 记录访问 ────────────────────────────────
        //
        // 这是"共享管理"模块唯一的真实数据来源。好友的代理流量不经过我们，
        // 能观测到的只有"他的客户端来拉了订阅"这个动作本身。
        try {
          ctx.tokens.touch(token);
          ctx.accessLog.record({
            token,
            profileId: profile.id,
            friendId: check.token.friendId,
            client: result.client,
            userAgent: req.headers['user-agent'] ?? '',
            ipHash: hashIp(req.ip, ctx.config.ipHashSalt),
            target: result.target,
            nodeCount: result.nodeCount,
            bytes,
          });
          const sourceLimit = check.token.sourceLimit ?? ctx.config.shareSourceAlert;
          if (sourceLimit > 0) {
            const current = ctx.tokens.usageForToken(token, Date.now() - 30 * 86400_000);
            if (current.distinctSources >= sourceLimit) {
              ctx.logger.warn('订阅 token 来源数达到告警阈值', {
                token,
                distinctSources: current.distinctSources,
                sourceLimit,
              });
            }
          }
        } catch (err) {
          // 记日志失败绝不能影响用户拿到订阅 —— 主功能优先
          ctx.logger.warn('访问日志写入失败', {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // ── 4. 响应头 ──────────────────────────────────
        reply.type(result.contentType);

        // 没有这个头，客户端里的流量条就是空的
        if (result.userinfoHeader) {
          reply.header('subscription-userinfo', result.userinfoHeader);
        }
        reply.header('profile-update-interval', String(profile.updateInterval));

        // RFC 5987 的 filename* 语法，能正确携带中文配置名
        const filename = `${profile.name}.${fileExtensionFor(result.target)}`;
        reply.header(
          'content-disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        );

        // 诊断信息。用户排查"节点怎么少了"时，一条 curl -I 就能看清全貌。
        reply.header('x-subagg-nodes', String(result.nodeCount));
        reply.header('x-subagg-target', `${result.target} (${result.targetSource})`);
        if (result.chain) reply.header('x-subagg-chain', String(result.chain.pairCount));
        if (result.skipped.length > 0) {
          reply.header('x-subagg-skipped', String(result.skipped.length));
          // 只放第一条原因：同一批被跳过的节点原因通常相同，
          // 而头部长度是有限的，全放进去可能超出反代的头部大小上限
          reply.header('x-subagg-skipped-reason', toHeaderValue(result.skipped[0]?.reason ?? ''));
        }
        if (result.warnings.length > 0) {
          reply.header('x-subagg-warning', toHeaderValue(result.warnings.join(' | ')));
        }

        ctx.logger.info('订阅已下发', {
          profile: profile.name,
          client: result.client,
          target: result.target,
          targetSource: result.targetSource,
          nodeCount: result.nodeCount,
          skipped: result.skipped.length,
          bytes,
        });

        return reply.send(result.body);
      },
    );
  };
}
