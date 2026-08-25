/**
 * QR 码编码器（ISO/IEC 18004）。
 *
 * ## 为什么自己写
 *
 * 二维码承载的是订阅链接与节点 URI —— 等同于全部节点的访问凭证。
 * 交给任何第三方出码服务（无论是 API 还是前端 CDN 脚本）都意味着把凭证
 * 送出去一份。所以这里自己算，全程零外部请求、零新增依赖。
 *
 * ## 为什么放在 core/
 *
 * QR 编码是纯计算：给定字符串与参数，输出一个确定的模块矩阵。
 * 不读文件、不发请求、不碰数据库、不看时钟 —— 符合 core/ 的零 IO 约定。
 * 全文件唯一的外部依赖是 `TextEncoder`（W3C 标准全局，纯计算）。
 * 刻意不用 `Buffer`：它是 Node 专属，而这份代码本可以原样搬进浏览器。
 *
 * ## 掩码选择必须确定性
 *
 * 同样的输入必须得到同样的矩阵、同样的 SVG。这不只是洁癖：测试的快照断言
 * 与将来可能加的 HTTP 缓存都依赖它。所以全文件不含任何随机数。
 *
 * ## 实现分解
 *
 * 数据编码 → 纠错码字（Reed-Solomon）→ 分块交织 → 矩阵构建 → 掩码选择。
 * 其中 RS 与交织是最容易错、也最难发现的部分：错了不会抛异常，
 * 只会产出一张画得挺好看但**扫不出来**的码。`test/qr-decode.ts` 里那个
 * 独立解码器就是为此存在的。
 */

// ─────────────────────────────────────────────────────────────
//  公开类型
// ─────────────────────────────────────────────────────────────

/** 纠错级别。可恢复的码字比例：L≈7% / M≈15% / Q≈25% / H≈30%。 */
export type QrEcc = 'L' | 'M' | 'Q' | 'H';

export const QR_ECC_LEVELS = ['L', 'M', 'Q', 'H'] as const satisfies readonly QrEcc[];

/**
 * 版本上限，刻意定在 25 而不是规范允许的 40。
 *
 * 扫码的成败取决于**模块的物理尺寸**，不是纠错级别。version 40 是 177×177，
 * 塞进一个 300px 的弹窗里每个模块只有 1.7 CSS 像素，多数手机根本对不上焦 ——
 * 那就是"出了一张扫不出来的码"。25 是 117×117，是"装得下真实最坏 payload"
 * 与"还扫得出来"的交点（实测最长的 vmess URI 落在 version 23）。
 */
export const QR_MAX_VERSION = 25;

export interface QrMatrix {
  /** 1–40。 */
  readonly version: number;
  /** 恒等于 4 * version + 17。冗余，但省得每个调用方自己算。 */
  readonly size: number;
  /** 实际使用的纠错级别，可能高于请求的下限（见"免费升级"）。 */
  readonly ecc: QrEcc;
  /** 实际选中的掩码 0–7。调试与测试需要它。 */
  readonly mask: number;
  /** `[row][col]`，true = 深色模块。不含静区。 */
  readonly modules: readonly (readonly boolean[])[];
}

export interface QrEncodeOptions {
  /** 纠错级别下限，默认 `'M'`。实际级别只会等于或高于它。 */
  minEcc?: QrEcc;
  /** 版本上限，默认 `QR_MAX_VERSION`。超过即视为编码失败。 */
  maxVersion?: number;
  /** 固定掩码（0–7）。**仅供测试对拍**，生产不要传。 */
  forceMask?: number;
}

export type QrEncodeResult =
  | { readonly ok: true; readonly matrix: QrMatrix }
  | {
      readonly ok: false;
      /** 面向用户的中文原因，可以直接放进 HTTP 响应体。 */
      readonly reason: string;
      /** 内容的 UTF-8 字节数。 */
      readonly byteLength: number;
      /** 在给定 minEcc / maxVersion 下的字节上限。 */
      readonly capacity: number;
    };

// ─────────────────────────────────────────────────────────────
//  规格表
// ─────────────────────────────────────────────────────────────
//
// 只内联两张表，其余全部由公式推导。手抄规范里那几张 40 行的大表
// 是这类实现最大的低级错误来源 —— 抄错一个数，只有特定长度的输入才会暴露，
// 随机测试碰不到。
//
// 索引方式：[eccIndex][version]，0 号槽位是占位（版本从 1 开始）。

const ECC_INDEX: Readonly<Record<QrEcc, number>> = { L: 0, M: 1, Q: 2, H: 3 };

/** 格式信息里的纠错级别位（注意不是 0/1/2/3 的顺序）。 */
const ECC_FORMAT_BITS: Readonly<Record<QrEcc, number>> = { L: 1, M: 0, Q: 3, H: 2 };

/** 每个纠错块的纠错码字数。 */
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  // 0  1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32  33  34  35  36  37  38  39  40
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
];

/** 纠错块数。 */
const ECC_BLOCK_COUNT: readonly (readonly number[])[] = [
  // 0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
  [-1, 1, 1, 2, 4, 4, 4, 5, 5, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // H
];

function tableAt(table: readonly (readonly number[])[], ecc: QrEcc, version: number): number {
  const row = table[ECC_INDEX[ecc]] ?? [];
  return row[version] ?? -1;
}

/**
 * 对齐图形的中心坐标。
 *
 * ⚠️ **version 32 是规范里唯一的例外**：通用公式算出来是错的，必须硬编码 26。
 * 这是所有自研 QR 实现的头号 bug —— 而且它只在 version 32 上表现，
 * 靠随机测试几乎撞不到。`test/qrcode.test.ts` 里有一条专门盯着它的用例。
 */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const size = 4 * version + 17;
  const count = Math.floor(version / 7) + 2;
  const step =
    version === 32
      ? 26
      : Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;

  const result: number[] = [];
  for (let i = 0, pos = size - 7; i < count - 1; i++, pos -= step) {
    result.unshift(pos);
  }
  result.unshift(6);
  return result;
}

/** 去掉功能图形后，可用于承载数据与纠错码字的模块总数。 */
export function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const count = Math.floor(version / 7) + 2;
    result -= (25 * count - 10) * count - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** 数据码字数（不含纠错码字）。 */
export function numDataCodewords(version: number, ecc: QrEcc): number {
  return (
    Math.floor(rawDataModules(version) / 8) -
    tableAt(ECC_CODEWORDS_PER_BLOCK, ecc, version) * tableAt(ECC_BLOCK_COUNT, ecc, version)
  );
}

/**
 * byte 模式下能装多少字节。
 *
 * 扣掉 4 位模式指示符与字符计数指示符（version 1–9 用 8 位，10–40 用 16 位）。
 */
export function qrCapacityBytes(version: number, ecc: QrEcc): number {
  const bits = numDataCodewords(version, ecc) * 8 - 4 - charCountBits(version);
  return Math.max(0, Math.floor(bits / 8));
}

/**
 * byte 模式的字符计数指示符位宽。
 *
 * version 9→10 的这个跳变是经典的 off-by-one 来源：写错的话
 * version 10 附近的码全部解不出来，而更小的版本一切正常。
 */
function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

// ─────────────────────────────────────────────────────────────
//  GF(256) 算术与 Reed-Solomon
// ─────────────────────────────────────────────────────────────
//
// 本原多项式 0x11D。表在模块加载时用 12 行循环生成，不内联 512 个字面量。

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  // 后半段是前半段的重复，让 exp 相加后不必取模
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255] ?? 0;
}

/** GF(256) 乘法。 */
export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)] ?? 0;
}

/** 生成多项式：(x - α⁰)(x - α¹)…(x - α^(degree-1))，返回系数（不含首项 1）。 */
export function rsGeneratorPoly(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      const cur = result[j] ?? 0;
      const next = result[j + 1] ?? 0;
      result[j] = gfMul(cur, root) ^ next;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** 多项式带余除法的余数，即纠错码字。 */
export function rsRemainder(data: Uint8Array, generator: Uint8Array): Uint8Array {
  const result = new Uint8Array(generator.length);
  for (const b of data) {
    const factor = b ^ (result[0] ?? 0);
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) {
      result[i] = (result[i] ?? 0) ^ gfMul(generator[i] ?? 0, factor);
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
//  数据编码
// ─────────────────────────────────────────────────────────────

/**
 * 只实现 byte 模式（UTF-8），不做 alphanumeric 优化 —— 这不是偷懒。
 *
 * alphanumeric 的字符集只有 45 个：`0-9 A-Z $ % * + - . / : 空格`，**不含小写字母**。
 * 而这里要编的两样东西：订阅链接（base64url token + 小写域名）与节点 URI
 * （vmess 的 base64、UUID、密码、百分号编码）——**一个字符都进不去**。
 * 实现它需要额外一套分段最优切分的动态规划，收益在本项目恒等于零。
 *
 * ECI 同理不需要：两个场景的 payload 实测 100% 是 ASCII，不存在字符集歧义。
 */
function encodeByteSegment(bytes: Uint8Array, version: number, dataCodewords: number): Uint8Array {
  const bits: number[] = [];
  const push = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // 模式指示符：byte
  push(bytes.length, charCountBits(version));
  for (const b of bytes) push(b, 8);

  const capacityBits = dataCodewords * 8;
  // 终止符最多 4 位，不足则截短
  push(0, Math.min(4, capacityBits - bits.length));
  // 补齐到字节边界
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(dataCodewords);
  for (let i = 0; i < bits.length; i++) {
    if ((bits[i] ?? 0) === 1) {
      const idx = i >>> 3;
      out[idx] = (out[idx] ?? 0) | (0x80 >>> (i & 7));
    }
  }
  // 交替填充 0xEC / 0x11 直到装满
  for (let i = bits.length / 8, pad = 0xec; i < dataCodewords; i++, pad ^= 0xec ^ 0x11) {
    out[i] = pad;
  }
  return out;
}

/**
 * 分块、算纠错码字、交织。
 *
 * **交织顺序错了，症状是"码画得出来但扫不出"** —— 没有任何异常。
 * 这是整个文件最需要外部验证的一段。
 */
function addEccAndInterleave(data: Uint8Array, version: number, ecc: QrEcc): Uint8Array {
  const blockCount = tableAt(ECC_BLOCK_COUNT, ecc, version);
  const eccPerBlock = tableAt(ECC_CODEWORDS_PER_BLOCK, ecc, version);
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  /** 短块的总长（含纠错码字）。 */
  const shortBlockTotal = Math.floor(rawCodewords / blockCount);
  /** 短块的数据码字数。 */
  const shortDataLen = shortBlockTotal - eccPerBlock;
  /** 前这么多个块是短块，其余每块多一个数据码字。 */
  const shortBlockCount = blockCount - (rawCodewords % blockCount);

  // 每个块都按**最长块**的尺寸分配：数据区 + 一个填充空位 + 纠错区。
  // 短块的数据区末尾那格是空的，交织时会被跳过。
  //
  // 这个"留空位"的布局是关键：若让纠错码字直接紧跟短块的数据（不留空位），
  // 交织时跳过的就不再是空位而是**第一个纠错码字**，块尾还会读越界 ——
  // 码照样画得出来，但扫不出来，且不抛任何异常。
  const blockLen = shortBlockTotal + 1;
  const generator = rsGeneratorPoly(eccPerBlock);
  const blocks: Uint8Array[] = [];
  for (let i = 0, k = 0; i < blockCount; i++) {
    const dataLen = shortDataLen + (i < shortBlockCount ? 0 : 1);
    const dat = data.slice(k, k + dataLen);
    k += dataLen;
    const block = new Uint8Array(blockLen);
    block.set(dat, 0);
    block.set(rsRemainder(dat, generator), blockLen - eccPerBlock);
    blocks.push(block);
  }

  const result = new Uint8Array(rawCodewords);
  let pos = 0;
  for (let i = 0; i < blockLen; i++) {
    for (let j = 0; j < blockCount; j++) {
      // 跳过短块数据区末尾的填充空位
      if (i === shortDataLen && j < shortBlockCount) continue;
      const v = blocks[j]?.[i];
      if (v === undefined) continue;
      result[pos++] = v;
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
//  矩阵
// ─────────────────────────────────────────────────────────────
//
// 内部用**一维 Uint8Array** 而不是 boolean[][]，为的是把
// `noUncheckedIndexedAccess` 带来的 `| undefined` 收窄集中在两个访问器里。
// 否则这个满是二维格点访问的文件会长出上百个 `!` 断言。
// 全文件零 `!`，这条可以直接写进 review checklist。

interface Grid {
  readonly size: number;
  readonly modules: Uint8Array;
  readonly isFunction: Uint8Array;
}

function makeGrid(size: number): Grid {
  return { size, modules: new Uint8Array(size * size), isFunction: new Uint8Array(size * size) };
}

function getModule(grid: Grid, x: number, y: number): boolean {
  return (grid.modules[y * grid.size + x] ?? 0) !== 0;
}

function setModule(grid: Grid, x: number, y: number, dark: boolean): void {
  grid.modules[y * grid.size + x] = dark ? 1 : 0;
}

function setFunctionModule(grid: Grid, x: number, y: number, dark: boolean): void {
  setModule(grid, x, y, dark);
  grid.isFunction[y * grid.size + x] = 1;
}

function isFunctionModule(grid: Grid, x: number, y: number): boolean {
  return (grid.isFunction[y * grid.size + x] ?? 0) !== 0;
}

function inRange(grid: Grid, x: number, y: number): boolean {
  return x >= 0 && x < grid.size && y >= 0 && y < grid.size;
}

/** 定位图形（7×7 同心方环）及其分隔符。 */
function drawFinder(grid: Grid, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy)); // 切比雪夫距离
      const x = cx + dx;
      const y = cy + dy;
      if (inRange(grid, x, y)) setFunctionModule(grid, x, y, dist !== 2 && dist !== 4);
    }
  }
}

/** 对齐图形（5×5 同心方环）。 */
function drawAlignment(grid: Grid, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFunctionModule(grid, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

/**
 * 格式信息：15 位 BCH(15,5)，生成多项式 0x537，末了 XOR 0x5412。
 * 用代码算而不是抄那张 32 项的表 —— 表放进测试里当对拍 oracle，
 * 两个独立来源互相验证，比在生产代码里抄一遍靠谱。
 */
function drawFormatBits(grid: Grid, ecc: QrEcc, mask: number): void {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;

  // 左上角，分两段
  for (let i = 0; i <= 5; i++) setFunctionModule(grid, 8, i, bit(i));
  setFunctionModule(grid, 8, 7, bit(6));
  setFunctionModule(grid, 8, 8, bit(7));
  setFunctionModule(grid, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFunctionModule(grid, 14 - i, 8, bit(i));

  // 右上与左下，另一份拷贝
  const size = grid.size;
  for (let i = 0; i < 8; i++) setFunctionModule(grid, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFunctionModule(grid, 8, size - 15 + i, bit(i));
  setFunctionModule(grid, 8, size - 8, true); // 恒深模块
}

/** 版本信息：18 位 BCH(18,6)，生成多项式 0x1F25。仅 version ≥ 7。 */
function drawVersionBits(grid: Grid, version: number): void {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;

  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = grid.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunctionModule(grid, a, b, dark);
    setFunctionModule(grid, b, a, dark);
  }
}

function drawFunctionPatterns(grid: Grid, version: number, ecc: QrEcc): void {
  const size = grid.size;

  // 定时图形：第 6 行与第 6 列交替
  for (let i = 0; i < size; i++) {
    setFunctionModule(grid, 6, i, i % 2 === 0);
    setFunctionModule(grid, i, 6, i % 2 === 0);
  }

  drawFinder(grid, 3, 3);
  drawFinder(grid, size - 4, 3);
  drawFinder(grid, 3, size - 4);

  // 对齐图形，跳过与三个定位图形重叠的角
  const positions = alignmentPositions(version);
  const n = positions.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      const px = positions[i];
      const py = positions[j];
      if (px !== undefined && py !== undefined) drawAlignment(grid, px, py);
    }
  }

  // 先用掩码 0 占位，真正的掩码定下来后会重画
  drawFormatBits(grid, ecc, 0);
  drawVersionBits(grid, version);
}

/**
 * 把码字按蛇形铺进矩阵。
 *
 * 从右下角起每次取两列向上/向下交替；**第 6 列要跳过**，那是竖向定时图形。
 */
function drawCodewords(grid: Grid, data: Uint8Array): void {
  const size = grid.size;
  let i = 0; // 位游标
  for (let right = size - 1; right >= 1; right -= 2) {
    // 跳过竖向定时图形所在的第 6 列。**必须改写 right 本身**，
    // 因为下一轮是 `right -= 2`：写成局部变量的话列序会从
    // …8,6→5,3,1 变成 …8,6,4,2，整个数据区全错位。
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunctionModule(grid, x, y) && i < data.length * 8) {
          const byte = data[i >>> 3] ?? 0;
          setModule(grid, x, y, ((byte >>> (7 - (i & 7))) & 1) !== 0);
          i++;
        }
        // 剩余位保持浅色（规范允许，且解码器会忽略）
      }
    }
  }
}

function maskPredicate(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return false;
  }
}

/** 对非功能模块取反。同一个掩码连用两次即还原。 */
function applyMask(grid: Grid, mask: number): void {
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      if (!isFunctionModule(grid, x, y) && maskPredicate(mask, x, y)) {
        setModule(grid, x, y, !getModule(grid, x, y));
      }
    }
  }
}

/** 规范定义的四条惩罚规则，用来挑出可读性最好的掩码。 */
function penaltyScore(grid: Grid): number {
  const size = grid.size;
  let score = 0;

  // N1：行/列上连续同色 ≥5
  const runScore = (run: number): number => (run >= 5 ? 3 + (run - 5) : 0);
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (getModule(grid, x, y) === getModule(grid, x - 1, y)) run++;
      else {
        score += runScore(run);
        run = 1;
      }
    }
    score += runScore(run);
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (getModule(grid, x, y) === getModule(grid, x, y - 1)) run++;
      else {
        score += runScore(run);
        run = 1;
      }
    }
    score += runScore(run);
  }

  // N2：每个 2×2 同色块
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = getModule(grid, x, y);
      if (c === getModule(grid, x + 1, y) && c === getModule(grid, x, y + 1) && c === getModule(grid, x + 1, y + 1)) {
        score += 3;
      }
    }
  }

  // N3：形似定位图形的 1:1:3:1:1 模式，任一侧带 ≥4 浅色
  const PATTERN = [true, false, true, true, true, false, true];
  const matchesAt = (get: (i: number) => boolean, start: number, len: number): boolean => {
    // 主体 7 格
    for (let k = 0; k < 7; k++) {
      const idx = start + k;
      if (idx < 0 || idx >= len || get(idx) !== PATTERN[k]) return false;
    }
    // 一侧要有 4 格连续浅色（超出边界视为浅色）
    const before = [-4, -3, -2, -1].every((d) => {
      const idx = start + d;
      return idx < 0 || !get(idx);
    });
    const after = [7, 8, 9, 10].every((d) => {
      const idx = start + d;
      return idx >= len || !get(idx);
    });
    return before || after;
  };
  for (let y = 0; y < size; y++) {
    const get = (x: number): boolean => getModule(grid, x, y);
    for (let x = -4; x < size; x++) if (matchesAt(get, x, size)) score += 40;
  }
  for (let x = 0; x < size; x++) {
    const get = (y: number): boolean => getModule(grid, x, y);
    for (let y = -4; y < size; y++) if (matchesAt(get, y, size)) score += 40;
  }

  // N4：深色占比每偏离 50% 五个百分点记 10 分
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (getModule(grid, x, y)) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * 10;

  return score;
}

// ─────────────────────────────────────────────────────────────
//  入口
// ─────────────────────────────────────────────────────────────

export function encodeQr(text: string, options: QrEncodeOptions = {}): QrEncodeResult {
  const minEcc = options.minEcc ?? 'M';
  const maxVersion = Math.min(options.maxVersion ?? QR_MAX_VERSION, 40);
  const bytes = new TextEncoder().encode(text);

  if (bytes.length === 0) {
    return { ok: false, reason: '内容为空', byteLength: 0, capacity: qrCapacityBytes(maxVersion, minEcc) };
  }

  // 选能装下的最小版本
  let version = -1;
  for (let v = 1; v <= maxVersion; v++) {
    if (bytes.length <= qrCapacityBytes(v, minEcc)) {
      version = v;
      break;
    }
  }
  if (version < 0) {
    const capacity = qrCapacityBytes(maxVersion, minEcc);
    return {
      ok: false,
      // 明确拒绝，**绝不降级到 L 硬塞**：那能装下更多，但产出的是一张
      // 117×117 的低纠错码 —— 恰恰是最容易扫不出的组合，而且失败是静默的
      // （用户只知道扫不出来，不知道为什么）。与"跳过节点必须上报"同一条原则。
      reason: `内容 ${bytes.length} 字节，超出可靠出码上限 ${capacity} 字节`,
      byteLength: bytes.length,
      capacity,
    };
  }

  // 免费升级纠错级别：符号尺寸已经定死了，能塞更强的纠错就塞
  let ecc = minEcc;
  for (const candidate of ['H', 'Q', 'M'] as const) {
    if (
      QR_ECC_LEVELS.indexOf(candidate) > QR_ECC_LEVELS.indexOf(minEcc) &&
      bytes.length <= qrCapacityBytes(version, candidate)
    ) {
      ecc = candidate;
      break;
    }
  }

  const dataCodewords = numDataCodewords(version, ecc);
  const segment = encodeByteSegment(bytes, version, dataCodewords);
  const codewords = addEccAndInterleave(segment, version, ecc);

  const size = 4 * version + 17;
  const grid = makeGrid(size);
  drawFunctionPatterns(grid, version, ecc);
  drawCodewords(grid, codewords);

  // 选掩码：逐个试，取惩罚分最低者；平局取编号最小。全程确定性。
  let mask = options.forceMask ?? -1;
  if (mask < 0) {
    let best = Number.POSITIVE_INFINITY;
    for (let m = 0; m < 8; m++) {
      applyMask(grid, m);
      drawFormatBits(grid, ecc, m);
      const score = penaltyScore(grid);
      if (score < best) {
        best = score;
        mask = m;
      }
      applyMask(grid, m); // 还原
    }
  }
  applyMask(grid, mask);
  drawFormatBits(grid, ecc, mask);

  const modules: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x++) row.push(getModule(grid, x, y));
    modules.push(row);
  }

  return { ok: true, matrix: { version, size, ecc, mask, modules } };
}

// ─────────────────────────────────────────────────────────────
//  SVG 渲染
// ─────────────────────────────────────────────────────────────

export interface QrSvgOptions {
  /** 静区模块数，默认 4（规范最小值，少于 4 显著降低识别率）。 */
  quietZone?: number;
  /** 深色，默认 `#000000`。只接受 #RGB / #RRGGBB。 */
  dark?: string;
  /** 浅色（含静区底色），默认 `#ffffff`。 */
  light?: string;
  /** `<title>` 无障碍文本。**绝不要把二维码内容传进来。** */
  title?: string;
}

const COLOR_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

function safeColor(value: string | undefined, fallback: string): string {
  return value !== undefined && COLOR_RE.test(value) ? value : fallback;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 渲染成自包含的 SVG 字符串。
 *
 * 选 SVG 而不是 PNG：出 PNG 要自己实现 deflate 与 CRC32（再加一百多行同样易错的
 * 代码），而 SVG 只是字符串拼接。矢量在放大与打印时也不会糊 —— 对高版本的
 * 密集码这是决定性的。
 *
 * **必须自带白色背景矩形**：界面有暗色主题，靠页面背景当静区的话，
 * 深色模式下静区会被"吃掉"，直接导致扫不出来。
 *
 * 每行连续的深色模块合并成一段路径。version 25 有 13689 个模块，
 * 逐个 `<rect>` 会产出数千个 DOM 节点和几百 KB 字符串；合并后通常只有几 KB。
 */
export function renderQrSvg(matrix: QrMatrix, options: QrSvgOptions = {}): string {
  const quiet = Math.max(0, Math.floor(options.quietZone ?? 4));
  const dark = safeColor(options.dark, '#000000');
  const light = safeColor(options.light, '#ffffff');
  const total = matrix.size + quiet * 2;

  const parts: string[] = [];
  for (let y = 0; y < matrix.size; y++) {
    const row = matrix.modules[y] ?? [];
    let x = 0;
    while (x < matrix.size) {
      if (row[x] !== true) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < matrix.size && row[x + run] === true) run++;
      parts.push(`M${x + quiet} ${y + quiet}h${run}v1h-${run}z`);
      x += run;
    }
  }

  const title = options.title === undefined ? '' : `<title>${escapeXml(options.title)}</title>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `width="100%" height="100%" shape-rendering="crispEdges" role="img">` +
    title +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path fill="${dark}" d="${parts.join('')}"/>` +
    `</svg>`
  );
}
