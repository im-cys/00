# 腾讯云 CloudBase 部署清单

本文对应当前架构：GitHub `main` 只保存代码，知乎数据通过受保护接口写入 CloudBase PostgreSQL，网页再从数据库读取。

## 1. 初始化 PostgreSQL

在 CloudBase「SQL 型数据库 → SQL 编辑器」中打开 `public` schema，复制并执行 [`database/schema.sql`](../database/schema.sql) 全部内容。执行后应出现以下表：

- `private_datasets`、`answer_maps`、`collision_cache`
- `discoveries`、`discovery_comments`
- `app_users`、`app_sessions`、`oauth_states`
- `answer_actions`、`answer_map_events`、`answer_comments`

表不直接授权给浏览器的 `anon` / `authenticated` 角色；读写统一经过云托管后端。

## 2. 配置云托管环境变量

在服务 `zhihu-social-demo` 的环境变量中添加：

```dotenv
CLOUDBASE_USE_DATABASE=true
CLOUDBASE_ENV_ID=<完整环境 ID>
CLOUDBASE_APIKEY=<CloudBase PostgreSQL API Key，对应 service_role>
CLOUDBASE_SECRETID=<腾讯云 SecretID>
CLOUDBASE_SECRETKEY=<腾讯云 SecretKey>
CLOUDBASE_DB_INSTANCE=default
CLOUDBASE_DB_SCHEMA=public
EXTRACT_BASE_URL=https://api.openai-next.com/v1
EXTRACT_MODEL=deepseek-v4-pro
EXTRACT_API_KEY=<你的模型 Key>

ZHIHU_OAUTH_APP_ID=<OAuth AppID>
ZHIHU_OAUTH_APP_KEY=<OAuth AppKey>
ZHIHU_ACCESS_SECRET=<Access Secret>
ZHIHU_OAUTH_REDIRECT_URI=https://zhihu-social-demo-302050-11-1344805741.sh.run.tcloudbase.com/auth/zhihu/callback

DATA_IMPORT_TOKEN=<至少 32 字节的随机值>
ALLOWED_HOSTS=*
```

`CLOUDBASE_SECRETID` / `CLOUDBASE_SECRETKEY` 与控制台“接入指引 → 后端框架 → Node.js”一致，用于腾讯云管理接口鉴权；PostgreSQL 表读写还必须配置准确命名的 `CLOUDBASE_APIKEY`，它对应数据库 `service_role`。代码在两者同时存在时优先使用数据库 API Key。`CLOUDBASE_DB_SCHEMA` 对应 PostgreSQL schema；控制台查询 `current_schema()` 为 `public` 时保持默认值即可。所有服务端凭据都绝不能提交到 GitHub、发送到前端或出现在截图中。`ZHIHU_ACCESS_SECRET` 当前不参与登录，仅为后续调用知乎内容数据接口预留。

`DATA_IMPORT_TOKEN` 可在本机 PowerShell 生成：

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

不要把上述真实值写入 `.env.example`、GitHub Actions 日志或截图。

## 3. 在知乎应用后台登记 OAuth 地址

三个地址分别表示：

- 授权入口：本站把浏览器送到知乎，固定为 `https://openapi.zhihu.com/authorize`。
- 换令牌接口：后端用一次性授权码换 access token，固定为 `https://openapi.zhihu.com/access_token`。
- 用户资料接口：后端用 access token 读取登录用户资料，固定为 `https://openapi.zhihu.com/user`。

这些官方接口已内置，不需要你在控制台填写。你真正需要在知乎 OAuth 应用后台登记的是回调地址：

```text
https://zhihu-social-demo-302050-11-1344805741.sh.run.tcloudbase.com/auth/zhihu/callback
```

它必须与云托管环境变量 `ZHIHU_OAUTH_REDIRECT_URI` 完全一致，包括协议、域名、路径且不要多一个尾部 `/`。

服务只支持真实的知乎 OAuth 授权登录；AppID、AppKey 或回调地址缺失时，登录页会直接提示配置不完整。

## 4. 部署后导入私有数据

每次部署包含数据库结构变更的版本前，先在 CloudBase SQL 控制台重新执行一次 [`database/schema.sql`](../database/schema.sql)。脚本可重复执行；本版本会新增 `daily_collision_attempts`，用于从服务端强制限制每位用户每天最多 10 次碰撞，失败尝试同样计数。

在本机仓库根目录创建 `.env`，只写：

```dotenv
DATA_IMPORT_TOKEN=<与云托管完全相同的值>
```

部署成功后执行：

```powershell
npm run import:data -- --url https://zhihu-social-demo-302050-11-1344805741.sh.run.tcloudbase.com --data "..\代码\private-data\data.js" --maps "..\代码\private-data\collision-maps.js"
```

如果没有现成结构图，删除 `--maps` 参数。原始数据只从本机通过 HTTPS 发往你的后端并写入 PostgreSQL，不进入 Git。以后数据有变化，重复运行即可覆盖主数据；已有结构图会按回答正文摘要判断是否仍可复用。

## 5. 验收顺序

1. 打开 `/api/health`，确认 `database: true`、`model: deepseek-v4-pro`。
2. 导入数据后刷新首页，确认不再显示“内容数据尚未配置”。
3. 在退出登录状态下打开首页，浏览器应直接进入知乎授权；授权完成后回到原页面。
4. 选择一篇无结构图的回答，确认页面先显示生成中，随后轮询取得结构图并写入 `answer_maps`。
5. 碰撞同一对节点两次，确认第二次使用 `collision_cache`。
6. 发布问题条目并评论，换浏览器打开后仍能看到，确认数据来自公共数据库而非 localStorage。
