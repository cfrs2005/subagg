import { describe, expect, it } from 'vitest';
import { applyFilter, compileUserRegex, type FilterRule } from '../src/core/filter.js';
import type { ProxyNode } from '../src/core/types.js';
import { makeNode } from './helpers.js';

/** 构造一批覆盖常见情况的测试节点。 */
function fixture(): ProxyNode[] {
  return [
    makeNode(
      {
        type: 'vless',
        name: '🇭🇰 香港 01 IEPL',
        server: 'hk1.example.com',
        port: 443,
        uuid: 'u1',
        transport: { network: 'tcp' },
      },
      { region: 'HK', sourceId: 's1', sourceName: '机场甲' },
    ),
    makeNode(
      {
        type: 'trojan',
        name: '🇭🇰 香港 02',
        server: 'hk2.example.com',
        port: 443,
        password: 'p2',
        transport: { network: 'tcp' },
        tls: { enabled: true },
      },
      { region: 'HK', sourceId: 's1', sourceName: '机场甲' },
    ),
    makeNode(
      {
        type: 'vmess',
        name: '🇯🇵 日本 01',
        server: 'jp1.example.com',
        port: 443,
        uuid: 'u3',
        alterId: 0,
        cipher: 'auto',
        transport: { network: 'tcp' },
      },
      { region: 'JP', sourceId: 's2', sourceName: '机场乙' },
    ),
    makeNode(
      {
        type: 'ss',
        name: '🇺🇸 美国 01',
        server: 'us1.example.com',
        port: 8388,
        cipher: 'aes-256-gcm',
        password: 'p4',
      },
      { region: 'US', sourceId: 's2', sourceName: '机场乙' },
    ),
    // 机场普遍塞入的"信息节点"—— 不是真节点，只是拿来显示文字的占位
    makeNode(
      {
        type: 'ss',
        name: '剩余流量：87.3 GB',
        server: 'info.example.com',
        port: 1,
        cipher: 'aes-256-gcm',
        password: 'x',
      },
      { sourceId: 's2', sourceName: '机场乙' },
    ),
    makeNode(
      {
        type: 'ss',
        name: '官网：example.com',
        server: 'info.example.com',
        port: 2,
        cipher: 'aes-256-gcm',
        password: 'x',
      },
      { sourceId: 's2', sourceName: '机场乙' },
    ),
  ];
}

const names = (nodes: readonly ProxyNode[]): string[] => nodes.map((n) => n.name);

describe('内置信息节点排除', () => {
  it('默认生效，并单独计数', () => {
    // 不过滤的话，生成的配置里会混满"剩余流量""官网"这类伪节点，
    // 在客户端的节点列表里非常碍眼，还会干扰自动测速分组。
    const out = applyFilter(fixture(), {});
    expect(out.stats.droppedByDefaultExclude).toBe(2);
    expect(out.nodes).toHaveLength(4);
    expect(names(out.nodes)).not.toContain('剩余流量：87.3 GB');
  });

  it('可以关掉', () => {
    const out = applyFilter(fixture(), { useDefaultExclude: false });
    expect(out.nodes).toHaveLength(6);
    expect(out.stats.droppedByDefaultExclude).toBe(0);
  });
});

describe('维度筛选', () => {
  it('按地区', () => {
    const out = applyFilter(fixture(), { regions: ['HK'] });
    expect(names(out.nodes)).toEqual(['🇭🇰 香港 01 IEPL', '🇭🇰 香港 02']);
  });

  it('按协议', () => {
    const out = applyFilter(fixture(), { types: ['vless', 'trojan'] });
    expect(out.nodes).toHaveLength(2);
  });

  it('按订阅源', () => {
    const out = applyFilter(fixture(), { sources: ['s1'] });
    expect(out.nodes).toHaveLength(2);
  });

  it('地区推断不出的节点会被地区筛选排除', () => {
    const out = applyFilter(fixture(), { regions: ['HK', 'JP', 'US'], useDefaultExclude: false });
    // 两个信息节点没有地区，被排除
    expect(out.nodes).toHaveLength(4);
  });
});

describe('include / exclude', () => {
  it('exclude 优先于 include', () => {
    // 这个优先级是刻意的：exclude 表达的是更强的意愿。
    // 反过来的话，"要所有香港节点但不要 IEPL"这种最常见的组合就写不出来了。
    const rule: FilterRule = {
      include: [{ field: 'region', op: 'eq', value: 'HK' }],
      exclude: [{ field: 'name', op: 'contains', value: 'IEPL' }],
    };
    const out = applyFilter(fixture(), rule);
    expect(names(out.nodes)).toEqual(['🇭🇰 香港 02']);
  });

  it('正则匹配', () => {
    const out = applyFilter(fixture(), {
      include: [{ field: 'name', op: 'regex', value: '香港|日本' }],
    });
    expect(out.nodes).toHaveLength(3);
  });

  it('写坏的正则被忽略并产生警告，而不是让整个请求失败', () => {
    const out = applyFilter(fixture(), {
      include: [{ field: 'name', op: 'regex', value: '[unclosed' }],
    });
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain('正则语法错误');
    // 规则被当作"不匹配"处理，所以没有节点通过 include
    expect(out.nodes).toHaveLength(0);
  });
});

describe('手动勾选（pick）', () => {
  it('only 模式：所见即所得，忽略其余筛选条件', () => {
    const all = fixture();
    const picked = [all[0]!.fingerprint, all[3]!.fingerprint];
    const out = applyFilter(all, {
      pick: picked,
      // 这些条件在 only 模式下应当被完全忽略
      regions: ['JP'],
      types: ['vmess'],
    });
    expect(names(out.nodes)).toEqual(['🇭🇰 香港 01 IEPL', '🇺🇸 美国 01']);
  });

  it('only 模式下不套用内置排除规则', () => {
    // 用户明确勾了这个节点，哪怕名字里带"官网"，那也是用户的选择。
    const all = fixture();
    const infoNode = all[5]!;
    const out = applyFilter(all, { pick: [infoNode.fingerprint] });
    expect(names(out.nodes)).toEqual(['官网：example.com']);
  });

  it('union 模式：规则结果 ∪ 勾选节点', () => {
    const all = fixture();
    const out = applyFilter(all, {
      regions: ['HK'],
      pick: [all[3]!.fingerprint], // 美国节点
      pickMode: 'union',
    });
    expect(names(out.nodes).sort()).toEqual(
      ['🇭🇰 香港 01 IEPL', '🇭🇰 香港 02', '🇺🇸 美国 01'].sort(),
    );
  });

  it('指纹在节点改名后依然有效', () => {
    // 这正是用指纹而不是名字做主键的理由：上游订阅每隔几小时刷新一次，
    // 机场随时会改名。用名字做主键的话，用户的勾选会在第一次刷新后全部失效。
    const before = fixture();
    const target = before[0]!;

    const afterRename = makeNode(
      {
        type: 'vless',
        name: '🇭🇰 HongKong-Premium-01', // 改名了
        server: 'hk1.example.com',
        port: 443,
        uuid: 'u1',
        transport: { network: 'tcp' },
      },
      { region: 'HK', sourceId: 's1', sourceName: '机场甲' },
    );

    expect(afterRename.fingerprint).toBe(target.fingerprint);

    const out = applyFilter([afterRename], { pick: [target.fingerprint] });
    expect(out.nodes).toHaveLength(1);
  });
});

describe('去重', () => {
  it('server-port 模式合并同一台机器', () => {
    const dup = makeNode(
      {
        type: 'trojan',
        name: '另一个机场转售的同一台机器',
        server: 'hk1.example.com',
        port: 443,
        password: 'different',
        transport: { network: 'tcp' },
        tls: { enabled: true },
      },
      { region: 'HK', sourceId: 's3', sourceName: '机场丙' },
    );

    const out = applyFilter([...fixture(), dup], { dedupe: 'server-port', regions: ['HK'] });
    expect(out.stats.droppedByDedupe).toBe(1);
    expect(out.nodes).toHaveLength(2);
  });

  it('fingerprint 模式只合并凭据完全相同的节点', () => {
    const dup = makeNode(
      {
        type: 'trojan',
        name: '凭据不同',
        server: 'hk1.example.com',
        port: 443,
        password: 'different',
        transport: { network: 'tcp' },
        tls: { enabled: true },
      },
      { region: 'HK', sourceId: 's3', sourceName: '机场丙' },
    );
    const out = applyFilter([...fixture(), dup], { dedupe: 'fingerprint', regions: ['HK'] });
    expect(out.stats.droppedByDedupe).toBe(0);
    expect(out.nodes).toHaveLength(3);
  });
});

describe('排序与截断', () => {
  it('按地区排序，同地区内按名字', () => {
    const out = applyFilter(fixture(), { sort: 'region' });
    expect(out.nodes.map((n) => n.meta.region)).toEqual(['HK', 'HK', 'JP', 'US']);
  });

  it('名字里的数字按数值比较', () => {
    // 否则 "01" < "10" < "2"，节点列表看起来是乱的
    const nodes = ['节点 2', '节点 10', '节点 1'].map((name, i) =>
      makeNode({
        type: 'ss',
        name,
        server: `s${i}.example.com`,
        port: 8388,
        cipher: 'aes-256-gcm',
        password: 'p',
      }),
    );
    const out = applyFilter(nodes, { sort: 'name' });
    expect(names(out.nodes)).toEqual(['节点 1', '节点 2', '节点 10']);
  });

  it('limit 截断并计数', () => {
    const out = applyFilter(fixture(), { limit: 2 });
    expect(out.nodes).toHaveLength(2);
    expect(out.stats.droppedByLimit).toBe(2);
  });
});

describe('重命名', () => {
  it('整体模板替换', () => {
    const out = applyFilter(fixture(), {
      regions: ['HK'],
      sort: 'name',
      rename: [{ replace: '{flag} {regionZh} {index2}' }],
    });
    expect(names(out.nodes)).toEqual(['🇭🇰 香港 01', '🇭🇰 香港 02']);
  });

  it('index 反映截断后的最终位置', () => {
    // 重命名放在排序与截断之后执行，序号才是 1..limit 连续的
    const out = applyFilter(fixture(), {
      sort: 'region',
      limit: 3,
      rename: [{ replace: '节点{index}' }],
    });
    expect(names(out.nodes)).toEqual(['节点1', '节点2', '节点3']);
  });

  it('正则替换保留捕获组', () => {
    const out = applyFilter(fixture(), {
      regions: ['HK'],
      rename: [{ pattern: '香港 (\\d+)', replace: 'HK-$1' }],
    });
    expect(names(out.nodes)[0]).toContain('HK-01');
  });

  it('重命名造成重名时自动去重', () => {
    // Clash 要求 proxies 的 name 全局唯一，重名会让客户端拒绝加载整份配置。
    // 而"把一批节点统一改成 {flag} {regionZh}"是最常见的重命名写法，
    // 必然制造重名 —— 所以这一步是正确性要求，不是锦上添花。
    const out = applyFilter(fixture(), {
      regions: ['HK'],
      rename: [{ replace: '{flag} {regionZh}' }],
    });
    expect(names(out.nodes)).toEqual(['🇭🇰 香港', '🇭🇰 香港 2']);
    expect(new Set(names(out.nodes)).size).toBe(out.nodes.length);
  });
});

describe('正则安全', () => {
  it('拒绝嵌套量词', () => {
    // (a+)+ 这类模式配上特定输入会造成指数级回溯，单条规则就能打满 CPU。
    // 这是缓解而非根治，完备方案需要 RE2；信任模型见 SECURITY.md。
    const result = compileUserRegex('(a+)+$');
    expect(result).toHaveProperty('error');
  });

  it('拒绝超长正则', () => {
    const result = compileUserRegex('a'.repeat(201));
    expect(result).toHaveProperty('error');
  });

  it('正常正则可以编译', () => {
    const result = compileUserRegex('香港|HK');
    expect(result).toHaveProperty('re');
  });
});

describe('统计', () => {
  it('各阶段的丢弃数量可追溯', () => {
    // 用户最常问"为什么我的节点少了"。有分阶段统计，界面上才能直接回答。
    const out = applyFilter(fixture(), { regions: ['HK'], limit: 1 });
    expect(out.stats.input).toBe(6);
    expect(out.stats.output).toBe(1);
    expect(out.stats.droppedByDefaultExclude).toBe(2);
    expect(out.stats.droppedByLimit).toBe(1);
    expect(out.stats.droppedBySelect).toBe(2);
  });
});
