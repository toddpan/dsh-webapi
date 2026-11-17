# 登录 WorkBuddy 即绑定 DSH 节点

> 目标：把原来「节点机器生成配对码 → Web 添加节点 → 管理员授权」三步，收敛为
> **在 DSH 插件里登录一次 WorkBuddy 账号，节点自动接入并归属当前账号**。
> 普通用户不再需要单独的 ONENAT 账号，也不用手工复制地址 / 配对码。

## 用户操作（唯一一步）

1. 打开 DSH 侧边栏「API 服务」设置页（本机 DSH GUI 内嵌）。
2. 在顶部「连接到 WorkBuddy」卡片（TAB 页）的 **账号登录** 页填写 **WorkBuddy 地址 / 账号 / 密码**，
   可勾选「记住密码」，点「登录并绑定 DSH」。
3. 插件自动完成：登录 → 后台申请固定 HTTPS 映射 → 下载安装并启动 ONENAT 客户端 →
   生成一次性配对信息并在后台提交绑定。完成后顶部状态栏显示「已绑定 / 节点已在线」，可直接打开 WorkBuddy。

本机 GUI 内操作**无需管理令牌**；远程管理或「手动接入其他 WorkBuddy」仍走管理令牌。
配对码与 API Key 统一在插件内生成管理：配对码一次性、5 分钟有效；API Key 由插件自动创建并用于持续调用，二者都不经过浏览器明文展示。

## 卡片 TAB 结构

- **账号登录**：登录表单（含记住密码）与绑定态操作（打开 WorkBuddy / 重新连接 / 重新登录 / 断开外网连接 / 清除记住的密码），
  以及折叠的「手动接入其他 WorkBuddy」一次性连接信息。
- **工作区目录**：注册节点时暴露给 WorkBuddy 的文件访问范围。默认跟随 DSH 当前工作区（只读展示）；
  可切换为自定义目录，通过「＋ 选择目录」弹窗逐级浏览本机目录选取（支持手动输入绝对路径，`~` 自动展开；
  ≤64 个，拒绝根目录）。已绑定时保存会触发后台重新绑定：重绑走与首绑相同的完整 pair 握手
  （新一次性码 + pinned 身份校验），节点当前 roots 随 pair 重读并刷新到 WorkBuddy 平台的节点注册。
  目录**注册解析**不被目录内容阻塞（真实开发目录常含符号链接，枚举被安全策略拒绝时解析降级为
  路径登记，见 vendor/security-node 的 catalog/resolve 降级逻辑）；但各工作区的**实际文件列表/访问**
  仍走严格校验——含符号链接等不受信条目的目录在 WorkBuddy 侧浏览顶层时会明确报错，属安全模型设计。
- **oneNat 客户端**：客户端安装/运行监控（安装状态、版本、运行状态、进程与自动重启次数、最近错误）、
  检查更新 / 升级 / 重新安装、以及最近日志（该 TAB 激活时 5 秒轮询）。
  升级 = 校验通过后原子替换二进制并重启客户端；校验失败旧二进制不动、原进程恢复，可直接重试。

## 链路

```
DSH 插件 (dsh-web-service)
  └─ 登录 WorkBuddy 账号（POST /api/auth/login，默认仅保存会话 Cookie；勾选记住密码才额外密封保存）
       └─ WorkBuddy 后台 (node-onboarding)
            ├─ 用后台服务账号登录 ONENAT（POST /api/login）
            ├─ POST /api/client/bootstrap：按安装 ID 幂等创建/复用 隧道+应用+HTTPS 映射
            │    · 下发该安装专用 tunnel key（ngk-，仅限本映射）
            │    · 把插件的 DSH API Key 密封进应用凭证（bearer）
            │    · 返回该安装专用只读 key（onk-，CanReadCred，仅 bootstrap 返回）
            └─ 插件启动 ONENAT 客户端（GitHub Releases 校验和安装）→ 取得固定 HTTPS origin
                 └─ 插件生成 dshnode1. 连接信息 → POST /api/me/node-onboarding/bind
                      └─ WorkBuddy 校验 origin/映射/签名身份 → 强制 owner=当前账号 → 节点可用
```

- 节点对 DSH 的引用保存为 **稳定 mappingId**（不是易漂移的公网 URL）；派发时经资源目录实时解析。
- WorkBuddy 用该安装的只读 key 调 `/api/v1/mappings/:id/credentials` 取回 DSH API Key，再调用节点。
- 重启恢复：插件重新 provision（刷新本地端口与映射凭证），身份/映射/子域名保持不变。

## 部署前置（管理员一次性配置）

1. **ONENAT 服务端**启用公网 HTTPS 隧道监听：配置 `httpsAddr`（固定共享端口，如 443）与有效域名证书
   （`tlsCrt/tlsKey`）。未启用时 bootstrap 返回 409，不会伪造 https 地址。
2. **WorkBuddy 后台**环境变量：
   - `WORKBUDDY_ONENAT_ADMIN_URL`（缺省回落 `settings.onenat.baseUrl`）
   - `WORKBUDDY_ONENAT_USERNAME` / `WORKBUDDY_ONENAT_PASSWORD`：用于代理 bootstrap/status 的 ONENAT 服务账号。
3. **资源面 API Key**（`settings.onenat.apiKey`）须与上述服务账号**同一 ONENAT 用户**（或管理员 key），
   否则资源目录看不到托管映射。后台会自动为每个安装签发只读 key，无需手工开启凭证读取。
4. 固定端口语义：HTTPS 用服务端固定共享端口 + 稳定子域名；显式 TCP 固定端口被占用时**报错**，不静默换随机端口。

## 安全边界

- 一次性配对码：哈希落盘、5 分钟过期、重生成使旧码失效、消费后不可重放（沿用既有签名节点协议）。
- 节点身份 Ed25519 固定（pin），目录/文件访问受根目录与路径隔离约束。
- 安装专用 tunnel key 只能注册其被分配的映射（协议/端口/子域名/hostname 全匹配），改造客户端无法扩权。
- DSH API Key 只密封在 ONENAT 应用凭证并经只读 key 取回，**不下发浏览器**。
- WorkBuddy 密码默认**不落盘**；勾选「记住密码」后以密封密文保存（AES-256-GCM，密钥由管理令牌 HKDF 派生，
  与 managed API Key 同一方案，0600 文件），仅用于会话过期后的自动重登；「清除记住的密码」随时删除密文。
  管理令牌被重建后旧密文失效，自动重登明确报错要求重新登录，不会静默失败。
- 本人添加即归属本人、立即可用；共享给其他账号才需要另行授权（保留既有权限模型）。

## 插件端点（/api/v1/node-connection）

| 端点 | 说明 |
|---|---|
| `GET ''` | 总状态：tunnel / node / account（不含任何密钥与密码，含 `passwordSaved` 布尔）/ workspace |
| `POST /login` | 登录并绑定（`rememberPassword` 控制是否密封保存密码） |
| `POST /bind` | 用已有会话（必要时用记住的密码自动重登）重新 provision + pair + bind |
| `POST /workspace` | 保存工作区目录覆盖 `{mode:'default'|'custom', roots}`；已绑定时后台重绑并刷新平台注册 |
| `GET /fs-dirs?path=` | 本机目录浏览（只列子目录，隐藏 dot 目录，≤500 条），供目录选择器使用 |
| `POST /forget-password` | 清除记住的密码密文 |
| `GET /onenat/update` | `{installed, current, latest, updateAvailable}`（GitHub 最新 release 比对） |
| `POST /onenat/upgrade` | 升级/重装客户端 `{force?}`；非 force 且无更新时返回 noop |
| `GET /onenat/logs` | 最近 80 行已脱敏客户端日志 |
| `POST /stop` | 断开外网连接 |
| `POST /connect`、`POST /pairing` | 手动接入路径（需管理令牌） |

除 `/connect`、`/pairing` 外，本机 GUI 凭一次性 setup token 即可调用；远程需管理令牌。

## 平台与能力

- 文件/目录能力：macOS、Linux（非 root，需 `/usr/bin/python3`）。
- 命令执行隔离：Linux 需专用 bwrap rootfs；未配置时执行请求明确拒绝（file-only）。
- `agents/invoke` 文本通道默认 `AGENT_RUNTIME_UNAVAILABLE`，不接宿主工具。
- Windows 原生暂不支持节点运行时（明确报错）。

## 手动接入（兼容保留）

已建立公网连接时，可在设置页「手动接入其他 WorkBuddy」生成 5 分钟有效的一次性连接信息
（`dshnode1.` 包装 baseUrl + 配对码），在另一端 Web「添加 DSH 节点」粘贴导入。此操作需管理令牌。

## 验证

- 插件：`npm run test:node-onboarding`（运行时安全协议、安装校验、托管映射、登录即绑定端到端）。
- Web：`npm run test:access`（连接信息导入、归属/权限、签名节点验收）+ `scripts/plugin-node-onboarding-ui.test.mjs`（设置页登录 UI 行为）。
- ONENAT：`go test ngrok/server/...`（bootstrap 幂等/私有、固定端口不降级、托管 key 不扩权、凭证密封）。
