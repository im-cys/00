# 知乎「回答节点碰撞」站点
# 单容器运行 Node 页面服务（对外）与 Python AI 服务（仅本机回环）
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-requests \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 私有内容不会复制进镜像；线上由受保护接口写入 PostgreSQL。
COPY . .

# PORT 必须与云托管监听端口一致。
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    COLLIDE_HOST=127.0.0.1 \
    COLLIDE_BASE=http://127.0.0.1:3311 \
    PRIVATE_DATA_DIR=/app/private-data

# 放行云托管探针使用的容器内网 Host；Origin 仍由应用单独检查。
ENV ALLOWED_HOSTS=*

EXPOSE 3000

CMD ["sh", "-c", "(python3 extractor/collide_service.py --port 3311 || echo '[warn] 碰撞服务未启动，页面服务继续运行') & exec node server/server.mjs"]
