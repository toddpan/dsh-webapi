/**
 * @dsh-external/dsh-web-service - Session Management API Handlers
 */

import type { Context } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { sendJson } from './router.js'
import type { SessionCreateInput, SessionItem, SessionUpdateInput, SessionHistoryMessage } from './types.js'

export function registerSessionRoutes(ctx: Context, router: any): void {
  // 1. 查询会话列表
  router.get('/sessions', async (_req: IncomingMessage, res: ServerResponse, _params: any, query: Record<string, string>) => {
    try {
      const sessionController = ctx.get('sessionController') as any
      const workspaceRegistry = ctx.get('workspaceRegistry') as any

      let rawList: any[] = []
      if (sessionController && typeof sessionController.list === 'function') {
        const result = await sessionController.list({}, new AbortController().signal)
        rawList = result?.items || []
      }

      // 如果指定了 search 关键字
      if (query.search && query.search.trim()) {
        const kw = query.search.trim().toLowerCase()
        rawList = rawList.filter((s: any) =>
          (s.title && s.title.toLowerCase().includes(kw)) ||
          String(s.sessionId || s.id).toLowerCase().includes(kw)
        )
      }

      // 如果指定了 workspaceId 过滤
      if (query.workspaceId && workspaceRegistry) {
        const ws = workspaceRegistry.get(query.workspaceId)
        if (ws) {
          const validIds = new Set([...ws.sessionIds].map(String))
          rawList = rawList.filter((s: any) => validIds.has(String(s.sessionId || s.id)))
        } else {
          rawList = []
        }
      }

      // 构建工作区映射
      const sessionWorkspaceMap = new Map<string, string>()
      if (workspaceRegistry) {
        for (const ws of workspaceRegistry.list()) {
          for (const sid of ws.sessionIds) {
            sessionWorkspaceMap.set(String(sid), String(ws.id))
          }
        }
      }

      const items: SessionItem[] = rawList.map((s: any) => {
        const sid = String(s.sessionId || s.id)
        return {
          id: sid,
          title: s.title || 'Untitled Session',
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          lastActivityAt: s.lastActivityAt,
          workspaceId: sessionWorkspaceMap.get(sid),
          status: s.running ? 'running' : 'idle',
        }
      })

      sendJson(res, 200, { ok: true, data: items })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 2. 查询单个会话详情
  router.get('/sessions/:id', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
    try {
      const sessionController = ctx.get('sessionController') as any
      const workspaceRegistry = ctx.get('workspaceRegistry') as any
      const sessionId = params.id

      let meta: any = null
      let events: any[] = []
      if (sessionController && typeof sessionController.inspect === 'function') {
        try {
          const inspected = await sessionController.inspect(sessionId, new AbortController().signal)
          meta = inspected.meta
          events = inspected.events
        } catch {
          // fallback to live session
        }
      }

      const sessionsService = ctx.get('sessions') as any
      const liveSession = sessionsService?.get ? sessionsService.get(sessionId) : undefined
      if (liveSession) {
        meta = liveSession.header
        events = [...liveSession.events]
      }

      if (!meta) {
        sendJson(res, 404, { ok: false, error: `Session '${sessionId}' not found`, code: 'NOT_FOUND' })
        return
      }

      // 查询所属工作区
      let workspaceId: string | undefined
      if (workspaceRegistry) {
        for (const ws of workspaceRegistry.list()) {
          if ([...ws.sessionIds].map(String).includes(sessionId)) {
            workspaceId = String(ws.id)
            break
          }
        }
      }

      const agentsService = ctx.get('agents') as any
      const agent = agentsService?.get ? agentsService.get(sessionId) : undefined
      const isRunning = agent?.status === 'running'

      // 获取当前会话使用的模型
      let currentModel: any = undefined
      if (sessionController?.agents?.selectionFor && agent) {
        const selection = sessionController.agents.selectionFor(agent)?.current
        if (selection) {
          currentModel = {
            provider: selection.provider,
            model: selection.model,
            reasoningEffort: selection.reasoningEffort,
          }
        }
      }

      const item: SessionItem = {
        id: String(meta.id),
        title: meta.title || 'Untitled Session',
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        workspaceId,
        status: isRunning ? 'running' : 'idle',
        model: currentModel,
      }

      sendJson(res, 200, {
        ok: true,
        data: {
          ...item,
          eventCount: events.length,
          cwd: meta.cwd,
        },
      })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 3. 创建会话 (添加)
  router.post('/sessions', async (_req: IncomingMessage, res: ServerResponse, _params: any, _query: any, body: SessionCreateInput) => {
    try {
      const sessionController = ctx.get('sessionController') as any
      const workspaceRegistry = ctx.get('workspaceRegistry') as any

      const sessionId = body.sessionId || `session-${randomUUID()}`
      let createdSessionId = sessionId

      if (sessionController && typeof sessionController.create === 'function') {
        const createResult = await sessionController.create({
          sessionId,
          workspaceId: body.workspaceId,
          cwd: body.cwd,
          agentPreset: body.agentPreset,
        })
        createdSessionId = String(createResult.sessionId)
      } else {
        // Fallback 直接使用 agents 创建
        const agentsService = ctx.get('agents') as any
        if (!agentsService) {
          sendJson(res, 503, { ok: false, error: 'Agent service unavailable', code: 'SERVICE_UNAVAILABLE' })
          return
        }
        await agentsService.create({
          sessionId,
          meta: { cwd: body.cwd || process.cwd() },
        })
        if (body.workspaceId && workspaceRegistry) {
          const ws = workspaceRegistry.get(body.workspaceId)
          if (ws) await ws.attachSession(sessionId)
        }
      }

      // 如果指定了标题
      if (body.title && body.title.trim() && sessionController?.rename) {
        try {
          await sessionController.rename({ sessionId: createdSessionId, title: body.title.trim() })
        } catch {
          // ignore rename error on create
        }
      }

      // 如果指定了特定模型
      if (body.provider && body.model && sessionController?.selectModel) {
        try {
          await sessionController.selectModel({
            sessionId: createdSessionId,
            provider: body.provider,
            model: body.model,
            reasoningEffort: body.reasoningEffort,
          })
        } catch (e: any) {
          // 返回警告但会话仍创建成功
        }
      }

      sendJson(res, 201, {
        ok: true,
        data: {
          sessionId: createdSessionId,
          title: body.title || 'Untitled Session',
          workspaceId: body.workspaceId,
        },
      })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 4. 修改会话 (修改标题 / 修改模型)
  router.put('/sessions/:id', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, _query: any, body: SessionUpdateInput) => {
    try {
      const sessionController = ctx.get('sessionController') as any
      const sessionId = params.id

      if (!body) {
        sendJson(res, 400, { ok: false, error: 'Empty update payload', code: 'BAD_REQUEST' })
        return
      }

      const updates: Record<string, any> = {}

      // 修改标题
      if (body.title !== undefined) {
        const title = body.title.trim()
        if (sessionController && typeof sessionController.rename === 'function') {
          const renameResult = await sessionController.rename({ sessionId, title })
          updates.title = renameResult.title
        }
      }

      // 修改模型
      if (body.provider && body.model) {
        if (sessionController && typeof sessionController.selectModel === 'function') {
          const modelResult = await sessionController.selectModel({
            sessionId,
            provider: body.provider,
            model: body.model,
            reasoningEffort: body.reasoningEffort,
          })
          updates.model = modelResult
        }
      }

      sendJson(res, 200, {
        ok: true,
        data: {
          sessionId,
          ...updates,
        },
      })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 5. 删除/归档会话 (删除)
  router.delete('/sessions/:id', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
    try {
      const workspaceRegistry = ctx.get('workspaceRegistry') as any
      const sessionId = params.id

      if (workspaceRegistry && typeof workspaceRegistry.archiveSession === 'function') {
        try {
          await workspaceRegistry.archiveSession(sessionId)
        } catch (e: any) {
          // ignore if already archived or stray
        }
      }

      // 释放内存活跃的 agent
      const agentsService = ctx.get('agents') as any
      const agent = agentsService?.get ? agentsService.get(sessionId) : undefined
      if (agent && typeof agent.dispose === 'function') {
        await agent.dispose()
      }

      sendJson(res, 200, { ok: true, data: { deleted: true, sessionId } })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 6. 获取会话历史记录 (分页)
  router.get('/sessions/:id/history', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, query: Record<string, string>) => {
    try {
      const sessionController = ctx.get('sessionController') as any
      const sessionId = params.id

      const maxMessages = query.maxMessages ? parseInt(query.maxMessages, 10) : 50
      const beforeSeq = query.beforeSeq !== undefined ? parseInt(query.beforeSeq, 10) : undefined

      // 读取 events
      let events: any[] = []
      if (sessionController && typeof sessionController.inspect === 'function') {
        try {
          const inspected = await sessionController.inspect(sessionId, new AbortController().signal)
          events = inspected?.events || []
        } catch {}
      }
      if (events.length === 0) {
        const sessionsService = ctx.get('sessions') as any
        const liveSession = sessionsService?.get ? sessionsService.get(sessionId) : undefined
        if (liveSession) events = [...liveSession.events]
      }

      // 如果指定了 beforeSeq，过滤在 beforeSeq 之前
      if (beforeSeq !== undefined) {
        events = events.filter((e: any) => e.seq < beforeSeq)
      }

      // 解析提取对话消息
      const allMessages: SessionHistoryMessage[] = []
      for (const ev of events) {
        if (ev.type === 'user/message') {
          let text = ''
          const content = ev.data?.content
          if (Array.isArray(content)) {
            text = content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('\n')
          } else if (typeof content === 'string') {
            text = content
          }
          allMessages.push({
            seq: ev.seq,
            type: ev.type,
            role: 'user',
            content: text,
            time: ev.time,
          })
        } else if (ev.type === 'assistant/message') {
          let text = ''
          const msg = ev.data?.message
          if (msg && Array.isArray(msg.content)) {
            text = msg.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('\n')
          } else if (typeof ev.data?.text === 'string') {
            text = ev.data.text
          }
          allMessages.push({
            seq: ev.seq,
            type: ev.type,
            role: 'assistant',
            content: text,
            reasoning: ev.data?.reasoning,
            time: ev.time,
          })
        }
      }

      const sliced = allMessages.slice(-maxMessages)
      const hasMore = allMessages.length > maxMessages

      sendJson(res, 200, {
        ok: true,
        data: {
          sessionId,
          messages: sliced,
          hasMore,
          totalMessages: allMessages.length,
          totalEvents: events.length,
        },
      })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 7. 取消当前轮次执行
  router.post('/sessions/:id/cancel', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
    try {
      const sessionController = ctx.get('sessionController') as any
      const sessionId = params.id

      if (sessionController && typeof sessionController.cancel === 'function') {
        const cancelResult = sessionController.cancel({ sessionId })
        sendJson(res, 200, { ok: true, data: cancelResult })
        return
      }

      const agentsService = ctx.get('agents') as any
      const agent = agentsService?.get ? agentsService.get(sessionId) : undefined
      if (agent && typeof agent.cancel === 'function') {
        agent.cancel()
      }

      sendJson(res, 200, { ok: true, data: { cancelled: true, sessionId } })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })
}
