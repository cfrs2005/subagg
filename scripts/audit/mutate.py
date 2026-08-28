#!/usr/bin/env python3
"""变异测试 —— 判据是「把实现改错了，测试还绿不绿」。

普通覆盖率回答「这行代码被执行过吗」，变异测试回答**「这行代码错了会不会有人喊」**。
本项目 430 个断言全绿，但下面 24 条不变量里有 13 条改错之后测试依然全绿 ——
那不是覆盖率低，是**门禁在那些位置根本不存在**。

每条变异都对应 CLAUDE.md「硬约定（违反了会出真实事故）」里的一条，`why` 字段记录
改错之后的真实后果。锚点可以是字面量，也可以是编译好的正则 —— 后者用于那些不该把
具体值抄进仓库的位置（比如部署者的 owner 邮箱）。完整审计结论见 docs/20260827-死代码审计与剪枝台账.md 第 6 节。

用法：
    python3 scripts/audit/mutate.py              # 跑全部（约 5 分钟）
    python3 scripts/audit/mutate.py M17 M19      # 只跑指定几条
    python3 scripts/audit/mutate.py --list       # 只列清单，不跑

工作方式：把 src/ test/ 复制到系统临时目录、软链 node_modules、在副本上改代码后跑
`npx vitest run`。**永远不碰工作区**。

⚠️ `--testTimeout=30000` 不能去掉：test/ix-routes.test.ts 里有一个 it 在默认 5000ms 下
   会间歇性超时（单文件跑三次挂一次），它污染过一次判定 —— 把 M5 误报成 caught。
"""
import os, re, sys, shutil, subprocess, tempfile

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
MUTANT = os.path.join(tempfile.gettempdir(), "subagg-mutant")

# ── filter.ts 的整块代码，用于「把 A 搬到 B 之后」这类顺序变异 ──────────────────
EXCLUDE_BLOCK = """      if (rule.exclude?.length && rule.exclude.some((e) => matches(node, e, warnings))) {
        stats.droppedByExclude++;
        continue;
      }
"""
INCLUDE_BLOCK = """      if (rule.include?.length && !rule.include.some((e) => matches(node, e, warnings))) {
        stats.droppedBySelect++;
        continue;
      }
"""
LIMIT_BLOCK = """  if (rule.limit && rule.limit > 0 && selected.length > rule.limit) {
    stats.droppedByLimit = selected.length - rule.limit;
    selected = selected.slice(0, rule.limit);
  }
"""
RENAME_BLOCK = """  if (rule.rename?.length) {
    selected = selected.map((node, i) => {
      const newName = applyRenameRules(node, rule.rename ?? [], i, warnings);
      return newName === node.name ? node : { ...node, name: newName };
    });
  }
"""
DEDUPE_BLOCK = """  const dedupeMode = rule.dedupe ?? 'off';
  if (dedupeMode !== 'off') {
    const seen = new Set<string>();
    const deduped: ProxyNode[] = [];
    for (const node of selected) {
      const key = dedupeKey(node, dedupeMode);
      if (seen.has(key)) {
        stats.droppedByDedupe++;
        continue;
      }
      seen.add(key);
      deduped.push(node);
    }
    selected = deduped;
  }
"""

F = "src/core/filter.ts"

# (id, 一句话, 后果, [(文件, 原文, 替换), ...])
MUTATIONS = [
 ("M1", "toHeaderValue() 退化成恒等", "中文直塞响应头 → Node 抛错，整个 /sub 响应失败", [
   ("src/server/routes/sub.ts", "function toHeaderValue(value: string): string {",
    "function toHeaderValue(value: string): string {\n  return value; // MUTANT")]),
 ("M2", "core 的 MAX_REGEX_LENGTH 200 → 5", "与 admin.ts 的 zod max(200) 失配", [
   (F, "const MAX_REGEX_LENGTH = 200;", "const MAX_REGEX_LENGTH = 5; // MUTANT")]),
 ("M3", "admin.ts 的 zod .max(200) → .max(5)", "反向失配：这边通过校验、那边静默忽略", [
   ("src/server/routes/admin.ts", "  pattern: z.string().max(200).optional(),",
    "  pattern: z.string().max(5).optional(), // MUTANT")]),
 ("M4", "ensureUniqueNames 变 no-op", "Clash 要求 proxies.name 全局唯一，重名会拒绝整份配置", [
   (F, "  selected = ensureUniqueNames(selected);", "  // MUTANT: ensureUniqueNames removed")]),
 ("M5", "5xx 把 error.message 原样回显", "路径 / SQL 片段泄漏给调用方", [
   ("src/server/app.ts", "      error: status >= 500 ? '服务器内部错误' : message,",
    "      error: message, // MUTANT")]),
 ("M6", "ClashX Meta 正则丢掉 [x]?", "ClashXMeta 漏成原版内核，链式与 VLESS/Hy2/TUIC 一并被跳过", [
   ("src/core/emit/index.ts",
    "    re: /mihomo|clash[x]?[.\\-_ ]?meta|clash-?verge|verge|stash|flclash|nyanpasu|clashmi/i,",
    "    re: /mihomo|clash[.\\-_ ]?meta|clash-?verge|verge|stash|flclash|nyanpasu|clashmi/i, // MUTANT")]),
 ("M7", "credentialOf 把 vmess alterId 算进凭据", "上游在 0/64 间改一次 → 全部 vmess 换指纹，用户勾选全失效", [
   ("src/core/fingerprint.ts", "    case 'vmess':\n      parts = [node.uuid];\n      break;",
    "    case 'vmess':\n      parts = [node.uuid, String(node.alterId)]; // MUTANT\n      break;")]),
 ("M8", "partitionBySupport 把全部节点当 usable", "跳过节点静默丢弃，用户查不到原因", [
   ("src/core/emit/capability.ts", "    const check = checkSupport(node, target);\n    if (check.supported) {",
    "    const check = checkSupport(node, target);\n    if (true) { // MUTANT")]),
 ("M9", "redactPathname 退化成恒等", "URL 路径段里的明文 token 落盘", [
   ("src/logger.ts", "    .map((seg) => (seg.length >= 12 ? mask(seg) : seg))", "    .map((seg) => seg) // MUTANT")]),
 ("M10", "notFoundHandler 不脱敏且返回 200", "明文 token 进日志 + 404 变 200", [
   ("src/server/app.ts", "    await reply.code(404).send({ error: `找不到 ${req.method} ${req.url}` });",
    "    await reply.code(200).send({ error: 'MUTANT' });")]),
 ("M11", "exclude 降到 include 之后", "exclude 优先级被反转（实测：节点输出不变，只有归因统计变）", [
   (F, EXCLUDE_BLOCK, ""), (F, INCLUDE_BLOCK, INCLUDE_BLOCK + EXCLUDE_BLOCK)]),
 ("M12", "截断挪到重命名之后", "CLAUDE.md 说 {index} 会不连续（实测：本实现下空转）", [
   (F, LIMIT_BLOCK, ""), (F, RENAME_BLOCK, RENAME_BLOCK + LIMIT_BLOCK)]),
 ("M13", "去重挪到重命名之后", "真行为变化：序号出空洞，配 limit 还少输出一个节点", [
   (F, DEDUPE_BLOCK, ""), (F, RENAME_BLOCK, RENAME_BLOCK + DEDUPE_BLOCK)]),
 ("M14", "指纹分隔符 \\x1f → '|'", "全库重新 key；字段里带 | 可制造指纹碰撞", [
   ("src/core/fingerprint.ts",
    "return createHash('sha1').update(parts.join('\\x1f')).digest('hex').slice(0, FINGERPRINT_LENGTH);",
    "return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, FINGERPRINT_LENGTH); // MUTANT")]),
 ("M15", "QR_MAX_VERSION 25 → 40", "v40 在 300px 弹窗里每模块 1.7 CSS 像素，扫不出来", [
   ("src/core/qrcode.ts", "export const QR_MAX_VERSION = 25;", "export const QR_MAX_VERSION = 40; // MUTANT")]),
 ("M16", "原版 Clash 的 SUPPORTED_TYPES 误填 vless", "客户端拒绝加载整份配置 = 全网断", [
   ("src/core/emit/capability.ts", "clash: new Set<ProxyType>(['ss', 'ssr', 'vmess', 'trojan']),",
    "clash: new Set<ProxyType>(['ss', 'ssr', 'vmess', 'trojan', 'vless']), // MUTANT")]),
 ("M17", "sync 解析出 0 个节点也照写库", "机场返 502 / 人机验证页 → 清空该订阅全部节点", [
   ("src/services/sync.ts", "      if (parsed.nodes.length === 0) {", "      if (false) { // MUTANT")]),
 ("M18", "replaceForSubscription 的 upsert 覆盖 first_seen", "丢失首见时间", [
   ("src/db/repo/nodes.ts", "         last_seen = excluded.last_seen`,",
    "         last_seen = excluded.last_seen,\n         first_seen = excluded.first_seen`, // MUTANT")]),
 ("M19", "去掉 x-subagg-skipped 响应头", "跳过节点静默丢弃", [
   ("src/server/routes/sub.ts", "          reply.header('x-subagg-skipped', String(result.skipped.length));",
    "          void 0; // MUTANT")]),
 ("M20", "去掉 token 层的 x-subagg-limit 头", "429 不可归因", [
   ("src/server/routes/sub.ts", "          reply.header('x-subagg-limit', 'token');", "          void 0; // MUTANT")]),
 ("M21", "去掉 quota 层的 x-subagg-limit 头", "429 不可归因", [
   ("src/server/routes/sub.ts", "            reply.header('x-subagg-limit', 'quota');", "            void 0; // MUTANT")]),
 # 锚点用正则而不是字面量：owner 邮箱是部署者的私人信息，不该出现在仓库的工具脚本里，
 # 而且这样写在邮箱变更后依然有效。
 ("M23", "DEFAULT_GOOGLE_OWNER_EMAIL 换成别人的邮箱", "owner-only 白名单被改", [
   ("src/config.ts", re.compile(r"export const DEFAULT_GOOGLE_OWNER_EMAIL = '[^']*';"),
    "export const DEFAULT_GOOGLE_OWNER_EMAIL = 'attacker@example.com'; // MUTANT")]),
 ("M24", "编辑已发布的迁移 v1（加一列）", "新库有、老库没有，静默分叉", [
   ("src/db/migrations.ts", "  format          TEXT    NOT NULL DEFAULT 'auto',",
    "  format          TEXT    NOT NULL DEFAULT 'auto',\n  legacy_probe    INTEGER NOT NULL DEFAULT 0, -- MUTANT")]),
 ("M25", "编辑已发布的迁移 v1（改默认值 12 → 99）", "同上", [
   ("src/db/migrations.ts", "  update_interval INTEGER NOT NULL DEFAULT 12,",
    "  update_interval INTEGER NOT NULL DEFAULT 99, -- MUTANT")]),
]


def reset():
    shutil.rmtree(MUTANT, ignore_errors=True)
    os.makedirs(MUTANT)
    for p in ("src", "test", "vitest.config.ts", "tsconfig.json", "package.json"):
        s, d = os.path.join(REPO, p), os.path.join(MUTANT, p)
        (shutil.copytree if os.path.isdir(s) else shutil.copy)(s, d)
    os.symlink(os.path.join(REPO, "node_modules"), os.path.join(MUTANT, "node_modules"))


def run_tests():
    r = subprocess.run(["npx", "vitest", "run", "--testTimeout=30000"],
                       cwd=MUTANT, capture_output=True, text=True)
    out = r.stdout + r.stderr
    summary = [l.strip() for l in out.splitlines() if "Tests " in l and ("passed" in l or "failed" in l)]
    fails = [l.strip() for l in out.splitlines() if l.strip().startswith("×")]
    return (summary[-1] if summary else "NO SUMMARY: " + out[-400:]), fails


def main():
    argv = [a for a in sys.argv[1:] if not a.startswith("-")]
    if "--list" in sys.argv:
        for mid, what, why, _ in MUTATIONS:
            print(f"{mid:5} {what}\n      → {why}")
        return
    todo = [m for m in MUTATIONS if not argv or m[0] in argv]
    if not todo:
        print(f"没有匹配的变异 id。可用：{', '.join(m[0] for m in MUTATIONS)}")
        sys.exit(1)

    uncaught = []
    for mid, what, why, edits in todo:
        reset()
        ok = True
        for path, old, new in edits:
            fp = os.path.join(MUTANT, path)
            src = open(fp).read()
            is_re = hasattr(old, "search")
            if not (old.search(src) if is_re else old in src):
                print(f"\n[{mid}] {what}\n  ⚠ 在 {path} 找不到锚点 —— 代码已改，这条变异需要更新")
                ok = False
                break
            open(fp, "w").write(old.sub(new, src, 1) if is_re else src.replace(old, new, 1))
        if not ok:
            continue
        summary, fails = run_tests()
        caught = "failed" in summary
        if not caught:
            uncaught.append((mid, what, why))
        print(f"\n[{mid}] {what}")
        print(f"  → {summary}   {'caught' if caught else '*** UNCAUGHT（改错了也全绿）***'}")
        for f in fails[:5]:
            print("     ", f)

    print("\n" + "=" * 72)
    print(f"跑了 {len(todo)} 条，{len(uncaught)} 条逃逸")
    for mid, what, why in uncaught:
        print(f"  {mid:5} {what}\n        后果：{why}")
    shutil.rmtree(MUTANT, ignore_errors=True)


if __name__ == "__main__":
    main()
