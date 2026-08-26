<div align="center">

# subagg

**自托管的代理订阅聚合管理器，可选中转编排。**

一条链接，客户端要什么格式就给什么格式；愿意的话，还能让它拨的是就近的中转入口，
而不是机场的落地机。

[English](./README.md) · [安全说明](./SECURITY.md) · [参与贡献](./CONTRIBUTING.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen.svg)](https://nodejs.org)

</div>

---

## 它解决什么问题

你手上有好几个机场订阅，每个给一条链接。每条链接只跟部分客户端合得来。
电脑上跑 Clash，手机上跑 Shadowrocket，分享节点的朋友又用着别的东西。

subagg 把它们合并成**一条链接**：

```
N 个上游订阅
     │
     ▼  抓取、解析成统一节点模型
  过滤规则（地区 / 协议 / 正则 / 手动勾选 / 去重 / 重命名）
     │
     ▼  可选：把拨号地址换成中转入口（IX）
  https://你的域名/sub/<token>
     │
     ├─ Clash 来拉        → 带分组与规则的 YAML
     ├─ Shadowrocket 来拉 → base64 URI 列表
     └─ v2rayN 来拉       → base64 URI 列表
```

格式由客户端的 `User-Agent` 自动判定。想强制指定就加 `?target=clash.meta`。

中间那一步可选的环节是这个项目的另一半：subagg 还能去驱动一个 L4 端口转发平台，
让发出去的链接指向就近的中转入口，而不是直接指向机场落地。
详见 [IX 中转编排](#ix-中转编排)。

## 功能

- **多源聚合** —— 自动识别 Clash YAML 与 base64 URI 列表两种订阅格式。
  支持协议：VMess、VLESS（含 REALITY）、Trojan、Shadowsocks、ShadowsocksR、
  Hysteria2、TUIC。
- **一条链接通吃** —— Clash / Clash.Meta(mihomo) / Shadowrocket / v2rayN
  按 UA 自动匹配。
- **过滤规则与输出格式解耦** —— 同一份规则可生成所有格式。可按地区、协议、
  订阅源、正则包含/排除筛选，也可以在界面上直接勾选节点。另有去重、
  重命名模板、排序与数量上限。
- **不静默丢节点** —— 客户端不支持的节点（比如原版 Clash 上的 VLESS）
  会通过响应头和界面如实上报，并说明原因。
- **流量监控** —— 解析各上游的 `Subscription-Userinfo`，保留历史快照，
  并把聚合后的流量头回写到自己的订阅响应里，客户端因此能显示流量条。
- **共享管理** —— 给每位好友发独立且可单独吊销的链接，并查看真实的
  拉取记录（时间、客户端、不同来源数）。
- **二维码本地生成** —— 订阅链接与单节点 URI 都能出码，扫码即可导入。
  编码器是自研的纯函数，**全程本地计算、零外部请求** —— 这条链接等同于
  全部节点的访问凭证，不会交给任何第三方出码服务。
- **IX 中转编排**（可选，默认关闭）—— 由 subagg 去 L4 中转平台建转发端口，
  订阅里下发的是中转入口地址而不是落地地址。**只改 `server` 与 `port`**，
  UUID、密码、TLS、SNI、Host、path 等协议参数与直连版逐字节一致。
  per-profile 开关 + 全局总闸，映射不可用的节点会如实回落直连并给出原因。

## 界面截图

### 节点管理

在一个紧凑工作区中筛选、查看和测试全部节点。公开图片已经过脱敏处理。

![节点管理工作区](./assets/screenshots/node-management.png)

### 链式代理配置

为可选的中继链路选择入口与落地节点，不改变普通订阅的输出。

![链式代理配置](./assets/screenshots/chain-proxy-configuration.png)

## 快速开始

需要 Node.js ≥ 20.11。

```bash
git clone https://github.com/your-org/subagg.git
cd subagg
npm install

cp .env.example .env
echo "ADMIN_TOKEN=$(openssl rand -hex 32)" >> .env
echo "IP_HASH_SALT=$(openssl rand -hex 16)" >> .env

npm run build
npm start
```

打开 <http://127.0.0.1:8787>，填入 `ADMIN_TOKEN`，添加订阅源。

开发时用 `npm run dev`（tsx 监听模式）。

> **在把它暴露到公网之前，请先读一遍 [SECURITY.md](./SECURITY.md)。**
> 数据库里存的是你的代理凭据。必须挂 HTTPS，管理接口不应该能被公网访问到。

部署方式：VPS 直装可用 [systemd unit](./scripts/subagg.service)；
偏好容器则有 [Dockerfile](./Dockerfile) 与 [compose 文件](./docker-compose.yml)。

## 使用订阅链接

```bash
# 同一条 URL，三种客户端，三种格式
curl -A "ClashforWindows/0.20.39" https://你的域名/sub/$TOKEN   # → YAML
curl -A "Shadowrocket/2.2.31"     https://你的域名/sub/$TOKEN   # → base64
curl -A "v2rayN/6.45"             https://你的域名/sub/$TOKEN   # → base64

# 强制指定格式
curl "https://你的域名/sub/$TOKEN?target=clash.meta"

# 不下载内容，只看发生了什么
curl -sI https://你的域名/sub/$TOKEN
```

值得关注的响应头：

| 响应头 | 含义 |
|---|---|
| `Subscription-Userinfo` | 聚合后的流量信息；客户端里的流量条就是靠它画出来的 |
| `Profile-Update-Interval` | 建议客户端多久来拉一次 |
| `X-Subagg-Nodes` | 本次写进配置的节点数 |
| `X-Subagg-Target` | 用了哪种格式，以及依据（`ua` / `query` / `default`） |
| `X-Subagg-Skipped` | 目标格式无法表达而被跳过的节点数 |
| `X-Subagg-IX` | 开了中转时的改写结果：`rewritten=N; direct=N; dropped=N` |
| `X-Subagg-IX-Reason` | 第一个**没被改写**的节点的原因码 |
| `X-Subagg-Warning` | 其他需要你知道的信息 |

## IX 中转编排

可选功能，不在某个配置文件上主动打开就不会生效。

它解决的是**链路质量**，不是能不能连上：从你的设备到机场落地那一跳你控制不了
（可能绕路、可能被限速）。L4 端口转发平台给你一个就近的入口地址，把流量透传到
落地机，长途那一段就跑在别人花钱维护的骨干上。

```
客户端 ──▶ IX 入口（就近）──▶ 原落地服务器
```

L4 转发不解 TLS、不看载荷。所以 subagg **只改拨号地址** —— `server` 与 `port`。
UUID、密码、加密方式、TLS、SNI、ALPN、REALITY、Host、path、gRPC serviceName、
flow 一律不动，与直连版逐字节一致。改写发生在**生成订阅的那一刻**，
**绝不入库**：库里的节点永远是原始地址，所以你的手动勾选、ping 历史、映射关系
都不会因为开了中转而失效。

由此带来的一个后果值得单独说，因为握手成败就在这里。`server` 其实同时承担了
"跟谁握手"这个角色 —— 模型里有 4 处在缺省时回落到它：`tls.sni`、
`ws.headers.Host`、`h2.host`、`http.headers.Host`。改 `server` 就等于悄悄改了
这 4 个值，所以 subagg 会把**原始 server** 显式写进这几个位置。这不是新增语义，
而是把改写前已经生效的隐式默认值固化下来。它默认开启（`fillOriginHost`），
建议保持开启 —— 关掉之后 TLS 类节点会拿中转入口域名去握手，必然失败，
而且失败原因对用户完全不可见。

### 怎么配

1. **录入中转商** —— 「IX 中转」页 →「＋ 添加中转商」。需要 API 基址
   （形如 `https://<平台域名>/api`）与凭据。
2. **测试连接** —— 拉回线路清单、每条线路的端口配额、流量、到期时间，
   以及一份明确写出"这个账号做不到什么"的清单。
3. **建转发端口** —— 节点页勾选要走中转的节点 →「建立 IX 转发」
   （一批最多 50 个指纹）。若平台上已经有指向同一个 `host:port` 的端口，
   subagg 会**认领**它而不是重复创建 —— 配额小到不允许浪费。
4. **在 profile 上打开** —— 配置文件编辑页 →「IX 中转」面板 → 打开。
   只有开了这个开关的 profile 会被改写，其余照旧下发直连地址。

### 认证方式

两种都是一等公民：

- **`X-API-Key`（首选）。** 长期有效的 Key，这类平台上通常需要管理员签发。
  申请时只要最小权限：够读写转发端口 + 读自己的订阅/额度即可 ——
  我们接入的这个平台上是 `ports_traffic` + `subscription_link`。
  **不要申请 `full` / `admin_system` / `agent_exec`**：subagg 用不到，
  而一把什么都能干的 Key 是不该躺在数据库里的。
  （这几个权限名来自平台自己的权限清单；subagg 代码不校验它们，只负责发这个头。）
- **账号登录（退路）。** 用账号密码换 JWT，实测有效期 **7 天**，自动续期
  （到期前 5 分钟主动重登，另外遇到 `401` 会重登恰好一次）。
  管理员不给 Key 时只能走这条。但它有个上限要知道：
  **平台一旦开启登录验证码，这条链路就彻底失效**，除了换成 API Key 没有别的办法。

### 开始之前要知道的限制

- **端口配额是「线路级」的，不是账户级**，而且很小 —— 在这个功能所依据的账号上，
  是每条线路 30 个。聚合后的节点数通常远超这个数，所以节点选择是
  **手动勾选，不是"全都走中转"**。subagg 会在创建前本地预检配额，
  超了就告诉你是哪条线路满了。
- **账号不给的话，只能用直连转发。** 链式转发、自定义转发出口、入站代理
  都是账号/线路级能力。平台把它们关着时，subagg 只走 direct 直接转发 ——
  而"测试连接"会逐条列出你没有哪些能力。
- **有些节点会被刻意拒绝改写。** 只要改地址会逼 subagg 去猜一个伪装参数，
  它就不改、让节点保持直连：REALITY 没有显式 `sni`、Shadowsocks 带 obfs 插件、
  ShadowsocksR 用了需要 Host 的混淆、明文 gRPC，以及 UDP 系协议
  （Hysteria2 / TUIC / QUIC）落在不转发 UDP 的端口后面。每一条都会说明原因
  和下一步该怎么办。
- **UDP 是端口的属性。** 转发端口不转 UDP 时，节点的 UDP 能力会被**如实降级**，
  而不是留着让 UDP 流量进黑洞。

### 出问题时怎么退

两个开关，从轻到重：

- **单个 profile** —— 关掉这份 profile 的 IX 开关，重新拉一次订阅，立刻回直连。
- **全局总闸** —— 关掉某个中转商的总闸，**所有** profile 一起回直连。
  凌晨三点该按的是这个。

但平台挂了并不需要你去按任何开关。**生成订阅的过程零出站请求** ——
它只读本地映射表 —— 所以中转平台不可达、被限流、到期，都不会影响订阅正常下发。
不可用的映射会自然回落直连，原因逐节点出现在 `X-Subagg-IX` /
`X-Subagg-IX-Reason` 与界面上。

### 两个延迟不是一回事，别相加

- **节点页**上的延迟由 subagg 自己测：**本机 → 原落地，直连**。
  它打的是库里的地址，而库里永远是原始地址。
- **IX 映射**上的延迟由中转平台探测：**中转入口 → 原落地**。

两者量的是不同的区段，相加也不等于你的端到端延迟。subagg 把两个数字分开显示、
各自标注含义，不做任何推导 —— 与"界面上没有流量估算"是同一条原则。

### 关于凭据加密（信它之前先读这段）

中转商凭据（API Key、密码、缓存的 JWT）在落库前用 AES-256-GCM 加密，
密钥从 `ADMIN_TOKEN` 派生。

要把它的定位说清楚。它防的是**数据库文件单独离开这台机器**：备份同步进了网盘、
`data/subagg.db` 被误提交、排障时把库文件随手传给了别人。这些场景里密文走了，
而 `ADMIN_TOKEN`（在 `.env` 或 systemd 的 EnvironmentFile 里）没跟着走。
它**不防主机沦陷** —— 能读到库文件的攻击者通常也能读到 `.env`。
这层加密只是把门槛从"拿到文件"抬到"拿到文件**并且**拿到环境变量"。

代价是绕不开的，要提前有准备：**轮换 `ADMIN_TOKEN` 之后，已存的凭据永久解不开。**
这是算术结果，不是 bug。subagg 会优雅处理 —— 把该中转商标成"需重新录入"、
受影响的 profile 回落直连、服务不崩 —— 但你得把凭据重新输一遍。

### 相关配置

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `IX_SYNC_INTERVAL_HOURS` | `6` | 多久与平台对齐一次本地映射。**`0` 表示禁用后台同步**，那只会让状态不再刷新，订阅照常下发。上限 168。 |
| `IX_TIMEOUT_MS` | `15000` | 调平台 API 的单请求超时。它是外部服务，不能让它拖住调度器。范围 1000–120000。 |
| `IX_ORPHAN_THRESHOLD` | `5` | 连续几轮同步没在任何订阅源里见到某节点，就把它的映射标成孤儿。刻意不设成 `1`：上游偶发返回不完整列表很常见，漏一轮什么都说明不了。孤儿**只标记**，绝不自动删远端端口。范围 1–100。 |

不新增任何必填密钥：加密密钥从你已经有的 `ADMIN_TOKEN` 派生。

## 关于 Clash 与 Clash.Meta

原版 Clash 内核（Dreamacro 的 core，ClashX、Clash for Windows、Clash for Android
用的都是它）**不支持 VLESS、Hysteria2 和 TUIC**，Clash.Meta / mihomo 才支持。

subagg 会识别你用的是哪一种，并把内核处理不了的节点剔除掉 —— 因为把它们塞进去，
客户端会拒绝加载**整份配置**，而不只是忽略那几个节点。剔除的数量与原因通过
`X-Subagg-Skipped` 返回。所以如果发现节点变少了，多半是这个原因，
换一个基于 Meta 内核的客户端即可（Clash Verge Rev、Stash、FlClash 等）。

## subagg 做不到的事

**它测不出好友用了多少流量。**

好友的代理流量是从他的设备直连代理服务器的，根本不经过 subagg。这里唯一能观测到的，
是他的客户端**来拉订阅**这个动作 —— 所以界面上展示的正是这些：拉取次数、时间、
识别出的客户端，以及不同来源 IP 的数量（这是判断"链接是不是被转发了"的真实信号）。

界面上刻意**没有**任何"本月估算用量"之类的数字，因为那种数字只能是编的，
而一个编出来的数字比没有数字更糟 —— 用户会拿它当真去做决策。
要精确用量，请看代理服务商的后台。

## 项目结构

```
src/core/       纯函数层 —— 零 IO，完整单测覆盖
  parse/        各种订阅格式 → 统一节点模型
  filter.ts     规则引擎
  ix.ts         中转改写 —— 只换拨号地址，别的一律不动
  secret.ts     凭据加密（AES-256-GCM）
  emit/         节点模型 → 各客户端格式，以及协议能力矩阵
src/db/         SQLite 持久化
src/services/   抓取、同步、调度、渲染、中转编排
src/server/     HTTP：/sub/:token（公开）与 /api/*（需鉴权）
public/         零构建前端 —— 原生 ES module，无打包器
```

渲染管线是 `filter → ix → chain → emit`，这个顺序是硬约束而不是随手排的 ——
理由写在 `src/core/ix.ts` 的文件头注释里。

`core/` 层刻意不含任何 IO。协议解析与配置生成是 bug 最密集的地方，
把副作用挡在门外，每一条分支才都能被单测覆盖到。其中最重要的一组测试断言
`parseUri(emitUri(node)) === node` 对每种协议都成立 ——
URI 方言的差异靠人眼 review 是发现不了的。

## 开发

```bash
npm run lint
npm run typecheck
npm test
```

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)，尤其是准备新增输出格式或协议的话。

## 后续计划

v1 没做，但接口已经留好：

- sing-box JSON 输出（`emit/` 的结构就是为此准备的，加一个文件并注册即可）
- Surge / Quantumult X 输出
- 节点测速与按延迟排序
- 继承上游的 `rules` / `proxy-groups`

## 许可

[MIT](./LICENSE)
