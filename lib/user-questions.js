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
import { randomUUID } from 'node:crypto';
import { sendJson } from './router.js';
/**
 * 提交 prompt 时携带的会话上下文：waterfall 监听器从中取回 sessionId。
 * 某些 harness 版本在 REST 执行路径上 exec.agent 为 undefined，无法用
 * agent 反查归属，此时以 ALS 为准（prompt-stream/sync 执行入口统一包裹）。
 */
export const askSessionStorage = new AsyncLocalStorage();
const pendings = new Map();
/** 上限防泄漏：单会话最多同时挂起的批次 */
const MAX_BATCHES_PER_SESSION = 8;
function normalizeQuestions(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw.map((q) => {
        const multi = q?.multiSelect !== undefined ? Boolean(q.multiSelect) : Boolean(q?.multi_select);
        return {
            id: String(q?.id ?? ''),
            question: String(q?.question ?? ''),
            ...(q?.header !== undefined ? { header: String(q.header) } : {}),
            ...(Array.isArray(q?.options) ? { options: q.options } : {}),
            multiSelect: multi,
        };
    });
}
export function registerUserQuestionBridge(ctx, router) {
    // 全局答复器：global hook 同时兼容无 agent 与 agent-scoped 两种 waterfall 派发。
    // 事件名不在本插件链接的类型 augment 里，运行时以字符串派发（cordis _hooks 按名存取）。
    // 关键：waterfall 只读派发方自己上下文上的 hooks。UserQuestionService 用它的安装 ctx
    // 派发 'user-questions/request'，因此监听器必须注册到同一个 ctx（服务实例的 .ctx），
    // 注册在本插件 ctx 上的 hooks 对该分发不可见。
    const uqService = ctx.get('userQuestions');
    const bridgeCtx = uqService?.ctx || ctx;
    bridgeCtx.on('user-questions/request', async function (request, next) {
        const questions = normalizeQuestions(request?.questions);
        if (!questions.length)
            return next();
        // 归属会话：ALS 优先（REST 执行入口包裹，精确）；否则用 request.agent 反查；再不行透传
        let scopeKey = askSessionStorage.getStore()?.sessionId || null;
        if (scopeKey === null && request?.agent !== undefined) {
            try {
                const sessionController = ctx.get('sessionController');
                const agentsService = ctx.get('agents');
                if (sessionController?.list && agentsService?.get) {
                    const listed = await sessionController.list({}, new AbortController().signal);
                    for (const item of listed?.items || []) {
                        const sid = String(item.sessionId || item.id);
                        if (agentsService.get(sid) === request.agent) {
                            scopeKey = sid;
                            break;
                        }
                    }
                }
            }
            catch { /* fallthrough */ }
        }
        if (scopeKey === null) {
            // 无法归属到 REST 可达的会话（如子 agent）→ 透传给其他答复器
            return next();
        }
        const batchId = 'batch-' + randomUUID();
        const list = pendings.get(scopeKey) ?? [];
        if (list.length >= MAX_BATCHES_PER_SESSION) {
            // 挂起过多：拒绝最早的，避免堆积
            const oldest = list.shift();
            if (oldest)
                oldest.reject(new Error('too many pending question batches'));
        }
        return await new Promise((resolve, reject) => {
            const batch = {
                batchId,
                questions,
                resolve: (answer) => {
                    cleanup();
                    resolve(answer);
                },
                reject: (err) => {
                    cleanup();
                    reject(err);
                },
                at: Date.now(),
                onAbort: () => {
                    cleanup();
                    reject(new Error('ask_user_question aborted before the user answered'));
                },
            };
            const cleanup = () => {
                const arr = pendings.get(scopeKey) || [];
                const idx = arr.indexOf(batch);
                if (idx >= 0)
                    arr.splice(idx, 1);
                if (arr.length === 0)
                    pendings.delete(scopeKey);
                request?.signal?.removeEventListener?.('abort', batch.onAbort);
            };
            request?.signal?.addEventListener?.('abort', batch.onAbort, { once: true });
            list.push(batch);
            pendings.set(scopeKey, list);
        });
    }, { global: true, prepend: true });
    // ---- 查询挂起的问题批次 ----
    router.get('/sessions/:id/questions', async (_req, res, params) => {
        const sessionId = params.id;
        const list = pendings.get(sessionId) || [];
        sendJson(res, 200, {
            ok: true,
            data: {
                sessionId,
                bridge: 'v0.1.7-als2',
                count: list.length,
                batches: list.map((b) => ({ batchId: b.batchId, at: b.at, questions: b.questions })),
            },
        });
    });
    // ---- 提交答复 ----
    router.post('/sessions/:id/answers', async (_req, res, params, _query, body) => {
        const sessionId = params.id;
        const list = pendings.get(sessionId) || [];
        if (list.length === 0) {
            return sendJson(res, 409, { ok: false, error: '该会话当前没有挂起的问题', code: 'NO_PENDING_QUESTION' });
        }
        const answers = Array.isArray(body?.answers) ? body.answers : [];
        if (answers.length === 0) {
            return sendJson(res, 400, { ok: false, error: 'answers 不能为空', code: 'BAD_REQUEST' });
        }
        const normalized = [];
        for (const a of answers) {
            if (!a || typeof a.id !== 'string' || !a.id) {
                return sendJson(res, 400, { ok: false, error: 'answers[].id 缺失', code: 'BAD_REQUEST' });
            }
            if (!Array.isArray(a.selected)) {
                return sendJson(res, 400, { ok: false, error: `answers[${a.id}].selected 必须是字符串数组`, code: 'BAD_REQUEST' });
            }
            normalized.push({
                id: a.id,
                selected: a.selected.map((x) => String(x)),
                ...(typeof a.custom === 'string' && a.custom !== '' ? { custom: a.custom } : {}),
            });
        }
        let batch;
        if (typeof body?.batchId === 'string' && body.batchId) {
            batch = list.find((b) => b.batchId === body.batchId);
            if (!batch)
                return sendJson(res, 404, { ok: false, error: `批次 ${body.batchId} 不存在或已答复`, code: 'NOT_FOUND' });
        }
        else {
            batch = list[0];
        }
        // 覆盖所有被问的问题：缺失的题按空答复补齐（对齐 harness 语义：答案集合回应全部问题）
        for (const q of batch.questions) {
            if (!normalized.some((a) => a.id === q.id)) {
                normalized.push({ id: q.id, selected: [] });
            }
        }
        batch.resolve({ answers: normalized });
        sendJson(res, 200, { ok: true, data: { sessionId, batchId: batch.batchId, answered: normalized.length } });
    });
}
//# sourceMappingURL=user-questions.js.map