/**
 * @dsh-external/dsh-web-service - Workspace Management API Handlers
 */

import type { Context } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson } from './router.js'
import type { WorkspaceCreateInput, WorkspaceItem, WorkspaceUpdateInput } from './types.js'

export function registerWorkspaceRoutes(ctx: Context, router: any): void {
  // 1. 查询所有工作区
  router.get('/workspaces', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const registry = ctx.get('workspaceRegistry') as any
      if (!registry) {
        sendJson(res, 503, { ok: false, error: 'Workspace registry is not available', code: 'SERVICE_UNAVAILABLE' })
        return
      }

      const list = registry.list()
      const items: WorkspaceItem[] = list.map((ws: any) => ({
        id: String(ws.id),
        path: ws.path,
        title: ws.title,
        sessionIds: [...ws.sessionIds].map(String),
        createdAt: ws.createdAt,
        updatedAt: ws.updatedAt,
      }))

      sendJson(res, 200, { ok: true, data: items })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 2. 查询单个工作区
  router.get('/workspaces/:id', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
    try {
      const registry = ctx.get('workspaceRegistry') as any
      if (!registry) {
        sendJson(res, 503, { ok: false, error: 'Workspace registry is not available', code: 'SERVICE_UNAVAILABLE' })
        return
      }

      const ws = registry.get(params.id)
      if (!ws) {
        sendJson(res, 404, { ok: false, error: `Workspace '${params.id}' not found`, code: 'NOT_FOUND' })
        return
      }

      const item: WorkspaceItem = {
        id: String(ws.id),
        path: ws.path,
        title: ws.title,
        sessionIds: [...ws.sessionIds].map(String),
        createdAt: ws.createdAt,
        updatedAt: ws.updatedAt,
      }

      sendJson(res, 200, { ok: true, data: item })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 3. 创建工作区 (添加)
  router.post('/workspaces', async (_req: IncomingMessage, res: ServerResponse, _params: any, _query: any, body: WorkspaceCreateInput) => {
    try {
      const registry = ctx.get('workspaceRegistry') as any
      if (!registry) {
        sendJson(res, 503, { ok: false, error: 'Workspace registry is not available', code: 'SERVICE_UNAVAILABLE' })
        return
      }

      if (!body || !body.path) {
        sendJson(res, 400, { ok: false, error: "Missing required parameter 'path'", code: 'BAD_REQUEST' })
        return
      }

      // 如果已存在则直接返回
      let ws = await registry.resolveByPath(body.path)
      let created = false
      if (!ws) {
        ws = await registry.create(body.path)
        created = true
      }

      if (body.title && body.title.trim() && body.title !== ws.title) {
        await ws.setTitle(body.title.trim())
      }

      const item: WorkspaceItem = {
        id: String(ws.id),
        path: ws.path,
        title: ws.title,
        sessionIds: [...ws.sessionIds].map(String),
        createdAt: ws.createdAt,
        updatedAt: ws.updatedAt,
      }

      sendJson(res, created ? 201 : 200, { ok: true, data: item })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 4. 修改工作区 (修改)
  router.put('/workspaces/:id', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, _query: any, body: WorkspaceUpdateInput) => {
    try {
      const registry = ctx.get('workspaceRegistry') as any
      if (!registry) {
        sendJson(res, 503, { ok: false, error: 'Workspace registry is not available', code: 'SERVICE_UNAVAILABLE' })
        return
      }

      const ws = registry.get(params.id)
      if (!ws) {
        sendJson(res, 404, { ok: false, error: `Workspace '${params.id}' not found`, code: 'NOT_FOUND' })
        return
      }

      if (!body || typeof body.title !== 'string' || !body.title.trim()) {
        sendJson(res, 400, { ok: false, error: "Missing or invalid parameter 'title'", code: 'BAD_REQUEST' })
        return
      }

      const newTitle = body.title.trim()
      await ws.setTitle(newTitle)

      const item: WorkspaceItem = {
        id: String(ws.id),
        path: ws.path,
        title: ws.title,
        sessionIds: [...ws.sessionIds].map(String),
        createdAt: ws.createdAt,
        updatedAt: ws.updatedAt,
      }

      sendJson(res, 200, { ok: true, data: item })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 5. 删除工作区 (删除)
  router.delete('/workspaces/:id', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
    try {
      const registry = ctx.get('workspaceRegistry') as any
      if (!registry) {
        sendJson(res, 503, { ok: false, error: 'Workspace registry is not available', code: 'SERVICE_UNAVAILABLE' })
        return
      }

      const ws = registry.get(params.id)
      if (!ws) {
        sendJson(res, 404, { ok: false, error: `Workspace '${params.id}' not found`, code: 'NOT_FOUND' })
        return
      }

      const success = await registry.delete(ws.id)
      sendJson(res, 200, { ok: true, data: { deleted: success, id: params.id } })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 6. 查询工作区下的所有会话
  router.get('/workspaces/:id/sessions', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
    try {
      const registry = ctx.get('workspaceRegistry') as any
      if (!registry) {
        sendJson(res, 503, { ok: false, error: 'Workspace registry is not available', code: 'SERVICE_UNAVAILABLE' })
        return
      }

      const ws = registry.get(params.id)
      if (!ws) {
        sendJson(res, 404, { ok: false, error: `Workspace '${params.id}' not found`, code: 'NOT_FOUND' })
        return
      }

      const sessionController = ctx.get('sessionController') as any
      let summaries: any[] = []
      if (sessionController && typeof sessionController.list === 'function') {
        const listVal = await sessionController.list({}, new AbortController().signal)
        summaries = listVal?.items || []
      }

      const sessionIds = new Set([...ws.sessionIds].map(String))
      const matched = summaries.filter((s: any) => sessionIds.has(String(s.id)))

      sendJson(res, 200, {
        ok: true,
        data: {
          workspaceId: String(ws.id),
          workspaceTitle: ws.title,
          sessions: matched.map((s: any) => ({
            id: String(s.id),
            title: s.title,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            lastActivityAt: s.lastActivityAt,
          })),
        },
      })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })
}
