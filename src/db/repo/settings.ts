/**
 * 站点级设置仓储。
 *
 * 只有一个使用方：全局默认分流编排。所以接口刻意做小 ——
 * 两个方法，一个键，没有通用 KV 的诱惑。
 */

import type { Orchestration } from '../../core/orchestrate.js';
import type { Db } from '../index.js';

const KEY = 'default_orchestration';

/** 解析损坏时返回 null（= 回到内置预设），与 profiles.rule 的兜底策略一致。 */
function toOrchestration(raw: string | undefined): Orchestration | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<Orchestration>;
    if (!Array.isArray(candidate.groups) || !Array.isArray(candidate.rules)) return null;
    return parsed as Orchestration;
  } catch {
    return null;
  }
}

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  /** 全局默认编排。null 表示未设置（回落到随代码发布的内置预设）。 */
  getDefaultOrchestration(): Orchestration | null {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(KEY) as { value: string } | undefined;
    return toOrchestration(row?.value);
  }

  /**
   * 写入全局默认编排。传 null 删除该键 = 清除自定义，回到内置预设。
   */
  setDefaultOrchestration(value: Orchestration | null): void {
    if (value === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(KEY);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(KEY, JSON.stringify(value), Date.now());
  }
}
