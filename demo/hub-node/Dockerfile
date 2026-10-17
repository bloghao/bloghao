# 广场 hub 演示镜像：plaza Workers 代码零改动跑进 Node（D1→node:sqlite）
# 构建上下文 = demo/hub-node/：docker build -t plaza-hub .
FROM node:26-alpine
WORKDIR /app
COPY dist/server.js ./dist/server.js
COPY public/ ./public/
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8790 HUB_DB=/data/plaza.db HOST=0.0.0.0 TRUST_PROXY=proxy
USER node
EXPOSE 8790
CMD ["node", "dist/server.js"]
