import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { emitClash } from '../../src/core/emit/clash.js';
import { resolveOrchestration, type Orchestration } from '../../src/core/orchestrate.js';
import { IOS_MIGRATED, findOrchestrationPreset } from '../../src/core/orchestrate-presets.js';
import type { ProxyNode } from '../../src/core/types.js';
import { makeNode } from '../helpers.js';

const dmit = (): ProxyNode =>
  makeNode({
    type: 'ss',
    name: 'DMIT-VIA-US-LOS-CG',
    server: 'dmit.example.com',
    port: 443,
    cipher: 'aes-128-gcm',
    password: 'pw',
  });

const dmitBackup = (): ProxyNode =>
  makeNode({
    type: 'ss',
    name: 'DMIT-SS2022',
    server: 'dmit2.example.com',
    port: 443,
    cipher: 'aes-128-gcm',
    password: 'pw',
  });

const verizon = (): ProxyNode =>
  makeNode({
    type: 'trojan',
    name: 'VERIZON-VIA-BWG',
    server: 'vz.example.com',
    port: 443,
    password: 'pw',
    transport: { network: 'tcp' },
    tls: { enabled: true, sni: 'vz.example.com' },
  });

const ganbei = (): ProxyNode =>
  makeNode({
    type: 'trojan',
    name: 'GANBEI-VIA-TXSH',
    server: 'gb.example.com',
    port: 443,
    password: 'pw',
    transport: { network: 'tcp' },
    tls: { enabled: true, sni: 'gb.example.com' },
  });

const nodes = [dmit(), dmitBackup(), verizon(), ganbei()];

function minimal(overrides: Partial<Orchestration> = {}): Orchestration {
  return {
    groups: [
      {
        name: 'PROXY',
        type: 'select',
        members: [{ kind: 'nodes', select: {} }],
      },
    ],
    rules: [{ type: 'MATCH', policy: 'PROXY' }],
    ...overrides,
  };
}

describe('resolveOrchestration', () => {
  it('按 preferred 把首选节点提到最前', () => {
    const resolved = resolveOrchestration(nodes, {
      groups: [
        {
          name: 'GOOGLE',
          type: 'fallback',
          members: [{ kind: 'nodes', select: { nameRegex: 'DMIT-' } }],
          preferred: ['DMIT-SS2022'],
        },
      ],
      rules: [{ type: 'MATCH', policy: 'GOOGLE' }],
    });

    expect(resolved.groups).toHaveLength(1);
    expect(resolved.groups[0]?.proxies).toEqual(['DMIT-SS2022', 'DMIT-VIA-US-LOS-CG']);
    expect(resolved.groups[0]?.type).toBe('fallback');
  });

  it('丢弃空分组，并丢掉引用它的规则', () => {
    const resolved = resolveOrchestration(nodes, {
      groups: [
        { name: 'EMPTY', type: 'select', members: [{ kind: 'nodes', select: { nameRegex: 'NOPE' } }] },
        { name: 'PROXY', type: 'select', members: [{ kind: 'nodes', select: {} }] },
      ],
      rules: [
        { type: 'DOMAIN-SUFFIX', value: 'example.com', policy: 'EMPTY' },
        { type: 'MATCH', policy: 'EMPTY' },
      ],
    });

    expect(resolved.groups.map((group) => group.name)).toEqual(['PROXY']);
    // 指向空组的普通规则被丢弃；MATCH 不能丢，改为默认分组。
    expect(resolved.rules).toEqual(['MATCH,PROXY']);
    expect(resolved.warnings.some((warning) => warning.includes('EMPTY'))).toBe(true);
  });

  it('onEmpty=direct 的分组在成员全被丢弃后退化为直连', () => {
    const resolved = resolveOrchestration(nodes, {
      groups: [
        { name: 'EMPTY', type: 'select', members: [{ kind: 'nodes', select: { nameRegex: 'NOPE' } }] },
        {
          name: 'FALLBACK',
          type: 'select',
          members: [{ kind: 'group', name: 'EMPTY' }],
          onEmpty: 'direct',
        },
      ],
      rules: [{ type: 'MATCH', policy: 'FALLBACK' }],
    });

    const fallback = resolved.groups.find((group) => group.name === 'FALLBACK');
    expect(fallback?.proxies).toEqual(['DIRECT']);
    expect(resolved.rules).toEqual(['MATCH,FALLBACK']);
  });

  it('分组名与节点重名时丢弃分组', () => {
    const resolved = resolveOrchestration(nodes, {
      groups: [
        { name: 'DMIT-VIA-US-LOS-CG', type: 'select', members: [{ kind: 'nodes', select: {} }] },
        { name: 'PROXY', type: 'select', members: [{ kind: 'nodes', select: {} }] },
      ],
      rules: [{ type: 'MATCH', policy: 'PROXY' }],
    });

    expect(resolved.groups.map((group) => group.name)).toEqual(['PROXY']);
    expect(resolved.warnings.some((warning) => warning.includes('重名'))).toBe(true);
  });

  it('对损坏的编排做运行时防御而不是抛异常', () => {
    const resolved = resolveOrchestration(nodes, {
      groups: [
        null,
        { name: 'BROKEN', type: 'select', members: 'not-an-array' },
      ],
      rules: [null, { type: 'MATCH', policy: 'BROKEN' }],
    } as never);

    // 坏分组被丢弃，MATCH 回落 DIRECT；整条链路不抛异常。
    expect(resolved.groups).toEqual([]);
    expect(resolved.rules).toEqual(['MATCH,DIRECT']);
  });

  it('MATCH 永远排在最后，即使输入写在中间', () => {
    const resolved = resolveOrchestration(nodes, {
      groups: [{ name: 'PROXY', type: 'select', members: [{ kind: 'nodes', select: {} }] }],
      rules: [
        { type: 'MATCH', policy: 'PROXY' },
        { type: 'DOMAIN-SUFFIX', value: 'example.com', policy: 'DIRECT' },
      ],
    });

    expect(resolved.rules.at(-1)).toBe('MATCH,PROXY');
    expect(resolved.rules).toContain('DOMAIN-SUFFIX,example.com,DIRECT');
  });

  it('断开分组的循环引用', () => {
    const resolved = resolveOrchestration(nodes, {
      groups: [
        {
          name: 'A',
          type: 'select',
          members: [{ kind: 'group', name: 'B' }, { kind: 'nodes', select: { nameRegex: 'DMIT' } }],
        },
        {
          name: 'B',
          type: 'select',
          members: [{ kind: 'group', name: 'A' }, { kind: 'nodes', select: { nameRegex: 'GANBEI' } }],
        },
      ],
      rules: [{ type: 'MATCH', policy: 'A' }],
    });

    const a = resolved.groups.find((group) => group.name === 'A');
    const b = resolved.groups.find((group) => group.name === 'B');
    // 两个组本身有节点成员，所以断环后仍然存活；只是不能再互相引用。
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a?.proxies.includes('B') && b?.proxies.includes('A')).toBe(false);
    expect(resolved.warnings.some((warning) => warning.includes('循环引用'))).toBe(true);
  });

  it('输出被引用的 rule-provider，并拒绝未声明的引用', () => {
    const resolved = resolveOrchestration(nodes, {
      groups: [{ name: 'PROXY', type: 'select', members: [{ kind: 'nodes', select: {} }] }],
      providers: {
        openai: { url: 'https://example.com/openai.list', behavior: 'classical' },
      },
      rules: [
        { type: 'RULE-SET', value: 'openai', policy: 'PROXY' },
        { type: 'RULE-SET', value: 'missing', policy: 'PROXY' },
        { type: 'MATCH', policy: 'PROXY' },
      ],
    });

    expect(Object.keys(resolved.providers)).toEqual(['openai']);
    expect(resolved.providers['openai']?.path).toBe('./rules/openai.txt');
    expect(resolved.rules).toContain('RULE-SET,openai,PROXY');
    expect(resolved.rules.some((line) => line.includes('missing'))).toBe(false);
  });

  it('把 DNS 转成 mihomo 字段', () => {
    const resolved = resolveOrchestration(nodes, {
      ...minimal(),
      dns: {
        nameserver: ['https://doh.pub/dns-query'],
        enhancedMode: 'redir-host',
        nameserverPolicy: { '+.gs-robot.com': 'https://doh.pub/dns-query' },
      },
      ipv6: false,
    });

    expect(resolved.dns).toMatchObject({
      enable: true,
      'enhanced-mode': 'redir-host',
      nameserver: ['https://doh.pub/dns-query'],
      'nameserver-policy': { '+.gs-robot.com': 'https://doh.pub/dns-query' },
    });
    expect(resolved.ipv6).toBe(false);
  });
});

describe('emitClash 与编排', () => {
  it('使用编排替换内置分组，并输出 DNS / providers', () => {
    const result = emitClash(nodes, {
      target: 'clash.meta',
      orchestration: {
        groups: [
          {
            name: 'AI',
            type: 'select',
            members: [{ kind: 'nodes', select: { nameRegex: 'GANBEI' } }],
          },
          { name: 'PROXY', type: 'select', members: [{ kind: 'nodes', select: {} }] },
        ],
        providers: {
          openai: { url: 'https://example.com/openai.list', behavior: 'classical' },
        },
        rules: [
          { type: 'RULE-SET', value: 'openai', policy: 'AI' },
          { type: 'MATCH', policy: 'PROXY' },
        ],
        dns: { nameserver: ['https://doh.pub/dns-query'] },
        hosts: { 'doh.pub': '1.12.12.12' },
        ipv6: false,
      },
    });

    const config = parseYaml(result.body) as Record<string, unknown>;
    expect(config['proxy-groups']).toEqual([
      { name: 'AI', type: 'select', proxies: ['GANBEI-VIA-TXSH'] },
      {
        name: 'PROXY',
        type: 'select',
        proxies: ['DMIT-VIA-US-LOS-CG', 'DMIT-SS2022', 'VERIZON-VIA-BWG', 'GANBEI-VIA-TXSH'],
      },
    ]);
    expect(config['rule-providers']).toMatchObject({
      openai: { type: 'http', behavior: 'classical', path: './rules/openai.txt' },
    });
    expect(config['rules']).toEqual(['RULE-SET,openai,AI', 'MATCH,PROXY']);
    expect(config['dns']).toMatchObject({ enable: true, nameserver: ['https://doh.pub/dns-query'] });
    expect(config['hosts']).toEqual({ 'doh.pub': '1.12.12.12' });
    expect(config['ipv6']).toBe(false);
  });

  it('mihomo 原生顶层：手动选择持久化、域名嗅探、延迟口径', () => {
    const result = emitClash(nodes, {
      target: 'clash.meta',
      orchestration: {
        groups: [{ name: 'PROXY', type: 'select', members: [{ kind: 'nodes', select: {} }] }],
        rules: [{ type: 'MATCH', policy: 'PROXY' }],
      },
    });

    const config = parseYaml(result.body) as Record<string, unknown>;
    // 少了 store-selected，订阅一刷新手动选的出口就被重置 —— 这是从
    // Shadowrocket 迁过来最刺眼的差异。
    expect(config['profile']).toEqual({ 'store-selected': true, 'store-fake-ip': true });
    expect(config['unified-delay']).toBe(true);
    expect(config['tcp-concurrent']).toBe(true);
    expect(config['sniffer']).toMatchObject({ enable: true, 'parse-pure-ip': true });

    // 原版 Clash 内核不认这些键，多写会让整份配置加载失败。
    const plain = emitClash(nodes, { target: 'clash' });
    const plainConfig = parseYaml(plain.body) as Record<string, unknown>;
    expect(plainConfig['profile']).toBeUndefined();
    expect(plainConfig['sniffer']).toBeUndefined();
    expect(plainConfig['unified-delay']).toBeUndefined();
  });

  it('DNS：保留 #策略名、补齐 bootstrap DNS、直连域名进 fake-ip-filter', () => {
    const result = emitClash(nodes, {
      target: 'clash.meta',
      orchestration: {
        groups: [{ name: 'PROXY', type: 'select', members: [{ kind: 'nodes', select: {} }] }],
        rules: [
          { type: 'DOMAIN-SUFFIX', value: 'gs-robot.com', policy: 'DIRECT' },
          { type: 'MATCH', policy: 'PROXY' },
        ],
        dns: {
          nameserver: ['https://dns.google/dns-query#PROXY'],
          fakeIpFilter: ['+.20260401.xyz'],
        },
      },
    });

    const dns = (parseYaml(result.body) as Record<string, Record<string, unknown>>)['dns']!;
    // `#proxy` 不是"无法表达"：mihomo 用 `#策略名`，丢后缀会让 DoH 退回直连解析。
    expect(dns['nameserver']).toEqual(['https://dns.google/dns-query#PROXY']);
    expect(dns['default-nameserver']).toEqual(['223.5.5.5', '119.29.29.29']);
    expect(dns['proxy-server-nameserver']).toEqual(['223.5.5.5', '119.29.29.29']);
    // 规则说直连，DNS 就必须给真实 IP，否则内网域名拿到 198.18.x.x 谁都不认识。
    expect(dns['fake-ip-filter']).toEqual(['+.20260401.xyz', '+.gs-robot.com']);
  });

  it('DNS 出口指向不存在的策略时剥掉后缀并告警', () => {
    const result = emitClash(nodes, {
      target: 'clash.meta',
      orchestration: {
        groups: [{ name: 'PROXY', type: 'select', members: [{ kind: 'nodes', select: {} }] }],
        rules: [{ type: 'MATCH', policy: 'PROXY' }],
        dns: { nameserver: ['https://dns.google/dns-query#NOPE'] },
      },
    });

    const dns = (parseYaml(result.body) as Record<string, Record<string, unknown>>)['dns']!;
    expect(dns['nameserver']).toEqual(['https://dns.google/dns-query']);
    expect(result.warnings?.some((warning) => warning.includes('NOPE'))).toBe(true);
  });

  it('ruleProxyBase 把 rule-providers 指向本站转换端点', () => {
    const result = emitClash(nodes, {
      target: 'clash.meta',
      ruleProxyBase: 'https://sub.example.com/r/TOKEN',
      orchestration: {
        groups: [{ name: 'PROXY', type: 'select', members: [{ kind: 'nodes', select: {} }] }],
        providers: {
          openai: { url: 'https://upstream.example.com/openai.list', behavior: 'classical' },
        },
        rules: [
          { type: 'RULE-SET', value: 'openai', policy: 'PROXY' },
          { type: 'MATCH', policy: 'PROXY' },
        ],
      },
    });

    const config = parseYaml(result.body) as Record<string, unknown>;
    expect(config['rule-providers']).toMatchObject({
      openai: {
        url: 'https://sub.example.com/r/TOKEN/openai',
        // 规则集在自家域名下，下载必须直连：否则「用规则决定怎么下规则」死锁。
        proxy: 'DIRECT',
        // 不显式写 format，mihomo 会按 yaml 解析纯文本，静默得到空集。
        format: 'text',
      },
    });
  });

  it('规则集缺省格式必须是 text，否则 mihomo 按 yaml 解析成空集', () => {
    const result = emitClash(nodes, {
      target: 'clash.meta',
      orchestration: {
        groups: [{ name: 'PROXY', type: 'select', members: [{ kind: 'nodes', select: {} }] }],
        providers: {
          openai: { url: 'https://upstream.example.com/openai.list', behavior: 'classical' },
        },
        rules: [
          { type: 'RULE-SET', value: 'openai', policy: 'PROXY' },
          { type: 'MATCH', policy: 'PROXY' },
        ],
      },
    });

    const config = parseYaml(result.body) as Record<string, Record<string, { format?: string }>>;
    expect(config['rule-providers']?.['openai']?.format).toBe('text');
  });

  it('原版 Clash 目标忽略编排并给出警告', () => {
    const result = emitClash(nodes, {
      target: 'clash',
      orchestration: {
        groups: [{ name: '仅此一组', type: 'select', members: [{ kind: 'nodes', select: {} }] }],
        rules: [{ type: 'MATCH', policy: '仅此一组' }],
      },
    });

    const config = parseYaml(result.body) as Record<string, unknown>;
    expect(JSON.stringify(config['proxy-groups'])).toContain('节点选择');
    expect(result.warnings?.[0]).toContain('不是 Clash.Meta');
  });

  it('能力筛选之后才解析分组，跳过协议不会留在组里', () => {
    const vless = makeNode({
      type: 'vless',
      name: 'VLESS-ONLY',
      server: 'vless.example.com',
      port: 443,
      uuid: '11111111-2222-3333-4444-555555555555',
      transport: { network: 'tcp' },
    });

    const result = emitClash([...nodes, vless], {
      target: 'clash',
      orchestration: minimal({
        groups: [{ name: 'PROXY', type: 'select', members: [{ kind: 'nodes', select: {} }] }],
      }),
    });

    // 原版 Clash 会忽略编排，这里只断言 VLESS 没被塞进任何分组。
    const config = parseYaml(result.body) as Record<string, unknown>;
    expect(JSON.stringify(config['proxy-groups'])).not.toContain('VLESS-ONLY');
    expect(result.skipped.some((item) => item.name === 'VLESS-ONLY')).toBe(true);
  });
});

describe('内置预设', () => {
  it('ios-migrated 能在真实节点上解析出非空分组', () => {
    const preset = findOrchestrationPreset('ios-migrated');
    expect(preset).toBeTruthy();

    const resolved = resolveOrchestration(nodes, preset!.orchestration);
    const names = resolved.groups.map((group) => group.name);
    expect(names).toContain('PROXY');
    expect(names).toContain('GOOGLE');
    expect(names).toContain('AI-OPENAI');
    expect(resolved.rules.at(-1)).toBe('MATCH,PROXY');
    expect(resolved.hosts).toMatchObject({ 'doh.pub': '1.12.12.12' });
    // 所有规则引用的策略都必须存在，否则整份配置会被客户端拒绝。
    const policies = new Set([
      'DIRECT',
      'REJECT',
      ...names,
      ...nodes.map((node) => node.name),
    ]);
    for (const line of resolved.rules) {
      const parts = line.split(',');
      const policy = parts[0] === 'MATCH' ? parts[1] : parts[2];
      expect(policies.has(policy ?? '')).toBe(true);
    }
  });

  it('ios-migrated 是 conf 的忠实翻译：生产节点名（大小写不同、含同名前缀干扰项）下分组精确命中', () => {
    // 生产库里的真实拼写：混合大小写，且存在大量 DMIT-* / verizon-* 干扰节点。
    const prodLike: ProxyNode[] = [
      'DMIT-via-US-LOS-CG',
      'DMIT-ss2022',
      'DMIT-666-R-NTT',
      'DMIT-via-ATT-WireGuard',
      'DMIT-Vision',
      'IX_DMIT-666-R-NTT',
      'verizon-via-bwg',
      'verizon-via-txsh',
      'verizon-via-dmit',
      'GANBEI-via-TXSH',
      'GANBEI-via-DMIT',
      'IX_GANBEI-via-DMIT',
      '沪港专线转香港BGP[M][Trojan][倍率:1.7]',
    ].map((name) =>
      makeNode({
        type: 'ss',
        name,
        server: `${name}.example.com`,
        port: 443,
        cipher: 'aes-128-gcm',
        password: 'pw',
      }),
    );

    const resolved = resolveOrchestration(prodLike, IOS_MIGRATED);

    // GOOGLE 只含 conf 点名的两台 —— 不是所有 DMIT-*。
    const google = resolved.groups.find((group) => group.name === 'GOOGLE');
    expect(google?.type).toBe('fallback');
    expect(google?.proxies).toEqual(['DMIT-via-US-LOS-CG', 'DMIT-ss2022']);

    // 同一出口的 VERIZON 节点：组内自适应，不再拆 -AUTO。
    const claude = resolved.groups.find((group) => group.name === 'AI-CLAUDE');
    expect(claude?.type).toBe('url-test');
    expect(claude?.proxies).toEqual(['verizon-via-bwg', 'verizon-via-txsh', 'verizon-via-dmit']);

    // AI-OPENAI：精确两台，不含 IX_ 派生。
    const openai = resolved.groups.find((group) => group.name === 'AI-OPENAI');
    expect(openai?.proxies).toEqual(['GANBEI-via-TXSH', 'GANBEI-via-DMIT']);

    // 顶层 PROXY 只列服务器组 + 全部节点自动组，不再平铺节点。
    const proxy = resolved.groups.find((group) => group.name === 'PROXY');
    expect(proxy?.type).toBe('select');
    expect(proxy?.proxies).toEqual([
      '♻️ 自动选择',
      'GOOGLE',
      'AI-CLAUDE',
      'AI-OPENAI',
      'DIRECT',
    ]);
    expect(resolved.groups.some((group) => group.name.endsWith('-AUTO'))).toBe(false);

    // 指向具体节点的规则：大小写不同也要命中，并回写成真实节点名。
    expect(resolved.rules).toContain('DOMAIN-SUFFIX,drleao.cn,DMIT-via-US-LOS-CG');

    // 用户 conf 里没有的东西不能凭空出现。
    expect(JSON.stringify(resolved.groups)).not.toContain('-AUTO');
  });

  it('规则策略大小写不敏感归一：命中后回写真实节点名', () => {
    const resolved = resolveOrchestration(nodes, {
      groups: [{ name: 'PROXY', type: 'select', members: [{ kind: 'nodes', select: {} }] }],
      rules: [
        { type: 'DOMAIN-SUFFIX', value: 'example.com', policy: 'dmit-via-us-los-cg' },
        { type: 'MATCH', policy: 'PROXY' },
      ],
    });

    expect(resolved.rules).toContain('DOMAIN-SUFFIX,example.com,DMIT-VIA-US-LOS-CG');
    expect(resolved.warnings.some((warning) => warning.includes('仅大小写不同'))).toBe(true);
  });
});

describe('节点源模式（proxy-providers）', () => {
  it('分组成员写成 use + filter，节点名不再出现在 proxies 里', () => {
    const resolved = resolveOrchestration(
      nodes,
      {
        groups: [
          {
            name: 'AI',
            type: 'url-test',
            members: [{ kind: 'nodes', select: { nameRegex: '^GANBEI-' } }],
          },
          { name: 'PROXY', type: 'select', members: [{ kind: 'nodes', select: {} }] },
        ],
        rules: [{ type: 'MATCH', policy: 'PROXY' }],
      },
      { providerMode: true },
    );

    const ai = resolved.groups.find((group) => group.name === 'AI')!;
    expect(ai.use).toEqual(['subagg']);
    expect(ai.filter).toBe('(?i:^GANBEI-)');
    // url-test 绝不能有 DIRECT 兜底：它会参与测速，赢了就静默直连。
    expect(ai.proxies).toEqual([]);

    // 无约束选择器 = 全部节点，此时不该有 filter（有 filter 反而可能误伤）。
    const proxy = resolved.groups.find((group) => group.name === 'PROXY')!;
    expect(proxy.use).toEqual(['subagg']);
    expect(proxy.filter).toBeUndefined();
  });

  it('规则指向具体节点时自动生成单节点分组（否则客户端拒载）', () => {
    const resolved = resolveOrchestration(
      nodes,
      {
        groups: [{ name: 'PROXY', type: 'select', members: [{ kind: 'nodes', select: {} }] }],
        rules: [
          { type: 'DOMAIN-SUFFIX', value: 'drleao.cn', policy: 'DMIT-VIA-US-LOS-CG' },
          { type: 'MATCH', policy: 'PROXY' },
        ],
      },
      { providerMode: true },
    );

    const synthetic = resolved.groups.find((group) => group.name.startsWith('🔒'));
    expect(synthetic?.filter).toBe('(?i:^DMIT-VIA-US-LOS-CG$)');
    expect(synthetic?.use).toEqual(['subagg']);
    // 规则改成指向分组：provider 节点不在全局代理池里，直接写名字会加载失败。
    expect(resolved.rules).toContain(`DOMAIN-SUFFIX,drleao.cn,${synthetic!.name}`);
  });

  it('内联模式不受影响（.conf 与 ?style=inline 仍拿名单）', () => {
    const resolved = resolveOrchestration(nodes, {
      groups: [{ name: 'AI', type: 'select', members: [{ kind: 'nodes', select: { nameRegex: 'GANBEI' } }] }],
      rules: [{ type: 'MATCH', policy: 'AI' }],
    });

    const ai = resolved.groups[0]!;
    expect(ai.use).toBeUndefined();
    expect(ai.filter).toBeUndefined();
    expect(ai.proxies).toEqual(['GANBEI-VIA-TXSH']);
  });
});
