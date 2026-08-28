/**
 * core/filter.ts 管线顺序的逐输入对比 —— 回答变异测试回答不了的那个问题。
 *
 * 变异测试只告诉你「改错了测试还绿」。绿有两种原因，后续动作完全相反：
 *   A. 测试写得弱     → 补断言
 *   B. 不变量本身空转 → 改文档（那条理由是错的）
 * 这个脚本把变异实现与原实现喂同一批输入、逐字比对输出来区分两者。
 *
 * 2026-08-27 的审计用它证明了 CLAUDE.md 里三条管线顺序理由有两条接错了对象：
 *   「去重必须早于重命名（重命名抹掉区分信息）」→ 理由错（dedupeKey 从不读 name），
 *     但结论对：真正的原因是 {index} 连续性 + 与 limit 的交互，且这是唯一一条真不变量
 *   「截断必须早于重命名（{index} 才连续）」→ 在本实现下空转（前缀截断，取值一致）
 *   「exclude 优先于 include」→ 节点输出逐字相同，真正需要顺序的是归因统计
 * 详见 docs/20260827-死代码审计与剪枝台账.md 第 7 节。
 *
 * 用法：npx tsx scripts/audit/filter-order.mts
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');

// filter.ts 的整块代码，用于「把 A 搬到 B 之后」这类顺序变异。
// 与 scripts/audit/mutate.py 的同名常量保持一致 —— 改了这边记得改那边。
const EXCLUDE = `      if (rule.exclude?.length && rule.exclude.some((e) => matches(node, e, warnings))) {
        stats.droppedByExclude++;
        continue;
      }
`;
const INCLUDE = `      if (rule.include?.length && !rule.include.some((e) => matches(node, e, warnings))) {
        stats.droppedBySelect++;
        continue;
      }
`;
const LIMIT = `  if (rule.limit && rule.limit > 0 && selected.length > rule.limit) {
    stats.droppedByLimit = selected.length - rule.limit;
    selected = selected.slice(0, rule.limit);
  }
`;
const RENAME = `  if (rule.rename?.length) {
    selected = selected.map((node, i) => {
      const newName = applyRenameRules(node, rule.rename ?? [], i, warnings);
      return newName === node.name ? node : { ...node, name: newName };
    });
  }
`;
const DEDUPE = `  const dedupeMode = rule.dedupe ?? 'off';
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
`;

const VARIANTS: Array<[string, string, Array<[string, string]>]> = [
  ['M11', 'exclude 降到 include 之后', [[EXCLUDE, ''], [INCLUDE, INCLUDE + EXCLUDE]]],
  ['M12', '截断挪到重命名之后', [[LIMIT, ''], [RENAME, RENAME + LIMIT]]],
  ['M13', '去重挪到重命名之后', [[DEDUPE, ''], [RENAME, RENAME + DEDUPE]]],
];

const tmp = mkdtempSync(join(tmpdir(), 'subagg-order-'));
try {
  cpSync(join(REPO, 'src', 'core'), join(tmp, 'orig'), { recursive: true });
  for (const [id, , edits] of VARIANTS) {
    const dir = join(tmp, id);
    cpSync(join(REPO, 'src', 'core'), dir, { recursive: true });
    const fp = join(dir, 'filter.ts');
    let src = readFileSync(fp, 'utf8');
    for (const [old, next] of edits) {
      if (!src.includes(old)) throw new Error(`${id}: 在 filter.ts 里找不到锚点 —— 代码已改，本脚本需要更新`);
      src = src.replace(old, next);
    }
    writeFileSync(fp, src);
  }

  const orig = await import(join(tmp, 'orig', 'filter.ts'));
  const { computeFingerprint } = await import(join(tmp, 'orig', 'fingerprint.ts'));

  const n = (name: string, server: string, port: number, region: string) => {
    const d = { type: 'ss', name, server, port, cipher: 'aes-256-gcm', password: 'p' } as const;
    return {
      ...d,
      fingerprint: computeFingerprint(d as never),
      meta: { region, sourceId: 's1', sourceName: 'a', firstSeen: 1, lastSeen: 1 },
    } as never;
  };
  const nodes = [
    n('🇭🇰 香港 01 IEPL', 'hk1.example.com', 443, 'HK'),
    n('🇭🇰 香港 02', 'hk1.example.com', 443, 'HK'), // 与上一条 server:port 相同 → dedupe 会吃掉
    n('🇯🇵 日本 01', 'jp1.example.com', 443, 'JP'),
    n('🇺🇸 美国 01', 'us1.example.com', 8388, 'US'),
    n('🇺🇸 美国 02 IEPL', 'us2.example.com', 8388, 'US'),
    n('🇸🇬 新加坡 01', 'sg1.example.com', 443, 'SG'),
  ];

  const cases: Array<[string, unknown]> = [
    ['exclude+include 同时命中', {
      include: [{ field: 'name', op: 'contains', value: '香港' }],
      exclude: [{ field: 'name', op: 'contains', value: 'IEPL' }],
    }],
    ['limit+rename{index}', { sort: 'region', limit: 3, rename: [{ replace: '节点{index}' }] }],
    ['dedupe+rename{index}', { dedupe: 'server-port', rename: [{ replace: '节点{index}' }] }],
    ['dedupe+limit+rename', { dedupe: 'server-port', limit: 3, sort: 'region', rename: [{ replace: '{regionZh}-{index}' }] }],
  ];

  const sig = (r: { nodes: Array<{ name: string }>; stats: unknown }) =>
    JSON.stringify({ names: r.nodes.map((x) => x.name), stats: r.stats });

  let diffs = 0;
  for (const [id, what, ] of VARIANTS) {
    const mutated = await import(join(tmp, id, 'filter.ts'));
    for (const [label, rule] of cases) {
      const a = sig(orig.applyFilter(nodes, rule as never));
      const b = sig(mutated.applyFilter(nodes, rule as never));
      if (a !== b) {
        diffs++;
        console.log(`\n>>> ${id}（${what}）在「${label}」下行为不同`);
        console.log('    原始:', a);
        console.log('    变异:', b);
      }
    }
  }
  console.log(`\n共 ${VARIANTS.length} 个顺序变异 × ${cases.length} 组输入，${diffs} 处行为差异。`);
  console.log('未列出的组合 = 变异后输出逐字相同 → 那条顺序不变量在当前实现下不可 falsify（空转）。');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
