/**
 * 规则集格式嗅探与归一。
 *
 * 这里守的是一个**静默失效**类的问题：格式猜错时 Clash 不会报错，
 * 规则集变成空集，流量悄悄走错路。所以每条用例都对应一种真实源站格式。
 */

import { describe, expect, it } from 'vitest';
import { convertRuleSet } from '../src/core/rule-set.js';

describe('规则集转换', () => {
  it('Shadowrocket 前导点列表转成 Clash domain 语法', () => {
    // blackmatrix7 的 `*_Domain.list` 就是这种格式：11 万行 `.0.zone`。
    // 直接当 behavior: domain 喂给 Clash 不会报错，但一条也不匹配 ——
    // 因为 Clash 只认 `+.x` / `*.x` / 裸域名。
    const converted = convertRuleSet('# NAME: ChinaMax\n.0.zone\n.00.net\n', 'domain');

    expect(converted?.format).toBe('leading-dot');
    expect(converted?.body).toBe('+.0.zone\n+.00.net\n');
    expect(converted?.count).toBe(2);
  });

  it('Surge 规则集转 classical 时丢弃无法表达的类型并计数', () => {
    const converted = convertRuleSet(
      'DOMAIN-SUFFIX,openai.com\nDOMAIN,api.foo.cn,no-resolve\nUSER-AGENT,Telegram*\n',
      'classical',
    );

    expect(converted?.format).toBe('surge');
    expect(converted?.body).toBe('DOMAIN-SUFFIX,openai.com\nDOMAIN,api.foo.cn\n');
    expect(converted?.dropped).toBe(1);
  });

  it('Clash payload 原样保留', () => {
    const converted = convertRuleSet("payload:\n  - '+.google.com'\n  - 'facebook.com'\n", 'domain');

    expect(converted?.format).toBe('clash-payload');
    expect(converted?.body).toBe('+.google.com\nfacebook.com\n');
  });

  it('裸域名列表按后缀语义处理', () => {
    const converted = convertRuleSet('example.com\nfoo.cn\n', 'domain');
    expect(converted?.body).toBe('+.example.com\n+.foo.cn\n');
  });

  it('IP 列表转 ipcidr，域名条目计入丢弃', () => {
    const converted = convertRuleSet('10.0.0.0/8\n2001:db8::/32\nexample.com\n', 'ipcidr');

    expect(converted?.body).toBe('10.0.0.0/8\n2001:db8::/32\n');
    expect(converted?.dropped).toBe(1);
  });

  it('HTML 页面拒绝转换', () => {
    // `github.com/.../blob/...` 返回的就是这个。下发空规则集比报错更危险。
    expect(convertRuleSet('<!DOCTYPE html>\n<html><body>404</body></html>', 'classical')).toBeNull();
  });

  it('空内容拒绝转换', () => {
    expect(convertRuleSet('# 只有注释\n', 'domain')).toBeNull();
  });
});
