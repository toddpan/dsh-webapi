# Changelog

## 0.7.7 — 2026-11-17

Native Windows read-only security nodes and complete pairing attempts.

- Start Windows security-node identity, signed pairing and workspace discovery instead of returning transport-only success. Support directory listing and file reading through a Windows handle broker; file mutation and isolated command execution remain disabled.
- Discover bundled Python from standalone Node, desktop Electron and managed DSH runtime layouts. Protect private node storage with Windows ACLs.
- Reject traversal, reparse points, hardlinks, alternate streams, replaced workspace identities, expired leases and drive-root exports. Keep macOS/Linux broker paths unchanged.
- Enable Windows pairing controls and describe supported capabilities. Preserve binding errors across tunnel status refreshes.
- Add native Windows and credential recovery regressions. WorkBuddy servers that reject Windows roots with INVALID_DIRECTORY must also apply the separately attached backend compatibility patch; this plugin release does not deploy the server change.

## 0.7.6 — 2026-11-17

Reliable ONENAT downloads, Windows transport support and simpler connection controls.

- Add standalone client installation with a single shared download progress panel. Support mirror fallback, HTTP Range resume, response-range/length validation, connection and stall timeouts, and checksum verification before atomic installation.
- Windows can provision, start and restore the HTTPS tunnel without attempting unsupported security-node pairing. The isolated-node platform gate remains intact.
- Show saved-account reconnect controls before node binding; reuse encrypted credentials without asking for the password again. Temporary server failures no longer erase saved passwords.
- Simplify actions by connection state, hide completed progress, move reinstall/logs and account changes into disclosures, and disable conflicting operations while installing/connecting.
- Retain all 0.7.2–0.7.5 root-host, workspace replay and node-name fixes.

## 0.7.5 — 2026-11-17

Keep the login-chosen node name across rebinds.

- The rebind connection info now carries the account's node name (`account.name`) before falling back to the hostname, so work on the settings card (workspace change / reconnect) no longer renames the platform node to the machine hostname.

Validation: TypeScript typecheck and build; the full node onboarding E2E suite (29 items) remains green with a new name-retention assertion.

## 0.7.4 — 2026-11-17

Survive persisted workspaces whose directory enumeration is refused by the security policy.

- The startup replay of persisted dynamic workspaces now tolerates content-policy rejections (`UNSAFE_FILE`/`UNTRUSTED_FILE`/`FILE_TOO_LARGE`/`DIRECTORY_TOO_LARGE`), matching the 0.7.0 resolve-time fallback. Previously a fallback-registered workspace (e.g. a directory containing symlinks) poisoned every later security-node start once the registered roots were widened to include it — the node stayed down with 「安全节点运行时不可用（UNSAFE_FILE）」 while the tunnel stayed online, and rebinds never reached the platform.
- E2E regression: re-saving the same symlink-containing custom root re-runs prepare and asserts the security node starts and serves the roots.

Validation: TypeScript typecheck and build; the full node onboarding E2E suite, node runtime and oneNat tunnel unit suites remain green; live root-host deployment verified.

## 0.7.3 — 2026-11-17

Honor `nodeAllowRoot` through to the security node process itself — 0.7.2 gated the plugin-side preflight but the vendored `startSecurityNode` still rejected root, so root-host deployments could not start the node at all.

- `SecurityNodeConfig` gains `allowRoot`; `startSecurityNode` skips the root rejection only when the host opted in (`config.allowRoot === true`). The Linux isolation probe keeps degrading to file-only mode under root as before.
- `NodeRuntime` passes its `allowRoot` option into the spawned security node config.
- Vendor README documents both plugin-side deviations from the pinned source.

Validation: TypeScript typecheck and build; the full node onboarding E2E suite, node runtime and oneNat tunnel unit suites remain green; live root-host deployment verified.

## 0.7.2 — 2026-11-17

Allow the WorkBuddy node security node to run under root via an explicit opt-in, for DSH hosts that themselves run as root.

- New plugin config `nodeAllowRoot` (default `false`): the node runtime preflight rejects root (「安全节点必须以非 root 的 Unix 用户运行」) unless this is enabled. Under root the uid-ownership checks lose their isolation meaning and only the path-scoping defenses remain (pinned directories, `O_NOFOLLOW`, ancestor validation); intended for single-user machines — e.g. system-service DSH deployments — where the host itself runs as root and the node onboarding would otherwise be unavailable.
- The preflight regression suite covers the root + `nodeAllowRoot` path (the root gate is skipped and the next gate, the Python probe, is reached).

Validation: TypeScript typecheck and build; the full node onboarding E2E suite, node runtime and oneNat tunnel unit suites remain green.

## 0.7.1 — 2026-11-17

- Show ONENAT installation stages, streamed download size, percentage when available, elapsed time and retry attempts above all node-connection tabs.
- Keep polling status during login, installation and upgrade; prevent overlapping status requests and retain operation results.
- Clear download metrics before verification and installation. Unknown download sizes use an indeterminate progress indicator.
- Report temporary progress-query failures without encouraging duplicate submissions.

Validation: TypeScript compilation, 12 ONENAT tunnel tests (including blocked-download status and progress transitions), embedded page script/render checks, and live verification that the running service serves the updated UI. Full node-onboarding integration tests could not run because the local WorkBuddy backend checkout lacks the required fixture sources.

## 0.7.0 — 2026-11-17

One-login WorkBuddy node onboarding gets a tabbed management card, remembers credentials, makes workspace directories configurable and exposes the oneNat client lifecycle.

- The 「连接到 WorkBuddy」card is rebuilt as a tabbed interface — 账号登录 / 工作区目录 / oneNat 客户端 — with a top status bar (phase dot, client version, public URL). Login state, bound actions and the manual pairing flow keep their semantics.
- Remember password (opt-in): the password is stored as an AES-256-GCM seal keyed from the admin token (same scheme as managed keys, 0600 at rest) and used to re-login automatically when the WorkBuddy session expires. 「清除记住的密码」 removes the seal; an undecryptable or rejected seal is dropped instead of retrying forever.
- Workspace directories: the card shows the DSH registry defaults read-only and allows switching to a custom list picked through a server-side directory browser (`GET /node-connection/fs-dirs`, local GUI only, subdirectories only). Saving while bound re-runs the full pairing handshake and the refreshed roots are re-registered on the WorkBuddy platform.
- Node onboarding rebind now performs the same complete pair handshake as the first bind (fresh one-time code plus pinned identity checks) so changed workspace roots reach the platform registration; identity, mapping and subdomain are unchanged. Backend counterpart released to the WorkBuddy platform (release `20261117T015207Z`) and verified live.
- oneNat client management: install state, running phase, process uptime, auto-restart count and last error, a sanitized log tail (`GET /node-connection/onenat/logs`), check-update against GitHub Releases (semver and `rYYYY.MM.DD` tags) and upgrade/reinstall (`POST /node-connection/onenat/upgrade`) with checksum-verified atomic binary replacement; a failed verification keeps the previous binary and restores the running process.
- Node security protocol: `catalog/resolve` no longer lets strict directory-content enumeration block workspace registration. Roots containing symlinks or untrusted entries (common in real dev directories) register and sync to the platform; actual file listings keep the strict checks.
- New endpoints: `POST /node-connection/workspace`, `POST /node-connection/forget-password`, `GET /node-connection/fs-dirs`, `GET /node-connection/onenat/update`, `POST /node-connection/onenat/upgrade`, `GET /node-connection/onenat/logs`. Local-GUI routes keep the setup-token gate; `/connect` and `/pairing` still require the admin token.

Validation: TypeScript typecheck and build; the node onboarding E2E suite (real WorkBuddy backend, real security node, real oneNat client process) covering remember-password auto-relogin, workspace override/rebind/platform refresh incl. symlink-containing roots, `fs-dirs`, and oneNat check-update/upgrade incl. verification failure; node runtime and oneNat tunnel unit suites; headless-Chrome render checks of the tabbed card. Verified live end-to-end on a desktop DSH instance against the WorkBuddy platform.

### 安装 / 升级

```bash
# npm：将 desktop 换成实际运行 API 服务的 profile
dsh plugin --profile desktop add dsh-web-service@0.7.0

# GitHub：使用带版本号的资产，避免旧 URL 解析缓存
dsh plugin --profile desktop add \
  https://github.com/toddpan/dsh-webapi/releases/download/v0.7.0/dsh-web-service-0.7.0.tgz
```

升级后检查 `/api/v1/system/status` 返回的插件版本为 `0.7.0`。若运行进程仍加载旧版，重启该 DSH 实例后复查。设置页顶部会出现 TAB 化的「连接到 WorkBuddy」卡片；已绑定节点继续使用原有身份与公网地址，无需重新绑定。

## 0.6.2 — 2026-11-10

Fix session model readback on DSH versions exposing `agent.model.current()`.

- `GET /api/v1/sessions/:id` now reports the running agent's provider, model and reasoning effort through the modern API, with support for the legacy `sessionController.agents.selectionFor(agent).current` API when the modern API is absent. This fixes WorkBuddy rejecting a newly created chat because the remote response omitted the explicitly selected model.
- Effort-only `PUT /api/v1/sessions/:id` preserves the running provider and full model ID instead of rejecting a valid modern session with `NO_MODEL_SELECTION`.
- OpenAI non-streaming `/api/v1/chat/completions` responses prefer the same actual runtime selection over stale legacy/header configuration.
- An empty modern selection stays unknown; it never falls back to a stale legacy selection. Explicit model selection errors and strict caller verification remain intact. Session detail returns only public model fields.

Validation: TypeScript typecheck and build, 20 HTTP route regressions using the compiled plugin with in-memory DSH services, existing streaming watchdog/heartbeat regressions, and the user-question bridge regressions. Tests do not contact model providers or change running DSH nodes. The DSH peer compatibility ranges are unchanged.

### 安装 / 升级

```bash
# npm：将 desktop 换成实际运行 API 服务的 profile
dsh plugin --profile desktop add dsh-web-service@0.6.2

# GitHub：使用带版本号的资产，避免旧 URL 解析缓存
dsh plugin --profile desktop add \
  https://github.com/toddpan/dsh-webapi/releases/download/v0.6.2/dsh-web-service-0.6.2.tgz
```

升级后检查 `/api/v1/system/status` 返回的插件版本为 `0.6.2`。若运行进程仍加载旧版，重启该 DSH 实例后复查。
再检查已加载会话的 `GET /api/v1/sessions/:id` 返回实际 `data.model`，并在 WorkBuddy 中使用节点当前有效模型新建话题验证。

本版发布安装包；运行节点需安装或升级后才生效。历史任务若保存了节点已不支持的模型，需要单独重新选择有效模型，本修复不会自动改写任务配置。
