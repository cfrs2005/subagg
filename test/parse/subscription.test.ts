import { describe, expect, it } from 'vitest';
import { parseSubscription } from '../../src/core/parse/index.js';
import { parseUri } from '../../src/core/parse/uri.js';
import { encodeBase64 } from '../../src/core/parse/util.js';

const SS_URI = 'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@ss.example.com:8388#SG-01';
const TROJAN_URI = 'trojan://pw@hk.example.com:443?security=tls&sni=hk.example.com#HK-01';

describe('格式嗅探', () => {
  it('识别 Clash YAML', () => {
    const out = parseSubscription(`proxies:
  - name: n
    type: ss
    server: a.example.com
    port: 8388
    cipher: aes-256-gcm
    password: pw
`);
    expect(out.detected).toBe('clash');
    expect(out.nodes).toHaveLength(1);
  });

  it('识别明文 URI 列表', () => {
    const out = parseSubscription(`${SS_URI}\n${TROJAN_URI}`);
    expect(out.detected).toBe('uri-list');
    expect(out.nodes).toHaveLength(2);
  });

  it('识别 base64 包裹的 URI 列表', () => {
    const out = parseSubscription(encodeBase64(`${SS_URI}\n${TROJAN_URI}`));
    expect(out.detected).toBe('uri-list');
    expect(out.nodes).toHaveLength(2);
  });

  it('识别 base64 包裹的 Clash YAML（少见但存在）', () => {
    const yaml = 'proxies:\n  - {name: n, type: ss, server: a.example.com, port: 8388, cipher: aes-256-gcm, password: pw}\n';
    const out = parseSubscription(encodeBase64(yaml));
    expect(out.detected).toBe('clash');
    expect(out.nodes).toHaveLength(1);
  });

  it('proxies 必须出现在行首才算 Clash', () => {
    // 否则一个名字里恰好含 "proxies" 的节点会让整份订阅被误判成 YAML
    const out = parseSubscription(`ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@a.example.com:8388#my%20proxies%20node`);
    expect(out.detected).toBe('uri-list');
    expect(out.nodes).toHaveLength(1);
  });

  it('可以用 hint 跳过嗅探', () => {
    // 自动识别出错时用户需要一个手动指定的逃生舱
    const out = parseSubscription(SS_URI, 'uri-list');
    expect(out.detected).toBe('uri-list');
  });
});

describe('失败时给出可操作的原因', () => {
  it('HTML 错误页 —— 机场挂掉时最常见的表现', () => {
    // 机场返回 HTTP 200 + HTML 错误页 / 人机验证页，是订阅失效的典型症状。
    // 报"解析失败"没有帮助，得说清楚发生了什么。
    const out = parseSubscription('<!DOCTYPE html><html><body>403 Forbidden</body></html>');
    expect(out.nodes).toHaveLength(0);
    expect(out.issues[0]?.reason).toContain('HTML');
  });

  it('空响应', () => {
    const out = parseSubscription('   ');
    expect(out.issues[0]?.reason).toContain('空');
  });

  it('完全无法识别的内容', () => {
    const out = parseSubscription('this is not a subscription at all');
    expect(out.issues[0]?.reason).toContain('无法识别');
  });
});

describe('单条 URI 的容错', () => {
  it('跳过坏行但保留好行', () => {
    const out = parseSubscription(`${SS_URI}
this-is-garbage
vmess://not-valid-base64-!!!
${TROJAN_URI}`);
    expect(out.nodes).toHaveLength(2);
    expect(out.issues).toHaveLength(2);
  });

  it('跳过空行与注释行', () => {
    // 部分机场会在订阅顶部加 # 开头的公告
    const out = parseSubscription(`# 欢迎使用本机场
${SS_URI}

// 另一种注释
${TROJAN_URI}`);
    expect(out.nodes).toHaveLength(2);
    expect(out.issues).toHaveLength(0);
  });

  it('未支持的协议给出协议名', () => {
    const out = parseUri('wireguard://key@1.2.3.4:51820#wg');
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.reason).toContain('wireguard');
  });

  it('端口非法的 URI 被拒绝', () => {
    const out = parseUri('trojan://pw@a.example.com:99999#x');
    expect(out).toMatchObject({ ok: false });
  });

  it('缺少 UUID 的 vless 被拒绝', () => {
    const out = parseUri('vless://@a.example.com:443#x');
    expect(out).toMatchObject({ ok: false });
  });
});

describe('SS 的两种 URI 格式都支持', () => {
  it('SIP002（现行标准）', () => {
    const out = parseUri(SS_URI);
    expect(out).toMatchObject({
      ok: true,
      node: { type: 'ss', cipher: 'aes-256-gcm', password: 'password', port: 8388 },
    });
  });

  it('旧式整段 base64', () => {
    // ss://base64(method:password@host:port)
    const legacy = `ss://${encodeBase64('aes-256-gcm:password@ss.example.com:8388')}#SG-01`;
    const out = parseUri(legacy);
    expect(out).toMatchObject({
      ok: true,
      node: { type: 'ss', cipher: 'aes-256-gcm', password: 'password', server: 'ss.example.com' },
    });
  });

  it('未编码的明文用户信息', () => {
    const out = parseUri('ss://aes-256-gcm:password@ss.example.com:8388#SG-01');
    expect(out).toMatchObject({ ok: true, node: { cipher: 'aes-256-gcm', password: 'password' } });
  });
});
