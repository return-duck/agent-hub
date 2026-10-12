# 运行时镜像（独立部署单元之一）
#
# ⚠️ 本文件未经实际构建验证：开发环境没有 Docker（见 README 的部署声明）。
#    非容器形态的启动方式已完成端到端验证（scripts/dev.sh）。
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# 以非 root 运行
USER node
EXPOSE 8090
ENV RUNTIME_HOST=0.0.0.0
ENV RUNTIME_PORT=8090
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
