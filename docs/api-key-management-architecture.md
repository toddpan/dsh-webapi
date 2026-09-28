# API Key 管理 — 后端架构设计（dsh-web-service）

> 状态：提议中（ADR-001 / ADR-002 / ADR-003 合订）
> 范围：仅架构设计，不含实现代码。零新增运行时依赖；不修改 DSH 宿主；不引入数据库。

---

## 0. 结论先行（TL;DR）

| 议题 | 推荐决策 | 一句话理由 |
|------|----------|------------|
| 数据模型 | `ApiKeyRecord`（id/name/prefix/hash/algo/created_at/last_used_at/expires_at/status/revoked_at/source），明文一次性返回 | 哈希落盘 + prefix 可展示 + 状态可审计 |
| 持久化 | 插件自有 JSON 文件 `<dshHome>/dsh-web-service/api-keys.json`，内存缓存 + 原子写（temp+rename，0600） | settingsController 面向 schema 表单 + secret 脱敏，不适合动态 key 列表 |
| 哈希 | HMAC-SHA256 + 全局 pepper（`node:crypto`），比对 `timingSafeEqual` | key 是 32B CSPRNG 高熵随机，无需慢哈希；零依赖 |
| REST | `/apikeys` 顶层命名空间 6 条路由，只回 `prefix`+掩码 | 避开 `/settings/:namespace` 吞路径；与 47 条现有路由无冲突 |
| 鉴权边界 | 管理面独立 admin token（首次启动生成，0600 文件）+ 仅回环 + Host/Origin 校验 | `authEnabled=false` 时任何人可建 key = 提权漏洞，必须堵 |
| 兼容 | `config.apiKey` 合成 `source:'config'` 的只读 legacy 记录，比对链 = 多 key 表 ∪ legacy | 老客户端零感知；可逐步迁移 |
| 生效时机 | 吊销/新增即时（内存索引），写盘 await 完成后才回响应 | 同进程共享单 router（index.ts:52），一次写全局生效 |

**⚠️ 顺带发现的现存风险（代码事实）**：
1. `router.ts:146` 用 `token !== this.config.apiKey` 非恒时比较，存在时序侧信道。
2. `GET /settings`（models.ts:192-205）→ `settingsController.describe()` 只对 `role('secret')` 字段脱敏（dsh-settings `redact.d.ts:2-6`），而 `apiKey: z.string().default('')`（index.ts:44）**未标 secret role**，疑似会把明文 key 随设置描述返回给任何持 key 调用者。schemastery 支持 `.role(text)`（schemastery `types/index.d.ts:162`），应补标。
3. CORS 反射任意 `Origin`（router.ts:202-203）且 `OPTIONS` 一律 204 放行（router.ts:97-101），恶意网页可借用户浏览器打 127.0.0.1 上的本服务——管理面必须做 Origin/Host 校验，不能依赖 preflight。

---

## 1. 数据模型

```ts
interface ApiKeyRecord {
  id: string              // 'ks_' + 12B base64url 随机；记录标识，非凭证
  name: string            // 人类可读名称/备注（缺省 'key-<seq>'）
  prefix: string          // 明文前缀，如 'dsk_ab12cd34'（约 12 字符）；用于 UI 展示与 O(1) 定位
  hash: string            // base64url(HMAC-SHA256(pepper, plaintext))，定长 32B
  algo: 'hmac-sha256'     // 算法标识，为将来升级留位（HMAC vs scrypt）
  created_at: number      // epoch ms
  created_by?: string     // 'admin-api' | 'config-import' | 'cli'
  last_used_at?: number   // 最近一次鉴权成功（节流写盘）
  expires_at?: number     // 可选；缺省 = 永不过期
  status: 'active' | 'revoked' | 'expired'   // 查询态
  revoked_at?: number     // 审计态
  revoked_reason?: string // 'manual' | 'rotated' | 'compromised' | 'migrated'
  source: 'managed' | 'config'   // 'config' = 由 config.apiKey 合成的 legacy 记录（只读）
  scopes?: string[]       // 预留，v1 可省
}
```

**文件格式**（`api-keys.json`）：

```json
{
  "version": 1,
  "auth_enabled": true,
  "keys": [ /* ApiKeyRecord[] */ ],
  "updated_at": 1718000000000
}
```

**为什么这么设计**

- **`prefix` 保留明文、`hash` 不可逆**：哈希方案下无法从哈希还原出"展示用的前几位"，而用户需要在 UI 上区分多把 key；prefix 泄露不构成风险（token 剩余熵 ≥ 20 字节随机），同时允许 `Map<prefix, records>` 做候选定位，避免全表哈希比对。
- **明文不落盘**：数据库文件被拷走也无法冒用；创建/轮换响应里一次性回 `plaintext`。
- **`status` 与 `revoked_at` 并存**：前者是查询/展示态（含惰性推导的 `expired`），后者是审计事实；`revoked_reason` 让"轮换吊销"与"人工吊销"可区分（合规审计常见要求）。
- **`source` 字段**：把 `config.apiKey` 这条"事实上存在但不可管理"的凭证显式建模，比在比对链里藏一条魔法分支更可审计（见 §6）。
- **`algo` 字段**：零依赖约束下今天只有 HMAC-SHA256，但记录里留算法位，将来升级（如 scrypt/Argon2 进入 Node 标准库）可逐条迁移而不必全量重置。
- **时间字段风格待定**：现有类型用 `createdAt: number`（types.ts:20-21 `WorkspaceItem`），本设计存储与 API 建议统一 camelCase（`createdAt/lastUsedAt/expiresAt/revokedAt`）以保持仓库一致性；需求草案里的 `created_at` 风格作为待与 UX/契约方确认项。

---

## 2. 持久化方案

### 推荐方案 A：插件自有 JSON 文件 + 内存缓存 + 原子落盘

- **路径**：`<dshHome>/dsh-web-service/api-keys.json`。`dshHome` 解析已有先例：`types.ts:161` `dshHome`（默认 `$DSH_HOME` 或 `~/.dsh`），skills.ts 已按此写文件（skills.ts:288 `mkdir`）。pepper 与 admin token 同目录独立文件。
- **写入时机**：
  - **强一致写**：create / rotate / revoke / 改名 / 启停鉴权 → 内存状态更新 + `await` 原子写盘**完成后**才回 HTTP 响应（失败则回 503 且不改内存）。
  - **弱一致写**：`last_used_at` 节流（如 60s 或每 N 次请求合并一次）异步写，丢一点精度可接受。
- **并发与原子性**：
  - 进程内：单写队列（promise 链）串行化所有"读-改-写"，杜绝两个并发 POST 丢记录。注意主 webserver 与 standalone 端口共用同一个 `HttpRouter` 实例（index.ts:52 单 router 被 index.ts:95 与 index.ts:111 两处 dispatch），所以进程内串行即全局串行。
  - 原子替换：写 `api-keys.json.tmp-<rand>`（`open('wx')`，mode `0o600`）→ `fs.rename` 覆盖目标（同目录 rename 原子，读者只见旧或新完整内容）。这与宿主 `dsh-atomic-write` 的做法一致（该包 `types/index.d.ts` 详述了 wx-exclusive + rename + mode 穿透），但该包不在本插件 peerDependencies（package.json），**不能引入**，需用 `node:fs/promises` 自实现同模式。
  - 跨进程：DSH 主进程单实例 + standalone server 同进程，v1 不需要文件锁；若将来出现多实例，补 `<file>.lock`（`wx` 创建，holder 进程失效可接管）——列为可暂缓。
- **文件权限**：目录 `0o700`、数据文件 `0o600`、pepper `0o600`、admin-token `0o600`。temp inode 创建时即带 mode（rename 穿透），避免 chmod 竞态；Windows 平台无 POSIX mode → 文档标注"依赖用户目录 ACL"。
- **损坏降级（fail-closed）**：
  1. `JSON.parse` 失败 → 将坏文件改名 `api-keys.json.corrupt-<ts>`（保留取证）→ 尝试 `api-keys.json.bak`（每次成功写盘前保留上一份）。
  2. 备份也坏 → 以空 key 表启动，但**绝不因此放松鉴权**：`auth_enabled` 取文件内值缺失时回落到 `Boolean(config.apiKey)`；若判定应鉴权而 key 表为空 → 所有数据面请求 401（fail-closed）。
  3. `/system/status` 暴露 `keysStoreDegraded: true`（index.ts:61-75 已有 status 载荷结构），并写一次告警日志。

### 备选方案 B：复用 `settingsController` / `ctx.settings`

宿主的设置面（models.ts:194、`dsh-api-settings-controller` `index.d.ts`）提供 `describe()` / `update(ns, patch, expectedRevision)`，自带 revision 乐观锁（`settings/conflict`）与 secret 脱敏。
**不采纳的理由**：(1) 其写模型是"schema 表单的 user section 合并/路径编辑"，动态长度的 key 记录数组只能靠 path op 增删元素，语义别扭；(2) secret 字段读取一律脱敏（redact.d.ts:20 "Wire readers always request secret redaction"），我们本来就存哈希，但字段角色机制会干扰 `prefix/hash` 的正常读取；(3) 与宿主设置 UI 版本耦合。
**保留价值**：标量配置（`auth_enabled`、`adminRemoteAccess`）本就应放插件 Config（schemastery），天然经 settings 面管理。

### 备选方案 C：纯内存（不落盘）/ SQLite

C1 重启丢全部 key，多 key 管理失去意义；C2 违反"零依赖 + 不引入数据库"约束。均否决。

---

## 3. 哈希与比对

- **明文不落盘**，仅在 `POST /apikeys` 与 rotate 响应的 `plaintext` 字段出现一次；此后 UI 只显示 `prefix + 掩码`。
- **推荐算法：HMAC-SHA256 + 全局 pepper**（`node:crypto` 的 `createHmac`）：
  - token 生成：`randomBytes(32).toString('base64url')`（CSPRNG，熵约 256 bit）。
  - **不用慢哈希（scrypt/bcrypt）的理由**：慢哈希针对"低熵人选拼密码"；API key 是高熵随机串，暴力搜索不可行，慢哈希只会把每次认证变成 CPU DoS 放大器。若产品允许用户自定义 key 文本，则回退 `crypto.scrypt`（N=2^15，每 key 独立 salt，`algo='scrypt'`）。
- **pepper**：`<dshHome>/dsh-web-service/pepper`（0600，32B），首次启动生成。pepper 与 hash 分文件的理由：单独拷走 `api-keys.json` 无法离线验证候选。pepper 丢失 = 全部 key 失效（可接受，等价一次性全量吊销，且是 fail-closed 方向）。**不放 config**：config 会经 `GET /settings` 描述面暴露（见 §0 风险 2）。
- **比对流程（常量时间）**：
  1. 从 `Authorization: Bearer` 或 `X-API-Key` 取 token（保留 router.ts:137-144 的双头兼容）。
  2. 解析 prefix（`dsk_` 后首段）→ `Map<prefix, ApiKeyRecord[]>` 定位候选（通常 0/1 条）。
  3. 对每条候选 `crypto.timingSafeEqual(hashBuf, computedHashBuf)`（同为定长 32B；入参先校验等长）。
  4. 候选为空时仍执行一次 dummy HMAC + `timingSafeEqual`，抹平"prefix 是否存在"的时序差异。
  5. legacy `config.apiKey` 比对**必须**同样走恒时比较（修复 router.ts:146 现状）。
  6. 命中后校验 `expires_at`（惰性判过期，写回 `status='expired'` 可异步）与 `status==='active'`。
- **红线**：plaintext / hash / pepper / admin-token 不得进入任何日志、错误消息、审计记录。注意 router.ts:188-196 的 500 会把 `err.message` 原样回传——实现约束：key 相关 handler 一律捕获并返回安全文案。

---

## 4. REST 接口契约

**命名空间**：`/apikeys`（顶层）。不放 `/settings/...`：`PATCH /settings/:namespace`（models.ts:208）会吞掉 `/settings/<任意>`；现有路由无顶层 `/:param` 通配（见路由清单：`/workspaces /sessions /models /settings /skills /fs /system /chat /docs /openapi.json /presets /providers`），`/apikeys` 与 `/apikeys/:id` 零冲突。全部路由需同步进 `openapi.ts`（现 47 条）。

**统一响应信封**：`{ ok, data?, error?, code?, timestamp }`（types.ts:5-11）。
**统一错误码**：`UNAUTHORIZED`(401)、`ADMIN_UNAUTHORIZED`(401)、`FORBIDDEN_ORIGIN`(403)、`KEY_NOT_FOUND`(404)、`BAD_REQUEST`(400)、`RATE_LIMITED`(429)、`KEYS_STORE_UNAVAILABLE`(503)、`INTERNAL_ERROR`(500，无细节)。
**脱敏规则**：任何读接口只返回 `prefix`（≤12 字符）与 `masked`（如 `dsk_ab12cd34••••••••`）；`hash`/`salt`/`pepper`/`plaintext` 永不出现在 GET、列表、错误、审计中；`plaintext` 只存在于创建/轮换的 201/200 响应体。

| # | Method/Path | 请求体 | 响应 | 错误 |
|---|-------------|--------|------|------|
| 1 | `GET /apikeys?includeRevoked=` | — | 200 `{ data:{ authEnabled, keys: [ {id,name,prefix,masked,status,createdAt,lastUsedAt,expiresAt,revokedAt,revokedReason,source} ] } }` | 401, 503 |
| 2 | `POST /apikeys` | `{ name?, expiresInDays?, scopes? }` | 201 `{ data:{ key: <脱敏记录>, plaintext } }`（plaintext 仅此一次） | 400, 401, 429, 503 |
| 3 | `POST /apikeys/:id/rotate` | `{ graceSeconds? }`（v1 可忽略=立即失效） | 200 同 #2（新 id、新 plaintext；旧记录 `revoked/reason:'rotated'`） | 401, 404, 429, 503 |
| 4 | `POST /apikeys/:id/revoke` | — | 200 `{ data:{ id, status:'revoked', revokedAt } }`（幂等） | 401, 404, 503 |
| 5 | `PATCH /apikeys/:id` | `{ name?, expiresAt? }`（不可改 hash/prefix） | 200 脱敏记录 | 400, 401, 404 |
| 6 | `GET /apikeys/auth` / `PUT /apikeys/auth` | PUT: `{ enabled: boolean, confirm?: "disable-auth" }` | 200 `{ data:{ authEnabled, activeKeyCount, legacyKeyPresent } }` | 400, 401, 403 |

- #6 关闭鉴权是高危操作：`enabled:false` 必须带 `confirm:"disable-auth"`，否则 400。
- 所有管理路由（#1-#6）走**管理面鉴权**（§5），API key 本身不能调用（防三方自我提权）。
- `GET /system/status`（index.ts:56-76）增补 `keysStoreDegraded`、`activeKeyCount`，`authEnabled` 语义改为"数据面是否强制鉴权"（= auth_enabled ∧ 有效凭证存在策略见 §6）。
- `/docs`（openapi.ts:24-31）与 `openapi.json` 维持 public 白名单（router.ts:135），但 `/docs` 的 key 输入框（openapi.ts:577, 737 `localStorage['dsh_api_key']`）应与 admin token 分离，不复用同一输入。

---

## 5. 鉴权边界与安全风险

### 5.1 核心问题
现有闸门 `if (!isPublic && this.config.apiKey)`（router.ts:136）意味着 **auth 关闭时全部路由匿名可写**。若 `/apikeys` 也走同一闸门，则匿名者可创建 key → 再开启鉴权 → 独占系统 = **提权漏洞**。

### 5.2 管理面方案（推荐）
1. **Admin token（bootstrap key）**：首次启动生成 `randomBytes(32)`，写 `<dshHome>/dsh-web-service/admin-token`（0600）。日志只打印**路径**不打印值。管理路由要求 `Authorization: Bearer <admin-token>`。
2. **回环限制**：管理路由默认只允许 `req.socket.remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}`；`adminRemoteAccess: false`（Config 新增，默认 false）才放开。standalone 监听绑 `0.0.0.0`（index.ts:121）尤其危险 → standalone 通道上的管理路由默认一律拒绝非回环。
3. **Host/Origin 校验**（防 DNS rebinding + 浏览器 CSRF）：管理路由要求 `Host` ∈ `{localhost, 127.0.0.1}[:port]`；带 `Origin` 时必须为同源/localhost，否则 403 `FORBIDDEN_ORIGIN`。依据：CORS 反射任意 origin（router.ts:202-203）+ `OPTIONS` 无条件 204（router.ts:97-101），preflight 不构成防护，恶意网页可经用户浏览器打本机端口。
4. **令牌层级分离**：数据面 = API key（多 key ∪ legacy）；管理面 = admin token（或回环+token）。API key 不能管理 key；admin token 不作为数据面凭证（审计清晰，本地脚本先用 admin token 建 API key）。此条需与 UX/测试确认可用性取舍。

### 5.3 其他安全要求
- **吊销生效时机**：内存索引即时（同进程下一请求即 401）；主 server 与 standalone 共用 router（index.ts:52/95/111）→ 行为一致。响应中明确 `effective: 'immediate'` 语义给测试方。
- **防暴力/限流**：认证失败按 IP 滑动窗口（如 10 次/分/IP、100 次/分全局）→ 429；管理写操作更严（5 次/分）。401 不区分"不存在/已吊销/已过期"，统一 `UNAUTHORIZED`。key 熵高，防的是扫描与 DoS 而非猜 key。
- **审计**：管理操作写 `audit.jsonl`（同目录，0600）：`{ts, action, keyId, prefix, actor:{ip, authType}, result}`；**不含 plaintext/hash/admin-token**。`last_used_at` 更新不逐条记日志。
- **日志红线**：任何 `logger`/`err.message`/500 响应禁止含凭证材料（注意 router.ts:192 透传 `err.message`，实现须自捕获）。
- **CORS 收紧**：管理路由不设 `Access-Control-Allow-Origin` 反射；数据面是否维持反射（router.ts:202）建议按现状保留但列入加固 backlog。
- **`GET /settings` 明文泄露风险**（§0 风险 2）：给 `apiKey` 的 schemastery schema 补 `.role('secret')`，或在多 key 落地后把明文 key 从 config 迁出（§6），二者至少做其一。

---

## 6. 向后兼容与迁移

- **语义保持**：`apiKey: z.string().default('')`（index.ts:44）含义不变——留空且 `auth_enabled` 未强制时不鉴权；老客户端携带旧 key 继续可用。
- **legacy 合成记录**：启动时若 `config.apiKey` 非空，且 key 表中无同 hash 的 `source:'config'` 记录 → 合成 `{ id:'cfg-legacy', name:'(config.apiKey)', source:'config', readOnly:true }`，只存 `HMAC(pepper, config.apiKey)`，不落明文。该记录在 UI 可见但不可 rotate/revoke/改名（只能改 config 或走迁移）。
- **比对链**：`有效凭证 = { status:'active' 的 managed key } ∪ { legacy config.apiKey }`；`auth 强制 = auth_enabled(文件) 或 Boolean(config.apiKey)`（两者取或，避免用户改了文件丢了 config 保护）。**此规则需与产品确认**（备选：config 优先 / 文件优先）。
- **一键迁移（可暂缓）**：`POST /apikeys/migrate-config` → 生成新 managed key（回 plaintext）+ 尝试把 `config.apiKey` 置空（经 `settingsController.update('dsh-web-service', {apiKey:''})`）。**待验证**：插件能否运行时写自身 config 命名空间、cordis 是否热重载 `apply`（index.ts:51）；不能则文档标注"改 config 需重启"，迁移 = 用户手工改 config。
- **config 变更生效**：`HttpRouter` 持有 config 引用（router.ts:32）并在闸门里直接读 `this.config.apiKey`（router.ts:136,146）。设计要求把鉴权决策集中到 `AuthService.verify(token)`，router 只做委托——这样多 key 状态与 config 快照解耦，热更新/重启都不产生双真相。
- **老客户端行为矩阵**：
  | 客户端 | 升级后行为 |
  |--------|-----------|
  | 带旧 config key | 继续 200（legacy 比对链） |
  | 不带 key 且 auth 关 | 继续 200（向后兼容） |
  | 不带 key 且 auth 开 | 401（与现状一致） |
  | 轮换/吊销某 managed key | 该 key 立即 401，其余不受影响 |
- **契约版本**：`/api/v1` 内只增字段不删；`package.json` 版本升 minor（0.2.0）；openapi.ts 同步新路由与 `securitySchemes`（现 BearerAuth/ApiKeyAuth，openapi.ts:43-56）。

---

## 7. 最小交付路径

### v1 必须
1. **KeyStore**：数据模型 + 原子 JSON 落盘 + pepper + 损坏降级（fail-closed）。
2. **AuthService**：多 key + legacy 恒时比对，替换 router.ts:135-154 闸门实现（对外行为兼容）。
3. **管理路由 5 条**：`GET /apikeys`、`POST /apikeys`、`POST /apikeys/:id/rotate`、`POST /apikeys/:id/revoke`、`PUT /apikeys/auth`。
4. **管理面防护**：admin token 文件 + 回环限制 + Host/Origin 校验。
5. **审计日志** `audit.jsonl`（无敏感数据）。
6. **openapi.ts / docs 同步** + README 迁移说明 + `/system/status` 增补字段。
7. **最小限流**：IP 失败计数 → 429。

### 可暂缓
- scopes 细粒度权限；expires 自动清理任务（惰性判定已够）；rotate 的 grace period；`PATCH /apikeys/:id`（改名/改过期）；`/apikeys/audit` 查询接口；Web 设置页 HTML（先纯 API + /docs）；`migrate-config` 一键迁移；跨进程文件锁；key 用量统计；`apiKey` 的 `.role('secret')` **不建议暂缓**（现存泄露风险，宜随 v1 修）。

---

## 8. 待验证项（设计推断 → 代码事实的缺口）

| # | 待验证 | 影响 |
|---|--------|------|
| V1 | `GET /settings` 是否明文返回 `config.apiKey`（`role('secret')` 未标）| 高：现存泄露面 |
| V2 | cordis 配置热重载：`settingsController.update` 插件 config 后 `apply` 是否重入、旧 router 引用是否失效 | 中：决定"改 config 是否需重启" |
| V3 | `$DSH_HOME`/`dshHome` 在插件运行时的实际取值与可写性（skills.ts:288 已用） | 中：持久化路径 |
| V4 | `webServer.host` 常见部署是 `127.0.0.1` 还是 `0.0.0.0`；standalonePort 常用配置 | 中：管理面暴露面 |
| V5 | `dsh-atomic-write` 是否可经 DSH bundle 免依赖解析（约束解读）| 低：不行就自实现 |
| V6 | 字段命名 camelCase vs snake_case 的对外契约偏好 | 低 |

---

## 9. 需核对的问题清单

### 与 UX 架构师
1. 设置页形态：DSH 宿主设置 UI（`ctx.settings` schema 表单）还是插件自有管理页（/docs 风格 HTML）？影响是否复用 `localStorage['dsh_api_key']` 输入。
2. 明文一次性展示交互：reveal + 复制 + "仅显示一次"确认弹窗？
3. 关闭鉴权的确认流程（`confirm:"disable-auth"`）与警示文案；`auth_enabled=false` 时管理页是否隐藏数据面入口。
4. 多 key 列表字段与命名（prefix 展示样式、camelCase）、轮换是否需要 grace period 的可视化。
5. legacy `config.apiKey` 记录在列表里如何标注（"来自配置文件，只读"）。

### 与验收测试工程师
1. 兼容用例：仅配 `config.apiKey` 的老部署升级后旧 key 仍 200；不带 key 的老客户端在 auth 关闭时仍 200。
2. 安全用例：`auth_enabled=false` 时非回环 `POST /apikeys` → 403；恶意 `Origin`/`Host` → 403 `FORBIDDEN_ORIGIN`；连续失败 → 429；401/500/审计/日志中 grep 不到 plaintext/hash/pepper。
3. 崩溃/损坏用例：写入中断不影响主文件（temp+rename）；主文件损坏 → 从 .bak 恢复或 fail-closed 全 401 + `keysStoreDegraded`。
4. 并发用例：并发 create/revoke 不丢记录（写队列）；rotate 后旧 key 立即 401、新 key 立即 200。
5. 恒时比对无法黑盒验收 → 以代码审查确认所有比对路径（含 legacy、dummy 分支）都走 `timingSafeEqual`。
6. 回归：`/settings`、`/docs`、`/openapi.json` 行为不变；47 条既有路由契约不变。
