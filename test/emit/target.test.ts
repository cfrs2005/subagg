/**
 * User-Agent 嗅探与目标判定。
 *
 * "一条链接，到处能用"这个产品承诺就落在这组测试上。判错的后果分两级：
 *
 * - 判得**太弱**（把 Meta 客户端当成原版 Clash）：几个 VLESS 节点被跳过，
 *   用户看到提示后可以自己加 `?target=clash.meta` 修正。
 * - 判得**太强**（把原版 Clash 当成 Meta）：VLESS 节点被写进配置，
 *   原版内核加载时直接报错，**整份订阅都用不了**。
 *
 * 后者破坏性大得多，所以拿不准时一律往弱了判。
 */

import { describe, expect, it } from 'vitest';
import { normalizeTargetAlias, resolveTarget, sniffClient } from '../../src/core/emit/index.js';

describe('UA 嗅探', () => {
  it('Shadowrocket', () => {
    expect(sniffClient('Shadowrocket/2.2.31 (iPhone; iOS 18.0)')).toMatchObject({
      target: 'shadowrocket',
      client: 'Shadowrocket',
    });
  });

  it('原版 Clash 内核', () => {
    // ClashX Pro / Clash for Windows / Clash for Android 都基于 Premium 内核，
    // 不支持 VLESS / Hysteria2 / TUIC
    expect(sniffClient('ClashforWindows/0.20.39')).toMatchObject({ target: 'clash' });
    expect(sniffClient('ClashX/1.95.1')).toMatchObject({ target: 'clash' });
    expect(sniffClient('ClashForAndroid/2.5.12')).toMatchObject({ target: 'clash' });
  });

  it('Clash.Meta 系必须优先于通用 Clash 规则', () => {
    // ClashMetaForAndroid 的 UA 里含有 "Clash"。如果通用规则排在前面，
    // 它会被当成原版内核，于是 VLESS / Hysteria2 节点被无谓地跳过。
    expect(sniffClient('ClashMetaForAndroid/2.11.5')).toMatchObject({ target: 'clash.meta' });
    expect(sniffClient('clash-verge/v2.0.3')).toMatchObject({ target: 'clash.meta' });
    expect(sniffClient('mihomo/1.18.8')).toMatchObject({ target: 'clash.meta' });
    // Stash 与 FlClash 用的也是 Meta 内核，但 UA 里没有 "meta" 字样
    expect(sniffClient('Stash/2.7.1')).toMatchObject({ target: 'clash.meta' });
    expect(sniffClient('FlClash/0.8.60')).toMatchObject({ target: 'clash.meta' });
  });

  it('ClashX Meta：clash 与 meta 之间夹着产品名也要认出来', () => {
    // ClashX Meta 内核是 mihomo、支持 dialer-proxy，但 UA 里 "Clash" 与 "Meta"
    // 中间夹了个 "X"。曾因此漏出 Meta 分支被判成原版内核，
    // 导致链式节点与 VLESS / Hysteria2 / TUIC 一并被跳过。
    // 三种发行写法都见过，一个都不能漏。
    expect(sniffClient('ClashX Meta/1.4.9')).toMatchObject({ target: 'clash.meta' });
    expect(sniffClient('ClashXMeta/1.4.9')).toMatchObject({ target: 'clash.meta' });
    expect(sniffClient('ClashX.Meta/1.4.9')).toMatchObject({ target: 'clash.meta' });
    expect(sniffClient('ClashX Meta/1.3.6 (darwin arm64)')).toMatchObject({
      target: 'clash.meta',
    });

    // 反向守卫：裸的 ClashX / ClashX Pro 是真·原版内核，不能被上面的放宽误收。
    // 这两条与「原版 Clash 内核」用例重复是有意的 —— 放在这里，
    // 改动 Meta 正则的人一眼就能看到边界在哪。
    expect(sniffClient('ClashX/1.118.0')).toMatchObject({ target: 'clash' });
    expect(sniffClient('ClashX Pro/1.97.2')).toMatchObject({ target: 'clash' });
  });

  it('V2Ray 系客户端', () => {
    expect(sniffClient('v2rayN/6.45')).toMatchObject({ target: 'v2ray' });
    expect(sniffClient('v2rayNG/1.8.23')).toMatchObject({ target: 'v2ray' });
    expect(sniffClient('NekoBox/1.3.1')).toMatchObject({ target: 'v2ray' });
  });

  it('sing-box 回落到 base64 URI 列表，并说明原因', () => {
    // 回落不是敷衍：sing-box 系客户端确实能导入 base64 URI 列表订阅，
    // 只是拿不到原生 JSON 配置的路由规则。
    const result = sniffClient('sing-box 1.10.0');
    expect(result.target).toBe('v2ray');
    expect(result.warning).toContain('sing-box');
  });

  it('Surge / Quantumult X：如实告知无法服务，不假装成功', () => {
    // 这两家用的是各自的专有配置格式，回落到任何现有格式都不能用。
    const surge = sniffClient('Surge iOS/2800');
    expect(surge.target).toBeUndefined();
    expect(surge.warning).toContain('Surge');
  });

  it('浏览器与未知客户端不给出目标', () => {
    expect(sniffClient('Mozilla/5.0 (Macintosh) Chrome/131').target).toBeUndefined();
    expect(sniffClient('curl/8.4.0')).toEqual({ client: '未知客户端' });
    expect(sniffClient(undefined)).toEqual({ client: '未知客户端' });
  });
});

describe('目标判定优先级', () => {
  it('显式 target 参数压过 UA', () => {
    // 自动判断总有失灵的时候，必须留一个逃生舱
    const r = resolveTarget('v2ray', 'ClashforWindows/0.20.39', 'clash');
    expect(r).toMatchObject({ target: 'v2ray', source: 'query' });
  });

  it('无显式参数时用 UA', () => {
    const r = resolveTarget(undefined, 'Shadowrocket/2.2.31', 'clash');
    expect(r).toMatchObject({ target: 'shadowrocket', source: 'ua' });
  });

  it('UA 认不出时回落到配置的默认目标', () => {
    const r = resolveTarget(undefined, 'curl/8.4.0', 'clash.meta');
    expect(r).toMatchObject({ target: 'clash.meta', source: 'default' });
  });

  it('无效的 target 参数会被忽略，并明确告知用户', () => {
    // 静默忽略会让用户以为参数生效了，反而更难排查
    const r = resolveTarget('surge', 'Shadowrocket/2.2.31', 'clash');
    expect(r.target).toBe('shadowrocket');
    expect(r.warning).toContain('surge');
  });

  it('UA 的警告信息一路传递到结果里', () => {
    const r = resolveTarget(undefined, 'sing-box 1.10.0', 'clash');
    expect(r.warning).toContain('sing-box');
  });
});

describe('target 别名', () => {
  it('接受常见的等价写法', () => {
    // 用户不该被迫记住我们内部的精确拼写
    expect(normalizeTargetAlias('meta')).toBe('clash.meta');
    expect(normalizeTargetAlias('mihomo')).toBe('clash.meta');
    expect(normalizeTargetAlias('Clash-Meta')).toBe('clash.meta');
    expect(normalizeTargetAlias('sr')).toBe('shadowrocket');
    expect(normalizeTargetAlias('v2rayN')).toBe('v2ray');
    expect(normalizeTargetAlias('base64')).toBe('v2ray');
  });

  it('接受规范名', () => {
    expect(normalizeTargetAlias('clash')).toBe('clash');
    expect(normalizeTargetAlias('clash.meta')).toBe('clash.meta');
  });

  it('拒绝未知值', () => {
    expect(normalizeTargetAlias('surge')).toBeUndefined();
    expect(normalizeTargetAlias('')).toBeUndefined();
  });
});
