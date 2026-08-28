# 更新日志

本文件记录面向用户的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- Production Google OIDC login with an exact owner-only email policy, PKCE,
  state/nonce validation, revocable hashed application sessions, CSRF protection,
  logout, public privacy/terms pages, and a production-disabled local development fallback.
- Database migration version 7 adds Google account mapping, web sessions, and
  single-use OAuth login attempts without persisting Google access or refresh tokens.
- Admin node list now has a TCP `host:port` connectivity check with latency and failure code.
- Chain rules can select entry and landing nodes and emit Shadowrocket `chain=` or mihomo `dialer-proxy` output.
- Light theme is now the default, with a persistent dark-theme switch.
- Token expiry, cumulative or rolling access quotas, source alerts, token-level burst limiting, rotation, and access-log pruning.

- **二维码出码**：订阅链接与单节点 URI 均可生成二维码，扫码即可导入客户端。
  编码器自研（`src/core/qrcode.ts`，纯函数、零新增依赖），**全程本地计算、
  零外部请求** —— 这条链接等同于全部节点的访问凭证，不会交给任何第三方出码服务。
  内容超出可靠出码上限时明确拒绝并给出可操作提示，绝不产出一张扫不出来的码。
- 三层限流（IP / 链接 / 配额）现在各自记结构化日志，并通过 `X-Subagg-Limit`
  响应头标明是哪一层拦的 —— 一条 `curl -I` 就能区分，不必再猜。

- **IX 派生协议节点**：节点页选择原节点和 IX 通道后，平台创建或认领转发端口，
  节点目录立即新增 `IX_<原节点名>`。原节点保留；IX 节点继承协议、凭据、TLS、
  SNI 与 Host，只把 `server` / `port` 换成平台返回的入口。
  - 派生指纹由 `providerId + 原节点指纹` 决定，入口域名与端口批量变化时保持稳定。
  - profile 直接选择 IX 节点，不再使用 `rule.ix` 或渲染期临时改写。
  - 不可用 IX 节点保留并标记，但不进入订阅，也不会伪装成同名直连节点。
  - 创建前执行协议安全检查；确定不安全的组合不调用远端创建接口、不占配额。
  - 五分钟自动同步入口；批量映射在一个事务中更新，避免新旧域名混合。
  - 首次同步会读取平台已有端口，按目标地址精确匹配本地节点并自动认领，不新建远端端口。
  - 删除 IX 节点时，最后一个本地引用会删除并回读确认远端端口；共享端口不会被
    提前删除。中转商仍有关联 IX 节点时禁止删除。
- 新增 `POST /api/ix/relays` 与 `DELETE /api/ix/relays/:relayFingerprint`；
  `GET /api/nodes` 增加节点类型、原节点指纹、provider 与 relay 状态。
- 新增环境变量 `IX_SYNC_INTERVAL_MINUTES`（默认 5，0 禁用后台同步），替换小时口径。
- 数据库迁移 version 6 `ix_remote_port_refs` 为共享远端端口引用查询增加索引。

### Fixed
- Refined the complete web workspace: desktop navigation no longer repeats the
  sidebar, long profile editors keep save actions visible, sparse friend and IX
  cards use available space, responsive controls remain reachable, login and
  legal pages share the product hierarchy, and dark theme now covers the actual
  workspace instead of only changing the theme toggle.
- Chain-node names are now presented as an explicit editable field with a mobile
  preview. A plain short name is accepted directly; `{entry}`, `{landing}`, and
  `{seq}` remain available for templates, and multiple pairs stay unique.
- Subscription links in the profile dialog are visible in full and copy the real
  URL again. The admin state now includes the same complete URL as the token API,
  and the copy action rejects empty values and falls back when Clipboard API access is unavailable.
- Upgraded `@fastify/static` to 10.1.3 after the production dependency audit
  reported path traversal and non-canonical URL authorization bypass advisories;
  the production audit now reports zero vulnerabilities.
- 链式代理的入口和落地现在从完整可用节点目录解析，不再被“仅使用所选节点”、
  地区/协议筛选或主规则数量上限误删；直选节点保持原规则，链式配对作为额外节点输出。
- 配置文件全屏编辑页恢复「删除配置」入口；删除前显示关联有效订阅链接数量，确认后配置与链接一并失效。
- **前端 `fmtBytes()` 的兜底分支会把入参原样送进 `innerHTML`**（XSS 路径）。
  其余分支都经过算术运算、结果必然是数字，只有 < 1000 那条把入参直接带出去 ——
  而流量字段来自上游与中转平台，理论上可以是任意 JSON 值。流量页与好友页
  也走同一个函数。已改为 `esc(bytes)`。
- **`GET /api/nodes/:fingerprint/uri` 缺 `cache-control: no-store`**。
  CLAUDE.md 声称三个凭据出口都带这个头，实际漏了这一个（两个二维码路由是带的）——
  响应体等同凭据，却可能被写进磁盘缓存。已补齐，三个出口现在一致。
- **ClashX Meta 被误判为原版 Clash 内核**。UA 识别正则要求 `clash` 与 `meta`
  之间最多隔一个分隔符，而 `ClashX Meta` 中间夹着 `X`，于是落到通用 Clash 规则，
  链式代理节点与 VLESS / Hysteria2 / TUIC 被整批跳过。裸的 ClashX / ClashX Pro
  仍正确识别为原版内核。
- **`/sub` 与 `/api` 的错误从未走过自定义错误处理**。`setErrorHandler` 与
  `setNotFoundHandler` 注册在各 `register()` 之后，而 Fastify 的处理器按封装上下文
  继承 —— 子插件只继承注册那一刻已有的处理器。后果是这两组路由的错误不脱敏、
  不记日志，5xx 还会把内部错误信息原样回显。两个处理器已前移到路由注册之前。
- **鉴权失败日志会写入明文订阅 token**。`redact()` 只对 `http(s)://` 开头的字符串
  做 URL 脱敏，而 `path: req.url` 是相对路径，于是
  `/api/tokens/<明文 token>/revoke` 被原样落盘。新增 `redactPath()`，并在
  `redact()` 中对 `path` 字段自动应用。
- 限流触发时的 429 响应统一为 `text/plain` 并带 `Retry-After`。此前 IP 层返回 JSON，
  代理客户端会先拿它当配置解析，最终报"配置解析失败"，把排查引向错误方向。
- Preview statistics and preview body now use the same node limit and filter pass.
- Fingerprint credential fields now use an unambiguous separator. Existing SS/SSR/TUIC fingerprints and saved picks are recalculated after upgrade.

## [0.1.0] — 首个版本

从静态原型到可用产品的第一版。

### 新增

**订阅聚合**
- 多订阅源抓取与合并，自动识别 Clash YAML 与 base64 URI 列表两种格式
- 协议支持：VMess、VLESS（含 REALITY / XTLS Vision）、Trojan、Shadowsocks
  （SIP002 与旧式两种 URI）、ShadowsocksR、Hysteria2、TUIC
- 传输层支持：TCP、WebSocket、gRPC、HTTP/2、HTTP 伪装
- 抓取具备超时、响应体大小上限、指数退避重试、ETag 条件请求、UA 伪装
- 定时同步调度器，按每个订阅各自的间隔触发

**多客户端输出**
- 同一条 `/sub/:token` 按 User-Agent 自动返回对应格式，`?target=` 可强制指定
- 输出目标：Clash、Clash.Meta(mihomo)、Shadowrocket、V2Ray/v2rayN
- 协议 × 目标的能力矩阵：目标不支持的节点会被跳过，并通过
  `X-Subagg-Skipped` 响应头与界面如实上报原因
- Clash 输出包含自动生成的 proxy-groups（含按地区分组）与规则

**过滤规则**
- 按地区、协议、订阅源、正则包含/排除筛选
- 手动勾选节点（基于稳定指纹，上游改名后依然有效）
- 去重（同服务器端口 / 完全相同两种口径）、重命名模板、排序、数量上限
- 内置信息节点排除规则，默认过滤机场塞入的"剩余流量""官网"等伪节点
- 各阶段过滤统计，可回答"我的节点为什么少了"

**流量监控**
- 解析上游的 `Subscription-Userinfo`，保存历史快照
- 自己的订阅响应回写聚合后的流量头，支持合计 / 跟随单一源 / 关闭三种口径

**共享管理**
- 好友管理，每人独立且可单独吊销、可一键轮换的订阅 token
- 真实访问日志：拉取时间、次数、识别出的客户端、来源 IP 的加盐哈希

**Web 管理界面**
- 零构建前端（原生 ES module，无打包器）
- 规则编辑器带实时预览：改任何一条规则立刻看到命中节点与生成结果
- 节点表格支持勾选并直接生成配置文件

**安全**
- 管理 API 全量 Bearer 鉴权，比较使用时间恒定算法
- 日志自动脱敏：订阅 URL、UUID、密码、token 一律打码
- 访问日志中的 IP 以 HMAC 哈希存储，不存明文
- `/sub` 端点限流；SQLite 文件权限 0600
- `ADMIN_TOKEN` 必填且无默认值，缺失时拒绝启动

### 相对原型的实质修正

原型（现位于 [`docs/prototype.html`](./docs/prototype.html)）中的两处问题在本版本被纠正：

- **地区色标不再硬编码。** 原先只有 `.r-HK` ~ `.r-UK` 七个 CSS 类，
  出现第八个地区就没有样式。现在按地区码哈希生成色相。
- **移除了编造的流量估算。** 原型里的 `estGB: 18.6` / `avgGB: 22.3` 是写死的假数据，
  与项目自己声明的"好友流量无法精确计量"自相矛盾。现在只展示真实采集到的拉取记录。

### 已知限制

- 无法测量好友的实际流量消耗（流量不经过本服务，这是原理性限制，不是待办事项）
- 尚未支持 sing-box JSON、Surge、Quantumult X 配置格式
- 正则的 ReDoS 防护是启发式的缓解而非根治，信任模型详见 [SECURITY.md](./SECURITY.md)
- 单用户自托管，没有多用户与权限体系

[Unreleased]: https://github.com/your-org/subagg/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/your-org/subagg/releases/tag/v0.1.0
