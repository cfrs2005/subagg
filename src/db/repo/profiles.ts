/**
 * 配置文件（过滤规则集）仓储。
 *
 * "配置文件"是本项目的核心概念：一份命名的过滤规则 + 一个默认输出格式。
 * 它回答的问题是"从我全部的节点里，按什么条件挑一批出来，给谁用"。
 *
 * 规则以 JSON 形式整体存储而不是拆成关系表。理由：规则是一个嵌套结构
 * （include/exclude 是表达式数组，rename 是规则数组），拆成关系表需要三四张
 * 附属表和一堆 join，而我们从来不需要"按规则内容查询配置文件"这种能力 ——
 * 规则永远是整存整取的。
 */

import { randomUUID } from 'node:crypto';
import type { EmitTarget } from '../../core/emit/index.js';
import { isEmitTarget } from '../../core/emit/index.js';
import type { FilterRule } from '../../core/filter.js';
import type { UserinfoMode } from '../../core/userinfo.js';
import type { Db } from '../index.js';

export interface Profile {
  id: string;
  name: string;
  description: string;
  icon: string;
  rule: FilterRule;
  /** UA 认不出客户端时使用的输出格式。 */
  defaultTarget: EmitTarget;
  userinfoMode: UserinfoMode;
  /** 写进 Profile-Update-Interval 响应头（小时）。 */
  updateInterval: number;
  createdAt: number;
  updatedAt: number;
}

interface ProfileRow {
  id: string;
  name: string;
  description: string;
  icon: string;
  rule: string;
  default_target: string;
  userinfo_mode: string;
  update_interval: number;
  created_at: number;
  updated_at: number;
}

/** 校验从数据库读出的 userinfo_mode。 */
function toUserinfoMode(raw: string): UserinfoMode {
  if (raw === 'sum' || raw === 'off') return raw;
  if (raw.startsWith('follow:')) return raw as UserinfoMode;
  // 数据被手工改坏时的兜底。sum 是最不容易出错的默认值。
  return 'sum';
}

function toProfile(row: ProfileRow): Profile {
  let rule: FilterRule;
  try {
    rule = JSON.parse(row.rule) as FilterRule;
  } catch {
    // 规则 JSON 损坏时退化为空规则（= 全部节点），
    // 好过让整个配置文件不可用。界面上会因为节点数异常而暴露问题。
    rule = {};
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    rule,
  defaultTarget: isEmitTarget(row.default_target) ? row.default_target : 'shadowrocket',
    userinfoMode: toUserinfoMode(row.userinfo_mode),
    updateInterval: row.update_interval,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateProfileInput {
  name: string;
  description?: string;
  icon?: string;
  rule?: FilterRule;
  defaultTarget?: EmitTarget;
  userinfoMode?: UserinfoMode;
  updateInterval?: number;
}

export class ProfileRepo {
  constructor(private readonly db: Db) {}

  list(): Profile[] {
    const rows = this.db
      .prepare('SELECT * FROM profiles ORDER BY created_at ASC')
      .all() as ProfileRow[];
    return rows.map(toProfile);
  }

  get(id: string): Profile | undefined {
    const row = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as
      | ProfileRow
      | undefined;
    return row ? toProfile(row) : undefined;
  }

  create(input: CreateProfileInput): Profile {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO profiles
           (id, name, description, icon, rule, default_target, userinfo_mode,
            update_interval, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.description ?? '',
        input.icon ?? '📦',
        JSON.stringify(input.rule ?? {}),
        input.defaultTarget ?? 'shadowrocket',
        input.userinfoMode ?? 'sum',
        input.updateInterval ?? 12,
        now,
        now,
      );
    const created = this.get(id);
    if (!created) throw new Error('配置文件创建后立即读取失败');
    return created;
  }

  update(id: string, patch: Partial<Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>>): Profile | undefined {
    const columns: Record<string, unknown> = {};
    if (patch.name !== undefined) columns['name'] = patch.name;
    if (patch.description !== undefined) columns['description'] = patch.description;
    if (patch.icon !== undefined) columns['icon'] = patch.icon;
    if (patch.rule !== undefined) columns['rule'] = JSON.stringify(patch.rule);
    if (patch.defaultTarget !== undefined) columns['default_target'] = patch.defaultTarget;
    if (patch.userinfoMode !== undefined) columns['userinfo_mode'] = patch.userinfoMode;
    if (patch.updateInterval !== undefined) columns['update_interval'] = patch.updateInterval;

    const keys = Object.keys(columns);
    if (keys.length === 0) return this.get(id);

    columns['updated_at'] = Date.now();
    const allKeys = Object.keys(columns);
    const assignments = allKeys.map((k) => `${k} = ?`).join(', ');
    this.db
      .prepare(`UPDATE profiles SET ${assignments} WHERE id = ?`)
      .run(...allKeys.map((k) => columns[k]), id);

    return this.get(id);
  }

  delete(id: string): boolean {
    // 关联的 token 会被 ON DELETE CASCADE 一并删除 ——
    // 这是有意的：配置文件没了，指向它的订阅链接自然应该失效。
    return this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id).changes > 0;
  }
}
