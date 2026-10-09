/**
 * dsh-web-service - Session Management API Handlers
 */
import type { Context } from '@deepseek-ai/cordis';
import type { WebServiceConfig } from './types.js';
export interface SessionStatsResult {
    turns: number;
    steps: number;
    llmMs: number;
    toolMs: number;
    ttftMs: number;
    ttftSteps: number;
    decodeMs: number;
    decodeTokens: number;
    usage: {
        /** 未命中缓存的计费输入 token（harness TokenUsage.inputTokens） */
        inputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        outputTokens: number;
    };
}
/**
 * 持久事件日志 → 会话级实时统计，字段语义对齐 harness 的
 * `@deepseek-ai/dsh-session-stats` 投影与 token-meter 账本：
 *  - steps 计 `step/end`（步骤生命周期权威事件，完成/失败/取消都会落一条）；
 *  - turns 为出现过分步闭合 turn 的去重数；
 *  - llmMs = step/start → assistant/message 墙钟；
 *  - 首 token = step/start 后首个非空 delta 块（assistant/chunk），跨 step 内 llm/retry 仍有效；
 *  - decode 仅统计同时带 usage.outputTokens 的步（首 token → assistant/message）；
 *  - toolMs 按 callId 配对 tool/call → tool/result；
 *  - usage 为各步 assistant/message.usage（以及独立 usage 事件）的账本总和。
 * 时间戳缺失的事件只跳过自身时间贡献，不影响其他统计。
 */
export declare function foldSessionStats(events: any[]): SessionStatsResult;
/** 会话任务清单条目（对齐 harness `@deepseek-ai/dsh-tool-todo` 的 TodoItem）。 */
export interface SessionTodoItem {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
}
export interface SessionTodosResult {
    /** 当前任务清单（todo_write 整表快照；新一轮开始后清空，与 harness todos 投影同语义） */
    todos: SessionTodoItem[];
    /** 最近一次清单更新时间 */
    updatedAt: number | null;
    /** 当前（或最后一轮）turn 的开始时间 */
    turnStartedAt: number | null;
    /** 当前（或最后一轮）turn 的结束时间；未结束为 null */
    turnEndedAt: number | null;
    /** 事件日志中最后一条带时间戳事件的时间 */
    lastEventAt: number | null;
    /** 仅按事件日志推断的运行态（caller 可用 live agent 状态覆盖） */
    running: boolean;
    /** 运行时长：运行中 = now - turnStartedAt；已结束 = 最后一轮 turn 墙钟 */
    elapsedMs: number;
    /** 事件日志中出现过的 turn 数（含无 step 的空轮） */
    turns: number;
}
/**
 * 持久事件日志 → 会话任务清单与运行时长。
 *  - 清单：`todo/write` 整表替换（last-write-wins），`turn/start` 清空
 *    —— 与 harness `todos` 投影完全一致（turn/end 保留上一轮清单可见）；
 *  - 运行时长：最后一个 turn 边界决定（turn/start 未闭合 = 运行中）。
 * 时间戳缺失的事件只跳过自身时间贡献，不影响其他字段。
 */
export declare function foldSessionTodos(events: any[], now?: number): SessionTodosResult;
export declare function registerSessionRoutes(ctx: Context, router: any, config: WebServiceConfig): void;
type PermFail = {
    error: string;
    status: number;
    code: string;
};
export interface SessionPermissionView {
    sessionId: string;
    /** 当前生效 preset（与 `/permission` 命令同口径；不匹配任何 preset 时为 custom） */
    preset: string;
    /** 当前沙箱模式：read-only / workspace-write / danger-full-access */
    sandbox?: string;
    /** 当前审批策略：ask / never 等 */
    approval?: string;
    /** 可切换的 preset 名 */
    available: string[];
}
export declare function readSessionPermission(ctx: Context, sessionId: string): Promise<SessionPermissionView | PermFail>;
/**
 * 切换会话运行权限：与 `/permission <preset>` 命令完全同一写路径——
 * presets.apply 记录 permission/preset 并按需写 sandbox/mode；审批策略经 approval.setPolicy
 * 切换（会向下一步注入一条「策略已变更」消息，与 GUI 切换行为一致）。
 */
export declare function applySessionPermission(ctx: Context, sessionId: string, rawPreset: string): Promise<SessionPermissionView | PermFail>;
export {};
