/**
 * Clash 分流编排：把「分组 + 规则」从写死的模板变成可声明的配置。
 *
 * ## 这个文件解决什么问题
 *
 * `clash.ts` 里的 `buildGroups()` / `buildRules()` 是通用模板，节点一多就不够用：
 * 想给 AI 单独选路、想让公司内网直连、想按名字把某几台落地机固定到 fallback，
 * 都只能改代码。
 *
 * 但直接让用户写 YAML 也不行。机场订阅每 12 小时刷新一次，节点名随时会变；
 * 一旦分组里硬编码了 `DMIT-VIA-US-LOS-CG` 这种名字，某天节点改名，整份配置
 * 会加载失败 —— 不是丢一个节点，是整份订阅都用不了。
 *
 * 所以这里把「编排」定义成**声明式选择器**：分组里写"名字匹配 `DMIT-` 的节点，
 * 优先 `DMIT-VIA-US-LOS-CG`"，渲染时才解析成真实节点名。选择器可以匹配
 * 名称 / 来源 / 地区 / 协议 / 指纹，组还可以引用组。
 *
 * ## 解析阶段必须守住的不变量
 *
 * 1. **分组不能为空。** Clash 对空 `proxies` 的分组会拒绝加载整份配置。
 * 2. **规则不能引用不存在的组。** 悬空引用同样导致加载失败或流量异常。
 * 3. **规则里引用的 `rule-providers` 必须真的被输出。**
 * 4. **`MATCH` 必须且只能出现在最后一条。**
 *
 * 任何一条被违反时，我们**丢弃有问题的部分并给出警告**，而不是让整份配置失败。
 * 一个分组坏了不该把用户全部节点一起拖下水。
 *
 * 本文件属于 core 纯函数层：无 IO。
 */

import { compileUserRegex } from './filter.js';
import type { ProxyNode, ProxyType } from './types.js';

// ─────────────────────────────────────────────────────────────
//  模型
// ─────────────────────────────────────────────────────────────

export type OrchestrationGroupType = 'select' | 'url-test' | 'fallback' | 'load-balance';

/**
 * 节点选择器。所有已给出的条件之间是 **AND**；
 * 一个条件都不给表示"全部节点"。
 */
export interface OrchestrationSelector {
  /** 匹配节点显示名（重命名之后的名字）。 */
  nameRegex?: string;
  /** 命中即排除，优先级高于其他条件。 */
  excludeNameRegex?: string;
  /** 订阅源 id 或显示名。 */
  source?: string[];
  /** ISO 3166-1 alpha-2 地区码。 */
  region?: string[];
  type?: ProxyType[];
  /** 节点指纹。与其它条件是 AND，用于精确固定某几个节点。 */
  pick?: string[];
}

/**
 * 分组成员：引用分组、按选择器取节点，或直接放内置策略（DIRECT / REJECT）。
 * 最后一种在 Clash 分组里很常见（"直连"作为手动组的备选项）。
 */
export type OrchestrationMember =
  | { kind: 'group'; name: string }
  | { kind: 'nodes'; select: OrchestrationSelector }
  | { kind: 'policy'; name: 'DIRECT' | 'REJECT' };

export interface OrchestrationGroup {
  name: string;
  type: OrchestrationGroupType;
  members: OrchestrationMember[];
  /**
   * 首选节点名，按顺序提前。支持精确名，也支持 `/正则/` 或裸正则。
   *
   * `fallback` 用顺序表达偏好；`url-test` 本身没有"首选"概念，
   * 想要"优先某台、挂了再自动"必须外层套一个 select。
   */
  preferred?: string[];
  /** `url-test` / `fallback` / `load-balance` 的测速地址。 */
  url?: string;
  interval?: number;
  tolerance?: number;
  /** 解析后为空时的处理：drop（默认）或退化为 DIRECT。 */
  onEmpty?: 'drop' | 'direct';
}

export type OrchestrationRuleType =
  | 'DOMAIN'
  | 'DOMAIN-SUFFIX'
  | 'DOMAIN-KEYWORD'
  | 'DOMAIN-REGEX'
  | 'IP-CIDR'
  | 'IP-CIDR6'
  | 'GEOIP'
  | 'GEOSITE'
  | 'RULE-SET'
  | 'MATCH';

export interface OrchestrationRule {
  type: OrchestrationRuleType;
  /** `MATCH` 不需要值；其余类型必填。 */
  value?: string;
  /** `DIRECT` / `REJECT` / 组名 / 节点名。 */
  policy: string;
  /** `IP-CIDR` 类规则是否禁止触发 DNS 解析。 */
  noResolve?: boolean;
}

export interface OrchestrationProvider {
  url: string;
  behavior: 'domain' | 'ipcidr' | 'classical';
  interval?: number;
  /** mihomo 支持的格式。默认 text。 */
  format?: 'text' | 'yaml' | 'mrs';
}

export interface OrchestrationDns {
  enable?: boolean;
  ipv6?: boolean;
  enhancedMode?: 'fake-ip' | 'redir-host';
  nameserver?: string[];
  fallback?: string[];
  proxyServerNameserver?: string[];
  /** 键如 `+.feishu.cn`，值可以是单个服务器或列表。 */
  nameserverPolicy?: Record<string, string | string[]>;
  fakeIpFilter?: string[];
}

export interface Orchestration {
  groups: OrchestrationGroup[];
  rules: OrchestrationRule[];
  providers?: Record<string, OrchestrationProvider>;
  dns?: OrchestrationDns;
  /** 静态域名映射，直接写进 Clash 的顶层 `hosts:`。 */
  hosts?: Record<string, string>;
  /** 顶层 IPv6 开关。与 dns.ipv6 分开是因为 Clash 有两个独立字段。 */
  ipv6?: boolean;
}

// ─────────────────────────────────────────────────────────────
//  解析结果
// ─────────────────────────────────────────────────────────────

export interface ResolvedGroup {
  name: string;
  type: OrchestrationGroupType;
  proxies: string[];
  url?: string;
  interval?: number;
  tolerance?: number;
}

export interface ResolvedProvider {
  type: 'http';
  behavior: 'domain' | 'ipcidr' | 'classical';
  url: string;
  path: string;
  interval: number;
  /**
   * **必须显式输出。** mihomo 不写 `format` 时按 `yaml` 解析，而订阅里
   * 绝大多数规则集是纯文本 —— 解析失败不会报错，只会得到一个空集。
   * 实测：同一份 `DOMAIN-SUFFIX,openai.com` 文本，加 `format: text` 才命中，
   * 不加就一路走到 `MATCH`。这条配置错了没人会发现，除了"某个网站不通"。
   */
  format: 'text' | 'yaml' | 'mrs';
  /** 下载规则集时使用的出口。中转到自己域名时用 DIRECT，避免与规则本身互锁。 */
  proxy?: string;
}

export interface ResolvedOrchestration {
  groups: ResolvedGroup[];
  rules: string[];
  providers: Record<string, ResolvedProvider>;
  dns?: Record<string, unknown>;
  hosts?: Record<string, string>;
  ipv6?: boolean;
  /** 兜底策略名，供调用方在没有 MATCH 时使用。 */
  defaultPolicy: string;
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────
//  常量
// ─────────────────────────────────────────────────────────────

/**
 * Clash 的内置策略名。分组不能叫这些名字 —— 重名会让规则无法表达
 * "我要的是那个组"还是"内置动作"，客户端的行为也不一致。
 */
const RESERVED_POLICIES: ReadonlySet<string> = new Set([
  'DIRECT',
  'REJECT',
  'REJECT-DROP',
  'PASS',
  'COMPATIBLE',
  'GLOBAL',
]);

const MAX_GROUP_NAME = 64;
const MAX_GROUPS = 64;
const MAX_RULES = 1000;
const RULE_TYPES: ReadonlySet<string> = new Set<OrchestrationRuleType>([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-REGEX',
  'IP-CIDR',
  'IP-CIDR6',
  'GEOIP',
  'GEOSITE',
  'RULE-SET',
  'MATCH',
]);

const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204';

// ─────────────────────────────────────────────────────────────
//  选择器
// ─────────────────────────────────────────────────────────────

interface CompiledSelector {
  selector: OrchestrationSelector;
  include?: RegExp;
  exclude?: RegExp;
}

function compileSelector(
  selector: OrchestrationSelector,
  owner: string,
  warnings: string[],
): CompiledSelector {
  const compiled: CompiledSelector = { selector };

  if (selector.nameRegex) {
    if (typeof selector.nameRegex !== 'string') {
      warnings.push(`分组「${owner}」的 nameRegex 不是字符串，已忽略`);
    } else {
      const result = compileUserRegex(selector.nameRegex);
      if ('error' in result) {
        warnings.push(`分组「${owner}」的 nameRegex 被忽略：${result.error}`);
      } else {
        compiled.include = result.re;
      }
    }
  }
  if (selector.excludeNameRegex) {
    if (typeof selector.excludeNameRegex !== 'string') {
      warnings.push(`分组「${owner}」的 excludeNameRegex 不是字符串，已忽略`);
    } else {
      const result = compileUserRegex(selector.excludeNameRegex);
      if ('error' in result) {
        warnings.push(`分组「${owner}」的 excludeNameRegex 被忽略：${result.error}`);
      } else {
        compiled.exclude = result.re;
      }
    }
  }

  return compiled;
}

function matchesSelector(node: ProxyNode, compiled: CompiledSelector): boolean {
  const { selector } = compiled;

  if (compiled.exclude?.test(node.name)) return false;
  if (compiled.include && !compiled.include.test(node.name)) return false;

  const pick = Array.isArray(selector.pick) ? selector.pick : [];
  if (pick.length && !pick.includes(node.fingerprint)) return false;

  const sources = Array.isArray(selector.source) ? selector.source : [];
  if (sources.length) {
    const wanted = sources.map((value) => value.toLowerCase());
    const sourceId = node.meta.sourceId.toLowerCase();
    const sourceName = node.meta.sourceName.toLowerCase();
    if (!wanted.includes(sourceId) && !wanted.includes(sourceName)) return false;
  }

  const regions = Array.isArray(selector.region) ? selector.region : [];
  if (regions.length) {
    const region = (node.meta.region ?? '').toUpperCase();
    if (!regions.some((value) => value.toUpperCase() === region)) return false;
  }

  const types = Array.isArray(selector.type) ? selector.type : [];
  if (types.length && !types.includes(node.type)) return false;

  return true;
}

/**
 * 把一个"首选"条目放到匹配节点前面。
 *
 * 先按精确名匹配；没有再当正则。用户从 Shadowrocket 里抄过来的名字
 * 常常带 `[M][TROJAN]` 这类方括号，直接当正则会立刻语法错误 ——
 * 所以精确名优先，正则只是补充。
 */
function applyPreferred(
  names: string[],
  preferred: readonly string[] | undefined,
  owner: string,
  warnings: string[],
): string[] {
  if (!Array.isArray(preferred) || preferred.length === 0 || names.length === 0) return names;

  const ordered: string[] = [];
  const taken = new Set<string>();

  for (const entry of preferred) {
    if (typeof entry !== 'string' || !entry) continue;
    const exact = names.find((name) => name === entry);
    if (exact && !taken.has(exact)) {
      ordered.push(exact);
      taken.add(exact);
      continue;
    }

    const pattern = entry.startsWith('/') && entry.endsWith('/') ? entry.slice(1, -1) : entry;
    const result = compileUserRegex(pattern);
    if ('error' in result) {
      warnings.push(`分组「${owner}」的首选「${entry}」被忽略：${result.error}`);
      continue;
    }
    for (const name of names) {
      if (!taken.has(name) && result.re.test(name)) {
        ordered.push(name);
        taken.add(name);
      }
    }
  }

  for (const name of names) {
    if (!taken.has(name)) ordered.push(name);
  }

  return ordered;
}

// ─────────────────────────────────────────────────────────────
//  分组
// ─────────────────────────────────────────────────────────────

interface WorkingGroup extends ResolvedGroup {
  /** 原始成员顺序：节点名与组引用混在一起，后面统一做丢弃与去环。 */
  members: string[];
  onEmpty?: 'drop' | 'direct';
}

function resolveGroupMembers(
  group: OrchestrationGroup,
  nodes: readonly ProxyNode[],
  warnings: string[],
): string[] {
  const members: string[] = [];
  const rawMembers = Array.isArray(group.members) ? group.members : [];

  for (const member of rawMembers) {
    if (!member || typeof member !== 'object') continue;

    if (member.kind === 'group') {
      const name = typeof member.name === 'string' ? member.name.trim() : '';
      // 自引用一定是写错了，直接丢掉；循环引用在 breakCycles 里统一处理。
      if (name && name !== group.name) members.push(name);
      continue;
    }

    if (member.kind === 'policy') {
      if (member.name === 'DIRECT' || member.name === 'REJECT') members.push(member.name);
      continue;
    }

    if (member.kind !== 'nodes') continue;

    const compiled = compileSelector(member.select ?? {}, group.name, warnings);
    const selected = nodes.filter((node) => matchesSelector(node, compiled)).map((node) => node.name);
    members.push(...selected);
  }

  return members;
}

function buildWorkingGroups(
  spec: Orchestration,
  nodes: readonly ProxyNode[],
  warnings: string[],
): WorkingGroup[] {
  const groups: WorkingGroup[] = [];
  const seen = new Set<string>();
  const nodeNames = new Set(nodes.map((node) => node.name));
  const declaredGroups = Array.isArray(spec.groups) ? spec.groups : [];

  if (declaredGroups.length > MAX_GROUPS) {
    warnings.push(`分组数量超过上限 ${MAX_GROUPS}，多出的 ${declaredGroups.length - MAX_GROUPS} 个已忽略`);
  }

  for (const group of declaredGroups.slice(0, MAX_GROUPS)) {
    if (!group || typeof group !== 'object') {
      warnings.push('有一个分组不是对象，已跳过');
      continue;
    }
    const name = typeof group.name === 'string' ? group.name.trim() : '';
    if (!name) {
      warnings.push('有一个分组没有名字，已跳过');
      continue;
    }
    if (name.length > MAX_GROUP_NAME || /[,\r\n]/.test(name)) {
      warnings.push(`分组名「${name}」不合法（超长或含逗号/换行），已跳过`);
      continue;
    }
    if (RESERVED_POLICIES.has(name.toUpperCase())) {
      warnings.push(`分组名「${name}」与 Clash 内置策略重名，已跳过`);
      continue;
    }
    if (nodeNames.has(name)) {
      // 节点与分组同名时，规则里的名字指向谁是模糊的，客户端行为也不一致。
      warnings.push(`分组名「${name}」与某个节点重名，Clash 无法区分，已跳过该分组`);
      continue;
    }
    if (seen.has(name)) {
      warnings.push(`分组「${name}」重复定义，后一个已忽略`);
      continue;
    }
    seen.add(name);

    const type = group.type;
    if (!['select', 'url-test', 'fallback', 'load-balance'].includes(type)) {
      warnings.push(`分组「${name}」的类型「${String(type)}」不受支持，已跳过`);
      continue;
    }

    const members = applyPreferred(
      resolveGroupMembers(group, nodes, warnings),
      group.preferred,
      name,
      warnings,
    );

    const resolved: WorkingGroup = {
      name,
      type,
      proxies: [],
      members,
      url: typeof group.url === 'string' && group.url.trim() ? group.url.trim() : DEFAULT_TEST_URL,
      interval: clampInt(group.interval, 60, 86_400, 300),
      tolerance: clampInt(group.tolerance, 0, 10_000, 50),
    };
    if (group.onEmpty === 'direct') {
      resolved.onEmpty = 'direct';
      if (members.length === 0) resolved.members = ['DIRECT'];
    }
    groups.push(resolved);
  }

  return groups;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * 反复丢弃"只剩下已丢弃引用"的分组，直到稳定。
 *
 * 这个循环是必需的：A 引用 B、B 引用 C，C 因为选择器没命中而被丢掉，
 * 那么 B 和 A 也必须跟着丢 —— 一次遍历处理不干净。
 */
function pruneGroups(
  groups: WorkingGroup[],
  nodeNames: ReadonlySet<string>,
  warnings: string[],
): WorkingGroup[] {
  const alive = new Map(groups.map((group) => [group.name, group]));

  let changed = true;
  while (changed) {
    changed = false;
    for (const group of [...alive.values()]) {
      // 成员有两种：真实节点名与分组引用。节点名永远有效（它们来自本次
      // 渲染的节点列表），分组引用只有在被引用的分组仍然存活时才保留。
      const proxies = [
        ...new Set(
          group.members.filter(
            (member) => member === 'DIRECT' || nodeNames.has(member) || alive.has(member),
          ),
        ),
      ];
      group.proxies = proxies;

      if (proxies.length > 0) continue;

      // 显式声明了 onEmpty=direct 的分组退化成直连，而不是消失。
      // 这在"A 引用 B、B 也空了"的链式丢弃里同样要生效，所以放在循环内。
      if (group.onEmpty === 'direct') {
        group.members = ['DIRECT'];
        group.proxies = ['DIRECT'];
        continue;
      }

      alive.delete(group.name);
      changed = true;
      warnings.push(
        `分组「${group.name}」解析后没有可用成员，已跳过；引用它的规则也会被丢弃`,
      );
    }
  }

  return [...alive.values()];
}

/**
 * 移除形成环的分组引用。
 *
 * Clash 不允许分组循环引用。用户的编排完全可能写错（A ⊃ B ⊃ A），
 * 与其让客户端报一个看不懂的错误，不如我们在这里断开并说清楚。
 */
function breakCycles(groups: WorkingGroup[], warnings: string[]): WorkingGroup[] {
  const byName = new Map(groups.map((group) => [group.name, group]));
  const state = new Map<string, 1 | 2>();

  const visit = (name: string): void => {
    const group = byName.get(name);
    if (!group) return;
    if (state.get(name) === 2) return;
    state.set(name, 1);

    for (const ref of [...group.proxies]) {
      if (!byName.has(ref)) continue;
      if (state.get(ref) === 1) {
        group.proxies = group.proxies.filter((member) => member !== ref);
        group.members = group.members.filter((member) => member !== ref);
        warnings.push(`分组「${group.name}」与「${ref}」形成循环引用，已断开后者`);
        continue;
      }
      visit(ref);
    }

    state.set(name, 2);
  };

  for (const group of groups) visit(group.name);
  return groups;
}

// ─────────────────────────────────────────────────────────────
//  规则
// ─────────────────────────────────────────────────────────────

interface WorkingRule {
  type: OrchestrationRuleType;
  value: string;
  policy: string;
  noResolve: boolean;
}

function normalizeRule(
  rule: OrchestrationRule,
  warnings: string[],
): WorkingRule | undefined {
  if (!rule || typeof rule !== 'object') {
    warnings.push('有一条规则不是对象，已跳过');
    return undefined;
  }

  const type = String(rule.type ?? '').toUpperCase() as OrchestrationRuleType;
  if (!RULE_TYPES.has(type)) {
    warnings.push(`规则类型「${String(rule.type)}」不受支持，已跳过`);
    return undefined;
  }

  const rawValue = typeof rule.value === 'string' ? rule.value.trim() : '';
  const policy = typeof rule.policy === 'string' ? rule.policy.trim() : '';

  if (type !== 'MATCH') {
    if (!rawValue) {
      warnings.push(`规则 ${type} 缺少值，已跳过`);
      return undefined;
    }
    if (/[,\r\n]/.test(rawValue)) {
      warnings.push(`规则 ${type} 的值「${rawValue}」含有逗号，Clash 无法表达，已跳过`);
      return undefined;
    }
  }

  if (!policy) {
    warnings.push(`规则 ${type}${rawValue ? `,${rawValue}` : ''} 缺少策略，已跳过`);
    return undefined;
  }
  if (/[,\r\n]/.test(policy)) {
    warnings.push(`规则 ${type} 的策略「${policy}」含有逗号或换行，已跳过`);
    return undefined;
  }

  return { type, value: rawValue, policy, noResolve: rule.noResolve === true };
}

function formatRule(rule: WorkingRule): string {
  if (rule.type === 'MATCH') return `MATCH,${rule.policy}`;
  return `${rule.type},${rule.value},${rule.policy}${rule.noResolve ? ',no-resolve' : ''}`;
}

// ─────────────────────────────────────────────────────────────
//  rule-providers
// ─────────────────────────────────────────────────────────────

function safeProviderKey(key: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(key);
}

function providerPath(key: string, format: 'text' | 'yaml' | 'mrs'): string {
  const ext = format === 'mrs' ? 'mrs' : format === 'yaml' ? 'yaml' : 'txt';
  return `./rules/${key}.${ext}`;
}

function buildProviders(
  referenced: ReadonlySet<string>,
  declared: Readonly<Record<string, OrchestrationProvider>> | undefined,
  warnings: string[],
): Record<string, ResolvedProvider> {
  const out: Record<string, ResolvedProvider> = {};
  if (!declared || typeof declared !== 'object') return out;

  for (const key of [...referenced].sort()) {
    const provider = declared[key];
    if (!provider || typeof provider !== 'object') continue;

    if (!safeProviderKey(key)) {
      warnings.push(`rule-provider 名称「${key}」不合法（只允许字母数字和 . _ -），相关规则已跳过`);
      continue;
    }

    const url = typeof provider.url === 'string' ? provider.url.trim() : '';
    if (!/^https?:\/\//i.test(url)) {
      warnings.push(`rule-provider「${key}」的 URL 不是 http(s)，相关规则已跳过`);
      continue;
    }

    const behavior = provider.behavior;
    if (!['domain', 'ipcidr', 'classical'].includes(behavior)) {
      warnings.push(`rule-provider「${key}」的 behavior「${String(behavior)}」不合法，相关规则已跳过`);
      continue;
    }

    // 缺省补 `text`：不写 format 时 mihomo 按 yaml 解析纯文本规则集，
    // 结果是静默空集（已用 mihomo 1.19.25 实测确认）。
    const format = provider.format ?? 'text';
    const resolved: ResolvedProvider = {
      type: 'http',
      behavior,
      url,
      path: providerPath(key, format),
      interval: clampInt(provider.interval, 60, 604_800, 86_400),
      format,
    };
    out[key] = resolved;
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
//  DNS
// ─────────────────────────────────────────────────────────────

function cleanServers(value: string[] | undefined): string[] {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((server) => String(server).trim())
    .filter((server) => server.length > 0)
    .slice(0, 20);
}

/**
 * bootstrap DNS：纯 IP，用来解析加密 DNS 服务器自己。
 *
 * 节点域名也可能落在这里（`proxy-server-nameserver`）—— 机场域名如果被
 * 自己的代理规则接管，就是死循环，所以必须有一条不经代理的解析通道。
 */
const BOOTSTRAP_DNS: readonly string[] = ['223.5.5.5', '119.29.29.29'];

/** 加密 DNS 服务器几乎总是用域名寻址（`https://dns.google/...`），而不是裸 IP。 */
function isHostnameBased(server: string): boolean {
  const bare = server.split('#')[0] ?? '';
  const withoutScheme = bare.replace(/^[a-z0-9+.-]+:\/\//i, '');
  const host = withoutScheme.split('/')[0]?.replace(/:\d+$/, '') ?? '';
  if (!host) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return !host.includes(':');
}

/**
 * 解析 `服务器#出口` 里的出口后缀。
 *
 * Shadowrocket 写 `dns-server = https://dns.google/dns-query#proxy`，意思是
 * 「解析请求本身走代理」—— 不带 `#proxy` 的 DoH 在国内网络里会被劫持。
 * mihomo 的原生写法是 `#策略名`（`...dns-query#PROXY`），**不是无法表达**。
 *
 * 但策略名必须真实存在，否则客户端会拒载整份配置。所以这里统一校验：
 * 存在于本次渲染的分组里就保留，否则剥掉后缀（退回直连解析）并告警。
 */
function resolveServers(
  value: string[] | undefined,
  context: { groups: ReadonlySet<string>; warnings: string[] },
): string[] {
  const out: string[] = [];

  for (const raw of cleanServers(value)) {
    const hash = raw.indexOf('#');
    if (hash === -1) {
      out.push(raw);
      continue;
    }

    const server = raw.slice(0, hash).trim();
    const via = raw.slice(hash + 1).trim();
    if (!server) continue;
    if (!via) {
      out.push(server);
      continue;
    }

    // `#h3` 是 DoH 的 HTTP/3 开关，与策略名是同一个语法位置，不能当成未知策略。
    const builtin = /^(direct|reject|pass|h3)$/i.test(via);
    if (builtin || context.groups.has(via)) {
      out.push(`${server}#${via}`);
      continue;
    }

    context.warnings.push(`DNS 服务器「${server}」指定的出口「${via}」不存在，已改为直连解析`);
    out.push(server);
  }

  return out;
}

/**
 * 静态域名映射。
 *
 * Clash 的 `hosts:` 与 Shadowrocket 的 `[Host]` 语义一致：解析这些域名时
 * 直接返回给定地址，不走 DNS。最典型的用途是把 DoH 服务器域名固定到
 * 已知 IP —— 否则\"解析 DoH 服务器本身\"又会退回系统 DNS，形成死循环。
 */
function buildHosts(hosts: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!hosts || typeof hosts !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(hosts ?? {})) {
    if (typeof value !== 'string') continue;
    const domain = key.trim();
    const address = value.trim();
    if (!domain || /[,\r\n]/.test(domain)) continue;
    if (!address || /[,\r\n]/.test(address)) continue;
    out[domain] = address;
    if (Object.keys(out).length >= 200) break;
  }
  return Object.keys(out).length ? out : undefined;
}

function buildDns(
  dns: OrchestrationDns | undefined,
  context: {
    groups: ReadonlySet<string>;
    /**
     * 显式标了 DIRECT 的域名。它们必须进 `fake-ip-filter`，否则 fake-ip 模式下
     * 域名会被分到 `198.18.x.x`，直连出去系统不认识这个地址 —— 表现就是
     * 「公司内网域名打不开」，而规则看起来是对的。
     */
    directDomains: readonly string[];
    warnings: string[];
  },
): Record<string, unknown> | undefined {
  if (!dns || dns.enable === false) return undefined;

  const nameserver = resolveServers(dns.nameserver, context);
  if (nameserver.length === 0) return undefined;

  const out: Record<string, unknown> = {
    enable: true,
    nameserver,
  };

  if (dns.ipv6 !== undefined) out['ipv6'] = dns.ipv6;
  if (dns.enhancedMode) out['enhanced-mode'] = dns.enhancedMode;

  // 加密 DNS 服务器自己是域名（dns.google / cloudflare-dns.com），
  // 解析它们需要一个纯 IP 的 bootstrap DNS，否则启动就是死锁。
  // 以前这份配置能跑，纯粹是因为 `hosts:` 里恰好固定了这几个域名。
  if (nameserver.some(isHostnameBased)) {
    out['default-nameserver'] = [...BOOTSTRAP_DNS];
  }

  const fallback = resolveServers(dns.fallback, context);
  if (fallback.length) out['fallback'] = fallback;

  const explicitProxyDns = resolveServers(dns.proxyServerNameserver, context);
  // 节点域名必须走不经代理的解析通道，否则「解析节点域名 → 走代理 → 需要先解析节点域名」
  // 就是死循环。显式给了就用给的，没给就用 bootstrap。
  out['proxy-server-nameserver'] = explicitProxyDns.length
    ? explicitProxyDns
    : [...BOOTSTRAP_DNS];

  const policy: Record<string, string | string[]> = {};
  const policySource =
    dns.nameserverPolicy && typeof dns.nameserverPolicy === 'object' ? dns.nameserverPolicy : {};
  for (const [key, value] of Object.entries(policySource)) {
    const domain = key.trim();
    if (!domain || /[,\r\n]/.test(domain)) continue;
    if (Array.isArray(value)) {
      const servers = cleanServers(value);
      if (servers.length) policy[domain] = servers;
    } else if (typeof value === 'string' && value.trim()) {
      policy[domain] = value.trim();
    }
  }
  if (Object.keys(policy).length) out['nameserver-policy'] = policy;

  // fake-ip 排除项 = 显式声明的 always-real-ip ∪ 显式标了 DIRECT 的域名。
  // 后者是这次补的：规则写着「这个域名直连」，但 fake-ip 会把它解析成
  // 198.18.x.x，直连发出去谁都不认识。规则与 DNS 必须成对。
  const fakeIpFilter = [
    ...new Set(
      [
        ...(Array.isArray(dns.fakeIpFilter) ? dns.fakeIpFilter : [])
          .map((entry) => String(entry).trim())
          .filter(Boolean),
        ...context.directDomains,
      ].map((entry) => entry.toLowerCase()),
    ),
  ].slice(0, 300);
  if (fakeIpFilter.length) out['fake-ip-filter'] = fakeIpFilter;

  return out;
}

// ─────────────────────────────────────────────────────────────
//  入口
// ─────────────────────────────────────────────────────────────

/**
 * 把声明式编排解析成可以直接写进 YAML 的分组与规则。
 *
 * @param nodes 已经过过滤、重命名、能力筛选的节点。**必须**是最终要输出的那批，
 *   否则分组里会出现配置中不存在的节点名。
 */
export function resolveOrchestration(
  nodes: readonly ProxyNode[],
  spec: Orchestration,
): ResolvedOrchestration {
  const warnings: string[] = [];

  const nodeNames = new Set(nodes.map((node) => node.name));

  // 顺序很重要：先丢空组，再断环（断环可能又造出空组），最后再丢一次。
  const working = pruneGroups(
    breakCycles(
      pruneGroups(buildWorkingGroups(spec, nodes, warnings), nodeNames, warnings),
      warnings,
    ),
    nodeNames,
    warnings,
  );

  const groupNames = new Set(working.map((group) => group.name));
  const providersReferenced = new Set<string>();

  // 规则策略里写的是"用户 conf 里的节点名拼写"，与订阅实际节点名可能只有
  // 大小写差异（DMIT-VIA-US-LOS-CG vs DMIT-via-US-LOS-CG）。Clash 的规则
  // 匹配是大小写敏感的，所以这里做一次不敏感查找、**回写成真实节点名** ——
  // 直接丢弃会让 drleao.cn 这类指向具体节点的规则悄无声息地失效。
  const nodeNameByLower = new Map(nodes.map((node) => [node.name.toLowerCase(), node.name]));

  const rules: string[] = [];
  const seenRules = new Set<string>();
  let matchRule: WorkingRule | undefined;

  const declaredRules = Array.isArray(spec.rules) ? spec.rules : [];
  if (declaredRules.length > MAX_RULES) {
    warnings.push(`规则数量超过上限 ${MAX_RULES}，多出的 ${declaredRules.length - MAX_RULES} 条已忽略`);
  }

  for (const raw of declaredRules.slice(0, MAX_RULES)) {
    let rule = normalizeRule(raw, warnings);
    if (!rule) continue;

    if (rule.type === 'MATCH') {
      if (matchRule) {
        warnings.push(`存在多条 MATCH，只有第一条生效（${matchRule.policy}）`);
        continue;
      }
      matchRule = rule;
      continue;
    }

    if (rule.type === 'RULE-SET') {
      if (!spec.providers?.[rule.value]) {
        warnings.push(`规则引用了未声明的 rule-provider「${rule.value}」，已跳过`);
        continue;
      }
    }

    const isBuiltin = rule.policy === 'DIRECT' || rule.policy === 'REJECT';
    if (!isBuiltin && !groupNames.has(rule.policy)) {
      const exactNode = nodeNames.has(rule.policy);
      const actualNode = exactNode
        ? rule.policy
        : nodeNameByLower.get(rule.policy.toLowerCase());
      if (actualNode) {
        // 大小写不敏感命中：回写成真实节点名，保证客户端加载后真的能解析。
        if (!exactNode) {
          warnings.push(
            `规则策略「${rule.policy}」与节点「${actualNode}」仅大小写不同，已按真实节点名输出`,
          );
        }
        warnings.push(`规则指向具体节点「${actualNode}」，该节点改名后规则会失效`);
        rule = { ...rule, policy: actualNode };
      } else {
        warnings.push(`规则 ${formatRule(rule)} 指向不存在的策略「${rule.policy}」，已跳过`);
        continue;
      }
    }

    if (rule.type === 'RULE-SET') {
      // 只有真正会被输出的规则才算"引用了 provider"。
      providersReferenced.add(rule.value);
    }

    const line = formatRule(rule);
    if (seenRules.has(line)) continue;
    seenRules.add(line);
    rules.push(line);
  }

  const providers = buildProviders(providersReferenced, spec.providers, warnings);

  // provider 没能输出时，引用它的规则也必须一起丢 —— 否则客户端会去加载一个
  // 不存在的 provider，同样导致整份配置失败。
  const filteredRules = rules.filter((line) => {
    if (!line.startsWith('RULE-SET,')) return true;
    const provider = line.split(',')[1] ?? '';
    return Boolean(providers[provider]);
  });

  const defaultPolicy = pickDefaultPolicy(working);

  const matchPolicy = matchRule
    ? isUsablePolicy(matchRule.policy, groupNames, nodeNames)
      ? matchRule.policy
      : defaultPolicy
    : defaultPolicy;

  if (matchRule && matchRule.policy !== matchPolicy) {
    warnings.push(`MATCH 指向不存在的策略「${matchRule.policy}」，已改为「${matchPolicy}」`);
  }

  filteredRules.push(`MATCH,${matchPolicy}`);

  const result: ResolvedOrchestration = {
    groups: working.map((group) => {
      const resolved: ResolvedGroup = {
        name: group.name,
        type: group.type,
        proxies: group.proxies,
      };
      if (group.type !== 'select') {
        resolved.url = group.url;
        resolved.interval = group.interval;
        resolved.tolerance = group.tolerance;
      }
      return resolved;
    }),
    rules: filteredRules,
    providers,
    defaultPolicy,
    warnings,
  };

  const dns = buildDns(spec.dns, {
    groups: groupNames,
    directDomains: collectDirectDomains(filteredRules),
    warnings,
  });
  if (dns) result.dns = dns;
  const hosts = buildHosts(spec.hosts);
  if (hosts) result.hosts = hosts;
  if (spec.ipv6 !== undefined) result.ipv6 = spec.ipv6;

  return result;
}

function isUsablePolicy(
  policy: string,
  groups: ReadonlySet<string>,
  nodes: ReadonlySet<string>,
): boolean {
  return policy === 'DIRECT' || policy === 'REJECT' || groups.has(policy) || nodes.has(policy);
}

/**
 * 从已通过的规则里收集显式直连域名，供 `fake-ip-filter` 使用。
 *
 * 只取 `DOMAIN` / `DOMAIN-SUFFIX` 且策略为 DIRECT 的规则。`RULE-SET` 里的
 * 几十万条域名不可能展开、也不该展开 —— 那是规则集自己的事。
 */
function collectDirectDomains(rules: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const line of rules) {
    const parts = line.split(',');
    const type = parts[0];
    if (type !== 'DOMAIN' && type !== 'DOMAIN-SUFFIX') continue;
    if (parts[2] !== 'DIRECT') continue;

    const value = parts[1]?.trim();
    if (!value) continue;

    const entry = type === 'DOMAIN-SUFFIX' ? `+.${value}` : value;
    if (seen.has(entry.toLowerCase())) continue;
    seen.add(entry.toLowerCase());
    out.push(entry);
    if (out.length >= 200) break;
  }

  return out;
}

function pickDefaultPolicy(groups: readonly WorkingGroup[]): string {
  const select = groups.find((group) => group.type === 'select');
  if (select) return select.name;
  const first = groups[0];
  return first ? first.name : 'DIRECT';
}
