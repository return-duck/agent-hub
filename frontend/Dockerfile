# 前端镜像（独立部署单元之一）：构建成静态资源，由 nginx 托管并把 /api 反代到 server
#
# ⚠️ 本文件未经实际构建验证：开发环境没有 Docker（见 README 的部署声明）。
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
