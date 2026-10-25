/**
 * dsh-web-service - 会话协作状态 API（目标 / 计划模式 / 压缩）
 *
 * 把 GUI 斜杠命令的内核能力开放为 REST 接口（与 /permission 同一模式）：
 * - GET  /sessions/:id/goal    读取当前长期目标（等价 /goal 查看）
 * - POST /sessions/:id/goal    创建目标 { objective, maxGoalRounds? }
 * - PUT  /sessions/:id/goal    目标生命周期 { action: edit|pause|resume|complete|blocked|clear|disarm, ... }
 * - GET  /sessions/:id/plan    查询计划模式状态
 * - PUT  /sessions/:id/plan    进入/退出计划模式 { active }（等价 /plan 命令）
 * - POST /sessions/:id/compact 手动压缩会话历史（等价 /compact 命令）
 *
 * 宿主服务：agents（live agent 定位）、goals（GoalService）、planMode（PlanModeController）、
 * compaction（CompactionEngine.compactNow）。三者都要求目标会话在进程内处于 live 状态，
 * 持久化但未加载的会话返回 409 SESSION_NOT_LIVE（可先 prompt 一次使其加载）。
 */
import type { Context } from '@deepseek-ai/cordis';
export declare function registerCollaborationRoutes(ctx: Context, router: any): void;
