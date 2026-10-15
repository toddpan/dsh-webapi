/**
 * dsh-web-service - ask_user_question 答复桥（headless 集成）
 *
 * DSH 的 ask_user_question 工具会挂起等待 `user-questions/request` waterfall
 * 的答复者（浏览器客户端是默认答复器；REST 集成没有浏览器 → NO_PROVIDER，
 * 工具直接报错，问题永远得不到回答）。本模块在宿主侧注册一个全局答复器：
 * 挂起的问题按会话登记，经 REST 端点查询与答复：
 *   GET  /sessions/:id/questions  查询挂起的问题批次
 *   POST /sessions/:id/answers    提交答复（answers: [{id, selected, custom?}]），
 *                                 resolve 后工具以普通 tool/result 返回，会话继续。
 *
 * 已装且一致不重复语义：答复只 resolve 当前登记的批次；signal 中止（会话取消/
 * agent 释放）自动 reject 并清理。本监听器【只】接管 ALS 能归属到 REST 执行
 * 的请求；其余一律 next() 透传给其他答复器（浏览器转发器等）。切勿用
 * request.agent 反查宿主会话来归属：sessionController.list() 列出宿主全部会话，
 * GUI 会话也在其中，反查会把 GUI 提问据为己有且不调用 next()，浏览器转发器
 * 永远轮不到 —— ask_user_question UI 不显示、工具挂起直到用户点停止
 * （v0.3.6 及之前的回归缺陷，见 scripts/test-user-questions-bridge.mjs 场景 A）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from '@deepseek-ai/cordis';
import { type HttpRouter } from './router.js';
/**
 * 提交 prompt 时携带的会话上下文：waterfall 监听器从中取回 sessionId。
 * 某些 harness 版本在 REST 执行路径上 exec.agent 为 undefined，无法用
 * agent 反查归属，此时以 ALS 为准（prompt-stream/sync 执行入口统一包裹）。
 */
export declare const askSessionStorage: AsyncLocalStorage<{
    sessionId: string;
}>;
export declare function registerUserQuestionBridge(ctx: Context, router: HttpRouter): void;
