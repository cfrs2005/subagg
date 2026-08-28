/**
 * IX 中转的管理 API（`/api/ix/*`）。
 *
 * 与 `routes/admin.ts`、`routes/sub.ts` 平级的一个 Fastify 插件，由 `app.ts` 注册
 * 在 `/api/ix` 前缀上（所以本文件里的路径都不带 `/ix` 那一段）。
 *
 * ## ⚠️ 鉴权必须由本插件自己挂
 *
 * Fastify 的 hook 是**按封装上下文**生效的：`admin.ts` 里那句
 * `app.addHook('preHandler', requireAdmin(ctx))` 只覆盖 admin 插件自己注册的路由，
 * 与前缀是不是同一个 `/api` 毫无关系。所以从 admin.ts 抽出来的这一组路由，
 * 必须在**本插件内**再挂一次 —— 少了这一句，九个 IX 路由会全部变成**公开**接口，
 * 而"能读能写中转商凭据状态、能删远端端口"的接口公开出去等于全盘失守。
 * （同一条机制也是 `app.ts` 里 `setErrorHandler` 必须先注册的原因。）
 * `test/ix-routes.test.ts` 的「十一个路由无 Bearer 一律 401」就是这条的绊线。
 *
 * ## 这一组的通用取舍
 *
 * 1. **凭据只进不出。** 明文经 POST/PATCH 进来即加密，响应里只有
 *    `hasCredentials` / `credentialBroken` 两个布尔（见 `providerView`）。
 * 2. **出站动作全部落在 services。** 路由只做校验、状态码与形状适配；
 *    probe / ensureMappings / refresh / removeMapping 是唯一会打平台的四个
 *    端点，其余全是本地 SQLite 同步读。
 * 3. **失败必须带可读原因。** IxService 的每个结果对象都自带中文
 *    `error`/`detail`/`warnings`，这里的职责是别把它们吞掉 ——
 *    返回一个空 `results` 而不说为什么，在界面上等于"点了没反应"。
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { decryptSecret, deriveKey, encryptSecret } from '../../core/secret.js';
import type { IxAuthMode, IxProvider, IxProviderPatch } from '../../db/repo/ix.js';
import { requireAdmin } from '../auth.js';
import { badRequest } from './validation.js';

// ─────────────────────────────────────────────────────────────
//  校验 schema
// ─────────────────────────────────────────────────────────────

/** **正向**对齐：清单里不能出现领域类型不认识的认证模式（手法同 admin.ts 的 ProxyType）。 */
const IX_AUTH_MODE_VALUES = ['api-key', 'login'] as const satisfies readonly IxAuthMode[];

/**
 * 导出给 `admin.ts` 的 `/meta` 用：那里把界面文案表的键集合再 `satisfies` 一遍这个
 * 枚举，构成**反向**对齐（领域类型加了成员而 schema 忘了跟进 → 编译期失败）。
 * 一份枚举两处引用，别在 admin.ts 里另写一份。
 */
export const IxAuthModeSchema = z.enum(IX_AUTH_MODE_VALUES);

/**
 * 一次 `POST /ix/mappings` 最多接受多少个指纹。
 *
 * 上限的两条理由都很实在：① 出站放大 —— 每个指纹最多三次外部请求
 * （认领 → 创建 → 回读），50 个就是 150 次，足够撞上平台限流；
 * ② 端口配额是**线路级的 30 个**，一次勾超过 50 个几乎必然是误操作
 * （多选了整页节点），而误操作的代价是真金白银的配额被建满。
 *
 * 前端从 `/meta` 的 `ixMaxFingerprints` 取同一个数（所以这里要导出给 admin.ts）——
 * 与 `MAX_REGEX_LENGTH` 同一条教训：两处各写一份，迟早出现"这边过了校验、那边被拒"。
 */
export const IX_MAX_FINGERPRINTS = 50;

/**
 * 中转商的录入表单。
 *
 * **明文凭据只在这一个方向出现**：进来即加密落库，任何响应里都不会再出现
 * （见下面的 `providerView`）。
 *
 * `null` 表示**清空**已存的凭据，`undefined`（不传）表示不动那一列 ——
 * 两者必须能区分，否则"只改个名字"的 PATCH 会把密钥抹掉。
 * `.min(1)` 挡掉空串：让"手滑提交空输入框"落到校验失败上，
 * 而不是变成一次静默的凭据清空。
 */
const CreateIxProviderSchema = z.object({
  name: z.string().min(1).max(100),
  baseUrl: z.string().url().max(500),
  authMode: IxAuthModeSchema,
  apiKey: z.string().min(1).max(1000).nullable().optional(),
  username: z.string().min(1).max(200).nullable().optional(),
  password: z.string().min(1).max(500).nullable().optional(),
  defaultLineId: z.number().int().positive().nullable().optional(),
  enableUdp: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const UpdateIxProviderSchema = CreateIxProviderSchema.partial();

const EnsureIxMappingsSchema = z.object({
  providerId: z.string().min(1).max(64).optional(),
  fingerprints: z.array(z.string().min(1).max(128)).min(1).max(IX_MAX_FINGERPRINTS),
});

const CreateIxRelaysSchema = z.object({
  providerId: z.string().min(1).max(64),
  sourceFingerprints: z.array(z.string().min(1).max(128)).min(1).max(IX_MAX_FINGERPRINTS),
});

const IxRefreshSchema = z.object({
  providerId: z.string().min(1).max(64).optional(),
});

/**
 * 查询串里的布尔值。
 *
 * 刻意用枚举而不是"等于 'true' 就是真、其余当假"：`?deleteRemote=yes` 写错时，
 * 后者会**静默**跳过远端删除 —— 用户以为端口删了，实际它继续占着线路配额，
 * 而界面上再也看不到那条映射。这类失败必须响，所以让它 400。
 */
const BoolQuerySchema = z.enum(['true', 'false', '1', '0']).optional();

const DeleteIxMappingQuerySchema = z.object({
  providerId: z.string().min(1).max(64).optional(),
  deleteRemote: BoolQuerySchema,
});

const IxMappingsQuerySchema = z.object({
  providerId: z.string().min(1).max(64).optional(),
});

function isTruthyQuery(value: 'true' | 'false' | '1' | '0' | undefined): boolean {
  return value === 'true' || value === '1';
}

/** provider id 的短引用。id 是 UUID，不是凭据，可以进日志。 */
function ixRef(id: string): string {
  return id.slice(0, 8);
}

/**
 * `quota_json` → 对象。
 *
 * 解不开就给 null 而不是把原文字符串塞给前端：那一列是我们自己写进去的
 * JSON，解析失败意味着数据被手工改过，此时"没有快照"比"半个快照"诚实。
 */
function parseQuota(raw: string | null): unknown {
  if (raw === null || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

type ProviderPick = { ok: true; id: string } | { ok: false; reason: string };

// ─────────────────────────────────────────────────────────────
//  路由
// ─────────────────────────────────────────────────────────────

export function createIxRoutes(ctx: AppContext): FastifyPluginAsync {
  return async function ixRoutes(app: FastifyInstance): Promise<void> {
    // 见文件头：hook 按封装上下文生效，admin 插件那句挂不到这里。删掉这行 =
    // 十一个 IX 路由全部公开。
    app.addHook('preHandler', requireAdmin(ctx));

    // ── IX 凭据的加解密（只在本文件内部用，明文绝不出门）──────
    //
    // `deriveKey` 是 scrypt（刻意慢），所以**懒派生一次**存在插件闭包里：
    // 没用 IX 中转的部署一次都不派生，用了的也只在第一次写/读凭据时付这笔成本。
    //
    // 债务：`context.ts` 装配 IxService 时已经派生过同一把密钥，但没挂到
    // AppContext 上，这里拿不到。日后把它提上去就能删掉这两行。
    let cachedKey: Buffer | null = null;
    const credentialKey = (): Buffer => (cachedKey ??= deriveKey(ctx.config.adminToken));

    /** 明文 → 密文。`undefined` 原样透传（= 不改那一列），`null` 表示清空。 */
    const sealSecret = (plain: string | null | undefined): string | null | undefined =>
      plain === undefined || plain === null ? plain : encryptSecret(plain, credentialKey());

    /**
     * "存了凭据没有"与"存的还解得开吗"。
     *
     * 刻意**不**走 `ctx.ix.clientFor()`：那个方法在解密失败时会写 `last_error`
     * 并记一条 warn 日志 —— 而这是列表接口，每次刷新界面都会调，
     * GET 不该产生写与日志。判据只有一条：把该模式对应的那列解一次。
     */
    const credentialState = (provider: IxProvider): { has: boolean; broken: boolean } => {
      const cipher = provider.authMode === 'api-key' ? provider.apiKeyEnc : provider.passwordEnc;
      if (cipher === null || cipher === '') return { has: false, broken: false };
      try {
        decryptSecret(cipher, credentialKey());
        return { has: true, broken: false };
      } catch {
        // 轮换过 ADMIN_TOKEN 的库里每个 provider 都会走到这里 —— 预期状态，不是异常。
        // 界面据此提示"需重新录入"，关联 IX 节点不可用，服务本身不崩。
        return { has: true, broken: true };
      }
    };

    /**
     * provider → 响应体。
     *
     * **逐字段显式列出，绝不 spread `IxProvider`。** 那个对象里有
     * `apiKeyEnc` / `passwordEnc` / `jwtEnc` 三列密文，spread 一次就把它们
     * 送进了每个打开界面的浏览器 —— 而且是每次刷新都送一遍。
     * 密文出不出门与"能不能解开"无关：它是凭据的可离线爆破形态。
     */
    const providerView = (provider: IxProvider) => {
      const credential = credentialState(provider);
      return {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        authMode: provider.authMode,
        enabled: provider.enabled,
        enableUdp: provider.enableUdp,
        defaultLineId: provider.defaultLineId,
        // 平台侧用户名是唯一可以外露的凭据相关字段（它不是秘密，而界面上
        // 必须能区分"这条录的是哪个账号"）
        username: provider.username,
        hasCredentials: credential.has,
        credentialBroken: credential.broken,
        lastProbeAt: provider.lastProbeAt,
        lastError: provider.lastError,
        quota: parseQuota(provider.quotaJson),
        mappingCount: ctx.ixMappings.count(provider.id),
        createdAt: provider.createdAt,
        updatedAt: provider.updatedAt,
      };
    };

    /**
     * 决定这次操作落在哪个 provider 上。
     *
     * 显式给了 id 就必须真实存在（拼错 id 静默落到默认 provider，会把端口
     * 建到另一个账号上）；没给就复用 services 层那份唯一的默认选择逻辑
     * （`resolveProvider` 是同步纯本地读，不出站）。
     */
    const pickProvider = (raw?: string): ProviderPick => {
      if (raw !== undefined && raw !== '') {
        return ctx.ixProviders.get(raw)
          ? { ok: true, id: raw }
          : { ok: false, reason: '中转商不存在（可能已被删除）' };
      }
      const resolution = ctx.ix.resolveProvider();
      return resolution.provider
        ? { ok: true, id: resolution.provider.id }
        : { ok: false, reason: resolution.reason ?? '没有可用的中转商' };
    };

    app.get('/providers', async () => ({
      providers: ctx.ixProviders.list().map(providerView),
    }));

    app.post('/providers', async (req, reply) => {
      const parsed = CreateIxProviderSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(badRequest(parsed.error.issues));

      const { apiKey, password, ...rest } = parsed.data;
      const created = ctx.ixProviders.create({
        ...rest,
        apiKeyEnc: sealSecret(apiKey),
        passwordEnc: sealSecret(password),
      });

      ctx.logger.info('IX：已录入中转商', {
        endpoint: 'POST /api/ix/providers',
        providerRef: ixRef(created.id),
        // 字段名不能带 authMode / hasCredentials 之类的字样：logger 的敏感键
        // 判定是**大小写不敏感的子串**匹配，`authMode` 命中 'auth'、
        // `hasCredentials` 命中 'credential'，双双被打成 '***' —— 日志白记。
        mode: created.authMode,
        stored: credentialState(created).has,
      });
      return reply.code(201).send({ provider: providerView(created) });
    });

    app.patch<{ Params: { id: string } }>('/providers/:id', async (req, reply) => {
      const parsed = UpdateIxProviderSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(badRequest(parsed.error.issues));
      if (!ctx.ixProviders.get(req.params.id)) {
        return reply.code(404).send({ error: '中转商不存在' });
      }

      const { apiKey, password, ...rest } = parsed.data;
      const patch: IxProviderPatch = { ...rest };
      // undefined = 不动那一列；null = 清空。两者必须区分，否则"只改个名字"
      // 的 PATCH 会顺手把密钥抹掉。
      if (apiKey !== undefined) patch.apiKeyEnc = sealSecret(apiKey);
      if (password !== undefined) patch.passwordEnc = sealSecret(password);

      // 换了身份就必须丢掉缓存的 JWT —— 它是**旧账号**的会话。留着的后果是
      // 把 provider 指向另一个账号之后，下一轮同步仍用旧账号建端口：
      // 端口建在别人的配额里，而界面上一切正常。
      if (patch.username !== undefined || patch.passwordEnc !== undefined || patch.authMode !== undefined) {
        patch.jwtEnc = null;
        patch.jwtExpiresAt = null;
      }

      const updated = ctx.ixProviders.update(req.params.id, patch);
      if (!updated) return reply.code(404).send({ error: '中转商不存在' });

      ctx.logger.info('IX：中转商已更新', {
        endpoint: 'PATCH /api/ix/providers/:id',
        providerRef: ixRef(updated.id),
        mode: updated.authMode,
        enabled: updated.enabled,
        // 拨了总闸、换了凭据都要能在日志里看出来，但不能记内容
        rotated: patch.apiKeyEnc !== undefined || patch.passwordEnc !== undefined,
      });
      return { provider: providerView(updated) };
    });

    app.delete<{ Params: { id: string } }>('/providers/:id', async (req, reply) => {
      const relayCount = ctx.ixMappings.count(req.params.id);
      if (relayCount > 0) {
        return reply.code(409).send({
          error: `该中转商仍有 ${relayCount} 个 IX 节点。请先在节点列表删除它们，再删除中转商。`,
          deleted: false,
        });
      }
      const deleted = ctx.ixProviders.delete(req.params.id);
      if (!deleted) return reply.code(404).send({ error: '中转商不存在', deleted: false });

      ctx.logger.info('IX：中转商已删除', {
        endpoint: 'DELETE /api/ix/providers/:id',
        providerRef: ixRef(req.params.id),
        droppedMappings: 0,
      });
      return { deleted: true };
    });

    app.post<{ Params: { id: string } }>('/providers/:id/probe', async (req, reply) => {
      const existing = ctx.ixProviders.get(req.params.id);
      if (!existing) return reply.code(404).send({ error: '中转商不存在' });

      // 这是本组四个会真打平台的端点之一。probe 自己不抛 —— 失败以
      // `{ok:false, error}` 返回，所以这里不需要 try/catch。
      const probe = await ctx.ix.probe(req.params.id);
      // probe 会写 quota_json / last_probe_at / last_error，所以**重新读一遍**：
      // 返回进来时那份旧对象，会让界面上的额度快照永远差一次刷新。
      const fresh = ctx.ixProviders.get(req.params.id) ?? existing;

      ctx.logger.info('IX：中转商连接测试', {
        endpoint: 'POST /api/ix/providers/:id/probe',
        providerRef: ixRef(req.params.id),
        ok: probe.ok,
        lines: probe.lines.length,
      });
      return { probe, provider: providerView(fresh) };
    });

    app.get<{ Querystring: { providerId?: string } }>('/mappings', async (req, reply) => {
      const parsed = IxMappingsQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send(badRequest(parsed.error.issues));
      const providerId = parsed.data.providerId;
      if (providerId !== undefined && !ctx.ixProviders.get(providerId)) {
        return reply.code(404).send({ error: '中转商不存在' });
      }

      // 节点名按指纹补上：界面要回答"这条映射是哪个节点"，只给一串指纹没法用。
      const nodeNames = new Map(ctx.nodes.listAll().map((node) => [node.fingerprint, node.name]));
      const mappings = ctx.ixMappings.list(providerId).map((mapping) => ({
        // IxMapping 里没有任何凭据（全是地址、状态、计数与错误文案），
        // 所以这里可以整体展开 —— 与 providerView 的处理不同，理由就在这句。
        ...mapping,
        // null 不是缺陷而是信号：节点已从上游消失，这条映射正在走向孤儿。
        nodeName: nodeNames.get(mapping.fingerprint) ?? null,
      }));

      const warnings: string[] = [];
      const orphans = mappings.filter((m) => m.state === 'orphan').length;
      if (orphans > 0) {
        warnings.push(
          `有 ${orphans} 条映射已标为孤儿：对应节点已从上游消失，远端端口仍在占用线路配额` +
            '（按既定策略不会自动删除）。下一步：确认不再需要就逐条删除并勾选"同时删除远端端口"。',
        );
      }
      const detached = mappings.filter((m) => m.nodeName === null).length;
      if (detached > orphans) {
        warnings.push(
          `有 ${detached} 条映射在本地节点表里找不到对应节点（还没累到孤儿阈值）。` +
            '下一步：先同步订阅源确认节点是否真的消失了。',
        );
      }
      return { mappings, warnings };
    });

    app.post('/mappings', async (req, reply) => {
      const parsed = EnsureIxMappingsSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(badRequest(parsed.error.issues));

      const result = await ctx.ix.ensureMappings(parsed.data.providerId, parsed.data.fingerprints);
      // 逐节点结果。`detail` → `reason`：service 侧那份文案本来就是
      //"原因 + 下一步"，直接透传，不在这里另写一套（两套文案必然长歪）。
      // undefined 的可选字段会在 JSON 序列化时自然消失。
      const results = result.items.map((item) => ({
        fingerprint: item.fingerprint,
        outcome: item.outcome,
        remotePortId: item.remotePortId,
        entryHost: item.entryHost,
        entryPort: item.entryPort,
        relayFingerprint: item.relayFingerprint,
        relayName: item.relayName,
        reason: item.detail,
      }));

      if (result.error !== undefined) {
        // 整体失败（连 provider / 客户端 / 线路都没拿到）：**不能**回 200 空 results，
        // 那在界面上等于"点了没反应"。原因必须带出去。
        return reply.code(400).send({ error: result.error, results, warnings: result.warnings });
      }

      ctx.logger.info('IX：批量建立映射', {
        endpoint: 'POST /api/ix/mappings',
        providerRef: result.providerId ? ixRef(result.providerId) : null,
        requested: parsed.data.fingerprints.length,
        created: results.filter((r) => r.outcome === 'created').length,
        claimed: results.filter((r) => r.outcome === 'claimed').length,
        failed: results.filter((r) => r.outcome === 'failed').length,
      });
      return { results, warnings: result.warnings };
    });

    app.post('/relays', async (req, reply) => {
      const parsed = CreateIxRelaysSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(badRequest(parsed.error.issues));
      const provider = ctx.ixProviders.get(parsed.data.providerId);
      if (!provider) {
        return reply.code(404).send({ error: '中转商不存在' });
      }
      if (!provider.enabled) {
        return reply.code(409).send({ error: '该 IX 通道已关闭，请先启用后再生成节点。' });
      }

      const result = await ctx.ix.ensureMappings(parsed.data.providerId, parsed.data.sourceFingerprints);
      const relays = result.items.map((item) => ({
        sourceFingerprint: item.fingerprint,
        relayFingerprint: item.relayFingerprint,
        relayName: item.relayName,
        outcome: item.outcome,
        remotePortId: item.remotePortId,
        entryHost: item.entryHost,
        entryPort: item.entryPort,
        reason: item.detail,
      }));
      if (result.error !== undefined) {
        return reply.code(400).send({ error: result.error, relays, warnings: result.warnings });
      }
      ctx.logger.info('IX：批量生成派生节点', {
        endpoint: 'POST /api/ix/relays',
        providerRef: ixRef(parsed.data.providerId),
        requested: parsed.data.sourceFingerprints.length,
        created: relays.filter((relay) => relay.outcome === 'created').length,
        claimed: relays.filter((relay) => relay.outcome === 'claimed').length,
        failed: relays.filter((relay) => relay.outcome === 'failed').length,
      });
      return reply.code(201).send({ relays, warnings: result.warnings });
    });

    app.delete<{ Params: { relayFingerprint: string } }>('/relays/:relayFingerprint', async (req, reply) => {
      const result = await ctx.ix.removeRelay(req.params.relayFingerprint);
      if (!result.ok) {
        return reply.code(result.error?.includes('不存在') ? 404 : 409).send({
          error: result.error ?? 'IX 节点删除失败',
          removed: false,
          remoteDeleted: false,
          warnings: result.warnings,
        });
      }
      return {
        removed: result.removedLocal,
        remoteDeleted: result.remoteDeleted,
        warnings: result.warnings,
      };
    });

    app.delete<{
      Params: { fingerprint: string };
      Querystring: { providerId?: string; deleteRemote?: string };
    }>('/mappings/:fingerprint', async (req, reply) => {
      const parsed = DeleteIxMappingQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send(badRequest(parsed.error.issues));
      const picked = pickProvider(parsed.data.providerId);
      if (!picked.ok) return reply.code(400).send({ error: picked.reason });

      const deleteRemote = isTruthyQuery(parsed.data.deleteRemote);
      const result = await ctx.ix.removeMapping(picked.id, req.params.fingerprint, { deleteRemote });

      // 三种"不完全成功"都在这里汇成一句可读的话：远端端口留着、远端删失败、
      // 映射本来就不存在。**不静默**是硬要求 —— 少了这句，远端删失败会表现成
      // 一次干净的删除，而那个端口从此永远占着配额、界面上却看不到。
      const warning = [...result.warnings, ...(result.error !== undefined ? [result.error] : [])].join('；');

      ctx.logger.info('IX：删除映射', {
        endpoint: 'DELETE /api/ix/mappings/:fingerprint',
        providerRef: ixRef(picked.id),
        fingerprint: req.params.fingerprint,
        deleteRemote,
        ok: result.ok,
        remoteDeleted: result.remoteDeleted,
      });
      return {
        removed: result.removedLocal,
        remoteDeleted: result.remoteDeleted,
        ...(warning !== '' ? { warning } : {}),
      };
    });

    app.post('/refresh', async (req, reply) => {
      const parsed = IxRefreshSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send(badRequest(parsed.error.issues));

      const providerId = parsed.data.providerId;
      const warnings: string[] = [];
      let results;
      if (providerId !== undefined) {
        if (!ctx.ixProviders.get(providerId)) {
          return reply.code(404).send({ error: '中转商不存在' });
        }
        results = [await ctx.ix.refresh(providerId)];
      } else {
        // 不指定就同步所有**启用中**的 provider（refreshAll 内部串行，
        // 多账号并发出站只会更快撞上平台限流）。
        results = await ctx.ix.refreshAll();
        if (results.length === 0) {
          warnings.push(
            '没有启用中的中转商，本次同步什么都没做。' +
              '下一步：到「IX 中转」页录入并启用一个中转商，或检查全局总闸是不是关着。',
          );
        }
      }

      ctx.logger.info('IX：状态同步（手动触发）', {
        endpoint: 'POST /api/ix/refresh',
        providers: results.length,
        ok: results.every((r) => r.ok),
        orphaned: results.reduce((sum, r) => sum + r.orphaned, 0),
      });
      return { results, warnings };
    });
  };
}
