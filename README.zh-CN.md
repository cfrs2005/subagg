<div align="center">

# subagg

**自托管的代理订阅聚合管理器。**

一条链接，客户端要什么格式就给什么格式。

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
     ▼
  https://你的域名/sub/<token>
     │
     ├─ Clash 来拉        → 带分组与规则的 YAML
     ├─ Shadowrocket 来拉 → base64 URI 列表
     └─ v2rayN 来拉       → base64 URI 列表
```

格式由客户端的 `User-Agent` 自动判定。想强制指定就加 `?target=clash.meta`。

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
| `X-Subagg-Warning` | 其他需要你知道的信息 |

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
  emit/         节点模型 → 各客户端格式，以及协议能力矩阵
src/db/         SQLite 持久化
src/services/   抓取、同步、调度、渲染
src/server/     HTTP：/sub/:token（公开）与 /api/*（需鉴权）
public/         零构建前端 —— 原生 ES module，无打包器
```

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
