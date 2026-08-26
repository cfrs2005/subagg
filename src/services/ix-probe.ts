/**
 * IX 中转商体检：拉账户额度与线路清单，写额度快照，清 `last_error`。
 *
 * 定位：`ix.ts` 的 `IxService.probe()` 的实现体。之所以单独一个文件，是因为它
 * 自成一段 —— 一次并发拉两个端点（`subscriptionInfo` + `lineDetails`）、
 * 把**单位不一致**的流量字段换算齐、把"这个账号做不到什么"逐条写成中文、
 * 最后把统一过单位的快照落库 —— 与"建映射 / 同步状态"那两条链路没有共享逻辑。
 *
 * `provider` 解析与客户端构造留在 `ix.ts`（那是所有出站方法共用的前置），
 * 所以本文件拿到的已经是"确定的 provider + 能用的客户端"。
 *
 * **返回结构里没有任何凭据**（只有平台侧 username），可以直接交给界面。
 */

import type { IxProvider, IxProviderRepo } from '../db/repo/ix.js';
import type { Logger } from '../logger.js';
import { describeError, providerRef, type IxPlatformClient } from './ix-mapping.js';
import type { IxLineDetail, IxSubscriptionInfo, IxSubscriptionLine } from './ix-protocol.js';

// ─────────────────────────────────────────────────────────────
//  返回结构
// ─────────────────────────────────────────────────────────────

export interface IxProbeLine {
  lineId: number;
  name: string;
  /** 中转入口主机名。客户端将来就是拨这个地址。 */
  entryHost: string;
  portStart: number;
  portEnd: number;
  /** 该线路的端口数上限。**配额是线路级的**，账户顶层没有这个字段。 */
  maxPorts: number;
  /** 平台实时占用（`line_details.port_count`）。null = 平台没回报这条线路。 */
  usedPorts: number | null;
  online: boolean;
  suspended: boolean;
}

export interface IxProbeResult {
  ok: boolean;
  providerId?: string;
  /** provider 在本地的展示名。 */
  name?: string;
  /** 平台侧用户名。凭据里只有它可以外露（密码/Key/JWT 一律不出现）。 */
  username?: string;
  isAdmin?: boolean;
  lines: IxProbeLine[];
  /** 字节。平台 `traffic_used` 的原始口径。 */
  trafficUsedBytes?: number;
  /**
   * 字节。平台的 `traffic_total` 是 **GiB**、`traffic_used` 是**字节** ——
   * 两个字段单位不同，直接相减是错的。这里统一换算成字节再出门。
   */
  trafficTotalBytes?: number;
  validUntil?: string;
  expired?: boolean;
  /**
   * 该账号**不可用**的能力，逐条中文说明。
   *
   * 必须明确告知：否则用户会以为能配链式转发 / 能拿 API Key，
   * 试半天才发现平台压根不给（而 `/forward_endpoints` 实测直接 500）。
   */
  unavailable: string[];
  warnings: string[];
  error?: string;
}

// ─────────────────────────────────────────────────────────────
//  常量
// ─────────────────────────────────────────────────────────────

/** `traffic_total` 的单位。实测 4967037106 字节 ≈ 4.63 → total 100 是 GiB 不是 GB。 */
const GIB = 1024 ** 3;

// ─────────────────────────────────────────────────────────────
//  体检
// ─────────────────────────────────────────────────────────────

/** 本次体检的输入。provider 已选定、客户端已构造好，两者都由 `ix.ts` 备齐。 */
export interface IxProbeInput {
  provider: IxProvider;
  client: IxPlatformClient;
  providers: IxProviderRepo;
  logger: Logger;
  /** 由调用方取一次时钟往下传（core 与纯逻辑一律不自己看时钟）。 */
  now: number;
  /** provider 解析阶段产生的提示（例如多 provider 的 tie-break 说明），原样带出。 */
  warnings: string[];
}

export async function runProbe(input: IxProbeInput): Promise<IxProbeResult> {
  const { provider, client, providers, logger, now, warnings } = input;
  const base = { providerId: provider.id, name: provider.name };

  try {
    // 两个端点互不依赖，并发拉 —— 但只有两个请求，不会给平台造成压力
    const [info, details] = await Promise.all([client.subscriptionInfo(), client.lineDetails()]);

    const lines = buildProbeLines(info.lines ?? [], details);
    const result: IxProbeResult = {
      ok: true,
      ...base,
      username: info.username,
      isAdmin: info.is_admin === true,
      lines,
      trafficUsedBytes: info.traffic_used,
      // GiB → 字节。两个字段单位不同，不换算就会算出荒谬的剩余量
      trafficTotalBytes: typeof info.traffic_total === 'number' ? info.traffic_total * GIB : undefined,
      validUntil: info.valid_until,
      expired: info.is_expired === true,
      unavailable: describeUnavailable(info),
      warnings,
    };

    // 快照存的是**已统一单位**的版本，字段名自带单位 ——
    // 存原文会让下一个读它的人重新踩一遍"字节减 GiB"那个坑。
    // 只做单位换算，不做任何推导（不编造"预计还能用多久"这类数据）。
    providers.update(
      provider.id,
      {
        quotaJson: JSON.stringify({
          probedAt: now,
          username: result.username ?? null,
          isAdmin: result.isAdmin ?? false,
          validUntil: result.validUntil ?? null,
          expired: result.expired ?? false,
          trafficUsedBytes: result.trafficUsedBytes ?? null,
          trafficTotalBytes: result.trafficTotalBytes ?? null,
          unavailable: result.unavailable,
          lines,
        }),
        lastProbeAt: now,
        lastError: null,
      },
      now,
    );

    logger.info('IX：连接测试通过', {
      providerRef: providerRef(provider.id),
      lines: lines.length,
      isAdmin: result.isAdmin,
    });
    return result;
  } catch (err) {
    const message = describeError(err);
    providers.update(provider.id, { lastProbeAt: now, lastError: message }, now);
    logger.warn('IX：连接测试失败', {
      providerRef: providerRef(provider.id),
      reason: message,
    });
    return { ok: false, ...base, lines: [], unavailable: [], warnings, error: message };
  }
}

// ─────────────────────────────────────────────────────────────
//  结果组装
// ─────────────────────────────────────────────────────────────

function buildProbeLines(
  lines: readonly IxSubscriptionLine[],
  details: readonly IxLineDetail[],
): IxProbeLine[] {
  return lines.map((line) => {
    const detail = details.find((candidate) => candidate.line_id === line.id);
    return {
      lineId: line.id,
      name: line.display_name || String(line.id),
      entryHost: line.ip_addr,
      portStart: line.port_start,
      portEnd: line.port_end,
      maxPorts: line.max_ports_number,
      usedPorts: detail?.port_count ?? null,
      online: line.is_online === true,
      suspended: line.is_suspended === true,
    };
  });
}

/**
 * 把"这个账号做不到什么"写清楚。
 *
 * 不写的话用户会照着平台文档去配链式转发/入站代理，试半天才发现权限不给
 * （而 `/forward_endpoints` 实测直接 500，报错信息毫无指向性）。
 */
function describeUnavailable(info: IxSubscriptionInfo): string[] {
  const out: string[] = [];
  if (info.allow_forward_endpoint === false) {
    out.push(
      '账号不允许自定义转发出口（allow_forward_endpoint=false）：relay / chain / tot 转发一概不可用，' +
        '只能走 direct 直接转发。',
    );
  }
  if (info.is_admin === false) {
    out.push(
      '账号不是管理员（is_admin=false）：拿不到长期 API Key（该端点对非管理员返回 404），' +
        '只能用账号密码登录，JWT 7 天到期后自动重登。',
    );
  }
  for (const line of info.lines ?? []) {
    const name = line.display_name || String(line.id);
    if (line.allow_forward === false) {
      out.push(`线路「${name}」不允许二级转发（allow_forward=false）：不能把它当链式中转的中间跳。`);
    }
    if (line.allow_inbound_proxy === false) {
      out.push(`线路「${name}」不支持入站代理（allow_inbound_proxy=false）：只能做 L4 端口转发。`);
    }
  }
  return out;
}
