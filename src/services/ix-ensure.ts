/**
 * 给指定节点建立映射：**先认领，再创建**。
 *
 * 定位：`ix.ts` 的 `IxService.ensureMappings()` 的实现体。单独一个文件是因为
 * 这条链路自成一段 —— 认领/配额预检/创建/回读四步、每一步都有自己的失败文案，
 * 而"失败也要留下一行映射"是它独有的硬要求（refresh 与 removeMapping 不需要）。
 *
 * `provider` 解析与客户端构造留在 `ix.ts`（那是所有出站方法共用的前置），
 * 所以本文件拿到的已经是"确定的 provider + 能用的客户端"。
 */

import type { IxMapping, IxMappingRepo, IxMappingState, IxProvider } from '../db/repo/ix.js';
import type { NodeRepo, StoredNode } from '../db/repo/nodes.js';
import type { Logger } from '../logger.js';
import { describeError, mappingPatchFromPort, providerRef, targetOf, type IxPlatformClient } from './ix-mapping.js';
import type { IxMutationResult, IxPort } from './ix-protocol.js';

// ─────────────────────────────────────────────────────────────
//  返回结构
// ─────────────────────────────────────────────────────────────

export type IxEnsureOutcome = 'created' | 'claimed' | 'skipped' | 'failed';

export interface IxEnsureItem {
  fingerprint: string;
  name: string;
  outcome: IxEnsureOutcome;
  /** 中文说明 + 下一步（照 core/ix.ts 的口径：给原因也给出路）。 */
  detail: string;
  remotePortId?: number;
  entryHost?: string;
  entryPort?: number;
}

export interface IxEnsureResult {
  ok: boolean;
  providerId?: string;
  items: IxEnsureItem[];
  warnings: string[];
  /** 整体失败（连 provider / 客户端 / 线路都没拿到）的原因。 */
  error?: string;
}

// ─────────────────────────────────────────────────────────────
//  常量
// ─────────────────────────────────────────────────────────────

/** 端口显示名前缀：在平台上一眼看出这个端口是 subagg 建的。 */
const DISPLAY_PREFIX = 'subagg';
/** 显示名长度上限。平台侧上限未实测，取一个保守值，免得被服务端截断到认不出。 */
const DISPLAY_MAX = 64;

const DETAIL_SKIPPED = '本地已有可用映射，未重复建端口（幂等）。';

const DETAIL_NO_NODE =
  '本地节点表里已经没有这个指纹了（上游刷新后消失，或指纹填错）。' +
  '下一步：先同步订阅源确认节点还在，再重新勾选。';

// ── 逐节点文案（照 core/ix.ts 的口径：给原因也给出路）──

function missingNodeItem(fingerprint: string, existing: IxMapping | undefined): IxEnsureItem {
  return {
    fingerprint,
    // 节点没了就用映射里冗余存的原地址指认它，比只给一串指纹前缀有用
    name: existing ? `${existing.targetHost}:${existing.targetPort}` : fingerprint.slice(0, 12),
    outcome: 'failed',
    detail: DETAIL_NO_NODE,
  };
}

function skippedItem(fingerprint: string, name: string, existing: IxMapping): IxEnsureItem {
  const item: IxEnsureItem = { fingerprint, name, outcome: 'skipped', detail: DETAIL_SKIPPED };
  if (existing.remotePortId !== null) item.remotePortId = existing.remotePortId;
  if (existing.entryHost !== null) item.entryHost = existing.entryHost;
  if (existing.entryPort !== null) item.entryPort = existing.entryPort;
  return item;
}

function detailClaimed(port: IxPort): string {
  return `已认领平台上现有的端口 ${port.id}（未新建，不占额外配额）。`;
}

function detailCreated(port: IxPort): string {
  return `已新建端口 ${port.id}，入口 ${port.ip_addr}:${port.port_v4}。`;
}

function detailQuota(budget: LineBudget): string {
  return (
    `线路「${budget.name}」的端口配额已用满（${budget.used}/${budget.maxPorts}），无法再建端口。` +
    '下一步：到中转平台删掉不用的端口，或在「IX 中转」页取消勾选部分节点；' +
    '配额是**线路级**的，换一条线路也能解决。'
  );
}

function detailReadback(created: IxMutationResult): string {
  return (
    `端口已在平台上创建（${describeMutation(created)}），但回读入口地址失败，本地映射先记为待就绪。` +
    '配额已经被占用。' +
    '下一步：跑一次 IX 状态同步，它会按目标地址把这个端口认领回来。'
  );
}

/** create 的响应形状未实测，只把能确认的部分说出来，不编造。 */
function describeMutation(result: IxMutationResult): string {
  if (typeof result.id === 'number') return `端口 id ${result.id}`;
  if (typeof result.message === 'string' && result.message !== '') return result.message;
  return '平台未回报端口 id';
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

interface LineBudget {
  lineId: number;
  name: string;
  maxPorts: number;
  /** 已占用端口数。本轮每建一个就 +1，避免一次批量把配额建超。 */
  used: number;
}

// ─────────────────────────────────────────────────────────────
//  建立映射
// ─────────────────────────────────────────────────────────────

/** 本轮建映射的输入。provider 已选定、客户端已构造好，两者都由 `ix.ts` 备齐。 */
export interface IxEnsureInput {
  provider: IxProvider;
  client: IxPlatformClient;
  mappings: IxMappingRepo;
  /** 只读：取节点的原始地址与显示名。 */
  nodes: NodeRepo;
  logger: Logger;
  /** 逐节点各取一次时钟（与原实现一致：每个节点用自己那一刻的时间戳）。 */
  now: () => number;
  /** provider 解析阶段产生的提示，原样带出。 */
  warnings: string[];
}

/**
 * 顺序是刻意的：
 * 1. 本地已有映射（且不是孤儿）→ 跳过，保证幂等；
 * 2. `findPortByTarget()` 认领远端已存在的端口 → 不发 create
 *    （用户平台上可能已有手工建的端口，30 个配额浪费不起）；
 * 3. **配额预检**：配额是**线路级**的（`lines[].max_ports_number` 对
 *    `line_details[].port_count`），超了就给可读原因并停止创建 ——
 *    不等服务端报错，因为超限的服务端文案未知；
 * 4. `createPort()` → **回读 `port_v4`**（端口号由平台分配，create 的响应里没有）。
 *
 * 任一节点失败只落到它自己的 `last_error` 并继续处理其余节点。
 */
export async function runEnsureMappings(
  input: IxEnsureInput,
  fingerprints: readonly string[],
): Promise<IxEnsureResult> {
  const { provider, mappings, nodes, logger, warnings } = input;

  const wanted = [...new Set(fingerprints)];
  if (wanted.length === 0) {
    return { ok: true, providerId: provider.id, items: [], warnings };
  }

  let budget: LineBudget;
  try {
    budget = await resolveBudget(input);
  } catch (err) {
    return {
      ok: false,
      providerId: provider.id,
      items: [],
      warnings,
      error: describeError(err),
    };
  }

  const nodeByFp = new Map<string, StoredNode>(nodes.listAll().map((node) => [node.fingerprint, node]));
  const existing = new Map<string, IxMapping>(
    mappings.listByFingerprints(provider.id, wanted).map((mapping) => [mapping.fingerprint, mapping]),
  );

  const items: IxEnsureItem[] = [];
  for (const fingerprint of wanted) {
    items.push(await ensureOne(input, budget, fingerprint, nodeByFp.get(fingerprint), existing.get(fingerprint)));
  }

  const failed = items.filter((item) => item.outcome === 'failed').length;
  logger.info('IX：映射建立完成', {
    providerRef: providerRef(provider.id),
    requested: wanted.length,
    created: items.filter((i) => i.outcome === 'created').length,
    claimed: items.filter((i) => i.outcome === 'claimed').length,
    skipped: items.filter((i) => i.outcome === 'skipped').length,
    failed,
  });

  return { ok: failed === 0, providerId: provider.id, items, warnings };
}

async function ensureOne(
  input: IxEnsureInput,
  budget: LineBudget,
  fingerprint: string,
  node: StoredNode | undefined,
  existing: IxMapping | undefined,
): Promise<IxEnsureItem> {
  const { provider, client, logger } = input;
  if (!node) return missingNodeItem(fingerprint, existing);

  // 幂等第一关：本地已有映射就不再动远端。孤儿例外 —— 那是"节点回来了"，
  // 该重新走一遍认领/创建把它救回 active。
  if (existing && existing.state !== 'orphan') return skippedItem(fingerprint, node.name, existing);

  const target = targetOf(node.server, node.port);
  const now = input.now();
  try {
    // ① 认领：远端已有指向同一目标的端口就直接用它，不消耗配额。
    //    客户端已在 findPortByTarget 里做过精确比对（服务端的 target 是
    //    子串模糊匹配，信它会把 A 节点的流量指到 B 节点的落地上）。
    const claimed = await client.findPortByTarget(target);
    if (claimed) {
      return writeMapping(input, fingerprint, node, claimed, now, 'claimed', detailClaimed(claimed));
    }

    // ② 配额预检。超了只挡"创建"，认领仍然继续 —— 认领不占配额，
    //    没道理因为配额满了就连白捡的端口都不要。
    if (budget.used >= budget.maxPorts) {
      return failMapping(input, fingerprint, node, now, detailQuota(budget), 'error');
    }

    // ③ 创建。端口号由平台分配，所以 create 的响应里没有入口地址。
    // provider.enableUdp 的作用域就到这里为止：它是**建端口的请求参数**。
    // 端口建成之后"到底转不转 UDP"只认平台回报的 enable_udp
    // （下面回读时由 mappingPatchFromPort 写进 entry_udp）——
    // 用户随时能在平台上手工改这个开关，我们的请求参数不是事实。
    const created = await client.createPort({
      displayName: truncate(`${DISPLAY_PREFIX} ${node.name}`, DISPLAY_MAX),
      outboundEndpointId: budget.lineId,
      targetAddressList: [target],
      enableUdp: provider.enableUdp,
      tags: [DISPLAY_PREFIX],
    });
    budget.used += 1;

    // ④ 回读：唯一能拿到 port_v4 的办法。回读不到也**不能**当成功 ——
    //    远端端口已经建出来了（配额已被占用），必须如实上报。
    const readback = await client.findPortByTarget(target);
    if (!readback) {
      return failMapping(input, fingerprint, node, now, detailReadback(created), 'pending', budget);
    }

    return writeMapping(input, fingerprint, node, readback, now, 'created', detailCreated(readback));
  } catch (err) {
    const detail = describeError(err);
    logger.warn('IX：建立映射失败', {
      providerRef: providerRef(provider.id),
      entry: target,
      reason: detail,
    });
    return failMapping(input, fingerprint, node, now, detail, 'error');
  }
}

/**
 * 记下一次失败：原因落到**该映射自己**的 `last_error`，然后返回 failed 条目。
 *
 * 单独抽出来是因为这条路径有三个入口（配额满、回读失败、平台报错），
 * 而"失败也要留下一行映射"是它们共同的硬要求 —— 少写一处，界面上就会出现
 * 一个既没有映射、也没有原因的节点，用户只能看到"勾了但没生效"。
 */
function failMapping(
  input: IxEnsureInput,
  fingerprint: string,
  node: StoredNode,
  now: number,
  detail: string,
  state: IxMappingState,
  budget?: LineBudget,
): IxEnsureItem {
  input.mappings.upsert(
    {
      providerId: input.provider.id,
      fingerprint,
      targetHost: node.server,
      targetPort: node.port,
      ...(budget ? { lineId: budget.lineId, lineName: budget.name } : {}),
      state,
      lastError: detail,
    },
    now,
  );
  return { fingerprint, name: node.name, outcome: 'failed', detail };
}

function writeMapping(
  input: IxEnsureInput,
  fingerprint: string,
  node: StoredNode,
  port: IxPort,
  now: number,
  outcome: IxEnsureOutcome,
  detail: string,
): IxEnsureItem {
  const saved = input.mappings.upsert(
    {
      providerId: input.provider.id,
      fingerprint,
      targetHost: node.server,
      targetPort: node.port,
      // mappingPatchFromPort 已经负责 lastError：端口就绪时是 null
      // （把上次的失败原因清掉，否则界面永远显示旧错误），
      // 端口还没分配到入口地址时是可读原因 —— 别在这里覆盖它。
      ...mappingPatchFromPort(port, now),
      missingCount: 0,
    },
    now,
  );
  const item: IxEnsureItem = { fingerprint, name: node.name, outcome, detail };
  if (saved.remotePortId !== null) item.remotePortId = saved.remotePortId;
  if (saved.entryHost !== null) item.entryHost = saved.entryHost;
  if (saved.entryPort !== null) item.entryPort = saved.entryPort;
  return item;
}

/**
 * 算出"往哪条线路建、还能建几个"。
 *
 * 端口配额是**线路级**的：上限在 `subscription.lines[].max_ports_number`，
 * 实时占用在 `line_details[].port_count`，账户顶层没有任何端口数字段。
 * 按账户级算会在多线路时给出完全错误的结论。
 */
async function resolveBudget(input: IxEnsureInput): Promise<LineBudget> {
  const { provider, client, mappings } = input;
  const [info, details] = await Promise.all([client.subscriptionInfo(), client.lineDetails()]);
  const lines = info.lines ?? [];
  const line =
    provider.defaultLineId !== null
      ? lines.find((candidate) => candidate.id === provider.defaultLineId)
      : lines[0];

  if (!line) {
    throw new Error(
      provider.defaultLineId !== null
        ? `平台没有 id 为 ${provider.defaultLineId} 的线路（可能已下线）。` +
          '下一步：到「IX 中转」页把默认线路改成平台上现有的线路，或清空它以自动选第一条。'
        : '平台没有返回任何可用线路。下一步：先点「测试连接」确认账号状态与线路清单。',
    );
  }

  const detail = details.find((candidate) => candidate.line_id === line.id);
  // port_count 拿不到时退回本地映射数：它可能偏大（含还没建成的 pending），
  // 偏大只会更早地挡住创建，是安全的方向。
  const used = detail?.port_count ?? mappings.count(provider.id);

  return {
    lineId: line.id,
    name: line.display_name || String(line.id),
    maxPorts: typeof line.max_ports_number === 'number' ? line.max_ports_number : 0,
    used,
  };
}
