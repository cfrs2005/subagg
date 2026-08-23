/**
 * 从节点名推断地区。
 *
 * 上游订阅不会告诉你节点在哪个国家 —— 唯一的线索就是节点名，而节点名是机场随手写的：
 *
 *     🇺🇸美国 | 霍格沃茨特快列车
 *     HK-Premium-02 IEPL
 *     JP-Softbank-01
 *     Los Angeles 01
 *
 * 本模块把这些五花八门的写法统一成 ISO 3166-1 alpha-2 代码（`US` / `HK` / `JP`），
 * 供过滤规则、分组生成和 UI 使用。
 *
 * ## 为什么统一到 ISO 代码
 *
 * 原型里用的是 `UK`，但 ISO 标准是 `GB`。混用会导致"英国"节点在过滤时对不上。
 * 这里的做法是：**存储用 ISO 代码，显示用本地化名称**。`UK` 作为输入别名接受，
 * 但一律归一化为 `GB`；显示层再把 `GB` 渲染成"英国"和 🇬🇧。
 *
 * ## 匹配策略（按置信度从高到低）
 *
 * 1. **旗帜 emoji** —— 置信度最高。Unicode 的区域指示符本身就编码了 ISO 代码，
 *    是无歧义的机器可读信号。
 * 2. **关键词** —— 中文地名、英文地名、城市名。含 CJK 的关键词用子串匹配，
 *    纯 ASCII 的关键词用词边界匹配（否则 `Japan` 会在 `Japanese` 里命中，
 *    `us` 会在 `Houston` 里命中）。
 * 3. **裸国家代码** —— 如 `HK-01` 里的 `HK`。两字母代码与英文单词碰撞严重
 *    （`IN` = India 会匹配一切含 "in" 的名字），所以只对一份**手工确认过的安全清单**
 *    做此匹配，且要求前后是非字母字符。
 *
 * 三轮都匹配不上就返回 `undefined` —— 猜错地区比不猜更糟，
 * 用户按"香港"筛选时冒出一个美国节点，会直接导致误用。
 *
 * 本文件属于 core 纯函数层：无 IO。
 */

/** 地区定义。`keywords` 全部小写存放，匹配时把待测字符串一并转小写。 */
interface RegionDef {
  /** ISO 3166-1 alpha-2。 */
  code: string;
  /** 中文显示名。 */
  zh: string;
  /** 英文显示名。 */
  en: string;
  /** 用于识别的关键词：中文名、英文名、常见城市名、机场惯用简称。 */
  keywords: string[];
}

/**
 * 地区表。
 *
 * 收录范围以"机场订阅里实际会出现的地区"为准，不追求覆盖全部 249 个 ISO 代码 ——
 * 表越长，关键词误匹配的概率越高。需要补充时直接往里加即可。
 *
 * 关键词的取舍原则：**宁可漏判，不可误判**。所以像"日"（JP）、"新"（SG）、
 * "台"（TW）这类单字都没有收录 —— 它们在"每日重置""最新公告""控制台"里都会命中。
 */
const REGIONS: readonly RegionDef[] = [
  // ── 亚太 ──────────────────────────────────────────
  {
    code: 'HK',
    zh: '香港',
    en: 'Hong Kong',
    keywords: ['香港', '港岛', '深港', 'hongkong', 'hong kong', 'hkg', '沙田', '荃湾'],
  },
  {
    code: 'TW',
    zh: '台湾',
    en: 'Taiwan',
    keywords: ['台湾', '臺灣', '台北', '臺北', '新北', '彰化', '高雄', 'taiwan', 'taipei'],
  },
  {
    code: 'JP',
    zh: '日本',
    en: 'Japan',
    keywords: [
      '日本', '东京', '東京', '大阪', '埼玉', '名古屋', '横滨', '橫濱', '川日',
      'japan', 'tokyo', 'osaka', 'saitama', 'nagoya', 'softbank', 'docomo',
    ],
  },
  {
    code: 'SG',
    zh: '新加坡',
    en: 'Singapore',
    keywords: ['新加坡', '狮城', '獅城', '坡县', 'singapore', 'singapur'],
  },
  {
    code: 'KR',
    zh: '韩国',
    en: 'South Korea',
    keywords: ['韩国', '韓國', '首尔', '首爾', '春川', 'korea', 'seoul'],
  },
  { code: 'MO', zh: '澳门', en: 'Macao', keywords: ['澳门', '澳門', 'macao', 'macau'] },
  {
    code: 'CN',
    zh: '中国',
    en: 'China',
    keywords: ['中国', '中國', '国内', '國內', '回国', '回國', '北京', '上海', '广州', '深圳', 'china'],
  },
  { code: 'MY', zh: '马来西亚', en: 'Malaysia', keywords: ['马来西亚', '馬來西亞', '吉隆坡', 'malaysia', 'kuala lumpur'] },
  { code: 'TH', zh: '泰国', en: 'Thailand', keywords: ['泰国', '泰國', '曼谷', 'thailand', 'bangkok'] },
  { code: 'VN', zh: '越南', en: 'Vietnam', keywords: ['越南', '胡志明', 'vietnam', 'viet nam'] },
  { code: 'PH', zh: '菲律宾', en: 'Philippines', keywords: ['菲律宾', '菲律賓', '马尼拉', 'philippines', 'manila'] },
  { code: 'ID', zh: '印尼', en: 'Indonesia', keywords: ['印尼', '印度尼西亚', '雅加达', 'indonesia', 'jakarta'] },
  { code: 'IN', zh: '印度', en: 'India', keywords: ['印度', '孟买', '孟買', '班加罗尔', 'india', 'mumbai', 'bangalore'] },
  { code: 'PK', zh: '巴基斯坦', en: 'Pakistan', keywords: ['巴基斯坦', 'pakistan'] },
  { code: 'BD', zh: '孟加拉', en: 'Bangladesh', keywords: ['孟加拉', 'bangladesh'] },
  { code: 'KZ', zh: '哈萨克斯坦', en: 'Kazakhstan', keywords: ['哈萨克', '哈薩克', 'kazakhstan'] },
  { code: 'AU', zh: '澳大利亚', en: 'Australia', keywords: ['澳大利亚', '澳洲', '悉尼', '墨尔本', 'australia', 'sydney', 'melbourne'] },
  { code: 'NZ', zh: '新西兰', en: 'New Zealand', keywords: ['新西兰', '紐西蘭', '奥克兰', 'new zealand', 'auckland'] },

  // ── 北美 ──────────────────────────────────────────
  {
    code: 'US',
    zh: '美国',
    en: 'United States',
    keywords: [
      '美国', '美國', '洛杉矶', '洛杉磯', '圣何塞', '聖何塞', '西雅图', '西雅圖',
      '芝加哥', '纽约', '紐約', '达拉斯', '達拉斯', '硅谷', '矽谷', '凤凰城', '鳳凰城',
      '阿什本', '迈阿密', '邁阿密', '亚特兰大', '波特兰',
      'united states', 'america', 'usa', 'los angeles', 'san jose', 'seattle',
      'chicago', 'new york', 'dallas', 'phoenix', 'ashburn', 'miami', 'atlanta',
      'silicon valley', 'portland',
    ],
  },
  { code: 'CA', zh: '加拿大', en: 'Canada', keywords: ['加拿大', '多伦多', '多倫多', '温哥华', '溫哥華', 'canada', 'toronto', 'vancouver', 'montreal'] },
  { code: 'MX', zh: '墨西哥', en: 'Mexico', keywords: ['墨西哥', 'mexico'] },

  // ── 欧洲 ──────────────────────────────────────────
  {
    code: 'GB',
    zh: '英国',
    en: 'United Kingdom',
    keywords: ['英国', '英國', '伦敦', '倫敦', '曼彻斯特', 'united kingdom', 'england', 'britain', 'london', 'manchester'],
  },
  { code: 'DE', zh: '德国', en: 'Germany', keywords: ['德国', '德國', '法兰克福', '法蘭克福', '柏林', 'germany', 'frankfurt', 'berlin', 'deutschland'] },
  { code: 'FR', zh: '法国', en: 'France', keywords: ['法国', '法國', '巴黎', '马赛', 'france', 'paris', 'marseille'] },
  { code: 'NL', zh: '荷兰', en: 'Netherlands', keywords: ['荷兰', '荷蘭', '阿姆斯特丹', 'netherlands', 'holland', 'amsterdam'] },
  { code: 'RU', zh: '俄罗斯', en: 'Russia', keywords: ['俄罗斯', '俄羅斯', '莫斯科', '圣彼得堡', 'russia', 'moscow', 'saint petersburg'] },
  { code: 'IT', zh: '意大利', en: 'Italy', keywords: ['意大利', '米兰', '米蘭', '罗马', '羅馬', 'italy', 'milan', 'rome'] },
  { code: 'ES', zh: '西班牙', en: 'Spain', keywords: ['西班牙', '马德里', '巴塞罗那', 'spain', 'madrid', 'barcelona'] },
  { code: 'PT', zh: '葡萄牙', en: 'Portugal', keywords: ['葡萄牙', '里斯本', 'portugal', 'lisbon'] },
  { code: 'CH', zh: '瑞士', en: 'Switzerland', keywords: ['瑞士', '苏黎世', '蘇黎世', 'switzerland', 'zurich'] },
  { code: 'SE', zh: '瑞典', en: 'Sweden', keywords: ['瑞典', '斯德哥尔摩', 'sweden', 'stockholm'] },
  { code: 'NO', zh: '挪威', en: 'Norway', keywords: ['挪威', '奥斯陆', 'norway', 'oslo'] },
  { code: 'FI', zh: '芬兰', en: 'Finland', keywords: ['芬兰', '芬蘭', '赫尔辛基', 'finland', 'helsinki'] },
  { code: 'DK', zh: '丹麦', en: 'Denmark', keywords: ['丹麦', '丹麥', '哥本哈根', 'denmark', 'copenhagen'] },
  { code: 'PL', zh: '波兰', en: 'Poland', keywords: ['波兰', '波蘭', '华沙', 'poland', 'warsaw'] },
  { code: 'IE', zh: '爱尔兰', en: 'Ireland', keywords: ['爱尔兰', '愛爾蘭', '都柏林', 'ireland', 'dublin'] },
  { code: 'AT', zh: '奥地利', en: 'Austria', keywords: ['奥地利', '奧地利', '维也纳', 'austria', 'vienna'] },
  { code: 'BE', zh: '比利时', en: 'Belgium', keywords: ['比利时', '比利時', '布鲁塞尔', 'belgium', 'brussels'] },
  { code: 'UA', zh: '乌克兰', en: 'Ukraine', keywords: ['乌克兰', '烏克蘭', '基辅', 'ukraine', 'kyiv', 'kiev'] },
  { code: 'CZ', zh: '捷克', en: 'Czechia', keywords: ['捷克', '布拉格', 'czech', 'prague'] },
  { code: 'HU', zh: '匈牙利', en: 'Hungary', keywords: ['匈牙利', '布达佩斯', 'hungary', 'budapest'] },
  { code: 'RO', zh: '罗马尼亚', en: 'Romania', keywords: ['罗马尼亚', '羅馬尼亞', 'romania', 'bucharest'] },
  { code: 'GR', zh: '希腊', en: 'Greece', keywords: ['希腊', '希臘', '雅典', 'greece', 'athens'] },
  { code: 'RS', zh: '塞尔维亚', en: 'Serbia', keywords: ['塞尔维亚', 'serbia', 'belgrade'] },
  { code: 'BG', zh: '保加利亚', en: 'Bulgaria', keywords: ['保加利亚', 'bulgaria', 'sofia'] },
  { code: 'IS', zh: '冰岛', en: 'Iceland', keywords: ['冰岛', '冰島', 'iceland', 'reykjavik'] },
  { code: 'LU', zh: '卢森堡', en: 'Luxembourg', keywords: ['卢森堡', '盧森堡', 'luxembourg'] },
  { code: 'MD', zh: '摩尔多瓦', en: 'Moldova', keywords: ['摩尔多瓦', 'moldova'] },
  { code: 'LT', zh: '立陶宛', en: 'Lithuania', keywords: ['立陶宛', 'lithuania'] },
  { code: 'LV', zh: '拉脱维亚', en: 'Latvia', keywords: ['拉脱维亚', 'latvia'] },
  { code: 'EE', zh: '爱沙尼亚', en: 'Estonia', keywords: ['爱沙尼亚', 'estonia'] },

  // ── 中东 / 非洲 / 南美 ─────────────────────────────
  { code: 'TR', zh: '土耳其', en: 'Türkiye', keywords: ['土耳其', '伊斯坦布尔', 'turkey', 'turkiye', 'istanbul'] },
  { code: 'IL', zh: '以色列', en: 'Israel', keywords: ['以色列', '特拉维夫', 'israel', 'tel aviv'] },
  { code: 'AE', zh: '阿联酋', en: 'United Arab Emirates', keywords: ['阿联酋', '阿聯酋', '迪拜', '杜拜', 'emirates', 'dubai'] },
  { code: 'SA', zh: '沙特', en: 'Saudi Arabia', keywords: ['沙特', '沙烏地', 'saudi'] },
  { code: 'ZA', zh: '南非', en: 'South Africa', keywords: ['南非', 'south africa', 'johannesburg'] },
  { code: 'EG', zh: '埃及', en: 'Egypt', keywords: ['埃及', 'egypt', 'cairo'] },
  { code: 'NG', zh: '尼日利亚', en: 'Nigeria', keywords: ['尼日利亚', 'nigeria', 'lagos'] },
  { code: 'BR', zh: '巴西', en: 'Brazil', keywords: ['巴西', '圣保罗', '聖保羅', 'brazil', 'brasil', 'sao paulo'] },
  { code: 'AR', zh: '阿根廷', en: 'Argentina', keywords: ['阿根廷', '布宜诺斯艾利斯', 'argentina', 'buenos aires'] },
  { code: 'CL', zh: '智利', en: 'Chile', keywords: ['智利', 'chile', 'santiago'] },
] as const;

/** code → 定义，供显示层做 O(1) 查表。 */
const BY_CODE: ReadonlyMap<string, RegionDef> = new Map(REGIONS.map((r) => [r.code, r]));

/**
 * 非 ISO 的常见写法 → ISO 代码。
 *
 * `UK` 是最典型的：满世界都在用，但 ISO 3166-1 alpha-2 里英国是 `GB`。
 */
const CODE_ALIASES: Readonly<Record<string, string>> = {
  UK: 'GB',
  EN: 'GB',
  TP: 'TW',
  ROC: 'TW',
  UAE: 'AE',
  KP: 'KR', // 机场偶尔笔误，实际都指韩国；朝鲜节点不存在
};

/**
 * 允许作为"裸代码"匹配的地区代码白名单。
 *
 * 为什么需要白名单：两字母代码与英文单词碰撞极其严重。
 * `IN`（印度）会让 "Premium IN Stock" 命中，`IT`（意大利）会让 "IT-Support" 命中，
 * `IS`（冰岛）、`AT`（奥地利）、`BE`（比利时）、`NO`（挪威）、`ME`、`SO`、`DO`
 * 全都是常见英文词。误判的代价是用户按地区筛选时拿到错误节点，
 * 所以这里只放行那些在节点命名中确实作为地区简称使用、且不构成英文单词的代码。
 */
const SAFE_CODE_TOKENS: ReadonlySet<string> = new Set([
  'HK', 'TW', 'JP', 'SG', 'KR', 'MO', 'CN', 'MY', 'TH', 'VN', 'PH', 'KZ',
  'US', 'CA', 'MX', 'BR', 'AR', 'CL',
  'GB', 'UK', 'DE', 'FR', 'NL', 'RU', 'ES', 'PT', 'CH', 'SE', 'DK', 'FI',
  'PL', 'IE', 'UA', 'CZ', 'HU', 'RO', 'GR', 'RS', 'BG', 'LU', 'LT', 'LV', 'EE',
  'TR', 'IL', 'AE', 'SA', 'ZA', 'EG', 'NG', 'AU', 'NZ',
]);

/** 转义正则元字符。关键词表里有 `hong kong` 这类含空格的项，还可能出现 `.`。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 单条关键词匹配器。
 *
 * `test` 在模块加载时就绑定好，避免在热路径上重复构造 RegExp ——
 * `detectRegion` 是对每个节点、每次订阅刷新都要跑的函数，
 * 关键词表有数百条，在循环里现编译正则会让它慢上一两个数量级。
 */
interface KeywordMatcher {
  code: string;
  length: number;
  test: (haystack: string) => boolean;
}

/**
 * 预编译的关键词索引，按关键词长度降序。
 *
 * 降序是为了保证最长匹配优先：`hong kong` 必须先于 `hk` 被尝试，
 * `new zealand` 必须先于其中的片段被尝试。
 */
const KEYWORD_INDEX: readonly KeywordMatcher[] = REGIONS.flatMap((r) =>
  r.keywords.map((raw): KeywordMatcher => {
    const keyword = raw.toLowerCase();
    // 纯 ASCII 关键词需要词边界匹配，否则 `japan` 会在 `japanese` 里命中；
    // 含 CJK 的关键词直接用 includes —— 中文本来就不分词，且 includes 远快于正则。
    const isAscii = /^[ -~]+$/.test(keyword);
    if (isAscii) {
      const re = new RegExp(`(?<![a-z])${escapeRegExp(keyword)}(?![a-z])`);
      return { code: r.code, length: keyword.length, test: (h) => re.test(h) };
    }
    return { code: r.code, length: keyword.length, test: (h) => h.includes(keyword) };
  }),
).sort((a, b) => b.length - a.length);

/** 预编译的裸代码正则，避免每次检测都重新构造 RegExp。 */
const CODE_TOKEN_PATTERNS: readonly { re: RegExp; code: string }[] = [...SAFE_CODE_TOKENS].map(
  (code) => ({
    // 前后不能紧邻字母：`HK-01` / `[HK]` / `HK 节点` 命中，而 `SHKA` / `BACKUP` 不命中。
    // 数字是允许的邻接字符，因为 `HK01` 这种写法很常见。
    re: new RegExp(`(?<![a-z])${code.toLowerCase()}(?![a-z])`, 'i'),
    code,
  }),
);

// ─────────────────────────────────────────────────────────────
//  旗帜 emoji
// ─────────────────────────────────────────────────────────────

/** Unicode 区域指示符 'A' 的码点。两个连续区域指示符构成一面国旗。 */
const REGIONAL_INDICATOR_A = 0x1f1e6;
const LATIN_A = 65; // 'A'.charCodeAt(0)

/**
 * 从字符串中提取旗帜 emoji 对应的地区代码。
 *
 * 旗帜 emoji 在 Unicode 里就是两个"区域指示符"字符拼起来的，
 * 而区域指示符与 ISO 代码字母一一对应 —— 也就是说 🇭🇰 字面上就编码着 "HK"。
 * 这使它成为置信度最高的信号：无需猜测，直接解码。
 */
export function flagToRegionCode(text: string): string | undefined {
  // 必须按码点遍历：区域指示符在 BMP 之外，用 charAt 会把它拆成两个代理项
  const codePoints = [...text];
  for (let i = 0; i < codePoints.length - 1; i++) {
    const first = codePoints[i]?.codePointAt(0);
    const second = codePoints[i + 1]?.codePointAt(0);
    if (first === undefined || second === undefined) continue;
    const isFirstRI = first >= REGIONAL_INDICATOR_A && first <= REGIONAL_INDICATOR_A + 25;
    const isSecondRI = second >= REGIONAL_INDICATOR_A && second <= REGIONAL_INDICATOR_A + 25;
    if (isFirstRI && isSecondRI) {
      return String.fromCharCode(
        LATIN_A + (first - REGIONAL_INDICATOR_A),
        LATIN_A + (second - REGIONAL_INDICATOR_A),
      );
    }
  }
  return undefined;
}

/**
 * 由地区代码生成旗帜 emoji。
 *
 * 供重命名模板的 `{flag}` 变量与 Web 界面使用 —— 我们不内置任何旗帜图片，
 * 直接用 Unicode 生成，零资源开销。
 */
export function regionToFlag(code: string): string {
  const normalized = normalizeRegionCode(code);
  if (!normalized) return '';
  const first = normalized.charCodeAt(0);
  const second = normalized.charCodeAt(1);
  return String.fromCodePoint(
    REGIONAL_INDICATOR_A + (first - LATIN_A),
    REGIONAL_INDICATOR_A + (second - LATIN_A),
  );
}

// ─────────────────────────────────────────────────────────────
//  公开 API
// ─────────────────────────────────────────────────────────────

/**
 * 把用户输入的地区代码归一化为 ISO 代码。
 *
 * 接受大小写混写与常见别名（`uk` → `GB`）。不是两个字母的一律拒绝，
 * 返回 `undefined` 而不是抛异常 —— 调用方通常来自用户输入，需要的是"忽略无效项"
 * 而不是"整个请求失败"。
 */
export function normalizeRegionCode(input: string): string | undefined {
  const upper = input.trim().toUpperCase();
  const aliased = CODE_ALIASES[upper] ?? upper;
  return /^[A-Z]{2}$/.test(aliased) ? aliased : undefined;
}

/**
 * 从节点名推断地区代码。推断不出时返回 `undefined`。
 *
 * @param name 节点显示名
 * @param server 可选的服务器地址。仅在名字完全无线索时作为兜底 ——
 *   域名里的 `hk1.example.com` / `jp.cf-warp.net` 常常带地区信息。
 *   置信度低于名字，所以放在最后。
 */
export function detectRegion(name: string, server?: string): string | undefined {
  // 第 1 轮：旗帜 emoji —— 无歧义，直接采信
  const fromFlag = flagToRegionCode(name);
  if (fromFlag) {
    // emoji 解出来的可能是我们表里没有的地区（比如 🇻🇦 梵蒂冈）。
    // 这没关系：ISO 代码本身就是有效的地区标识，表只影响显示名。
    return fromFlag;
  }

  const fromName = matchByKeywordOrCode(name);
  if (fromName) return fromName;

  // 第 4 轮（兜底）：从服务器域名找线索。
  // 只在名字毫无信息时使用 —— 域名里的地区标识不如名字可靠，
  // 比如 CDN 回源域名可能与落地地区完全无关。
  if (server) {
    const fromServer = matchByKeywordOrCode(server);
    if (fromServer) return fromServer;
  }

  return undefined;
}

/** 第 2、3 轮匹配：关键词（最长优先）→ 安全清单内的裸代码。 */
function matchByKeywordOrCode(text: string): string | undefined {
  const haystack = text.toLowerCase();

  // 第 2 轮：关键词
  for (const entry of KEYWORD_INDEX) {
    if (entry.test(haystack)) return entry.code;
  }

  // 第 3 轮：安全清单内的裸国家代码
  for (const { re, code } of CODE_TOKEN_PATTERNS) {
    if (re.test(haystack)) {
      return normalizeRegionCode(code) ?? code;
    }
  }

  return undefined;
}

/** 地区的中文显示名。表里没有时回退到代码本身。 */
export function regionNameZh(code: string): string {
  const normalized = normalizeRegionCode(code);
  return (normalized && BY_CODE.get(normalized)?.zh) ?? code;
}

/** 地区的英文显示名。表里没有时回退到代码本身。 */
export function regionNameEn(code: string): string {
  const normalized = normalizeRegionCode(code);
  return (normalized && BY_CODE.get(normalized)?.en) ?? code;
}

/** 已收录的全部地区代码，供 UI 构建下拉选项。 */
export function knownRegionCodes(): string[] {
  return REGIONS.map((r) => r.code);
}
