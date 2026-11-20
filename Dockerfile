# HA 3D Plugin Studio — 图形化插件开发台
#
# 多阶段构建：
#   Stage 1  用 devDependencies（Vite）把 Vue 前端构建成 client/dist（js / css / html 已 minify）
#   Stage 2  只带 生产依赖 + 服务端源码（原样，方便进容器排查）+ 构建好的前端，数据全部走挂载卷：
#   /data    插件项目（projects/）+ 全局配置（config.json），升级/重启不丢
#
# 服务端**不做压缩**：镜像里保持 server/ 可读源码，报错栈行号与仓库一一对应，
# 排查问题直接 docker exec 看文件即可。前端由 Vite 构建时压好，无需额外处理。
#
# 运行配置（与 ha-3d-home 同款环境变量约定）：
#   PORT                   监听端口，默认 8098
#   HA3D_STUDIO_DATA_DIR   数据目录，容器内指向挂载点 /data

# ---------- Stage 1: 构建前端 ----------
FROM node:22-alpine AS client-build
WORKDIR /build

COPY client/package.json client/package-lock.json ./client/
RUN npm --prefix client ci --no-audit --no-fund

COPY client ./client
# Vite 构建本身就带 minify（js / css / html 都在这一步压好）
RUN npm --prefix client run build

# ---------- Stage 2: 运行层 ----------
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8098 \
    HA3D_STUDIO_DATA_DIR=/data

# 服务端生产依赖（package-lock 锁版本）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# 服务端源码（原样，不压缩）+ Stage 1 构建好的前端（Vite 已 minify）
COPY server ./server
COPY --from=client-build /build/client/dist ./client/dist

RUN mkdir -p /data

VOLUME ["/data"]
EXPOSE 8098

CMD ["node", "server/index.js"]
