# 参与贡献

感谢有兴趣改进 subagg。这份文档说明如何上手，以及本项目在代码上的几条硬约定。

## 快速开始

```bash
git clone https://github.com/your-org/subagg.git
cd subagg
npm install

cp .env.example .env
# 生成必填的两个密钥
echo "ADMIN_TOKEN=$(openssl rand -hex 32)" >> .env
echo "IP_HASH_SALT=$(openssl rand -hex 16)" >> .env

npm run dev        # tsx watch，起在 127.0.0.1:8787
```

提交前请确保三件事通过：

```bash
npm run lint
npm run typecheck
npm test
```

CI 会在 Node 20 与 22 上跑同样的检查。

## 项目结构与分层约定

```
src/core/       纯函数层：零 IO、完全可单测
src/db/         数据持久化
src/services/   业务编排：抓取、同步、调度、渲染
src/server/     HTTP 层
public/         零构建前端（原生 JS，不要引入打包器）
```

**最重要的一条约定：`src/core/` 里不允许出现任何 IO。**

不读文件、不发网络请求、不碰数据库、不读环境变量、不看时钟（需要时间就作为参数传进来）。
这一层是整个项目正确性的地基——协议解析和格式生成的每一个分支都能被单测覆盖，
代价仅仅是"把副作用挡在门外"。如果你发现某个 core 函数需要 IO，说明它应该被拆成
一个纯函数 + 一个 services 层的调用方。

（`node:crypto` 的哈希函数是例外——它是纯计算，没有副作用，`fingerprint.ts` 用它算节点指纹。）

## 新增一种客户端输出格式

这是最常见的贡献类型。以加入 sing-box 为例：

1. **`src/core/emit/capability.ts`** — 在能力矩阵里登记新目标支持哪些协议与传输层。
   请如实填写：漏填会导致节点被静默跳过，误填会导致生成出客户端无法解析的配置。
2. **`src/core/emit/singbox.ts`** — 实现 `Emitter` 接口，返回 `{ body, contentType, skipped[] }`。
   遇到矩阵中不支持的节点，**记入 `skipped` 并附原因，不要静默丢弃**。
3. **`src/core/emit/index.ts`** — 注册到 `EMITTERS` 表，并在 `UA_PATTERNS` 里加上
   对应客户端的 User-Agent 特征。
4. **`test/emit/singbox.test.ts`** — 至少覆盖：每种协议各一个节点、一个不支持的节点
   （断言它出现在 `skipped` 里）、空节点集。

## 新增一种协议解析

1. **`src/core/types.ts`** — 在 `ProxyNode` 判别联合里加分支。
2. **`src/core/parse/uri.ts`** — 加解析函数并注册到 scheme 分发表。
3. **`src/core/emit/uri.ts`** — 加对应的序列化函数。
4. **`test/parse/roundtrip.test.ts`** — **必须**加往返用例。

### 关于往返测试

本项目最核心的质量保障是往返等价：

```ts
parseUri(emitUri(node)) 在语义上等于 node
```

协议 URI 的各种方言差异（vmess 的 base64-JSON、ss 的 SIP002、Reality 的参数命名）
是这类工具出 bug 最密集的地方，而往返测试能一次性覆盖解析与生成两侧。
新增协议时请务必补上。

## 代码风格

- TypeScript `strict` 全开，包含 `noUncheckedIndexedAccess`。数组下标访问会返回
  `T | undefined`，请显式处理，不要用 `!` 一把梭。
- 用 `import type` 导入类型（`verbatimModuleSyntax` 已开启，混用会报错）。
- **注释写"为什么"，不写"是什么"。** 代码已经说明了它在做什么；注释应该解释
  为什么要这么做——尤其是那些看起来多余、实则是在绕开某个客户端方言差异的分支。
- 中文注释与英文注释都可以，跟随所在文件的既有风格。

## 提交信息

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat(emit): add sing-box output target
fix(parse): handle ss SIP002 URIs without a plugin parameter
docs(readme): clarify the traffic measurement limitation
test(parse): add vmess round-trip cases for gRPC transport
```

## 提交 PR 前的自检

- [ ] `npm run lint && npm run typecheck && npm test` 全绿
- [ ] 新增/修改的 core 逻辑有对应单测
- [ ] 涉及协议改动的，往返测试已补
- [ ] 没有把真实的订阅 URL、UUID、密码写进代码或 fixture（**请务必检查**，
      test fixture 里的凭据必须是编造的或已脱敏的）
- [ ] 面向用户的行为变更已更新 README 与 CHANGELOG

## 报告问题

提 issue 时请附上：subagg 版本、Node 版本、客户端及其版本、复现步骤。

**贴日志或配置前请先脱敏**——去掉订阅 URL、UUID、密码和 token。
如果是"某客户端导入失败"类问题，把该客户端的 User-Agent 一并贴上会非常有帮助。

安全漏洞请勿走公开 issue，见 [SECURITY.md](./SECURITY.md)。

## 许可

提交贡献即表示同意你的代码以 [MIT 许可证](./LICENSE) 发布。
