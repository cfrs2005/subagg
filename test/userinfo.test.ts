import { describe, expect, it } from 'vitest';
import {
  aggregateUserinfo,
  formatUserinfo,
  parseUserinfo,
  remainingBytes,
  usagePercent,
  usedBytes,
} from '../src/core/userinfo.js';
import type { TrafficInfo } from '../src/core/types.js';

/**
 * 来自真实机场订阅的响应头（纯数字，不含任何敏感信息）。
 * 项目 README 里记录的就是这一条，用它做基准用例。
 */
const REAL_HEADER =
  'upload=96701335; download=143028274; total=161061273600; expire=1803225600';

describe('解析', () => {
  it('解析真实响应头', () => {
    const info = parseUserinfo(REAL_HEADER);
    expect(info).toEqual({
      upload: 96701335,
      download: 143028274,
      total: 161061273600,
      expire: 1803225600,
    });
  });

  it('容忍格式变体', () => {
    // 分隔符、空格、大小写在各家机场之间都不统一
    expect(parseUserinfo('upload=1;download=2;total=3')).toEqual({
      upload: 1,
      download: 2,
      total: 3,
    });
    expect(parseUserinfo('UPLOAD=1 ; DOWNLOAD=2')).toEqual({ upload: 1, download: 2 });
    expect(parseUserinfo('download=2, upload=1')).toEqual({ upload: 1, download: 2 });
  });

  it('total=0 表示不限量，而非配额为零', () => {
    // 按字面理解会让客户端显示"已用 100%"，是完全错误的提示
    const info = parseUserinfo('upload=1; download=2; total=0');
    expect(info?.total).toBeUndefined();
  });

  it('expire=0 表示不过期', () => {
    const info = parseUserinfo('upload=1; download=2; expire=0');
    expect(info?.expire).toBeUndefined();
  });

  it('无效输入返回 undefined', () => {
    expect(parseUserinfo(undefined)).toBeUndefined();
    expect(parseUserinfo('')).toBeUndefined();
    expect(parseUserinfo('garbage')).toBeUndefined();
    // 没有 upload/download 就不是一个有效的流量头
    expect(parseUserinfo('total=100')).toBeUndefined();
  });

  it('丢弃负数与非数值', () => {
    const info = parseUserinfo('upload=-5; download=2; total=abc');
    expect(info).toEqual({ upload: 0, download: 2 });
  });
});

describe('生成', () => {
  it('与解析构成往返', () => {
    const info = parseUserinfo(REAL_HEADER);
    expect(info).toBeDefined();
    expect(parseUserinfo(formatUserinfo(info!))).toEqual(info);
  });

  it('省略缺失的可选字段而不是输出 0', () => {
    // 输出 total=0 与省略 total 在客户端里的表现完全不同
    expect(formatUserinfo({ upload: 1, download: 2 })).toBe('upload=1; download=2');
  });
});

describe('聚合', () => {
  const a: TrafficInfo = { upload: 10, download: 20, total: 100, expire: 2000 };
  const b: TrafficInfo = { upload: 5, download: 5, total: 50, expire: 1000 };

  it('sum：流量相加，到期取最早', () => {
    // 到期取最早而不是最晚 —— 最先到期的那个决定了"什么时候会出问题"，
    // 取最晚会给出虚假的安全感。
    const out = aggregateUserinfo(
      new Map([
        ['s1', a],
        ['s2', b],
      ]),
      'sum',
    );
    expect(out).toEqual({ upload: 15, download: 25, total: 150, expire: 1000 });
  });

  it('sum：跳过没有上报流量的订阅源', () => {
    const out = aggregateUserinfo(
      new Map([
        ['s1', a],
        ['s2', undefined],
      ]),
      'sum',
    );
    expect(out).toEqual(a);
  });

  it('follow：跟随指定订阅源', () => {
    const out = aggregateUserinfo(
      new Map([
        ['s1', a],
        ['s2', b],
      ]),
      'follow:s2',
    );
    expect(out).toEqual(b);
  });

  it('off：不输出', () => {
    expect(aggregateUserinfo(new Map([['s1', a]]), 'off')).toBeUndefined();
  });

  it('全部订阅源都没有流量数据时返回 undefined', () => {
    // 调用方据此**不输出**该响应头。输出一个全零的头会让客户端
    // 显示"已用 0 / 总量 0"，比不显示更容易引起误解。
    const out = aggregateUserinfo(new Map([['s1', undefined]]), 'sum');
    expect(out).toBeUndefined();
  });
});

describe('派生计算', () => {
  const info: TrafficInfo = { upload: 30, download: 70, total: 200 };

  it('已用与剩余', () => {
    expect(usedBytes(info)).toBe(100);
    expect(remainingBytes(info)).toBe(100);
  });

  it('不限量时剩余为 undefined 而不是 Infinity', () => {
    // 调用方需要区分"剩余很多"和"没有配额概念"：前者显示数字，后者显示"不限量"
    expect(remainingBytes({ upload: 1, download: 1 })).toBeUndefined();
    expect(usagePercent({ upload: 1, download: 1 })).toBeUndefined();
  });

  it('超额使用时百分比截断到 100', () => {
    // 部分机场允许超额，进度条画到 130% 只会让 UI 溢出
    expect(usagePercent({ upload: 150, download: 150, total: 200 })).toBe(100);
  });
});
