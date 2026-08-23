/**
 * base64 URI 列表输出 —— Shadowrocket 与 V2Ray/v2rayN 两个目标共用这一层。
 *
 * 格式极其简单：每行一条代理 URI，整体做一次 base64 编码。
 * 这是最古老、覆盖客户端最广的订阅格式。
 *
 * ## 为什么 Shadowrocket 与 V2Ray 共用同一份序列化
 *
 * 老实说：**因为它们在序列化层面目前确实没有差异**。
 * 两者都消费同一套 `vmess://` / `vless://` / `trojan://` / `ss://` URI，
 * 且都接受 base64 包裹。历史上 Shadowrocket 有过自己的 vmess 方言，
 * 但现代版本已完全接受 v2rayN 的 base64-JSON 形式。
 *
 * 真正的差异在**能力矩阵**（见 capability.ts）——Shadowrocket 原生支持 SSR，
 * 而 v2rayN 系客户端对 SSR 与新协议的支持随版本浮动。
 *
 * 这里仍然保留两个独立导出而不是合成一个，是为了让将来两者分化时
 * （某一方新增了独有字段）只需改这个文件，调用方与路由层不受影响。
 *
 * 本文件属于 core 纯函数层：无 IO。
 */

import { encodeBase64 } from '../parse/util.js';
import type { ProxyNode } from '../types.js';
import { partitionBySupport, type EmitResult } from './capability.js';
import { emitUri } from './uri.js';

/**
 * 生成 base64 URI 列表。
 *
 * @param base64 是否对结果做 base64 编码。默认 true。
 *   传 false 得到明文 URI 列表 —— 便于调试与人工核对，
 *   Web 界面的"预览"功能用的就是这个。
 */
function emitList(
  nodes: readonly ProxyNode[],
  target: 'shadowrocket' | 'v2ray',
  base64 = true,
): EmitResult {
  const { usable, skipped } = partitionBySupport(nodes, target);

  // 行尾统一用 \n。部分客户端在遇到 \r\n 时会把 \r 当成 URI 的一部分，
  // 导致最后一个节点的名字里多出一个不可见字符。
  const plain = usable.map((node) => emitUri(node)).join('\n');

  return {
    body: base64 ? encodeBase64(plain) : plain,
    // 必须是 text/plain：某些客户端会根据 Content-Type 决定是否尝试解码，
    // 返回 application/octet-stream 会让它们把内容当二进制文件下载。
    contentType: 'text/plain; charset=utf-8',
    nodeCount: usable.length,
    skipped,
  };
}

/** 生成 Shadowrocket 订阅内容。 */
export function emitShadowrocket(nodes: readonly ProxyNode[], base64 = true): EmitResult {
  return emitList(nodes, 'shadowrocket', base64);
}

/** 生成 V2Ray / v2rayN 订阅内容。 */
export function emitV2Ray(nodes: readonly ProxyNode[], base64 = true): EmitResult {
  return emitList(nodes, 'v2ray', base64);
}
