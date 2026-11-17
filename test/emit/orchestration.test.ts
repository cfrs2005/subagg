import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { emitClash } from '../../src/core/emit/clash.js';
import { resolveOrchestration, type Orchestration } from '../../src/core/orchestrate.js';
import { findOrchestrationPreset } from '../../src/core/orchestrate-presets.js';
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
    ]);
    for (const line of resolved.rules) {
      const parts = line.split(',');
      const policy = parts[0] === 'MATCH' ? parts[1] : parts[2];
      expect(policies.has(policy ?? '')).toBe(true);
    }
  });
});
