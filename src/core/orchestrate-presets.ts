/**
 * 内置的 Clash 分流编排预设。
 *
 * 目前只有一份：`ios-migrated`，把作者在 Shadowrocket 里长期使用的一套策略
 * 翻译成 Clash.Meta 可用的声明式编排。它不是"通用最佳实践"，
 * 而是一份**可读的迁移样例** —— 告诉用户声明式编排长什么样、能表达什么。
 *
 * ## 从 Shadowrocket 迁过来时做的三处改写
 *
 * 1. `GOOGLE = fallback,...,policy-select-name=...` → `fallback` + `preferred`。
 *    Clash 的 fallback 就是"按顺序取第一个可用的"，首选放第一位即可。
 * 2. `AI-CLAUDE = url-test,...,policy-select-name=...` → 外层 `select`
 *    套内层 `url-test`。url-test 永远选最低延迟，没有"首选"概念。
 * 3. `FINAL,PROXY` → `MATCH,PROXY`；`PROXY` 必须是一个真实存在的分组，
 *    而不是 Clash 的内置关键字。
 *
 * ## 为什么规则里不直接写节点名
 *
 * 原配置里 `drleao.cn` 直接指向 `DMIT-VIA-US-LOS-CG`。照抄的话，机场一旦
 * 改名这份配置就会加载失败。这里改成指向 `GOOGLE` 分组 —— 分组内部用
 * `nameRegex` 选节点、用 `preferred` 表达首选，节点改名不会影响规则。
 */

import type { Orchestration } from './orchestrate.js';

export interface OrchestrationPreset {
  id: string;
  name: string;
  description: string;
  orchestration: Orchestration;
}

/** 内部域名走 doh.pub，避免公共 DoH 解析内网域名失败或变慢。 */
const INTERNAL_DNS: Record<string, string> = {
  '+.feishu.cn': 'https://doh.pub/dns-query',
  '+.aiforce.run': 'https://doh.pub/dns-query',
  '+.zijieapi.com': 'https://doh.pub/dns-query',
  '+.feishucdn.com': 'https://doh.pub/dns-query',
  '+.gs-robot.com': 'https://doh.pub/dns-query',
  '+.gsbot.net': 'https://doh.pub/dns-query',
  '+.gsbot.cc': 'https://doh.pub/dns-query',
  '+.80aj.com': 'https://doh.pub/dns-query',
  '+.20260401.xyz': 'https://doh.pub/dns-query',
  '+.ai.gsbot.dev': 'https://doh.pub/dns-query',
  '+.426624.xyz': 'https://doh.pub/dns-query',
  '+.tccoany.com': 'https://doh.pub/dns-query',
  '+.629630.xyz': 'https://doh.pub/dns-query',
  '+.164165.xyz': 'https://doh.pub/dns-query',
  '+.731732.xyz': 'https://doh.pub/dns-query',
  '+.122733.xyz': 'https://doh.pub/dns-query',
  '+.9a2kq8m5.top': 'https://doh.pub/dns-query',
};

const PRIVATE_RULES: Orchestration['rules'] = [
  { type: 'DOMAIN-SUFFIX', value: 'local', policy: 'DIRECT' },
  { type: 'IP-CIDR', value: '127.0.0.0/8', policy: 'DIRECT', noResolve: true },
  { type: 'IP-CIDR', value: '10.0.0.0/8', policy: 'DIRECT', noResolve: true },
  { type: 'IP-CIDR', value: '172.16.0.0/12', policy: 'DIRECT', noResolve: true },
  { type: 'IP-CIDR', value: '192.168.0.0/16', policy: 'DIRECT', noResolve: true },
  { type: 'IP-CIDR', value: '169.254.0.0/16', policy: 'DIRECT', noResolve: true },
  { type: 'IP-CIDR', value: '100.64.0.0/10', policy: 'DIRECT', noResolve: true },
];

/**
 * 站点所有者的长期策略（由其 Shadowrocket 配置迁移而来）。
 *
 * 它同时扮演两个角色：
 * 1. 「iOS 迁移」预设，可在配置编辑页一键套用；
 * 2. **全局默认编排的兜底值** —— settings 表没写默认时用它，
 *    于是"我的策略"天然就是所有未单独编排的 profile 的分流策略。
 */
const IOS_MIGRATED: Orchestration = {
  groups: [
    {
      name: '♻️ 自动选择',
      type: 'url-test',
      members: [{ kind: 'nodes', select: {} }],
      url: 'http://www.gstatic.com/generate_204',
      interval: 300,
      tolerance: 50,
    },
    {
      name: 'PROXY',
      type: 'select',
      members: [
        { kind: 'group', name: '♻️ 自动选择' },
        { kind: 'nodes', select: {} },
      ],
    },
    {
      name: 'GOOGLE',
      type: 'fallback',
      // DMIT 优先；万一哪天节点改名到一台 DMIT 都不剩，至少还能退回
      // PROXY，而不是让高风控服务的规则整条消失。
      members: [
        { kind: 'nodes', select: { nameRegex: 'DMIT-' } },
        { kind: 'group', name: 'PROXY' },
      ],
      preferred: ['DMIT-VIA-US-LOS-CG', 'DMIT-SS2022'],
      url: 'http://www.gstatic.com/generate_204',
      interval: 600,
    },
    {
      name: 'AI-CLAUDE-AUTO',
      type: 'url-test',
      members: [
        { kind: 'nodes', select: { nameRegex: 'VERIZON' } },
        { kind: 'group', name: 'PROXY' },
      ],
      url: 'http://www.gstatic.com/generate_204',
      interval: 600,
      tolerance: 100,
    },
    {
      name: 'AI-CLAUDE',
      type: 'select',
      members: [
        { kind: 'nodes', select: { nameRegex: '^VERIZON-VIA-BWG$' } },
        { kind: 'group', name: 'AI-CLAUDE-AUTO' },
      ],
    },
    {
      name: 'AI-OPENAI-AUTO',
      type: 'url-test',
      members: [
        { kind: 'nodes', select: { nameRegex: 'GANBEI' } },
        { kind: 'group', name: 'PROXY' },
      ],
      url: 'http://www.gstatic.com/generate_204',
      interval: 600,
      tolerance: 100,
    },
    {
      name: 'AI-OPENAI',
      type: 'select',
      members: [
        { kind: 'nodes', select: { nameRegex: '^GANBEI-VIA-TXSH$' } },
        { kind: 'group', name: 'AI-OPENAI-AUTO' },
      ],
    },
  ],
  providers: {
    openai: {
      url: 'https://raw.githubusercontent.com/cfrs2005/mantaray/main/rules/openai.list',
      behavior: 'classical',
    },
    anthropic: {
      url: 'https://cdn.jsdelivr.net/gh/VPSDance/ai-proxy-rules@main/rules/shadowrocket/anthropic.list',
      behavior: 'classical',
    },
    googleai: {
      url: 'https://raw.githubusercontent.com/cfrs2005/mantaray/main/rules/googleai.list',
      behavior: 'classical',
    },
    sensitive: {
      url: 'https://raw.githubusercontent.com/cfrs2005/mantaray/main/rules/sensitive_services.list',
      behavior: 'classical',
    },
    crypto: {
      url: 'https://raw.githubusercontent.com/cfrs2005/mantaray/main/rules/crypto.list',
      behavior: 'classical',
    },
    'china-domain': {
      url: 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/ChinaMaxNoIP/ChinaMaxNoIP_Domain.list',
      behavior: 'domain',
    },
    china: {
      url: 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/ChinaMaxNoIP/ChinaMaxNoIP.list',
      behavior: 'classical',
    },
    lan: {
      url: 'https://raw.githubusercontent.com/cfrs2005/mantaray/main/rules/lan_direct.list',
      behavior: 'classical',
    },
    dingtalk: {
      // 原配置用的是 github.com/.../blob/...，那个 URL 返回 HTML，规则集会解析失败。
      url: 'https://raw.githubusercontent.com/cfrs2005/mantaray/main/rules/dingTalk.list',
      behavior: 'classical',
    },
    'direct-cn': {
      url: 'https://raw.githubusercontent.com/cfrs2005/mantaray/main/rules/direct_cn.list',
      behavior: 'classical',
    },
  },
  rules: [
    ...PRIVATE_RULES,

    // ── 个人与内网：必须在 GEOIP 之前，否则会被当成国外流量丢给代理 ──
    { type: 'IP-CIDR', value: '10.12.50.0/24', policy: 'DIRECT', noResolve: true },
    { type: 'IP-CIDR', value: '172.19.0.0/12', policy: 'DIRECT', noResolve: true },
    { type: 'DOMAIN-SUFFIX', value: 'bot-eu.gs-robot.com', policy: 'PROXY' },
    { type: 'DOMAIN-SUFFIX', value: 'gs-robot.com', policy: 'DIRECT' },
    { type: 'DOMAIN-SUFFIX', value: 'ai.gsbot.dev', policy: 'DIRECT' },
    { type: 'DOMAIN-SUFFIX', value: 'gsbot.net', policy: 'DIRECT' },
    { type: 'DOMAIN-SUFFIX', value: 'gsbot.cc', policy: 'DIRECT' },
    { type: 'DOMAIN-SUFFIX', value: '20260401.xyz', policy: 'DIRECT' },
    { type: 'DOMAIN-SUFFIX', value: '80aj.com', policy: 'DIRECT' },
    { type: 'DOMAIN-SUFFIX', value: 'mysql.rds.aliyuncs.com', policy: 'DIRECT' },
    { type: 'DOMAIN-SUFFIX', value: 'link.fufeishangban.com', policy: 'DIRECT' },
    { type: 'DOMAIN-SUFFIX', value: 'seagm.com', policy: 'DIRECT' },

    // ── 个人站点与普通代理 ──
    { type: 'DOMAIN-SUFFIX', value: 'drleao.cn', policy: 'GOOGLE' },
    { type: 'DOMAIN-SUFFIX', value: 'wirqed.cn', policy: 'PROXY' },
    { type: 'DOMAIN-SUFFIX', value: 'chatgpt.site', policy: 'AI-OPENAI' },
    { type: 'DOMAIN-SUFFIX', value: 'browser-intake-datadoghq.com', policy: 'PROXY' },

    // ── AI 与高风控服务 ──
    { type: 'RULE-SET', value: 'openai', policy: 'AI-OPENAI' },
    { type: 'RULE-SET', value: 'anthropic', policy: 'AI-OPENAI' },
    { type: 'RULE-SET', value: 'googleai', policy: 'AI-CLAUDE' },
    { type: 'RULE-SET', value: 'sensitive', policy: 'GOOGLE' },
    { type: 'RULE-SET', value: 'crypto', policy: 'GOOGLE' },

    // ── 国内直连 ──
    { type: 'RULE-SET', value: 'china-domain', policy: 'DIRECT' },
    { type: 'RULE-SET', value: 'china', policy: 'DIRECT' },
    { type: 'RULE-SET', value: 'lan', policy: 'DIRECT' },
    { type: 'RULE-SET', value: 'dingtalk', policy: 'DIRECT' },
    { type: 'RULE-SET', value: 'direct-cn', policy: 'DIRECT' },
    { type: 'GEOIP', value: 'CN', policy: 'DIRECT' },

    // FINAL,PROXY 的等价物：必须最后一条。
    { type: 'MATCH', policy: 'PROXY' },
  ],
  dns: {
    enable: true,
    ipv6: false,
    // redir-host 更接近 Shadowrocket 的语义：GEOIP 规则需要真实 IP。
    enhancedMode: 'redir-host',
    nameserver: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query'],
    // 与 Shadowrocket 的 fallback-dns-server 对齐；公共 DoH 被污染或超时时兜底。
    fallback: ['https://1.1.1.1/dns-query'],
    // 解析节点域名走国内 DNS，避免"为了连代理先连不上 DNS"。
    proxyServerNameserver: ['https://doh.pub/dns-query', '223.5.5.5'],
    nameserverPolicy: INTERNAL_DNS,
  },
  // DoH 服务器域名固定到 IP，避免"解析 DoH 服务器本身"又退回被污染的 DNS。
  hosts: {
    'cloudflare-dns.com': '1.1.1.1',
    'dns.google': '8.8.8.8',
    'doh.pub': '1.12.12.12',
  },
  ipv6: false,
};

export { IOS_MIGRATED };

export const ORCHESTRATION_PRESETS: readonly OrchestrationPreset[] = [
  {
    id: 'ios-migrated',
    name: 'iOS 迁移（Shadowrocket）',
    description:
      '从 Shadowrocket 长期配置迁移：AI 分组、Google fallback、内网直连、国内规则集与 DoH 分流。',
    orchestration: IOS_MIGRATED,
  },
];

export function findOrchestrationPreset(id: string): OrchestrationPreset | undefined {
  return ORCHESTRATION_PRESETS.find((preset) => preset.id === id);
}
