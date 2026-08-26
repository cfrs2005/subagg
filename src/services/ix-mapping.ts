/**
 * IX 编排层的底座：**平台端口对象 → 本地映射行**的纯翻译，加上编排层对平台
 * 客户端的最小契约与两个跨文件共用的格式化原子。
 *
 * 定位：`ix.ts` / `ix-probe.ts` / `ix-ensure.ts` 三个文件共同的下层。依赖方向
 * 单向朝下（那三个 import 本文件，本文件不 import 它们中的任何一个）——
 * 放在这里的判据只有一条：**被其中至少两个用到**。只有一个地方用的东西留在原处，
 * 免得这里退化成一个什么都往里塞的杂物间。
 *
 * 零 IO：不发请求、不碰 DB、不看时钟（要时间就当参数传）。
 */

import type { IxMappingPatch } from '../db/repo/ix.js';
// `IxCreatePortInput` 是客户端的入参形状（camelCase 包在线缆 body 外面），
// 所以它住在 ix-client.ts 而不是 ix-protocol.ts。
import type { IxCreatePortInput } from './ix-client.js';
import type {
  IxLineDetail,
  IxMutationResult,
  IxPort,
  IxSubscriptionInfo,
} from './ix-protocol.js';

// ─────────────────────────────────────────────────────────────
//  平台客户端契约
// ─────────────────────────────────────────────────────────────

/**
 * 本服务真正用到的客户端能力。
 *
 * 刻意只列这六个方法而不是直接依赖 `IxClient` 类：测试用鸭子类型替身即可
 * （仿 `test/node-ping-service.test.ts` 的 `as unknown as NodeRepo`），
 * 而"这个编排层会往平台发哪些请求"在这里一目了然 —— 想加一个出站调用，
 * 得先在这个接口上写下来。
 */
export interface IxPlatformClient {
  subscriptionInfo(): Promise<IxSubscriptionInfo>;
  lineDetails(): Promise<IxLineDetail[]>;
  listAllPorts(): Promise<IxPort[]>;
  findPortByTarget(target: string): Promise<IxPort | undefined>;
  createPort(input: IxCreatePortInput): Promise<IxMutationResult>;
  deletePort(id: number): Promise<IxMutationResult>;
}

// ─────────────────────────────────────────────────────────────
//  纯映射：平台端口 → 映射补丁
// ─────────────────────────────────────────────────────────────

/**
 * 平台端口 → 映射补丁。ensure 与 refresh 共用，免得两处各写一份、慢慢长歪。
 *
 * `suspended` 单独成列、不折进 `state`（理由见 `ix.ts` 的 `statusFor`）。
 * `sync_error_message` 也不改 `state`：那是平台把配置下发给转发节点时的错误，
 * 与"我们调 API 失败"不是一回事，混在一起会让 `last_error` 说不清是谁的问题。
 *
 * `entryUdp` 是这里唯一的"端口级 UDP 能力"写入点：平台回报什么就写什么，
 * 回报不了就写 `null`（未知）。**不许拿 `provider.enableUdp` 顶上**，
 * 理由见 `ix.ts` 的 `entriesFor`。
 */
export function mappingPatchFromPort(port: IxPort, now: number): IxMappingPatch {
  const entryHost = typeof port.ip_addr === 'string' && port.ip_addr !== '' ? port.ip_addr : null;
  const entryPort =
    typeof port.port_v4 === 'number' && Number.isInteger(port.port_v4) && port.port_v4 > 0
      ? port.port_v4
      : null;
  const ready = entryHost !== null && entryPort !== null;

  return {
    remotePortId: port.id,
    entryHost,
    entryPort,
    // 端口级 UDP 能力的事实来源。平台没回报这个字段就写 null（未知），
    // 而不是猜一个 —— 猜错的方向是"输出 UDP 黑洞的死节点"。
    entryUdp: typeof port.enable_udp === 'boolean' ? port.enable_udp : null,
    lineId: typeof port.outbound_endpoint_id === 'number' ? port.outbound_endpoint_id : null,
    lineName: typeof port.line_name === 'string' ? port.line_name : null,
    state: ready ? 'active' : 'pending',
    lastError: ready
      ? null
      : '平台还没给这个端口分配入口地址（ip_addr / port_v4 为空）。' +
        '下一步：稍后再跑一次 IX 状态同步；若一直如此，到平台上检查该端口。',
    suspended: port.is_suspended === true,
    syncError: typeof port.sync_error_message === 'string' ? port.sync_error_message : null,
    latencyUs: port.current_latency_summary?.avg_latency_us ?? null,
    lossRate: port.current_latency_summary?.packet_loss_rate ?? null,
    trafficIn: typeof port.traffic_in === 'number' ? port.traffic_in : null,
    trafficOut: typeof port.traffic_out === 'number' ? port.traffic_out : null,
    remoteSyncedAt: now,
  };
}

/** 目标地址的规范形态。认领比对与 `target_address_list` 必须用同一份拼法。 */
export function targetOf(host: string, port: number): string {
  return `${host}:${port}`;
}

// ─────────────────────────────────────────────────────────────
//  共用的格式化原子
// ─────────────────────────────────────────────────────────────

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** provider id 的短引用，用于日志与提示。id 是 UUID，不是凭据，可以记。 */
export function providerRef(id: string): string {
  return id.slice(0, 8);
}
