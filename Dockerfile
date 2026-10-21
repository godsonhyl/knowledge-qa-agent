# 知识问答 Agent TS —— Docker 镜像（本地预构建版）
# 构建环境无法访问 npm 公网：宿主机先 npm run build 产出 dist/，
# 镜像只 COPY dist + node_modules（含全部依赖），运行即用。
#
# 宿机构建步骤：
#   npm install && npm run build:web && npm run build:server
#   docker compose build && docker compose up -d

FROM node:22-alpine
LABEL org.opencontainers.image.title="knowledge-qa-agent-ts" \
      org.opencontainers.image.description="TS 重构版：Hono + React + Qdrant 混合检索的可溯源问答 Agent" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    SSLCERT_DIR=/app/sslcert

WORKDIR /app
COPY dist ./dist
COPY node_modules ./node_modules
COPY package.json ./
COPY sslcert ./sslcert

# sslcert 由构建装入；确保 node 用户可读（key.pem 原为 root 600）
RUN chown -R node:node /app/sslcert && chmod 600 /app/sslcert/key.pem || true

# 备份目录：清空前自动导出快照。挂载宿目录覆盖即可持久化。
RUN mkdir -p /app/backups && chown -R node:node /app/backups
ENV BACKUP_DIR=/app/backups

USER node
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
