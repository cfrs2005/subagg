/**
 * 规则集格式嗅探与归一。
 *
 * ## 这个文件解决什么问题
 *
 * Shadowrocket / Surge / Clash 三家的规则集**格式各不相同**，但文件名长得
 * 很像，扩展名也不可信：
 *
 * | 来源 | 实际内容 |
 * |---|---|
 * | `blackmatrix7/.../Shadowrocket/X/X_Domain.list` | 前导点后缀（`.0.zone`），11 万行 |
 * | `blackmatrix7/.../Shadowrocket/X/X.list` | Surge 语法（`DOMAIN-SUFFIX,x`） |
 * | `blackmatrix7/.../Clash/X/X_Domain.txt` | Clash payload（`- '+.x'`） |
 * | 各种机场自定义 | 裸域名一行一个 |
 * | `github.com/.../blob/...` | **HTML 页面** |
 *
 * 以前的做法是按 URL 里有没有 "domain" 字样猜 `behavior`，猜对了格式也未必对
 * ——最典型的就是那 11 万行前导点列表被当成 `behavior: domain` 直接喂给
 * Clash：前导点不是 Clash 的后缀语法（只认 `+.x` / `*.x` / 裸域名），
 * 结果整层规则静默失效，看起来配了，实际一条不生效。
 *
 * 所以格式判断必须看**内容**，不看文件名；归一在服务端做一次，
 * 客户端只拿到自己 behavior 对应的干净格式。
 *
 * 本文件属于 core 纯函数层：无 IO。
 */

export type RuleSetBehavior = 'domain' | 'classical' | 'ipcidr';

/** 嗅探到的源格式。只用于诊断与日志，不影响输出。 */
export type RuleSetFormat =
  | 'clash-payload'
  | 'surge'
  | 'leading-dot'
  | 'plain-domain'
  | 'ipcidr'
  | 'html'
  | 'other';

export interface ConvertedRuleSet {
  format: RuleSetFormat;
  /** 按目标 behavior 渲染后的正文。 */
  body: string;
  /** 有效条目数。 */
  count: number;
  /** 因类型不兼容而被丢掉的条目数。 */
  dropped: number;
}

interface Buckets {
  suffix: Set<string>;
  exact: Set<string>;
  cidr: Set<string>;
  wildcard: Set<string>;
  other: number;
  surgeLines: number;
  payloadLines: number;
  leadingDotLines: number;
}

const MAX_ENTRIES = 400_000;

/** 常见 CIDR：`10.0.0.0/8`、`2001:db8::/32`。 */
function isCidr(value: string): boolean {
  return /^[0-9a-fA-F:.]+\/\d{1,3}$/.test(value);
}

/** 看起来像域名：至少一个点，只含域名合法字符。 */
function isDomainLike(value: string): boolean {
  if (value.length > 253) return false;
  if (!value.includes('.')) return false;
  return /^[A-Za-z0-9._*+-]+\.[A-Za-z0-9-]+$/.test(value);
}

function isHtml(text: string): boolean {
  const head = text.slice(0, 512).trimStart().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml');
}

function meaningfulLines(text: string): string[] {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith('#') &&
        !line.startsWith(';') &&
        !line.startsWith('//'),
    );
}

/** 去掉 YAML payload 的 `- ` 前缀与引号。 */
function stripPayloadPrefix(line: string): string | undefined {
  if (!line.startsWith('-')) return undefined;
  return line
    .slice(1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

/**
 * 把任意一行拆成「语义 + 值」。
 *
 * 顺序是有讲究的：先看显式的 Surge 类型前缀（最不容易误判），再看
 * 前缀符号（`.` / `+.` / `*.`），最后才按形状猜。
 */
function classify(line: string, buckets: Buckets, inPayload = false): void {
  const payload = stripPayloadPrefix(line);
  if (payload !== undefined) {
    buckets.payloadLines += 1;
    if (payload) classify(payload, buckets, true);
    return;
  }

  const typed = /^([A-Z-]+),(.+)$/.exec(line);
  if (typed) {
    const kind = (typed[1] ?? '').toUpperCase();
    const value = (typed[2] ?? '').split(',')[0]?.trim() ?? '';
    buckets.surgeLines += 1;
    if (!value) {
      buckets.other += 1;
      return;
    }
    if (kind === 'DOMAIN-SUFFIX') {
      buckets.suffix.add(value);
      return;
    }
    if (kind === 'DOMAIN') {
      buckets.exact.add(value);
      return;
    }
    if (kind === 'IP-CIDR' || kind === 'IP-CIDR6') {
      buckets.cidr.add(value);
      return;
    }
    // DOMAIN-KEYWORD / USER-AGENT / PROCESS-NAME 这类在 domain-provider 里
    // 无法表达，如实计数而不是悄悄塞进去。
    buckets.other += 1;
    return;
  }

  if (line.startsWith('+.')) {
    buckets.suffix.add(line.slice(2));
    return;
  }
  if (line.startsWith('*.')) {
    buckets.wildcard.add(line.slice(2));
    return;
  }
  if (line.startsWith('.')) {
    buckets.leadingDotLines += 1;
    // Shadowrocket 的 DOMAIN-SET 用前导点表示后缀，Clash 要 `+.x`。
    buckets.suffix.add(line.slice(1));
    return;
  }
  if (isCidr(line)) {
    buckets.cidr.add(line);
    return;
  }
  if (isDomainLike(line)) {
    // Clash payload 里的裸域名是**精确匹配**（`DOMAIN,x`）；而通用的裸域名
    // 列表在实践中都是「含子域」语义。跟着来源走，不擅自放宽匹配范围 ——
    // 把 DOMAIN 当 DOMAIN-SUFFIX 会让原本精确的规则突然覆盖整棵子树。
    if (inPayload) buckets.exact.add(line);
    else buckets.suffix.add(line);
    return;
  }

  buckets.other += 1;
}

/**
 * 把规则集源文本按目标 behavior 归一。
 *
 * @returns 无法转换（HTML、空集、全是不可表达的类型）时返回 `null`，
 *   调用方应当退回上游原始 URL，而不是下发一份空规则集 ——
 *   空规则集不会报错，只会让流量悄悄走错路。
 */
export function convertRuleSet(text: string, behavior: RuleSetBehavior): ConvertedRuleSet | null {
  if (isHtml(text)) return null;

  const buckets: Buckets = {
    suffix: new Set(),
    exact: new Set(),
    cidr: new Set(),
    wildcard: new Set(),
    other: 0,
    surgeLines: 0,
    payloadLines: 0,
    leadingDotLines: 0,
  };

  for (const line of meaningfulLines(text).slice(0, MAX_ENTRIES)) {
    classify(line, buckets);
  }

  const out: string[] = [];
  let dropped = buckets.other;

  if (behavior === 'domain') {
    for (const value of buckets.suffix) out.push(`+.${value}`);
    for (const value of buckets.wildcard) out.push(`*.${value}`);
    for (const value of buckets.exact) out.push(value);
    dropped += buckets.cidr.size;
  } else if (behavior === 'ipcidr') {
    for (const value of buckets.cidr) out.push(value);
    dropped += buckets.suffix.size + buckets.wildcard.size + buckets.exact.size;
  } else {
    for (const value of buckets.suffix) out.push(`DOMAIN-SUFFIX,${value}`);
    for (const value of buckets.wildcard) out.push(`DOMAIN-SUFFIX,${value}`);
    for (const value of buckets.exact) out.push(`DOMAIN,${value}`);
    for (const value of buckets.cidr) out.push(`IP-CIDR,${value}`);
  }

  const unique = [...new Set(out)];
  if (unique.length === 0) return null;

  return {
    format: sniffFormat(buckets),
    body: `${unique.join('\n')}\n`,
    count: unique.length,
    dropped,
  };
}

function sniffFormat(buckets: Buckets): RuleSetFormat {
  if (buckets.payloadLines > 0) return 'clash-payload';
  if (buckets.surgeLines > 0) return 'surge';
  if (buckets.leadingDotLines > 0) return 'leading-dot';
  if (buckets.cidr.size > 0 && buckets.suffix.size === 0 && buckets.exact.size === 0) {
    return 'ipcidr';
  }
  if (buckets.suffix.size > 0 || buckets.exact.size > 0) return 'plain-domain';
  return 'other';
}
