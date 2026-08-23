# 更新日志

本文件记录面向用户的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- Admin node list now has a TCP `host:port` connectivity check with latency and failure code.
- Chain rules can select entry and landing nodes and emit Shadowrocket `chain=` or mihomo `dialer-proxy` output.
- Light theme is now the default, with a persistent dark-theme switch.
- Token expiry, cumulative or rolling access quotas, source alerts, token-level burst limiting, rotation, and access-log pruning.

### Fixed
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
