# dsh-web-service 安装说明（@dsh-external/dsh-web-service v0.1.8）

把 DSH 全部功能封装为 RESTful + SSE + OpenAI 兼容 API 的 Host 插件。
它 **inject** `webServer`、`tools`（均为宿主提供的能力），**不发布任何 Service**，
因此既可挂宿主 cordis.yml（推荐，webserver 属宿主面），也可直接作为一行挂进 agent preset。

---

## (a) 插件行（可逐字复制）

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

等价行同上；本包自带 bundle patch（`package.json` 的 `dsh.bundle.patch: ./cordis.patch.yml`），
以 `dsh plugin add` 方式安装时会自动把上面同一行 insert 进装配层，无需手写。

## (b) 依赖安装命令

peerDependencies：`cordis`、`schemastery`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`
（全部由 DSH checkout 提供，构建脚本自动 symlink，无需 npm install）。

```bash
# 1. 取源码（本地已有则跳过）
git clone https://github.com/feyanggit/DHS-test && cd DHS-test/dsh-web-service

# 2. 构建（src/ → lib/；需要 DSH 源码 checkout，自动探测或设 DSH_CHECKOUT）
bash scripts/build.sh

# 3. 挂载进 profile（二选一）
# 3a. 标准：link 进 profile 的 package.json + bundles，重启后自动装配
dsh plugin --profile web add /Users/tsbj/feyanggit/DHS-test/dsh-web-service
# 3b. 免重启热注入（需 dsh-super-injector）
#     dev_install_package {"dir": ".../dsh-web-service", "profile": "web"}
```

## (c) 挂载验证

```bash
# 1. 重启 DSH（标准方式）或热注入后，枚举插件确认在列且 fiber 正常
#    dev_plugin_status  → 应出现 @dsh-external/dsh-web-service

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
