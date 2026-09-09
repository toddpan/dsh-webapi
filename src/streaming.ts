/**
 * @dsh-external/dsh-web-service - Streaming & Chat API Handlers
 */

import type { Context } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { initSseStream, sendJson } from './router.js'
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
      const result = await executePromptAndWait(ctx, sessionId, body)
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

    // 监听 session/event
    const unsubscribe = ctx.on('session/event', (session: any, event: any) => {
      if (String(session.id) !== sessionId) return

      try {
        if (event.type === 'assistant/chunk') {
          const chunk = event.data?.chunk
          if (chunk?.type === 'text-delta') {
            sse.send('delta', { delta: chunk.text || '', seq: event.seq })
          } else if (chunk?.type === 'reasoning-delta') {
            sse.send('reasoning', { delta: chunk.text || '', seq: event.seq })
          }
          return
        }

        switch (event.type) {
          case 'reasoning/delta':
            sse.send('reasoning', {
              delta: event.data?.delta || '',
              seq: event.seq,
            })
            break

          case 'assistant/delta':
            sse.send('delta', {
              delta: event.data?.delta || '',
              seq: event.seq,
            })
            break

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

          case 'turn/end':
            turnEnded = true
            sse.send('turn_end', {
              reason: event.data?.reason || 'completed',
              seq: event.seq,
            })
            sse.send('done', '[DONE]')
            cleanup()
            break

          case 'error':
            sse.send('error', {
              message: event.data?.message || 'Execution error',
            })
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

    // 提交 Prompt 给会话
    try {
      await submitPromptToSession(ctx, sessionId, body)
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
        const unsubscribe = ctx.on('session/event', (session: any, event: any) => {
          if (String(session.id) !== sessionId) return

          let deltaText = ''
          if (event.type === 'assistant/chunk') {
            const chunk = event.data?.chunk
            if (chunk?.type === 'text-delta') deltaText = chunk.text || ''
          } else if (event.type === 'assistant/delta') {
            deltaText = event.data?.delta || ''
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
      const result = await executePromptAndWait(ctx, sessionId, { prompt: promptText })
      const openAiResponse = {
        id: completionId,
        object: 'chat.completion',
        created: createdTime,
        model: body.model || 'dsh-model',
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
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
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
): Promise<{ content: string; reasoning?: string; toolCalls: any[] }> {
  return new Promise(async (resolve, reject) => {
    let content = ''
    let reasoning = ''
    const toolCalls: any[] = []
    let completed = false

    const timeout = setTimeout(() => {
      cleanup()
      if (!completed) {
        resolve({ content, reasoning, toolCalls })
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
      } else if (event.type === 'tool/call') {
        toolCalls.push(event.data)
      } else if (event.type === 'turn/end') {
        completed = true
        cleanup()
        resolve({
          content: content.trim(),
          reasoning: reasoning || undefined,
          toolCalls,
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
