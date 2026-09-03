---
name: dsh-web-service
description: 通过 RESTful API 管理 DeepSeek Harness (DSH)：工作区、会话、模型设置与 SSE 流式对话。当需要用 HTTP 接口操作 DSH（三方系统集成、OpenAI 兼容调用、自动化脚本）时使用。
whenToUse: 用户要求通过 HTTP/REST API 调用 DSH、集成三方系统、使用 OpenAI 兼容协议对话、或自动化管理工作区与会话时使用。
---

# DSH Web Service API（dsh-web-service）

本机 DSH 已由插件 `@dsh-external/dsh-web-service` 暴露为 Web Service。所有能力通过 HTTP 访问，第三方系统、脚本或任何 OpenAI SDK 均可直接调用。

## 服务地址

- **Base URL**：`http://127.0.0.1:3080/api/v1`（DSH 主 webserver 端口，默认 3080）
- **交互式文档**：`http://127.0.0.1:3080/api/v1/docs`
- **OpenAPI 规范**：`http://127.0.0.1:3080/api/v1/openapi.json`
- **鉴权**：若部署时配置了 `apiKey`，请求需带 `Authorization: Bearer <key>` 或 `X-API-Key: <key>` 头；未配置则免鉴权。
- **CORS**：默认开启。

快速自检：

```bash
curl -s http://127.0.0.1:3080/api/v1/system/status
```

## 统一响应约定

除 `/chat/completions` 外，所有接口返回：

```json
{ "ok": true, "data": { ... }, "timestamp": 1788421880661 }
{ "ok": false, "error": "错误信息", "timestamp": ... }
```

HTTP 状态码：`200` 成功、`201` 创建成功、`400` 参数错误、`401` 鉴权失败、`404` 资源不存在、`500` 内部错误、`503` 依赖服务未挂载。

## 1. 工作区管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/workspaces` | 列出全部工作区 |
| GET | `/workspaces/:id` | 工作区详情 |
| POST | `/workspaces` | 添加工作区，body `{"path": "本地目录", "title": "标题"}`；目录必须已存在 |
| PUT | `/workspaces/:id` | 重命名，body `{"title": "新标题"}` |
| DELETE | `/workspaces/:id` | 删除绑定（保留文件与会话） |
| GET | `/workspaces/:id/sessions` | 该工作区下的会话 |

示例：

```bash
# 添加工作区（目录须已存在，否则先 mkdir）
mkdir -p /tmp/my-project
curl -s -X POST http://127.0.0.1:3080/api/v1/workspaces \
  -H "Content-Type: application/json" \
  -d '{"path": "/tmp/my-project", "title": "我的项目"}'
```

## 2. 会话管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions` | 会话列表；`?search=关键词` 搜索、`?workspaceId=` 按工作区过滤 |
| GET | `/sessions/:id` | 会话详情（状态、模型、所属工作区、cwd、事件数） |
| POST | `/sessions` | 创建会话，body 可选 `{"workspaceId", "cwd", "title", "provider", "model", "reasoningEffort"}` |
| PUT | `/sessions/:id` | 修改标题和/或模型，body `{"title"?, "provider"?, "model"?, "reasoningEffort"?}` |
| DELETE | `/sessions/:id` | 删除/归档会话并释放 Agent |
| GET | `/sessions/:id/history` | 历史消息分页；`?maxMessages=50`、`?beforeSeq=` |
| POST | `/sessions/:id/cancel` | 中止当前轮次 |

典型流程：创建 → 对话 → 查历史 → 归档。

```bash
SID=$(curl -s -X POST http://127.0.0.1:3080/api/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{"title": "测试", "cwd": "/tmp/my-project"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['sessionId'])")
```

`GET /sessions/:id/history` 返回 `messages[]`（`role`: user/assistant，`content`，`seq`，`time`）及 `totalMessages`、`totalEvents`、`hasMore`。

## 3. 模型管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/models` | 全部模型目录：`provider`、`id`、`name`、`reasoning.efforts`、`routeOnly`、`isDefault` |
| GET | `/models/default` | 当前全局默认模型 `{provider, model, reasoningEffort?}` |
| PUT | `/models/default` | 修改全局默认，body `{"provider", "model", "reasoningEffort"?}`；对新会话生效 |
| GET | `/providers` | 提供商清单，每个含其 `models[]` |

模型条目分两类：
- **目录型**：来自 `modelCatalog.groups`，有名称与 reasoning 档位；
- **路由型**（`routeOnly: true`）：无模型目录但可直接路由。

**选模型前先 `GET /models` 拿合法的 `provider` + `model` 组合**。非法组合会被拒绝：`no adapter registered for provider ...`。

`PUT /models/default` 与设置命名空间 `agent-default-model` 写同一存储，两者互通。

## 4. 流式与同步对话

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/sessions/:id/prompt-stream` | **SSE 流式**：body `{"prompt", "mode"?: "normal"\|"steer"}` |
| GET | `/sessions/:id/events` | SSE 订阅该会话全部底层事件 |
| POST | `/sessions/:id/prompt` | 同步阻塞直到本轮完成，返回 `{content, reasoning?, toolCalls[]}` |

### SSE 事件类型（prompt-stream）

| event | data | 含义 |
|---|---|---|
| `connected` | `{sessionId}` | 连接建立 |
| `delta` | `{delta, seq}` | 文本增量 |
| `reasoning` | `{delta, seq}` | 思考过程增量 |
| `tool_call` | `{id?, name, arguments}` | 模型发起工具调用 |
| `tool_result` | `{id?, name, result}` | 工具执行结果 |
| `turn_end` | `{reason}` | 本轮结束 |
| `done` | `[DONE]` | 流终止信号 |
| `error` | `{message}` | 出错 |

```bash
curl -N -X POST http://127.0.0.1:3080/api/v1/sessions/$SID/prompt-stream \
  -H "Content-Type: application/json" \
  -d '{"prompt": "介绍一下你自己"}'
```

`GET /sessions/:id/events` 透传 Harness 原生事件（`turn/start`、`user/message`、`assistant/chunk`（含 `text-delta`/`reasoning-delta` 分片）、`assistant/message`、`tool/call`、`turn/end` 等），按 `seq` 递增。

## 5. OpenAI 兼容接口

`POST /chat/completions`，兼容标准 OpenAI 客户端与 SDK：

```bash
# 非流式
curl -s -X POST http://127.0.0.1:3080/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "PONG测试"}]}'

# 流式（SSE chunks，以 data: [DONE] 结束）
curl -N -X POST http://127.0.0.1:3080/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "你好"}], "stream": true}'
```

- 可传 `sessionId` 延续指定会话；不传则自动创建新会话。
- 可传 `model`，格式 `"provider/model"`（如 `"zai-coding-cn/glm-5.3"`）会为该会话切换模型。
- 响应中带 `sessionId`，可用于后续多轮。

OpenAI Python SDK 用法：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:3080/api/v1", api_key="none")
r = client.chat.completions.create(model="none", messages=[{"role": "user", "content": "你好"}])
print(r.choices[0].message.content)
```

## 6. 设置接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/settings` | 全部设置命名空间（redacted 值 + schema） |
| PATCH | `/settings/:namespace` | 合并写入指定命名空间，body 为 JSON patch |

常用命名空间：`agent-default-model`、`locale`、`ui-theme`、`permission` 等。

## 排错速查

| 现象 | 处理 |
|---|---|
| 连接拒绝 | DSH 未启动或端口非 3080；先查 `system/status` |
| 401 | 配置了 `apiKey`；请求带 `Authorization: Bearer <key>` |
| 模型选择报 no adapter | `provider/model` 非法；先 `GET /models` 校验 |
| 新会话模型不对 | 全局默认被改过；查 `GET /models/default`，或创建时显式传 `provider/model` |
| 流式空回复 | 会话刚创建需 Agent 就绪；改用 `POST /sessions/:id/prompt` 同步等待，或先 `GET /events` 确认事件在流动 |
| prompt 被拒 `agent-busy` | 会话正在跑；先 `POST /sessions/:id/cancel` 或改 `mode: "steer"` 追加 |

## 调用策略

- 一切以**实测 curl**为准；不要凭记忆猜测端点或字段。
- 批量操作前先查列表拿到真实 id（workspace/session id 均为 UUID）。
- 长任务用 `prompt-stream` 或 `events` 监听，避免同步阻塞超时。
- 三方集成优先走 `/chat/completions`（标准协议、免协调会话生命周期）。
