/**
 * Clash / Clash.Meta(mihomo) YAML 配置生成。
 *
 * 输出一份**完整可用**的配置，而不只是一段 `proxies` —— 用户把链接丢进
 * Clash Verge / ClashX 就应该能直接用，不需要再手动配分组和规则。
 *
 * ## 为什么自己生成分组与规则，而不沿用上游的
 *
 * 上游订阅里的 `proxy-groups` 和 `rules` 是机场对**他们自己那批节点**的编排。
 * 聚合多个订阅后这些编排必然打架：两家机场都定义了名为"自动选择"的分组，
 * 规则里互相引用对方不存在的节点，Clash 加载时直接报错。
 *
 * 所以策略是：**只取节点，编排由我们按模板统一生成**。
 *
 * ## 关于顶层配置
 *
 * 只输出一组最小且无副作用的顶层字段。特别地，**不输出 `external-controller`**
 * ——那会开一个本地管理端口，是订阅内容不该替用户做的决定。
 *
 * 本文件属于 core 纯函数层：无 IO。
 */

import { stringify as stringifyYaml } from 'yaml';
import { regionNameZh, regionToFlag } from '../region.js';
import {
  PROVIDER_NAME,
  resolveOrchestration,
  type Orchestration,
  type OrchestrationProvider,
} from '../orchestrate.js';
import type { ProxyNode, TlsOptions, Transport } from '../types.js';
import { partitionBySupport, type EmitResult } from './capability.js';

export interface ClashEmitOptions {
  /** 目标内核。决定协议能力矩阵，见 capability.ts。 */
  target: 'clash' | 'clash.meta';
  /** 是否生成 proxy-groups 与 rules。关掉则只输出 proxies，供进阶用户自行编排。 */
  withGroups?: boolean;
  /** 是否按地区额外生成 url-test 分组。默认 true。 */
  regionGroups?: boolean;
  /** 延迟测试用的 URL。默认用 Google 的 204 端点。 */
  testUrl?: string;
  /**
   * 自定义分流编排。给了就用它替换内置的分组与规则。
   *
   * 只对 `clash.meta` 生效：`rule-providers` 是 Clash Premium / Meta 的特性，
   * 塞给原版 Clash 会导致整份配置加载失败。
   */
  orchestration?: Orchestration;
  /**
   * 规则集转换端点的基址，形如 `https://host/r/<token>`。
   *
   * 给出后，`rule-providers[].url` 改写为 `<base>/<providerKey>`。
   * 为什么必须改写：源站格式五花八门（SR 前导点、GitHub blob 的 HTML、
   * 扩展名拼错），客户端不会替你猜。转换放在服务端做一次，
   * 客户端只拿目标 behavior 对应的干净格式。
   *
   * 不给则保留原始 URL —— 预览路径就是这样，输出与线上会差这一点。
   */
  ruleProxyBase?: string;
  /**
   * 节点源地址（`?target=clash.provider` 的完整 URL）。
   *
   * 给出后配置切成 provider 模式：节点不再内联进 `proxies:`，而是由客户端
   * 定期拉取，分组成员写成 `use` + `filter`。机场改名时 filter 在客户端
   * 重新求值，配置一行不用改 —— 这是 inline 模式做不到的。
   *
   * 不给则保持内联（预览、`.conf`、以及 `?style=inline` 的逃生舱）。
   */
  nodeProviderUrl?: string;
}

// ─────────────────────────────────────────────────────────────
//  分组名
// ─────────────────────────────────────────────────────────────
//
// 用 emoji 前缀是 Clash 生态的惯例，在客户端的分组列表里辨识度最高。

const GROUP_SELECT = '🚀 节点选择';
const GROUP_AUTO = '♻️ 自动选择';
const GROUP_FALLBACK = '🐟 漏网之鱼';
const GROUP_CHAIN = '🔗 链式落地';
const GROUP_ENTRY = '🚪 入口节点';

const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204';

/**
 * mihomo 专属的顶层字段。这些不是"锦上添花"，每一条都对应一个真实差异 ——
 * 少了它们，从 Shadowrocket 迁过来的人会立刻觉得「这客户端是坏的」。
 *
 * | 字段 | 缺了会怎样 |
 * |---|---|
 * | `profile.store-selected` | 订阅一刷新，手动选中的出口被重置回第一个成员。SR 是永远记住的 |
 * | `profile.store-fake-ip` | fake-ip 映射不持久，重启后同一域名换 IP，连接被误判 |
 * | `sniffer` | 规则几乎全是域名规则，但 TUN 下只拿到 IP，域名规则根本不参与匹配 |
 * | `unified-delay` | 延迟含 TLS 握手，比 SR 报的数大两三倍，用户以为线路劣化 |
 * | `tcp-concurrent` | 同一域名多个 IP 串行尝试，首字节时间明显变长 |
 */
function metaTopLevel(): Record<string, unknown> {
  return {
    'unified-delay': true,
    'tcp-concurrent': true,
    profile: {
      'store-selected': true,
      'store-fake-ip': true,
    },
    sniffer: {
      enable: true,
      // 纯 IP 连接也尝试嗅探：TUN 转发过来时目标只有 IP，没有域名。
      'parse-pure-ip': true,
      // 嗅探到的域名只用于规则匹配，不改写连接目标 —— 改写会破坏 SNI 校验。
      'override-destination': false,
      sniff: {
        TLS: { ports: [443, 8443] },
        HTTP: { ports: [80, 8080] },
        QUIC: { ports: [443] },
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────
//  节点 → Clash proxy
// ─────────────────────────────────────────────────────────────

/** 丢掉值为 undefined 的键。Clash 对多余的 null 字段不宽容，宁可不写。 */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/** 传输层 → Clash 的 `network` 与对应的 `*-opts`。 */
function transportFields(t: Transport): Record<string, unknown> {
  // network: tcp 是默认值，写出来只是噪音
  const fields: Record<string, unknown> = t.network === 'tcp' ? {} : { network: t.network };

  switch (t.network) {
    case 'ws': {
      const opts = compact({
        path: t.ws?.path,
        headers: t.ws?.headers,
        'max-early-data': t.ws?.maxEarlyData,
        'early-data-header-name': t.ws?.earlyDataHeaderName,
      });
      if (Object.keys(opts).length > 0) fields['ws-opts'] = opts;
      break;
    }
    case 'grpc': {
      if (t.grpc?.serviceName) {
        fields['grpc-opts'] = { 'grpc-service-name': t.grpc.serviceName };
      }
      break;
    }
    case 'h2': {
      const opts = compact({ path: t.h2?.path, host: t.h2?.host });
      if (Object.keys(opts).length > 0) fields['h2-opts'] = opts;
      break;
    }
    case 'http': {
      const opts = compact({
        method: t.http?.method,
        path: t.http?.path,
        headers: t.http?.headers,
      });
      if (Object.keys(opts).length > 0) fields['http-opts'] = opts;
      break;
    }
    default:
      break;
  }

  return fields;
}

/**
 * TLS → Clash 字段。
 *
 * @param sniKey Clash 里 SNI 的键名不统一：vmess/vless 用 `servername`，
 *   trojan/hysteria2/tuic 用 `sni`。写错了客户端会忽略该字段，
 *   导致走了错误的 SNI 而握手失败。
 * @param emitTlsFlag 是否输出 `tls: true`。trojan 等协议隐含 TLS，
 *   写出来虽无害但属于冗余。
 */
function tlsFields(
  tls: TlsOptions | undefined,
  sniKey: 'servername' | 'sni',
  emitTlsFlag: boolean,
): Record<string, unknown> {
  if (!tls?.enabled) return {};

  const fields: Record<string, unknown> = {};
  if (emitTlsFlag) fields['tls'] = true;
  if (tls.sni) fields[sniKey] = tls.sni;
  if (tls.alpn?.length) fields['alpn'] = tls.alpn;
  // client-fingerprint 是 uTLS 握手指纹；fingerprint 是证书指纹固定。
  // 这两个键名极易搞反，搞反的后果是握手失败且报错信息毫无提示性。
  if (tls.fingerprint) fields['client-fingerprint'] = tls.fingerprint;
  if (tls.certFingerprint) fields['fingerprint'] = tls.certFingerprint;
  if (tls.allowInsecure === true) fields['skip-cert-verify'] = true;

  if (tls.reality) {
    fields['reality-opts'] = compact({
      'public-key': tls.reality.publicKey,
      'short-id': tls.reality.shortId,
    });
  }

  return fields;
}

/** 把统一模型转成 Clash 的 proxies 条目。 */
export function toClashProxy(node: ProxyNode): Record<string, unknown> {
  const base = compact({
    name: node.name,
    type: node.type,
    server: node.server,
    port: node.port,
    udp: node.udp,
    'dialer-proxy': node.chain?.viaName,
  });

  switch (node.type) {
    case 'vmess':
      return compact({
        ...base,
        uuid: node.uuid,
        alterId: node.alterId,
        cipher: node.cipher,
        ...tlsFields(node.tls, 'servername', true),
        ...transportFields(node.transport),
      });

    case 'vless':
      return compact({
        ...base,
        uuid: node.uuid,
        flow: node.flow,
        ...tlsFields(node.tls, 'servername', true),
        ...transportFields(node.transport),
      });

    case 'trojan':
      return compact({
        ...base,
        password: node.password,
        ...tlsFields(node.tls, 'sni', false),
        ...transportFields(node.transport),
      });

    case 'ss':
      return compact({
        ...base,
        cipher: node.cipher,
        password: node.password,
        plugin: node.plugin?.name,
        'plugin-opts':
          node.plugin && Object.keys(node.plugin.opts).length > 0 ? node.plugin.opts : undefined,
      });

    case 'ssr':
      return compact({
        ...base,
        cipher: node.cipher,
        password: node.password,
        protocol: node.protocol,
        obfs: node.obfs,
        'protocol-param': node.protocolParam,
        'obfs-param': node.obfsParam,
      });

    case 'hysteria2':
      return compact({
        ...base,
        password: node.password,
        obfs: node.obfs,
        'obfs-password': node.obfsPassword,
        up: node.up,
        down: node.down,
        ...tlsFields(node.tls, 'sni', false),
      });

    case 'tuic':
      return compact({
        ...base,
        uuid: node.uuid,
        password: node.password,
        'congestion-controller': node.congestionController,
        'udp-relay-mode': node.udpRelayMode,
        ...tlsFields(node.tls, 'sni', false),
      });
  }
}

// ─────────────────────────────────────────────────────────────
//  分组与规则
// ─────────────────────────────────────────────────────────────

interface ProxyGroup {
  name: string;
  type: 'select' | 'url-test';
  proxies: string[];
  url?: string;
  interval?: number;
  tolerance?: number;
}

/**
 * 生成 proxy-groups。
 *
 * 有一个必须处理的边界情况：**节点数为零**。Clash 要求每个分组的 `proxies`
 * 非空，空数组会让客户端拒绝加载整份配置。而节点数为零是完全可能发生的
 * ——所有订阅都过期了，或者过滤规则写得太严。此时回退到只含 `DIRECT` 的分组，
 * 保证配置本身仍然合法可加载，用户至少能打开客户端看到问题所在。
 */
function buildGroups(
  nodes: readonly ProxyNode[],
  opts: { testUrl: string; regionGroups: boolean },
): ProxyGroup[] {
  const names = nodes.map((n) => n.name);

  if (names.length === 0) {
    return [
      { name: GROUP_SELECT, type: 'select', proxies: ['DIRECT'] },
      { name: GROUP_FALLBACK, type: 'select', proxies: ['DIRECT'] },
    ];
  }

  const testConfig = { url: opts.testUrl, interval: 300, tolerance: 50 };

  const entryFingerprints = new Set(nodes.filter((node) => node.chain).map((node) => node.chain!.viaFingerprint));
  const entryNames = nodes.filter((node) => entryFingerprints.has(node.fingerprint)).map((node) => node.name);
  const chainNames = nodes.filter((node) => Boolean(node.chain)).map((node) => node.name);
  const autoNames = nodes.filter((node) => !entryFingerprints.has(node.fingerprint)).map((node) => node.name);

  const autoGroup: ProxyGroup = {
    name: GROUP_AUTO,
    type: 'url-test',
    ...testConfig,
    proxies: autoNames.length > 0 ? autoNames : names,
  };

  // ── 地区分组 ──────────────────────────────────────────
  const regionGroups: ProxyGroup[] = [];
  if (opts.regionGroups) {
    const byRegion = new Map<string, string[]>();
    for (const node of nodes) {
      const region = node.meta.region;
      if (!region) continue; // 推断不出地区的节点不进地区分组，但仍在总分组里
      if (entryFingerprints.has(node.fingerprint)) continue;
      const list = byRegion.get(region);
      if (list) list.push(node.name);
      else byRegion.set(region, [node.name]);
    }

    // 按地区码排序，保证多次生成的分组顺序稳定
    for (const region of [...byRegion.keys()].sort()) {
      const members = byRegion.get(region);
      if (!members || members.length === 0) continue;
      regionGroups.push({
        name: `${regionToFlag(region)} ${regionNameZh(region)}`,
        type: 'url-test',
        ...testConfig,
        proxies: members,
      });
    }
  }

  // 主选择分组：自动选择在最前（多数人用它），然后是地区分组，
  // 再是 DIRECT，最后才铺开全部节点。顺序即是使用频率。
  const extraGroups: ProxyGroup[] = [];
  if (chainNames.length > 0) extraGroups.push({ name: GROUP_CHAIN, type: 'select', proxies: chainNames });
  if (entryNames.length > 0) extraGroups.push({ name: GROUP_ENTRY, type: 'select', proxies: entryNames });
  const selectMembers = [
    GROUP_AUTO,
    ...(chainNames.length > 0 ? [GROUP_CHAIN] : []),
    ...regionGroups.map((g) => g.name),
    ...(entryNames.length > 0 ? [GROUP_ENTRY] : []),
    'DIRECT',
    ...names,
  ];
  const selectGroup: ProxyGroup = {
    name: GROUP_SELECT,
    type: 'select',
    proxies: selectMembers,
  };

  const fallbackGroup: ProxyGroup = {
    name: GROUP_FALLBACK,
    type: 'select',
    proxies: [GROUP_SELECT, 'DIRECT'],
  };

  return [selectGroup, autoGroup, ...regionGroups, ...extraGroups, fallbackGroup];
}

/**
 * 生成规则。
 *
 * 刻意保持最小：局域网直连 + 国内直连 + 其余走代理。
 * 只使用 `IP-CIDR` 与 `GEOIP` 这类内置规则类型，不引入 `RULE-SET`
 * ——后者依赖外部规则集文件，会给订阅增加一个可能失效的外部依赖。
 */
function buildRules(): string[] {
  return [
    // 本地与保留地址直连。no-resolve 避免为了匹配规则而先做 DNS 解析，
    // 那会造成 DNS 泄漏并拖慢连接建立。
    'DOMAIN-SUFFIX,local,DIRECT',
    'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
    'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
    'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve',
    'IP-CIDR,100.64.0.0/10,DIRECT,no-resolve',
    'IP-CIDR6,::1/128,DIRECT,no-resolve',
    'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
    'IP-CIDR6,fe80::/10,DIRECT,no-resolve',
    // 国内直连
    'GEOIP,CN,DIRECT',
    // 其余走代理
    `MATCH,${GROUP_SELECT}`,
  ];
}

// ─────────────────────────────────────────────────────────────
//  入口
// ─────────────────────────────────────────────────────────────

/**
 * 把 `rule-providers` 的 URL 指向本站转换端点。
 *
 * 返回新对象，**绝不改原 spec** —— `.conf` 的 emitter 还要用原始 URL 回填
 * `RULE-SET,<url>,<policy>`：Shadowrocket 本来就能直吃 Surge 格式，
 * 让它绕一圈经过我们的 Clash 格式转换反而是倒退。
 */
function localizeProviders(spec: Orchestration, base: string): Orchestration {
  const providers = spec.providers;
  if (!providers) return spec;

  const prefix = base.replace(/\/+$/, '');
  const rewritten: Record<string, OrchestrationProvider> = {};
  for (const [key, provider] of Object.entries(providers)) {
    rewritten[key] = { ...provider, url: `${prefix}/${encodeURIComponent(key)}` };
  }
  return { ...spec, providers: rewritten };
}

/**
 * 生成 Clash YAML 配置。
 *
 * 不支持的节点会被跳过并记入返回值的 `skipped`，由调用方负责上报给用户。
 */
export function emitClash(nodes: readonly ProxyNode[], options: ClashEmitOptions): EmitResult {
  const target = options.target;
  const withGroups = options.withGroups ?? true;
  const testUrl = options.testUrl ?? DEFAULT_TEST_URL;
  const { usable, skipped } = partitionBySupport(nodes, target);

  const warnings: string[] = [];
  let orchestration: ReturnType<typeof resolveOrchestration> | undefined;

  if (withGroups && options.orchestration) {
    if (target !== 'clash.meta') {
      warnings.push(
        '自定义编排包含 rule-providers / DNS 等 mihomo 专属能力，当前目标不是 Clash.Meta，已回退内置模板',
      );
    } else {
      const spec = options.ruleProxyBase
        ? localizeProviders(options.orchestration, options.ruleProxyBase)
        : options.orchestration;
      // 节点源模式下分组成员由客户端的 filter 求值：改名免疫，
      // 也不会因为服务端某次渲染把名单拍死而丢掉用户的手动选择。
      orchestration = resolveOrchestration(usable, spec, {
        providerMode: Boolean(options.nodeProviderUrl),
      });

      // 规则集下载必须直连。规则集就在我们自己的域名下，而"用规则决定怎么
      // 下载规则"是死锁：首次启动规则集为空，下载请求会一路走到 MATCH，
      // 被塞进一个可能还没测通的节点，于是规则集永远下不下来。
      // 实测 mihomo 1.19.25：不配 proxy 时确实会走代理栈。
      if (options.ruleProxyBase) {
        for (const provider of Object.values(orchestration.providers)) {
          provider.proxy = 'DIRECT';
        }
      }

      warnings.push(...orchestration.warnings);
    }
  }

  const config: Record<string, unknown> = {
    // 最小顶层配置。刻意不含 external-controller ——
    // 那是用户对自己客户端的选择，订阅不该越俎代庖。
    'mixed-port': 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'info',
  };

  // 只有 mihomo 认这些字段。原版 Clash 内核遇到未知键会直接拒绝加载，
  // 不能靠"多写无所谓"来处理。
  if (target === 'clash.meta') {
    Object.assign(config, metaTopLevel());
  }

  if (orchestration?.ipv6 !== undefined) config['ipv6'] = orchestration.ipv6;
  if (orchestration?.hosts) config['hosts'] = orchestration.hosts;

  if (!options.nodeProviderUrl) {
    config['proxies'] = usable.map(toClashProxy);
  } else {
    // 节点源。客户端按 interval 自己拉，配置本身不再是节点快照 ——
    // 机场改名、增删节点，配置一个字都不用变。
    config['proxy-providers'] = {
      [PROVIDER_NAME]: {
        type: 'http',
        url: options.nodeProviderUrl,
        path: `./providers/${PROVIDER_NAME}.yaml`,
        interval: 3600,
        // 组的 url-test / fallback 已经在测速，provider 再测一遍纯属浪费。
        'health-check': { enable: false },
      },
    };
  }

  if (withGroups && orchestration) {
    if (orchestration.groups.length > 0) {
      config['proxy-groups'] = orchestration.groups.map((group) => {
        const { excludeFilter, ...rest } = group;
        const out: Record<string, unknown> = { ...rest };
        // Clash 的键是 `exclude-filter`，不是我们内部模型里的驼峰写法。
        if (excludeFilter) out['exclude-filter'] = excludeFilter;
        // provider 模式的分组可能只靠 filter 取成员，此时 `proxies` 为空。
        // 空数组会让客户端判定"组为空"并拒绝加载，必须整键省略。
        if (group.proxies.length === 0) delete out.proxies;
        return out;
      });
    }
    if (Object.keys(orchestration.providers).length > 0) {
      config['rule-providers'] = orchestration.providers;
    }
    config['rules'] = orchestration.rules;
    if (orchestration.dns) config['dns'] = orchestration.dns;
  } else if (withGroups) {
    config['proxy-groups'] = buildGroups(usable, {
      testUrl,
      regionGroups: options.regionGroups ?? true,
    });
    config['rules'] = buildRules();
  }

  const body = stringifyYaml(config, {
    // lineWidth: 0 关闭自动折行。折行后的长字符串（比如带很多查询参数的
    // WebSocket path）在部分客户端的 YAML 解析器上会出问题。
    lineWidth: 0,
  });

  const result: EmitResult = {
    body,
    // Clash 客户端对 Content-Type 不敏感，但 text/yaml 便于在浏览器里直接查看
    contentType: 'text/yaml; charset=utf-8',
    nodeCount: usable.length,
    skipped,
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

/**
 * 只输出 `proxies:` 的节点源，供 `proxy-providers[].url` 指向。
 *
 * 这是 P3 的另一半：配置里不再内联节点，客户端按需拉这个文件。
 * 内容必须只有 `proxies` —— 带上 proxy-groups 或 rules 会让客户端
 * 把节点源当成配置去解析，行为不可预期。
 */
export function emitClashProvider(
  nodes: readonly ProxyNode[],
  options: { target: 'clash' | 'clash.meta' },
): EmitResult {
  const { usable, skipped } = partitionBySupport(nodes, options.target);
  const body = stringifyYaml({ proxies: usable.map(toClashProxy) }, { lineWidth: 0 });

  return {
    body,
    contentType: 'text/yaml; charset=utf-8',
    nodeCount: usable.length,
    skipped,
  };
}
