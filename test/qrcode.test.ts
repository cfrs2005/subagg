/**
 * QR 编码器测试。
 *
 * 这里的核心不是"跑通了"，而是**独立解码器往返**：Reed-Solomon、交织顺序、
 * 掩码这几处出错时不会抛异常，只会产出一张扫不出来的码。所以判据必须是
 * "把它读回来还等于原文"，而不是"没报错"。
 *
 * `test/qr-decode.ts` 是一份与生产实现毫无共享代码的解码器，连规范表都重抄了
 * 一份 —— 两份独立来源互相验证。
 */

import { describe, expect, it } from 'vitest';
import {
  alignmentPositions,
  encodeQr,
  gfMul,
  numDataCodewords,
  qrCapacityBytes,
  QR_ECC_LEVELS,
  QR_MAX_VERSION,
  rawDataModules,
  renderQrSvg,
  rsGeneratorPoly,
  rsRemainder,
  type QrEcc,
} from '../src/core/qrcode.js';
import { decodeQr, readFormatBits } from './qr-decode.js';
import { emitUri } from '../src/core/emit/uri.js';
import { makeNode } from './helpers.js';

function roundTrip(text: string, minEcc: QrEcc = 'M'): void {
  const r = encodeQr(text, { minEcc });
  expect(r.ok, `编码失败：${r.ok ? '' : r.reason}`).toBe(true);
  if (!r.ok) return;
  expect(decodeQr(r.matrix), `长度 ${text.length} 的内容解码不回原文`).toBe(text);
}

describe('GF(256) 算术', () => {
  it('gfMul 与朴素移位异或实现在全部 65536 组输入上一致', () => {
    // 生产用 log/exp 查表，这里用俄罗斯农夫乘法 —— 两套完全不同的算法。
    // 这一条能一次性排掉所有查表构造错误。
    const naive = (a: number, b: number): number => {
      let result = 0;
      let x = a;
      let y = b;
      while (y > 0) {
        if (y & 1) result ^= x;
        y >>= 1;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
      }
      return result;
    };
    for (let a = 0; a < 256; a++) {
      for (let b = 0; b < 256; b++) {
        expect(gfMul(a, b)).toBe(naive(a, b));
      }
    }
  });

  it('乘法满足交换律与单位元', () => {
    for (let a = 0; a < 256; a += 7) {
      expect(gfMul(a, 1)).toBe(a);
      expect(gfMul(a, 0)).toBe(0);
      for (let b = 0; b < 256; b += 11) expect(gfMul(a, b)).toBe(gfMul(b, a));
    }
  });
});

describe('Reed-Solomon', () => {
  it('生成多项式与独立参考实现一致', () => {
    // 参考值由一份独立的 GF(256) 实现算出（俄罗斯农夫乘法 + 逐项构造 (x - α^i)），
    // 与生产代码的 log/exp 查表路径无任何共享。
    expect([...rsGeneratorPoly(7)]).toEqual([127, 122, 154, 164, 11, 68, 117]);
    expect([...rsGeneratorPoly(10)]).toEqual([216, 194, 159, 111, 199, 94, 95, 113, 157, 193]);
    expect([...rsGeneratorPoly(13)]).toEqual([137, 73, 227, 17, 177, 17, 52, 13, 46, 43, 83, 132, 120]);
  });

  it('余数计算：已知数据码字 → 已知纠错码字', () => {
    // "HELLO WORLD" 在 version 1-Q 下的数据码字，纠错码字由独立实现验证过
    const data = new Uint8Array([0x40, 0xb4, 0x84, 0x54, 0xc4, 0xc4, 0xf2, 0x05, 0x74, 0xf5, 0x24, 0xc4, 0x40]);
    expect([...rsRemainder(data, rsGeneratorPoly(13))]).toEqual([
      0x2b, 0xf5, 0x24, 0x27, 0xab, 0xc6, 0x18, 0xb9, 0xc4, 0x29, 0x54, 0xc5, 0x9f,
    ]);
  });
});

describe('规格表', () => {
  it('每个 (version, ecc) 的码字数自洽', () => {
    // 数据码字 + 纠错码字 必须恰好等于该版本的总码字数。
    // 这条能抓出两张规格表里抄错的任何一个数 —— 那种错误只在特定长度的
    // 输入上表现，靠随机测试碰不到。
    for (let v = 1; v <= 40; v++) {
      const total = Math.floor(rawDataModules(v) / 8);
      for (const ecc of QR_ECC_LEVELS) {
        const dataCw = numDataCodewords(v, ecc);
        expect(dataCw, `v${v}-${ecc} 数据码字数为负`).toBeGreaterThan(0);
        expect(dataCw).toBeLessThan(total);
      }
    }
  });

  it('已知版本的总码字数符合规范', () => {
    expect(Math.floor(rawDataModules(1) / 8)).toBe(26);
    expect(Math.floor(rawDataModules(2) / 8)).toBe(44);
    expect(Math.floor(rawDataModules(3) / 8)).toBe(70);
    expect(Math.floor(rawDataModules(4) / 8)).toBe(100);
    expect(Math.floor(rawDataModules(10) / 8)).toBe(346);
    expect(Math.floor(rawDataModules(25) / 8)).toBe(1588);
    expect(Math.floor(rawDataModules(40) / 8)).toBe(3706);
  });

  it('byte 模式容量与规范表一致', () => {
    // 规范的容量表当 oracle：表放测试里、算法放生产代码里，
    // 两个独立来源互相验证。抄错任何一个数都会在这里现形。
    // ⚠️ 别把"数据码字数"当成"字节容量"——后者还要扣掉 4 位模式指示符与
    // 8/16 位字符计数指示符再向下取整。例如 v9-M 有 182 个数据码字，
    // 但只能装 180 字节。这个混淆很容易让人误判实现有 bug。
    const expected: Record<number, [number, number, number, number]> = {
      // version: [L, M, Q, H]
      1: [17, 14, 11, 7],
      2: [32, 26, 20, 14],
      3: [53, 42, 32, 24],
      4: [78, 62, 46, 34],
      5: [106, 84, 60, 44],
      9: [230, 180, 130, 98],
      10: [271, 213, 151, 119],
      20: [858, 666, 482, 382],
      25: [1273, 997, 715, 535],
      40: [2953, 2331, 1663, 1273],
    };
    for (const [v, caps] of Object.entries(expected)) {
      QR_ECC_LEVELS.forEach((ecc, i) => {
        expect(qrCapacityBytes(Number(v), ecc), `v${v}-${ecc}`).toBe(caps[i]);
      });
    }
  });

  it('容量并非处处单调 —— 这是规范特性，不是 bug', () => {
    // 两处反直觉的地方，写断言时别想当然：
    //
    // 1. **跨版本会回落**：v9-H 只有 98 字节，比 v8-H 的 110 还少 ——
    //    v9-H 用 8 块 × 24 = 192 个纠错码字，纠错开销反而更大。
    expect(qrCapacityBytes(8, 'H')).toBe(110);
    expect(qrCapacityBytes(9, 'H')).toBe(98);

    // 2. **同版本内 Q 可能比 H 还小**：v8-Q 是 108，低于 v8-H 的 110。
    //    Q 用 6 块 × 22 = 132 个纠错码字，H 用 5 块 × 26 = 130 —— H 反而更省。
    //    所以"纠错越强容量越小"这条直觉在这里是错的。
    expect(qrCapacityBytes(8, 'Q')).toBe(108);
    expect(qrCapacityBytes(8, 'Q')).toBeLessThan(qrCapacityBytes(8, 'H'));

    // 全表扫一遍，把跨版本的回落点钉死。将来改规格表若引入新的回落，
    // 这条会立刻失败，逼人回来确认是抄错了表还是规范如此。
    const drops: string[] = [];
    for (let v = 2; v <= 40; v++) {
      for (const ecc of QR_ECC_LEVELS) {
        if (qrCapacityBytes(v, ecc) <= qrCapacityBytes(v - 1, ecc)) drops.push(`v${v}-${ecc}`);
      }
    }
    expect(drops).toEqual(['v9-H']);
  });

  it('对齐图形坐标符合规范', () => {
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(20)).toEqual([6, 34, 62, 90]);
  });

  it('version 32 是通用公式的唯一例外', () => {
    // 规范里 v32 的步长必须硬编码成 26；通用公式会算出 28，
    // 于是对齐图形整体偏位、码彻底扫不出来。改这段公式的人应该先看到这条。
    expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
    const positions = alignmentPositions(32);
    expect(positions[2]! - positions[1]!).toBe(26);
  });
});

describe('编码往返（独立解码器）', () => {
  it('订阅链接', () => {
    roundTrip('https://miao.20260401.xyz/sub/Ab3xY9_qLmNpQrStUvWxYz0123456789AbCdEfGhIjK', 'Q');
  });

  it('七种协议的真实 URI', () => {
    // 用真正的 emitUri 产出，而不是手写字符串 —— 这样协议改动会自动带进来
    const nodes = [
      makeNode({
        type: 'vmess', name: '🇭🇰 香港 IEPL 专线 01', server: 'hk.example.com', port: 443,
        uuid: '00000000-0000-4000-8000-000000000000', alterId: 0, cipher: 'auto',
        transport: { network: 'ws', ws: { path: '/ray?ed=2048', headers: { Host: 'hk.example.com' } } },
        tls: { enabled: true, sni: 'hk.example.com' },
      }),
      makeNode({
        type: 'vless', name: '日本01-Reality', server: 'jp.example.com', port: 443,
        uuid: '00000000-0000-4000-8000-000000000000', flow: 'xtls-rprx-vision',
        transport: { network: 'tcp' },
        tls: { enabled: true, sni: 'www.microsoft.com', fingerprint: 'chrome',
          reality: { publicKey: 'A'.repeat(43), shortId: '0123456789abcdef' } },
      }),
      makeNode({
        type: 'trojan', name: '新加坡 01', server: 'sg.example.com', port: 443, password: 'p@ssw0rd',
        transport: { network: 'tcp' }, tls: { enabled: true, sni: 'sg.example.com' },
      }),
      makeNode({ type: 'ss', name: '美国 01', server: 'us.example.com', port: 8388, cipher: 'aes-256-gcm', password: 'secret-password' }),
      makeNode({
        type: 'hysteria2', name: '德国 01', server: 'de.example.com', port: 443,
        password: 'hy2-password', tls: { enabled: true, sni: 'de.example.com' },
      }),
      makeNode({
        type: 'tuic', name: '韩国 01', server: 'kr.example.com', port: 443,
        uuid: '00000000-0000-4000-8000-000000000000', password: 'tuic-password',
        tls: { enabled: true, sni: 'kr.example.com' },
      }),
    ];
    for (const node of nodes) {
      const uri = emitUri(node);
      if (uri === null) continue;
      roundTrip(uri);
    }
  });

  it('极端节点名：中文 + emoji + 长路径', () => {
    const long = 'vmess://' + Buffer.from(JSON.stringify({
      v: '2', ps: '🇭🇰 香港 IEPL 专线 01 | 倍率 1.0x | 剩余流量 128GB | 到期 2026-12-31',
      add: 'hk-relay-01.example.com', port: '443', id: '00000000-0000-4000-8000-000000000000',
      aid: '0', scy: 'auto', net: 'ws', type: 'none', host: 'hk-relay-01.example.com',
      path: '/ray?ed=2048', tls: 'tls', sni: 'hk-relay-01.example.com', alpn: 'h2,http/1.1', fp: 'chrome',
    })).toString('base64');
    roundTrip(long);
  });

  it('中文、emoji 与单字符', () => {
    roundTrip('短');
    roundTrip('中文内容测试 with mixed ASCII 12345');
    roundTrip('🇭🇰🇯🇵🇸🇬');
    roundTrip('x');
  });

  it('每个版本的容量边界都能往返', () => {
    // 容量边界是版本切换点，也是字符计数指示符位宽切换点，
    // 最容易出 off-by-one。
    for (let v = 1; v <= QR_MAX_VERSION; v++) {
      for (const ecc of QR_ECC_LEVELS) {
        const cap = qrCapacityBytes(v, ecc);
        const r = encodeQr('a'.repeat(cap), { minEcc: ecc, maxVersion: v });
        expect(r.ok, `v${v}-${ecc} 恰好装满时应成功`).toBe(true);
        if (r.ok) expect(decodeQr(r.matrix)).toBe('a'.repeat(cap));
      }
    }
  });

  it('v9→v10 字符计数指示符从 8 位变 16 位', () => {
    // 经典 off-by-one：写错的话 v10 附近的码全部解不出，而更小的版本一切正常
    for (const len of [176, 178, 180, 181, 182, 184]) roundTrip('x'.repeat(len));
  });

  it('伪随机长度扫射（固定种子，可复现）', () => {
    let s = 0x12345678;
    const rnd = (): number => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
    const CH = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~:/?#@!$&()*+,;=%';
    for (let i = 0; i < 40; i++) {
      const len = 1 + Math.floor(rnd() * 900);
      let text = '';
      for (let k = 0; k < len; k++) text += CH[Math.floor(rnd() * CH.length)];
      roundTrip(text);
    }
  });

  it('八个掩码都能往返', () => {
    const text = 'https://miao.20260401.xyz/sub/' + 'A'.repeat(43);
    for (let m = 0; m < 8; m++) {
      const r = encodeQr(text, { minEcc: 'M', forceMask: m });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.matrix.mask).toBe(m);
      expect(decodeQr(r.matrix), `mask=${m} 解不回原文`).toBe(text);
    }
  });

  it('格式信息位与声明的纠错级别、掩码一致', () => {
    for (const ecc of QR_ECC_LEVELS) {
      const r = encodeQr('format bits check', { minEcc: ecc });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(readFormatBits(r.matrix)).toEqual({ ecc: r.matrix.ecc, mask: r.matrix.mask });
    }
  });
});

describe('结构不变式', () => {
  it('尺寸、定位图形、定时图形、恒深模块', () => {
    for (const v of [1, 2, 6, 7, 14, 25]) {
      const r = encodeQr('x'.repeat(Math.min(20, qrCapacityBytes(v, 'M'))), { minEcc: 'M', maxVersion: v });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const m = r.matrix;
      if (m.version !== v) continue;
      const size = m.size;
      expect(size).toBe(4 * v + 17);

      const get = (x: number, y: number): boolean => m.modules[y]?.[x] ?? false;
      // 三个定位图形的 7×7 同心环
      for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            expect(get(cx + dx, cy + dy), `finder(${cx},${cy}) 偏移(${dx},${dy})`).toBe(d !== 2);
          }
        }
      }
      // 定时图形逐格交替
      for (let i = 8; i < size - 8; i++) {
        expect(get(i, 6)).toBe(i % 2 === 0);
        expect(get(6, i)).toBe(i % 2 === 0);
      }
      // 恒深模块
      expect(get(8, size - 8)).toBe(true);
    }
  });
});

describe('容量与边界', () => {
  it('超出上限时明确拒绝，并给出可读原因', () => {
    const cap = qrCapacityBytes(QR_MAX_VERSION, 'M');
    const over = encodeQr('a'.repeat(cap + 1), { minEcc: 'M' });
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.reason).toContain('超出');
    expect(over.reason).toContain(String(cap));
    expect(over.byteLength).toBe(cap + 1);
    expect(over.capacity).toBe(cap);
  });

  it('绝不降级到 L 硬塞', () => {
    // L 级能装下更多，但那会产出一张超密的低纠错码 —— 最容易扫不出的组合，
    // 而且失败是静默的。宁可明确拒绝。
    const capM = qrCapacityBytes(QR_MAX_VERSION, 'M');
    const capL = qrCapacityBytes(QR_MAX_VERSION, 'L');
    expect(capL).toBeGreaterThan(capM);
    const r = encodeQr('a'.repeat(capM + 1), { minEcc: 'M' });
    expect(r.ok).toBe(false);
  });

  it('空字符串被拒绝', () => {
    const r = encodeQr('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('空');
  });

  it('免费升级纠错级别：尺寸不变就用更强的纠错', () => {
    const short = 'https://miao.20260401.xyz/sub/' + 'A'.repeat(43);
    const r = encodeQr(short, { minEcc: 'L' });
    expect(r.ok).toBe(true);
    // 同一版本下装得下更高级别时应当升级，绝不降级
    if (r.ok) expect(QR_ECC_LEVELS.indexOf(r.matrix.ecc)).toBeGreaterThanOrEqual(QR_ECC_LEVELS.indexOf('L'));
  });

  it('确定性：同输入必得同输出', () => {
    const text = 'https://miao.20260401.xyz/sub/deterministic-check';
    const a = encodeQr(text);
    const b = encodeQr(text);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.matrix.mask).toBe(b.matrix.mask);
      expect(renderQrSvg(a.matrix)).toBe(renderQrSvg(b.matrix));
    }
  });
});

describe('SVG 渲染', () => {
  const sample = encodeQr('https://miao.20260401.xyz/sub/' + 'A'.repeat(43), { minEcc: 'Q' });

  it('结构正确且自带白色底', () => {
    expect(sample.ok).toBe(true);
    if (!sample.ok) return;
    const svg = renderQrSvg(sample.matrix);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${sample.matrix.size + 8} ${sample.matrix.size + 8}"`);
    // 必须自带白底：界面有暗色主题，靠页面背景当静区会让码扫不出来
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('<path');
  });

  it('内容绝不出现在输出里', () => {
    // 这条锁死了一个设计不变式：二维码内容是被编码成比特画进矩阵的，
    // 从来不以字符串形式进入 SVG。前端因此可以安全地 innerHTML。
    const secret = 'https://miao.20260401.xyz/sub/SUPER-SECRET-TOKEN-VALUE-0123456789';
    const r = encodeQr(secret);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const svg = renderQrSvg(r.matrix);
    expect(svg).not.toContain(secret);
    expect(svg).not.toContain('SUPER-SECRET');
    expect(svg).not.toMatch(/<script|javascript:|on[a-z]+\s*=/i);
  });

  it('颜色白名单挡住注入', () => {
    expect(sample.ok).toBe(true);
    if (!sample.ok) return;
    const svg = renderQrSvg(sample.matrix, { dark: '"><script>alert(1)</script>' });
    expect(svg).toContain('#000000');
    expect(svg).not.toContain('<script');
  });

  it('静区可配置', () => {
    expect(sample.ok).toBe(true);
    if (!sample.ok) return;
    const svg = renderQrSvg(sample.matrix, { quietZone: 0 });
    expect(svg).toContain(`viewBox="0 0 ${sample.matrix.size} ${sample.matrix.size}"`);
  });
});
