# scripts/audit —— 死代码与门禁审计工具

这三个脚本回答的是 `npm test` 回答不了的问题。它们**不跑在 CI 里**，是需要时手动跑的诊断工具，
产出给人读，不是断言。全部只读工作区（变异测试在系统临时目录里操作副本）。

背景与完整结论：[`docs/20260827-死代码审计与剪枝台账.md`](../../docs/20260827-死代码审计与剪枝台账.md)

## `mutate.py` —— 变异测试

```bash
python3 scripts/audit/mutate.py            # 全部 24 条，约 5 分钟
python3 scripts/audit/mutate.py M17 M19    # 只跑指定几条
python3 scripts/audit/mutate.py --list     # 只看清单
```

覆盖率回答「这行代码被执行过吗」，变异测试回答**「这行代码错了会不会有人喊」**。

24 条变异逐条对应 CLAUDE.md「硬约定（违反了会出真实事故）」里的一条。首次跑出的结果是
**13 条逃逸** —— 改错之后 430 个断言依然全绿，也就是那些位置根本没有门禁。最要命的三条：

- `M17` sync 解析出 0 个节点也照写库 → 机场返 502 就清空该订阅全部节点
- `M19` 去掉 `x-subagg-skipped` 响应头 → 跳过节点静默丢弃
- `M7` `credentialOf` 把 vmess `alterId` 算进凭据 → 上游改一次，用户手动勾选全失效

**补断言的正确姿势是让对应的变异从 UNCAUGHT 变成 caught**，而不是追覆盖率数字。

改了被变异的那几处代码后，脚本会报「找不到锚点」——那说明这条变异需要跟着更新，不是脚本坏了。

⚠️ `--testTimeout=30000` 不能去掉。`test/ix-routes.test.ts` 里有个 it 在默认 5000ms 下会
间歇性超时（单文件跑三次挂一次），它污染过一次判定，把 `M5` 误报成 caught。

## `dead-actions.cjs` —— `data-action` 双向对账

```bash
node scripts/audit/dead-actions.cjs
```

`public/` 是零构建原生 ES module、事件走统一委托 + `data-action`，所以「按钮」和「处理它的 case」
是两份互相看不见的清单。两个方向的缺口后果不同：

| 方向 | 后果 | 退出码 |
|---|---|---|
| 有按钮但无 case | 用户点了没反应（真 bug） | 1 |
| 有 case 但无产出点 | 死 handler（可删） | 0 |

首次跑出三个死 handler，其中 `create-friend-token` 触发即抛 `TypeError`（它读两个 DOM 里
根本不存在的 id）。

## `dead-fns.cjs` —— `app.js` 顶层函数引用分析

```bash
node scripts/audit/dead-fns.cjs                              # 找零引用函数
node scripts/audit/dead-fns.cjs --dead 1602-1818,2069-2112   # 排除死区后重跑（级联）
```

关键能力是 `--dead` 的**级联**：把已确认的死代码行段排除掉再跑，那些「只被死代码引用」的函数
会新暴露出来。审计里正是靠这一步证明「旧 modal 版配置编辑器 + 实时预览」是整块被取代的，
而不是零散几个函数 —— 连带六个 CSS 类也随之暴露为死。

⚠️ 这是词法分析，不懂动态调用。报出来的每一条都要人工确认它不是通过 `data-action` 表间接调用、
或作为回调传参的（这两种在本项目里很常见）。

## `filter-order.mts` —— 管线顺序的逐输入对比

```bash
npx tsx scripts/audit/filter-order.mts
```

变异测试只告诉你「改错了测试还绿」。绿有两种原因，后续动作完全相反：

- **测试写得弱** → 补断言
- **不变量本身空转** → 改文档（那条理由是错的）

这个脚本把变异实现与原实现喂同一批输入、逐字比对输出来区分两者。它证明了 CLAUDE.md 关于
`core/filter.ts` 管线顺序的三条理由里有两条接错了对象：

| 文档说 | 实测 |
|---|---|
| 去重必须早于重命名（重命名抹掉区分信息） | 理由错（`dedupeKey` 从不读 `name`），但**结论对**：真正的原因是 `{index}` 连续性 + 与 limit 的交互 —— 顺序一反，序号出空洞，配 limit 还少输出一个节点 |
| 截断必须早于重命名（`{index}` 才连续） | **空转**：前缀截断，`{index}` 在截断前后取值一致 |
| exclude 优先于 include 是刻意的 | 节点输出逐字相同；真正需要顺序的是**归因统计**（`droppedBySelect` / `droppedByExclude`） |

脚本里的代码块常量与 `mutate.py` 的同名常量必须一致 —— 改了一边记得改另一边。
