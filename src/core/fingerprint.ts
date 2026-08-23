/**
 * 节点稳定指纹。
 *
 * 这是整个项目里最容易被做错、做错后代价又最大的一个设计点，值得把理由写清楚。
 *
 * 节点需要一个主键，用来：
 *   1. 跨订阅源去重（同一台服务器被两个机场同时售卖是常见现象）
 *   2. 持久化"用户手动勾选了哪些节点"（profile 的 `pick` 规则）
 *
 * 而上游订阅每隔几小时就会刷新一次，机场会随时改节点名、调整顺序、增删条目。
 * 所以主键**绝对不能**是：
 *   - 节点名 —— 改名后勾选全部失效
 *   - 数组下标 —— 顺序一变全部错位
 *   - 上游给的 id —— 大多数订阅格式根本没有这个字段
 *
 * 结论：从"连上这个节点所必需的信息"派生出哈希。
 *
 *     fingerprint = sha1(type | server | port | credential).slice(0, 16)
 *
 * 由此得到的性质：
 *   - **改名不影响指纹** —— 这正是我们要的
 *   - 换服务器地址视为新节点 —— 合理，那确实是另一台机器了
 *   - 同服务器同端口但不同用户凭据视为不同节点 —— 合理，共享节点时能区分开
 *
 * 16 个十六进制字符 = 64 bit。按生日碰撞估算，需要约 40 亿个节点才有 1/2 的碰撞概率，
 * 而现实中一个人的全部订阅加起来也就几百到几千个节点，余量极其充裕。
 *
 * 这里用 SHA-1 而非 SHA-256 纯粹是因为输出更短、计算更快。
 * **这不是安全用途** —— 指纹只用于标识，不用于认证或完整性校验，
 * SHA-1 的碰撞攻击（需要攻击者构造两份特殊输入）在此场景下不构成威胁。
 */

import { createHash } from 'node:crypto';
import type { NodeMeta, ProxyNode, ProxyNodeDraft } from './types.js';

/** 指纹长度（十六进制字符数）。 */
const FINGERPRINT_LENGTH = 16;

/**
 * 提取"凭据"部分——也就是区分不同用户/不同配置所必需的字段。
 *
 * 各协议取什么，取决于"改动它是否意味着这是另一个节点"：
 * SS 的加密方式变了就连不上，所以算进去；而 vmess 的 alterId 属于协商细节，
 * 上游订阅经常在 0 和 64 之间来回改而服务端两者都收，把它算进指纹会导致
 * 节点在每次刷新后被误判为新节点，所以不算。
 */
function credentialOf(node: ProxyNodeDraft): string {
  let parts: string[];

  switch (node.type) {
    case 'vmess':
      parts = [node.uuid];
      break;
    case 'vless':
      parts = [node.uuid];
      break;
    case 'trojan':
      parts = [node.password];
      break;
    case 'ss':
      // 加密方式与密码必须配对才能连上，两者都算
      parts = [node.cipher, node.password];
      break;
    case 'ssr':
      // SSR 的协议/混淆插件变了同样连不上
      parts = [node.cipher, node.password, node.protocol, node.obfs];
      break;
    case 'hysteria2':
      parts = [node.password];
      break;
    case 'tuic':
      parts = [node.uuid, node.password];
      break;
  }

  // Use the same non-printable separator as the outer fingerprint tuple.
  // A credential may contain any printable delimiter, so ':' is ambiguous.
  return parts.join('\x1f');
}

/**
 * 规范化主机名。
 *
 * 域名大小写不敏感，`HK1.Example.com` 与 `hk1.example.com` 是同一台主机；
 * 上游订阅的书写并不统一。不做归一化会导致同一节点产生两个指纹，去重失效。
 * 末尾的根域点（`example.com.`）同理。
 */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * 计算节点指纹。纯函数：同样的输入永远得到同样的输出，与时间、来源、名称无关。
 */
export function computeFingerprint(node: ProxyNodeDraft): string {
  const parts = [node.type, normalizeHost(node.server), String(node.port), credentialOf(node)];
  // 用 \x1f（单元分隔符）而不是 ':' 之类的可打印字符做分隔，
  // 避免密码里恰好含有分隔符时造成歧义（"a:b" + "c" 与 "a" + "b:c" 会撞哈希）。
  return createHash('sha1').update(parts.join('\x1f')).digest('hex').slice(0, FINGERPRINT_LENGTH);
}

/** Derive a stable identity for a landing node reached through an entry node. */
export function deriveChainFingerprint(landingFp: string, entryFp: string): string {
  return createHash('sha1').update([landingFp, 'via', entryFp].join('\x1f')).digest('hex').slice(0, FINGERPRINT_LENGTH);
}

/**
 * 把解析器产出的半成品补齐为完整节点：规范化主机名、计算指纹、绑定来源信息。
 *
 * 所有解析器都必须经由此函数产出最终节点，以保证指纹计算口径一致。
 */
export function finalizeNode(draft: ProxyNodeDraft, meta: NodeMeta): ProxyNode {
  const normalized = { ...draft, server: normalizeHost(draft.server) };
  // 这里的断言是必要的：TypeScript 无法证明对判别联合做展开后重新组合出的对象
  // 仍然属于原联合类型。运行时结构是正确的 —— normalized 保留了 draft 的所有字段
  // （含判别用的 type），只是额外补上了 Omit 掉的 fingerprint 与 meta。
  return {
    ...normalized,
    fingerprint: computeFingerprint(normalized),
    meta,
  } as ProxyNode;
}

/**
 * 去重键。
 *
 * - `fingerprint`：严格模式，只有完全相同的节点（含凭据）才算重复。
 * - `server-port`：宽松模式，同一 `host:port` 即视为重复，不论凭据是否相同。
 *   适用于多个机场转售同一批落地机的情况 —— 它们指向同一台服务器，
 *   留一个就够了，多留只是让客户端的节点列表变长。
 */
export function dedupeKey(node: ProxyNode, mode: 'fingerprint' | 'server-port'): string {
  return mode === 'server-port'
    ? `${normalizeHost(node.server)}:${node.port}`
    : node.fingerprint;
}
