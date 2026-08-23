import { describe, expect, it } from 'vitest';
import { computeFingerprint, dedupeKey, normalizeHost } from '../src/core/fingerprint.js';
import type { ProxyNodeDraft } from '../src/core/types.js';
import { makeNode } from './helpers.js';

const base: ProxyNodeDraft = {
  type: 'vless',
  name: '原始名字',
  server: 'hk1.example.com',
  port: 443,
  uuid: '11111111-2222-3333-4444-555555555555',
  transport: { network: 'tcp' },
};

describe('指纹稳定性', () => {
  it('改名不影响指纹', () => {
    // 这是整个设计的核心诉求：上游订阅每隔几小时刷新一次，机场随时会改名。
    // 用名字做主键的话，用户勾选的节点会在第一次刷新后全部失效。
    const a = computeFingerprint(base);
    const b = computeFingerprint({ ...base, name: '完全不同的名字' });
    expect(a).toBe(b);
  });

  it('来源不影响指纹', () => {
    // 同一台服务器出现在两个订阅里，应当被识别为同一个节点
    const a = makeNode(base, { sourceId: 's1', sourceName: '机场甲' });
    const b = makeNode(base, { sourceId: 's2', sourceName: '机场乙' });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('主机名大小写不影响指纹', () => {
    // 域名大小写不敏感，上游订阅的书写并不统一。
    // 不归一化会让同一节点产生两个指纹，去重失效。
    const a = makeNode(base);
    const b = makeNode({ ...base, server: 'HK1.Example.COM' });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(b.server).toBe('hk1.example.com');
  });

  it('换服务器视为新节点', () => {
    const a = computeFingerprint(base);
    const b = computeFingerprint({ ...base, server: 'hk2.example.com' });
    expect(a).not.toBe(b);
  });

  it('换端口视为新节点', () => {
    expect(computeFingerprint(base)).not.toBe(computeFingerprint({ ...base, port: 8443 }));
  });

  it('换凭据视为新节点', () => {
    // 同服务器同端口但凭据不同 —— 合理地区分开，共享节点时用得上
    const other = computeFingerprint({ ...base, uuid: '99999999-9999-9999-9999-999999999999' });
    expect(computeFingerprint(base)).not.toBe(other);
  });

  it('协议不同则指纹不同', () => {
    const trojan = computeFingerprint({
      type: 'trojan',
      name: 'x',
      server: 'hk1.example.com',
      port: 443,
      password: '11111111-2222-3333-4444-555555555555',
      transport: { network: 'tcp' },
      tls: { enabled: true },
    });
    expect(computeFingerprint(base)).not.toBe(trojan);
  });

  it('分隔符不会造成歧义碰撞', () => {
    // 用不可打印的 \x1f 而不是冒号做分隔，
    // 避免密码里恰好含分隔符时 "a:b"+"c" 与 "a"+"b:c" 撞哈希
    const a = computeFingerprint({
      type: 'ss',
      name: 'x',
      server: 'a.example.com',
      port: 1,
      cipher: 'aes:128',
      password: 'gcm',
    });
    const b = computeFingerprint({
      type: 'ss',
      name: 'x',
      server: 'a.example.com',
      port: 1,
      cipher: 'aes',
      password: '128:gcm',
    });
    expect(a).not.toBe(b);
  });

  it('长度固定为 16 个十六进制字符', () => {
    expect(computeFingerprint(base)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('主机名归一化', () => {
  it('转小写并去掉末尾的根域点', () => {
    expect(normalizeHost('  Example.COM.  ')).toBe('example.com');
  });
});

describe('去重键', () => {
  const a = makeNode(base);
  const sameMachine = makeNode({
    ...base,
    uuid: '99999999-9999-9999-9999-999999999999',
  });

  it('server-port 模式合并同一台机器上的不同账号', () => {
    // 多个机场转售同一批落地机时，它们指向同一台服务器，
    // 留一个就够了，多留只是让客户端的节点列表变长
    expect(dedupeKey(a, 'server-port')).toBe(dedupeKey(sameMachine, 'server-port'));
  });

  it('fingerprint 模式区分不同账号', () => {
    expect(dedupeKey(a, 'fingerprint')).not.toBe(dedupeKey(sameMachine, 'fingerprint'));
  });
});
