# 观点分身独立网页原型

这是“观点分身”的独立网页交互原型。当前包含产品介绍首页、个人中心和回答代理对话页；注册、AI 回复与数据存储均为本地演示实现。

## 文件职责

| 文件 | 负责什么 | 与谁协作 |
| --- | --- | --- |
| `index.html` | 产品首页、个人中心外壳、注册弹窗和手动导入回答弹窗 | 由 `app.js` 控制，使用 `styles.css` |
| `app.js` | 首页/个人中心切换、五个业务视图、原型注册、观点与对话本地数据 | 创建会话后跳转到 `study.html`；与 `study.js` 共享本地数据键 |
| `study.html` | 回答代理对话页的三栏页面结构与成果弹窗 | 由 `study.js` 控制，使用 `styles.css` |
| `study.js` | 加载会话、模拟代理回复、整理观点线索、确认长期记忆 | 读取 `app.js` 创建的会话；把确认观点写回主网页 |
| `styles.css` | 两个页面共用的颜色、布局、组件、代理球和响应式样式 | 同时服务 `index.html` 与 `study.html` |
| `server.mjs` | 提供页面、静态资源、别名路由和健康检查接口 | 由 `npm start` 启动 |
| `package.json` | 项目名称、Node 版本要求和启动命令 | `npm start` 会运行 `server.mjs` |
| `extension/` | Chrome / Edge 扩展：跨页悬浮球、回答选择、自由悬浮窗与后端通信 | 调用 `server.mjs` 的回答代理接口 |
| `viewpoint-agent-extension.zip` | 提供给内测用户下载的扩展压缩包 | 网页安装弹窗通过 `/downloads/viewpoint-agent-extension.zip` 下载 |

## 页面关系

```text
index.html
  ├─ 产品介绍首页
  └─ 个人中心
      ├─ 概览
      ├─ 我的代理
      ├─ 观点记忆
      ├─ 对话记录
      └─ 创作草稿
             │
             └─ 手动导入问题与回答
                       │
                       ▼
                   study.html
                       ├─ 原回答来源
                       ├─ 回答代理对话
                       ├─ 本轮观点线索
                       └─ 观点确认与回复草稿
```

## 当前数据流

```text
app.js 创建会话
→ 保存到 localStorage: viewpointAgentSessions
→ 跳转 /study?id=<会话ID>
→ study.js 读取并更新会话
→ 用户确认观点
→ 写入 localStorage: viewpointAgentMemories
→ 返回个人中心的观点记忆页
```

当前使用三个本地存储键：

- `viewpointAgentUser`：原型用户；
- `viewpointAgentSessions`：回答代理会话；
- `viewpointAgentMemories`：已确认和待确认的观点。

这些数据只适合交互原型。接入正式后端后，应由账户隔离的数据库和 API 替换。

## 本地运行

```powershell
npm start
```

然后访问：

- 产品首页：`http://127.0.0.1:3000/`
- 无账号演示个人中心：`http://127.0.0.1:3000/dashboard`
- 回答代理演示：`http://127.0.0.1:3000/study?id=remote-work`
- 服务检查：`http://127.0.0.1:3000/api/health`
- 扩展测试包：`http://127.0.0.1:3000/downloads/viewpoint-agent-extension.zip`

## 仍是模拟实现的部分

- 注册与登录；
- AI 回答代理回复；
- 观点总结与回复草稿生成；
- 云端数据库与跨设备同步；
- 浏览器扩展与网页账户的数据同步；
- Chrome Web Store 与 Microsoft Edge Add-ons 正式发布。

下一阶段接入真实能力时，优先保持页面结构不变，用后端 API 替换 `localStorage` 和 `generateAgentReply()`。

> 更新：浏览器扩展 MVP 已加入 `extension/`，Chrome 与 Edge 共用同一份 Manifest V3 代码。0.3 版支持常驻悬浮球、工作台首页、多条未完成会话缓存、跨页恢复、隐藏式会话切换、八方向缩放和回答原文折叠；同一浏览器内可把缓存映射到本地网页面板，真正的云端账号同步和 AI 模型仍需后端支持。具体说明见 `extension/README.md`。
