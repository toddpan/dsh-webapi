# dsh-webapi (@dsh-external/dsh-web-service)

[English](README.md) | **中文**

把 DeepSeek Harness 通过 HTTP 开放出来：DSH 里的工作区、会话、模型、设置、技能与文件直接变成
REST 接口与 SSE 流，再加一个 OpenAI 兼容的 `/chat/completions`，现成的 OpenAI 客户端不用改就能接到 DSH。

典型用法：给 DSH 做一个自托管控制台、桌面或移动端客户端、驱动 Agent 的 CI/自动化流程、
把 DSH 当成工具调用的其它 Agent，或在 DSH 前面再包一层自己的 API 网关。

- **零新增依赖**：插件只 `inject` `webServer` 与 `tools`，路由挂在 DSH 宿主的 webserver 上（也可选独立端口）。
- **60 条路由**（REST + SSE），内置 OpenAPI 3.0 规范、在线调试页与 API Key 设置页。
- **自带 SKILL**：`skills/dsh-web-service/SKILL.md` 教会 DSH 里的 Agent 调用本 API（流式、中止、
  回答挂起问题、上传文件等）。

## 安装

兼容 DSH `0.1.0`–`0.2.x`（peer 范围见 `package.json`；已在 `0.1.7-rc.2` 上运行验证，并在 `0.2.0-rc.2` 上通过类型检查与运行时装配验证）。

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

**方式二：直接从 git 仓库安装**（插件管理器的「GitHub 仓库地址」安装方式）

```bash
dsh plugin --profile web add github:toddpan/dsh-webapi
```

`lib/` 已入库，所以从 git 装的包可直接运行。`lib/` 与 `src/` 保持同步——改动 `src/` 后，
请在同一次改动里重新构建并提交 `lib/`。

**方式三：从源码构建**（需要一份 DSH 源码 checkout）

```bash
git clone https://github.com/toddpan/dsh-webapi && cd dsh-webapi
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh     # src/ → lib/
dsh plugin --profile web add "$PWD"
```

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
| `adminRemoteAccess` | `false` | 是否允许**非回环**地址访问 API Key 管理接口；默认仅本机可管理密钥 |

> `apiKey` 只是「遗留单 Key」，向后兼容用。日常管理请到设置页生成/吊销多条 Key，详见
> [API Key 管理](#api-key-管理设置页)。

## API Key 管理（设置页）

打开 **`GET /api/v1/settings/api-keys`** 即可在一个页面里管理三方调用鉴权的密钥：
查看（脱敏）、新建、轮换、吊销、开启/关闭鉴权。`/docs` 页头部也有「管理 API Key」入口。

**三个入口**

| 入口 | 说明 |
|---|---|
| DSH Web GUI 侧边栏「API Key 管理」 | 插件自带浏览器半边（client half），装好并重启 DSH 后出现在侧边栏，内嵌本页 |
| `GET /api/v1/settings/api-keys` | 独立页面，可直接收藏 |
| `/docs` 页头「管理 API Key」按钮 | 从 API 文档一键跳转 |

页面按**管理令牌闸门**设计：密钥管理与普通 API 调用是两套凭证。首次打开会要求输入管理令牌，
页面会直接给出取令牌的命令（在运行 DSH 的机器上执行）：
`cat <DSH 配置根>/dsh-web-service/admin-token`，粘贴一次后保存在浏览器 localStorage。
未通过闸门时，页头的「新建 API Key」等管理按钮一律收起——不会出现「点了按钮才报 401」的死胡同。

### 页面主题与离线可用

`/docs`、`/docs/reference`、`/settings/api-keys` 三个页面统一使用 **HARNESS 设计令牌**
（`--dsw-alias-*`，取值镜像 `packages/client/ui-theme/src/styles/design-platform.css`），
因此配色、圆角、字号与 DSH Web GUI 一致，并同时支持浅色 / 深色：

- **内嵌在 GUI 侧边栏时**（同源 iframe）直接读取父页面的令牌计算值并实时跟随其明暗切换，
  用户自定义主题同样生效；
- **独立打开时**按系统 `prefers-color-scheme`，也可用 `?theme=light` / `?theme=dark` 强制。

Swagger UI 资产随包自托管在 `vendor/swagger-ui/`，由 `/api/v1/docs/assets/*` 提供，
**不依赖任何公共 CDN**，内网或离线环境同样可以打开 `/docs/reference`。

新建时有**两种 Key 值来源**，对应 `POST /api-keys` 的 `plaintext` 字段：

| 方式 | 行为 |
|---|---|
| 随机生成（默认） | 服务端生成 `dsk_` + 32 字节 CSPRNG（256 位熵） |
| **使用自定义 Key** | 粘贴你已有的 Key（16-256 位可见 ASCII），用于接入既有客户端或迁移 |

> 自定义 Key 的强度由你负责，因此它**连前缀都不展示**（列表里标记「自定义」）——否则一个
> `my-secret-api-key-xxx` 露出前 12 位就泄露了大半价值。服务端同样只保存哈希。
> 同值的**有效**记录会被拒绝（400）；已吊销 / 已过期的值可以重新登记。

**两套凭证，互不通用**

| 用途 | 凭证 | 头部写法 |
|---|---|---|
| 调用业务接口（数据面） | API Key | `Authorization: Bearer <key>` 或 `X-API-Key: <key>` |
| 管理密钥（管理面） | Admin Token | `Authorization: Bearer <admin-token>` 或 `X-Admin-Token: <admin-token>` |

这样持有 API Key 的三方客户端无法给自己增发密钥。Admin Token 由插件**首次启动时自动生成**，
存放在 DSH 配置根下的 `dsh-web-service/admin-token`（权限 0600）：

```bash
cat "${DSH_HOME:-$HOME/.dsh}/dsh-web-service/admin-token"
```

**安全约定**

- 完整 Key **只在新建/轮换成功的一次性弹层里出现一次**，之后页面只显示前缀 + 掩码，无法找回；
  落盘只存 `sha256(明文)`，明文永不写入磁盘、日志或错误信息。
- 管理接口默认**只允许本机（回环）访问**；远程管理需显式设置 `adminRemoteAccess: true`。
  浏览器请求一律做同源校验（防 CSRF / DNS rebinding），跨源返回 `403 FORBIDDEN_ORIGIN`。
- 吊销立即生效且不可恢复；轮换会让旧 Key 立即失效——更稳妥的做法是先「新建」替代 Key 分发，
  确认切换完成后再吊销旧的。
- 插件配置里存在 `apiKey` 时鉴权被**强制开启**，页面上无法关闭（防止误放松保护）；
  没有任何有效 Key 时也不允许开启鉴权，避免把自己锁在外面。
- 密钥存储文件损坏时按 fail-closed 处理：不放松鉴权，`/system/status` 会报 `keysStoreDegraded`。
  损坏文件会改名为 `api-keys.json.corrupt-<时间戳>` 保留取证，并自动从 `api-keys.json.bak`
  （每次成功写入后更新的「最后已知良好状态」）恢复，不会静默丢弃既有密钥记录。
- 管理接口的回环判定看的是 TCP 对端地址。若 DSH 前面挂了反向代理 / 隧道（例如把端口转发到公网），
  插件会把代理端当成对端地址，此时回环护栏形同虚设——必须自行在网络层收口，或保持
  `adminRemoteAccess: false` 并只在本机做管理操作。
- 数据面（业务接口）的鉴权是 Bearer / API Key 校验，**不含**同源校验：它本来就面向跨域三方客户端，
  因此浏览器页面携带有效 Key 的跨源请求属于预期能力；跨域放行范围由 `cors` 控制。
- 管理令牌会保存在浏览器 `localStorage`，公用电脑用完请在页面上「清除本机管理令牌」。

数据文件位于 `<DSH_HOME>/dsh-web-service/api-keys.json`（0600）。

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
8. **API Key 设置页与密钥管理**：`GET /api/v1/settings/api-keys` 一页管理三方调用密钥——
   多 Key 并存可命名、脱敏展示、新建/轮换/吊销、开启关闭鉴权；明文只显示一次，落盘只存哈希。

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
| **API Keys** | `GET` | `/settings/api-keys` | **API Key 设置页**（HTML，公开；数据接口需 Admin Token） |
| | `GET` | `/api-keys` | 列出 API Key（脱敏，不含明文/哈希） |
| | `POST` | `/api-keys` | 新建 API Key（明文仅返回一次） |
| | `PATCH` | `/api-keys/:id` | 修改名称 / 备注 / 过期时间 |
| | `POST` | `/api-keys/:id/rotate` | 轮换（旧 Key 立即失效，新 Key 明文仅一次） |
| | `POST` | `/api-keys/:id/revoke` | 吊销（幂等，不可恢复） |
| | `DELETE` | `/api-keys/:id` | 删除记录（仅限已吊销的 Key） |
| | `GET` | `/api-keys/auth` | 查询鉴权状态 |
| | `PUT` | `/api-keys/auth` | 开启 / 关闭鉴权（关闭需 `confirm: "disable-auth"`） |
| **Docs** | `GET` | `/docs` | 内置交互式 API 测试页面 |
| | `GET` | `/docs/reference` | 在线接口文档与调试（Swagger UI，全量接口 Try it out） |
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
