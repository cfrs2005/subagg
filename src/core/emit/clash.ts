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
function buildGroups(nodes: readonly ProxyNode[], opts: Required<ClashEmitOptions>): ProxyGroup[] {
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
 * 生成 Clash YAML 配置。
 *
 * 不支持的节点会被跳过并记入返回值的 `skipped`，由调用方负责上报给用户。
 */
export function emitClash(nodes: readonly ProxyNode[], options: ClashEmitOptions): EmitResult {
  const opts: Required<ClashEmitOptions> = {
    target: options.target,
    withGroups: options.withGroups ?? true,
    regionGroups: options.regionGroups ?? true,
    testUrl: options.testUrl ?? DEFAULT_TEST_URL,
  };

  const { usable, skipped } = partitionBySupport(nodes, opts.target);

  const config: Record<string, unknown> = {
    // 最小顶层配置。刻意不含 external-controller / DNS ——
    // 那些是用户对自己客户端的选择，订阅不该越俎代庖。
    'mixed-port': 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'info',
    proxies: usable.map(toClashProxy),
  };

  if (opts.withGroups) {
    config['proxy-groups'] = buildGroups(usable, opts);
    config['rules'] = buildRules();
  }

  const body = stringifyYaml(config, {
    // lineWidth: 0 关闭自动折行。折行后的长字符串（比如带很多查询参数的
    // WebSocket path）在部分客户端的 YAML 解析器上会出问题。
    lineWidth: 0,
  });

  return {
    body,
    // Clash 客户端对 Content-Type 不敏感，但 text/yaml 便于在浏览器里直接查看
    contentType: 'text/yaml; charset=utf-8',
    nodeCount: usable.length,
    skipped,
  };
}
