/**
 * dsh-web-service - Streaming & Chat API Handlers
 */
import { randomUUID } from 'node:crypto';
import { initSseStream, sendJson } from './router.js';
import { askSessionStorage } from './user-questions.js';
export function registerStreamingRoutes(ctx, router) {
    // 1. 同步非流式对话：POST /sessions/:id/prompt
    router.post('/sessions/:id/prompt', async (req, res, params, _query, body) => {
        const sessionId = params.id;
        if (!body || !body.prompt) {
            sendJson(res, 400, { ok: false, error: "Missing required field 'prompt'", code: 'BAD_REQUEST' });
            return;
        }
        try {
            const result = await askSessionStorage.run({ sessionId }, () => executePromptAndWait(ctx, sessionId, body));
            sendJson(res, 200, { ok: true, data: result });
        }
        catch (err) {
            sendJson(res, 500, { ok: false, error: err.message });
        }
    });
    // 2. SSE 会话流式交互接口：POST /sessions/:id/prompt-stream
    router.post('/sessions/:id/prompt-stream', async (req, res, params, _query, body) => {
        const sessionId = params.id;
        if (!body || !body.prompt) {
            sendJson(res, 400, { ok: false, error: "Missing required field 'prompt'", code: 'BAD_REQUEST' });
            return;
        }
        const sse = initSseStream(res);
        sse.send('connected', { sessionId, timestamp: Date.now() });
        let cleanedUp = false;
        let turnEnded = false;
        // 本 step 已推送的文本/思考量：harness 可能不发增量 chunk，只在 assistant/message 给全文，
        // 用它做差量补推，既不丢内容也不重复。
        let streamedText = '';
        let streamedReasoning = '';
        // SSE 心跳：每 15s 注释帧，防中间层（Nginx/网关/浏览器空闲超时）在长沉默期静默掐流
        const stopHeartbeat = startSseHeartbeat(sse);
        // 停滞看门狗（与 pi-web-service 修复同语义）：不按「整轮总时长」掐断 ——
        // 持续产出（哪怕远超 5 分钟的长文本/多轮工具）永远不打断；
        // 只有持续 stallGapMs 收不到任何会话事件（真停滞）才显式报错收流。
        const stallGapMs = body.stallTimeoutMs && body.stallTimeoutMs > 0 ? body.stallTimeoutMs : 300000;
        let watchdog;
        const resetStallTimer = () => {
            if (watchdog)
                clearTimeout(watchdog);
            watchdog = setTimeout(() => {
                if (cleanedUp)
                    return;
                sse.send('error', { message: `turn stalled: no session events for ${Math.round(stallGapMs / 1000)}s` });
                sse.send('done', '[DONE]');
                cleanup();
            }, stallGapMs);
            if (typeof watchdog.unref === 'function')
                watchdog.unref();
        };
        resetStallTimer();
        /**
         * 本次流所属的 turn。
         *
         * 事件订阅是**会话级**的：若订阅时该会话上一轮尚未收尾（prompt 被排队 / steer 到运行中回合），
         * 旧轮次的 `turn/end` 会被误当作本轮结束 —— 流提前关闭，调用方拿到半截内容却以为完成了。
         * 因此：
         *   - `turn/start` 之前到达的 `turn/end` 一定不属于本次提交（它的 turn/start 早于订阅），直接忽略；
         *   - 一旦认领了自己的 turn，后续其它 turn 的事件（含 turn/end）一律不转发；
         *   - steer 模式下不会出现新的 `turn/start`，此时 ownTurn 保持 undefined，行为与旧版一致。
         */
        let ownTurn;
        let sawTurnStart = false;
        const turnOf = (event) => typeof event?.data?.turn === 'number' ? event.data.turn : undefined;
        const isForeignTurn = (event) => {
            if (!sawTurnStart || ownTurn === undefined)
                return false;
            const t = turnOf(event);
            return t !== undefined && t !== ownTurn;
        };
        // 监听 session/event
        const unsubscribe = ctx.on('session/event', (session, event) => {
            if (String(session.id) !== sessionId)
                return;
            if (isForeignTurn(event))
                return;
            try {
                // 任何属于本会话的事件到达都证明流转活着：重置停滞看门狗
                resetStallTimer();
                if (event.type === 'turn/start') {
                    if (!sawTurnStart) {
                        sawTurnStart = true;
                        const t = turnOf(event);
                        if (t !== undefined)
                            ownTurn = t;
                    }
                    return;
                }
                if (event.type === 'assistant/chunk') {
                    const chunk = event.data?.chunk;
                    if (chunk?.type === 'text-delta') {
                        const t = chunk.text || '';
                        streamedText += t;
                        if (t)
                            sse.send('delta', { delta: t, seq: event.seq });
                    }
                    else if (chunk?.type === 'reasoning-delta') {
                        const t = chunk.text || '';
                        streamedReasoning += t;
                        if (t)
                            sse.send('reasoning', { delta: t, seq: event.seq });
                    }
                    return;
                }
                switch (event.type) {
                    case 'step/start':
                        // 每个 step 是一次独立模型调用：重置差量游标
                        streamedText = '';
                        streamedReasoning = '';
                        break;
                    case 'reasoning/delta':
                        sse.send('reasoning', {
                            delta: event.data?.delta || '',
                            seq: event.seq,
                        });
                        break;
                    case 'assistant/delta': {
                        const t = event.data?.delta || '';
                        streamedText += t;
                        if (t)
                            sse.send('delta', { delta: t, seq: event.seq });
                        break;
                    }
                    case 'tool/call':
                        // DSH 核心 tool/call 载荷: { turn, step, callId, name, arguments }
                        sse.send('tool_call', {
                            id: event.data?.callId,
                            name: event.data?.name,
                            arguments: event.data?.arguments,
                            seq: event.seq,
                        });
                        break;
                    case 'tool/result': {
                        // DSH 核心 tool/result 载荷: { turn, step, message: { content: [{type:'tool-result', toolCallId, content, isError}] } }
                        const msg = event.data?.message;
                        const blocks = Array.isArray(msg?.content) ? msg.content : (msg?.content !== undefined ? [{ content: msg.content }] : []);
                        const flat = (c) => {
                            if (typeof c === 'string')
                                return c;
                            if (Array.isArray(c))
                                return c.map((x) => (typeof x?.text === 'string' ? x.text : (typeof x === 'string' ? x : (() => { try {
                                    return JSON.stringify(x);
                                }
                                catch {
                                    return String(x);
                                } })()))).join('\n');
                            try {
                                return JSON.stringify(c ?? '');
                            }
                            catch {
                                return String(c);
                            }
                        };
                        const text = blocks.map((b) => flat(b?.content ?? b)).join('\n');
                        sse.send('tool_result', {
                            id: blocks[0]?.toolCallId,
                            result: text,
                            isError: blocks.some((b) => b?.isError === true) || Boolean(event.data?.error),
                            seq: event.seq,
                        });
                        break;
                    }
                    case 'assistant/message':
                    case 'usage': {
                        // harness 可能不发增量 chunk：从完整 assistant 消息补推差量文本
                        if (event.type === 'assistant/message') {
                            const full = extractAssistantText(event.data?.message);
                            const textSuffix = takeSuffix(full.text, streamedText);
                            if (textSuffix) {
                                sse.send('delta', { delta: textSuffix, seq: event.seq });
                                streamedText = full.text;
                            }
                            const reasonSuffix = takeSuffix(full.reasoning, streamedReasoning);
                            if (reasonSuffix) {
                                sse.send('reasoning', { delta: reasonSuffix, seq: event.seq });
                                streamedReasoning = full.reasoning;
                            }
                        }
                        // 透传真实 token 账本（含缓存命中），供前端展示缓存率
                        const u = event.type === 'usage' ? (event.data?.usage || event.data) : event.data?.usage;
                        if (u && typeof u === 'object') {
                            sse.send('usage', { usage: u, seq: event.seq });
                        }
                        break;
                    }
                    case 'turn/end':
                        // 尚未见到本轮 turn/start 就来的 turn/end：属于订阅前就已开始的旧轮次，不是本次提交的结束
                        if (!sawTurnStart)
                            break;
                        turnEnded = true;
                        sse.send('turn_end', {
                            reason: event.data?.reason || 'completed',
                            seq: event.seq,
                        });
                        sse.send('done', '[DONE]');
                        cleanup();
                        break;
                    case 'error':
                        // error 是流终结事件：必须补 done 并关闭，否则消费方（等 done/关流才结束）
                        // 会永远挂在打开的 SSE 上 —— 表现为「回复一直不同步」。错误后的恢复交给
                        // 调用方的对账通道（history/status 轮询），本流不再服务后续事件。
                        sse.send('error', {
                            message: event.data?.message || 'Execution error',
                        });
                        sse.send('done', '[DONE]');
                        cleanup();
                        break;
                }
            }
            catch (err) {
                // 不能静默吞掉：任何 handler 内部错误都要让调用方可见，否则表现为
                // 「connected 之后流无声消失」且无从排查（pi-web-service 排障教训）。
                try {
                    sse.send('error', { message: `stream handler error: ${err?.message || err}` });
                }
                catch { /* 响应已结束 */ }
                sse.send('done', '[DONE]');
                cleanup();
            }
        });
        function cleanup() {
            if (cleanedUp)
                return;
            cleanedUp = true;
            try {
                unsubscribe();
            }
            catch { }
            try {
                stopHeartbeat();
            }
            catch { }
            if (watchdog) {
                clearTimeout(watchdog);
            }
            sse.close();
        }
        // 客户端断开处理
        req.on('close', () => {
            cleanup();
        });
        // 提交 Prompt 给会话（ALS 携带 sessionId，供 ask_user_question 答复桥归属）
        try {
            await askSessionStorage.run({ sessionId }, () => submitPromptToSession(ctx, sessionId, body));
        }
        catch (err) {
            sse.send('error', { message: `Failed to admit prompt: ${err.message}` });
            cleanup();
        }
    });
    // 3. SSE 会话事件实时广播通道：GET /sessions/:id/events
    router.get('/sessions/:id/events', async (req, res, params) => {
        const sessionId = params.id;
        const sse = initSseStream(res);
        sse.send('connected', { sessionId, message: 'Subscribed to session events', timestamp: Date.now() });
        // SSE 心跳：会话空闲（无事件）期间保活，防中间层静默掐流
        const stopHeartbeat = startSseHeartbeat(sse);
        const unsubscribe = ctx.on('session/event', (session, event) => {
            if (String(session.id) !== sessionId)
                return;
            try {
                sse.send('event', {
                    seq: event.seq,
                    type: event.type,
                    data: event.data,
                    time: event.time,
                });
            }
            catch {
                cleanup();
            }
        });
        let cleanedUp = false;
        function cleanup() {
            if (cleanedUp)
                return;
            cleanedUp = true;
            try {
                unsubscribe();
            }
            catch { }
            try {
                stopHeartbeat();
            }
            catch { }
            sse.close();
        }
        req.on('close', () => {
            cleanup();
        });
    });
    // 4. OpenAI 兼容接口：POST /chat/completions
    router.post('/chat/completions', async (req, res, _params, _query, body) => {
        try {
            if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
                sendJson(res, 400, {
                    ok: false,
                    error: "Invalid request: 'messages' array is required and must not be empty",
                    code: 'BAD_REQUEST',
                });
                return;
            }
            // 提取最后一条用户消息
            const lastUserMsg = [...body.messages].reverse().find(m => m.role === 'user');
            if (!lastUserMsg) {
                sendJson(res, 400, { ok: false, error: 'No user message found in messages', code: 'BAD_REQUEST' });
                return;
            }
            const promptText = typeof lastUserMsg.content === 'string'
                ? lastUserMsg.content
                : Array.isArray(lastUserMsg.content)
                    ? lastUserMsg.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
                    : String(lastUserMsg.content);
            // 解析或获取 Session
            const sessionController = ctx.get('sessionController');
            let sessionId = body.sessionId;
            if (!sessionId) {
                sessionId = `session-${randomUUID()}`;
                if (sessionController?.create) {
                    await sessionController.create({
                        sessionId,
                        cwd: process.cwd(),
                    });
                }
            }
            // 临时指定模型（如果显式提供了 provider/model 格式）
            if (body.model && body.model.includes('/') && sessionController?.selectModel) {
                const [provider, ...modelParts] = body.model.split('/');
                const model = modelParts.join('/');
                if (provider && model) {
                    try {
                        await sessionController.selectModel({ sessionId, provider, model });
                    }
                    catch { }
                }
            }
            const completionId = `chatcmpl-${randomUUID()}`;
            const createdTime = Math.floor(Date.now() / 1000);
            // 如果客户端请求流式 (stream: true)
            if (body.stream) {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.flushHeaders?.();
                let cleanedUp = false;
                // 本 step 已推送文本量：harness 只在 assistant/message 给全文时补推差量
                let streamedText = '';
                // 与本文件 prompt-stream 相同的 turn 归属判定：忽略订阅前旧轮次的 turn/end 与其它轮次的事件
                let ownTurn;
                let sawTurnStart = false;
                const unsubscribe = ctx.on('session/event', (session, event) => {
                    if (String(session.id) !== sessionId)
                        return;
                    const turnOf = (e) => (typeof e?.data?.turn === 'number' ? e.data.turn : undefined);
                    if (event.type === 'turn/start') {
                        if (!sawTurnStart) {
                            sawTurnStart = true;
                            const t = turnOf(event);
                            if (t !== undefined)
                                ownTurn = t;
                        }
                        return;
                    }
                    if (!sawTurnStart && event.type === 'turn/end')
                        return;
                    if (sawTurnStart && ownTurn !== undefined) {
                        const t = turnOf(event);
                        if (t !== undefined && t !== ownTurn)
                            return;
                    }
                    let deltaText = '';
                    if (event.type === 'step/start') {
                        streamedText = '';
                    }
                    else if (event.type === 'assistant/chunk') {
                        const chunk = event.data?.chunk;
                        if (chunk?.type === 'text-delta') {
                            deltaText = chunk.text || '';
                            streamedText += deltaText;
                        }
                    }
                    else if (event.type === 'assistant/delta') {
                        deltaText = event.data?.delta || '';
                        streamedText += deltaText;
                    }
                    else if (event.type === 'assistant/message') {
                        const full = extractAssistantText(event.data?.message);
                        const suffix = takeSuffix(full.text, streamedText);
                        if (suffix) {
                            deltaText = suffix;
                            streamedText = full.text;
                        }
                    }
                    if (deltaText) {
                        const chunk = {
                            id: completionId,
                            object: 'chat.completion.chunk',
                            created: createdTime,
                            model: body.model || 'dsh-model',
                            choices: [
                                {
                                    index: 0,
                                    delta: { content: deltaText },
                                    finish_reason: null,
                                },
                            ],
                        };
                        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    }
                    else if (event.type === 'turn/end') {
                        const finalChunk = {
                            id: completionId,
                            object: 'chat.completion.chunk',
                            created: createdTime,
                            model: body.model || 'dsh-model',
                            choices: [
                                {
                                    index: 0,
                                    delta: {},
                                    finish_reason: 'stop',
                                },
                            ],
                        };
                        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                        res.write('data: [DONE]\n\n');
                        cleanup();
                    }
                });
                // SSE 注释帧心跳：长思考/工具执行沉默期保活（注释行由标准 SSE/OpenAI 解析器忽略）
                const stopHeartbeat = startSseHeartbeat({ ping: () => { if (!res.writableEnded)
                        res.write(': ping\n\n'); } });
                function cleanup() {
                    if (cleanedUp)
                        return;
                    cleanedUp = true;
                    try {
                        unsubscribe();
                    }
                    catch { }
                    try {
                        stopHeartbeat();
                    }
                    catch { }
                    res.end();
                }
                req.on('close', () => {
                    cleanup();
                });
                // ALS 携带 sessionId，供 ask_user_question 答复桥归属（与另外三个入口保持一致）
                try {
                    await askSessionStorage.run({ sessionId }, () => submitPromptToSession(ctx, sessionId, { prompt: promptText }));
                }
                catch (err) {
                    // 头已发出后 sendJson 是 no-op —— 必须用 OpenAI 错误块收流，否则客户端永远挂在空流上
                    res.write(`data: ${JSON.stringify({ error: { message: `Failed to admit prompt: ${err?.message || err}`, type: 'server_error' } })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    cleanup();
                }
                return;
            }
            // 非流式：执行并等待结果
            const result = await askSessionStorage.run({ sessionId }, () => executePromptAndWait(ctx, sessionId, { prompt: promptText }));
            // 透传模型真实选择（会话 request/header 的 provider/model），而不是占位字符串。
            const realModel = (await readSessionModel(ctx, sessionId)) || body.model || 'dsh-model';
            // 映射 harness 的 token 账本到 OpenAI 兼容 usage 字段；prompt_tokens 含缓存命中(PromptCache读)。
            const usage = result.usage
                ? toOpenAiUsage(result.usage)
                : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
            const openAiResponse = {
                id: completionId,
                object: 'chat.completion',
                created: createdTime,
                model: realModel,
                sessionId,
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: result.content,
                            reasoning_content: result.reasoning,
                        },
                        finish_reason: 'stop',
                    },
                ],
                usage,
            };
            const payload = JSON.stringify(openAiResponse);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(payload);
        }
        catch (err) {
            sendJson(res, 500, { ok: false, error: err.message });
        }
    });
}
/** 提交 Prompt 到 Session 执行 */
async function submitPromptToSession(ctx, sessionId, input) {
    const sessionController = ctx.get('sessionController');
    let resolvedAgent = undefined;
    if (sessionController && typeof sessionController.resolveAgent === 'function') {
        const result = await sessionController.resolveAgent(sessionId);
        if ('error' in result) {
            throw new Error(`Failed to resolve agent for session '${sessionId}': ${result.error?.message || result.error}`);
        }
        resolvedAgent = result.agent || result;
    }
    else {
        const agentsService = ctx.get('agents');
        resolvedAgent = agentsService?.get ? agentsService.get(sessionId) : undefined;
    }
    if (!resolvedAgent) {
        throw new Error(`Agent for session '${sessionId}' is not active or available`);
    }
    // 构造 User 消息内容块
    const contentBlocks = [{ type: 'text', text: input.prompt }];
    if (input.images && input.images.length > 0) {
        const attachmentsService = ctx.get('attachments');
        for (const img of input.images) {
            if (attachmentsService) {
                // 如果有附件系统则存入
            }
        }
    }
    const message = {
        id: `msg-${randomUUID()}`,
        role: 'user',
        source: { kind: 'user' },
        content: contentBlocks,
    };
    if (input.mode === 'steer' && typeof resolvedAgent.steer === 'function') {
        resolvedAgent.steer(message);
    }
    else if (typeof resolvedAgent.followup === 'function') {
        resolvedAgent.followup(message);
    }
    else {
        throw new Error(`Agent for session '${sessionId}' does not support followup`);
    }
}
/** 执行 Prompt 并同步等待完成 */
async function executePromptAndWait(ctx, sessionId, input) {
    return new Promise(async (resolve, reject) => {
        let content = '';
        let reasoning = '';
        const toolCalls = [];
        let usage;
        let completed = false;
        // 停滞看门狗（与 pi-web-service 修复同语义）：不按「整轮总耗时」掐断 ——
        // 持续产出的轮次（长文本流式生成、多轮工具调用）哪怕远超 180 秒也能完整跑完；
        // 只有持续 stallGapMs 收不到任何会话事件（模型/工具真停滞）才显式报错。
        // 兼容旧入参：timeoutMs 继续生效，语义由「总时长上限」改为「停滞阈值」，默认 180s。
        const stallGapMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : 180000;
        let watchdog;
        const disarmStall = () => {
            if (watchdog) {
                clearTimeout(watchdog);
                watchdog = undefined;
            }
        };
        const armStall = () => {
            disarmStall();
            watchdog = setTimeout(() => {
                if (completed)
                    return;
                completed = true;
                cleanup();
                reject(new Error(`turn stalled: no session events for ${Math.round(stallGapMs / 1000)}s (prompt abandoned)`));
            }, stallGapMs);
            if (typeof watchdog.unref === 'function')
                watchdog.unref();
        };
        const unsubscribe = ctx.on('session/event', (session, event) => {
            if (String(session.id) !== sessionId)
                return;
            // 每个事件都在证明轮次仍活着：重置停滞计时（含 tool/call、usage 等非文本事件）
            armStall();
            if (event.type === 'assistant/chunk') {
                const chunk = event.data?.chunk;
                if (chunk?.type === 'text-delta') {
                    content += chunk.text || '';
                }
                else if (chunk?.type === 'reasoning-delta') {
                    reasoning += chunk.text || '';
                }
            }
            else if (event.type === 'assistant/delta') {
                content += event.data?.delta || '';
            }
            else if (event.type === 'reasoning/delta') {
                reasoning += event.data?.delta || '';
            }
            else if (event.type === 'assistant/message') {
                // 从完整 assistant 消息中提取 content
                const msg = event.data?.message;
                if (msg && Array.isArray(msg.content)) {
                    const texts = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
                    if (texts)
                        content = texts;
                }
                // 记录本轮真实 token 账本（含缓存命中），供 OpenAI 兼容响应透传
                const u = event.data?.usage;
                if (u && typeof u === 'object')
                    usage = { ...u };
            }
            else if (event.type === 'usage') {
                const u = event.data?.usage || event.data;
                if (u && typeof u === 'object')
                    usage = { ...u };
            }
            else if (event.type === 'tool/call') {
                toolCalls.push(event.data);
            }
            else if (event.type === 'turn/end') {
                completed = true;
                cleanup();
                resolve({
                    content: content.trim(),
                    reasoning: reasoning || undefined,
                    toolCalls,
                    usage,
                });
            }
            else if (event.type === 'error') {
                completed = true;
                cleanup();
                reject(new Error(event.data?.message || 'Agent error'));
            }
        });
        function cleanup() {
            disarmStall();
            try {
                unsubscribe();
            }
            catch { }
        }
        armStall();
        try {
            await submitPromptToSession(ctx, sessionId, input);
        }
        catch (err) {
            completed = true;
            cleanup();
            reject(err);
        }
    });
}
/**
 * 解析会话当前实际使用的模型（provider/model），供 OpenAI 兼容响应透传。
 * 优先取 agent 的模型选择，否则取会话 request/header 的 config，二者都无则 undefined。
 */
async function readSessionModel(ctx, sessionId) {
    try {
        const sessionController = ctx.get('sessionController');
        const agentsService = ctx.get('agents');
        const agent = agentsService?.get ? agentsService.get(sessionId) : undefined;
        const selection = sessionController?.agents?.selectionFor?.(agent)?.current;
        if (selection?.provider && selection?.model)
            return `${selection.provider}/${selection.model}`;
        const sessionsService = ctx.get('sessions');
        const live = sessionsService?.get ? sessionsService.get(sessionId) : undefined;
        const hdr = live?.requestHeader?.();
        if (hdr?.config?.provider && hdr?.config?.model)
            return `${hdr.config.provider}/${hdr.config.model}`;
    }
    catch { /* fallthrough */ }
    return undefined;
}
/**
 * 把 harness token 账本映射为 OpenAI 兼容 usage 字段。
 * Harness 约定 inputTokens/cacheReadTokens 已按「命中/未命中」拆分（互斥），
 * 而 OpenAI 兼容表单的 prompt_tokens 包含缓存命中，故 prompt_tokens = miss + hit。
 */
function toOpenAiUsage(usage) {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const read = num(usage.cacheReadTokens);
    const miss = num(usage.uncachedInputTokens) || num(usage.inputTokens);
    const output = num(usage.outputTokens);
    const prompt = miss + read;
    return {
        prompt_tokens: prompt,
        completion_tokens: output,
        total_tokens: num(usage.totalTokens) || (prompt + output),
        prompt_cache_hit_tokens: read,
        prompt_cache_miss_tokens: miss,
    };
}
/** 从 assistant 消息内容块提取正文与思考文本（兼容 text / reasoning / thinking 块）。 */
function extractAssistantText(message) {
    let text = '';
    let reasoning = '';
    const parts = Array.isArray(message?.content) ? message.content : [];
    for (const p of parts) {
        if (!p || typeof p !== 'object')
            continue;
        if (p.type === 'text' && typeof p.text === 'string')
            text += p.text;
        else if ((p.type === 'reasoning' || p.type === 'thinking') && typeof p.text === 'string')
            reasoning += p.text;
    }
    return { text, reasoning };
}
/**
 * SSE 注释帧心跳：每 intervalMs 写一个 `: ping` 帧，长沉默期（思考/工具执行/排队）
 * 保活连接，防中间代理与网关因空闲超时静默掐断长流。
 * 标准 SSE 与 OpenAI SDK 解析器都会忽略注释行。
 */
function startSseHeartbeat(sse, intervalMs = 15000) {
    const timer = setInterval(() => {
        try {
            sse.ping();
        }
        catch { /* 响应已结束，最终由 cleanup 收尾 */ }
    }, intervalMs);
    if (typeof timer.unref === 'function')
        timer.unref();
    return () => {
        try {
            clearInterval(timer);
        }
        catch { }
    };
}
/** 取 full 相对 streamed 的增量：已对齐只补差量；无法对齐且尚未推送过则补全量。 */
function takeSuffix(full, streamed) {
    const f = typeof full === 'string' ? full : '';
    const s = typeof streamed === 'string' ? streamed : '';
    if (!f)
        return '';
    if (!s)
        return f;
    if (f === s)
        return '';
    if (f.startsWith(s))
        return f.slice(s.length);
    if (s.startsWith(f))
        return '';
    return f;
}
//# sourceMappingURL=streaming.js.map