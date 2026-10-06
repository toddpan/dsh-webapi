/**
 * @dsh-external/dsh-web-service - ask_user_question 答复桥（headless 集成）
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
 * agent 释放）自动 reject 并清理。若同宿主存在其他答复器（浏览器），本监听器
 * 只接管能归属到 REST 会话的请求，其余 next() 透传。
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
