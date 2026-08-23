import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { emitClash, toClashProxy } from '../../src/core/emit/clash.js';
import { parseClashProxy } from '../../src/core/parse/clash.js';
import type { ProxyNode, ProxyNodeDraft } from '../../src/core/types.js';
import { makeNode, stripDerived } from '../helpers.js';

/** Clash 侧的往返：node → Clash proxy 对象 → node。 */
function clashRoundtrip(draft: ProxyNodeDraft): void {
  const node = makeNode(draft);
  const proxy = toClashProxy(node);
  const parsed = parseClashProxy(proxy);
  if (!parsed.ok) {
    throw new Error(`Clash 往返失败：${parsed.reason}\n${JSON.stringify(proxy, null, 2)}`);
  }
  expect(parsed.node).toEqual(stripDerived(node));
}

const vlessNode = (): ProxyNode =>
  makeNode(
    {
      type: 'vless',
      name: '🇺🇸 US Reality',
      server: 'us.example.com',
      port: 443,
      uuid: '11111111-2222-3333-4444-555555555555',
      flow: 'xtls-rprx-vision',
      transport: { network: 'tcp' },
      tls: {
        enabled: true,
        sni: 'www.microsoft.com',
        fingerprint: 'chrome',
        reality: { publicKey: 'pk', shortId: 'sid' },
      },
    },
    { region: 'US' },
  );

const vmessNode = (): ProxyNode =>
  makeNode(
    {
      type: 'vmess',
      name: '🇭🇰 HK WS',
      server: 'hk.example.com',
      port: 443,
      uuid: '66666666-7777-8888-9999-000000000000',
      alterId: 0,
      cipher: 'auto',
      transport: { network: 'ws', ws: { path: '/ws', headers: { Host: 'cdn.example.com' } } },
      tls: { enabled: true, sni: 'cdn.example.com' },
    },
    { region: 'HK' },
  );

const trojanNode = (): ProxyNode =>
  makeNode(
    {
      type: 'trojan',
      name: '🇭🇰 HK Trojan',
      server: 'hk2.example.com',
      port: 443,
      password: 'pw',
      transport: { network: 'tcp' },
      tls: { enabled: true, sni: 'hk2.example.com' },
    },
    { region: 'HK' },
  );

describe('Clash proxy 往返', () => {
  it('VMess + WebSocket + TLS', () => {
    clashRoundtrip(stripDerived(vmessNode()));
  });

  it('VLESS + REALITY', () => {
    clashRoundtrip(stripDerived(vlessNode()));
  });

  it('Trojan（隐含 TLS，不写 tls: true）', () => {
    clashRoundtrip(stripDerived(trojanNode()));
  });

  it('SS + 插件', () => {
    clashRoundtrip({
      type: 'ss',
      name: 'SS obfs',
      server: 'ss.example.com',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'pw',
      plugin: { name: 'obfs-local', opts: { obfs: 'http', 'obfs-host': 'www.bing.com' } },
    });
  });

  it('SSR', () => {
    clashRoundtrip({
      type: 'ssr',
      name: 'SSR',
      server: 'ssr.example.com',
      port: 8388,
      cipher: 'aes-256-cfb',
      password: 'pw',
      protocol: 'auth_aes128_md5',
      protocolParam: 'pp',
      obfs: 'tls1.2_ticket_auth',
      obfsParam: 'op',
    });
  });

  it('TUIC', () => {
    clashRoundtrip({
      type: 'tuic',
      name: 'TUIC',
      server: 'tuic.example.com',
      port: 443,
      uuid: '11111111-2222-3333-4444-555555555555',
      password: 'pw',
      congestionController: 'bbr',
      udpRelayMode: 'native',
      tls: { enabled: true, sni: 'tuic.example.com', alpn: ['h3'] },
    });
  });

  it('uTLS 指纹与证书指纹分别落到不同的键', () => {
    // Clash 里 client-fingerprint 是 uTLS 握手指纹，fingerprint 是证书指纹固定。
    // 这两个键名极易搞反，搞反后握手失败且报错毫无提示性。
    const node = makeNode({
      type: 'vmess',
      name: 'FP 测试',
      server: 'fp.example.com',
      port: 443,
      uuid: '1',
      alterId: 0,
      cipher: 'auto',
      transport: { network: 'tcp' },
      tls: { enabled: true, fingerprint: 'chrome', certFingerprint: 'abcdef' },
    });
    const proxy = toClashProxy(node);
    expect(proxy['client-fingerprint']).toBe('chrome');
    expect(proxy['fingerprint']).toBe('abcdef');
  });
});

describe('能力矩阵', () => {
  it('原版 Clash 跳过 VLESS 并说明原因', () => {
    // 静默丢弃是不可接受的：用户看到节点数变少只会以为订阅坏了，
    // 而真实原因是"你的客户端内核太老"。
    const out = emitClash([vlessNode(), vmessNode()], { target: 'clash' });
    expect(out.nodeCount).toBe(1);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]?.type).toBe('vless');
    expect(out.skipped[0]?.reason).toContain('mihomo');
  });

  it('Clash.Meta 保留 VLESS', () => {
    const out = emitClash([vlessNode(), vmessNode()], { target: 'clash.meta' });
    expect(out.nodeCount).toBe(2);
    expect(out.skipped).toHaveLength(0);
  });
});

describe('生成的配置结构', () => {
  const out = emitClash([vlessNode(), vmessNode(), trojanNode()], { target: 'clash.meta' });
  const config = parseYaml(out.body) as Record<string, unknown>;

  it('是合法 YAML 且含必要的顶层字段', () => {
    expect(config['mode']).toBe('rule');
    expect(Array.isArray(config['proxies'])).toBe(true);
  });

  it('不输出 external-controller', () => {
    // 那会开一个本地管理端口，是订阅内容不该替用户做的决定
    expect(config).not.toHaveProperty('external-controller');
  });

  it('按地区生成 url-test 分组', () => {
    const groups = config['proxy-groups'] as { name: string; type: string }[];
    const names = groups.map((g) => g.name);
    expect(names).toContain('🚀 节点选择');
    expect(names).toContain('♻️ 自动选择');
    expect(names).toContain('🇭🇰 香港');
    expect(names).toContain('🇺🇸 美国');
  });

  it('分组只引用真实存在的节点或其他分组', () => {
    // 引用了不存在的名字，Clash 会拒绝加载整份配置
    const proxies = config['proxies'] as { name: string }[];
    const groups = config['proxy-groups'] as { name: string; proxies: string[] }[];
    const valid = new Set([
      ...proxies.map((p) => p.name),
      ...groups.map((g) => g.name),
      'DIRECT',
      'REJECT',
    ]);
    for (const group of groups) {
      for (const ref of group.proxies) {
        expect(valid.has(ref), `分组「${group.name}」引用了不存在的「${ref}」`).toBe(true);
      }
    }
  });

  it('规则以 MATCH 收尾', () => {
    const rules = config['rules'] as string[];
    expect(rules[rules.length - 1]).toMatch(/^MATCH,/);
  });
});

describe('边界情况', () => {
  it('零节点时仍生成可加载的配置', () => {
    // 所有订阅都过期、或过滤规则写得太严时会发生。
    // Clash 要求每个分组的 proxies 非空，空数组会让客户端拒绝加载整份配置 ——
    // 那样用户连打开客户端看问题都做不到。
    const out = emitClash([], { target: 'clash.meta' });
    const config = parseYaml(out.body) as Record<string, unknown>;
    const groups = config['proxy-groups'] as { proxies: string[] }[];

    expect(out.nodeCount).toBe(0);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.proxies.length).toBeGreaterThan(0);
    }
  });

  it('地区推断不出的节点仍进入总分组', () => {
    const noRegion = makeNode({
      type: 'ss',
      name: '未知地区节点',
      server: 'x.example.com',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'pw',
    });
    const out = emitClash([noRegion], { target: 'clash.meta' });
    const config = parseYaml(out.body) as Record<string, unknown>;
    const groups = config['proxy-groups'] as { name: string; proxies: string[] }[];
    const auto = groups.find((g) => g.name === '♻️ 自动选择');
    expect(auto?.proxies).toContain('未知地区节点');
  });

  it('可以只输出 proxies 而不生成编排', () => {
    const out = emitClash([vmessNode()], { target: 'clash.meta', withGroups: false });
    const config = parseYaml(out.body) as Record<string, unknown>;
    expect(config).not.toHaveProperty('proxy-groups');
    expect(config).not.toHaveProperty('rules');
  });
});
