# xwblog 自托管 POC 镜像：一个进程按域名跑多个完全独立的博客租户。
# 构建上下文必须是仓库根目录：
#   docker build -f docker-poc/Dockerfile -t xwblog-poc .
#
# 产物只有 node:26-alpine + 一个打包后的 server.js + public/（约 70MB）：
# - 无任何原生模块：SQLite 用 Node 内置的 node:sqlite，无需 better-sqlite3 编译
# - schema.sql / 主题 CSS 已在打包时内联（--loader 文本导入，与 Workers Text 规则同口径）

FROM node:26-alpine AS build
WORKDIR /app
# 运行时依赖只有 hono（root package.json 的 dependencies）：装到 /app/node_modules，
# esbuild 从 src/ 向上解析刚好命中——docker-poc/node_modules 不在 src 的解析链上
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY docker-poc/package.json ./docker-poc/
RUN cd docker-poc && npm install --no-audit --no-fund
COPY src/ ./src/
COPY public/ ./public/
COPY schema.sql ./
# COPY 对目录是「拷内容、不拷目录本身」，shims 必须显式落到 ./docker-poc/shims/
# server/control/scheme 三个入口文件逐个列全——server.ts 新增兄弟模块时记得同步这里
COPY docker-poc/server.ts docker-poc/control.ts docker-poc/scheme.ts ./docker-poc/
COPY docker-poc/shims/ ./docker-poc/shims/
RUN cd docker-poc && npm run build

FROM node:26-alpine
WORKDIR /app
# 保持 docker-poc/dist 的目录层级，server.js 的相对默认路径（../../public、../tenants.json）与本地一致
ENV NODE_ENV=production PORT=8787 \
    TENANTS_DIR=/data/tenants \
    TENANTS_CONFIG=/app/docker-poc/tenants.json \
    PUBLIC_ROOT=/app/public
COPY --from=build /app/docker-poc/dist/server.js ./docker-poc/dist/server.js
COPY docker-poc/tenants.json ./docker-poc/tenants.json
COPY public/ ./public/
# 预建数据目录并归 node：named/匿名卷首次挂载会继承这里的属主；
# Linux bind mount 的 root 属主目录由 entrypoint.sh 在运行期修正
RUN mkdir -p /data/tenants && chown node:node /data/tenants \
    && apk add --no-cache su-exec
COPY --chmod=0755 docker-poc/entrypoint.sh /usr/local/bin/entrypoint.sh
VOLUME /data/tenants
EXPOSE 8787
# 不用 USER node：entrypoint 以 root 起步修属主后经 su-exec 降权，应用进程非 root
ENTRYPOINT ["entrypoint.sh"]
CMD ["node", "docker-poc/dist/server.js"]
