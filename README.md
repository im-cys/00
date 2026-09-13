# 回答节点碰撞试用站

这是一个把同一问题下的不同回答拆成观点节点、对照节点并生成新问题的前端试用项目。网页、Node 服务、Python 抽取与碰撞代码已统一放在本目录，不再依赖两个旧代码子项目。

## 目录

```text
代码/
├─ web/                 页面、样式与前端交互
├─ server/              Node 静态服务、登录和互动接口
├─ extractor/           节点抽取、证据回查与碰撞服务
├─ scripts/             启停、测试和私有结构图导入
├─ private-data/        本地私有内容（被 Git 忽略）
├─ .env.example         配置模板
└─ package.json
```

## 本地运行

要求 Node.js 22+ 和 Python 3.11+。

1. 复制 `.env.example` 为 `.env`，按需填写模型配置。
2. 双击 `启动服务.cmd`，或执行 `npm start`。
3. 打开 `http://127.0.0.1:3210`。

需要完整碰撞链路时，双击 `启动自测环境.cmd`。它会同时启动 Python 碰撞服务和 Node 页面服务。

运行测试：

```powershell
npm test
python extractor/check_config.py
```

## 私有内容与 GitHub

试用问题和回答摘录位于 `private-data/data.js`。整个 `private-data/` 已写入 `.gitignore`，因此 `git add .` 不会把这些摘录、生成的回答节点、导入清单或其他真实流程数据提交到 GitHub。

仓库内的 `web/data.empty.js` 与 `web/collision-maps.empty.js` 只是无内容兜底。服务器按以下顺序加载：

1. `PRIVATE_DATA_DIR/data.js`，不存在时使用空白内容；
2. `PRIVATE_DATA_DIR/collision-maps.js`，不存在时使用空白节点图。

部署时请通过服务器文件复制、挂载目录或私有制品发布流程，把本机的 `private-data/data.js` 单独放到服务器。例如把它放在 `/srv/answer-collision-private/data.js`，并配置：

```dotenv
HOST=0.0.0.0
ALLOWED_HOSTS=example.com,www.example.com
ALLOWED_ORIGINS=https://example.com
PRIVATE_DATA_DIR=/srv/answer-collision-private
```

这样 GitHub 仓库不含摘录正文，部署后的网页仍能从服务器私有目录显示内容。不要把 `private-data` 复制进公开镜像层或公开构建产物；若使用容器，优先以只读 volume 挂载。

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
