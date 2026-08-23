# ─────────────────────────────────────────────────────────────
#  subagg — 多阶段构建
#
#  better-sqlite3 是原生模块。多数平台有预编译产物可直接下载，
#  但构建阶段仍装上 python3/make/g++ 以便在没有预编译包的架构上回退到源码编译。
#  运行阶段不带这些工具链，镜像保持精简。
# ─────────────────────────────────────────────────────────────

# ---------- 构建阶段 ----------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 先只拷贝清单，让依赖层能被 Docker 缓存复用
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# 裁剪出仅含生产依赖的 node_modules
RUN npm prune --omit=dev


# ---------- 运行阶段 ----------
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DB_PATH=/data/subagg.db

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
# 前端是零构建的静态资源，直接拷贝原文件
COPY public ./public

# 数据卷：SQLite 里存的是代理凭据，必须持久化到宿主机
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 8787

# 健康检查打的是无需鉴权的 /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
