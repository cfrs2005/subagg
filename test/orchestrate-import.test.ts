import { describe, expect, it } from 'vitest';
import { parseShadowrocketConf } from '../src/core/orchestrate-import.js';
import { resolveOrchestration } from '../src/core/orchestrate.js';
import type { ProxyNode } from '../src/core/types.js';
import { makeNode } from './helpers.js';

const SAMPLE = `
# Shadowrocket: 2026-11-17 04:56:42
[General]
dns-server = https://cloudflare-dns.com/dns-query#proxy,https://dns.google/dns-query#proxy
fallback-dns-server = https://1.1.1.1/dns-query#proxy
skip-proxy = 192.168.0.0/16, 100.64.0.0/10, localhost,*.20260401.xyz,*.ai.gsbot.dev, git.gs-robot.com, jira.gs-robot.com, 1.2.3.4, e.]
ipv6 = false
prefer-ipv6 = false
dns-direct-system = true
bypass-system = true
tun-excluded-routes = 10.0.0.0/8,127.0.0.0/8

[Proxy Group]
GOOGLE = fallback,DMIT-VIA-US-LOS-CG,DMIT-SS2022,policy-select-name=DMIT-VIA-US-LOS-CG,interval=600,timeout=5,url=http://www.gstatic.com/generate_204
AI-CLAUDE = url-test,VERIZON-VIA-BWG,VERIZON-VIA-TXSH,policy-select-name=VERIZON-VIA-BWG,interval=600,tolerance=100
AI-OPENAI = url-test,GANBEI-VIA-TXSH,policy-select-name=GANBEI-VIA-TXSH,interval=600

[Rule]
DOMAIN-SUFFIX,chatgpt.site,AI-OPENAI
IP-CIDR,10.12.50.0/24,DIRECT,no-resolve
DOMAIN-SUFFIX,browser-intake-datadoghq.com,PROXY,extended-matching
DOMAIN-SUFFIX,gs-robot.com,DIRECT
USER-AGENT,MicroMessenger*,DIRECT
RULE-SET,https://raw.githubusercontent.com/cfrs2005/mantaray/main/rules/openai.list,AI-OPENAI
RULE-SET,https://github.com/cfrs2005/mantaray/blob/main/rules/dingTalk.list,DIRECT
DOMAIN-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/ChinaMaxNoIP/ChinaMaxNoIP_Domain.list,DIRECT
RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/ChinaMaxNoIP/ChinaMaxNoIP.list,DIRECT
GEOIP,CN,DIRECT
FINAL,PROXY

[Host]
*.feishu.cn = server:https://doh.pub/dns-query
*.gs-robot.com = server:https://doh.pub/dns-query
static.example.com = 1.2.3.4

[Proxy]
DIRECT = direct
`;

function nodes(): ProxyNode[] {
  const make = (name: string, server: string): ProxyNode =>
    makeNode({
      type: 'ss',
      name,
      server,
      port: 443,
      cipher: 'aes-128-gcm',
      password: 'pw',
    });
  return [
    make('DMIT-VIA-US-LOS-CG', 'dmit.example.com'),
    make('DMIT-SS2022', 'dmit2.example.com'),
    make('VERIZON-VIA-BWG', 'vz.example.com'),
    make('VERIZON-VIA-TXSH', 'vz2.example.com'),
    make('GANBEI-VIA-TXSH', 'gb.example.com'),
    make('OTHER', 'other.example.com'),
  ];
}

describe('parseShadowrocketConf', () => {
  it('解析分组、规则、DNS 与 skip-proxy', () => {
    const { orchestration, warnings } = parseShadowrocketConf(SAMPLE);

    // 顶层 PROXY 只列服务器组（Shadowrocket 的 PROXY = 当前出口），
    // 组内自适应；不再把每个节点平铺进来。
    const proxy = orchestration.groups.find((group) => group.name === 'PROXY');
    expect(proxy?.type).toBe('select');
    expect(
      proxy?.members.map((member) => (member.kind === 'group' ? member.name : member.kind)),
    ).toEqual(['♻️ 自动选择', 'GOOGLE', 'AI-CLAUDE', 'AI-OPENAI', 'policy']);

    const google = orchestration.groups.find((group) => group.name === 'GOOGLE');
    expect(google?.type).toBe('fallback');
    expect(google?.preferred).toEqual(['DMIT-VIA-US-LOS-CG']);
    expect(google?.url).toBe('http://www.gstatic.com/generate_204');
    expect(google?.interval).toBe(600);

    const claude = orchestration.groups.find((group) => group.name === 'AI-CLAUDE');
    expect(claude?.type).toBe('url-test');
    expect(claude?.tolerance).toBe(100);
    expect(claude?.preferred).toEqual(['VERIZON-VIA-BWG']);
    // 同一出口的节点由组内测速自适应，不再拆 -AUTO 子组。
    expect(orchestration.groups.some((group) => group.name.endsWith('-AUTO'))).toBe(false);

    // 没有 PROXY 分组但规则引用了它 → 自动补一个。
    expect(orchestration.groups.some((group) => group.name === 'PROXY')).toBe(true);

    // skip-proxy 的规则必须排在最前面，否则会被后面的代理规则截胡。
    expect(orchestration.rules.slice(0, 2).every((rule) => rule.policy === 'DIRECT')).toBe(true);
    // 裸 IP 要补成 /32 的 CIDR，否则 Clash 会把 1.2.3.4 当成域名。
    expect(
      orchestration.rules.some((rule) => rule.type === 'IP-CIDR' && rule.value === '1.2.3.4/32'),
    ).toBe(true);

    // FINAL 必须在最后，并且被转成 MATCH。
    const last = orchestration.rules.at(-1);
    expect(last).toMatchObject({ type: 'MATCH', policy: 'PROXY' });

    // extended-matching 被丢掉，但 no-resolve 保留下来。
    const ipcidr = orchestration.rules.find((rule) => rule.value === '10.12.50.0/24');
    expect(ipcidr?.noResolve).toBe(true);

    // RULE-SET 的 URL 变成 provider，规则值变成 provider key。
    const openai = orchestration.rules.find(
      (rule) => rule.type === 'RULE-SET' && rule.value === 'openai',
    );
    expect(openai?.policy).toBe('AI-OPENAI');
    expect(orchestration.providers?.['openai']?.behavior).toBe('classical');

    // 只含域名的列表必须用 behavior: domain。
    const chinaDomain = orchestration.rules.find(
      (rule) => rule.type === 'RULE-SET' && rule.value === 'chinamaxnoip_domain',
    );
    expect(chinaDomain).toBeTruthy();
    expect(orchestration.providers?.['chinamaxnoip_domain']?.behavior).toBe('domain');

    // [Host] 的 DoH 映射进入 nameserver-policy，静态 IP 进入顶层 hosts。
    expect(orchestration.dns?.nameserverPolicy).toMatchObject({
      '+.feishu.cn': 'https://doh.pub/dns-query',
      '+.gs-robot.com': 'https://doh.pub/dns-query',
    });
    expect(orchestration.hosts).toMatchObject({ 'static.example.com': '1.2.3.4' });
    expect(orchestration.ipv6).toBe(false);

    // 明确告诉用户哪些东西没迁移过去。
    expect(warnings.some((warning) => warning.includes('extended-matching'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('顶层 select'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('USER-AGENT'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('GitHub 网页地址'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('dns-server 支持 #proxy'))).toBe(true);
  });

  it('解析结果能被 resolveOrchestration 消费', () => {
    const { orchestration } = parseShadowrocketConf(SAMPLE);
    const resolved = resolveOrchestration(nodes(), orchestration);

    expect(resolved.groups.map((group) => group.name)).toEqual(
      expect.arrayContaining(['GOOGLE', 'AI-CLAUDE', 'PROXY']),
    );

    const google = resolved.groups.find((group) => group.name === 'GOOGLE');
    expect(google?.proxies).toEqual(['DMIT-VIA-US-LOS-CG', 'DMIT-SS2022']);

    const claude = resolved.groups.find((group) => group.name === 'AI-CLAUDE');
    expect(claude?.proxies).toEqual([
      'VERIZON-VIA-BWG',
      'VERIZON-VIA-TXSH',
    ]);

    expect(resolved.rules.at(-1)).toBe('MATCH,PROXY');
    expect(resolved.rules).toContain('RULE-SET,openai,AI-OPENAI');
    expect(resolved.providers['openai']?.path).toBe('./rules/openai.txt');
  });

  it('没有任何分组时自动补 PROXY 与 MATCH', () => {
    const { orchestration, warnings } = parseShadowrocketConf('[Rule]\nGEOIP,CN,DIRECT');

    expect(orchestration.groups).toHaveLength(1);
    expect(orchestration.groups[0]?.name).toBe('PROXY');
    expect(orchestration.rules.at(-1)).toMatchObject({ type: 'MATCH', policy: 'PROXY' });
    expect(warnings.some((warning) => warning.includes('FINAL'))).toBe(true);
  });

  it('不把 [Proxy] 内联节点当作订阅节点', () => {
    const { orchestration, warnings } = parseShadowrocketConf(SAMPLE);
    expect(orchestration.groups.some((group) => group.name === 'DIRECT')).toBe(false);
    expect(warnings.some((warning) => warning.includes('[Proxy]'))).toBe(true);
  });

  it('把 include-all-proxies / policy-regex-filter / DOMAIN-REGEX 翻译过来', () => {
    const { orchestration } = parseShadowrocketConf(
      [
        '[Proxy Group]',
        'AUTO = url-test,policy-regex-filter=^VERIZON-,include-all-proxies=true,url=http://www.gstatic.com/generate_204',
        '[Rule]',
        'DOMAIN-REGEX,^ads?\\.,REJECT',
        'FINAL,AUTO',
      ].join('\n'),
    );

    const auto = orchestration.groups.find((group) => group.name === 'AUTO');
    expect(auto?.type).toBe('url-test');
    expect(auto?.members).toEqual([
      { kind: 'nodes', select: {} },
      { kind: 'nodes', select: { nameRegex: '^VERIZON-' } },
    ]);
    expect(orchestration.rules.some((rule) => rule.type === 'DOMAIN-REGEX')).toBe(true);
  });

  it('不同 URL 生成同名 provider 时自动改名，不串规则', () => {
    const { orchestration, warnings } = parseShadowrocketConf(
      [
        '[Proxy Group]',
        'PROXY = select,NodeA',
        '[Rule]',
        'RULE-SET,https://one.example.com/rules.list,PROXY',
        'RULE-SET,https://two.example.com/rules.list,PROXY',
      ].join('\n'),
    );

    expect(orchestration.providers?.['rules']?.url).toBe('https://one.example.com/rules.list');
    expect(orchestration.providers?.['rules-2']?.url).toBe('https://two.example.com/rules.list');
    expect(
      orchestration.rules.some((rule) => rule.type === 'RULE-SET' && rule.value === 'rules-2'),
    ).toBe(true);
    expect(warnings.some((warning) => warning.includes('重名'))).toBe(true);
  });
});
