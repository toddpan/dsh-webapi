# dsh-web-service 挂载参考（@dsh-external/dsh-web-service v0.1.9）

> 常规安装看 [README.md](README.md)（English）/ [README.zh.md](README.zh.md)（中文）。
> 本文件补充底层细节：插件行怎么写、preset 怎么挂、peer 依赖有哪些、挂载后怎么验证。

插件把 DSH 的工作区、会话、模型、设置、技能与文件能力开放为 REST + SSE 接口，并带一个 OpenAI
兼容的 `/chat/completions`。它 **inject** `webServer`、`tools`（均为宿主提供的能力），**不发布任何
Service**，因此既可挂宿主 cordis.yml（推荐，webserver 属宿主面），也可直接作为一行挂进 agent preset。

---

## (a) 标准安装（推荐）

```bash
dsh plugin --profile web add \
  https://github.com/toddpan/dsh-webapi/releases/latest/download/dsh-web-service.tgz
```

本包自带 bundle patch（`package.json` 的 `dsh.bundle.patch: ./cordis.patch.yml`），
`dsh plugin add` 会自动把下面的插件行 insert 进装配层、并写进 `dsh.profile.bundles`，无需手写。

## (b) 手动插件行（可逐字复制）

### 挂到 agent preset（`${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/agent.cordis.yml`）

在 rows 列表中追加（与 `tool-bash` 等消费型行同级、不要包进 isolate realm——
它只消费宿主的 `webServer`，包进 realm 反而解析不到）：

```yaml
- id: dsh-web-service
  name: '@dsh-external/dsh-web-service'
  config: {}
```

可选 config 字段（均有默认值，可不写）：

```yaml
  config:
    pathPrefix: /api/v1        # 路由前缀
    apiKey: ''                 # 非空则开启鉴权
    standalonePort: 0          # >0 时额外独立监听该端口
    cors: true
    defaultCwd: ''
    maxUploadBytes: 2147483648
```

### 挂到宿主 cordis.yml（推荐方式）

等价行同上，由 bundle patch 自动插入。

## (c) 从源码构建（需要 DSH 源码 checkout）

```bash
git clone https://github.com/toddpan/dsh-webapi && cd dsh-webapi
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh   # src/ → lib/
dsh plugin --profile web add "$PWD"
```

peerDependencies：`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、
`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-tools`
（全部由 DSH checkout 提供，构建脚本自动 symlink，无需 `npm install`）。

## (d) 挂载验证

```bash
# 1. 热重载后枚举插件确认在列且 fiber 正常
#    dev_plugin_status → 应出现 @dsh-external/dsh-web-service

# 2. 探活：系统状态接口应返回 ok:true
curl -s http://127.0.0.1:3080/api/v1/system/status

# 3. 交互式文档与 OpenAPI 规范可达
curl -sI http://127.0.0.1:3080/api/v1/docs | head -1        # HTTP/1.1 200 OK
curl -s http://127.0.0.1:3080/api/v1/openapi.json | head -c 100

# 4. preset 方式：mount-validate（standingKeyFor(id)）不报
#    "Cannot find package" / "did not activate" / "published process-global service(s)" 即通过
```

启动日志无 `Cannot find package '@dsh-external/dsh-web-service'`、
无 `invalid config`、无路由注册报错，即挂载成功。
