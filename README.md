# 回答节点碰撞试用站

这是一个把同一问题下的回答拆成完整观点树、选择末层观点进行碰撞并生成新问题的试用项目。Node 后端通过 CloudBase SDK 使用 PostgreSQL；Python 服务调用 OpenAI 兼容模型生成结构图与碰撞问题。

## 目录

```text
代码/
├─ web/                 页面、样式与前端交互
├─ server/              Node 静态服务、登录和互动接口
├─ extractor/           节点抽取、证据回查与碰撞服务
├─ scripts/             启停、测试和私有结构图导入
├─ database/            PostgreSQL 建表脚本
├─ docs/                CloudBase 部署清单
├─ private-data/        本地私有内容（被 Git 忽略）
├─ .env.example         配置模板
└─ package.json
```

## 本地运行

要求 Node.js 22+ 和 Python 3.11+。

1. 复制 `.env.example` 为 `.env`，按需填写模型配置。
2. 将本地回答数据放在 `private-data/data.js`。
3. 执行 `npm run dev`，或双击 `启动本地环境.cmd`。
4. 打开 `http://127.0.0.1:3210`。

`npm run dev` 会同时启动 Python 生成服务和 Node 页面服务，使用本地文件存储，不读写 CloudBase。结束时执行 `npm run dev:stop`。

## 临时多账号测试登录

为验证不同账号之间的发布、评论、点赞和数据持久化，登录页临时提供「用户名 + 密码」的创建与登录入口，同时保留知乎 OAuth。密码使用 scrypt 加盐哈希存储，不保存明文。

开关为 `TEST_PASSWORD_AUTH_ENABLED`；当前测试阶段默认开启。测试结束后先在环境变量中设为 `false`，再移除以下临时内容：

- `/api/auth/test/register` 与 `/api/auth/test/login`；
- `server/test-auth.mjs` 和登录页的测试表单；
- PostgreSQL `test_accounts` 表。

真实环境首次部署前需执行更新后的 [`database/schema.sql`](database/schema.sql)，否则 CloudBase 无法创建测试账号。

启动脚本只从当前新版项目的 `private-data/data.js` 导入回答数据，并可从 `private-data/.env` 读取本地模型配置，不再扫描或依赖同级旧代码目录。也可显式指定：

```powershell
.\scripts\start.ps1 -DataFile "D:\path\to\data.js" -MapsFile "D:\path\to\collision-maps.js" -ModelEnv "D:\path\to\.env"
```

运行测试：

```powershell
npm test
python extractor/check_config.py
```

文章拆解使用 `answer-tree-v2`：用户能看到从唯一总观点到可碰撞叶子的完整树，叶子下的支撑材料默认隐藏并可定位原文。实现约束和验收项见 [`docs/ANSWER_TREE_V2.md`](docs/ANSWER_TREE_V2.md)。没有模型配置时，可以用本地回归样例检查完整链路：

```powershell
python extractor/preview_answer_tree.py --input "<回答样本.json>" --answer-id q6_a9 --mock "<本地模型输出.json>"
```

## 私有内容与 GitHub

试用问题和回答摘录位于 `private-data/data.js`。整个 `private-data/` 已写入 `.gitignore`，因此 `git add .` 不会把这些摘录、生成的回答节点、导入清单或其他真实流程数据提交到 GitHub。

仓库内的 `web/data.empty.js` 与 `web/collision-maps.empty.js` 只是无内容兜底。服务器按以下顺序加载：

1. `PRIVATE_DATA_DIR/data.js`，不存在时使用空白内容；
2. `PRIVATE_DATA_DIR/collision-maps.js`，不存在时使用空白节点图。

云端不再依赖容器内文件。部署后运行 `npm run import:data`，私有内容会通过带令牌的 HTTPS 接口写入 PostgreSQL。GitHub 仓库、Docker 镜像和构建日志均不包含正文。完整步骤见 [`docs/CLOUDBASE_DEPLOY.md`](docs/CLOUDBASE_DEPLOY.md)。

## 重新生成真实节点数据

当前仓库和本地私有目录中的旧回答节点图已清空，前端公共节点状态也使用了新的空存储命名空间。准备好私有输入后：

1. 将抽取输入和产物放到 `PRIVATE_DATA_DIR/COLLISION_DATA_DIR` 指定的目录；
2. 使用 `extractor/` 中的流程生成回答节点；
3. 执行 `npm run import:maps`；
4. 结果写入 `private-data/collision-maps.js`，复核清单写入 `private-data/map-manifest.json`。

这些文件仍不会进入 Git。公共节点则只会在用户真实完成碰撞并公开之后出现，不再预置演示条目。

## 上传前检查

```powershell
git status --short
git check-ignore -v .env private-data/data.js private-data/collision-maps.js
npm test
```

请同时确认实际部署与展示摘录内容已取得必要授权；技术隔离只能避免内容进入公开源码仓库，并不替代内容许可。
