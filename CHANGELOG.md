# Changelog

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
