/**
 * 往返测试：`parseUri(emitUri(node))` 必须在语义上等于 `node`。
 *
 * **这是全项目最重要的一组测试。**
 *
 * 代理 URI 没有统一规范，每个客户端都有自己的方言 —— 同一个字段可能叫 `sni`
 * 也可能叫 `peer`，vmess 的传输层藏在 `net` 里而伪装类型藏在 `type` 里，
 * SSR 的查询参数值还要再套一层 base64。这些坑靠人眼 review 是发现不了的。
 *
 * 而往返测试能一次性锁住解析与生成两侧：任何一侧漏读、漏写、写错键名，
 * 往返结果就对不上。新增协议或修改字段时，请务必先在这里补用例。
 *
 * ## 关于 `udp` 字段
 *
 * URI 格式不承载 UDP 开关（那是 Clash 配置层面的概念），所以这里的测试节点
 * 都不设置 `udp`。这不是遗漏 —— 从 URI 解析出的节点本来就无法知道这个信息。
 */

import { describe, expect, it } from 'vitest';
import { emitUri } from '../../src/core/emit/uri.js';
import { parseUri } from '../../src/core/parse/uri.js';
import type { ProxyNodeDraft } from '../../src/core/types.js';
import { makeNode, stripDerived } from '../helpers.js';

/** 跑一次往返并断言等价。返回生成的 URI，便于额外断言。 */
function roundtrip(draft: ProxyNodeDraft): string {
  const node = makeNode(draft);
  const uri = emitUri(node);

  const parsed = parseUri(uri);
  if (!parsed.ok) {
    throw new Error(`往返失败：生成的 URI 无法被解析回来\n  URI: ${uri}\n  原因: ${parsed.reason}`);
  }

  expect(parsed.node).toEqual(stripDerived(node));
  return uri;
}

describe('VMess 往返', () => {
  it('裸 TCP，无 TLS', () => {
    const uri = roundtrip({
      type: 'vmess',
      name: '🇭🇰 香港 01',
      server: 'hk1.example.com',
      port: 443,
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      alterId: 0,
      cipher: 'auto',
      transport: { network: 'tcp' },
    });
    expect(uri.startsWith('vmess://')).toBe(true);
  });

  it('WebSocket + TLS + uTLS 指纹', () => {
    roundtrip({
      type: 'vmess',
      name: 'WS 节点',
      server: 'ws.example.com',
      port: 8443,
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      alterId: 0,
      cipher: 'auto',
      transport: {
        network: 'ws',
        ws: { path: '/v2ray', headers: { Host: 'cdn.example.com' } },
      },
      tls: {
        enabled: true,
        sni: 'cdn.example.com',
        alpn: ['h2', 'http/1.1'],
        fingerprint: 'chrome',
      },
    });
  });

  it('gRPC —— serviceName 借用 path 字段传递', () => {
    // vmess 的 JSON 格式里没有 serviceName 字段，惯例是复用 path。
    // 这个用例锁住"借用"两侧的一致性。
    roundtrip({
      type: 'vmess',
      name: 'gRPC 节点',
      server: 'grpc.example.com',
      port: 443,
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      alterId: 0,
      cipher: 'auto',
      transport: { network: 'grpc', grpc: { serviceName: 'GunService' } },
      tls: { enabled: true, sni: 'grpc.example.com' },
    });
  });

  it('HTTP/1.1 伪装 —— net=tcp 且 type=http 的组合', () => {
    // 这是 vmess 里最容易搞错的一处：HTTP 伪装的正确表达不是 net=http，
    // 而是 net=tcp + type=http。写错的话客户端会按裸 TCP 连接而握手失败。
    const uri = roundtrip({
      type: 'vmess',
      name: 'HTTP 伪装',
      server: 'http.example.com',
      port: 80,
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      alterId: 0,
      cipher: 'auto',
      transport: {
        network: 'http',
        http: { path: ['/a', '/b'], headers: { Host: ['x.com', 'y.com'] } },
      },
    });

    const json: unknown = JSON.parse(
      Buffer.from(uri.slice('vmess://'.length), 'base64').toString('utf8'),
    );
    expect(json).toMatchObject({ net: 'tcp', type: 'http' });
  });

  it('非零 alterId 得以保留', () => {
    // alterId 非 0 意味着旧版 MD5 认证。虽然已过时，但仍有服务端在用，
    // 静默改成 0 会导致连不上。
    roundtrip({
      type: 'vmess',
      name: '旧式节点',
      server: 'legacy.example.com',
      port: 10086,
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      alterId: 64,
      cipher: 'aes-128-gcm',
      transport: { network: 'tcp' },
    });
  });
});

describe('VLESS 往返', () => {
  it('REALITY + XTLS Vision', () => {
    roundtrip({
      type: 'vless',
      name: '🇺🇸 US Reality',
      server: 'reality.example.com',
      port: 443,
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      flow: 'xtls-rprx-vision',
      transport: { network: 'tcp' },
      tls: {
        enabled: true,
        sni: 'www.microsoft.com',
        fingerprint: 'chrome',
        reality: { publicKey: 'aGVsbG93b3JsZA', shortId: '6ba85179e30d4fc2' },
      },
    });
  });

  it('REALITY 的空 shortId 被保留', () => {
    // 空 shortId 是合法配置，与"不配置 shortId"含义不同。
    // 如果生成时把空串当成缺省丢掉，服务端会认证失败。
    const uri = roundtrip({
      type: 'vless',
      name: '空 shortId',
      server: 'reality2.example.com',
      port: 443,
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      transport: { network: 'tcp' },
      tls: {
        enabled: true,
        sni: 'www.apple.com',
        reality: { publicKey: 'cHVibGlja2V5', shortId: '' },
      },
    });
    expect(uri).toContain('sid=');
  });

  it('WebSocket 传输', () => {
    roundtrip({
      type: 'vless',
      name: 'VLESS WS',
      server: 'vless-ws.example.com',
      port: 443,
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      transport: {
        network: 'ws',
        ws: { path: '/path?ed=2048', headers: { Host: 'front.example.com' } },
      },
      tls: { enabled: true, sni: 'front.example.com' },
    });
  });

  it('无 TLS 时输出 security=none', () => {
    const uri = roundtrip({
      type: 'vless',
      name: '明文 VLESS',
      server: 'plain.example.com',
      port: 80,
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      transport: { network: 'tcp' },
    });
    expect(uri).toContain('security=none');
  });
});

describe('Trojan 往返', () => {
  it('基础 TLS', () => {
    roundtrip({
      type: 'trojan',
      name: '🇭🇰 HK Trojan',
      server: 'trojan.example.com',
      port: 443,
      password: 'p@ssw0rd!',
      transport: { network: 'tcp' },
      tls: { enabled: true, sni: 'trojan.example.com' },
    });
  });

  it('密码含 URI 保留字符', () => {
    // 密码里的 @ : / # ? 如果不做百分号编码，会把 URI 结构撑坏 ——
    // 解析时 @ 之后的部分会被当成主机名。
    roundtrip({
      type: 'trojan',
      name: '特殊字符密码',
      server: 'trojan2.example.com',
      port: 443,
      password: 'a@b:c/d#e?f&g=h',
      transport: { network: 'tcp' },
      tls: { enabled: true },
    });
  });

  it('gRPC 传输 + 跳过证书校验', () => {
    roundtrip({
      type: 'trojan',
      name: 'Trojan gRPC',
      server: 'trojan-grpc.example.com',
      port: 443,
      password: 'pwd',
      transport: { network: 'grpc', grpc: { serviceName: 'TrojanService' } },
      tls: { enabled: true, sni: 'trojan-grpc.example.com', allowInsecure: true },
    });
  });
});

describe('Shadowsocks 往返', () => {
  it('SIP002 基础形态', () => {
    const uri = roundtrip({
      type: 'ss',
      name: '🇸🇬 SG SS',
      server: 'ss.example.com',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'somepassword',
    });
    expect(uri.startsWith('ss://')).toBe(true);
  });

  it('带 obfs 插件', () => {
    roundtrip({
      type: 'ss',
      name: 'SS + obfs',
      server: 'ss-obfs.example.com',
      port: 8388,
      cipher: 'chacha20-ietf-poly1305',
      password: 'pw',
      plugin: {
        name: 'obfs-local',
        opts: { obfs: 'http', 'obfs-host': 'www.bing.com' },
      },
    });
  });

  it('密码含非 ASCII 字符', () => {
    // 用户信息段先按 base64 试解、失败再当明文处理。这个判定只校验
    // 冒号前的加密方式名（规范保证是 ASCII），不校验整串 ——
    // 否则带中文密码的节点会被误判成明文而解析错乱。
    roundtrip({
      type: 'ss',
      name: '中文密码',
      server: 'ss4.example.com',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: '密码里有中文',
    });
  });

  it('密码含冒号 —— 只按第一个冒号切分', () => {
    // method:password 的切分必须用第一个冒号，用最后一个的话
    // 密码里含冒号时会把一部分密码当成加密方式。
    roundtrip({
      type: 'ss',
      name: '冒号密码',
      server: 'ss3.example.com',
      port: 8388,
      cipher: 'aes-128-gcm',
      password: 'a:b:c',
    });
  });
});

describe('ShadowsocksR 往返', () => {
  it('完整参数', () => {
    roundtrip({
      type: 'ssr',
      name: '🇯🇵 JP SSR',
      server: '1.2.3.4',
      port: 8388,
      cipher: 'aes-256-cfb',
      password: 'ssrpassword',
      protocol: 'auth_aes128_md5',
      protocolParam: '1234:abcd',
      obfs: 'tls1.2_ticket_auth',
      obfsParam: 'cloudflare.com',
    });
  });

  it('省略可选参数', () => {
    roundtrip({
      type: 'ssr',
      name: 'SSR 简版',
      server: '5.6.7.8',
      port: 1234,
      cipher: 'rc4-md5',
      password: 'pw',
      protocol: 'origin',
      obfs: 'plain',
    });
  });
});

describe('Hysteria2 往返', () => {
  it('带混淆与带宽声明', () => {
    roundtrip({
      type: 'hysteria2',
      name: 'HY2 节点',
      server: 'hy2.example.com',
      port: 443,
      password: 'hy2password',
      obfs: 'salamander',
      obfsPassword: 'obfspw',
      up: '100 mbps',
      down: '200 mbps',
      tls: { enabled: true, sni: 'hy2.example.com', alpn: ['h3'], allowInsecure: true },
    });
  });

  it('最简形态', () => {
    roundtrip({
      type: 'hysteria2',
      name: 'HY2 简版',
      server: 'hy2b.example.com',
      port: 8443,
      password: 'pw',
      tls: { enabled: true },
    });
  });
});

describe('TUIC 往返', () => {
  it('v5 完整参数', () => {
    roundtrip({
      type: 'tuic',
      name: 'TUIC 节点',
      server: 'tuic.example.com',
      port: 443,
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      password: 'tuicpassword',
      congestionController: 'bbr',
      udpRelayMode: 'native',
      tls: { enabled: true, sni: 'tuic.example.com', alpn: ['h3'] },
    });
  });
});

describe('IPv6 主机', () => {
  it('方括号在生成时补上、解析时剥掉', () => {
    // 内部模型存不带方括号的地址；URI 的 authority 部分必须加方括号，
    // 否则 IPv6 里的冒号会与端口分隔符冲突。
    const uri = roundtrip({
      type: 'trojan',
      name: 'IPv6 节点',
      server: '2001:db8::1',
      port: 443,
      password: 'pw',
      transport: { network: 'tcp' },
      tls: { enabled: true },
    });
    expect(uri).toContain('[2001:db8::1]:443');
  });
});
