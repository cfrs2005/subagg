/**
 * Shadowrocket / Surge `.conf` → 声明式编排。
 *
 * ## 为什么需要一个"导入器"而不是让用户手写 JSON
 *
 * 用户在小火箭里积累的分流策略往往是几百行、带十几个外部规则集。
 * 要求他手工翻译成我们的 JSON，等于让迁移成本高到没人愿意做。
 * 这个文件把那次性的翻译自动化，并把**翻译不了的部分如实说出来** ——
 * 静默丢弃规则比不迁移更危险：用户会以为策略已经生效。
 *
 * ## 能翻译什么
 *
 * - `[Proxy Group]` → `groups`（select / url-test / fallback / load-balance）
 * - `[Rule]` → `rules`（DOMAIN / IP-CIDR / GEOIP / RULE-SET / DOMAIN-SET / FINAL）
 * - `[Host]` 的 `server:https://...` → `dns.nameserverPolicy`
 * - `[General]` 的 `dns-server` / `skip-proxy` / `always-real-ip` / `ipv6`
 *
 * ## 明确翻译不了什么
 *
 * - `[Proxy]` 里内联的节点：节点由订阅提供，不从这里导入
 * - `USER-AGENT` / `URL-REGEX` / `PROCESS-NAME` 等 Surge 专有规则类型
 * - `policy-select-name`：Clash 的 url-test 没有"首选"，外层包一个 select 来还原
 * - `skip-proxy` 的 `bypass-system` 语义：Clash 没有系统代理绕过，只能落成规则
 * - `#proxy` 后缀：Clash 不能为单个 DoH 服务器指定出口
 *
 * 本文件属于 core 纯函数层：无 IO。
 */

import type {
  Orchestration,
  OrchestrationDns,
  OrchestrationGroup,
  OrchestrationMember,
  OrchestrationProvider,
  OrchestrationRule,
  OrchestrationRuleType,
} from './orchestrate.js';

export interface ShadowrocketImportResult {
  orchestration: Orchestration;
  warnings: string[];
}

const SUPPORTED_RULE_TYPES: ReadonlySet<string> = new Set([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-REGEX',
  'IP-CIDR',
  'IP-CIDR6',
  'GEOIP',
  'GEOSITE',
  'RULE-SET',
  'DOMAIN-SET',
]);

/** Surge 专有、Clash 无法表达的规则类型。 */
const UNSUPPORTED_RULE_TYPES: ReadonlySet<string> = new Set([
  'USER-AGENT',
  'URL-REGEX',
  'PROCESS-NAME',
  'PROCESS-PATH',
  'DEST-PORT',
  'SRC-IP',
  'SRC-PORT',
  'SCRIPT',
  'AND',
  'OR',
  'NOT',
  'CELLULAR',
  'SSID',
]);

const GROUP_TYPES: ReadonlySet<string> = new Set([
  'select',
  'url-test',
  'fallback',
  'load-balance',
]);

const GROUP_OPTION_KEYS: ReadonlySet<string> = new Set([
  'url',
  'interval',
  'tolerance',
  'timeout',
  'policy-select-name',
  'policy-regex-filter',
  'include-all-proxies',
  'evaluate-before-use',
  'alive',
  'max-failed-times',
  'interface',
  'no-alert',
  'hidden',
  'icon-url',
  'filter',
  'select',
]);

// ─────────────────────────────────────────────────────────────
//  基础解析
// ─────────────────────────────────────────────────────────────

function stripComment(line: string): string {
  const trimmed = line.trim();
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith(';') ||
    trimmed.startsWith('//')
  ) {
    return '';
  }
  return trimmed;
}

/** 按第一个 `=` 切分，保留右侧的 `=`（DoH URL 里常见）。 */
function splitAssignment(line: string): { key: string; value: string } | undefined {
  const index = line.indexOf('=');
  if (index <= 0) return undefined;
  return {
    key: line.slice(0, index).trim(),
    value: line.slice(index + 1).trim(),
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactNameSelector(name: string): OrchestrationMember {
  return { kind: 'nodes', select: { nameRegex: `^${escapeRegex(name)}$` } };
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
//  [Proxy Group]
// ─────────────────────────────────────────────────────────────

function parseGroupLine(
  line: string,
  groupNames: ReadonlySet<string>,
  warnings: string[],
): OrchestrationGroup | undefined {
  const assignment = splitAssignment(line);
  if (!assignment) return undefined;

  const name = assignment.key;
  const parts = splitList(assignment.value);
  const rawType = (parts[0] ?? '').toLowerCase();
  if (!rawType) {
    warnings.push(`分组「${name}」缺少类型，已跳过`);
    return undefined;
  }

  let type: OrchestrationGroup['type'];
  if (GROUP_TYPES.has(rawType)) {
    type = rawType as OrchestrationGroup['type'];
  } else {
    warnings.push(`分组「${name}」类型「${rawType}」不支持，已按 select 处理`);
    type = 'select';
  }

  const members: OrchestrationMember[] = [];
  const group: OrchestrationGroup = { name, type, members };
  const preferred: string[] = [];
  let includeAllProxies = false;
  const regexFilters: string[] = [];

  for (const token of parts.slice(1)) {
    const eq = token.indexOf('=');
    if (eq > 0) {
      const key = token.slice(0, eq).trim().toLowerCase();
      const value = token.slice(eq + 1).trim();
      if (GROUP_OPTION_KEYS.has(key)) {
        switch (key) {
          case 'url':
            group.url = value;
            break;
          case 'interval': {
            const interval = Number(value);
            if (Number.isFinite(interval)) group.interval = interval;
            break;
          }
          case 'tolerance': {
            const tolerance = Number(value);
            if (Number.isFinite(tolerance)) group.tolerance = tolerance;
            break;
          }
          case 'policy-select-name':
            if (value) preferred.push(value);
            break;
          case 'include-all-proxies':
            includeAllProxies = value === 'true' || value === '1';
            break;
          case 'policy-regex-filter':
            // Surge 用正则从全部节点里筛成员；Clash 没有这个字段，
            // 但我们可以把它翻译成一个 nameRegex 选择器。
            if (value) regexFilters.push(value);
            break;
          default:
            // timeout / hidden 之类对 Clash 无意义，静默丢掉。
            break;
        }
        continue;
      }
    }

    if (token === 'DIRECT' || token === 'REJECT') {
      members.push({ kind: 'policy', name: token });
    } else if (groupNames.has(token)) {
      members.push({ kind: 'group', name: token });
    } else {
      members.push(exactNameSelector(token));
    }
  }

  if (includeAllProxies) {
    members.push({ kind: 'nodes', select: {} });
  }
  for (const pattern of regexFilters) {
    members.push({ kind: 'nodes', select: { nameRegex: pattern } });
  }

  if (preferred.length) {
    group.preferred = preferred;
  }

  return group;
}

// ─────────────────────────────────────────────────────────────
//  [Rule]
// ─────────────────────────────────────────────────────────────

interface ParsedRule {
  rule: OrchestrationRule;
  provider?: { key: string; provider: OrchestrationProvider };
}

function providerKeyFromUrl(url: string): string {
  const basename = url.split('?')[0]?.split('/').pop() ?? 'rules';
  return basename
    .replace(/\.(list|txt|yaml|yml)$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 64) || 'rules';
}

function providerBehaviorFromUrl(url: string): OrchestrationProvider['behavior'] {
  const basename = (url.split('?')[0]?.split('/').pop() ?? '').toLowerCase();
  // 只含域名的列表（Shadowrocket 的 DOMAIN-SET、blackmatrix7 的 *_Domain.list）
  // 必须用 behavior: domain，否则 Clash 会把每一行当成完整规则解析而失败。
  if (basename.includes('domain') || basename.endsWith('_domain.list')) return 'domain';
  return 'classical';
}

function parseRuleLine(
  line: string,
  warnings: string[],
): ParsedRule | undefined {
  const parts = line.split(',').map((part) => part.trim());
  const type = (parts[0] ?? '').toUpperCase();

  if (!type) return undefined;

  if (type === 'FINAL' || type === 'MATCH') {
    const policy = parts[1] ?? '';
    if (!policy) {
      warnings.push(`规则「${line}」缺少策略，已跳过`);
      return undefined;
    }
    return { rule: { type: 'MATCH', policy } };
  }

  if (UNSUPPORTED_RULE_TYPES.has(type)) {
    warnings.push(`规则类型 ${type} 是 Surge/Shadowrocket 专有，Clash 无法表达，已跳过：${line}`);
    return undefined;
  }

  if (!SUPPORTED_RULE_TYPES.has(type)) {
    warnings.push(`规则类型 ${type} 暂不支持，已跳过：${line}`);
    return undefined;
  }

  if (type === 'RULE-SET' || type === 'DOMAIN-SET') {
    const url = parts[1] ?? '';
    const policy = parts[2] ?? '';
    if (!/^https?:\/\//i.test(url)) {
      warnings.push(`规则「${line}」的规则集 URL 不是 http(s)，已跳过`);
      return undefined;
    }

    // 这两个 URL 形态在 Shadowrocket 里也常见，但拿到 Clash 里一定会坏：
    // - github.com/.../blob/... 返回的是 HTML 页面，不是规则文本
    // - 非 .list/.txt/.yaml 结尾多半是拼错了扩展名（例如 googleai.lsit）
    if (/^https?:\/\/github\.com\/[^/]+\/[^/]+\/blob\//i.test(url)) {
      warnings.push(
        `规则集「${url}」是 GitHub 网页地址（返回 HTML），请改用 raw.githubusercontent.com；已保留但可能加载失败`,
      );
    } else if (!/\.(list|txt|yaml|yml)(\?.*)?$/i.test(url)) {
      warnings.push(`规则集「${url}」的扩展名不常见，请确认它真的是规则文本；已保留但可能加载失败`);
    }
    if (!policy) {
      warnings.push(`规则「${line}」缺少策略，已跳过`);
      return undefined;
    }

    const key = providerKeyFromUrl(url);
    const behavior =
      type === 'DOMAIN-SET' ? 'domain' : providerBehaviorFromUrl(url);

    return {
      rule: { type: 'RULE-SET', value: key, policy },
      provider: { key, provider: { url, behavior } },
    };
  }

  const value = parts[1] ?? '';
  const policy = parts[2] ?? '';
  if (!value || !policy) {
    warnings.push(`规则「${line}」缺少值或策略，已跳过`);
    return undefined;
  }

  const options = parts.slice(3).map((option) => option.toLowerCase());
  if (options.includes('extended-matching')) {
    warnings.push(`规则「${line}」的 extended-matching 在 Clash 中没有等价物，已忽略该参数`);
  }

  const rule: OrchestrationRule = {
    type: type as OrchestrationRuleType,
    value,
    policy,
  };
  if (options.includes('no-resolve')) rule.noResolve = true;

  return { rule };
}

// ─────────────────────────────────────────────────────────────
//  [Host]
// ─────────────────────────────────────────────────────────────

function parseHostLine(
  line: string,
  policy: Record<string, string>,
  hosts: Record<string, string>,
  warnings: string[],
): void {
  const assignment = splitAssignment(line);
  if (!assignment) return;

  const rawDomain = assignment.key;
  const value = assignment.value;

  const serverMatch = /^server:(.+)$/i.exec(value);
  if (!serverMatch) {
    // `domain = 1.2.3.4` 是静态解析，Clash 用顶层 `hosts:` 表达，语义一致。
    if (/^[A-Za-z0-9.:_-]+$/.test(value)) {
      hosts[rawDomain] = value;
      return;
    }
    warnings.push(`[Host] 的「${rawDomain} = ${value}」无法翻译，已跳过`);
    return;
  }

  const server = (serverMatch[1] ?? '').split('#')[0]?.trim() ?? '';
  if (!/^https?:\/\//i.test(server)) {
    warnings.push(`[Host] 的「${rawDomain}」使用了非 DoH 服务器「${server}」，已跳过`);
    return;
  }

  const domain = rawDomain.startsWith('*.') ? `+.${rawDomain.slice(2)}` : rawDomain;
  policy[domain] = server;
}

// ─────────────────────────────────────────────────────────────
//  [General]
// ─────────────────────────────────────────────────────────────

interface GeneralState {
  nameserver: string[];
  fallback: string[];
  proxyServerNameserver: string[];
  fakeIpFilter: string[];
  ipv6?: boolean;
  skipProxyRules: OrchestrationRule[];
  ignored: string[];
}

function cleanDnsServer(value: string): string {
  const withoutProxyTag = value.split('#')[0]?.trim() ?? '';
  return withoutProxyTag;
}

function parseSkipProxy(value: string, rules: OrchestrationRule[]): void {
  for (const entry of splitList(value)) {
    if (entry.includes(':')) {
      const cidr = entry.includes('/') ? entry : `${entry}/128`;
      rules.push({ type: 'IP-CIDR6', value: cidr, policy: 'DIRECT', noResolve: true });
      continue;
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(entry)) {
      rules.push({ type: 'IP-CIDR', value: `${entry}/32`, policy: 'DIRECT', noResolve: true });
      continue;
    }
    if (/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(entry)) {
      rules.push({ type: 'IP-CIDR', value: entry, policy: 'DIRECT', noResolve: true });
      continue;
    }

    const domain = entry.startsWith('*.') ? entry.slice(2) : entry;
    if (!/^[A-Za-z0-9._-]+$/.test(domain)) {
      // `skip-proxy` 里常见残片（例如 `e.]`）。丢掉但不要刷屏。
      continue;
    }
    rules.push({ type: 'DOMAIN-SUFFIX', value: domain, policy: 'DIRECT' });
  }
}

function parseGeneralLine(line: string, state: GeneralState, warnings: string[]): void {
  const assignment = splitAssignment(line);
  if (!assignment) return;

  const key = assignment.key.toLowerCase();
  const value = assignment.value;

  switch (key) {
    case 'dns-server': {
      const servers = splitList(value);
      state.nameserver.push(...servers.map(cleanDnsServer).filter(Boolean));
      if (servers.some((server) => server.toLowerCase().includes('#proxy'))) {
        warnings.push(
          'Shadowrocket 的 dns-server 支持 #proxy，Clash 不能为单个 DoH 服务器指定出口；已按普通 nameserver 输出',
        );
      }
      break;
    }
    case 'fallback-dns-server':
      state.fallback.push(...splitList(value).map(cleanDnsServer).filter(Boolean));
      break;
    case 'skip-proxy':
      parseSkipProxy(value, state.skipProxyRules);
      break;
    case 'always-real-ip': {
      for (const entry of splitList(value)) {
        const domain = entry.startsWith('*.') ? entry.slice(2) : entry;
        if (domain) state.fakeIpFilter.push(`+.${domain}`);
      }
      break;
    }
    case 'ipv6':
      state.ipv6 = value.toLowerCase() === 'true';
      break;
    case 'prefer-ipv6':
      if (value.toLowerCase() === 'false' && state.ipv6 === undefined) state.ipv6 = false;
      break;
    case 'dns-direct-system':
    case 'dns-fallback-system':
    case 'bypass-system':
    case 'tun-excluded-routes':
    case 'private-ip-answer':
    case 'icmp-auto-reply':
    case 'always-reject-url-rewrite':
    case 'dns-fallback-proxy':
    case 'update-url':
      state.ignored.push(key);
      break;
    default:
      break;
  }
}

// ─────────────────────────────────────────────────────────────
//  兜底分组
// ─────────────────────────────────────────────────────────────

/**
 * Shadowrocket / Surge 的自动组（url-test / fallback / load-balance）都允许
 * 在界面里**手动指定节点**，指定后优先使用、失败再回到自动；Clash 的
 * 同名类型却是纯自动、完全不可点选。直接照抄类型，用户在客户端里会觉得
 * "所有分组都点不动"。
 *
 * 忠实且可用的翻译是：外层 `select`（首个成员 = 首选节点，可任意切换）
 * + 内层 `<name>-AUTO`（保留原类型与测速参数）。规则仍指向原组名，
 * 默认行为仍是"首选优先"，想交给自动时点内层组即可。
 *
 * 注：`policy-regex-filter` / `include-all-proxies` 这类选项在 select 外层
 * 不需要重复，成员已经解析成真实节点。
 */
function wrapAutoGroups(groups: OrchestrationGroup[], warnings: string[]): OrchestrationGroup[] {
  const names = new Set(groups.map((group) => group.name));
  const out: OrchestrationGroup[] = [];

  for (const group of groups) {
    if (group.type === 'select') {
      out.push(group);
      continue;
    }

    let autoName = `${group.name}-AUTO`;
    for (let index = 2; names.has(autoName); index += 1) {
      autoName = `${group.name}-AUTO-${index}`;
    }

    // 外层：原成员（preferred 会被解析器提前）+ 自动子组。
    out.push({
      name: group.name,
      type: 'select',
      members: [...group.members, { kind: 'group', name: autoName }],
      ...(group.preferred?.length ? { preferred: [...group.preferred] } : {}),
    });
    // 内层：保留原类型、测速参数与成员（preferred 只属于外层）。
    out.push({
      ...group,
      name: autoName,
      preferred: undefined,
    });

    names.add(autoName);
    warnings.push(
      `分组「${group.name}」原为 ${group.type}（Clash 中不可手动切换），已翻译为外层 select + 内层自动组「${autoName}」`,
    );
  }

  return out;
}

function ensureGroups(orchestration: Orchestration, warnings: string[]): void {
  const names = new Set(orchestration.groups.map((group) => group.name));

  const wantsProxy = orchestration.rules.some(
    (rule) => rule.policy === 'PROXY' || rule.policy === 'GLOBAL',
  );
  if (wantsProxy && !names.has('PROXY')) {
    orchestration.groups.unshift({
      name: 'PROXY',
      type: 'select',
      members: [{ kind: 'nodes', select: {} }],
    });
    names.add('PROXY');
    warnings.push('规则引用了 PROXY 但配置里没有该分组，已自动创建一个包含全部节点的 select 组');
  }

  if (orchestration.groups.length === 0) {
    orchestration.groups.push({
      name: 'PROXY',
      type: 'select',
      members: [{ kind: 'nodes', select: {} }],
    });
    names.add('PROXY');
    warnings.push('配置里没有任何分组，已自动创建一个 PROXY 组');
  }

  const hasMatch = orchestration.rules.some((rule) => rule.type === 'MATCH');
  if (!hasMatch) {
    const first = orchestration.groups[0];
    const policy = names.has('PROXY') ? 'PROXY' : (first?.name ?? 'DIRECT');
    orchestration.rules.push({ type: 'MATCH', policy });
    warnings.push(`配置里没有 FINAL / MATCH，已补一条兜底：MATCH,${policy}`);
  }
}

// ─────────────────────────────────────────────────────────────
//  入口
// ─────────────────────────────────────────────────────────────

/**
 * 解析一份 Shadowrocket / Surge 配置。
 *
 * 永远返回一份**可渲染**的编排（至少有一个分组和一条 MATCH），
 * 无法翻译的部分记在 `warnings` 里，由界面逐条展示。
 */
export function parseShadowrocketConf(text: string): ShadowrocketImportResult {
  const warnings: string[] = [];
  const groups: OrchestrationGroup[] = [];
  const groupNames = new Set<string>();
  const rules: OrchestrationRule[] = [];
  const providers: Record<string, OrchestrationProvider> = {};

  const hostPolicy: Record<string, string> = {};
  const hosts: Record<string, string> = {};
  const general: GeneralState = {
    nameserver: [],
    fallback: [],
    proxyServerNameserver: [],
    fakeIpFilter: [],
    skipProxyRules: [],
    ignored: [],
  };

  let section = '';

  // 第一遍：只收集分组名。成员引用分组时必须先知道所有名字，
  // 否则 PROXY 引用后面定义的自动选择会被误判成节点名。
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line) continue;
    const header = /^\[(.+)]$/.exec(line);
    if (header) {
      section = (header[1] ?? '').trim().toLowerCase();
      continue;
    }
    if (section === 'proxy group') {
      const assignment = splitAssignment(line);
      if (assignment) groupNames.add(assignment.key);
    }
  }

  section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line) continue;

    const header = /^\[(.+)]$/.exec(line);
    if (header) {
      section = (header[1] ?? '').trim().toLowerCase();
      if (section === 'proxy') {
        warnings.push('[Proxy] 里的内联节点不会导入；节点仍由订阅提供');
      }
      continue;
    }

    switch (section) {
      case 'proxy group': {
        const group = parseGroupLine(line, groupNames, warnings);
        if (group) groups.push(group);
        break;
      }
      case 'rule': {
        const parsed = parseRuleLine(line, warnings);
        if (!parsed) break;

        if (parsed.provider) {
          const baseKey = parsed.provider.key;
          const provider = parsed.provider.provider;
          let key = baseKey;
          let index = 2;
          let existing = providers[key];

          // 同一个文件名可能指向不同 URL（不同目录、不同仓库）。直接复用
          // key 会让后一条规则悄悄用上前一个规则集 —— 规则看起来在，行为是错的。
          // 所以冲突时生成一个唯一 key，两条规则各自指向自己的 URL。
          while (existing && existing.url !== provider.url) {
            key = `${baseKey}-${index}`;
            index += 1;
            existing = providers[key];
          }

          if (!existing) {
            providers[key] = provider;
            if (key !== baseKey) {
              warnings.push(`规则集「${provider.url}」与已有 provider 重名，已改名为「${key}」`);
            }
          }
          parsed.rule.value = key;
        }

        rules.push(parsed.rule);
        break;
      }
      case 'host':
        parseHostLine(line, hostPolicy, hosts, warnings);
        break;
      case 'general':
        parseGeneralLine(line, general, warnings);
        break;
      default:
        // [URL Rewrite] / [MITM] / [Map Local] 等与分流无关，静默忽略。
        break;
    }
  }

  // skip-proxy 是"不要代理"的语义，必须排在所有规则最前面。
  rules.unshift(...general.skipProxyRules);

  const orchestration: Orchestration = {
    groups,
    rules,
    providers: Object.keys(providers).length ? providers : undefined,
  };

  const dns: OrchestrationDns = {};
  if (general.nameserver.length) dns.nameserver = general.nameserver;
  if (general.fallback.length) dns.fallback = general.fallback;
  if (general.fakeIpFilter.length) dns.fakeIpFilter = general.fakeIpFilter;
  if (Object.keys(hostPolicy).length) dns.nameserverPolicy = hostPolicy;
  if (general.ipv6 !== undefined) dns.ipv6 = general.ipv6;
  if (dns.nameserver?.length) dns.enable = true;
  if (Object.keys(dns).length) orchestration.dns = dns;
  if (Object.keys(hosts).length) orchestration.hosts = hosts;

  if (general.ipv6 !== undefined) orchestration.ipv6 = general.ipv6;

  if (general.ignored.length) {
    warnings.push(
      `以下 [General] 选项在 Clash 中没有等价物，已忽略：${[
        ...new Set(general.ignored),
      ].join(', ')}`,
    );
  }

  // 节点名是按"渲染后的显示名"精确匹配的。profile 如果开了重命名模板，
  // 分组会匹配不到 —— 这是迁移里最容易踩的坑，必须提前说。
  if (
    groups.some((group) =>
      group.members.some(
        (member) => member.kind === 'nodes' && typeof member.select?.nameRegex === 'string',
      ),
    )
  ) {
    warnings.push(
      '分组里的节点名/正则按「渲染后的显示名」匹配；如果该配置文件启用了重命名模板，请确认这些成员仍然能命中',
    );
  }

  orchestration.groups = wrapAutoGroups(orchestration.groups, warnings);
  ensureGroups(orchestration, warnings);

  return { orchestration, warnings };
}
