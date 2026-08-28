#!/usr/bin/env node
/**
 * data-action 双向对账 —— public/ 是零构建原生 ES module，事件走统一委托 + data-action，
 * 所以「按钮」和「处理它的 case」是两份互相看不见的清单，只能靠对账发现缺口。
 *
 * 两个方向的缺口后果完全不同：
 *   HTML/JS 产出了 action 但 switch 没有 case  →  用户点了没反应（真 bug）
 *   switch 有 case 但全仓无任何产出点          →  死 handler（可删）
 *
 * 本脚本在 2026-08-27 的审计里抓到三个死 handler（toggle-region / toggle-type /
 * create-friend-token，其中最后一个触发即抛 TypeError）。详见
 * docs/20260827-死代码审计与剪枝台账.md 第 3 节批次 A。
 *
 * 用法：node scripts/audit/dead-actions.cjs
 * 退出码：发现「点了没反应」时为 1，仅有死 handler 时为 0（后者不是线上故障）。
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const js = fs.readFileSync(path.join(REPO, 'public/app.js'), 'utf8');
const html = fs
  .readdirSync(path.join(REPO, 'public'))
  .filter((f) => f.endsWith('.html'))
  .map((f) => fs.readFileSync(path.join(REPO, 'public', f), 'utf8'))
  .join('\n');
const all = `${js}\n${html}`;

const produced = new Set();
for (const m of all.matchAll(/data-action="([a-z0-9-]+)"/g)) produced.add(m[1]);
// 动态产出：ixConfirmModal({ action: 'x' }) 这类把 action 名当参数传的
for (const m of js.matchAll(/\baction:\s*'([a-z0-9-]+)'/g)) produced.add(m[1]);

const handled = new Set();
const i = js.indexOf("addEventListener('click'");
const sw = i < 0 ? '' : js.slice(i);
for (const m of sw.matchAll(/^\s*case\s+'([a-z0-9-]+)':/gm)) handled.add(m[1]);
for (const m of js.matchAll(/dataset\.action\s*===\s*'([a-z0-9-]+)'/g)) handled.add(m[1]);

const noHandler = [...produced].sort().filter((a) => !handled.has(a));
const noProducer = [...handled].sort().filter((a) => !produced.has(a));

console.log(`produced: ${produced.size}   handled: ${handled.size}`);
console.log('\n=== 有按钮但无 case（点了没反应，真 bug）===');
console.log(noHandler.length ? noHandler.map((a) => `  ${a}`).join('\n') : '  （无）');
console.log('\n=== 有 case 但全仓无产出点（死 handler，可删）===');
console.log(noProducer.length ? noProducer.map((a) => `  ${a}`).join('\n') : '  （无）');

if (noHandler.length) process.exit(1);
