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

# PORT 必须与云托管「服务配置 → 监听端口」一致，否则存活/就绪探针连不上，
# 部署会以 Readiness/Liveness probe failed: connection refused 失败。
# 当前云托管服务配置的是 3000，这里保持一致。
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    COLLIDE_HOST=127.0.0.1 \
    COLLIDE_BASE=http://127.0.0.1:3311 \
    PRIVATE_DATA_DIR=/app/private-data

# 服务端有 Host 头白名单（server/config.mjs），默认只放行 127.0.0.1/localhost。
# 探针用容器内网 IP 直连，Host 头不是域名，不放开会被 403 拦掉。
ENV ALLOWED_HOSTS=*

EXPOSE 3000

# Python 碰撞服务后台常驻，Node 服务用 exec 接管 PID 1 以正确接收停止信号。
# 碰撞服务即使因缺少私有数据而异常退出，也不影响 Node 页面服务对外提供健康检查。
CMD ["sh", "-c", "(python3 extractor/collide_service.py --port 3311 || echo '[warn] 碰撞服务未启动，页面服务继续运行') & exec node server/server.mjs"]
