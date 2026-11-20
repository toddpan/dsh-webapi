---
id: task-2
title: '[P1] 原生 settings CAS 预览应用回滚'
status: Done
assignee: []
created_date: '2026-11-08T00:27:10.885Z'
labels: [remote-model-config, p1]
dependencies: [task-1]
priority: high
ordinal: 2000
updated_date: '2026-11-08T02:04:50Z'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
用户授权：按模块拆分并写入各模块代码仓库 backlog，按优先级依次开发测试。
源码范围：src/model-config.ts; scripts/test-model-config.mjs。设计依据：WorkBuddy docs/design-remote-model-config.md；独立代理源码/包归属 WorkBuddy Web，并在安装技能时部署到 DSH 节点。
保留现有工作树改动；不修改已安装插件或真实用户模型配置，不启动替代现有 GUI 的服务，不隐式重启客户端。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 expectedRevision 绑定节点运行代次与命名空间 revision，使用宿主队列条件写
- [x] #2 默认选择与供应商配置独立；完整校验且只改 owned 字段
- [x] #3 无 CAS 的共享 credentials set/unset 不开放；明示 unsupported 而非伪造原子性
- [x] #4 预览/操作幂等与 rollback 使用实际当前 revision；测试冲突、重启、失败及脱敏
<!-- AC:END -->

## Execution Notes

本任务由当前源码会话执行。验收记录应包含真实命令、结果和范围，不伪造 WorkBuddy 派发记录或线上部署证据。

### 2026-11-08T01:52:27Z 派发为任务
task-9828809f · mode=chat · 成员=0

### 2026-11-08T02:05Z 执行记录
结论：P1 原生 settings CAS 预览/应用/回滚已完成并全部验证通过。

改动范围（仅本仓库工作树，未触碰已安装插件与真实用户模型配置）：
- `src/model-config-native.ts`：修复 rollback 一次性槽位在「因 revision 冲突被拒绝」时被误消耗的问题——`rolledBack` 仅在写回执 status=200 时置位，被拒后调用方可携带实际当前 revision 重试（AC#4）。
- `src/index.ts`：接线 `registerNativeModelConfigRoutes`（此前模块存在但未注册，preview/apply/rollback 路由实际不可达）。
- `src/openapi.ts`：补齐 `/model-config/native/inspect`、`/model-config/preview`、`/model-config/apply`、`/model-config/rollback` 四条路由的 OpenAPI 文档（含 409/501/503 语义与 allowlist 说明）。
- `scripts/test-model-config-native.mjs`（新增）：离线回归套件，本地 tsc 编译当前 src 到一次性目录，宿主 settingsController/llm/sessionController 全部为 fixture，哨兵值断言任何密钥/错误正文不得进入响应。
- `lib/`：重新编译同步（含 model-config-native 的 js/map/d.ts 更新）。

验收对照：
- #1 inspect 返回 fence {instanceId, namespace, revision, fingerprint}；apply/rollback 写入前重读校验 fence，经每命名空间队列 serialize 后调用宿主 mutate(ns, ops, revision) 条件提交；宿主冲突（settings/conflict）→ 409 REVISION_CONFLICT。
- #2 default 与 provider 目标独立 target/namespace/allowlist（default: provider/model/reasoningEffort；provider: displayName/baseURL/api/timeoutMs）；default patch 经宿主目录完整校验（模型与推理档位必须真实存在，route-only 不猜测）；只允许 owned 字段。
- #3 credentials/apiKey/schema 等从不在 allowlist，patch credentials → 400 BAD_REQUEST；宿主缺 settingsController/llm seams 或非观察形状 → 501 NOT_SUPPORTED（fail closed）。
- #4 preview/apply/rollback 均 requestId/operationId 幂等重放；plan 一次性消费（PLAN_CONSUMED）；rollback 使用实际当前 revision（外部写入推进 revision 后旧 fence 409，携带当前 fence 成功且只还原 preview 触碰字段，继承字段用 unset）；重启（异 instanceId fence）→ 409；写入未确认 → 503 NATIVE_WRITE_UNCONFIRMED / 读回不一致 → 503 NATIVE_READBACK_UNVERIFIED；错误正文与密钥哨兵全程脱敏。

验证命令与结果：
- `npm run typecheck` → 通过
- `node scripts/test-model-config.mjs` → 21 pass / 0 fail（P0 inspect 回归不受影响）
- `node scripts/test-model-config-native.mjs` → 8 pass / 0 fail（fresh src）
- `node scripts/test-model-config-native.mjs --compiled` → 8 pass / 0 fail（跟踪的 lib/ 产物一致）

未做/边界：未安装或重启任何插件实例（遵守任务约束）；宿主真实 mutate/describe 契约以 fixture 形状为准（观察到的 agent-default-model 与 llm-pi-ai 形状），真实 DSH 节点上的联调留待安装验证阶段。

### 2026-11-08T02:04:50Z 派发执行（成功）
任务 task-9828809f · 结果=成功
The implementation for the native CAS module already exists in the working tree (`src/model-config-native.ts`). Let me verify it: typecheck, build, and run the test script.The native CAS module exists and typechecks, but AC#4 requires tests for conflict/restart/failure/redaction and there are none covering `model-config-native.ts`. Let me review the test harness pattern in the existing script to extend it.The host source isn't locally inspectable (packaged asar), so I'll test against the fixture
