/**
 * 测试辅助工具。
 *
 * 这里刻意不使用任何 mock 框架 —— core 层是纯函数，测试只需要构造输入、
 * 断言输出。需要 mock 才能测的代码，说明它不该待在 core 层。
 */

import { finalizeNode } from '../src/core/fingerprint.js';
import type { NodeMeta, ProxyNode, ProxyNodeDraft } from '../src/core/types.js';

export const TEST_META: NodeMeta = {
  sourceId: 'sub-1',
  sourceName: '测试订阅',
  tags: [],
};

/**
 * 由半成品构造完整节点。
 *
 * 注意 `finalizeNode` 会把 server 转小写，所以测试数据里的服务器地址
 * 请直接写小写，否则往返断言会因为大小写差异而失败 —— 那是预期行为，
 * 不是 bug。
 */
export function makeNode(draft: ProxyNodeDraft, meta: Partial<NodeMeta> = {}): ProxyNode {
  return finalizeNode(draft, { ...TEST_META, ...meta });
}

/**
 * 去掉 fingerprint 与 meta，得到可与解析结果直接比较的形态。
 *
 * URI 里不承载这两样东西（指纹是我们算出来的，来源是调用方给的），
 * 所以往返比较时必须先剥掉。
 */
export function stripDerived(node: ProxyNode): ProxyNodeDraft {
  const { fingerprint: _fingerprint, meta: _meta, ...rest } = node;
  return rest as ProxyNodeDraft;
}
