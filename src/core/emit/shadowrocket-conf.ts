/**
 * Shadowrocket 完整配置文件（.conf）生成。
 *
 * ## 这个文件解决什么问题
 *
 * Shadowrocket 有两种消费订阅的方式：
 *
 * 1. **订阅**：只收节点（base64 URI 列表）。分流策略留在 App 本地的 conf 里，
 *    用户得手工维护 —— 这是"iOS 侧策略带不过来"的根源。
 * 2. **远程配置**：收一份完整 `.conf`，分组 / 规则 / DNS 都在里面。
 *    关键的是：conf 分组里写的**节点名**会解析到 App 里已添加订阅的节点上
 *    （用户的现网配置就是这么工作的：本地 conf + 订阅节点名引用）。
 *
 * 所以同一个 profile 可以同时喂两端：Clash.Meta 拿 YAML（编排直译），
 * Shadowrocket 除了加同一条订阅，再把我们生成的 conf 加为远程配置，
 * 分流策略就从"手工维护本地文件"变成"站点统一下发"。
 *
 * ## 翻译约定
 *
 * - 分组成员用**渲染期的真实节点名**（与 Clash 侧同一份 resolveOrchestration
 *   的输出）。机场改名后重新下载 conf 即可（[General] 里的 update-url 指回
 *   本配置，App 内"检查更新"一键拉新）。
 * - `MATCH` → `FINAL`；`RULE-SET` 用 provider 的原始 URL（Shadowrocket 原生
 *   支持远程规则集，不需要 Clash 那套 rule-providers 间接层）。
 * - DNS 反向翻译：`nameserver-policy` 的 `+.x` → `[Host] *.x = server:...`，
 *   静态 `hosts` → `[Host] domain = ip`。
 * - **不输出 [Proxy]**：节点由订阅提供。conf 只负责策略，避免两份节点凭据。
 *
 * 本文件属于 core 纯函数层：无 IO。
 */

import { resolveOrchestration, type Orchestration } from '../orchestrate.js';
import type { ProxyNode } from '../types.js';
import { partitionBySupport, type EmitResult } from './capability.js';

export interface ShadowrocketConfOptions {
  /** 自定义分流编排。缺省时输出一份最小可用 conf（PROXY + FINAL）。 */
  orchestration?: Orchestration;
  /** 本 conf 自己的 URL，写进 [General] update-url，供 App 内检查更新。 */
  confUrl?: string;
  /** 节点订阅 URL。仅在头部注释里提示，方便用户对照添加订阅。 */
  subUrl?: string;
}

/** conf 行里不能出现的字符：整个格式是逗号分隔的。 */
function safeToken(value: string): boolean {
  return value.length > 0 && !/[,\r\n]/.test(value);
}

/**
 * `#PROXY` 是 mihomo 的策略名写法；Shadowrocket 只有一个内置的 `#proxy`，
 * 意思是「用当前出口解析」。反向输出时换回去，否则 App 不认这个后缀。
 */
function toShadowrocketDns(server: string): string {
  const hash = server.indexOf('#');
  if (hash === -1) return server;

  const base = server.slice(0, hash);
  const via = server.slice(hash + 1);
  if (/^h3$/i.test(via)) return server;
  return `${base}#proxy`;
}

function formatGroup(name: string, type: string, members: readonly string[], options: readonly string[]): string {
  return [`${name} = ${type}`, ...members, ...options].join(',');
}

/**
 * 生成 Shadowrocket 远程配置。
 *
 * 不支持的节点照旧记入 `skipped` —— 分组里引用一个 App 加不进来的节点名
 * 与引用一个不存在的节点名同样糟糕，所以可用节点集合必须与订阅一致。
 */
export function emitShadowrocketConf(
  nodes: readonly ProxyNode[],
  options: ShadowrocketConfOptions = {},
): EmitResult {
  const { usable, skipped } = partitionBySupport(nodes, 'shadowrocket.conf');
  const warnings: string[] = [];

  const nodeNames = usable.map((node) => node.name);
  const cleanNames = nodeNames.filter((name) => {
    if (safeToken(name)) return true;
    warnings.push(`节点「${name}」的名字含逗号，无法写进 Shadowrocket 分组，已从分组中剔除`);
    return false;
  });

  const sections: string[] = [];
  const general: string[] = [];
  const groups: string[] = [];
  const rules: string[] = [];
  const hosts: string[] = [];

  if (options.confUrl) general.push(`update-url = ${options.confUrl}`);

  if (options.orchestration) {
    const resolved = resolveOrchestration(usable, options.orchestration);
    warnings.push(...resolved.warnings);

    // ── [Proxy Group] ────────────────────────────────
    //
    // Clash 侧为了"可手动切换"会把自动组包成 select + `<name>-AUTO`；
    // Shadowrocket 原生支持 url-test/fallback + policy-select-name，
    // 所以这里把包装形态还原回单组，保持与用户原 conf 一致。
    const groupByName = new Map(resolved.groups.map((group) => [group.name, group]));
    const consumed = new Set<string>();

    for (const group of resolved.groups) {
      if (consumed.has(group.name)) continue;

      if (group.type === 'select') {
        const autoRef = group.proxies.find((member) => {
          const candidate = groupByName.get(member);
          return (
            candidate !== undefined &&
            candidate.type !== 'select' &&
            member.startsWith(`${group.name}-AUTO`)
          );
        });
        const auto = autoRef ? groupByName.get(autoRef) : undefined;

        if (auto) {
          const members = group.proxies.filter((member) => member !== autoRef);
          const coversAll =
            members.length > 0 &&
            members.every((member) => member === 'DIRECT' || auto.proxies.includes(member));

          if (coversAll) {
            const groupOptions: string[] = [];
            // 首个成员就是解析器排好的首选节点。
            if (!groupByName.has(members[0] ?? '') && members[0] !== 'DIRECT') {
              groupOptions.push(`policy-select-name=${members[0]}`);
            }
            if (auto.url) groupOptions.push(`url=${auto.url}`);
            if (auto.interval !== undefined) groupOptions.push(`interval=${auto.interval}`);
            if (auto.tolerance !== undefined) groupOptions.push(`tolerance=${auto.tolerance}`);

            groups.push(formatGroup(group.name, auto.type, members, groupOptions));
            consumed.add(auto.name);
            continue;
          }
        }
      }

      const members = group.proxies.filter((member) => {
        if (safeToken(member)) return true;
        warnings.push(`分组「${group.name}」的成员「${member}」含逗号，已剔除`);
        return false;
      });
      if (members.length === 0) members.push('DIRECT');

      const groupOptions: string[] = [];
      if (group.type !== 'select') {
        if (group.url) groupOptions.push(`url=${group.url}`);
        if (group.interval !== undefined) groupOptions.push(`interval=${group.interval}`);
        if (group.tolerance !== undefined) groupOptions.push(`tolerance=${group.tolerance}`);
      }
      groups.push(formatGroup(group.name, group.type, members, groupOptions));
    }

    // ── [Rule] ───────────────────────────────────────
    // resolved.rules 是 Clash 语法字符串，这里反向翻译回 Shadowrocket。
    for (const line of resolved.rules) {
      const parts = line.split(',');
      const type = parts[0] ?? '';

      if (type === 'MATCH') {
        // FINAL 必须是 [Rule] 的最后一条 —— resolved 已经保证 MATCH 唯一且置尾。
        rules.push(`FINAL,${parts[1] ?? 'DIRECT'}`);
        continue;
      }

      if (type === 'RULE-SET') {
        const key = parts[1] ?? '';
        const policy = parts[2] ?? '';
        const provider = options.orchestration.providers?.[key];
        // resolveOrchestration 只输出被声明且被引用的 provider，所以这里
        // 理论上不会缺；真缺了就退化为跳过并说明，不让 conf 加载失败。
        if (provider?.url) {
          rules.push(`RULE-SET,${provider.url},${policy}`);
        } else {
          warnings.push(`规则 ${line} 找不到规则集 URL，已跳过`);
        }
        continue;
      }

      rules.push(line);
    }

    // ── DNS 反向翻译 ─────────────────────────────────
    const dns = options.orchestration.dns;
    if (dns?.nameserver?.length) {
      general.push(`dns-server = ${dns.nameserver.map(toShadowrocketDns).join(',')}`);
    }
    if (dns?.fallback?.length) {
      general.push(`fallback-dns-server = ${dns.fallback.map(toShadowrocketDns).join(',')}`);
    }
    for (const [domain, server] of Object.entries(dns?.nameserverPolicy ?? {})) {
      const value = Array.isArray(server) ? server[0] : server;
      if (!value) continue;
      const key = domain.startsWith('+.') ? `*.${domain.slice(2)}` : domain;
      hosts.push(`${key} = server:${value}`);
    }
    for (const [domain, address] of Object.entries(options.orchestration.hosts ?? {})) {
      hosts.push(`${domain} = ${address}`);
    }

    if (options.orchestration.ipv6 === false || dns?.ipv6 === false) {
      general.push('ipv6 = false');
      general.push('prefer-ipv6 = false');
    }
  } else {
    // 没有编排：最小可用 conf。分组仍然引用真实节点名，保证加上订阅即可用。
    groups.push(formatGroup('PROXY', 'select', cleanNames.length ? cleanNames : ['DIRECT'], []));
    rules.push('GEOIP,CN,DIRECT', 'FINAL,PROXY');
  }

  if (general.length) sections.push(`[General]\n${general.join('\n')}`);
  if (groups.length) sections.push(`[Proxy Group]\n${groups.join('\n')}`);
  if (rules.length) sections.push(`[Rule]\n${rules.join('\n')}`);
  if (hosts.length) sections.push(`[Host]\n${hosts.join('\n')}`);

  const header = [
    '# 由 subagg 生成的 Shadowrocket 远程配置。',
    '# 用法：App 内先添加节点订阅，再把本 URL 添加为「远程配置」。',
    ...(options.subUrl ? [`# 节点订阅：${options.subUrl}`] : []),
  ].join('\n');

  const body = `${header}\n\n${sections.join('\n\n')}\n`;

  const result: EmitResult = {
    body,
    contentType: 'text/plain; charset=utf-8',
    nodeCount: usable.length,
    skipped,
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}
