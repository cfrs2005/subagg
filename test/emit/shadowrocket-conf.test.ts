import { describe, expect, it } from 'vitest';
import { emitShadowrocketConf } from '../../src/core/emit/shadowrocket-conf.js';
import type { Orchestration } from '../../src/core/orchestrate.js';
import type { ProxyNode } from '../../src/core/types.js';
import { makeNode } from '../helpers.js';

const nodes: ProxyNode[] = [
  makeNode({
    type: 'ss',
    name: 'DMIT-VIA-US-LOS-CG',
    server: 'dmit.example.com',
    port: 443,
    cipher: 'aes-128-gcm',
    password: 'pw',
  }),
  makeNode({
    type: 'trojan',
    name: 'GANBEI-VIA-TXSH',
    server: 'gb.example.com',
    port: 443,
    password: 'pw',
    transport: { network: 'tcp' },
    tls: { enabled: true, sni: 'gb.example.com' },
  }),
];

const ORCHESTRATION: Orchestration = {
  groups: [
    {
      name: 'GOOGLE',
      type: 'fallback',
      members: [{ kind: 'nodes', select: { nameRegex: 'DMIT-' } }],
      preferred: ['DMIT-VIA-US-LOS-CG'],
      url: 'http://www.gstatic.com/generate_204',
      interval: 600,
    },
    { name: 'PROXY', type: 'select', members: [{ kind: 'nodes', select: {} }] },
  ],
  providers: {
    openai: {
      url: 'https://example.com/openai.list',
      behavior: 'classical',
    },
  },
  rules: [
    { type: 'DOMAIN-SUFFIX', value: 'gs-robot.com', policy: 'DIRECT' },
    { type: 'RULE-SET', value: 'openai', policy: 'PROXY' },
    { type: 'MATCH', policy: 'PROXY' },
  ],
  dns: {
    nameserver: ['https://doh.pub/dns-query'],
    nameserverPolicy: { '+.gs-robot.com': 'https://doh.pub/dns-query' },
  },
  hosts: { 'doh.pub': '1.12.12.12' },
  ipv6: false,
};

describe('emitShadowrocketConf', () => {
  it('把编排翻译成 Shadowrocket conf：分组引用真实节点名，MATCH 变 FINAL，RULE-SET 回填 URL', () => {
    const result = emitShadowrocketConf(nodes, {
      orchestration: ORCHESTRATION,
      confUrl: 'https://sub.example.com/t?target=shadowrocket.conf',
      subUrl: 'https://sub.example.com/t',
    });

    // ── [General] ──
    expect(result.body).toContain('update-url = https://sub.example.com/t?target=shadowrocket.conf');
    expect(result.body).toContain('dns-server = https://doh.pub/dns-query');
    expect(result.body).toContain('ipv6 = false');

    // ── [Proxy Group] ── preferred 顺序 + 测速参数。
    expect(result.body).toContain(
      'GOOGLE = fallback,DMIT-VIA-US-LOS-CG,url=http://www.gstatic.com/generate_204,interval=600',
    );
    expect(result.body).toContain('PROXY = select,DMIT-VIA-US-LOS-CG,GANBEI-VIA-TXSH');

    // ── [Rule] ── FINAL 置尾；RULE-SET 用 provider 的原始 URL。
    expect(result.body).toContain('DOMAIN-SUFFIX,gs-robot.com,DIRECT');
    expect(result.body).toContain('RULE-SET,https://example.com/openai.list,PROXY');
    expect(result.body).toContain('FINAL,PROXY');
    expect(result.body).not.toContain('RULE-SET,openai,');

    // ── [Host] ── nameserver-policy 与静态 hosts 都反向翻译。
    expect(result.body).toContain('*.gs-robot.com = server:https://doh.pub/dns-query');
    expect(result.body).toContain('doh.pub = 1.12.12.12');

    // 节点订阅 URL 只出现在头部注释里，conf 本体不内嵌节点。
    expect(result.body.startsWith('#')).toBe(true);
    expect(result.body).toContain('# 节点订阅：https://sub.example.com/t');
    expect(result.nodeCount).toBe(2);
  });

  it('没有编排时输出最小可用 conf', () => {
    const result = emitShadowrocketConf(nodes, {});

    expect(result.body).toContain('PROXY = select,DMIT-VIA-US-LOS-CG,GANBEI-VIA-TXSH');
    expect(result.body).toContain('FINAL,PROXY');
    expect(result.body).not.toContain('[Host]');
  });

  it('节点名含逗号时从分组剔除并给出警告，而不是生成非法 conf', () => {
    const bad = makeNode({
      type: 'ss',
      name: '逗,号节点',
      server: 'bad.example.com',
      port: 443,
      cipher: 'aes-128-gcm',
      password: 'pw',
    });

    const result = emitShadowrocketConf([...nodes, bad], {
      orchestration: ORCHESTRATION,
    });

    expect(result.body).not.toContain('逗,号节点');
    expect(result.warnings?.some((warning) => warning.includes('逗'))).toBe(true);
    // 合法节点不受影响。
    expect(result.body).toContain('GANBEI-VIA-TXSH');
  });

  it('能力过滤照常生效：conf 引用的节点集合与订阅一致', () => {
    const vless = makeNode({
      type: 'vless',
      name: 'VLESS-ONLY',
      server: 'vless.example.com',
      port: 443,
      uuid: '11111111-2222-3333-4444-555555555555',
      transport: { network: 'tcp' },
    });

    // shadowrocket.conf 目标的协议面与 shadowrocket 相同，VLESS 可用；
    // 但链式 VLESS 不在可链式集合里，会被跳过 —— 这里用普通 VLESS 验证放行。
    const result = emitShadowrocketConf([...nodes, vless], { orchestration: ORCHESTRATION });
    expect(result.nodeCount).toBe(3);
    expect(result.body).toContain('VLESS-ONLY');
  });
});
