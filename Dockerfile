# 知乎「回答节点碰撞」站点
# 单容器内同时运行 Node 页面服务（对外）与 Python 碰撞服务（仅本机回环）
#
# 说明：
# - Node 服务用 Node 22（server/config.mjs 使用 node:util 的 parseEnv，需 Node 20.12+ / 22）。
# - Python 碰撞服务只依赖标准库，无需 pip install；bookworm-slim 自带 python3.11。
# - 项目本身没有任何 npm 依赖，因此不需要 npm install。

FROM node:22-bookworm-slim

# Python 3.11（供 extractor/collide_service.py 使用）
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先只复制代码，私有内容（private-data）刻意不打包进镜像
COPY . .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=80 \
    COLLIDE_HOST=127.0.0.1 \
    COLLIDE_BASE=http://127.0.0.1:3311 \
    PRIVATE_DATA_DIR=/app/private-data

# 服务端有 Host 头白名单（server/config.mjs），默认只放行 127.0.0.1/localhost。
# 云托管的访问域名事前不确定，不放开会直接返回 403 Host denied。
# 介意的话，改成在云托管控制台把 ALLOWED_HOSTS 设为你绑定的实际域名。
ENV ALLOWED_HOSTS=*

EXPOSE 80

# Python 碰撞服务后台常驻，Node 服务用 exec 接管 PID 1 以正确接收停止信号
CMD ["sh", "-c", "python3 extractor/collide_service.py --port 3311 & exec node server/server.mjs"]
