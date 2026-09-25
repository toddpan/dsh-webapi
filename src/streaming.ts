/**
 * @dsh-external/dsh-web-service - Streaming & Chat API Handlers
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { initSseStream, sendJson } from './router.js'
import { askSessionStorage } from './user-questions.js'
import type { OpenAiChatCompletionRequest, SessionPromptInput } from './types.js'

export function registerStreamingRoutes(ctx: Context, router: any): void {
  // 1. 同步非流式对话：POST /sessions/:id/prompt
  router.post('/sessions/:id/prompt', async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, _query: any, body: SessionPromptInput) => {
    const sessionId = params.id
    if (!body || !body.prompt) {
      sendJson(res, 400, { ok: false, error: "Missing required field 'prompt'", code: 'BAD_REQUEST' })
      return
    }

    try {
      const result = await askSessionStorage.run({ sessionId }, () => executePromptAndWait(ctx, sessionId, body))
      sendJson(res, 200, { ok: true, data: result })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 2. SSE 会话流式交互接口：POST /sessions/:id/prompt-stream
  router.post('/sessions/:id/prompt-stream', async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, _query: any, body: SessionPromptInput) => {
    const sessionId = params.id
    if (!body || !body.prompt) {
      sendJson(res, 400, { ok: false, error: "Missing required field 'prompt'", code: 'BAD_REQUEST' })
      return
    }

    const sse = initSseStream(res)
    sse.send('connected', { sessionId, timestamp: Date.now() })

    let cleanedUp = false
    let turnEnded = false
    // 本 step 已推送的文本/思考量：harness 可能不发增量 chunk，只在 assistant/message 给全文，
    // 用它做差量补推，既不丢内容也不重复。
    let streamedText = ''
    let streamedReasoning = ''

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
    let ownTurn: number | undefined
    let sawTurnStart = false
    const turnOf = (event: any): number | undefined =>
      typeof event?.data?.turn === 'number' ? event.data.turn : undefined
    const isForeignTurn = (event: any): boolean => {
      if (!sawTurnStart || ownTurn === undefined) return false
      const t = turnOf(event)
      return t !== undefined && t !== ownTurn
    }

    // 监听 session/event
    const unsubscribe = ctx.on('session/event', (session: any, event: any) => {
      if (String(session.id) !== sessionId) return
      if (isForeignTurn(event)) return

      try {
        if (event.type === 'turn/start') {
          if (!sawTurnStart) {
            sawTurnStart = true
            const t = turnOf(event)
            if (t !== undefined) ownTurn = t
          }
          return
        }
        if (event.type === 'assistant/chunk') {
          const chunk = event.data?.chunk
          if (chunk?.type === 'text-delta') {
            const t = chunk.text || ''
            streamedText += t
            if (t) sse.send('delta', { delta: t, seq: event.seq })
          } else if (chunk?.type === 'reasoning-delta') {
            const t = chunk.text || ''
            streamedReasoning += t
            if (t) sse.send('reasoning', { delta: t, seq: event.seq })
          }
          return
        }

        switch (event.type) {
          case 'step/start':
            // 每个 step 是一次独立模型调用：重置差量游标
            streamedText = ''
            streamedReasoning = ''
            break

          case 'reasoning/delta':
            sse.send('reasoning', {
              delta: event.data?.delta || '',
              seq: event.seq,
            })
            break

          case 'assistant/delta': {
            const t = event.data?.delta || ''
            streamedText += t
            if (t) sse.send('delta', { delta: t, seq: event.seq })
            break
          }

          case 'tool/call':
            // DSH 核心 tool/call 载荷: { turn, step, callId, name, arguments }
            sse.send('tool_call', {
              id: event.data?.callId,
              name: event.data?.name,
              arguments: event.data?.arguments,
              seq: event.seq,
            })
            break

          case 'tool/result': {
            // DSH 核心 tool/result 载荷: { turn, step, message: { content: [{type:'tool-result', toolCallId, content, isError}] } }
            const msg = event.data?.message
            const blocks: any[] = Array.isArray(msg?.content) ? msg.content : (msg?.content !== undefined ? [{ content: msg.content }] : [])
            const flat = (c: any): string => {
              if (typeof c === 'string') return c
              if (Array.isArray(c)) return c.map((x) => (typeof x?.text === 'string' ? x.text : (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x) } catch { return String(x) } })()))).join('\n')
              try { return JSON.stringify(c ?? '') } catch { return String(c) }
            }
            const text = blocks.map((b) => flat(b?.content ?? b)).join('\n')
            sse.send('tool_result', {
              id: blocks[0]?.toolCallId,
              result: text,
              isError: blocks.some((b) => b?.isError === true) || Boolean(event.data?.error),
              seq: event.seq,
            })
            break
          }

          case 'assistant/message':
          case 'usage': {
            // harness 可能不发增量 chunk：从完整 assistant 消息补推差量文本
            if (event.type === 'assistant/message') {
              const full = extractAssistantText(event.data?.message)
              const textSuffix = takeSuffix(full.text, streamedText)
              if (textSuffix) {
                sse.send('delta', { delta: textSuffix, seq: event.seq })
                streamedText = full.text
              }
              const reasonSuffix = takeSuffix(full.reasoning, streamedReasoning)
              if (reasonSuffix) {
                sse.send('reasoning', { delta: reasonSuffix, seq: event.seq })
                streamedReasoning = full.reasoning
              }
            }
            // 透传真实 token 账本（含缓存命中），供前端展示缓存率
            const u = event.type === 'usage' ? (event.data?.usage || event.data) : event.data?.usage
            if (u && typeof u === 'object') {
              sse.send('usage', { usage: u, seq: event.seq })
            }
            break
          }

          case 'turn/end':
            // 尚未见到本轮 turn/start 就来的 turn/end：属于订阅前就已开始的旧轮次，不是本次提交的结束
            if (!sawTurnStart) break
            turnEnded = true
            sse.send('turn_end', {
              reason: event.data?.reason || 'completed',
              seq: event.seq,
            })
            sse.send('done', '[DONE]')
            cleanup()
            break

          case 'error':
            // error 是流终结事件：必须补 done 并关闭，否则消费方（等 done/关流才结束）
            // 会永远挂在打开的 SSE 上 —— 表现为「回复一直不同步」。错误后的恢复交给
            // 调用方的对账通道（history/status 轮询），本流不再服务后续事件。
            sse.send('error', {
              message: event.data?.message || 'Execution error',
            })
            sse.send('done', '[DONE]')
            cleanup()
            break
        }
      } catch {
        cleanup()
      }
    })

    function cleanup() {
      if (cleanedUp) return
      cleanedUp = true
      try {
        unsubscribe()
      } catch {}
      sse.close()
    }

    // 客户端断开处理
    req.on('close', () => {
      cleanup()
    })

    // 提交 Prompt 给会话（ALS 携带 sessionId，供 ask_user_question 答复桥归属）
    try {
      await askSessionStorage.run({ sessionId }, () => submitPromptToSession(ctx, sessionId, body))
    } catch (err: any) {
      sse.send('error', { message: `Failed to admit prompt: ${err.message}` })
      cleanup()
    }
  })

  // 3. SSE 会话事件实时广播通道：GET /sessions/:id/events
  router.get('/sessions/:id/events', async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
    const sessionId = params.id
    const sse = initSseStream(res)
    sse.send('connected', { sessionId, message: 'Subscribed to session events', timestamp: Date.now() })

    const unsubscribe = ctx.on('session/event', (session: any, event: any) => {
      if (String(session.id) !== sessionId) return
      try {
        sse.send('event', {
          seq: event.seq,
          type: event.type,
          data: event.data,
          time: event.time,
        })
      } catch {
        cleanup()
      }
    })

    let cleanedUp = false
    function cleanup() {
      if (cleanedUp) return
      cleanedUp = true
      try { unsubscribe() } catch {}
      sse.close()
    }

    req.on('close', () => {
      cleanup()
    })
  })

  // 4. OpenAI 兼容接口：POST /chat/completions
  router.post('/chat/completions', async (req: IncomingMessage, res: ServerResponse, _params: any, _query: any, body: OpenAiChatCompletionRequest) => {
    try {
      if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
        sendJson(res, 400, {
          ok: false,
          error: "Invalid request: 'messages' array is required and must not be empty",
          code: 'BAD_REQUEST',
        })
        return
      }

      // 提取最后一条用户消息
      const lastUserMsg = [...body.messages].reverse().find(m => m.role === 'user')
      if (!lastUserMsg) {
        sendJson(res, 400, { ok: false, error: 'No user message found in messages', code: 'BAD_REQUEST' })
        return
      }

      const promptText = typeof lastUserMsg.content === 'string'
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg.content)
          ? lastUserMsg.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
          : String(lastUserMsg.content)

      // 解析或获取 Session
      const sessionController = ctx.get('sessionController') as any
      let sessionId = body.sessionId

      if (!sessionId) {
        sessionId = `session-${randomUUID()}`
        if (sessionController?.create) {
          await sessionController.create({
            sessionId,
            cwd: process.cwd(),
          })
        }
      }

      // 临时指定模型（如果显式提供了 provider/model 格式）
      if (body.model && body.model.includes('/') && sessionController?.selectModel) {
        const [provider, ...modelParts] = body.model.split('/')
        const model = modelParts.join('/')
        if (provider && model) {
          try {
            await sessionController.selectModel({ sessionId, provider, model })
          } catch {}
        }
      }

      const completionId = `chatcmpl-${randomUUID()}`
      const createdTime = Math.floor(Date.now() / 1000)

      // 如果客户端请求流式 (stream: true)
      if (body.stream) {
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.flushHeaders?.()

        let cleanedUp = false
        // 本 step 已推送文本量：harness 只在 assistant/message 给全文时补推差量
        let streamedText = ''
        // 与本文件 prompt-stream 相同的 turn 归属判定：忽略订阅前旧轮次的 turn/end 与其它轮次的事件
        let ownTurn: number | undefined
        let sawTurnStart = false
        const unsubscribe = ctx.on('session/event', (session: any, event: any) => {
          if (String(session.id) !== sessionId) return
          const turnOf = (e: any): number | undefined => (typeof e?.data?.turn === 'number' ? e.data.turn : undefined)
          if (event.type === 'turn/start') {
            if (!sawTurnStart) {
              sawTurnStart = true
              const t = turnOf(event)
              if (t !== undefined) ownTurn = t
            }
            return
          }
          if (!sawTurnStart && event.type === 'turn/end') return
          if (sawTurnStart && ownTurn !== undefined) {
            const t = turnOf(event)
            if (t !== undefined && t !== ownTurn) return
          }

          let deltaText = ''
          if (event.type === 'step/start') {
            streamedText = ''
          } else if (event.type === 'assistant/chunk') {
            const chunk = event.data?.chunk
            if (chunk?.type === 'text-delta') {
              deltaText = chunk.text || ''
              streamedText += deltaText
            }
          } else if (event.type === 'assistant/delta') {
            deltaText = event.data?.delta || ''
            streamedText += deltaText
          } else if (event.type === 'assistant/message') {
            const full = extractAssistantText(event.data?.message)
            const suffix = takeSuffix(full.text, streamedText)
            if (suffix) {
              deltaText = suffix
              streamedText = full.text
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
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
          } else if (event.type === 'turn/end') {
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
            }
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
            res.write('data: [DONE]\n\n')
            cleanup()
          }
        })

        function cleanup() {
          if (cleanedUp) return
          cleanedUp = true
          try { unsubscribe() } catch {}
          res.end()
        }

        req.on('close', () => {
          cleanup()
        })

        await submitPromptToSession(ctx, sessionId, { prompt: promptText })
        return
      }

      // 非流式：执行并等待结果
      const result = await askSessionStorage.run({ sessionId }, () => executePromptAndWait(ctx, sessionId, { prompt: promptText }))
      // 透传模型真实选择（会话 request/header 的 provider/model），而不是占位字符串。
      const realModel = (await readSessionModel(ctx, sessionId)) || body.model || 'dsh-model'
      // 映射 harness 的 token 账本到 OpenAI 兼容 usage 字段；prompt_tokens 含缓存命中(PromptCache读)。
      const usage = result.usage
        ? toOpenAiUsage(result.usage)
        : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
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
      }

      const payload = JSON.stringify(openAiResponse)
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(payload)
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })
}

/** 提交 Prompt 到 Session 执行 */
async function submitPromptToSession(ctx: Context, sessionId: string, input: SessionPromptInput): Promise<void> {
  const sessionController = ctx.get('sessionController') as any
  let resolvedAgent: any = undefined

  if (sessionController && typeof sessionController.resolveAgent === 'function') {
    const result = await sessionController.resolveAgent(sessionId)
    if ('error' in result) {
      throw new Error(`Failed to resolve agent for session '${sessionId}': ${result.error?.message || result.error}`)
    }
    resolvedAgent = result.agent || result
  } else {
    const agentsService = ctx.get('agents') as any
    resolvedAgent = agentsService?.get ? agentsService.get(sessionId) : undefined
  }

  if (!resolvedAgent) {
    throw new Error(`Agent for session '${sessionId}' is not active or available`)
  }

  // 构造 User 消息内容块
  const contentBlocks: any[] = [{ type: 'text', text: input.prompt }]
  if (input.images && input.images.length > 0) {
    const attachmentsService = ctx.get('attachments') as any
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
  }

  if (input.mode === 'steer' && typeof resolvedAgent.steer === 'function') {
    resolvedAgent.steer(message)
  } else if (typeof resolvedAgent.followup === 'function') {
    resolvedAgent.followup(message)
  } else {
    throw new Error(`Agent for session '${sessionId}' does not support followup`)
  }
}

/** 执行 Prompt 并同步等待完成 */
async function executePromptAndWait(
  ctx: Context,
  sessionId: string,
  input: SessionPromptInput,
): Promise<{ content: string; reasoning?: string; toolCalls: any[]; usage?: Record<string, number> }> {
  return new Promise(async (resolve, reject) => {
    let content = ''
    let reasoning = ''
    const toolCalls: any[] = []
    let usage: Record<string, number> | undefined
    let completed = false

    const timeout = setTimeout(() => {
      cleanup()
      if (!completed) {
        resolve({ content, reasoning, toolCalls, usage })
      }
    }, input.timeoutMs || 180000)

    const unsubscribe = ctx.on('session/event', (session: any, event: any) => {
      if (String(session.id) !== sessionId) return

      if (event.type === 'assistant/chunk') {
        const chunk = event.data?.chunk
        if (chunk?.type === 'text-delta') {
          content += chunk.text || ''
        } else if (chunk?.type === 'reasoning-delta') {
          reasoning += chunk.text || ''
        }
      } else if (event.type === 'assistant/delta') {
        content += event.data?.delta || ''
      } else if (event.type === 'reasoning/delta') {
        reasoning += event.data?.delta || ''
      } else if (event.type === 'assistant/message') {
        // 从完整 assistant 消息中提取 content
        const msg = event.data?.message
        if (msg && Array.isArray(msg.content)) {
          const texts = msg.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
          if (texts) content = texts
        }
        // 记录本轮真实 token 账本（含缓存命中），供 OpenAI 兼容响应透传
        const u = event.data?.usage
        if (u && typeof u === 'object') usage = { ...u }
      } else if (event.type === 'usage') {
        const u = event.data?.usage || event.data
        if (u && typeof u === 'object') usage = { ...u }
      } else if (event.type === 'tool/call') {
        toolCalls.push(event.data)
      } else if (event.type === 'turn/end') {
        completed = true
        cleanup()
        resolve({
          content: content.trim(),
          reasoning: reasoning || undefined,
          toolCalls,
          usage,
        })
      } else if (event.type === 'error') {
        completed = true
        cleanup()
        reject(new Error(event.data?.message || 'Agent error'))
      }
    })

    function cleanup() {
      clearTimeout(timeout)
      try { unsubscribe() } catch {}
    }

    try {
      await submitPromptToSession(ctx, sessionId, input)
    } catch (err) {
      cleanup()
      reject(err)
    }
  })
}

/**
 * 解析会话当前实际使用的模型（provider/model），供 OpenAI 兼容响应透传。
 * 优先取 agent 的模型选择，否则取会话 request/header 的 config，二者都无则 undefined。
 */
async function readSessionModel(ctx: Context, sessionId: string): Promise<string | undefined> {
  try {
    const sessionController = ctx.get('sessionController') as any
    const agentsService = ctx.get('agents') as any
    const agent = agentsService?.get ? agentsService.get(sessionId) : undefined
    const selection = sessionController?.agents?.selectionFor?.(agent)?.current
    if (selection?.provider && selection?.model) return `${selection.provider}/${selection.model}`
    const sessionsService = ctx.get('sessions') as any
    const live = sessionsService?.get ? sessionsService.get(sessionId) : undefined
    const hdr = live?.requestHeader?.()
    if (hdr?.config?.provider && hdr?.config?.model) return `${hdr.config.provider}/${hdr.config.model}`
  } catch { /* fallthrough */ }
  return undefined
}

/**
 * 把 harness token 账本映射为 OpenAI 兼容 usage 字段。
 * Harness 约定 inputTokens/cacheReadTokens 已按「命中/未命中」拆分（互斥），
 * 而 OpenAI 兼容表单的 prompt_tokens 包含缓存命中，故 prompt_tokens = miss + hit。
 */
function toOpenAiUsage(usage: Record<string, number>): {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_cache_hit_tokens: number
  prompt_cache_miss_tokens: number
} {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const read = num(usage.cacheReadTokens)
  const miss = num(usage.uncachedInputTokens) || num(usage.inputTokens)
  const output = num(usage.outputTokens)
  const prompt = miss + read
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: num(usage.totalTokens) || (prompt + output),
    prompt_cache_hit_tokens: read,
    prompt_cache_miss_tokens: miss,
  }
}

/** 从 assistant 消息内容块提取正文与思考文本（兼容 text / reasoning / thinking 块）。 */
function extractAssistantText(message: any): { text: string; reasoning: string } {
  let text = ''
  let reasoning = ''
  const parts = Array.isArray(message?.content) ? message.content : []
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue
    if (p.type === 'text' && typeof p.text === 'string') text += p.text
    else if ((p.type === 'reasoning' || p.type === 'thinking') && typeof p.text === 'string') reasoning += p.text
  }
  return { text, reasoning }
}
/** 取 full 相对 streamed 的增量：已对齐只补差量；无法对齐且尚未推送过则补全量。 */
function takeSuffix(full: unknown, streamed: unknown): string {
  const f = typeof full === 'string' ? full : ''
  const s = typeof streamed === 'string' ? streamed : ''
  if (!f) return ''
  if (!s) return f
  if (f === s) return ''
  if (f.startsWith(s)) return f.slice(s.length)
  if (s.startsWith(f)) return ''
  return f
}
