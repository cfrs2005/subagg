import { describe, expect, it } from 'vitest';
import {
  detectRegion,
  flagToRegionCode,
  normalizeRegionCode,
  regionNameZh,
  regionToFlag,
} from '../src/core/region.js';

describe('旗帜 emoji', () => {
  it('解码出 ISO 代码', () => {
    // 旗帜 emoji 由两个"区域指示符"组成，字面上就编码着 ISO 代码，
    // 所以这是置信度最高的信号 —— 解码而非猜测。
    expect(flagToRegionCode('🇺🇸美国 | 霍格沃茨特快列车')).toBe('US');
    expect(flagToRegionCode('🇭🇰香港｜海格的小屋')).toBe('HK');
    expect(flagToRegionCode('🇯🇵 JP-Softbank-01')).toBe('JP');
  });

  it('没有旗帜时返回 undefined', () => {
    expect(flagToRegionCode('HK-Premium-01')).toBeUndefined();
  });

  it('由代码生成旗帜', () => {
    expect(regionToFlag('US')).toBe('🇺🇸');
    expect(regionToFlag('HK')).toBe('🇭🇰');
    // UK 是常见但非 ISO 的写法，应归一化到 GB 后再生成
    expect(regionToFlag('UK')).toBe('🇬🇧');
  });
});

describe('地区代码归一化', () => {
  it('UK 归一化为 ISO 的 GB', () => {
    expect(normalizeRegionCode('UK')).toBe('GB');
    expect(normalizeRegionCode('uk')).toBe('GB');
  });

  it('非法输入返回 undefined 而不是抛异常', () => {
    // 这些值来自用户输入，需要的是"忽略无效项"而不是"整个请求失败"
    expect(normalizeRegionCode('')).toBeUndefined();
    expect(normalizeRegionCode('CHINA')).toBeUndefined();
    expect(normalizeRegionCode('1')).toBeUndefined();
  });
});

describe('从节点名推断地区', () => {
  it('旗帜优先', () => {
    expect(detectRegion('🇺🇸美国 | 霍格沃茨特快列车')).toBe('US');
    expect(detectRegion('🇭🇰香港｜海格的小屋')).toBe('HK');
  });

  it('中文地名', () => {
    expect(detectRegion('香港 IEPL 专线 01')).toBe('HK');
    expect(detectRegion('日本 东京 BGP')).toBe('JP');
    expect(detectRegion('德国法兰克福')).toBe('DE');
    expect(detectRegion('英国伦敦')).toBe('GB');
  });

  it('英文城市名', () => {
    expect(detectRegion('Los Angeles 01')).toBe('US');
    expect(detectRegion('Frankfurt Premium')).toBe('DE');
    expect(detectRegion('Singapore Standard')).toBe('SG');
  });

  it('裸国家代码（限安全清单内）', () => {
    expect(detectRegion('HK-Premium-02 IEPL')).toBe('HK');
    expect(detectRegion('JP-Softbank-01')).toBe('JP');
    expect(detectRegion('US-LA-01')).toBe('US');
    // UK 命中后归一化为 GB
    expect(detectRegion('UK-London-Warp')).toBe('GB');
  });

  it('危险的两字母代码不参与匹配', () => {
    // IN(印度) / IT(意大利) / IS(冰岛) 等都是常见英文词，
    // 放进裸代码匹配会造成大量误判。它们不在安全清单里。
    expect(detectRegion('IT-Support Line')).toBeUndefined();
    expect(detectRegion('Premium IN Stock')).toBeUndefined();
  });

  it('英文关键词要求词边界', () => {
    // 否则 `Deutschland` 里的匹配会蔓延到 `Deutschlander` 这类词上。
    // 这条规则的代价是偶尔漏判，但漏判远比误判安全 ——
    // 用户按"德国"筛选却拿到别国节点，会直接导致误用。
    expect(detectRegion('Deutschland Node')).toBe('DE');
    expect(detectRegion('Deutschlander')).toBeUndefined();
  });

  it('完全无线索时返回 undefined，不瞎猜', () => {
    expect(detectRegion('Premium Line 01')).toBeUndefined();
    expect(detectRegion('节点一号')).toBeUndefined();
  });

  it('名字无线索时从服务器域名兜底', () => {
    // 域名的置信度低于名字（CDN 回源域名可能与落地地区无关），
    // 所以只在名字完全没有信息时才用。
    expect(detectRegion('Warp Node', 'jp.cf-warp.net')).toBe('JP');
    expect(detectRegion('Warp Node', 'de.cf-warp.net')).toBe('DE');
    expect(detectRegion('Warp Node', 'tw.cf-warp.net')).toBe('TW');
  });

  it('名字有线索时不被域名带偏', () => {
    // 名字说香港、域名说美国 —— 应当信名字
    expect(detectRegion('🇭🇰 香港节点', 'us-relay.example.com')).toBe('HK');
  });
});

describe('显示名', () => {
  it('返回中文名', () => {
    expect(regionNameZh('HK')).toBe('香港');
    expect(regionNameZh('GB')).toBe('英国');
    expect(regionNameZh('UK')).toBe('英国');
  });

  it('表里没有的代码回退到代码本身', () => {
    // emoji 能解出任意 ISO 代码，可能超出我们的地区表范围。
    // 这不是错误：代码本身就是有效标识，表只影响显示名。
    expect(regionNameZh('VA')).toBe('VA');
  });
});
