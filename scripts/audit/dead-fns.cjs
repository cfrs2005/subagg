#!/usr/bin/env node
/**
 * public/app.js 的顶层函数引用分析 —— 找没有任何调用点的函数。
 *
 * 关键能力是**死区级联**：把已知的死代码行段用 --dead 传进来，被排除后重跑，
 * 那些「只被死代码引用」的函数会新暴露出来。2026-08-27 的审计正是靠这一步
 * 证明「旧 modal 版配置编辑器 + 实时预览」是整块被取代的，而不是零散几个函数
 * （连带六个 CSS 类也随之暴露为死）。详见 docs/20260827-死代码审计与剪枝台账.md 第 4 节。
 *
 * 用法：
 *   node scripts/audit/dead-fns.cjs                        # 直接找零引用函数
 *   node scripts/audit/dead-fns.cjs --dead 1602-1818,1970-2022   # 排除死区后重跑（级联）
 *
 * ⚠️ 这是词法分析，不懂动态调用。报出来的每一条都要人工确认它不是通过
 *    data-action 表间接调用、或作为回调传参的（那两种情况在本项目里很常见）。
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const js = fs.readFileSync(path.join(REPO, 'public/app.js'), 'utf8');

const flagIdx = process.argv.indexOf('--dead');
const DEAD =
  flagIdx > -1 && process.argv[flagIdx + 1]
    ? process.argv[flagIdx + 1].split(',').map((r) => r.split('-').map(Number))
    : [];
const inDead = (line) => DEAD.some(([a, b]) => line >= a && line <= b);

const lines = js.split('\n');
const defs = [];
lines.forEach((l, i) => {
  let m = l.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
  if (m) defs.push([m[1], i + 1]);
  m = l.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/);
  if (m) defs.push([m[1], i + 1]);
});

console.log(`顶层函数定义: ${defs.length}${DEAD.length ? `   已排除死区: ${process.argv[flagIdx + 1]}` : ''}`);
let found = 0;
for (const [name, line] of defs) {
  const re = new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, 'g');
  const refs = [...js.matchAll(re)]
    .map((m) => js.slice(0, m.index).split('\n').length)
    .filter((l) => l !== line);
  const live = refs.filter((l) => !inDead(l));
  if (live.length === 0) {
    found++;
    const note = refs.length ? `refs=[${refs.join(',')}] 全部落在死区内` : '全仓零引用';
    console.log(`  DEAD  ${name}  def:${line}  ${note}`);
  }
}
if (!found) console.log('  （无零引用函数）');
