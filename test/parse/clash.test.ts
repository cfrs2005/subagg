import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseClashProxy, parseClashYaml } from '../../src/core/parse/clash.js';
import type { SsNode, VmessNode } from '../../src/core/types.js';

const FIXTURE = readFileSync(
  fileURLToPath(new URL('../fixtures/clash-subscription.yaml', import.meta.url)),
  'utf8',
);

describe('Clash 订阅解析', () => {
  const result = parseClashYaml(FIXTURE);

  it('解析出全部 proxies（含信息节点 —— 过滤是下一层的职责）', () => {
    // 解析层只负责"读懂"，不负责"取舍"。信息节点由过滤引擎处理，
    // 这样用户才能在需要时关掉过滤看到全部内容。
    expect(result.nodes).toHaveLength(8);
    expect(result.issues).toHaveLength(0);
  });

  it('忽略上游自带的 proxy-groups 与 rules', () => {
    // 聚合多个订阅时这些编排必然冲突：两家机场都定义"自动选择"分组，
    // 规则互相引用对方不存在的节点，Clash 加载时直接报错。
    const names = result.nodes.map((n) => n.name);
    expect(names).not.toContain('上游的自动选择');
  });

  it('VLESS + REALITY', () => {
    const node = result.nodes[0];
    expect(node).toMatchObject({
      type: 'vless',
      server: 'train.hogwarts.example',
      port: 443,
      flow: 'xtls-rprx-vision',
      udp: true,
    });
    expect(node).toHaveProperty('tls.reality.publicKey', 'cHVibGljLWtleS1wbGFjZWhvbGRlcg');
    expect(node).toHaveProperty('tls.reality.shortId', '6ba85179');
    // Clash 管 SNI 叫 servername
    expect(node).toHaveProperty('tls.sni', 'www.microsoft.com');
    // client-fingerprint 是 uTLS 指纹，不是证书指纹 —— 两者必须分开存
    expect(node).toHaveProperty('tls.fingerprint', 'chrome');
  });

  it('VMess + WebSocket', () => {
    const node = result.nodes[1] as VmessNode;
    expect(node.transport).toEqual({
      network: 'ws',
      ws: { path: '/hagrid', headers: { Host: 'cdn.hogwarts.example' } },
    });
  });

  it('兼容老版本的 ws-path / ws-headers 平铺写法', () => {
    // Clash 1.x 早期用的是这套字段名，至今仍有订阅在生成它
    const node = result.nodes[2] as VmessNode;
    expect(node.transport).toEqual({
      network: 'ws',
      ws: { path: '/legacy', headers: { Host: 'jp-legacy.example.com' } },
    });
  });

  it('纯数字密码被转回字符串', () => {
    // YAML 会把 `password: 12345678` 解析成 number。
    // 不转回字符串的话，生成的配置里密码类型不对，客户端认证失败。
    const node = result.nodes[4] as SsNode;
    expect(node.password).toBe('12345678');
    expect(typeof node.password).toBe('string');
  });

  it('Hysteria2 的混淆与带宽参数', () => {
    const node = result.nodes[5];
    expect(node).toMatchObject({
      type: 'hysteria2',
      obfs: 'salamander',
      obfsPassword: 'obfs-secret',
      up: '100 mbps',
      down: '200 mbps',
    });
  });
});

describe('容错', () => {
  it('YAML 语法错误返回 issue 而不是抛异常', () => {
    const out = parseClashYaml('proxies:\n  - [unclosed');
    expect(out.nodes).toHaveLength(0);
    expect(out.issues).toHaveLength(1);
  });

  it('没有 proxies 数组时给出明确原因', () => {
    const out = parseClashYaml('rules:\n  - MATCH,DIRECT');
    expect(out.issues[0]?.reason).toContain('proxies');
  });

  it('单个坏节点不影响其余节点', () => {
    // 订阅里混入一条格式错误的条目是常态，
    // 正确做法是跳过它并记录，而不是整个订阅报错
    const out = parseClashYaml(`
proxies:
  - name: good
    type: ss
    server: a.example.com
    port: 8388
    cipher: aes-256-gcm
    password: pw
  - name: bad-missing-server
    type: ss
    port: 8388
    cipher: aes-256-gcm
    password: pw
  - name: bad-unknown-protocol
    type: wireguard
    server: c.example.com
    port: 51820
`);
    expect(out.nodes).toHaveLength(1);
    expect(out.issues).toHaveLength(2);
    expect(out.issues[0]?.reason).toContain('server');
    expect(out.issues[1]?.reason).toContain('wireguard');
  });

  it('出错条目只记录节点名，不记录整个对象', () => {
    // 序列化整个对象会把密码写进日志
    const out = parseClashYaml(`
proxies:
  - name: leaky
    type: ss
    port: 8388
    cipher: aes-256-gcm
    password: super-secret-password
`);
    expect(out.issues[0]?.raw).toBe('leaky');
    expect(JSON.stringify(out.issues)).not.toContain('super-secret-password');
  });

  it('端口越界的节点被拒绝', () => {
    const out = parseClashProxy({
      name: 'x',
      type: 'ss',
      server: 'a.example.com',
      port: 70000,
      cipher: 'aes-256-gcm',
      password: 'pw',
    });
    expect(out).toMatchObject({ ok: false });
  });
});
