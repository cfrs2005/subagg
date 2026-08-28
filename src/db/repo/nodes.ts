/**
 * 节点仓储。
 *
 * ## 同步时的写入策略：upsert 而非「先删后插」
 *
 * 每次同步拿到的是订阅源的**全量**节点列表，最直觉的做法是
 * "删掉该订阅的所有旧节点，再插入新的"。但那样会丢掉 `first_seen`
 * ——用户想知道"这个节点是什么时候出现的"，而先删后插会让每个节点的
 * first_seen 在每次同步后都变成当前时间。
 *
 * 所以用 upsert：已存在的更新 `last_seen` 与可变字段，新出现的插入。
 * 之后把本轮没见到的节点删掉（它们已从上游消失）。
 */

import type { Db } from '../index.js';
import type { ProxyNode } from '../../core/types.js';

/**
 * 带持久化元信息的节点。
 *
 * 必须写成交叉类型而不是 `interface StoredNode extends ProxyNode` ——
 * `ProxyNode` 是判别联合，而 interface 只能继承对象类型或对象类型的交叉，
 * 继承联合是编译错误。交叉则会分配到每个成员上，判别能力也得以保留。
 */
export type StoredNode = ProxyNode & {
  /** 首次在该订阅源中出现的时间。 */
  firstSeen: number;
  /** 最近一次同步中仍然存在的时间。 */
  lastSeen: number;
};

interface NodeRow {
  subscription_id: string;
  fingerprint: string;
  name: string;
  type: string;
  server: string;
  port: number;
  region: string | null;
  payload: string;
  first_seen: number;
  last_seen: number;
}

/**
 * 反序列化。
 *
 * 完整节点存在 `payload` 的 JSON 里，其余列是为了能用 SQL 做筛选排序而冗余的。
 * 读取时以 payload 为准 —— 它是唯一的真相来源。
 */
function toNode(row: NodeRow): StoredNode | undefined {
  try {
    const node = JSON.parse(row.payload) as ProxyNode;
    return { ...node, firstSeen: row.first_seen, lastSeen: row.last_seen };
  } catch {
    // payload 损坏（理论上不会发生，但数据库文件可能被手工改过）。
    // 返回 undefined 让调用方跳过，好过让整个订阅请求失败。
    return undefined;
  }
}

export class NodeRepo {
  constructor(private readonly db: Db) {}

  /**
   * 用一批新节点替换某订阅源的节点集合。
   *
   * 整个过程在一个事务里完成 —— 否则并发的订阅请求可能读到
   * "旧节点已删、新节点未插"的中间状态，生成出一份空配置。
   *
   * ⚠️ **调用方必须保证 `nodes` 非空。** 传入空数组会清空该订阅的全部节点，
   * 而"解析出 0 个节点"最常见的原因是机场临时故障（返回了错误页），
   * 这时候把用户的节点全删掉是最坏的反应。`services/sync.ts` 在解析失败时
   * 会跳过本方法，保留旧节点继续服务。
   */
  replaceForSubscription(subscriptionId: string, nodes: readonly ProxyNode[], now = Date.now()): void {
    const upsert = this.db.prepare(
      `INSERT INTO nodes
         (subscription_id, fingerprint, name, type, server, port, region, payload, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subscription_id, fingerprint) DO UPDATE SET
         name      = excluded.name,
         region    = excluded.region,
         payload   = excluded.payload,
         last_seen = excluded.last_seen`,
    );

    // 删除本轮未出现的节点：它们已从上游消失。
    // 用 last_seen 而不是维护一份"本轮指纹集合"，是因为后者在节点数
    // 上千时会生成超长的 SQL IN 子句。
    const deleteStale = this.db.prepare(
      'DELETE FROM nodes WHERE subscription_id = ? AND last_seen < ?',
    );

    const run = this.db.transaction((batch: readonly ProxyNode[]) => {
      for (const node of batch) {
        upsert.run(
          subscriptionId,
          node.fingerprint,
          node.name,
          node.type,
          node.server,
          node.port,
          node.meta.region ?? null,
          JSON.stringify(node),
          now,
          now,
        );
      }
      deleteStale.run(subscriptionId, now);
    });

    run(nodes);
  }

  /** 取全部节点。订阅请求的热路径，节点数在几千量级时一次性读入完全可行。 */
  listAll(): StoredNode[] {
    const rows = this.db.prepare('SELECT * FROM nodes').all() as NodeRow[];
    return rows.map(toNode).filter((n): n is StoredNode => n !== undefined);
  }

  /**
   * 当前存在的全部地区代码。供 Web 界面构建筛选器选项。
   *
   * 从实际数据里取而不是列出全部已知地区 —— 用户只关心自己有哪些地区的节点。
   */
  distinctRegions(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT region FROM nodes WHERE region IS NOT NULL ORDER BY region')
      .all() as { region: string }[];
    return rows.map((r) => r.region);
  }

  /** 当前存在的全部协议类型。 */
  distinctTypes(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT type FROM nodes ORDER BY type')
      .all() as { type: string }[];
    return rows.map((r) => r.type);
  }
}
