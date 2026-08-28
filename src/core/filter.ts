/**
 * 节点过滤规则引擎。
 *
 * 这是产品里"生成、选择、过滤"三个动作的落点：一份 `FilterRule` 描述"从全部节点里
 * 挑出哪些、怎么排、叫什么名字"，规则与输出格式完全解耦 —— 同一份规则可以生成
 * Clash、Shadowrocket、V2Ray 三种订阅。
 *
 * ## 处理管线
 *
 * ```
 * 全部节点
 *   → 1. 选择      pick 白名单 / exclude → sources+regions+types → include
 *   → 2. 去重      dedupe
 *   → 3. 排序      sort
 *   → 4. 截断      limit
 *   → 5. 重命名    rename（此时才有稳定的序号）
 *   → 6. 名称去重  确保输出的名字互不重复
 * ```
 *
 * 顺序不是随意定的，每一步为什么在这个位置，见各步骤的注释。
 *
 * 本文件属于 core 纯函数层：无 IO。
 */

import { dedupeKey } from './fingerprint.js';
import { regionNameZh, regionToFlag } from './region.js';
import type { ProxyNode, ProxyType } from './types.js';

// ─────────────────────────────────────────────────────────────
//  规则定义
// ─────────────────────────────────────────────────────────────

/** 可用于匹配的字段。 */
export type MatchField = 'name' | 'server' | 'type' | 'region' | 'source';

/** 单条匹配表达式。 */
export interface MatchExpr {
  field: MatchField;
  op: 'regex' | 'contains' | 'eq';
  value: string;
}

/** 重命名规则。 */
export interface RenameRule {
  /**
   * 匹配的正则。**留空表示匹配整个名字**，此时 `replace` 就是新名字模板 ——
   * 这是最常用的形态：把所有节点统一改成 `{flag} {regionZh} {index2}`。
   */
  pattern?: string;
  /**
   * 替换模板。支持两类占位符：
   *   - `{name}` `{region}` `{regionZh}` `{flag}` `{type}` `{source}`
   *     `{server}` `{port}` `{index}` `{index2}`
   *   - 正则捕获组 `$1` `$2`（仅在 `pattern` 非空时有意义）
   *
   * 占位符先展开，再交给 `String.replace` 处理捕获组。
   */
  replace: string;
  /** 是否全局替换（正则加 `g` 标志）。默认 false。 */
  all?: boolean;
}

/** 去重模式。语义见 fingerprint.ts 的 `dedupeKey`。 */
export type DedupeMode = 'off' | 'server-port' | 'fingerprint';

/** 排序方式。 */
export type SortMode = 'none' | 'name' | 'region' | 'type' | 'source';

/** `pick` 与其余规则的组合方式。 */
export type PickMode = 'only' | 'union';

export interface FilterRule {
  /** 限定订阅源 id。留空表示不限。 */
  sources?: string[];
  /** 限定地区（ISO alpha-2）。留空表示不限。地区推断不出的节点会被排除。 */
  regions?: string[];
  /** 限定协议。留空表示不限。 */
  types?: ProxyType[];
  /** 命中任一条即保留。留空表示不做正向筛选。 */
  include?: MatchExpr[];
  /** 命中任一条即丢弃。**优先级高于 include**。 */
  exclude?: MatchExpr[];

  /**
   * 手动勾选的节点指纹列表。
   *
   * 这是 Web 界面上"在节点表格里打勾"的持久化形式。用指纹而不是名字或下标，
   * 是为了让勾选在上游订阅刷新、节点改名之后依然有效（详见 fingerprint.ts）。
   */
  pick?: string[];
  /**
   * `pick` 的语义：
   * - `only`（默认）：**只**使用勾选的节点，其余筛选条件全部忽略。
   *   所见即所得 —— 你勾了什么就得到什么，不会出现"明明勾了却没有"的困惑。
   * - `union`：规则筛出的节点 ∪ 勾选的节点。适合"所有香港节点，再额外加这三个日本的"。
   */
  pickMode?: PickMode;

  /**
   * 是否启用内置的信息节点排除规则。默认 **true**。
   *
   * 机场普遍在订阅里塞入"官网地址""剩余流量：12.3GB""距离下次重置还有 3 天"
   * 这类伪节点。不过滤的话，生成出的配置里会混满这些垃圾条目，
   * 在客户端的节点列表里非常碍眼，还会干扰自动测速分组。
   */
  useDefaultExclude?: boolean;

  dedupe?: DedupeMode;
  rename?: RenameRule[];
  sort?: SortMode;
  /** 最多保留多少个节点。用于控制配置体积，`0` 或省略表示不限。 */
  limit?: number;
  chain?: ChainRule;
}

export interface ChainSelector {
  pick?: string[];
  sources?: string[];
  regions?: string[];
  types?: ProxyType[];
  include?: MatchExpr[];
  exclude?: MatchExpr[];
}

export interface ChainRule {
  enabled?: boolean;
  entry: ChainSelector;
  landing: ChainSelector;
  nameTemplate?: string;
  keepLandingDirect?: boolean;
  maxPairs?: number;
}

// ─────────────────────────────────────────────────────────────
//  内置排除规则
// ─────────────────────────────────────────────────────────────

/**
 * 内置的"信息节点"排除模式。
 *
 * 取舍原则是**宁可漏杀，不可错杀** —— 误删一个真实节点，用户会以为订阅出了问题，
 * 排查成本很高；而漏掉一个信息节点只是列表里多一条碍眼的条目。
 *
 * 所以这里只收录那些几乎不可能出现在真实节点名里的词。像"测试"这类词
 * 就没有收录 —— 确实有机场会提供名为"测试节点"的可用线路。
 */
export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  // 流量与到期提示
  '剩余流量', '剩余', '到期', '过期', '距离下次重置', '重置', '有效期',
  // 推广与站点信息
  '官网', '官址', '网址', '主页', '订阅地址', '备用地址', '最新地址',
  '套餐', '续费', '购买', '优惠', '邀请', '返利', '佣金',
  // 运营信息
  '客服', '群组', '频道', '公告', '通知', '教程', '使用说明',
  '请勿', '禁止', '无法访问',
  // 英文
  'expire', 'expired', 'remaining', 'traffic reset', 'official site',
  'renew', 'subscribe', 'website',
  // 社交链接
  't\\.me', 'telegram',
];

/** 内置排除规则的编译结果。模块加载时编译一次，避免每次过滤都重新构造。 */
const DEFAULT_EXCLUDE_RE: RegExp = new RegExp(DEFAULT_EXCLUDE_PATTERNS.join('|'), 'i');

// ─────────────────────────────────────────────────────────────
//  正则安全
// ─────────────────────────────────────────────────────────────

/** 用户提供的正则最大长度。 */
const MAX_REGEX_LENGTH = 200;

/**
 * 检测明显的灾难性回溯模式。
 *
 * JavaScript 的正则引擎是回溯式的，`(a+)+$` 配上 `aaaaaaaaaaaaaaaaaaaaX`
 * 这样的输入会导致指数级的时间复杂度，单条规则就能把 CPU 打满。
 *
 * 这个检测**只是缓解，不是根治** —— 完备的方案需要 RE2 之类的线性时间引擎。
 * 考虑到本项目的信任模型是单用户自托管（写规则的人就是部署的人），
 * 当前的缓解程度与风险是匹配的。详见 SECURITY.md。
 */
function hasNestedQuantifier(pattern: string): boolean {
  // 匹配 `(...+)+` `(...*)* ` `(...+){2,}` 这类分组内外都带量词的结构
  return /\([^)]*[+*][^)]*\)\s*[+*{]/.test(pattern);
}

/**
 * 安全地编译用户提供的正则。
 *
 * 失败时返回 undefined 而不是抛异常 —— 一条写坏的规则不应该让整个订阅生成失败，
 * 而应该被跳过并在结果里给出警告。
 */
export function compileUserRegex(
  pattern: string,
  flags = 'i',
): { re: RegExp } | { error: string } {
  if (pattern.length > MAX_REGEX_LENGTH) {
    return { error: `正则过长（${pattern.length} > ${MAX_REGEX_LENGTH} 字符）` };
  }
  if (hasNestedQuantifier(pattern)) {
    return { error: '正则包含嵌套量词，可能导致灾难性回溯，已拒绝' };
  }
  try {
    return { re: new RegExp(pattern, flags) };
  } catch (err) {
    return { error: `正则语法错误：${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─────────────────────────────────────────────────────────────
//  匹配
// ─────────────────────────────────────────────────────────────

/** 取节点上某个字段的值，用于匹配。地区推断不出时返回空串。 */
function fieldValue(node: ProxyNode, field: MatchField): string {
  switch (field) {
    case 'name':
      return node.name;
    case 'server':
      return node.server;
    case 'type':
      return node.type;
    case 'region':
      return node.meta.region ?? '';
    case 'source':
      return node.meta.sourceName;
  }
}

/**
 * 单条表达式的匹配。
 *
 * @param warnings 正则编译失败时把原因追加进去。写坏的规则会被当作"不匹配"处理，
 *   并让用户在界面上看到警告，而不是静默生效或整体报错。
 */
export function matchAny(node: ProxyNode, exprs: readonly MatchExpr[] | undefined, warnings: string[]): boolean {
  return Boolean(exprs?.some((expr) => matches(node, expr, warnings)));
}

function matches(node: ProxyNode, expr: MatchExpr, warnings: string[]): boolean {
  const value = fieldValue(node, expr.field);
  switch (expr.op) {
    case 'eq':
      return value.toLowerCase() === expr.value.toLowerCase();
    case 'contains':
      return value.toLowerCase().includes(expr.value.toLowerCase());
    case 'regex': {
      const compiled = compileUserRegex(expr.value);
      if ('error' in compiled) {
        const msg = `规则 ${expr.field} ~ /${expr.value}/ 被忽略：${compiled.error}`;
        if (!warnings.includes(msg)) warnings.push(msg);
        return false;
      }
      return compiled.re.test(value);
    }
  }
}

/** Select nodes for chain roles without applying dedupe, sort, rename or limit. */
export function selectNodes(
  all: readonly ProxyNode[],
  selector: ChainSelector,
  warnings: string[],
): ProxyNode[] {
  const hasPredicate = Boolean(
    selector.sources?.length || selector.regions?.length || selector.types?.length || selector.include?.length || selector.exclude?.length,
  );
  const pick = new Set(selector.pick ?? []);
  if (pick.size === 0 && !hasPredicate) {
    warnings.push('链式选择器为空，未匹配任何节点；请至少选择一个节点或筛选条件');
    return [];
  }
  return all.filter((node) => {
    const picked = pick.has(node.fingerprint);
    const predicate = hasPredicate &&
      (!selector.sources?.length || selector.sources.includes(node.meta.sourceId)) &&
      (!selector.regions?.length || (node.meta.region && selector.regions.includes(node.meta.region))) &&
      (!selector.types?.length || selector.types.includes(node.type)) &&
      (!selector.include?.length || matchAny(node, selector.include, warnings)) &&
      (!selector.exclude?.length || !matchAny(node, selector.exclude, warnings));
    return picked || predicate;
  });
}

// ─────────────────────────────────────────────────────────────
//  结果
// ─────────────────────────────────────────────────────────────

/**
 * 各阶段的节点数统计。
 *
 * 之所以要把这些数字暴露出来：用户最常问的问题是"为什么我的节点少了"。
 * 有了分阶段统计，界面上就能直接回答"内置规则过滤掉了 4 个信息节点、
 * 去重合并了 3 个"，而不是让用户自己猜。
 */
export interface FilterStats {
  /** 输入节点总数。 */
  input: number;
  /** 被 sources/regions/types/include 筛掉的数量。 */
  droppedBySelect: number;
  /** 被内置信息节点规则排除的数量。 */
  droppedByDefaultExclude: number;
  /** 被用户 exclude 规则排除的数量。 */
  droppedByExclude: number;
  /** 被去重合并掉的数量。 */
  droppedByDedupe: number;
  /** 被 limit 截断掉的数量。 */
  droppedByLimit: number;
  /** 最终输出数量。 */
  output: number;
}

export interface FilterOutcome {
  nodes: ProxyNode[];
  stats: FilterStats;
  /** 规则本身的问题（如写坏的正则）。呈现给用户，不影响其余规则生效。 */
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────
//  主流程
// ─────────────────────────────────────────────────────────────

/**
 * 按规则过滤并整理节点。
 *
 * 输入不会被修改；输出的节点在需要改名时是浅拷贝的新对象。
 */
export function applyFilter(all: readonly ProxyNode[], rule: FilterRule): FilterOutcome {
  const warnings: string[] = [];
  const stats: FilterStats = {
    input: all.length,
    droppedBySelect: 0,
    droppedByDefaultExclude: 0,
    droppedByExclude: 0,
    droppedByDedupe: 0,
    droppedByLimit: 0,
    output: 0,
  };

  // ── 1. 选择 ────────────────────────────────────────────
  const pickSet = new Set(rule.pick ?? []);
  const pickMode: PickMode = rule.pickMode ?? 'only';
  const usePickOnly = pickSet.size > 0 && pickMode === 'only';

  let selected: ProxyNode[];

  if (usePickOnly) {
    // 纯白名单模式：用户勾了什么就是什么。
    // 内置排除规则在这里**故意不生效** —— 如果用户明确勾选了某个节点，
    // 哪怕它名字里带"官网"，那也是用户的选择，我们不该替他做主。
    selected = all.filter((n) => pickSet.has(n.fingerprint));
    stats.droppedBySelect = all.length - selected.length;
  } else {
    const useDefaultExclude = rule.useDefaultExclude ?? true;
    selected = [];

    for (const node of all) {
      // union 模式下，被勾选的节点直接放行，跳过全部筛选条件
      if (pickSet.size > 0 && pickMode === 'union' && pickSet.has(node.fingerprint)) {
        selected.push(node);
        continue;
      }

      // 1a. 排除先行。
      //
      // 排除放在维度筛选之前，是为了让统计有诊断价值：一个名为"剩余流量：87GB"
      // 的信息节点，无论用户是否同时在按地区筛选，都应当被归因到"内置规则排除"
      // 而不是"地区不匹配"。否则界面上就没法告诉用户"我帮你滤掉了 2 个信息节点"。
      if (useDefaultExclude && DEFAULT_EXCLUDE_RE.test(node.name)) {
        stats.droppedByDefaultExclude++;
        continue;
      }
      // exclude 优先于 include，这个优先级是刻意的：exclude 表达的是
      // "我不要这个"，是更强的意愿。反过来（include 覆盖 exclude）会让
      // "要所有香港节点，但不要 IEPL"这种最常见的组合无法表达。
      if (rule.exclude?.length && rule.exclude.some((e) => matches(node, e, warnings))) {
        stats.droppedByExclude++;
        continue;
      }

      // 1b. 维度筛选
      if (rule.sources?.length && !rule.sources.includes(node.meta.sourceId)) {
        stats.droppedBySelect++;
        continue;
      }
      if (rule.regions?.length) {
        const region = node.meta.region;
        // 地区推断不出的节点会被地区筛选排除。这是正确行为：
        // 用户要"香港节点"，一个我们不知道在哪的节点不该混进去。
        if (!region || !rule.regions.includes(region)) {
          stats.droppedBySelect++;
          continue;
        }
      }
      if (rule.types?.length && !rule.types.includes(node.type)) {
        stats.droppedBySelect++;
        continue;
      }

      // 1c. 正向包含：一旦指定，节点必须至少命中一条
      if (rule.include?.length && !rule.include.some((e) => matches(node, e, warnings))) {
        stats.droppedBySelect++;
        continue;
      }

      selected.push(node);
    }
  }

  // ── 2. 去重 ────────────────────────────────────────────
  // 必须早于重命名：重命名会抹掉区分节点的原始信息，
  // 之后再去重就分不清"两个同名节点"到底是不是同一台机器了。
  const dedupeMode = rule.dedupe ?? 'off';
  if (dedupeMode !== 'off') {
    const seen = new Set<string>();
    const deduped: ProxyNode[] = [];
    for (const node of selected) {
      const key = dedupeKey(node, dedupeMode);
      if (seen.has(key)) {
        stats.droppedByDedupe++;
        continue;
      }
      seen.add(key);
      deduped.push(node);
    }
    selected = deduped;
  }

  // ── 3. 排序 ────────────────────────────────────────────
  const sortMode = rule.sort ?? 'none';
  if (sortMode !== 'none') {
    selected = [...selected].sort(comparatorFor(sortMode));
  }

  // ── 4. 截断 ────────────────────────────────────────────
  // 早于重命名，这样 {index} 序号才是 1..limit 连续的。
  if (rule.limit && rule.limit > 0 && selected.length > rule.limit) {
    stats.droppedByLimit = selected.length - rule.limit;
    selected = selected.slice(0, rule.limit);
  }

  // ── 5. 重命名 ──────────────────────────────────────────
  // 放在排序与截断之后，{index} 才能反映节点在最终列表里的真实位置。
  if (rule.rename?.length) {
    selected = selected.map((node, i) => {
      const newName = applyRenameRules(node, rule.rename ?? [], i, warnings);
      return newName === node.name ? node : { ...node, name: newName };
    });
  }

  // ── 6. 名称去重 ────────────────────────────────────────
  // 这一步不是锦上添花，是**正确性要求**：Clash 要求 proxies 的 name 全局唯一，
  // 重名会导致客户端拒绝加载整份配置或静默丢节点。
  // 而重命名规则极易制造重名（比如把所有节点都改成 "{flag} {regionZh}"）。
  selected = ensureUniqueNames(selected);

  stats.output = selected.length;
  return { nodes: selected, stats, warnings };
}

// ─────────────────────────────────────────────────────────────
//  排序
// ─────────────────────────────────────────────────────────────

/**
 * 名称比较。
 *
 * `numeric: true` 让 `HK-2` 排在 `HK-10` 前面，而不是按字符串比较得出的
 * `HK-10 < HK-2`。节点名里大量存在这种编号，不开这个选项排出来的顺序很难看。
 *
 * 依赖 Node 的完整 ICU（官方构建自 v13 起默认包含）。
 */
function compareName(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

function comparatorFor(mode: Exclude<SortMode, 'none'>): (a: ProxyNode, b: ProxyNode) => number {
  switch (mode) {
    case 'name':
      return (a, b) => compareName(a.name, b.name);
    case 'region':
      // 同地区内再按名字排，否则同一个地区的节点会散在各处
      return (a, b) => {
        const ra = a.meta.region ?? '￿'; // 无地区的排到最后
        const rb = b.meta.region ?? '￿';
        return ra === rb ? compareName(a.name, b.name) : ra.localeCompare(rb);
      };
    case 'type':
      return (a, b) => (a.type === b.type ? compareName(a.name, b.name) : a.type.localeCompare(b.type));
    case 'source':
      return (a, b) =>
        a.meta.sourceName === b.meta.sourceName
          ? compareName(a.name, b.name)
          : compareName(a.meta.sourceName, b.meta.sourceName);
  }
}

// ─────────────────────────────────────────────────────────────
//  重命名
// ─────────────────────────────────────────────────────────────

/**
 * 展开模板里的 `{var}` 占位符。
 *
 * 未知的占位符原样保留 —— 用户可能就是想在名字里写一对花括号，
 * 静默删掉会让人困惑。
 */
function expandTemplate(template: string, node: ProxyNode, index: number): string {
  const region = node.meta.region ?? '';
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    switch (key) {
      case 'name':
        return node.name;
      case 'region':
        return region;
      case 'regionZh':
        return region ? regionNameZh(region) : '';
      case 'flag':
        return region ? regionToFlag(region) : '';
      case 'type':
        return node.type;
      case 'source':
        return node.meta.sourceName;
      case 'server':
        return node.server;
      case 'port':
        return String(node.port);
      case 'index':
        return String(index + 1);
      case 'index2':
        // 两位零填充，让 01..09 与 10 对齐，客户端列表里排版更整齐
        return String(index + 1).padStart(2, '0');
      default:
        return whole;
    }
  });
}

/** 依次应用全部重命名规则。后一条规则作用在前一条的结果上。 */
function applyRenameRules(
  node: ProxyNode,
  rules: readonly RenameRule[],
  index: number,
  warnings: string[],
): string {
  let name = node.name;

  for (const rule of rules) {
    // 占位符先展开，再交给 String.replace 处理 $1 之类的捕获组引用。
    // 顺序不能反 —— 先跑 replace 的话，模板里的 {name} 拿到的会是半成品。
    const replacement = expandTemplate(rule.replace, { ...node, name }, index);

    if (!rule.pattern) {
      // 空 pattern = 整体替换。这是最常用的形态。
      name = replacement;
      continue;
    }

    const compiled = compileUserRegex(rule.pattern, rule.all ? 'gi' : 'i');
    if ('error' in compiled) {
      const msg = `重命名规则 /${rule.pattern}/ 被忽略：${compiled.error}`;
      if (!warnings.includes(msg)) warnings.push(msg);
      continue;
    }
    name = name.replace(compiled.re, replacement);
  }

  return name.trim();
}

/**
 * 保证名称唯一。
 *
 * Clash 的 `proxies` 要求 name 全局唯一，重名会让客户端拒绝整份配置。
 * 重命名规则很容易制造重名（把一批节点统一改成 `{flag} {regionZh}` 就会），
 * 所以这一步是必需的兜底。
 *
 * 重复项追加 ` 2` ` 3` 后缀，而不是随机串 —— 保持可读且在多次生成之间稳定。
 */
export function ensureUniqueNames(nodes: readonly ProxyNode[]): ProxyNode[] {
  const used = new Set<string>();
  return nodes.map((node) => {
    // 名字为空也要兜底，否则客户端会显示一个无法选中的空条目
    const base = node.name.trim() || `${node.server}:${node.port}`;
    if (!used.has(base)) {
      used.add(base);
      return base === node.name ? node : { ...node, name: base };
    }
    let n = 2;
    let candidate = `${base} ${n}`;
    while (used.has(candidate)) {
      n++;
      candidate = `${base} ${n}`;
    }
    used.add(candidate);
    return { ...node, name: candidate };
  });
}
