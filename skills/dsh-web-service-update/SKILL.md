---
name: dsh-web-service-update
description: 把 dsh-web-service 插件更新到目标 DSH 实例（macOS DeepSeek Harness.app、Linux systemd、DSH-X），含版本核对、按形态的升级步骤、验证与回滚。
whenToUse: 用户要求升级/更新 dsh-web-service 插件版本、把新版本发布物装到某台 DSH 机器上、或升级后验证节点/页面行为时使用。
---

# 更新 dsh-web-service 插件

把新版本的 `dsh-web-service` 装到一台已在运行该插件的 DSH 上，并验证升级生效。节点注册（WorkBuddy 登录绑定）见用户级技能 `dsh-node-deploy`；本技能聚焦**更新**本身。

## 1. 确定目标版本与发布物

- 仓库是 `toddpan/dsh-webapi`（**与 npm 包名同名但仓库名不同**）；`lib/` 特意入库（插件管理器按仓库原样安装），改完必须重新构建并提交。
- 发布物三选一：
  1. 本仓库 `npm pack`（本地构建）；
  2. npm 线上：`npm view dsh-web-service versions dist-tags --json`（用户会并行操作本仓库与发布——**本地操作前先 `git fetch` 对齐远端**）；
  3. GitHub Release 资产 `dsh-web-service-<ver>.tgz`（带版本号 URL，避免缓存）。
- 选版本时对照 CHANGELOG 的能力表（如 root 宿主需 ≥0.7.3、Windows 节点需 ≥0.7.7、后台配套补丁是否已部署）。

## 2. 摸清目标机形态（四选一）

| 形态 | 识别特征 | 插件落点 |
|---|---|---|
| macOS desktop | DeepSeek Harness.app | `~/.dsh/profiles/desktop/node_modules/dsh-web-service/`（真实目录） |
| Linux systemd | `dsh.service`（`dsh web --port 3080`） | `~/.dsh/profiles/<profile>/node_modules/dsh-web-service/`（真实目录或 pnpm symlink + `file:` tgz pin） |
| DSH-X | manager API 127.0.0.1:3780 | `~/.dsh/profiles/web/package.json` 用 `link:` 指向仓库 |
| 数据目录（各形态通用） | `~/.dsh/dsh-web-service/`（admin-token、api-keys.json、node-connection/、service-settings.json）——升级**不动**它，身份/账号/密钥全保留 | |

插件配置在 `~/.dsh/profiles/<profile>/cordis.patch.yml`（顶层 YAML 列表，条目 `- id/name/config`；改完用 `dsh --profile <p> --dump-config` 验证合并树）——**升级不会动它**，`nodeAllowRoot` 等配置跨版本保留。

## 3. 按形态升级

### A. macOS desktop（最快，rsync 本地构建）

```bash
# 本地构建后同步 lib 与 vendor（vendor 必须与 lib 同步——安全节点协议改动在 vendor）
rsync -a --delete <repo>/lib/ ~/.dsh/profiles/desktop/node_modules/dsh-web-service/lib/
rsync -a <repo>/vendor/security-node/ ~/.dsh/profiles/desktop/node_modules/dsh-web-service/vendor/security-node/
osascript -e 'tell application "DeepSeek Harness" to quit'   # 优雅退出=插件 close()，oneNat 子进程/python broker 干净终止
open -a "DeepSeek Harness"                                   # 等 31789 端口重新监听（4-10s）
```

### B. Linux + 官方 dsh CLI（首选，机器上有 `dsh` 命令时）

```bash
npm pack dsh-web-service@<ver> --pack-destination /tmp
scp -P <port> /tmp/dsh-web-service-<ver>.tgz root@<host>:/root/.dsh/backups/staging-<ver>/dsh-web-service-<ver>.tgz
ssh root@<host> 'dsh plugin --profile <profile> add /root/.dsh/backups/staging-<ver>/dsh-web-service-<ver>.tgz'
```

- 该命令需要 **pnpm 在 PATH**（缺失时 `npm i -g pnpm` 并把 pnpm 链到 /usr/local/bin）；安装走 pnpm，自动更新 profile `package.json` 的 pin（常见为 `file:…tgz` 形态）。

### C. Linux 无 dsh CLI（手动替换，如 BRAIN 机的 pnpm 布局）

```bash
ssh root@<host> '
  cd ~/.dsh/profiles/<profile>
  cp -a node_modules/dsh-web-service node_modules/dsh-web-service.bak-<oldver>   # pnpm symlink 场景 cp -a 会复制真实目录
  rm -rf node_modules/dsh-web-service.new && mkdir node_modules/dsh-web-service.new
  tar -xzf /tmp/dsh-web-service-<ver>.tgz -C node_modules/dsh-web-service.new
  rm -rf node_modules/dsh-web-service && mv node_modules/dsh-web-service.new/package node_modules/dsh-web-service
  rmdir node_modules/dsh-web-service.new
  python3 - <<PY      # 同步 pin，保持插件管理器一致
import json; p=json.load(open("package.json"))
p["dependencies"]["dsh-web-service"]="<ver>"
json.dump(p,open("package.json","w"),indent=2); open("package.json","a").write("\n")
PY
  systemctl restart dsh'
```

### D. DSH-X（link 仓库）

```bash
cd <repo> && bash scripts/build.sh          # 重编 lib
curl 127.0.0.1:3780/api/stop                # stop→start 即热重启
# 注意：有待确认更新提示（/api/pending 非空）时重启不会自动拉起 web，需 POST /api/start {"version":"..."}
```

## 4. 验证

```bash
curl -s http://127.0.0.1:<port>/api/v1/system/updates | python3 -m json.tool   # current=新版本
```

- **`current` 读的是磁盘 package.json，不代表运行进程已加载新版**——行为验证才算数：
  - 有节点绑定：`GET /api/v1/node-connection` 看新字段/行为（如 0.7.x 的 `workspace` 字段），phase 应自动回 online（同身份/子域名，无需重绑）；
  - 页面：`/settings/api-keys` HTML 里 grep 新版本特性标记；
  - 升级后首个数据面请求 401 属正常（fail-closed 初始化），管理面/页面请求会触发初始化。
- 双端验证（节点已绑定时）：用 `~/.dsh/dsh-web-service/node-connection/workbuddy-account.json` 的 cookie 调 WorkBuddy `/api/me/nodes`，确认该节点 online 且 roots 一致。

## 5. 回滚

- A/C/B 均有 `.bak-<oldver>` 备份：`mv` 回去 + 恢复 pin + 重启。
- DSH-X：git 回退仓库后重跑 build + 热重启。
- 数据目录（账号/密钥/身份）跨版本保留，降级无需重新绑定。

## 6. 更新专属坑

| 症状 | 处置 |
|---|---|
| 版本对但新功能不生效 | 运行进程没加载新 lib——确认真的重启了对应形态的进程 |
| `system/updates` 报 GitHub 403 | 限流，无害；且该接口读磁盘版本 |
| vendor 与 lib 版本错位（安全节点行为不一致） | lib 与 vendor 必须**同一次**同步/打包（npm 包已内置，手动 rsync 别漏 vendor） |
| 升级后节点名变成主机名 | <0.7.5 的重绑缺陷；升 0.7.5+ 后触发一次重绑恢复 |
| root 宿主升级后节点起不来 | 确认 cordis.patch.yml 的 `nodeAllowRoot: true` 仍在（升级不动配置），且版本 ≥0.7.3 |
| pnpm/file: 形态机器 | 用 C 方案时先 `cp -a` 备份（symlink 会解出真实目录）；或装 pnpm 走 B 方案官方 CLI |
| push 本仓库被拒 | 用户会并行发布——`git fetch` + rebase 再推 |

## 7. 发布新版本（如需）

提交分两段：`feat(...)` + `chore(release): v<ver> —— 摘要`；CHANGELOG.md 按既有英文条目格式新增（含安装命令块）；`npm pack` 出 tgz；`gh release create v<ver> <tgz> --notes`（附 SHA-256）；`npm publish`（registry 传播 2-3 分钟才可 `npm view` 验证，勿提前判失败）。提交前对 src/lib/scripts/docs/vendor 做秘密扫描（`scripts/live-onboarding-test.mjs` 含真实凭据，已 gitignore）。
