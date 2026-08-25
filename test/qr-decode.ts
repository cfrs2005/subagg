/**
 * 测试专用的最小 QR 解码器。
 *
 * **本文件必须是独立实现，禁止 import `src/core/qrcode.ts` 的任何内部函数。**
 * 共享实现就是共享 bug —— 那样这个解码器一文不值。它只接收 `QrMatrix`
 * 这个数据结构，其余（功能图形位置、掩码、蛇形遍历、反交织）全部自己算一遍。
 *
 * 这是整套 QR 测试的支点：Reed-Solomon、交织顺序、掩码这几处出错时**不会抛异常**，
 * 只会产出一张画得挺好看但扫不出来的码。只有把码字读回来、解析回原文，
 * 才算真的验证过。
 */

import type { QrEcc, QrMatrix } from '../src/core/qrcode.js';

// 规范表的独立副本（故意重抄一份，用来交叉验证生产代码里的那两张表）
const ECC_CODEWORDS_PER_BLOCK: Record<QrEcc, readonly number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

const ECC_BLOCK_COUNT: Record<QrEcc, readonly number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 5, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

function at(row: readonly number[], i: number): number {
  return row[i] ?? -1;
}

function alignPositions(version: number): number[] {
  if (version === 1) return [];
  const size = 4 * version + 17;
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
  const out: number[] = [];
  for (let i = 0, pos = size - 7; i < count - 1; i++, pos -= step) out.unshift(pos);
  out.unshift(6);
  return out;
}

function rawModules(version: number): number {
  let r = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const n = Math.floor(version / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (version >= 7) r -= 36;
  }
  return r;
}

/** 独立重建功能模块位置图。 */
function functionMap(version: number): boolean[][] {
  const size = 4 * version + 17;
  const f: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (x: number, y: number): void => {
    if (x >= 0 && x < size && y >= 0 && y < size) {
      const row = f[y];
      if (row) row[x] = true;
    }
  };

  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
  }
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  const ps = alignPositions(version);
  const n = ps.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      const px = ps[i];
      const py = ps[j];
      if (px === undefined || py === undefined) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(px + dx, py + dy);
    }
  }
  for (let i = 0; i < 6; i++) mark(8, i);
  mark(8, 7);
  mark(8, 8);
  mark(7, 8);
  for (let i = 9; i < 15; i++) mark(14 - i, 8);
  for (let i = 0; i < 8; i++) mark(size - 1 - i, 8);
  for (let i = 8; i < 15; i++) mark(8, size - 15 + i);
  mark(8, size - 8);
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      mark(a, b);
      mark(b, a);
    }
  }
  return f;
}

function maskAt(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return false;
  }
}

/** 从矩阵的格式信息区读回纠错级别与掩码，用来验证它们与声明的一致。 */
export function readFormatBits(matrix: QrMatrix): { ecc: QrEcc; mask: number } {
  const get = (x: number, y: number): number => ((matrix.modules[y]?.[x] ?? false) ? 1 : 0);
  let bits = 0;
  for (let i = 0; i < 6; i++) bits |= get(8, i) << i;
  bits |= get(8, 7) << 6;
  bits |= get(8, 8) << 7;
  bits |= get(7, 8) << 8;
  for (let i = 9; i < 15; i++) bits |= get(14 - i, 8) << i;
  const val = bits ^ 0x5412;
  const eccBits = (val >>> 13) & 3;
  const byBits: Record<number, QrEcc> = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };
  return { ecc: byBits[eccBits] ?? 'M', mask: (val >>> 10) & 7 };
}

/** 反掩码 + 蛇形遍历，读回交织后的码字流。 */
function readCodewords(matrix: QrMatrix): number[] {
  const size = matrix.size;
  const f = functionMap(matrix.version);
  const g: boolean[][] = matrix.modules.map((row) => [...row]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!(f[y]?.[x] ?? false) && maskAt(matrix.mask, x, y)) {
        const row = g[y];
        if (row) row[x] = !row[x];
      }
    }
  }

  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!(f[y]?.[x] ?? false)) bits.push((g[y]?.[x] ?? false) ? 1 : 0);
      }
    }
  }

  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | (bits[i + k] ?? 0);
    out.push(b);
  }
  return out;
}

/** 反交织，还原出顺序排列的数据码字。 */
function deinterleave(cw: number[], version: number, ecc: QrEcc): number[] {
  const bc = at(ECC_BLOCK_COUNT[ecc], version);
  const epb = at(ECC_CODEWORDS_PER_BLOCK[ecc], version);
  const raw = Math.floor(rawModules(version) / 8);
  const shortTotal = Math.floor(raw / bc);
  const shortData = shortTotal - epb;
  const shortCount = bc - (raw % bc);

  const lens: number[] = [];
  for (let j = 0; j < bc; j++) lens.push(shortData + (j < shortCount ? 0 : 1));
  const blocks: number[][] = Array.from({ length: bc }, () => []);
  let pos = 0;
  const maxLen = Math.max(...lens);
  for (let i = 0; i < maxLen; i++) {
    for (let j = 0; j < bc; j++) {
      if (i < (lens[j] ?? 0)) {
        blocks[j]?.push(cw[pos] ?? 0);
        pos++;
      }
    }
  }
  return blocks.flat();
}

/**
 * 把矩阵解码回原始字符串。
 *
 * 只实现 byte 模式 —— 生产实现也只产出 byte 模式，够用。
 * 返回 null 表示解不出来（模式不对、长度越界、UTF-8 非法）。
 */
export function decodeQr(matrix: QrMatrix): string | null {
  const data = deinterleave(readCodewords(matrix), matrix.version, matrix.ecc);
  let bits = '';
  for (const b of data) bits += b.toString(2).padStart(8, '0');

  if (parseInt(bits.slice(0, 4), 2) !== 0b0100) return null; // 非 byte 模式
  const ccb = matrix.version <= 9 ? 8 : 16;
  const len = parseInt(bits.slice(4, 4 + ccb), 2);
  const start = 4 + ccb;
  if (start + len * 8 > bits.length) return null;

  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(bits.slice(start + i * 8, start + i * 8 + 8), 2);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
