# dsh-webapi (@dsh-external/dsh-web-service)

[English](README.md) | **中文**

把 DeepSeek Harness 通过 HTTP 开放出来：DSH 里的工作区、会话、模型、设置、技能与文件直接变成
REST 接口与 SSE 流，再加一个 OpenAI 兼容的 `/chat/completions`，现成的 OpenAI 客户端不用改就能接到 DSH。

典型用法：给 DSH 做一个自托管控制台、桌面或移动端客户端、驱动 Agent 的 CI/自动化流程、
把 DSH 当成工具调用的其它 Agent，或在 DSH 前面再包一层自己的 API 网关。

- **零新增依赖**：插件只 `inject` `webServer` 与 `tools`，路由挂在 DSH 宿主的 webserver 上（也可选独立端口）。
- **47 条路由**（REST + SSE），内置 OpenAPI 3.0 规范与在线调试页。
- **自带 SKILL**：`skills/dsh-web-service/SKILL.md` 教会 DSH 里的 Agent 调用本 API（流式、中止、
  回答挂起问题、上传文件等）。

## 安装

兼容 DSH `0.1.0`–`0.1.9`（peer 范围见 `package.json`，已在 `0.1.7-rc.2` 上运行验证）。

**方式一：预构建 tarball（推荐，免构建、免 `allowBuilds` 授权）**

```bash
dsh plugin --profile web add \
  https://github.com/toddpan/dsh-webapi/releases/latest/download/dsh-web-service.tgz
```

`dsh plugin` 会把该包写进 profile 的 `package.json`（依赖 + `dsh.profile.bundles`）；
带 HMR 的 profile 会立即装配，否则重启 DSH 生效。探活：

```bash
curl -s http://127.0.0.1:3080/api/v1/system/status   # {"ok":true,...}
curl -sI http://127.0.0.1:3080/api/v1/docs           # HTTP/1.1 200 OK
```

> **升级提示。** 资产名不带版本号，`latest/download/dsh-web-service.tgz` 对**全新安装**永远指向最新构建；
> 但包管理器可能复用该 URL 的旧解析结果。要把已有安装切到确定版本，用带版本号的资产：
> `dsh plugin --profile web add https://github.com/toddpan/dsh-webapi/releases/download/v0.1.11/dsh-web-service-0.1.11.tgz`

**方式二：从源码构建**（需要一份 DSH 源码 checkout）

```bash
git clone https://github.com/toddpan/dsh-webapi && cd dsh-webapi
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh     # src/ → lib/
dsh plugin --profile web add "$PWD"
```

`lib/` 是构建产物、不入库，**所以从 git 直接安装拿不到可运行代码**——请用方式一，或先自行构建。
`scripts/build.sh` 会从 checkout 软链 `cordis` / `schemastery` / `@deepseek-ai/*` 等 peer，无需 `npm install`。

## 配置

全部可选，装好后写在 profile patch 的插件行 `config` 里（默认值见 `src/index.ts`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `pathPrefix` | `/api/v1` | 路由前缀 |
| `apiKey` | `''` | 非空则开启鉴权，请求需带该 key |
| `standalonePort` | `0` | `>0` 时额外独立监听端口；`0` 表示只挂主 webserver |
| `cors` | `true` | 是否允许跨域 |
| `defaultCwd` | `''` | 默认工作目录，留空取 `process.cwd()` |
| `maxUploadBytes` | `2 GiB` | 上传大小上限，大文件建议走分片接口 |

## 功能特性

1. **工作区管理 (Workspaces)**：添加、删除、修改、查询工作区及其关联会话。
2. **会话管理 (Sessions)**：添加、删除/归档、修改标题/模型、列表查询及消息历史记录分页。
3. **设置与模型管理 (Models & Settings)**：查询可用模型列表、提供方列表、获取与修改系统全局默认模型配置。
4. **会话流式交互 (Streaming)**：
   - `POST /sessions/:id/prompt-stream`：基于 Server-Sent Events (SSE) 实时推送 `delta`、`reasoning`、`tool_call`、`tool_result` 与 `turn_end`。
   - `GET /sessions/:id/events`：会话底层事件总线实时广播监听通道。
5. **OpenAI 兼容协议**：
   - `POST /chat/completions`：支持标准 OpenAI 客户端调用（兼容 `stream: true/false`）。
6. **交互式 Web UI 文档 & OpenAPI 规范**：
   - 内置交互式 API 测试面板：`GET /api/v1/docs`
   - OpenAPI 3.0 规范：`GET /api/v1/openapi.json`
7. **交互式会话**：读取挂起的 `ask_user_question` 问题并经 REST 作答、中止正在跑的轮次、
   上传/列出/下载工作区文件（含分片续传上传）。

## API 路由汇总

默认基础前缀：`/api/v1`

| 模块 | 方法 | 路径 | 说明 |
|---|---|---|---|
| **System** | `GET` | `/system/status` | 系统状态、在线模型及端口信息 |
| **Workspaces** | `GET` | `/workspaces` | 查询工作区列表 |
| | `POST` | `/workspaces` | 创建/添加工作区 |
| | `GET` | `/workspaces/:id` | 获取工作区详情 |
| | `PUT` | `/workspaces/:id` | 修改工作区标题 |
| | `DELETE` | `/workspaces/:id` | 删除工作区绑定 |
| | `GET` | `/workspaces/:id/sessions` | 查询工作区下的会话 |
| **Sessions** | `GET` | `/sessions` | 查询会话列表 (支持搜索和工作区过滤) |
| | `POST` | `/sessions` | 创建新会话 |
| | `GET` | `/sessions/:id` | 查询单个会话详情与状态 |
| | `PUT` | `/sessions/:id` | 修改会话 (标题/模型) |
| | `DELETE` | `/sessions/:id` | 删除/归档会话 |
| | `GET` | `/sessions/:id/history` | 分页查询会话历史消息 |
| | `GET` | `/sessions/:id/stats` | 会话实时统计：轮/步、LLM 与工具调用耗时、首 token 均值、解码吞吐、缓存命中、token 账本（对齐 harness session-stats 投影语义） |
| | `GET` | `/sessions/:id/todos` | 会话任务清单 + 运行时长：`todos[{content,status}]`（`todo_write` 整表投影，`turn/start` 清空）、`counts{completed,inProgress,pending}`、`running`/`elapsedMs`（当前或最后一轮 turn 墙钟）、`turnStartedAt`/`turnEndedAt`/`updatedAt`（供三方控制台渲染「任务」面板，≥0.1.8） |
| | `GET` | `/sessions/:id/skills` | 会话作用域技能目录（按会话 cwd 解析技能根，支持 `?search=` 过滤；供输入框 "/" 技能候选，对齐 harness skills/list） |
| | `GET` | `/sessions/:id/questions` | 查询会话当前挂起的 ask_user_question 问题批次（REST 集成的宿主侧答复桥，≥0.1.7；含 connection 层抢答绕过与 ALS 会话归属） |
| | `POST` | `/sessions/:id/answers` | 提交挂起问题的答复（`answers: [{id, selected, custom?}]`），resolve 后工具以普通 tool/result 返回、会话继续 |
| | `POST` | `/sessions/:id/cancel` | 中止会话轮次 |
| | `POST` | `/sessions/:id/files` | 上传文件到会话工作区 (multipart 多文件 或 raw+?filename=)；同名自动 -1/-1 去重，AI 可用文件工具直接读取 |
| | `GET` | `/sessions/:id/files` | 列出会话工作区目录（?path= 浏览相对子目录，目录优先排序） |
| | `GET` | `/sessions/:id/files/download` | 下载工作区文件（?path= 相对路径；?inline=1 浏览器内联预览） |
| **Streaming** | `POST` | `/sessions/:id/prompt-stream` | SSE 流式发送提示词并接收生成 |
| | `GET` | `/sessions/:id/events` | SSE 会话全局事件监听订阅 |
| | `POST` | `/sessions/:id/prompt` | 同步等待对话结果 |
| **OpenAI** | `POST` | `/chat/completions` | 兼容 OpenAI Chat 协议 (流式/非流式) |
| **Models** | `GET` | `/models` | 查询可用模型清单与默认模型 |
| | `GET` | `/models/default` | 获取全局默认模型 |
| | `PUT` | `/models/default` | 更新全局默认模型 |
| | `GET` | `/providers` | 查询注册的 LLM 提供商 |
| | `GET` | `/presets` | 查询可用 Agent Preset 清单 |
| **Settings** | `GET` | `/settings` | 获取系统设置配置命名空间 |
| | `PATCH` | `/settings/:namespace` | 更新指定命名空间配置 |
| **Docs** | `GET` | `/docs` | 内置交互式 API 测试页面 |
| | `GET` | `/openapi.json` | OpenAPI 3.0 接口定义 |

## 开发与构建

```bash
# 构建插件
bash scripts/build.sh

# 运行时热注入 (需 dsh-super-injector)
dev_inject_plugin {"dir": "/path/to/dsh-web-service"}

# 热重载
dev_reload_package {"packageName": "dsh-web-service"}
```

## SKILL：让 AI 智能体学会调用本 API

本仓库自带一份 DSH 原生 SKILL（`skills/dsh-web-service/SKILL.md`），安装后 AI 智能体会自动发现并掌握全部接口的用法（触发词：HTTP 操作 DSH、三方集成、OpenAI 兼容调用等），会话内也可用 `/dsh-web-service` 直接调用。

### 一键在线安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/toddpan/dsh-webapi/main/scripts/install-skill.sh | bash
```

安装到用户级 skill 目录 `~/.dsh/skills/dsh-web-service/`，DSH 的 skill-filesystem 提供方会热发现（无需重启），下一个会话即可用。

### 可选参数

```bash
# 安装到指定目录（项目级 .dsh/skills 或 .agents/skills）
curl -fsSL .../install-skill.sh | bash -s -- --dir /path/to/project/.dsh/skills

# 指定分支 / 仓库
curl -fsSL .../install-skill.sh | bash -s -- --branch dev
curl -fsSL .../install-skill.sh | bash -s -- --repo other/dsh-webapi

# 卸载
curl -fsSL .../install-skill.sh | bash -s -- uninstall
# 或本地：bash install-skill.sh uninstall
```

脚本行为：下载 SKILL.md → 校验 frontmatter 合法性 → 安装到目标目录 → 探测本机 3080/3000 端口的 DSH Web Service 是否在线并提示。幂等可重复执行。

### 本地安装（仓库内）

```bash
bash scripts/install-skill.sh
```

## License

BSD-3-Clause
