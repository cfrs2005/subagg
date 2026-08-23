/**
 * `Subscription-Userinfo` 响应头的解析、生成与聚合。
 *
 * 这是机场订阅事实上的流量上报标准（没有 RFC，是 Surge 带起来、大家跟着抄的）：
 *
 *     Subscription-Userinfo: upload=96701335; download=143028274;
 *                            total=161061273600; expire=1803225600
 *
 * 客户端读到这个头，就能在界面上画出流量条和到期时间。
 *
 * 对 subagg 来说，这个头有**双向**用途：
 *   - **读**：抓取上游订阅时解析它，得到每个订阅源的流量与到期信息（流量监控模块）
 *   - **写**：我们自己的 `/sub/:token` 也必须回这个头，否则用户在 Clash 里
 *     看到的流量条会是空的 —— 这是流量监控功能对外的最后一环
 *
 * 本文件属于 core 纯函数层：无 IO。
 */

import type { TrafficInfo } from './types.js';

/**
 * 解析 `Subscription-Userinfo` 头。
 *
 * 解析策略刻意宽容：
 *   - 分隔符可能是 `;` 也可能是 `; `，甚至有的机场用 `,`
 *   - 字段顺序不固定
 *   - `total` 与 `expire` 都可能缺失（不限量套餐 / 永久套餐）
 *   - 数值可能是浮点（少数机场会写 `upload=1.5e9`）
 *
 * 完全解析不出 upload/download 时返回 undefined —— 这两个字段缺失说明
 * 这根本不是一个有效的流量头，可能是机场返回了别的东西。
 */
export function parseUserinfo(header: string | undefined | null): TrafficInfo | undefined {
  if (!header) return undefined;

  const fields = new Map<string, number>();
  // 同时接受 `;` 与 `,` 作为分隔符
  for (const part of header.split(/[;,]/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const raw = part.slice(eq + 1).trim();
    if (raw.length === 0) continue;
    const value = Number(raw);
    // 负数与 NaN 一律丢弃：流量不可能为负，出现就说明上游数据有问题
    if (!Number.isFinite(value) || value < 0) continue;
    fields.set(key, value);
  }

  const upload = fields.get('upload');
  const download = fields.get('download');
  if (upload === undefined && download === undefined) return undefined;

  const info: TrafficInfo = {
    upload: upload ?? 0,
    download: download ?? 0,
  };

  const total = fields.get('total');
  // total=0 在实践中表示"不限量"而非"配额为零"，按缺失处理
  if (total !== undefined && total > 0) info.total = total;

  const expire = fields.get('expire');
  // 同理，expire=0 表示不过期
  if (expire !== undefined && expire > 0) info.expire = Math.floor(expire);

  return info;
}

/**
 * 生成 `Subscription-Userinfo` 头。
 *
 * 字段顺序固定为 upload / download / total / expire —— 虽然规范没有要求顺序，
 * 但个别客户端的解析实现是位置相关的，按主流顺序输出最安全。
 * 缺失的可选字段直接省略，而不是输出 `total=0`（含义不同）。
 */
export function formatUserinfo(info: TrafficInfo): string {
  const parts = [`upload=${Math.round(info.upload)}`, `download=${Math.round(info.download)}`];
  if (info.total !== undefined && info.total > 0) parts.push(`total=${Math.round(info.total)}`);
  if (info.expire !== undefined && info.expire > 0) parts.push(`expire=${Math.round(info.expire)}`);
  return parts.join('; ');
}

/**
 * 多个上游流量信息的聚合方式。
 *
 * 聚合多个订阅源后，"我还剩多少流量"这个问题不再有唯一答案，
 * 所以把选择权交给用户：
 *
 * - `sum`：各源相加，到期时间取最早的那个。适合"手里几个机场都是备用，
 *   关心的是总量"的场景。缺点是数字失去了对应关系——客户端里显示的
 *   总配额是个虚拟的合计值，与任何一家机场后台都对不上。
 * - `follow`：跟随指定的某一个订阅源。适合"有一个主力机场，其余是备用"的场景，
 *   客户端里看到的就是主力机场的真实数据。
 * - `off`：不输出该头。客户端里不显示流量条。
 */
export type UserinfoMode = 'sum' | 'off' | `follow:${string}`;

/**
 * 按指定方式聚合多个上游的流量信息。
 *
 * @param sources 各订阅源的流量信息。key 是订阅源 id，value 为 undefined 表示
 *   该源没有上报流量（很多免费订阅就是这样）。
 * @param mode 聚合方式
 * @returns 聚合结果；`off` 模式或无有效数据时返回 undefined，此时调用方应当
 *   **不输出**该响应头，而不是输出一个全零的头 —— 全零会让客户端显示
 *   "已用 0 / 总量 0"，比不显示更容易引起误解。
 */
export function aggregateUserinfo(
  sources: ReadonlyMap<string, TrafficInfo | undefined>,
  mode: UserinfoMode,
): TrafficInfo | undefined {
  if (mode === 'off') return undefined;

  if (mode.startsWith('follow:')) {
    const id = mode.slice('follow:'.length);
    return sources.get(id);
  }

  // ── sum ──────────────────────────────────────────────
  let upload = 0;
  let download = 0;
  let total = 0;
  let hasTotal = false;
  let hasAny = false;
  let earliestExpire: number | undefined;

  for (const info of sources.values()) {
    if (!info) continue;
    hasAny = true;
    upload += info.upload;
    download += info.download;

    if (info.total !== undefined) {
      total += info.total;
      hasTotal = true;
    }
    // 到期时间取最早：多个订阅里最先到期的那个决定了"什么时候会出问题"，
    // 取最晚会给出虚假的安全感。
    if (info.expire !== undefined) {
      earliestExpire =
        earliestExpire === undefined ? info.expire : Math.min(earliestExpire, info.expire);
    }
  }

  if (!hasAny) return undefined;

  const result: TrafficInfo = { upload, download };
  if (hasTotal) result.total = total;
  if (earliestExpire !== undefined) result.expire = earliestExpire;
  return result;
}

/** 已用流量（上传 + 下载）。 */
export function usedBytes(info: TrafficInfo): number {
  return info.upload + info.download;
}

/**
 * 剩余流量。不限量（无 total）时返回 undefined 而不是 Infinity ——
 * 调用方需要区分"剩余很多"和"没有配额概念"，前者要显示数字，后者要显示"不限量"。
 */
export function remainingBytes(info: TrafficInfo): number | undefined {
  if (info.total === undefined) return undefined;
  return Math.max(0, info.total - usedBytes(info));
}

/**
 * 已用百分比（0–100）。不限量时返回 undefined。
 *
 * 上限截断到 100：部分机场允许超额使用，此时已用会大于总量，
 * 而进度条画到 130% 只会让 UI 溢出。
 */
export function usagePercent(info: TrafficInfo): number | undefined {
  if (info.total === undefined || info.total <= 0) return undefined;
  return Math.min(100, (usedBytes(info) / info.total) * 100);
}
