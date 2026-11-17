/**
 * 内置的 Clash 分流编排预设。
 *
 * ## 为什么预设是一份解析产物，而不是手写的 JSON
 *
 * `ios-migrated` 的来源是站点所有者**当前在用的 Shadowrocket 配置原文**
 * （`orchestrate-preset-conf.ts` 里的快照），过一遍 `parseShadowrocketConf()`
 * 得到编排。第一版预设是手写的"近似翻译"：把 `GOOGLE = fallback,DMIT-A,DMIT-B`
 * 写成了 `nameRegex: 'DMIT-'` —— 结果分组里混进了 DMIT-666、DMIT-Vision、
 * IX_ 派生节点等所有名字带 DMIT 的节点，还自作主张加了 PROXY 兜底成员。
 * 用户一眼就看出"这不是我的配置"。
 *
 * 忠实 > 聪明。预设与导入器共用同一条翻译路径，以后改预设 = 换快照，
 * 不会再出现"导入的和内置的长得不一样"。
 *
 * ## 用户后续怎么改策略
 *
 * 不用动代码：网页「系统设置 → 默认分流编排」粘贴新的 `.conf` →
 * 解析 → 保存为默认，即刻对所有未单独编排的 profile 生效。
 * 这里的预设只是"还没保存过自定义时"的出厂值。
 */

import { parseShadowrocketConf } from './orchestrate-import.js';
import type { Orchestration } from './orchestrate.js';
import { OWNER_SHADOWROCKET_CONF } from './orchestrate-preset-conf.js';

export interface OrchestrationPreset {
  id: string;
  name: string;
  description: string;
  orchestration: Orchestration;
}

/**
 * 站点所有者的长期策略：其 Shadowrocket 配置原文的忠实翻译。
 *
 * 它同时扮演两个角色：
 * 1. 「iOS 迁移」预设，可在配置编辑页一键套用；
 * 2. **全局默认编排的兜底值** —— settings 表没写默认时用它，
 *    于是"我的策略"天然就是所有未单独编排的 profile 的分流策略。
 *
 * 导入时产生的 warnings 在这里丢弃：那是"翻译说明"，不是"渲染告警"，
 * 每次真正渲染时 resolveOrchestration 会给出与当前节点集相关的实时告警。
 */
export const IOS_MIGRATED: Orchestration = parseShadowrocketConf(
  OWNER_SHADOWROCKET_CONF,
).orchestration;

export const ORCHESTRATION_PRESETS: readonly OrchestrationPreset[] = [
  {
    id: 'ios-migrated',
    name: 'iOS 迁移（Shadowrocket）',
    description:
      '站点所有者当前 Shadowrocket 配置的忠实翻译：AI 分组、Google fallback、内网直连、国内规则集与 DoH 分流。',
    orchestration: IOS_MIGRATED,
  },
];

export function findOrchestrationPreset(id: string): OrchestrationPreset | undefined {
  return ORCHESTRATION_PRESETS.find((preset) => preset.id === id);
}
