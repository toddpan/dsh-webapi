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

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson } from './router.js'

/** 定位会话的 live agent（进程内已加载）；不存在返回 undefined。 */
function liveAgent(ctx: Context, sessionId: string): any {
  const agents = ctx.get('agents') as any
  return agents?.get ? agents.get(sessionId) : undefined
}

function notLive(res: ServerResponse, sessionId: string): boolean {
  sendJson(res, 409, {
    ok: false,
    error: 'session ' + sessionId + ' is not live in this process (not loaded). Prompt it once first, then retry.',
    code: 'SESSION_NOT_LIVE',
  })
  return true
}

/** GoalService 异常 → HTTP；其余原样抛出。 */
function sendGoalError(res: ServerResponse, error: any): void {
  const message = String(error?.message || error || 'goal operation failed')
  sendJson(res, 409, { ok: false, error: message, code: 'GOAL_STATE_CONFLICT' })
}

/** 解析目标引用：显式 body.ref 优先，否则取当前目标的 { id, revision }。宿主实现为同步，await 兼容 async 包装。 */
async function resolveGoalRef(ctx: Context, agent: any, body: any): Promise<{ id: string; revision: number } | undefined> {
  const ref = body?.ref
  if (ref && typeof ref.id === 'string' && Number.isInteger(ref.revision) && ref.revision > 0) {
    return { id: ref.id, revision: ref.revision }
  }
  const goals = ctx.get('goals') as any
  const view = await goals?.get?.(agent)
  if (!view || typeof view.id !== 'string' || !Number.isInteger(view.revision)) return undefined
  return { id: view.id, revision: view.revision }
}

export function registerCollaborationRoutes(ctx: Context, router: any): void {
  // ---------- 目标（/goal 命令） ----------
  router.get('/sessions/:id/goal', async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
    const agent = liveAgent(ctx, params.id)
    if (!agent) return notLive(res, params.id)
    const goals = ctx.get('goals') as any
    if (!goals?.get) {
      return sendJson(res, 501, { ok: false, error: 'goals service unavailable on this host', code: 'SERVICE_UNAVAILABLE' })
    }
    try {
      const view = await goals.get(agent)
      sendJson(res, 200, { ok: true, data: { goal: view ?? null } })
    } catch (error) {
      sendGoalError(res, error)
    }
  })

  router.post('/sessions/:id/goal', async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, _query: any, body: any) => {
    const agent = liveAgent(ctx, params.id)
    if (!agent) return notLive(res, params.id)
    const goals = ctx.get('goals') as any
    if (!goals?.create) {
      return sendJson(res, 501, { ok: false, error: 'goals service unavailable on this host', code: 'SERVICE_UNAVAILABLE' })
    }
    const objective = typeof body?.objective === 'string' ? body.objective.trim() : ''
    if (!objective) {
      return sendJson(res, 400, { ok: false, error: 'objective is required', code: 'INVALID_INPUT' })
    }
    const request: Record<string, unknown> = { objective }
    if (body?.maxGoalRounds !== undefined) {
      if (!Number.isInteger(body.maxGoalRounds) || body.maxGoalRounds <= 0) {
        return sendJson(res, 400, { ok: false, error: 'maxGoalRounds must be a positive integer', code: 'INVALID_INPUT' })
      }
      request.maxGoalRounds = body.maxGoalRounds
    }
    try {
      const view = await goals.create(agent, request)
      sendJson(res, 201, { ok: true, data: { goal: view } })
    } catch (error) {
      sendGoalError(res, error)
    }
  })

  router.put('/sessions/:id/goal', async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, _query: any, body: any) => {
    const agent = liveAgent(ctx, params.id)
    if (!agent) return notLive(res, params.id)
    const goals = ctx.get('goals') as any
    if (!goals?.get) {
      return sendJson(res, 501, { ok: false, error: 'goals service unavailable on this host', code: 'SERVICE_UNAVAILABLE' })
    }
    const action = String(body?.action || '')
    try {
      if (action === 'disarm') {
        // 仅撤销本进程的自动续跑授权，不改持久状态
        const view = goals.disarm ? await goals.disarm(agent) : await goals.get(agent)
        return sendJson(res, 200, { ok: true, data: { goal: view ?? null } })
      }
      const ref = await resolveGoalRef(ctx, agent, body)
      if (!ref) {
        return sendJson(res, 404, { ok: false, error: 'no current goal on this session', code: 'GOAL_NOT_FOUND' })
      }
      let view: any
      switch (action) {
        case 'edit': {
          if (!goals.edit) throw new Error('edit unsupported')
          const request: Record<string, unknown> = {}
          if (typeof body?.objective === 'string' && body.objective.trim()) request.objective = body.objective.trim()
          if (body?.maxGoalRounds !== undefined) {
            if (!Number.isInteger(body.maxGoalRounds) || body.maxGoalRounds <= 0) {
              return sendJson(res, 400, { ok: false, error: 'maxGoalRounds must be a positive integer', code: 'INVALID_INPUT' })
            }
            request.maxGoalRounds = body.maxGoalRounds
          }
          if (!Object.keys(request).length) {
            return sendJson(res, 400, { ok: false, error: 'edit requires objective and/or maxGoalRounds', code: 'INVALID_INPUT' })
          }
          view = await goals.edit(agent, ref, request)
          break
        }
        case 'pause':
          view = await goals.pause(agent, ref)
          break
        case 'resume':
          view = await goals.resume(agent, ref)
          break
        case 'complete':
          view = await goals.complete(agent, ref)
          break
        case 'blocked': {
          const reason = body?.blockedReason
          const code = typeof reason?.code === 'string' && reason.code.trim() ? reason.code.trim() : ''
          const message = typeof reason?.message === 'string' && reason.message.trim() ? reason.message.trim() : ''
          if (!code || !message) {
            return sendJson(res, 400, { ok: false, error: 'blockedReason { code, message } is required', code: 'INVALID_INPUT' })
          }
          view = await goals.block(agent, ref, { code, message })
          break
        }
        case 'clear': {
          const cleared = goals.clear ? await goals.clear(agent, ref) : undefined
          return sendJson(res, 200, { ok: true, data: { goal: null, cleared: cleared ?? ref } })
        }
        default:
          return sendJson(res, 400, {
            ok: false,
            error: 'action must be one of edit | pause | resume | complete | blocked | clear | disarm',
            code: 'INVALID_INPUT',
          })
      }
      sendJson(res, 200, { ok: true, data: { goal: view } })
    } catch (error) {
      sendGoalError(res, error)
    }
  })

  // ---------- 计划模式（/plan 命令） ----------
  router.get('/sessions/:id/plan', async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
    const agent = liveAgent(ctx, params.id)
    if (!agent) return notLive(res, params.id)
    const planMode = ctx.get('planMode') as any
    if (!planMode?.get) {
      return sendJson(res, 501, { ok: false, error: 'planMode service unavailable on this host', code: 'SERVICE_UNAVAILABLE' })
    }
    const state = planMode.get(agent)
    sendJson(res, 200, { ok: true, data: { active: !!state?.active, pending: !!state?.pending } })
  })

  router.put('/sessions/:id/plan', async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, _query: any, body: any) => {
    const agent = liveAgent(ctx, params.id)
    if (!agent) return notLive(res, params.id)
    const planMode = ctx.get('planMode') as any
    if (!planMode?.set) {
      return sendJson(res, 501, { ok: false, error: 'planMode service unavailable on this host', code: 'SERVICE_UNAVAILABLE' })
    }
    if (typeof body?.active !== 'boolean') {
      return sendJson(res, 400, { ok: false, error: 'active (boolean) is required', code: 'INVALID_INPUT' })
    }
    // 'committed' 立即生效；'queued' 排队到下一个步边界；'noop' 已是目标状态；
    // 'cancelled' 表示排队意图被取消（如步边界被拒）
    const state = planMode.set(agent, body.active)
    const current = planMode.get(agent)
    sendJson(res, 200, { ok: true, data: { active: !!current?.active, pending: !!current?.pending, transition: state } })
  })

  // ---------- 压缩（/compact 命令） ----------
  router.post('/sessions/:id/compact', async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
    const agent = liveAgent(ctx, params.id)
    if (!agent) return notLive(res, params.id)
    const compaction = ctx.get('compaction') as any
    if (!compaction?.compactNow) {
      return sendJson(res, 501, { ok: false, error: 'compaction service unavailable on this host', code: 'SERVICE_UNAVAILABLE' })
    }
    try {
      const result = await compaction.compactNow(agent, new AbortController().signal)
      if (result === null) {
        return sendJson(res, 200, { ok: true, data: { compacted: false, message: 'no compactable history yet' } })
      }
      sendJson(res, 200, { ok: true, data: { compacted: true, result } })
    } catch (error) {
      const err = error as any
      const code = typeof err?.code === 'string' ? err.code : ''
      const known: Record<string, string> = {
        busy: 'compaction unavailable: another compaction is active or the agent is not idle',
        cancelled: 'compaction cancelled',
        changed: 'the history selected for compaction changed before replacement; conversation unchanged',
        summary: 'compaction could not produce a useful summary; conversation unchanged',
        commit: 'compaction did not finish cleanly; inspect session state before retrying',
        persistence: 'compaction finished, but the session could not be saved',
      }
      if (code && known[code]) {
        return sendJson(res, 409, { ok: false, error: known[code], code: 'COMPACTION_' + code.toUpperCase() })
      }
      throw error
    }
  })
}
