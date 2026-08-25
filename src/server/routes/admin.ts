/**
 * 管理 API（`/api/*`）。全部需要 Bearer 鉴权。
 *
 * ## 一条贯穿本文件的取舍：节点列表不返回凭据
 *
 * `GET /api/nodes` 返回的是节点的**元信息**（名称、协议、地区、服务器、端口、
 * 来源），不含 UUID、密码这些凭据。
 *
 * 理由是暴露面控制：节点列表是 Web 界面上加载最频繁的接口，它的响应会经过
 * 浏览器内存、可能被开发者工具记录、被截图。把几百个节点的完整凭据在每次
 * 打开页面时都传一遍，是没有必要的风险。
 *
 * 真的需要完整凭据时（比如"复制节点 URI"），走
 * `GET /api/nodes/:fingerprint/uri` 单独取一条 —— 一次一个，有意为之。
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { EMIT_TARGETS, TARGET_LABELS, emitUri, type EmitTarget } from '../../core/emit/index.js';
import { applyFilter, DEFAULT_EXCLUDE_PATTERNS, type FilterRule } from '../../core/filter.js';
import { knownRegionCodes, regionNameZh, regionToFlag } from '../../core/region.js';
import { encodeQr, renderQrSvg } from '../../core/qrcode.js';
import { PROXY_TYPES, type ProxyType } from '../../core/types.js';
import type { UserinfoMode } from '../../core/userinfo.js';
import { tokenRef } from '../../db/repo/sharing.js';
import { renderProfile } from '../../services/render.js';
import { expandChain } from '../../core/chain.js';
import { requireAdmin } from '../auth.js';

// ─────────────────────────────────────────────────────────────
//  校验 schema
// ─────────────────────────────────────────────────────────────

/**
 * 协议与输出目标用字面量元组，而不是 `z.string().refine(...)`。
 *
 * 区别不只是风格：`refine` 不做类型收窄，解析结果的类型仍然是 `string`，
 * 于是把它传给需要 `ProxyType[]` 的函数时就必须加断言 —— 而一旦开始加断言，
 * 也就放弃了让编译器检查"schema 与领域类型是否一致"这件事。
 * `z.enum` 的解析结果直接就是字面量联合，类型天然对得上。
 *
 * 这里的 `satisfies` 负责**正向**对齐：清单里不能出现 core 不认识的协议。
 * **反向**对齐（core 新增了协议而这里忘了跟进）在下面 `/meta` 的响应里检查。
 */
const PROXY_TYPE_VALUES = [
  'vmess',
  'vless',
  'trojan',
  'ss',
  'ssr',
  'hysteria2',
  'tuic',
] as const satisfies readonly ProxyType[];

const ProxyTypeSchema = z.enum(PROXY_TYPE_VALUES);

const MatchExprSchema = z.object({
  field: z.enum(['name', 'server', 'type', 'region', 'source']),
  op: z.enum(['regex', 'contains', 'eq']),
  value: z.string().max(200),
});

const RenameRuleSchema = z.object({
  pattern: z.string().max(200).optional(),
  replace: z.string().max(200),
  all: z.boolean().optional(),
});

const ChainSelectorSchema = z.object({
  pick: z.array(z.string()).max(5000).optional(),
  sources: z.array(z.string()).optional(),
  regions: z.array(z.string().length(2)).optional(),
  types: z.array(ProxyTypeSchema).optional(),
  include: z.array(MatchExprSchema).max(50).optional(),
  exclude: z.array(MatchExprSchema).max(50).optional(),
});
const ChainRuleSchema = z.object({
  enabled: z.boolean().optional(),
  entry: ChainSelectorSchema,
  landing: ChainSelectorSchema,
  nameTemplate: z.string().max(200).optional(),
  keepLandingDirect: z.boolean().optional(),
  maxPairs: z.number().int().min(1).max(1000).optional(),
});

/**
 * 过滤规则的校验。
 *
 * 上限不是随手写的：`limit` 卡在 5000 是因为再多的节点会让生成的 YAML
 * 大到多数客户端无法处理；`pick` 卡在 5000 同理。正则长度 200 与
 * core/filter.ts 里的 ReDoS 防护上限保持一致 —— 两处必须对齐，
 * 否则用户会在这里通过校验、在那里被静默忽略。
 */
const FilterRuleSchema = z.object({
  sources: z.array(z.string()).optional(),
  regions: z.array(z.string().length(2)).optional(),
  types: z.array(ProxyTypeSchema).optional(),
  include: z.array(MatchExprSchema).max(50).optional(),
  exclude: z.array(MatchExprSchema).max(50).optional(),
  pick: z.array(z.string()).max(5000).optional(),
  pickMode: z.enum(['only', 'union']).optional(),
  useDefaultExclude: z.boolean().optional(),
  dedupe: z.enum(['off', 'server-port', 'fingerprint']).optional(),
  rename: z.array(RenameRuleSchema).max(20).optional(),
  sort: z.enum(['none', 'name', 'region', 'type', 'source']).optional(),
  limit: z.number().int().min(0).max(5000).optional(),
  chain: ChainRuleSchema.optional(),
});

const TARGET_VALUES = [
  'clash',
  'clash.meta',
  'shadowrocket',
  'v2ray',
] as const satisfies readonly EmitTarget[];

const TargetSchema = z.enum(TARGET_VALUES);

/**
 * `follow:<id>` 是带参数的，枚举表达不了，只能用 custom。
 * 这里显式给出泛型参数，让解析结果拿到 `UserinfoMode` 而不是 `string`。
 */
const UserinfoModeSchema = z.custom<UserinfoMode>(
  (v) => typeof v === 'string' && (v === 'sum' || v === 'off' || v.startsWith('follow:')),
  { message: 'userinfoMode 必须是 sum / off / follow:<订阅源 id>' },
);

const CreateSubscriptionSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  format: z.enum(['auto', 'clash', 'uri-list']).optional(),
  updateInterval: z.number().int().min(1).max(720).optional(),
  userAgent: z.string().max(200).nullable().optional(),
});

const UpdateSubscriptionSchema = CreateSubscriptionSchema.partial().extend({
  enabled: z.boolean().optional(),
});

const CreateProfileSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(300).optional(),
  icon: z.string().max(8).optional(),
  rule: FilterRuleSchema.optional(),
  defaultTarget: TargetSchema.optional(),
  userinfoMode: UserinfoModeSchema.optional(),
  updateInterval: z.number().int().min(1).max(720).optional(),
});

const UpdateProfileSchema = CreateProfileSchema.partial();

const CreateTokenFields = z.object({
  profileId: z.string().min(1),
  friendId: z.string().min(1).nullable().optional(),
  label: z.string().max(100).optional(),
  /** Unix 毫秒时间戳。省略表示永不过期。 */
  expiresAt: z.number().int().positive().nullable().optional(),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
  maxAccess: z.number().int().min(1).nullable().optional(),
  quotaWindowHours: z.number().int().min(1).max(720).nullable().optional(),
  sourceLimit: z.number().int().min(0).nullable().optional(),
});
const CreateTokenSchema = CreateTokenFields.refine((value) => !(value.expiresAt !== undefined && value.expiresInDays !== undefined), {
  message: 'expiresAt 与 expiresInDays 不能同时使用',
  path: ['expiresAt'],
});
const UpdateTokenSchema = CreateTokenFields.partial().refine((value: { expiresAt?: number | null; expiresInDays?: number }) => !(value.expiresAt !== undefined && value.expiresInDays !== undefined), {
  message: 'expiresAt 与 expiresInDays 不能同时使用',
  path: ['expiresAt'],
});

const FriendSchema = z.object({
  name: z.string().min(1).max(50),
  note: z.string().max(500).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, '颜色必须是 #RRGGBB 格式')
    .optional(),
});

const PreviewSchema = z.object({
  rule: FilterRuleSchema,
  target: TargetSchema.optional(),
  /** 预览时只渲染前若干个节点，避免大配置拖慢界面。 */
  limit: z.number().int().min(1).max(200).optional(),
});

// ─────────────────────────────────────────────────────────────
//  路由
// ─────────────────────────────────────────────────────────────

export function createAdminRoutes(ctx: AppContext): FastifyPluginAsync {
  return async function adminRoutes(app: FastifyInstance): Promise<void> {
    // 整个 /api 前缀下的请求统一鉴权
    app.addHook('preHandler', requireAdmin(ctx));

    /** 统一的校验失败响应。把 zod 的报错整理成人能看懂的形式。 */
    const badRequest = (issues: z.ZodIssue[]): { error: string; details: string[] } => ({
      error: '请求参数校验失败',
      details: issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`),
    });

    // ── 元信息 ────────────────────────────────────────
    // 供界面构建下拉选项。放在服务端而不是前端硬编码，
    // 这样新增协议或输出目标时前端不用同步改。
    app.get('/meta', async () => ({
      // 这两处 satisfies 是 schema 的**反向**对齐检查：core 层新增了协议或输出目标、
      // 而上面的 zod 清单忘了跟进时，编译期就会失败。
      // 没有这道检查的话，遗漏的表现是用户在界面上按新协议筛选时莫名收到 400。
      targets: (EMIT_TARGETS satisfies readonly z.infer<typeof TargetSchema>[]).map((t) => ({
        value: t,
        label: TARGET_LABELS[t],
      })),
      proxyTypes: PROXY_TYPES satisfies readonly z.infer<typeof ProxyTypeSchema>[],
      // 当前实际拥有的地区在前，全量地区表在后 —— 前端可以只显示前者
      presentRegions: ctx.nodes.distinctRegions().map((code) => ({
        code,
        name: regionNameZh(code),
        flag: regionToFlag(code),
      })),
      allRegions: knownRegionCodes().map((code) => ({
        code,
        name: regionNameZh(code),
        flag: regionToFlag(code),
      })),
      presentTypes: ctx.nodes.distinctTypes(),
      defaultExcludePatterns: DEFAULT_EXCLUDE_PATTERNS,
      publicBaseUrl: ctx.config.publicBaseUrl,
      trustProxy: ctx.config.trustProxy,
      shareSourceAlert: ctx.config.shareSourceAlert,
      nodePingIntervalHours: ctx.config.nodePingIntervalHours,
    }));

    // ── 首屏聚合 ──────────────────────────────────────
    // 一次请求拿到界面渲染所需的全部数据。
    // 分成五六个接口会让首屏出现明显的瀑布式加载。
    app.get('/state', async () => {
      // 全部节点只读一次。放在循环里读的话，每个配置文件都会触发一次
      // 全表扫描 + 每行一次 JSON.parse —— 5 个配置 × 2000 个节点就是
      // 一万次反序列化，而首屏每次刷新都要走这条路径。
      const allNodes = ctx.nodes.listAll();
      const friends = ctx.friends.list();
      const tokens = ctx.tokens.listAll();
      const snapshots = ctx.traffic.latestAll();

      const subscriptions = ctx.subscriptions.list().map((sub) => ({
        ...sub,
        traffic: snapshots.get(sub.id) ?? null,
      }));

      const profiles = ctx.profiles.list().map((profile) => ({
        ...profile,
        // 顺带算出每个配置文件当前命中多少节点 —— 这是界面上最有用的一个数字，
        // 它直接回答"我这条链接现在能给出多少节点"
        matchedNodes: applyFilter(allNodes, profile.rule).stats.output,
        outputNodes: expandChain(applyFilter(allNodes, profile.rule).nodes, profile.rule.chain).nodes.length,
        tokenCount: tokens.filter((t) => t.profileId === profile.id && !t.revoked).length,
      }));

      return {
        subscriptions,
        profiles,
        friends,
        tokens,
        totals: {
          subscriptions: subscriptions.length,
          nodes: allNodes.length,
          profiles: profiles.length,
          friends: friends.length,
        },
      };
    });

    // ── 订阅源 ────────────────────────────────────────
    app.get('/subscriptions', async () => ctx.subscriptions.list());

    app.post('/subscriptions', async (req, reply) => {
      const parsed = CreateSubscriptionSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(badRequest(parsed.error.issues));

      const created = ctx.subscriptions.create(parsed.data);
      // 创建后立即同步一次：用户添加订阅的意图就是"我要用它",
      // 让他再手动点一次同步是多余的一步
      const result = await ctx.sync.syncOne(created);
      return reply.code(201).send({
        subscription: ctx.subscriptions.get(created.id),
        sync: result,
      });
    });

    app.patch<{ Params: { id: string } }>('/subscriptions/:id', async (req, reply) => {
      const parsed = UpdateSubscriptionSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(badRequest(parsed.error.issues));

      const updated = ctx.subscriptions.update(req.params.id, parsed.data);
      if (!updated) return reply.code(404).send({ error: '订阅源不存在' });
      return updated;
    });

    app.delete<{ Params: { id: string } }>('/subscriptions/:id', async (req, reply) => {
      const ok = ctx.subscriptions.delete(req.params.id);
      if (!ok) return reply.code(404).send({ error: '订阅源不存在' });
      return reply.code(204).send();
    });

    app.post<{ Params: { id: string } }>('/subscriptions/:id/sync', async (req, reply) => {
      const sub = ctx.subscriptions.get(req.params.id);
      if (!sub) return reply.code(404).send({ error: '订阅源不存在' });
      return ctx.sync.syncOne(sub);
    });

    app.post('/sync', async () => {
      const results = await ctx.sync.syncAll();
      return {
        results,
        summary: {
          total: results.length,
          succeeded: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
        },
      };
    });

    // ── 节点 ──────────────────────────────────────────
    app.get('/nodes', async () => {
      // 只返回元信息，不含凭据 —— 见文件头部的说明
      const latestPings = ctx.pingHistory.latestAll();
      return ctx.nodes.listAll().map((node) => ({
        fingerprint: node.fingerprint,
        name: node.name,
        type: node.type,
        server: node.server,
        port: node.port,
        region: node.meta.region ?? null,
        sourceId: node.meta.sourceId,
        sourceName: node.meta.sourceName,
        tags: node.meta.tags,
        firstSeen: node.firstSeen,
        lastSeen: node.lastSeen,
        ping: latestPings.get(node.fingerprint) ?? null,
      }));
    });

    app.get<{ Params: { fingerprint: string } }>('/nodes/:fingerprint/uri', async (req, reply) => {
      // 一次只取一个节点的完整 URI。批量导出凭据不是这个接口的用途。
      const node = ctx.nodes.listAll().find((n) => n.fingerprint === req.params.fingerprint);
      if (!node) return reply.code(404).send({ error: '节点不存在' });

      ctx.logger.info('导出单个节点 URI', {
        fingerprint: node.fingerprint,
        type: node.type,
      });
      return { uri: emitUri(node) };
    });

    // 二维码与上面的 /uri 是同一类出口：都吐完整凭据，都一次一条。
    // 出码在本地算（src/core/qrcode.ts），不经任何第三方服务 ——
    // 这条链接等同于节点的访问凭证，交出去一份就少一分。
    app.get<{ Params: { fingerprint: string } }>('/nodes/:fingerprint/qrcode', async (req, reply) => {
      const node = ctx.nodes.listAll().find((n) => n.fingerprint === req.params.fingerprint);
      if (!node) return reply.code(404).send({ error: '节点不存在' });

      const uri = emitUri(node);
      if (uri === null) {
        return reply.code(422).send({ error: `${node.type} 暂不支持导出为 URI，无法生成二维码` });
      }

      const result = encodeQr(uri, { minEcc: 'M' });
      if (!result.ok) {
        // 给出**可操作**的下一步，而不是只说"太长了"
        return reply.code(422).send({
          error:
            `节点 URI 有 ${result.byteLength} 字节，超出可扫二维码的上限 ${result.capacity} 字节` +
            ` —— 通常是节点名过长。请用「复制 URI」手动导入，或在配置的重命名规则里缩短节点名。`,
        });
      }

      ctx.logger.info('生成节点二维码', {
        fingerprint: node.fingerprint,
        type: node.type,
        version: result.matrix.version,
        ecc: result.matrix.ecc,
      });
      // 响应体等同凭据，不该进磁盘缓存
      reply.header('cache-control', 'no-store');
      return {
        svg: renderQrSvg(result.matrix, { title: '节点二维码' }),
        version: result.matrix.version,
        ecc: result.matrix.ecc,
        size: result.matrix.size,
        byteLength: uri.length,
      };
    });

    app.get<{ Params: { fingerprint: string } }>('/nodes/:fingerprint/ping/history', async (req, reply) => {
      const node = ctx.nodes.listAll().find((item) => item.fingerprint === req.params.fingerprint);
      if (!node) return reply.code(404).send({ error: '节点不存在' });

      const retentionDays = 90;
      return {
        fingerprint: node.fingerprint,
        intervalHours: ctx.config.nodePingIntervalHours,
        retentionDays,
        snapshots: ctx.pingHistory.history(node.fingerprint, Date.now() - retentionDays * 86400_000),
      };
    });

    app.get<{ Params: { fingerprint: string } }>('/nodes/:fingerprint/ping', async (req, reply) => {
      const node = ctx.nodes.listAll().find((item) => item.fingerprint === req.params.fingerprint);
      if (!node) return reply.code(404).send({ error: '节点不存在' });

      const result = await ctx.nodePing.pingNode(node);
      ctx.logger.info('节点 TCP 连通性测试完成', {
        fingerprint: node.fingerprint,
        host: node.server,
        port: node.port,
        ok: result.ok,
        latencyMs: result.latencyMs,
        error: result.error,
      });
      return result;
    });

    // ── 配置文件 ──────────────────────────────────────
    app.get('/profiles', async () => ctx.profiles.list());

    app.post('/profiles', async (req, reply) => {
      const parsed = CreateProfileSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(badRequest(parsed.error.issues));
      return reply.code(201).send(ctx.profiles.create(parsed.data));
    });

    app.patch<{ Params: { id: string } }>('/profiles/:id', async (req, reply) => {
      const parsed = UpdateProfileSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(badRequest(parsed.error.issues));

      const updated = ctx.profiles.update(req.params.id, parsed.data);
      if (!updated) return reply.code(404).send({ error: '配置文件不存在' });
      return updated;
    });

    app.delete<{ Params: { id: string } }>('/profiles/:id', async (req, reply) => {
      const ok = ctx.profiles.delete(req.params.id);
      if (!ok) return reply.code(404).send({ error: '配置文件不存在' });
      // 关联 token 已被级联删除 —— 配置文件没了，指向它的链接自然应当失效
      return reply.code(204).send();
    });

    /**
     * 规则预览。
     *
     * 这是规则编辑器的核心支撑：用户改一条规则，立刻看到会选中哪些节点、
     * 各阶段过滤掉了多少、生成出来长什么样。**不需要先保存配置文件**，
     * 所以接受的是一份临时规则而不是 profile id。
     */
    app.post('/preview', async (req, reply) => {
      const parsed = PreviewSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(badRequest(parsed.error.issues));

      const rule: FilterRule = parsed.data.rule;
      // 用一个临时 profile 走完整的渲染路径，保证预览到的内容
      // 与客户端真正拉到的**完全一致** —— 否则预览就失去了意义
      const now = Date.now();
      const rendered = renderProfile(
        ctx,
        {
          id: '__preview__',
          name: '预览',
          description: '',
          icon: '👁',
          rule,
          defaultTarget: parsed.data.target ?? 'shadowrocket',
          userinfoMode: 'sum',
          updateInterval: 12,
          createdAt: now,
          updatedAt: now,
        },
        {
          explicitTarget: parsed.data.target,
          // 预览时不做 base64：一坨 base64 对人类没有任何信息量
          base64: false,
          limitOverride: parsed.data.limit ?? 50,
        },
      );

      return {
        stats: rendered.filterStats,
        chain: rendered.chain,
        warnings: rendered.warnings,
        skipped: rendered.skipped,
        target: rendered.target,
        // 命中的节点（元信息，不含凭据）
        nodes: rendered.nodes.slice(0, 200).map((n) => ({
          fingerprint: n.fingerprint,
          name: n.name,
          type: n.type,
          region: n.meta.region ?? null,
          sourceName: n.meta.sourceName,
          chained: Boolean(n.chain),
          via: n.chain?.viaName ?? null,
        })),
        // 生成结果的片段，让用户直观确认格式对不对
        bodyPreview: rendered.body.slice(0, 4000),
        bodyTruncated: rendered.body.length > 4000,
      };
    });

    // ── 订阅 token ────────────────────────────────────
    app.get('/tokens', async () => {
      const base = ctx.config.publicBaseUrl.replace(/\/+$/, '');
      return ctx.tokens.listAll().map((token) => ({
        ...token,
        // 直接把完整链接拼好返回，前端不用重复实现拼接逻辑
        url: `${base}/sub/${token.token}`,
      }));
    });

    app.post('/tokens', async (req, reply) => {
      const parsed = CreateTokenSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(badRequest(parsed.error.issues));

      if (!ctx.profiles.get(parsed.data.profileId)) {
        return reply.code(400).send({ error: '配置文件不存在' });
      }
      if (parsed.data.friendId && !ctx.friends.get(parsed.data.friendId)) {
        return reply.code(400).send({ error: '好友不存在' });
      }

      const token = ctx.tokens.create({
        ...parsed.data,
        expiresAt:
          parsed.data.expiresInDays !== undefined
            ? Date.now() + parsed.data.expiresInDays * 86400_000
            : parsed.data.expiresAt,
      });
      const base = ctx.config.publicBaseUrl.replace(/\/+$/, '');
      return reply.code(201).send({ ...token, url: `${base}/sub/${token.token}` });
    });

    app.get<{ Params: { token: string } }>('/tokens/:token/qrcode', async (req, reply) => {
      const record = ctx.tokens.get(req.params.token);
      if (!record) return reply.code(404).send({ error: 'token 不存在' });

      // 与 GET /tokens 用同一份拼接逻辑，唯一真源是 publicBaseUrl ——
      // 否则界面上显示的链接和二维码里的链接可能对不上
      const base = ctx.config.publicBaseUrl.replace(/\/+$/, '');
      // 订阅链接固定在 80 字节量级，用 Q 级纠错只多几个模块，
      // 换来屏幕反光、斜角拍摄下的容错，白拿的余量
      const result = encodeQr(`${base}/sub/${record.token}`, { minEcc: 'Q' });
      if (!result.ok) {
        return reply.code(422).send({ error: `${result.reason}。请检查 PUBLIC_BASE_URL 是否异常` });
      }

      ctx.logger.info('生成订阅链接二维码', {
        // 刻意不记 token 明文
        ref: tokenRef(record.token),
        profileId: record.profileId,
        version: result.matrix.version,
        ecc: result.matrix.ecc,
      });
      reply.header('cache-control', 'no-store');
      return {
        svg: renderQrSvg(result.matrix, { title: '订阅链接二维码' }),
        version: result.matrix.version,
        ecc: result.matrix.ecc,
        size: result.matrix.size,
      };
    });

    app.patch<{ Params: { token: string } }>('/tokens/:token', async (req, reply) => {
      const parsed = UpdateTokenSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(badRequest(parsed.error.issues));
      if (parsed.data.friendId && !ctx.friends.get(parsed.data.friendId)) {
        return reply.code(400).send({ error: '好友不存在' });
      }
      const patch = { ...parsed.data };
      delete patch.expiresInDays;
      const updated = ctx.tokens.update(req.params.token, {
        ...patch,
        expiresAt:
          parsed.data.expiresInDays !== undefined
            ? Date.now() + parsed.data.expiresInDays * 86400_000
            : parsed.data.expiresAt,
      });
      if (!updated) return reply.code(404).send({ error: 'token 不存在' });
      return updated;
    });

    app.post<{ Params: { token: string } }>('/tokens/:token/revoke', async (req, reply) => {
      const ok = ctx.tokens.revoke(req.params.token);
      if (!ok) return reply.code(404).send({ error: 'token 不存在' });
      ctx.logger.info('订阅 token 已吊销');
      return { revoked: true };
    });

    app.post<{ Params: { token: string } }>('/tokens/:token/rotate', async (req, reply) => {
      const existing = ctx.tokens.get(req.params.token);
      if (!existing) return reply.code(404).send({ error: 'token 不存在' });
      const body = z.object({ expiresInDays: z.number().int().min(1).max(3650).nullable().optional() }).safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send(badRequest(body.error.issues));
      if (body.data.expiresInDays === undefined && existing.expiresAt !== null && existing.expiresAt < Date.now()) {
        return reply.code(400).send({ error: '旧 token 已过期，请指定新的 expiresInDays 或 expiresInDays: null' });
      }
      const rotated = ctx.tokens.rotate(req.params.token, body.data);
      if (!rotated) return reply.code(404).send({ error: 'token 不存在' });
      ctx.logger.info('订阅 token 已轮换');
      const base = ctx.config.publicBaseUrl.replace(/\/+$/, '');
      return { ...rotated, url: `${base}/sub/${rotated.token}` };
    });

    app.delete<{ Params: { token: string } }>('/tokens/:token', async (req, reply) => {
      const ok = ctx.tokens.delete(req.params.token);
      if (!ok) return reply.code(404).send({ error: 'token 不存在' });
      return reply.code(204).send();
    });

    app.get<{ Params: { token: string } }>('/tokens/:token/access', async (req) => {
      return ctx.accessLog.listByToken(req.params.token, 100);
    });

    // ── 好友 ──────────────────────────────────────────
    app.get('/friends', async () => {
      // 30 天窗口。再长的窗口对"最近有没有在用"这个判断没有帮助。
      const since = Date.now() - 30 * 86400_000;
      const base = ctx.config.publicBaseUrl.replace(/\/+$/, '');

      return ctx.friends.list().map((friend) => {
        const tokens = ctx.tokens.listByFriend(friend.id);
        const summary = ctx.accessLog.summaryForFriend(friend.id, since);
        return {
          ...friend,
          tokens: tokens.map((t) => ({ ...t, url: `${base}/sub/${t.token}` })),
          // 全部是真实采集的数据。这里**没有**"估算用量"字段 ——
          // 好友的代理流量不经过我们，任何 GB 数字都只能是编的。
          access: summary,
        };
      });
    });

    app.post('/friends', async (req, reply) => {
      const parsed = FriendSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(badRequest(parsed.error.issues));
      return reply.code(201).send(ctx.friends.create(parsed.data));
    });

    app.patch<{ Params: { id: string } }>('/friends/:id', async (req, reply) => {
      const parsed = FriendSchema.partial().safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(badRequest(parsed.error.issues));

      const updated = ctx.friends.update(req.params.id, parsed.data);
      if (!updated) return reply.code(404).send({ error: '好友不存在' });
      return updated;
    });

    app.delete<{ Params: { id: string } }>('/friends/:id', async (req, reply) => {
      const ok = ctx.friends.delete(req.params.id);
      if (!ok) return reply.code(404).send({ error: '好友不存在' });
      // 注意：关联 token 不会被删除，只是解绑（friend_id 置 NULL）。
      // 删好友是"不再跟踪这个人"，不等于"立刻切断他的网"。
      // 要断网请显式吊销 token。
      return reply.code(204).send();
    });

    app.get<{ Params: { id: string } }>('/friends/:id/access', async (req, reply) => {
      if (!ctx.friends.get(req.params.id)) {
        return reply.code(404).send({ error: '好友不存在' });
      }
      return ctx.accessLog.listByFriend(req.params.id, 100);
    });

    // ── 流量 ──────────────────────────────────────────
    app.get('/traffic', async () => {
      const latest = ctx.traffic.latestAll();
      return ctx.subscriptions.list().map((sub) => ({
        subscriptionId: sub.id,
        name: sub.name,
        updateInterval: sub.updateInterval,
        lastSyncAt: sub.lastSyncAt,
        lastError: sub.lastError,
        traffic: latest.get(sub.id) ?? null,
      }));
    });

    app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
      '/traffic/:id/history',
      async (req, reply) => {
        if (!ctx.subscriptions.get(req.params.id)) {
          return reply.code(404).send({ error: '订阅源不存在' });
        }
        const days = Math.min(365, Math.max(1, Number.parseInt(req.query.days ?? '30', 10) || 30));
        return ctx.traffic.history(req.params.id, Date.now() - days * 86400_000);
      },
    );

    // ── 最近访问 ──────────────────────────────────────
    app.get('/access', async () => ctx.accessLog.listRecent(100));
  };
}
