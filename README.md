# dsh-webapi (@dsh-external/dsh-web-service)

DeepSeek Harness (DSH) Web Service API 插件：
把 DSH 所有功能封装为标准 Web Service RESTful API 与 SSE 流式接口，提供给三方系统集成调用。

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
