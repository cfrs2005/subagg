/**
 * IX 中转编排：把「本地节点」与「远端转发端口」对齐。
 *
 * 定位：services 层唯一知道"平台状态"与"本地映射"如何互相翻译的地方。
 * 上面是路由与调度器（发起动作），下面是 `ix-client.ts`（出站）与
 * `db/repo/ix.ts`（纯 DAO）。
 *
 * ## 两条不可动摇的分工
 *
 * 1. **节点目录与渲染热路径绝不出站。** `relayViews()` 只读本地 SQLite ——
 *    平台挂了、限流了、JWT 过期了，订阅仍可使用最后一次入口。
 *    所有 `async` 方法都只从管理路由或调度器进入，永不出现在 `/sub/:token` 上。
 * 2. **`state` 与 `IxPortStatus` 不是同一个枚举。** DB 里 `state` 和
 *    `suspended` 是两列，core 的 `IxPortStatus` 是一个五态枚举。
 *    翻译只发生在本文件的 `statusFor()`，别在别处再写一遍 ——
 *    只看 `state` 会把平台上已停用的端口当可用拿去改写，
 *    症状是整批节点连不上而且无从归因。
 *
 * ## 失败口径：照 `sync.ts` 的"失败时保留旧数据"
 *
 * 平台抽风是常态。所以：单个节点失败只落到那条映射的 `last_error` 并继续
 * 处理其余节点；解密失败标记 provider 需重新录入并优雅降级；
 * 远端端口消失只标 `state='error'`，绝不删本地映射（删了就再也认不回来了）。
 * 孤儿只标记、**绝不自动删远端端口**（用户已明确决策）。
 */

import {
  buildIxRelayNode,
  checkIxSafety,
  type IxEntry,
  type IxEntryMap,
  type IxPortStatus,
} from '../core/ix.js';
import { deriveIxRelayFingerprint } from '../core/fingerprint.js';
import type { ProxyNode, ProxyType } from '../core/types.js';
import { decryptSecret, encryptSecret, isSecretDecryptError } from '../core/secret.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { NodeRepo } from '../db/repo/nodes.js';
import type {
  IxMapping,
  IxMappingPatch,
  IxMappingRepo,
  IxProvider,
  IxProviderRepo,
} from '../db/repo/ix.js';
import { IxClient, type IxAuth } from './ix-client.js';
import {
  describeError,
  mappingPatchFromPort,
  providerRef,
  targetOf,
  type IxPlatformClient,
} from './ix-mapping.js';
import { runEnsureMappings, type IxEnsureResult } from './ix-ensure.js';
import { runProbe, type IxProbeResult } from './ix-probe.js';
import type { IxPort, IxSession } from './ix-protocol.js';

/**
 * probe / ensure 两条链路的返回结构住在各自的实现文件里，但它们是
 * `IxService` 方法的返回类型 —— 也就是本模块公开 API 的一部分，所以在这里转出。
 * 下游（路由、测试）继续从 `services/ix.js` import，不必知道内部怎么分文件。
 */
export type { IxPlatformClient } from './ix-mapping.js';
export type { IxEnsureItem, IxEnsureOutcome, IxEnsureResult } from './ix-ensure.js';
export type { IxProbeLine, IxProbeResult } from './ix-probe.js';

// ─────────────────────────────────────────────────────────────
//  依赖
// ─────────────────────────────────────────────────────────────

export interface IxDeps {
  config: Config;
  logger: Logger;
  providers: IxProviderRepo;
  mappings: IxMappingRepo;
  /** 只读：判断"这个指纹还在不在上游"（孤儿判定）与取原始地址。 */
  nodes: NodeRepo;
  /**
   * 凭据加解密密钥。由 `context.ts` 从 `ADMIN_TOKEN` 派生一次往下传 ——
   * core 零 IO，`deriveKey` 不读环境变量，密钥从哪来是装配层的事。
   */
  secretKey: Buffer;
  /** 造客户端。默认造真的 `IxClient`；测试注入替身。 */
  createClient?: (provider: IxProvider, auth: IxAuth) => IxPlatformClient;
  now?: () => number;
}

// ─────────────────────────────────────────────────────────────
//  返回结构
// ─────────────────────────────────────────────────────────────

export interface IxProviderResolution {
  provider?: IxProvider;
  /** 可直接展示给用户的提示（例如多 provider 时的 tie-break 说明）。 */
  warnings: string[];
  /** 解析不到时的可读原因。`provider` 为 undefined 时必有。 */
  reason?: string;
}

export type IxClientResolution =
  | { ok: true; client: IxPlatformClient }
  | {
      ok: false;
      reason: string;
      /** true = 凭据本身的问题（缺失或解不开），需要用户去重新录入。 */
      credentialProblem: boolean;
    };

export interface IxRefreshResult {
  ok: boolean;
  providerId?: string;
  /** 检查过的本地映射数。 */
  checked: number;
  /** 从远端刷到新状态的映射数。 */
  updated: number;
  /** 本轮从平台已有端口中自动发现并认领的本地映射数。 */
  discovered: number;
  /** 远端端口已消失的映射数。 */
  missingRemote: number;
  /** 本轮新标成孤儿的映射数。 */
  orphaned: number;
  /** 节点回来了、missing 计数被清零的映射数。 */
  recovered: number;
  warnings: string[];
  error?: string;
}

export interface IxRemoveResult {
  ok: boolean;
  removedLocal: boolean;
  remoteDeleted: boolean;
  /** 远端仍然存在的端口 id。如实给出，便于人工去平台上收拾。 */
  remotePortId?: number;
  warnings: string[];
  error?: string;
}

export type IxRelayState = 'active' | 'stale' | 'pending' | 'unavailable';

export interface IxRelayView {
  fingerprint: string;
  name: string;
  type: ProxyType;
  server: string;
  port: number;
  region: string | null;
  sourceId: string;
  sourceName: string;
  tags: string[];
  firstSeen: number;
  lastSeen: number;
  originFingerprint: string;
  providerId: string;
  relayState: IxRelayState;
  relayError: string | null;
  node?: ProxyNode;
}

// ─────────────────────────────────────────────────────────────
//  常量
// ─────────────────────────────────────────────────────────────

/** 凭据解不开时那句报错的标志性片段。`isDecryptFailureNote` 靠它回认。 */
const DECRYPT_FAILURE_MARK = '凭据无法解密';

const NEXT_STEP_RELOGIN = '下一步：点该中转商的「编辑」重新录入账号密码或 API Key。';

/**
 * 判断一条 `last_error` 是不是"凭据解不开"。
 *
 * 用途只有一个：凭据重新录入后，把这条已经不成立的报错抹掉。
 * 文案匹配确实不优雅，但产生处只有 `clientFor` 一个，且 DB 里
 * `last_error` 就一个字符串列 —— 为给错误分类单开一列不值得一次迁移。
 * 改那句文案时记得这里跟着改（`DECRYPT_FAILURE_MARK` 是唯一的耦合点）。
 */
function isDecryptFailureNote(note: string): boolean {
  return note.includes(DECRYPT_FAILURE_MARK);
}

// ─────────────────────────────────────────────────────────────
//  纯映射：DB 行 ↔ 平台端口 ↔ core 的 IxEntry
// ─────────────────────────────────────────────────────────────

/**
 * `state` + `suspended` → core 的 `IxPortStatus`。**全系统只有这一处做这个翻译。**
 *
 * `state==='active'` 时必须再看 `suspended` 那一列：DB 的 `state` 说的是
 * "我们这条映射健不健康"，`suspended` 说的是"平台把这个端口挂起了没有"，
 * 两件事。只看 `state` 就会把已挂起的端口当 active 拿去改写地址，
 * 而那批节点会全部连不上、且用户从界面上看不出任何异常。
 *
 * `error`/`orphan` 刻意不映射成 `active` 之外的新语义：
 * - `error` → `'unknown'`：我们不知道它还能不能用，派生目录会标记为不可用。
 * - `orphan` → `'expired'`：节点已从上游消失，这条入口是过期的历史遗留。
 */
function statusFor(mapping: IxMapping): IxPortStatus {
  switch (mapping.state) {
    case 'active':
      return mapping.suspended ? 'suspended' : 'active';
    case 'pending':
      return 'pending';
    case 'error':
      return 'unknown';
    case 'orphan':
      return 'expired';
  }
}

// ── refresh 的文案 ──────────────────────────────────────

const DETAIL_REMOTE_GONE =
  '远端已经没有这条映射对应的转发端口了（可能在平台上被删除或过期）。' +
  '下一步：在「IX 中转」页重新为该节点建端口，或删除 IX 节点并明确使用原节点。';

function detailOrphan(missing: number): string {
  return (
    `该节点已连续 ${missing} 轮同步没有出现在任何订阅源里，标为孤儿。` +
    '远端端口**没有被自动删除**（仍在占用线路配额）。' +
    '下一步：确认不再需要就在「IX 中转」页删除这条映射并勾选"同时删除远端端口"。'
  );
}

// ─────────────────────────────────────────────────────────────
//  服务
// ─────────────────────────────────────────────────────────────

export class IxService {
  constructor(private readonly deps: IxDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Project durable IX mappings into user-visible relay nodes.
   *
   * Active and stale relays include a complete ProxyNode. Pending/unavailable relays
   * remain visible as metadata but cannot be emitted, copied or pinged. This prevents
   * an `IX_` name from silently falling back to the origin address.
   */
  relayViews(): IxRelayView[] {
    const origins = new Map(this.deps.nodes.listAll().map((node) => [node.fingerprint, node]));
    const providers = new Map(this.deps.providers.list().map((provider) => [provider.id, provider]));
    const views: IxRelayView[] = [];

    for (const mapping of this.deps.mappings.list()) {
      const origin = origins.get(mapping.fingerprint);
      const provider = providers.get(mapping.providerId);
      if (!origin || !provider) continue;

      const fingerprint = deriveIxRelayFingerprint(provider.id, origin.fingerprint);
      const sourceId = `ix:${provider.id}`;
      const sourceName = `IX · ${provider.name}`;
      const base: IxRelayView = {
        fingerprint,
        name: `IX_${origin.name}`,
        type: origin.type,
        server: mapping.entryHost ?? mapping.targetHost,
        port: mapping.entryPort ?? mapping.targetPort,
        region: origin.meta.region ?? null,
        sourceId,
        sourceName,
        tags: [...new Set([...origin.meta.tags, 'ix-relay'])],
        firstSeen: mapping.createdAt,
        lastSeen: mapping.updatedAt,
        originFingerprint: origin.fingerprint,
        providerId: provider.id,
        relayState: 'unavailable',
        relayError: mapping.lastError ?? mapping.syncError,
      };

      if (mapping.state === 'pending' || mapping.entryHost === null || mapping.entryPort === null) {
        views.push({ ...base, relayState: 'pending' });
        continue;
      }
      if (!provider.enabled) {
        views.push({ ...base, relayError: 'IX 提供商已停用。' });
        continue;
      }
      if (mapping.state !== 'active' || mapping.suspended || mapping.syncError !== null) {
        const reason = mapping.suspended
          ? 'IX 端口已被平台挂起。'
          : mapping.syncError ?? mapping.lastError ?? 'IX 端口当前不可用。';
        views.push({ ...base, relayError: reason });
        continue;
      }

      const built = buildIxRelayNode(
        origin,
        provider,
        {
          entryHost: mapping.entryHost,
          entryPort: mapping.entryPort,
          status: 'active',
          ...(mapping.entryUdp !== null ? { udp: mapping.entryUdp } : {}),
          ...(mapping.lineName !== null ? { label: mapping.lineName } : {}),
        },
      );
      if (!built.ok) {
        views.push({ ...base, relayError: built.detail });
        continue;
      }

      views.push({
        ...base,
        relayState: provider.lastError === null ? 'active' : 'stale',
        relayError: provider.lastError,
        node: built.node,
      });
    }
    return views;
  }

  relayView(relayFingerprint: string): IxRelayView | undefined {
    return this.relayViews().find((view) => view.fingerprint === relayFingerprint);
  }

  // ── provider 解析 ─────────────────────────────────────

  /**
   * 决定用哪个中转商。
   *
   * 给了 id 就取它（**不管总闸开没开** —— 管理页仍要能对关掉的 provider 做体检）。
   *
   * 没给 id 时取 `listEnabled()` 的第一个。这里的 tie-break 是计划里的空白，
   * 补成：**按 `created_at` 取最早建的那个**（`listEnabled()` 已经这么排序，
   * 所以结果确定、可复现，不会因为 SQLite 的行序变化而漂移），并且在启用的
   * provider 多于一个时**返回一条 warning** —— 静默挑一个的话，用户会看到
   * "有些节点走了中转、有些没走"却查不出为什么。
   */
  resolveProvider(providerId?: string): IxProviderResolution {
    if (providerId !== undefined && providerId !== '') {
      const provider = this.deps.providers.get(providerId);
      if (!provider) {
        return {
          warnings: [],
          reason:
            `指定的中转商（${providerRef(providerId)}…）不存在，可能已被删除。` +
            '下一步：到「IX 中转」页重新选择通道。',
        };
      }
      return { provider, warnings: [] };
    }

    const enabled = this.deps.providers.listEnabled();
    const first = enabled[0];
    if (!first) {
      return {
        warnings: [],
        reason:
          '没有启用的中转商（一个都没录入，或全局总闸都关着）。' +
          '下一步：到「IX 中转」页录入并启用一个中转商。',
      };
    }
    if (enabled.length === 1) return { provider: first, warnings: [] };

    return {
      provider: first,
      warnings: [
        `IX 中转：当前有 ${enabled.length} 个启用中的中转商，而请求没指定用哪个，` +
          `已按创建时间取最早的「${first.name}」；生成 IX 节点时应显式选择通道`,
      ],
    };
  }

  // ── 客户端构造（含凭据解密与 JWT 持久化）───────────────

  /**
   * 解密凭据并造一个客户端。**任何失败都不抛**，返回 `ok:false`。
   *
   * 这条约束是硬的：`clientFor` 会被管理路由与调度器调用，而凭据解不开
   * （轮换过 `ADMIN_TOKEN` 就一定解不开）属于可预期状态，不是异常。
   * 抛出去的话，一次 ADMIN_TOKEN 轮换会把管理页整片打成 500。
   */
  clientFor(provider: IxProvider): IxClientResolution {
    let auth: IxAuth;
    try {
      auth = this.buildAuth(provider);
    } catch (err) {
      if (isSecretDecryptError(err)) {
        const reason = `中转商「${provider.name}」的${DECRYPT_FAILURE_MARK}。${NEXT_STEP_RELOGIN}`;
        // 落到 last_error：界面要能直接显示"为什么这个 provider 不工作"
        this.deps.providers.update(provider.id, { lastError: reason }, this.now());
        this.deps.logger.warn('IX：凭据无法解密，已标记需重新录入', {
          providerRef: providerRef(provider.id),
          reason: err.reason,
        });
        return { ok: false, reason, credentialProblem: true };
      }
      const reason = describeError(err);
      this.deps.providers.update(provider.id, { lastError: reason }, this.now());
      return { ok: false, reason, credentialProblem: true };
    }

    // 解得开了就把上一次的"解不开"抹掉。不清的后果是界面永远飘红：
    // 用户按提示重新录入了凭据、也确实生效了，却还看着一条已经不成立的
    // 报错 —— 而这种"修好了但还在报错"最能教人从此不信界面上的提示。
    // 只清这一类：clientFor 成功只证明凭据能解开，不证明平台调得通，
    // 网络类的 last_error 得留着。DB 里 last_error 就一个字符串列，
    // 为分类单开一列不值得一次迁移，所以用文案前缀判定（产生处只有一个）。
    if (provider.lastError && isDecryptFailureNote(provider.lastError)) {
      this.deps.providers.update(provider.id, { lastError: null }, this.now());
    }

    const factory = this.deps.createClient ?? ((p, a) => this.defaultClient(p, a));
    return { ok: true, client: factory(provider, auth) };
  }

  private defaultClient(provider: IxProvider, auth: IxAuth): IxPlatformClient {
    return new IxClient({
      baseUrl: provider.baseUrl,
      auth,
      logger: this.deps.logger,
      timeoutMs: this.deps.config.ixTimeoutMs,
    });
  }

  private buildAuth(provider: IxProvider): IxAuth {
    const key = this.deps.secretKey;

    if (provider.authMode === 'api-key') {
      if (!provider.apiKeyEnc) {
        throw new Error(
          `中转商「${provider.name}」是 API Key 模式但没有存 Key。` +
            '下一步：到「IX 中转」页补录 API Key，或改用账号密码登录模式。',
        );
      }
      return { mode: 'api-key', apiKey: decryptSecret(provider.apiKeyEnc, key) };
    }

    if (!provider.username || !provider.passwordEnc) {
      throw new Error(
        `中转商「${provider.name}」还没录入账号密码。下一步：到「IX 中转」页补录凭据。`,
      );
    }

    return {
      mode: 'login',
      username: provider.username,
      password: decryptSecret(provider.passwordEnc, key),
      session: this.cachedSession(provider),
      onSession: (session) => this.persistSession(provider.id, session),
    };
  }

  /**
   * 取回上次登录缓存的 JWT。
   *
   * 解不开就当没有缓存（**不抛**）：密码那条已经在同一把密钥上解过一次了，
   * 能走到这里说明密钥是对的，JWT 密文单独坏掉只意味着"重登一次"，
   * 不该把整个 provider 打成不可用。
   *
   * `sessionId` 不落库（schema 里没有这列），它只用于日志里的 ref，
   * 恢复时给空串即可 —— 客户端只用 `jwt` 与 `expiresAt`。
   */
  private cachedSession(provider: IxProvider): IxSession | null {
    if (!provider.jwtEnc) return null;
    try {
      return {
        jwt: decryptSecret(provider.jwtEnc, this.deps.secretKey),
        sessionId: '',
        expiresAt: provider.jwtExpiresAt,
      };
    } catch {
      this.deps.logger.warn('IX：缓存的 JWT 解不开，将重新登录', {
        providerRef: providerRef(provider.id),
      });
      return null;
    }
  }

  /** 客户端拿到新 JWT 时的持久化回调（加密落库）。抛异常不影响本次业务请求。 */
  private persistSession(providerId: string, session: IxSession): void {
    try {
      this.deps.providers.update(
        providerId,
        {
          jwtEnc: encryptSecret(session.jwt, this.deps.secretKey),
          jwtExpiresAt: session.expiresAt,
        },
        this.now(),
      );
    } catch (err) {
      this.deps.logger.warn('IX：JWT 缓存写入失败，下轮同步会重新登录', {
        providerRef: providerRef(providerId),
        reason: describeError(err),
      });
    }
  }

  // ── 体检 ─────────────────────────────────────────────

  /**
   * 测试连接：拉账户额度与线路清单，写快照，清 `last_error`。
   *
   * 本方法只做**所有出站方法共用的前置**（选 provider、造客户端），
   * 真正那一趟在 `ix-probe.ts` 的 `runProbe()`。
   * 返回结构里**没有任何凭据**（只有平台侧 username），可以直接交给界面。
   */
  async probe(providerId?: string): Promise<IxProbeResult> {
    const resolution = this.resolveProvider(providerId);
    const provider = resolution.provider;
    if (!provider) {
      return {
        ok: false,
        lines: [],
        unavailable: [],
        warnings: resolution.warnings,
        error: resolution.reason ?? '没有可用的中转商',
      };
    }

    const base = { providerId: provider.id, name: provider.name };
    const client = this.clientFor(provider);
    if (!client.ok) {
      return { ok: false, ...base, lines: [], unavailable: [], warnings: resolution.warnings, error: client.reason };
    }

    // probe 自己不抛：失败以 `{ok:false, error}` 返回（同 clientFor 的口径）。
    return runProbe({
      provider,
      client: client.client,
      providers: this.deps.providers,
      logger: this.deps.logger,
      now: this.now(),
      warnings: resolution.warnings,
    });
  }

  // ── 建立映射 ─────────────────────────────────────────

  /**
   * 给指定节点建立映射。
   *
   * 这里只做前置（选 provider、造客户端），四步链路（认领 → 配额预检 →
   * 创建 → 回读）与它那一整套逐节点文案在 `ix-ensure.ts` 的 `runEnsureMappings()`。
   */
  async ensureMappings(providerId: string | undefined, fingerprints: readonly string[]): Promise<IxEnsureResult> {
    const resolution = this.resolveProvider(providerId);
    const provider = resolution.provider;
    if (!provider) {
      return { ok: false, items: [], warnings: resolution.warnings, error: resolution.reason ?? '没有可用的中转商' };
    }
    const client = this.clientFor(provider);
    if (!client.ok) {
      return { ok: false, providerId: provider.id, items: [], warnings: resolution.warnings, error: client.reason };
    }

    return runEnsureMappings(
      {
        provider,
        client: client.client,
        mappings: this.deps.mappings,
        nodes: this.deps.nodes,
        logger: this.deps.logger,
        // 传函数而不是一个时间点：ensure 是逐节点各取一次时钟的
        now: () => this.now(),
        warnings: resolution.warnings,
      },
      fingerprints,
    );
  }

  // ── 状态同步 ─────────────────────────────────────────

  /**
   * 拉远端端口对齐本地映射：入口地址、延迟、丢包、流量、挂起、下发错误、线路名。
   *
   * **一次 `listAllPorts()` 拉全再逐条比对**，不按映射逐个查 ——
   * 平台没有 `GET /ports/:id`，逐个查等于每条映射至少两次翻页请求。
   *
   * 孤儿判定也在这里：节点已从本地 `nodes` 表消失就累加 `missing_count`，
   * 累到阈值标 `orphan`。**绝不自动删远端端口**（用户已明确决策）。
   */
  async refresh(providerId?: string): Promise<IxRefreshResult> {
    const resolution = this.resolveProvider(providerId);
    const provider = resolution.provider;
    if (!provider) {
      return {
        ok: false,
        checked: 0,
        updated: 0,
        discovered: 0,
        missingRemote: 0,
        orphaned: 0,
        recovered: 0,
        warnings: resolution.warnings,
        error: resolution.reason ?? '没有可用的中转商',
      };
    }
    const empty: IxRefreshResult = {
      ok: true,
      providerId: provider.id,
      checked: 0,
      updated: 0,
      discovered: 0,
      missingRemote: 0,
      orphaned: 0,
      recovered: 0,
      warnings: resolution.warnings,
    };

    const mappings = this.deps.mappings.listByProvider(provider.id);

    const client = this.clientFor(provider);
    if (!client.ok) {
      this.deps.providers.update(provider.id, { lastError: client.reason }, this.now());
      return { ...empty, ok: false, error: client.reason };
    }

    let ports: IxPort[];
    try {
      ports = await client.client.listAllPorts();
    } catch (err) {
      const message = describeError(err);
      this.deps.providers.update(provider.id, { lastError: message }, this.now());
      return { ...empty, ok: false, error: message };
    }

    const { byId, byTarget } = indexPorts(ports);
    const localNodes = this.deps.nodes.listAll();
    const localFingerprints = new Set(localNodes.map((node) => node.fingerprint));

    const result = { ...empty, checked: mappings.length };
    const now = this.now();
    const threshold = this.deps.config.ixOrphanThreshold;

    this.deps.mappings.transaction(() => {
      // 首次接入 provider 时，本地映射表通常是空的，但平台上可能已有手工端口。
      // 把远端 target 与原节点地址做**精确匹配**后自动认领，绝不调用 createPort。
      const existingFingerprints = new Set(mappings.map((mapping) => mapping.fingerprint));
      const nodesByTarget = new Map<string, typeof localNodes>();
      for (const node of localNodes) {
        if (!checkIxSafety(node).ok) continue;
        const key = targetOf(node.server, node.port).toLowerCase();
        const bucket = nodesByTarget.get(key) ?? [];
        bucket.push(node);
        nodesByTarget.set(key, bucket);
      }
      for (const port of [...ports].sort((left, right) => left.id - right.id)) {
        for (const target of port.target_address_list ?? []) {
          for (const node of nodesByTarget.get(target.trim().toLowerCase()) ?? []) {
            if (existingFingerprints.has(node.fingerprint)) continue;
            const saved = this.deps.mappings.upsert(
              {
                providerId: provider.id,
                fingerprint: node.fingerprint,
                targetHost: node.server,
                targetPort: node.port,
                ...mappingPatchFromPort(port, now),
                missingCount: 0,
              },
              now,
            );
            mappings.push(saved);
            existingFingerprints.add(node.fingerprint);
            result.discovered += 1;
          }
        }
      }
      result.checked = mappings.length;

      for (const mapping of mappings) {
        // id 找不到就按目标地址再找一次：用户可能在平台上手工删了重建，
        // 那个新端口指向同一个落地，认回来比标 error 有用。
        const port =
          (mapping.remotePortId !== null ? byId.get(mapping.remotePortId) : undefined) ??
          byTarget.get(targetOf(mapping.targetHost, mapping.targetPort).toLowerCase());

        const patch: IxMappingPatch = port
          ? mappingPatchFromPort(port, now)
          : { state: 'error', lastError: DETAIL_REMOTE_GONE, remoteSyncedAt: now };
        if (port) result.updated += 1;
        else result.missingRemote += 1;

        // 孤儿判定压在最后：它可以覆盖上面算出来的 state。
        // 注意 bumpMissing() 对不存在的映射也返回 0，与"计数真的是 0"不可区分 ——
        // 这里遍历的都是刚从库里列出来的映射，行一定存在，所以返回值可信。
        if (localFingerprints.has(mapping.fingerprint)) {
          if (mapping.missingCount > 0) {
            this.deps.mappings.resetMissing(provider.id, mapping.fingerprint, now);
            result.recovered += 1;
          }
        } else {
          const missing = this.deps.mappings.bumpMissing(provider.id, mapping.fingerprint, now);
          if (missing >= threshold) {
            if (mapping.state !== 'orphan') result.orphaned += 1;
            patch.state = 'orphan';
            patch.lastError = detailOrphan(missing);
          }
        }

        this.deps.mappings.update(provider.id, mapping.fingerprint, patch, now);
      }
    });
    this.deps.providers.update(provider.id, { lastError: null }, now);

    this.deps.logger.info('IX：状态同步完成', {
      providerRef: providerRef(provider.id),
      checked: result.checked,
      updated: result.updated,
      discovered: result.discovered,
      missingRemote: result.missingRemote,
      orphaned: result.orphaned,
      recovered: result.recovered,
    });
    return result;
  }

  /** 同步所有启用中的 provider。串行：多账号并发出站只会更快撞上限流。 */
  async refreshAll(): Promise<IxRefreshResult[]> {
    const results: IxRefreshResult[] = [];
    for (const provider of this.deps.providers.listEnabled()) {
      results.push(await this.refresh(provider.id));
    }
    return results;
  }

  // ── 删除映射 ─────────────────────────────────────────

  async removeRelay(relayFingerprint: string): Promise<IxRemoveResult> {
    const relay = this.relayView(relayFingerprint);
    if (!relay) {
      return {
        ok: false,
        removedLocal: false,
        remoteDeleted: false,
        warnings: [],
        error: 'IX 派生节点不存在（可能已经被删除）。',
      };
    }
    return this.removeMapping(relay.providerId, relay.originFingerprint, { deleteRemote: true });
  }

  /**
   * 删一条映射，可选连远端端口一起删。
   *
   * **远端删失败时不删本地映射**：删了就再也不知道那个端口 id 是谁的了，
   * 它会永远占着线路配额而界面上什么都看不到。宁可留着这条映射带一个
   * 可读的 `last_error`，让用户能看见、能重试。
   */
  async removeMapping(
    providerId: string,
    fingerprint: string,
    options: { deleteRemote?: boolean } = {},
  ): Promise<IxRemoveResult> {
    const mapping = this.deps.mappings.get(providerId, fingerprint);
    if (!mapping) {
      return {
        ok: false,
        removedLocal: false,
        remoteDeleted: false,
        warnings: [],
        error: '这条映射不存在（可能已经被删掉了）。',
      };
    }

    const warnings: string[] = [];
    if (!options.deleteRemote || mapping.remotePortId === null) {
      if (mapping.remotePortId !== null) {
        warnings.push(
          `远端端口 ${mapping.remotePortId} 仍然存在，会继续占用线路配额；` +
            '需要一起删请重新执行并勾选"同时删除远端端口"',
        );
      } else if (options.deleteRemote) {
        warnings.push('平台尚未分配远端端口 id，本次只删除本地 IX 节点。');
      }
      const removedLocal = this.deps.mappings.delete(providerId, fingerprint);
      const result: IxRemoveResult = { ok: removedLocal, removedLocal, remoteDeleted: false, warnings };
      if (mapping.remotePortId !== null) result.remotePortId = mapping.remotePortId;
      return result;
    }

    const shared = this.deps.mappings.listByRemotePort(providerId, mapping.remotePortId);
    if (shared.length > 1) {
      const removedLocal = this.deps.mappings.delete(providerId, fingerprint);
      warnings.push(
        `远端端口 ${mapping.remotePortId} 仍被另外 ${shared.length - 1} 个 IX 节点使用，` +
          '本次只删除当前派生节点；最后一个引用删除时才会删除远端端口。',
      );
      return {
        ok: removedLocal,
        removedLocal,
        remoteDeleted: false,
        remotePortId: mapping.remotePortId,
        warnings,
      };
    }

    const provider = this.deps.providers.get(providerId);
    if (!provider) {
      return {
        ok: false,
        removedLocal: false,
        remoteDeleted: false,
        remotePortId: mapping.remotePortId,
        warnings,
        error: '这条映射的中转商已不存在，无法删除远端端口。',
      };
    }
    const client = this.clientFor(provider);
    if (!client.ok) {
      return {
        ok: false,
        removedLocal: false,
        remoteDeleted: false,
        remotePortId: mapping.remotePortId,
        warnings,
        error: `无法删除远端端口：${client.reason}`,
      };
    }

    const now = this.now();
    let deleteError: string | undefined;
    try {
      await client.client.deletePort(mapping.remotePortId);
    } catch (err) {
      deleteError = describeError(err);
    }

    let stillExists: boolean;
    try {
      const ports = await client.client.listAllPorts();
      stillExists = ports.some((port) => port.id === mapping.remotePortId);
    } catch (err) {
      const verifyError = describeError(err);
      this.deps.mappings.update(
        providerId,
        fingerprint,
        {
          state: 'error',
          lastError:
            `无法确认远端端口 ${mapping.remotePortId} 是否已删除：${verifyError}。` +
            '本地 IX 节点已保留，避免远端端口继续占配额却失去追踪。',
        },
        now,
      );
      return {
        ok: false,
        removedLocal: false,
        remoteDeleted: false,
        remotePortId: mapping.remotePortId,
        warnings,
        error: verifyError,
      };
    }

    if (stillExists) {
      const message = deleteError ?? '平台删除接口返回后端口仍然存在';
      this.deps.mappings.update(
        providerId,
        fingerprint,
        {
          state: 'error',
          lastError:
            `删除远端端口 ${mapping.remotePortId} 失败：${message}。` +
            '本地映射已保留，IX 节点也继续显示；下一步：稍后重试，或到中转平台手动删除。',
        },
        now,
      );
      return {
        ok: false,
        removedLocal: false,
        remoteDeleted: false,
        remotePortId: mapping.remotePortId,
        warnings,
        error: message,
      };
    }

    if (deleteError) warnings.push(`删除接口返回「${deleteError}」，但回读确认远端端口已不存在。`);

    const removedLocal = this.deps.mappings.delete(providerId, fingerprint);
    this.deps.logger.info('IX：映射与远端端口已删除', {
      providerRef: providerRef(providerId),
      portId: mapping.remotePortId,
    });
    return { ok: true, removedLocal, remoteDeleted: true, warnings };
  }

  // ── 渲染路径（同步、零出站）─────────────────────────

  /**
   * 给渲染管线用的映射表。**纯本地 SQLite 同步读，零出站请求。**
   *
   * 这是 `state`+`suspended` → `IxPortStatus` 翻译的唯一入口（见 `statusFor`）。
   *
   * 没有入口地址的映射（`pending`，端口还没建成/还没认领）**不进这张表**：
   * 与其编一个 `:0` 的假入口让 core 报"地址非法"，不如让 core 如实说
   * "这个节点没有映射"，用户到「IX 中转」页就能看到那条 pending 映射和它的原因。
   * 项目里 `entry_port` 不给默认 0 就是同一个理由 —— 0 是能一路混进客户端配置的假值。
   */
  entriesFor(providerId: string): IxEntryMap {
    const entries = new Map<string, IxEntry>();
    const provider = this.deps.providers.get(providerId);
    if (!provider) return entries;

    for (const [fingerprint, mapping] of this.deps.mappings.mapForProvider(providerId)) {
      if (mapping.entryHost === null || mapping.entryPort === null) continue;
      entries.set(fingerprint, {
        entryHost: mapping.entryHost,
        entryPort: mapping.entryPort,
        status: statusFor(mapping),
        // UDP 三态的事实来源**只有** entry_udp 这一列（由 refresh / 认领回读时
        // 从平台 port 的 enable_udp 写入）。NULL → undefined，即"我们还不知道
        // 这个端口转不转 UDP"，core 的 udpPolicy='lenient' 会照改并留一条警告。
        //
        // 绝不回落到 provider.enableUdp。那只是我们**建端口时**用的请求参数：
        // 用户在平台上手工关掉某个端口的 UDP，我们从那个值上完全看不出来。
        // 拿它当事实有两重代价 ——
        //   ① hysteria2 / tuic / QUIC 节点被当成可改写，输出一个 TCP 通、
        //      UDP 黑洞的死节点（最难归因的"半坏"）；
        //   ② "未知"该有的那条 warning 也被一并吞掉，用户连线索都没有。
        // 诚实说"不知道"比假装知道好。这里看着像"少了个默认值"，是刻意的。
        udp: mapping.entryUdp ?? undefined,
        label: mapping.lineName ?? provider.name,
      });
    }
    return entries;
  }
}

// ─────────────────────────────────────────────────────────────
//  辅助
// ─────────────────────────────────────────────────────────────

/**
 * 把端口列表建成两张索引：按 id、按目标地址。
 *
 * 两张都要：按 id 是常态，按目标地址是为了认回"用户在平台上手工删了重建"
 * 的端口（id 变了但落地没变）—— 那种情况下标 error 会让用户白建一次。
 */
function indexPorts(ports: readonly IxPort[]): { byId: Map<number, IxPort>; byTarget: Map<string, IxPort> } {
  const byId = new Map<number, IxPort>();
  const byTarget = new Map<string, IxPort>();
  for (const port of ports) {
    byId.set(port.id, port);
    for (const addr of port.target_address_list ?? []) {
      byTarget.set(addr.trim().toLowerCase(), port);
    }
  }
  return { byId, byTarget };
}
