# `dsh-web-service` API Key 设置页面 — 信息架构 / 交互流程 / 界面实现规范

> 状态：设计稿（未实现，不改任何代码）
> 参照物：`src/openapi.ts` `generateDocsHtml()`（GET `{prefix}/docs` 交互式文档页）
> 约束：零新增依赖、纯内联 HTML/CSS/JS、不得明文回显已保存 Key

标注约定：
- **【事实】** = 已从代码核实
- **【假设】** = 设计决策，需要软件架构师确认
- **【待核】** = 需与架构师 / 验收测试工程师核对的开放问题

---

## 0. 结论先行（决策摘要）

| # | 决策 | 一句话理由 |
|---|------|-----------|
| D1 | 新页面为独立服务端渲染路由 `GET {prefix}/settings/api-keys`，与 `/docs` 并列；`/docs` 头部加"管理 API Key"入口 | 与 `generateDocsHtml()` 同构：一条路由 + 一个 `generateXxxHtml()` 函数返回整页内联 HTML，零构建链 |
| D2 | 数据/管理接口走独立命名空间 `GET/POST/PATCH/DELETE {prefix}/api-keys*`，**不复用** `/settings/:namespace` | 【事实】`PATCH /settings/:namespace` 会把 `api-keys` 当成 namespace 吞掉（正则 `^\/settings\/([^/]+)$`，先注册先匹配）；且语义上那是 DSH 系统设置 |
| D3 | 多 Key 持久化为插件自有 Key 记录（存 hash + 前缀 + 掩码），**永不明文落盘**；现有 `config.apiKey` 作为只读"遗留 Key"条目向后兼容 | 安全底线：页面上任何时刻不出现完整 Key；旧配置零迁移成本 |
| D4 | 创建 / 轮换后完整 Key **仅在一次性弹层内可见**，关闭即不可再获取（只有 hash） | 服务端只存 hash，"再看一次"在技术上不可能，UI 必须诚实反映这一点 |
| D5 | "启停鉴权"= 两级：全局鉴权开关（authEnabled）+ 单 Key 启用/停用；全局关闭时页面顶部常驻红色横幅 | 误关鉴权是高危操作，必须有持续可见的状态提示 |
| D6 | 页面 HTML 参照 `/docs` 公开；管理接口必须鉴权（管理凭据策略见【待核】Q1） | 页面壳公开与 `/docs` 一致；但 Key 管理接口不能公开 |
| D7 | CSS 完全复用 `/docs` 的 `:root` 变量与类名风格（kebab-case 单层、状态类加在容器上、`.btn/.api-card/.response-box` 原样搬用），仅新增 5 个语义变量 | 视觉与代码组织双一致；两个 HTML 函数可互相照抄样式段 |
| D8 | 响应式：在 `/docs` 现状（无断点、固定 1100px）之上新增 2 个断点（768px / 480px），表格降级为卡片列表 | Key 列表是表格型数据，手机上必须可用；同时不破坏 `/docs` 的现状（差异在一致性清单中显式列出） |

---

## 1. 页面信息架构

### 1.1 路由与入口【事实基础 + 假设设计】

**【事实】** 现有路由注册方式：`src/index.ts` 中 `registerXxxRoutes(ctx, router[, config])`，`HttpRouter.get()` 注册，最终挂在 `ctx.webServer` 的 `pathPrefix`（默认 `/api/v1`）。`GET /docs` 由 `registerOpenApiRoutes()` 注册，返回 `generateDocsHtml(prefix, requireAuth)` 生成的整页 HTML。**【事实】** 公开路由白名单硬编码在 `src/router.ts:135` 附近：`targetPath === '/docs' || targetPath === '/openapi.json' || targetPath === '/'`。

**新增路由（【假设】，建议全部落在新文件 `src/api-keys.ts`）**：

| 方法 | 路径（相对 prefix） | 类型 | 说明 |
|------|---------------------|------|------|
| GET | `/settings/api-keys` | 页面（HTML） | 设置页本体，服务端渲染 |
| GET | `/api-keys` | JSON | 列出所有 Key（脱敏记录） |
| POST | `/api-keys` | JSON | 新建 Key（响应体一次性返回完整 Key） |
| PATCH | `/api-keys/:id` | JSON | 改名/备注/过期时间/启停单 Key |
| POST | `/api-keys/:id/rotate` | JSON | 轮换（返回一次性新 Key + 旧 Key 宽限期） |
| DELETE | `/api-keys/:id` | JSON | 吊销/删除 |
| GET | `/api-keys/auth-config` | JSON | 鉴权总开关状态 + 汇总（启用数/停用数/遗留 Key 状态） |
| PATCH | `/api-keys/auth-config` | JSON | 开关全局鉴权（危险操作） |

**为什么页面放 `/settings/api-keys` 而数据放 `/api-keys`（D2 理由）：**
- **【事实】** `router.dispatch()` 按注册顺序遍历、首个匹配生效；`registerModelRoutes()`（含 `PATCH /settings/:namespace`）在 `registerOpenApiRoutes()` 之前注册。因此 `PATCH /settings/api-keys` 会被 `^\/settings\/([^/]+)$` 匹配成 `namespace="api-keys"` 交给 `settingsController.update()`，产生脏数据。把**所有写操作**移出 `/settings/` 前缀即可彻底规避，不需要改动注册顺序。
- **【事实】** `GET /settings` 是精确匹配（`^\/settings$`），`GET /settings/api-keys` 不会与之冲突；`GET /settings/:namespace` 未注册。所以**页面**放 `/settings/api-keys` 是安全的，且语义上最自然。
- **【事实】** `models.ts:192` 的 `/settings` 走 DSH `settingsController`，是系统设置；API Key 是本插件的凭据，语义不同，混在同一命名空间会让 API 消费者误判。

**入口（【假设】）：**
1. `/docs` 页头部右侧按钮区，在"查看 OpenAPI JSON"旁新增 `管理 API Key` 按钮 → `href="{prefix}/settings/api-keys"`（`target="_self"`，同标签页，因为要返回）。
2. `/docs` 的 `.auth-box`（API Key 鉴权输入框）右侧新增小链接 `管理/生成 Key →`，覆盖"用户不知道去哪拿 Key"的路径。
3. 设置页本身不再提供其他二级入口（单一职责，避免长出第二个导航系统）。

### 1.2 面包屑与返回路径【假设】

页面顶部 `<header>` 下方一行面包屑（`<nav aria-label="面包屑">`）：

```
DSH Web Service API （链接 → {prefix}/docs） › 设置 › API Key 管理
```

- 面包屑最后一项 `aria-current="page"`，非链接。
- 页头右侧主操作区固定放两个按钮：`返回 API 文档`（次级样式 `.btn.btn-ghost`）与 `新建 API Key`（主色 `.btn`）。
- 浏览器返回键行为安全：创建 Key 弹层用 `dialog` 元素 + `showModal()`（【假设】，见 4.5），不写 URL hash，避免"返回键关不掉弹层"。

### 1.3 区块划分（自上而下）

```
┌─ header（h1 + subtitle + 主操作按钮）────────────────┐
├─ nav.breadcrumb 面包屑 ──────────────────────────────┤
├─ [可选] .alert.alert-danger  「鉴权已关闭」常驻横幅    │
├─ [可选] .alert.alert-warning 「无管理权限」/ 401 引导   │
├─ 1. .section-title 「🔑 鉴权状态」                     │
│     .auth-box（复用 /docs 的 .auth-box 样式）          │
│     全局鉴权开关（启/停）+ 汇总：N 个启用 / M 个停用    │
├─ 2. .section-title 「🗝️ API Keys」                    │
│     .key-toolbar（筛选：全部/启用/停用/已过期 + 计数）  │
│     .key-list → 桌面 .key-table / 窄屏 .key-card 两种渲染
│     空状态：.empty-state（首次引导）                   │
├─ 3. .section-title 「📖 使用说明」                     │
│     .usage-box（.response-box 样式的代码块：curl 示例）│
└─ footer（插件版本 + 链回 /docs）──────────────────────┘
```

区块理由：
- **鉴权状态置顶**：全局开关影响的是"整个 API 是否裸奔"，比单个 Key 更高优先级（D5）。
- **使用说明内置**：创建完 Key 的下一个动作就是"拿去调用"，把 curl 示例（含 `Authorization: Bearer` / `X-API-Key` 两种写法，**【事实】** `router.ts` 两种头都接受）放在同页，减少跨页跳转。
- 顺序 = 用户任务顺序：先看鉴权是否开 → 管理 Key → 学会怎么用。

---

## 2. 交互流程（逐屏）

### 2.0 首次使用 / 空状态（一条 Key 都没有）

| 步骤 | 用户操作 | 预期反馈 |
|------|----------|----------|
| 1 | 打开 `GET {prefix}/settings/api-keys` | 页面骨架渲染；Key 列表区显示**空状态卡**，不是空白表格 |
| 2 | 阅读空状态 | 文案：「还没有任何 API Key」+ 三步引导：① 点击"新建 API Key" → ② 复制并妥善保存（仅一次可见）→ ③ 在调用时携带 `Authorization: Bearer <key>`；主按钮 `新建 API Key` 内嵌在空状态卡里 |
| 3 | 若同时全局鉴权=关 | 空状态卡额外显示黄色提示：「当前鉴权已关闭，任何调用方无需凭据即可访问 API」+ 快捷按钮 `启用鉴权`（触发 2.5 流程） |

**【假设】** 首次引导采用"空状态内嵌三步"而非新手浮层（tour）：零依赖、无状态机、刷新即恢复，符合内联 JS 的复杂度预算。

### 2.1 新建 Key

| 步骤 | 用户操作 | 预期反馈 |
|------|----------|----------|
| 1 | 点 `新建 API Key` | 打开 `<dialog>` 弹层（`.modal`），焦点自动落 `名称` 输入框 |
| 2 | 填表单（见 §3.1）：名称（必填）、备注（选填）、过期时间（选填） | 实时校验：输入框下方 `.field-hint` / `.field-error`，失焦与提交时校验；提交按钮在表单无效时 `disabled` |
| 3 | 点 `生成 Key` | 按钮进入 `.is-loading`（`生成中…` + `aria-busy="true"`），POST `/api-keys` |
| 4a | 成功 | **自动切换到"仅此一次可见"弹层**（2.6）；列表刷新，新行以 `.row-highlight` 高亮 3 秒 |
| 4b | 失败（网络/500） | 弹层不关闭，顶部 `.alert.alert-danger` 显示错误 + `重试` 按钮；表单内容保留 |
| 4c | 失败（403 无权限 / 401） | 弹层关闭，页面顶部显示权限横幅（2.7） |

### 2.2 复制 Key

| 场景 | 操作 | 反馈 |
|------|------|------|
| 一次性弹层内 | 点 `复制` 按钮 | `navigator.clipboard.writeText()`；成功后按钮文字变 `已复制 ✓`（`.btn-success`），2 秒恢复；失败降级为"请手动全选复制"提示并 `select()` 选中文本 |
| 列表行内（脱敏值） | 点 `复制前缀` | 仅复制 `dsh_xxxx…` 前缀，用于对照排查；**不提供复制完整 Key 的入口**（服务端只有 hash，拿不到） |

**【假设】** 复制成功用按钮态反馈而非 toast（少一个组件）；如架构师希望统一只用 toast，可全部改为 toast（见【待核】Q4）。

### 2.3 轮换（Rotate）

| 步骤 | 操作 | 反馈 |
|------|------|------|
| 1 | 列表行点 `轮换` | 打开确认弹层（`.modal.modal-danger`？——否，轮换属"警示级"，用 `.modal.modal-warning`），说明：「轮换后将生成新 Key；旧 Key `<prefix>…` 将在 **[宽限期]** 后失效。使用旧 Key 的调用方需要同步更新。」 |
| 2 | 选择宽限期（【假设】默认 `立即失效`，可选 1h / 24h / 7d） | 单选按钮组，`role="radiogroup"` |
| 3 | 点 `确认轮换` → POST `/api-keys/:id/rotate` | 成功：旧弹层关闭 + **自动打开一次性可见弹层**（2.6）展示新 Key；列表行显示状态徽标 `轮换中（旧 Key 至 <time> 失效）` |
| 4 | 取消 | 弹层关闭，无任何变更 |

理由：轮换不给宽限期会打断线上调用方；但默认"立即失效"是安全优先，宽限期由用户显式选择（【待核】Q3）。

### 2.4 吊销 / 删除

| 步骤 | 操作 | 反馈 |
|------|------|------|
| 1 | 列表行点 `吊销` | 打开**危险确认弹层**（`.modal.modal-danger`，红色标题），要求**手动输入 Key 名称**（输入框 `type="text"`，`placeholder` 显示目标名称）才能激活 `确认吊销` 按钮；同时显示后果文案：「吊销后使用该 Key 的调用方将立即收到 401，且无法恢复。」 |
| 2 | 输入名称匹配 | `确认吊销` 按钮由 `disabled` → 可点 |
| 3 | 确认 → DELETE `/api-keys/:id` | 成功：弹层关闭、行淡出移除、toast「已吊销 `<name>`」；失败：弹层内 `.alert.alert-danger` + 保留弹层 |
| 4 | Esc / 点遮罩 / `取消` | 弹层关闭，无变更 |

**"吊销"与"删除"合并为一个动作**（【假设】）：对 hash-only 存储来说二者无区别（无恢复价值）；UI 文案用「吊销（删除）」，避免用户以为还有"删除但可恢复"的语义。若产品要区分"软删除留痕"，见【待核】Q5。

### 2.5 启 / 停鉴权（两级）

**A. 单 Key 启停**（行内开关 `.switch`，`role="switch"`）：
1. 点开关 → 立即 PATCH `/api-keys/:id`（乐观更新，行内 `.spinner-mini`）。
2. 成功：开关到位 + 行内徽标 `启用`/`停用` 切换 + toast。
3. 失败：开关回弹 + 行内红色小字错误。
4. **停用最后一把启用中的 Key** 时前置二次确认（文案：「停用后所有调用方将无法通过鉴权访问 API（或退化为无鉴权，取决于全局开关）。确定停用？」）。

**B. 全局鉴权开关**（鉴权状态区块，`role="switch"`）：
1. 从"开 → 关"：弹危险确认（输入 `关闭鉴权` 四字确认，同 2.4 的输入确认模式），红色文案：「关闭后任何人无需凭据即可调用全部 API（含会话、文件读写）。」
2. 从"关 → 开"：普通确认（若没有任何启用中的 Key，禁用开关并提示「请先创建至少一把启用状态的 Key，否则你自己也会被锁在外面」）。
3. 成功：顶部常驻横幅出现/消失（见 2.7），`/system/status` 的 `authEnabled` 同步（**【事实】** 该字段由 `Boolean(config.apiKey)` 计算，实现时需改为"遗留 Key 或任一启用 Key"，见【待核】Q2）。

### 2.6 「仅此一次可见」Key 展示

**展示时机（D4）**：仅在 `POST /api-keys`（新建）与 `POST /api-keys/:id/rotate`（轮换）**成功响应返回完整 Key 的那一刻**打开。其余任何时刻（刷新、返回、列表、日志）都不再出现完整值。

**弹层结构与关闭方式：**
- `.modal.modal-once`，`role="alertdialog"`，`aria-modal="true"`，`aria-labelledby` 指向标题「请立即保存你的 API Key」。
- 内容：`.key-reveal`（`.response-box` 样式的等宽代码框，完整 Key）+ `复制` 按钮 + 警示条「**关闭后将无法再次查看**，服务端仅保存校验哈希」。
- **关闭方式（三种，全部要求显式动作）**：
  1. 点 `我已保存，关闭` 主按钮（推荐路径，位于焦点默认位）；
  2. 输入确认勾选 `我已保存该 Key` 后才允许点关闭（【假设】可选严格模式，见【待核】Q3）；
  3. Esc / 点遮罩 = 等价于"我已保存"（不阻止，但弹层关闭前 `confirm()` 兜底一次）。
- **自动保护**：页面 `visibilitychange` 切到后台时立即把 `.key-reveal` 文本替换为 `[已隐藏]`（防止截屏/投屏残留），回前台仍需点"显示"才恢复（仅限本弹层未关闭期间）。
- 关闭后：完整 Key 从 DOM 与 JS 内存中清除（`textContent = ''`），不写 localStorage（**【事实】** `/docs` 页把 key 存 `localStorage['dsh_api_key']`，那是"用户自己的调用凭据输入框"，与"新生成 Key 的一次性展示"是两回事；本弹层禁止写入任何存储）。

### 2.7 权限 / 鉴权异常横幅

| 场景 | 页面表现 |
|------|----------|
| 401（未带凭据或凭据无效） | 顶部 `.alert.alert-warning`：「需要管理凭据才能管理 API Key」+ 内联输入框（`type="password"`，`autocomplete="current-password"`）+ `保存凭据`（复用 `/docs` 的 `localStorage['dsh_api_key']` 约定，**【事实】** 同源同键可互通），保存后自动重新拉取列表 |
| 403（凭据有效但无管理权限） | 顶部 `.alert.alert-danger`：「当前凭据没有 Key 管理权限」，隐藏所有写操作按钮（只读浏览脱敏列表） |
| 503（服务不可用，【事实】** `models.ts` 对 settingsController 缺失返回 503，同类语义**） | `.alert.alert-warning` + `重试` 按钮 |
| 鉴权已全局关闭 | `.alert.alert-danger` 常驻：「⚠️ 鉴权已关闭，API 完全开放访问」+ `启用鉴权` 快捷按钮 |

### 2.8 行内编辑（改名 / 备注 / 过期时间）

点行内 `编辑` → 行就地展开成 `.key-edit-form`（表单字段同 3.1 的非敏感项），`保存` / `取消`；PATCH 失败保留输入并显示行内错误。不提供"查看完整 Key"入口（永远不可用，UI 不留死按钮）。

---

## 3. 表单与状态规范

### 3.1 字段定义

| 字段 | 类型 | 必填 | 校验规则 | UI 控件 | 说明 |
|------|------|------|----------|---------|------|
| `name` 名称 | string | ✅ | 1–64 字符（trim 后），允许中文/字母/数字/空格/`-_`，不允许 `<>"'&`（防注入展示层，同时服务端输出转义） | `input type="text"` | 列表主标识 |
| `note` 备注 | string | ❌ | ≤ 256 字符 | `textarea rows="2"` | 用途/负责人等 |
| `expiresAt` 过期时间 | ISO datetime | ❌ | 若填必须 > 当前时间；提供"永不过期"快捷选项 | `input type="datetime-local"` + checkbox `永不过期` | 过期后状态自动变 `已过期` |
| `keyPrefix` 前缀 | string | — | 服务端生成，仅展示 | 只读文本 | 如 `dsh_ab12cd34`（前 8 位随机 + 校验位）【假设】 |
| `keyMasked` 掩码 | string | — | `keyPrefix + '••••••••••••' + keySuffix` | 只读文本（等宽） | 页面上唯一可见形态 |
| `createdAt` 创建时间 | number(ms) | — | 服务端 | 只读 | `YYYY-MM-DD HH:mm` |
| `lastUsedAt` 最后使用时间 | number(ms) | — | 服务端在鉴权命中时更新（节流 ≥ 60s 写一次，【假设】） | 只读 | 从未使用显示 `从未使用` |
| `status` 状态 | enum | — | 计算字段 | 徽标 `.badge` | `active` 启用 / `disabled` 停用 / `revoked` 已吊销 / `expired` 已过期 / `rotating` 轮换宽限期 |

**状态徽标配色（复用 `/docs` 的 tag 色板）**：`active`→`--tag-get`（绿）、`disabled`→`--text-muted`（灰）、`expired`→`--tag-put`（琥珀）、`revoked`→`--tag-delete`（红）、`rotating`→`--tag-post`（蓝）。理由：**【事实】** 这四个色已在 `:root` 定义且语义（get/post/put/delete）与"正常/进行/警示/危险"直觉一致，零新增变量。

### 3.2 四种状态的表现规范

| 状态 | 触发 | 表现 |
|------|------|------|
| **加载中** | 请求发出后 | ① 列表区渲染 3 行 `.skeleton`（`@keyframes pulse` 渐变占位条，禁用动画时静态）；② 按钮 `.is-loading`：文字替换为 `请稍候…`、`disabled`、`aria-busy="true"`；③ `<span class="sr-only" role="status">加载中</span>` 供读屏 |
| **成功** | 2xx | ① 短反馈：按钮态（复制）或 `.toast`（3 秒自动消失，`role="status"`）；② 数据变更：局部 DOM 更新或整表重拉，列表行变更时高亮过渡 |
| **失败** | 4xx/5xx/网络异常 | ① 就近显示：弹层内 → 弹层顶部 `.alert.alert-danger`；行内操作 → 行内红字 `.field-error`；② 文案 = 人话 + 错误码，如「生成失败（500 INTERNAL_ERROR）：…」；③ 必有 `重试` 或"返回"出路；④ 不清空用户已输入内容 |
| **无权限** | 401 / 403 | 见 2.7 横幅；403 时隐藏/禁用全部写按钮（`disabled` + `title` 说明原因，保留可聚焦以便读屏播报原因） |

**空状态**（列表为空）见 2.0；**空搜索结果**（筛选无命中）：`.empty-state` 文案「没有符合条件的 Key」+ `清除筛选` 按钮。

### 3.3 校验交互细节【假设】

- 校验时机：`input` 时只清错误、`blur` 时校验、`submit` 时全量校验并聚焦第一个错误字段。
- 错误提示：`.field-error`（红字 12px）+ `aria-invalid="true"` + `aria-describedby` 指向错误元素。
- 服务端 400（【事实】** `sendJson` 错误体为 `{ok:false, error, code}`，`timestamp` 附带**）：把 `error` 文本映射到对应字段；无法映射的显示在弹层顶部。

---

## 4. 可直接落地的界面实现规范

### 4.1 文件与代码组织【事实对齐】

**【事实】** `generateDocsHtml(prefix, requireAuth)` 是 `openapi.ts` 内的一个纯函数，返回模板字符串（整页 HTML + `<style>` + `<script>`），路由处理器里 `res.setHeader('Content-Type', 'text/html; charset=utf-8')` 后 `res.end(html)`。无外部资源、无构建产物。

**【假设】** 新页面完全同构：

```
src/api-keys.ts
├─ registerApiKeyRoutes(ctx, router, config)   // 页面路由 + 8 条 JSON 路由
├─ generateApiKeysHtml(prefix, opts)           // 整页内联 HTML（与 generateDocsHtml 并列同风格）
├─ (可选) sharedCssBlock()                     // 抽出公共 <style> 段，两个 HTML 函数共用
└─ ApiKeyStore                                 // hash 生成/校验、持久化（见【待核】Q2）
```

- 模板字符串 + `${prefix}` 插值（与 `/docs` 一致）。
- JS 全局函数 + `onclick=""` 内联绑定（与 `/docs` 一致：`toggleCard` / `sendReq` / `saveApiKey` 都是全局函数）。**【假设】** 允许新增一个 `qs()/qsa()` 微型选择器帮助函数替代 `document.getElementById` 长链，但不引入任何框架。
- 所有服务端渲染进 HTML 的动态文本必须过 HTML 转义（`escapeHtml()`），**【事实】** `/docs` 当前只插值了 prefix 与布尔值，无转义函数；新页面插值 Key 名称/备注（用户输入），必须补转义（实现注意点，不是本次改动）。

### 4.2 DOM 结构层级（骨架模板）

```html
<body>
  <div class="container">
    <header class="page-header">
      <div>
        <h1>API Key 管理</h1>
        <div class="subtitle">DSH Web Service API &bull; 基础前缀: <code>{prefix}</code></div>
      </div>
      <div class="header-actions">
        <a class="btn btn-ghost" href="{prefix}/docs">返回 API 文档</a>
        <button class="btn" id="btnCreateKey">新建 API Key</button>
      </div>
    </header>

    <nav class="breadcrumb" aria-label="面包屑">
      <a href="{prefix}/docs">DSH Web Service API</a>
      <span class="sep" aria-hidden="true">›</span>
      <span>设置</span>
      <span class="sep" aria-hidden="true">›</span>
      <span aria-current="page">API Key 管理</span>
    </nav>

    <!-- 状态横幅插槽：按需插入 alert-danger / alert-warning -->
    <div id="bannerSlot"></div>

    <!-- 1. 鉴权状态 -->
    <div class="section-title">&#x1F511; 1. 鉴权状态</div>
    <div class="auth-box">
      <span class="auth-label">全局 API 鉴权：</span>
      <button class="switch" id="authSwitch" role="switch" aria-checked="true">
        <span class="switch-thumb" aria-hidden="true"></span>
        <span class="switch-text">已启用</span>
      </button>
      <span class="auth-summary" id="authSummary">3 个启用 / 1 个停用</span>
    </div>

    <!-- 2. Key 列表 -->
    <div class="section-title">&#x1F5DD;&#xFE0E; 2. API Keys</div>
    <div class="key-toolbar">
      <div class="filter-group" role="group" aria-label="按状态筛选">
        <button class="chip active" data-filter="all">全部</button>
        <button class="chip" data-filter="active">启用</button>
        <button class="chip" data-filter="disabled">停用</button>
        <button class="chip" data-filter="expired">已过期</button>
      </div>
      <span class="key-count" id="keyCount">共 4 条</span>
    </div>

    <div class="key-list" id="keyList">
      <!-- 桌面：table.key-table；窄屏：同一数据渲染 div.key-card（JS 按 matchMedia 切换） -->
      <table class="key-table">
        <caption class="sr-only">API Key 列表（脱敏展示）</caption>
        <thead>
          <tr><th scope="col">名称</th><th scope="col">Key</th><th scope="col">状态</th>
              <th scope="col">创建时间</th><th scope="col">最后使用</th><th scope="col">过期时间</th>
              <th scope="col"><span class="sr-only">操作</span></th></tr>
        </thead>
        <tbody id="keyTableBody"></tbody>
      </table>
    </div>

    <!-- 3. 使用说明 -->
    <div class="section-title">&#x1F4D6; 3. 使用说明</div>
    <div class="response-box">curl -H "Authorization: Bearer &lt;API_KEY&gt;" {prefix}/sessions</div>

    <footer class="page-footer">
      <a href="{prefix}/docs">API 文档</a> &bull; <a href="{prefix}/openapi.json">OpenAPI JSON</a>
    </footer>
  </div>

  <!-- 弹层：全部用原生 <dialog>（零依赖，自带 Esc/焦点管理） -->
  <dialog class="modal" id="createModal" aria-labelledby="createModalTitle"> … </dialog>
  <dialog class="modal modal-once" id="revealModal" role="alertdialog" aria-labelledby="revealTitle"> … </dialog>
  <dialog class="modal modal-warning" id="rotateModal" aria-labelledby="rotateTitle"> … </dialog>
  <dialog class="modal modal-danger" id="revokeModal" aria-labelledby="revokeTitle"> … </dialog>
</body>
```

**行模板（`<tbody>` 内，JS 渲染）：**

```html
<tr class="key-row" data-id="{id}">
  <td class="cell-name">
    <span class="key-name">{name}</span>
    <span class="key-note">{note}</span>
  </td>
  <td class="cell-key"><code class="key-masked">{prefix}••••••••••••{suffix}</code></td>
  <td class="cell-status"><span class="badge badge-active">启用</span></td>
  <td class="cell-time">{createdAt}</td>
  <td class="cell-time">{lastUsedAt}</td>
  <td class="cell-time">{expiresAt|永不过期}</td>
  <td class="cell-actions">
    <button class="btn btn-sm" data-action="edit">编辑</button>
    <button class="btn btn-sm" data-action="rotate">轮换</button>
    <button class="btn btn-sm btn-danger" data-action="revoke">吊销</button>
  </td>
</tr>
```

事件绑定用**事件委托**：`keyTableBody.addEventListener('click', e => { const btn = e.target.closest('[data-action]') … })`（比 `/docs` 的逐个 `onclick` 更适合动态行，属允许范围内的写法改进）。

### 4.3 CSS 类命名约定【事实对齐 + 假设扩展】

**【事实】** `/docs` 的命名风格：kebab-case、单层（非 BEM），块级容器 + 语义子件（`.api-card` / `.api-header` / `.api-body` / `.form-group` / `.test-actions` / `.response-box` / `.auth-box` / `.section-title`），状态用容器上的状态类（`.api-card.open .api-body { display:block }`），修饰符少见（`.method.get`）。

**新页面沿用，规则固化为：**

| 规则 | 示例 |
|------|------|
| 块：名词 kebab-case | `.key-table` `.key-row` `.auth-box` `.empty-state` |
| 子件：块名缩写或位置语义 | `.key-toolbar` `.cell-name` `.field-error` `.modal-title` |
| 状态类：`is-*` / 语义形容词，加在容器上 | `.is-loading` `.row-highlight` `.badge-active` `.modal-danger` |
| 修饰符：`btn-*` / `alert-*` | `.btn-ghost` `.btn-danger` `.btn-sm` `.alert-warning` |
| 禁止 | BEM 双下划线、CSS-in-JS、嵌套超过 2 层选择器 |

### 4.4 复用的 CSS 变量清单（全部来自 **【事实】** `generateDocsHtml()` 的 `:root`）

| 变量 | 值 | 新页面用途 |
|------|----|-----------|
| `--primary` | `#2563eb` | 主按钮、开关激活态、焦点环 |
| `--primary-hover` | `#1d4ed8` | hover 态 |
| `--bg` | `#0f172a` | 页面背景 |
| `--card-bg` | `#1e293b` | 卡片/弹层/工具条背景 |
| `--border` | `#334155` | 边框、分隔线、表头下边框 |
| `--text` | `#f8fafc` | 主文本 |
| `--text-muted` | `#94a3b8` | 次要文本、标签、`disabled` 态 |
| `--tag-get` | `#10b981` | `badge-active`、成功反馈 |
| `--tag-post` | `#3b82f6` | `badge-rotating` |
| `--tag-put` | `#f59e0b` | `badge-expired`、`alert-warning`、`modal-warning` |
| `--tag-delete` | `#ef4444` | `badge-revoked`、`btn-danger`、`alert-danger` |
| `--code-bg` | `#090d16` | 输入框、key 掩码框、`.response-box`、代码块 |

**【假设】** 新增 4 个语义变量（写在新页面 `<style>` 里，可被 `/docs` 后续采纳）：

```css
:root {
  --radius-sm: 6px;    /* 输入框/按钮，与 /docs 现有 6px 一致 */
  --radius-md: 8px;    /* 卡片/弹层，与 /docs 现有 8px 一致 */
  --shadow-modal: 0 8px 32px rgba(0,0,0,.45);  /* 弹层投影 */
  --focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--primary);  /* 统一焦点环 */
}
```

理由：`/docs` 目前把 6px/8px 散落硬编码，抽出为变量不改变视觉，只提高可维护性；焦点环是新增可访问性要求，必须有统一定义。

**字体与基础样式（【事实】照搬）**：
- `font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif`
- `body { background: var(--bg); color: var(--text); padding: 24px; line-height: 1.5; }`
- `.container { max-width: 1100px; margin: 0 auto; }`
- 等宽：`ui-monospace, SFMono-Regular, Menlo, monospace`
- `h1 { font-size: 26px; font-weight: 700; color: #60a5fa; }`、`.subtitle { color: var(--text-muted); font-size: 14px; margin-top: 6px; }`
- `.btn` / `.section-title` / `.auth-box` / `.response-box` / `.form-group` 样式**逐字复用**。

### 4.5 响应式断点【假设】

**【事实】** `/docs` 无任何 `@media`，固定 1100px 容器。新页面新增（并在一致性清单里声明差异）：

| 断点 | 行为 |
|------|------|
| `> 768px`（默认） | `.key-table` 表格；header 左右分列；面包屑单行 |
| `≤ 768px` | header 改纵向堆叠（`flex-direction: column; align-items: flex-start; gap: 12px`）；`.key-table thead` 隐藏，`.key-row` 改为 `display: block` 的卡片（`td::before { content: attr(data-label) }` 显示字段名）；弹层宽度 `calc(100vw - 32px)` |
| `≤ 480px` | 操作按钮组换行；`.key-reveal` 代码框允许横向滚动（`overflow-x: auto`）；面包屑折叠为 `‹ 返回 API 文档` |

mobile-first 落实方式：基础样式按窄屏写，`@media (min-width: 768px)` 展开表格布局（与 `/docs` 的桌面优先写法不同，但输出一致；理由：表格降级卡片用 `td::before` 方案在窄屏书写更直接）。

### 4.6 可访问性要点【假设，参照 WCAG 2.1 AA】

**键盘操作**
- 全部交互控件用原生 `<button>` / `<input>` / `<dialog>`，天然可 Tab 聚焦；禁止 `div onclick`。
- Tab 顺序 = DOM 顺序 = 视觉顺序；工具条筛选按钮在列表之前。
- 弹层：`<dialog>.showModal()` 自带焦点收束与 Esc；关闭后焦点**返回触发它的按钮**（`dialog` close 事件里手动 `triggerBtn.focus()`）。
- 行内开关支持 `Space`/`Enter` 切换（`role="switch"` 的按钮天然支持）。
- `Esc` 逐层关闭：先关最上层弹层，不触发页面跳转。

**焦点态**
- `:focus-visible { outline: none; box-shadow: var(--focus-ring); }`（`--focus-ring` 见 4.4）；禁止 `outline: none` 无替代。
- 危险弹层的初始焦点落在 `取消` 上（防误触），"仅此一次"弹层初始焦点落在 `复制` 上。

**ARIA**
- 弹层：`role="dialog"`（危险确认 `role="alertdialog"`）、`aria-modal="true"`、`aria-labelledby="…"`、`aria-describedby` 指向后果说明。
- 开关：`role="switch"` + `aria-checked`；筛选组：`role="group"` + `aria-label`；面包屑：`<nav aria-label="面包屑">` + `aria-current="page"`。
- 表格：`<caption class="sr-only">`、`<th scope="col">`；操作列头用 `sr-only` 文本"操作"。
- 动态反馈：`.toast` 与错误横幅 `role="status"`（成功）/ `role="alert"`（失败）；加载态 `aria-busy="true"` + `sr-only` 文本。
- 所有纯图标（若有）`aria-hidden="true"`；图标+文字按钮以文字为准。
- `.sr-only` 工具类：`position:absolute; width:1px; height:1px; overflow:hidden; clip-path: inset(50%); white-space:nowrap;`。

**密码型 / 敏感输入的正确属性**
- 一次性 Key 展示框：只读展示，`<code class="key-reveal" tabindex="0" aria-label="新生成的 API Key，仅本次可见">`（可聚焦以便键盘用户滚动/复制）。
- 管理凭据输入框（401 横幅）：`type="password"`、`autocomplete="current-password"`、`aria-label="管理凭据"`。
- 新建表单中**不出现**任何输入完整 Key 的框（Key 由服务端生成）；`/docs` 的 `type="password"` 输入框保持现状（它是用户粘贴自己的 Key，`autocomplete="off"` 建议补上——一致性清单里的遗留项）。
- 颜色对比度：正文 `--text` on `--bg`（≈ 15:1）、`--text-muted` on `--card-bg`（≈ 4.8:1）、按钮白字 on `--primary`（≈ 5.1:1）均 ≥ AA；徽标色块内一律白字（`--tag-*` 上白字 ≥ 4.5:1，绿/蓝/红满足，琥珀 `--tag-put` 上白字约 2.2:1 ✗ → **琥珀徽标内文字改用 `#0f172a` 深色字**，对比 ≈ 9:1）。

---

## 5. 与现有 `/docs` 页的视觉一致性清单

| 项 | `/docs`（【事实】） | 设置页（【假设】） | 一致性 |
|----|--------------------|--------------------|--------|
| 主题 | 深色单主题（`:root` 一套变量，无 `data-theme`） | 同左，不引入亮色主题 | ✅ 一致（注：与"新站点默认亮/暗/系统"的通用规范冲突，此处以仓库现状为准，见【待核】Q7） |
| CSS 变量 | 12 个（见 4.4） | 全部复用 + 4 个语义变量（radius/shadow/focus） | ✅ 超集 |
| 字体 | 系统 sans + `ui-monospace` 等宽 | 同左 | ✅ |
| 页头 | `h1` 26px `#60a5fa` + `.subtitle` + 右侧 `.btn` 链接 | 同结构同尺寸 | ✅ |
| 按钮 | `.btn`（6px 圆角、`--primary`、hover `--primary-hover`） | 复用 + `.btn-ghost/.btn-danger/.btn-sm` 修饰 | ✅ 扩展 |
| 卡片 | `.api-card`：`--card-bg`、1px `--border`、8px 圆角 | `.key-table` 行/弹层/空状态同底同边框 | ✅ |
| 代码/输入 | `--code-bg` 背景、等宽、6px 圆角 | Key 掩码框、curl 示例、输入框同款 | ✅ |
| 区块标题 | `.section-title` 18px `#e2e8f0` + emoji 前缀 | 同款（emoji 用 `&#x…;` 实体写法，与 `/docs` 一致） | ✅ |
| 响应应式 | 无断点，固定 1100px | 新增 768/480 断点 | ⚠️ **有意差异**（表格页必须可移动端）；建议后续给 `/docs` 补同样断点 |
| 反馈方式 | `alert()`（保存凭据）、`.response-box` 就地输出 | toast + `.alert` 横幅 + 弹层内错误 | ⚠️ **有意升级**：危险操作不能用 `alert()`；`.response-box` 保留用于"使用说明"代码块 |
| Key 存储 | `localStorage['dsh_api_key']`（用户输入的凭据） | 管理凭据沿用同键；新生成 Key **不落任何存储** | ✅ 语义兼容 |
| 弹层 | 无 | 原生 `<dialog>` + `.modal` | ⚠️ 新增组件，样式取 `--card-bg`/`--border`/radius 保持一致 |
| 交互绑定 | 全局函数 + 内联 `onclick` | 全局函数为主 + 动态行用事件委托 | ✅ 同风格 |

---

## 6. 需要与软件架构师 / 验收测试工程师核对的问题

### 软件架构师
- **Q1 管理接口的鉴权边界**：`/api-keys*` 写操作用什么凭证？候选：(a) 复用任意有效 API Key（则任何持 Key 者可吊销他人 Key）；(b) 单独的 admin scope/管理口令；(c) 仅 loopback（127.0.0.1）可管理；(d) 鉴权关闭时开放、开启时要求"最后一把启用 Key"。**推荐 (b)+(c) 组合**，但这决定 403 语义与测试用例数量。
- **Q2 Key 的持久化与 hash**：存哪（插件配置 `apiKeys[]` 由 DSH config 持久化 vs `dshHome` 下独立 JSON）？hash 算法（sha256+per-key salt？）？`lastUsedAt` 写放大怎么节流？`/system/status` 的 `authEnabled`（现为 `Boolean(config.apiKey)`）是否改为"遗留 Key 或任一启用 Key"？多进程/`standalonePort` 双监听下状态一致性？
- **Q3 一次性可见与轮换语义**：新 Key 展示是否需要勾选确认才能关闭？轮换宽限期默认值与档位？旧 Key 宽限期内新旧并存如何计入"启用数"？
- **Q6 向后兼容细节**：`config.apiKey` 是否允许从 UI 修改/吊销（**当前设计：只读**，只显示掩码与状态）？吊销遗留 Key 是否意味着必须改配置文件并重启？`registerOpenApiRoutes`/`/docs` 的 public 白名单（`router.ts:135` 硬编码三项）是否改为可配置列表以纳入设置页路由？
- **Q8 OpenAPI 规范同步**：新 8 条接口是否需要进 `generateOpenApiSpec()`（`/docs` 页会展示）？新增 tags `Auth / API Keys`？

### 验收测试工程师
- **Q4 反馈组件验收口径**：复制成功用按钮态还是 toast？错误必须"就近 + 可重试"是否为硬性验收项？
- **Q5 吊销=删除**：验收是否接受单动作？若要求审计留痕（吊销后列表保留 `revoked` 行 N 天），用例需覆盖"吊销后仍可见"。
- **Q7 主题**：验收是否要求亮/暗/跟随系统三态（通用 UX 规范）？当前 `/docs` 只有深色单主题，设置页若补三态会与 `/docs` 不一致——二者需统一口径。
- **Q9 安全验收**：断言"任何接口响应/HTML/日志中不得出现完整 Key（创建/轮换响应体除外，且响应头 `Cache-Control: no-store`）"；一次性弹层关闭后 DOM 中无完整值；脱敏格式固定为 `前缀 + 12 个 • + 后 4 位`（需确认掩码位数口径）。
- **Q10 可访问性验收**：键盘全流程（Tab/Enter/Space/Esc）可达；读屏播报（焦点进弹层读标题与后果）；对比度（琥珀徽标深色字）；`type="password"` 与 `autocomplete` 属性断言。
- **Q11 状态用例矩阵**：加载/成功/失败/无权限 × （新建/轮换/吊销/启停/编辑/列表）全组合至少抽测；空状态、筛选空结果、最后一把 Key 停用、鉴权关闭横幅、401 重新输入凭据后自动重载。

---

## 7. 实现优先级（给开发的施工顺序，【假设】）

1. **P0 地基**：`src/api-keys.ts` 骨架 + `GET /settings/api-keys` 页面路由 + CSS 变量/公共样式段 + 面包屑/页头（与 `/docs` 互链）。
2. **P0 数据**：`ApiKeyStore`（hash、持久化、遗留 Key 归一）+ `GET/POST /api-keys` + 一次性可见弹层。
3. **P1 管理**：编辑、启停单 Key、吊销（输入确认）、轮换（宽限期）。
4. **P1 全局开关**：`GET/PATCH /api-keys/auth-config` + 常驻横幅 + 无 Key 保护。
5. **P2 体验**：筛选、骨架屏、toast、响应式卡片降级、`visibilitychange` 遮蔽、复制降级路径。
6. **P2 收尾**：OpenAPI spec 同步、`/docs` 入口按钮、错误码映射表、验收用例矩阵自测。
