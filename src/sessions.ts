/**
 * dsh-web-service - Session Management API Handlers
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { sendJson } from './router.js'
import { discoverSkills, resolveSkillRoot } from './skill-utils.js'
import type { WebServiceConfig } from './types.js'
import type { SessionCreateInput, SessionItem, SessionUpdateInput, SessionHistoryMessage } from './types.js'

/**
 * 防御式快照 live session 的事件日志：不同 DSH 核心版本里 `sessions.get()`
 * 返回的记录结构不同（Session 实例的 events 是 getter；某些版本是包装记录，
 * events 可能缺失或非数组）。任何形态异常都不能让 GET /sessions/:id 500，
 * 否则调用方（如 WorkBuddy）会误判会话丢失而重建，导致多轮上下文清零。
 */
function snapshotLiveEvents(liveSession: any, fallback: any[]): any[] {
  const ev = liveSession?.events
  if (Array.isArray(ev)) return ev.slice()
  if (ev && typeof ev[Symbol.iterator] === 'function') {
    try { return [...ev] } catch { /* fallthrough */ }
  }
  return fallback
}

/** 读取会话完整持久事件日志（sessionController.inspect 优先，live session 兜底）。 */
async function loadSessionEvents(ctx: Context, sessionId: string): Promise<any[]> {
  const sessionController = ctx.get('sessionController') as any
  let events: any[] = []
  if (sessionController && typeof sessionController.inspect === 'function') {
    try {
      const inspected = await sessionController.inspect(sessionId, new AbortController().signal)
      events = inspected?.events || []
    } catch { /* fallthrough to live session */ }
  }
  if (events.length === 0) {
    const sessionsService = ctx.get('sessions') as any
    const liveSession = sessionsService?.get ? sessionsService.get(sessionId) : undefined
    if (liveSession) events = snapshotLiveEvents(liveSession, events)
  }
  return events
}

function finiteNonNegative(v: any): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

/** 会话级 agentPreset 运行时记录（宿主会话元数据不可读时的 GET 回读兜底；进程内存级）。 */
const sessionPresetMemo = new Map<string, string>()

/**
 * 尽力对运行中会话应用模式预设：探测宿主 sessionController / agentPresets 服务上的
 * 运行时应用能力（不同宿主版本能力不定，方法名/签名都无法从类型确认）。没有可用能力
 * 或调用失败都返回 applied:false 而不报错——preset 的持久化语义由上层（WorkBuddy
 * 任务级 agentPreset）兜底，下轮建会话必然生效。
 */
async function applySessionAgentPreset(ctx: Context, sessionId: string, preset: string): Promise<{ applied: boolean; reason?: string }> {
  if (!preset) return { applied: false, reason: 'preset-cleared' }
  const sessionController = ctx.get('sessionController') as any
  for (const method of ['selectPreset', 'applyPreset', 'setPreset', 'applyAgentPreset']) {
    if (sessionController && typeof sessionController[method] === 'function') {
      try {
        await sessionController[method]({ sessionId, agentPreset: preset, preset })
        return { applied: true }
      } catch (e: any) {
        return { applied: false, reason: e?.message || `${method} failed` }
      }
    }
  }
  const presetsService = ctx.get('agentPresets') as any
  for (const method of ['applySession', 'applyToSession']) {
    if (presetsService && typeof presetsService[method] === 'function') {
      try {
        await presetsService[method](sessionId, preset)
        return { applied: true }
      } catch (e: any) {
        return { applied: false, reason: e?.message || `${method} failed` }
      }
    }
  }
  return { applied: false, reason: 'host-not-supported' }
}

function eventTime(ev: any): number | null {
  return finiteNonNegative(ev?.time) ? ev.time : null
}

/**
 * 是否为携带非空首 token 的流块（对齐 harness session-stats 投影的 isTokenDelta）。
 * assistant/chunk 载荷: { turn, step, chunk: { type: 'text-delta'|'reasoning-delta', text }
 *   | { type: 'tool-call-delta', argumentsDelta?, name? } | ... }
 */
function isTokenDeltaChunk(chunk: any): boolean {
  if (!chunk || typeof chunk !== 'object') return false
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof chunk.text === 'string' && chunk.text !== ''
    case 'tool-call-delta':
      return (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta !== '')
        || chunk.name !== undefined
    default:
      return false
  }
}

export interface SessionStatsResult {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
  usage: {
    /** 未命中缓存的计费输入 token（harness TokenUsage.inputTokens） */
    inputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    outputTokens: number
  }
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
export function foldSessionStats(events: any[]): SessionStatsResult {
  const out: SessionStatsResult = {
    turns: 0, steps: 0, llmMs: 0, toolMs: 0,
    ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  }
  const turnsSeen = new Set<number>()
  // 当前打开的 step 边界；message 组装后置 null，step/end 再兜底清理
  let openStep: { startTime: number | null; firstTokenTime: number | null } | null = null
  const pendingCalls = new Map<string, number>()
  // 旧版核心可能以独立 usage 事件记账；只要日志里有带 usage 的 assistant/message，
  // 就不重复计入独立 usage 事件，避免账本双算。
  const hasMessageUsage = (events || []).some(
    (ev: any) => ev?.type === 'assistant/message' && ev?.data?.usage && typeof ev.data.usage === 'object',
  )

  const closeStep = () => { openStep = null }

  for (const ev of events || []) {
    const t = eventTime(ev)
    switch (ev?.type) {
      case 'step/start': {
        closeStep()
        openStep = { startTime: t, firstTokenTime: null }
        break
      }
      case 'assistant/chunk': {
        if (openStep && openStep.firstTokenTime === null && t !== null
          && isTokenDeltaChunk(ev.data?.chunk)) {
          openStep.firstTokenTime = t
        }
        break
      }
      case 'assistant/message': {
        if (openStep && openStep.startTime !== null && t !== null) {
          out.llmMs += Math.max(0, t - openStep.startTime)
        }
        // 首 token 延迟只在消息组装（步正常走完模型调用）时计入，取消步不计
        if (openStep && openStep.startTime !== null && openStep.firstTokenTime !== null && t !== null) {
          out.ttftMs += Math.max(0, openStep.firstTokenTime - openStep.startTime)
          out.ttftSteps += 1
        }
        if (openStep && openStep.firstTokenTime !== null && t !== null) {
          const usage = ev.data?.usage
          if (usage && typeof usage === 'object' && finiteNonNegative(usage.outputTokens)) {
            out.decodeMs += Math.max(0, t - openStep.firstTokenTime)
            out.decodeTokens += usage.outputTokens
          }
        }
        // token 账本累加（billed input = 未缓存输入 + 缓存读 + 缓存写）
        const usage = ev.data?.usage
        if (usage && typeof usage === 'object') {
          if (finiteNonNegative(usage.inputTokens)) out.usage.inputTokens += usage.inputTokens
          if (finiteNonNegative(usage.cacheReadTokens)) out.usage.cacheReadTokens += usage.cacheReadTokens
          if (finiteNonNegative(usage.cacheWriteTokens)) out.usage.cacheWriteTokens += usage.cacheWriteTokens
          if (finiteNonNegative(usage.outputTokens)) out.usage.outputTokens += usage.outputTokens
        }
        closeStep()
        break
      }
      case 'step/end': {
        out.steps += 1
        if (finiteNonNegative(ev.data?.turn)) turnsSeen.add(ev.data.turn)
        closeStep()
        break
      }
      case 'tool/call': {
        const callId = ev.data?.callId
        if (typeof callId === 'string' && callId && t !== null) pendingCalls.set(callId, t)
        break
      }
      case 'tool/result': {
        const callId = ev.data?.message?.content?.find?.((c: any) => c?.type === 'tool-result')?.toolCallId
          ?? ev.data?.callId
        const start = typeof callId === 'string' ? pendingCalls.get(callId) : undefined
        if (start !== undefined && t !== null) {
          out.toolMs += Math.max(0, t - start)
          pendingCalls.delete(callId)
        }
        break
      }
      case 'usage': {
        // 旧版核心的独立 usage 记账事件（新版在 assistant/message.usage 上）
        if (!hasMessageUsage) {
          const u = ev.data?.usage || ev.data
          if (u && typeof u === 'object') {
            if (finiteNonNegative(u.inputTokens)) out.usage.inputTokens += u.inputTokens
            if (finiteNonNegative(u.cacheReadTokens)) out.usage.cacheReadTokens += u.cacheReadTokens
            if (finiteNonNegative(u.cacheWriteTokens)) out.usage.cacheWriteTokens += u.cacheWriteTokens
            if (finiteNonNegative(u.outputTokens)) out.usage.outputTokens += u.outputTokens
          }
        }
        break
      }
      default:
      break
    }
  }

  out.turns = turnsSeen.size
  return out
}

/** 会话任务清单条目（对齐 harness `@deepseek-ai/dsh-tool-todo` 的 TodoItem）。 */
export interface SessionTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface SessionTodosResult {
  /** 当前任务清单（todo_write 整表快照；新一轮开始后清空，与 harness todos 投影同语义） */
  todos: SessionTodoItem[]
  /** 最近一次清单更新时间 */
  updatedAt: number | null
  /** 当前（或最后一轮）turn 的开始时间 */
  turnStartedAt: number | null
  /** 当前（或最后一轮）turn 的结束时间；未结束为 null */
  turnEndedAt: number | null
  /** 事件日志中最后一条带时间戳事件的时间 */
  lastEventAt: number | null
  /** 仅按事件日志推断的运行态（caller 可用 live agent 状态覆盖） */
  running: boolean
  /** 运行时长：运行中 = now - turnStartedAt；已结束 = 最后一轮 turn 墙钟 */
  elapsedMs: number
  /** 事件日志中出现过的 turn 数（含无 step 的空轮） */
  turns: number
}

/** 规整模型写入的清单：丢弃空内容、未知状态回落 pending（对齐 harness 的闭合三态）。 */
function normalizeTodos(raw: any): SessionTodoItem[] {
  if (!Array.isArray(raw)) return []
  const out: SessionTodoItem[] = []
  for (const item of raw) {
    const content = typeof item?.content === 'string' ? item.content.trim() : ''
    if (!content) continue
    const status: SessionTodoItem['status'] = item?.status === 'in_progress' || item?.status === 'completed'
      ? item.status
      : 'pending'
    out.push({ content, status })
  }
  return out
}

/**
 * 持久事件日志 → 会话任务清单与运行时长。
 *  - 清单：`todo/write` 整表替换（last-write-wins），`turn/start` 清空
 *    —— 与 harness `todos` 投影完全一致（turn/end 保留上一轮清单可见）；
 *  - 运行时长：最后一个 turn 边界决定（turn/start 未闭合 = 运行中）。
 * 时间戳缺失的事件只跳过自身时间贡献，不影响其他字段。
 */
export function foldSessionTodos(events: any[], now: number = Date.now()): SessionTodosResult {
  const out: SessionTodosResult = {
    todos: [], updatedAt: null, turnStartedAt: null, turnEndedAt: null,
    lastEventAt: null, running: false, elapsedMs: 0, turns: 0,
  }
  const turnsSeen = new Set<number>()
  for (const ev of events || []) {
    const t = eventTime(ev)
    if (t !== null) out.lastEventAt = out.lastEventAt === null ? t : Math.max(out.lastEventAt, t)
    switch (ev?.type) {
      case 'turn/start': {
        // 新一轮开始即清空上一轮清单（与 harness 投影同语义）
        out.todos = []
        out.updatedAt = null
        out.turnStartedAt = t
        out.turnEndedAt = null
        if (finiteNonNegative(ev.data?.turn)) turnsSeen.add(ev.data.turn)
        break
      }
      case 'turn/end': {
        out.turnEndedAt = t
        if (finiteNonNegative(ev.data?.turn)) turnsSeen.add(ev.data.turn)
        break
      }
      case 'todo/write': {
        out.todos = normalizeTodos(ev.data?.todos)
        out.updatedAt = t
        break
      }
      default:
        break
    }
  }
  out.turns = turnsSeen.size
  out.running = out.turnStartedAt !== null && out.turnEndedAt === null
  if (out.running && out.turnStartedAt !== null) {
    out.elapsedMs = Math.max(0, now - out.turnStartedAt)
  } else if (out.turnStartedAt !== null && out.turnEndedAt !== null) {
    out.elapsedMs = Math.max(0, out.turnEndedAt - out.turnStartedAt)
  }
  return out
}

/** live agent 运行态（权威）：返回 undefined 表示查不到（调用方回退事件推断）。 */
function liveRunningState(ctx: Context, sessionId: string): boolean | undefined {
  const agentsService = ctx.get('agents') as any
  const agent = agentsService?.get ? agentsService.get(sessionId) : undefined
  if (agent && typeof agent.status === 'string') return agent.status === 'running'
  return undefined
}

export function registerSessionRoutes(ctx: Context, router: any, config: WebServiceConfig): void {
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
        meta = liveSession.header ?? meta
        events = snapshotLiveEvents(liveSession, events)
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
        agentPreset: (meta as any)?.agentPreset || sessionPresetMemo.get(String(meta.id)),
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

      // 记录建会话时的模式预设（GET /sessions/:id 回读兜底）
      if (body.agentPreset && String(body.agentPreset).trim()) {
        sessionPresetMemo.set(createdSessionId, String(body.agentPreset).trim())
      }

      // 如果指定了特定模型
      if (body.provider && body.model && sessionController?.selectModel) {
        try {
          // harness 的 selectModel 会无条件把选择持久化为部署全局默认；
          // API 建会话属会话级选择，先记住原默认，设置后立即恢复，避免劫持
          const defaultModelService = ctx.get('agentDefaultModel') as any
          const previousDefault =
            defaultModelService && typeof defaultModelService.currentSelection === 'function'
              ? defaultModelService.currentSelection()
              : undefined
          await sessionController.selectModel({
            sessionId: createdSessionId,
            provider: body.provider,
            model: body.model,
            reasoningEffort: body.reasoningEffort,
          })
          if (
            previousDefault &&
            defaultModelService &&
            typeof defaultModelService.saveSelection === 'function'
          ) {
            try {
              await defaultModelService.saveSelection(previousDefault)
            } catch (restoreErr: any) {
              console.warn('[dsh-web-service] restore previous default model failed:', restoreErr?.message)
            }
          }
        } catch (e: any) {
          // 返回警告但会话仍创建成功
        }
      }

      // 建会话即设定运行权限（原生 permissionPresets；失败不影响会话创建）
      let permission: SessionPermissionView | undefined
      if (body.permission && String(body.permission).trim()) {
        try {
          const r = await applySessionPermission(ctx, createdSessionId, String(body.permission).trim())
          if (!('error' in r)) permission = r
        } catch { /* ignore */ }
      }

      sendJson(res, 201, {
        ok: true,
        data: {
          permission,
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

      // 修改模型（provider+model 成对修改；仅 reasoningEffort 时与当前 selection 合并，支持单独调推理强度）
      if ((body.provider && body.model) || body.reasoningEffort) {
        if (sessionController && typeof sessionController.selectModel === 'function') {
          let provider = body.provider
          let model = body.model
          if ((!provider || !model) && body.reasoningEffort) {
            // 单独调强度：读当前 selection 合并，避免把模型选择清掉
            const agentsService = ctx.get('agents') as any
            const agent = agentsService?.get ? agentsService.get(sessionId) : undefined
            const current =
              agent && sessionController.agents?.selectionFor
                ? sessionController.agents.selectionFor(agent)?.current
                : undefined
            if (!current?.provider || !current?.model) {
              sendJson(res, 400, {
                ok: false,
                error: '会话尚无模型选择记录，无法单独修改推理强度（请连同 provider/model 一起传）',
                code: 'NO_MODEL_SELECTION',
              })
              return
            }
            provider = current.provider
            model = current.model
          }
          const modelResult = await sessionController.selectModel({
            sessionId,
            provider: provider as string,
            model: model as string,
            reasoningEffort: body.reasoningEffort,
          })
          updates.model = modelResult
        }
      }

      // 模式预设：宿主支持运行时应用则立即生效；否则仅记录并返回 applied:false（上层任务级持久化兜底）
      if (body.agentPreset !== undefined) {
        const preset = String(body.agentPreset || '').trim()
        if (preset) sessionPresetMemo.set(sessionId, preset)
        else sessionPresetMemo.delete(sessionId)
        updates.preset = { id: preset || undefined, ...(await applySessionAgentPreset(ctx, sessionId, preset)) }
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
        if (liveSession) events = snapshotLiveEvents(liveSession, events)
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

  // 6.5 会话实时统计（轮/步/LLM 与工具耗时/首 token/吞吐/缓存命中/token 账本）
  router.get('/sessions/:id/stats', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
    try {
      const sessionId = params.id
      const events = await loadSessionEvents(ctx, sessionId)
      const stats = foldSessionStats(events)
      sendJson(res, 200, {
        ok: true,
        data: {
          sessionId,
          ...stats,
          // 计费输入 = 未缓存输入 + 缓存读 + 缓存写（对齐 harness billedInputTokens）
          billedInputTokens: stats.usage.inputTokens + stats.usage.cacheReadTokens + stats.usage.cacheWriteTokens,
        },
      })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 6.6 会话任务清单（todo_write 投影）+ 运行时长（当前/最后一轮 turn 墙钟）
  // 供三方控制台（如 OneNat WorkBuddy）在聊天窗口渲染「任务」面板：清单条目 + N 进行中 · M 待处理 + 运行时长。
  // 运行态以 live agent 状态为权威（事件流中断/进程重启后未闭合的 turn 不会误报运行中）。
  router.get('/sessions/:id/todos', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
    try {
      const sessionId = params.id
      const events = await loadSessionEvents(ctx, sessionId)
      const now = Date.now()
      const result = foldSessionTodos(events, now)
      const liveRunning = liveRunningState(ctx, sessionId)
      const running = liveRunning === undefined ? result.running : liveRunning
      let elapsedMs = 0
      if (running && result.turnStartedAt !== null) {
        elapsedMs = Math.max(0, now - result.turnStartedAt)
      } else if (result.turnStartedAt !== null && result.turnEndedAt !== null) {
        elapsedMs = Math.max(0, result.turnEndedAt - result.turnStartedAt)
      }
      sendJson(res, 200, {
        ok: true,
        data: {
          sessionId,
          ...result,
          running,
          elapsedMs,
          counts: {
            completed: result.todos.filter((x) => x.status === 'completed').length,
            inProgress: result.todos.filter((x) => x.status === 'in_progress').length,
            pending: result.todos.filter((x) => x.status === 'pending').length,
          },
          serverTime: now,
        },
      })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) })
    }
  })

  // 6.5 会话作用域技能目录（对齐 harness skills/list：按会话 cwd 解析技能根，供输入框 "/" 候选）
  // 装载语义在宿主核心：用户消息中的空白符边界 /name 手势（tool-skill pre-step）会把
  // 技能正文注入模型上下文，本接口只负责给出可选清单与元数据。
  router.get('/sessions/:id/skills', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, query: Record<string, string>) => {
    try {
      const sessionId = params.id

      // 会话 cwd：inspect meta 优先，live session header 兜底
      let cwd: string | undefined
      const sessionController = ctx.get('sessionController') as any
      if (sessionController && typeof sessionController.inspect === 'function') {
        try {
          const inspected = await sessionController.inspect(sessionId, new AbortController().signal)
          cwd = inspected?.meta?.cwd
        } catch { /* fallthrough */ }
      }
      if (!cwd) {
        const sessionsService = ctx.get('sessions') as any
        const liveSession = sessionsService?.get ? sessionsService.get(sessionId) : undefined
        cwd = liveSession?.header?.cwd || liveSession?.cwd
      }

      const resolved = resolveSkillRoot(query.root || 'user-dsh', cwd, config.customSkillDirs || [], config.dshHome, config.agentsHome, config.bundledSkillDir)
      if ('error' in resolved) return sendJson(res, 400, { ok: false, error: resolved.error, code: 'BAD_REQUEST' })
      const root = resolved.root

      const skills = await discoverSkills(root.path)
      const kw = (query.search || '').trim().toLowerCase()
      const filtered = kw
        ? skills.filter((x) => x.name.toLowerCase().includes(kw) || x.description.toLowerCase().includes(kw))
        : skills
      // userInvocable 缺省 true（skill-utils 已按 frontmatter 解析）；gesture 注入只认可用户调用的技能
      sendJson(res, 200, {
        ok: true,
        data: {
          sessionId,
          cwd: cwd || undefined,
          root: { kind: root.kind, path: root.path },
          count: filtered.length,
          skills: filtered.map((x) => ({
            name: x.name,
            description: x.description,
            whenToUse: x.whenToUse,
            modelInvocable: x.modelInvocable,
            userInvocable: x.userInvocable,
          })),
        },
      })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) })
    }
  })

  // 6b. 运行权限（沙箱模式 + 审批策略）：走 harness 原生 permissionPresets 服务，
  //     与 `/permission <preset>` 命令同一写路径（session 事件 permission/preset + sandbox/mode + approval/policy），
  //     对远端执行会话真实生效，而不是靠提示词文字约定。
  router.get('/sessions/:id/permission', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
    try {
      const r = await readSessionPermission(ctx, params.id)
      if ('error' in r) { sendJson(res, r.status, { ok: false, error: r.error, code: r.code }); return }
      sendJson(res, 200, { ok: true, data: r })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) })
    }
  })

  router.put('/sessions/:id/permission', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, _query: any, body: { preset?: string }) => {
    try {
      const preset = String(body?.preset || '').trim()
      if (!preset) { sendJson(res, 400, { ok: false, error: 'preset is required', code: 'BAD_REQUEST' }); return }
      const r = await applySessionPermission(ctx, params.id, preset)
      if ('error' in r) { sendJson(res, r.status, { ok: false, error: r.error, code: r.code }); return }
      sendJson(res, 200, { ok: true, data: r })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) })
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

// ---------------- 运行权限（sandbox mode + approval policy） ----------------

type PermFail = { error: string; status: number; code: string }
export interface SessionPermissionView {
  sessionId: string
  /** 当前生效 preset（与 `/permission` 命令同口径；不匹配任何 preset 时为 custom） */
  preset: string
  /** 当前沙箱模式：read-only / workspace-write / danger-full-access */
  sandbox?: string
  /** 当前审批策略：ask / never 等 */
  approval?: string
  /** 可切换的 preset 名 */
  available: string[]
}

/** 常见别名 → harness preset 名（ask = 写工作区 + 需审批） */
const PRESET_ALIASES: Record<string, string> = {
  ask: 'workspace-write',
  'full-access': 'danger-full-access',
  full: 'danger-full-access',
}

async function resolvePermissionTarget(ctx: Context, sessionId: string): Promise<{ agent: any; presets: any } | PermFail> {
  const presets = ctx.get('permissionPresets') as any
  if (!presets || typeof presets.apply !== 'function') {
    return { error: 'permissionPresets service unavailable on this DSH node', status: 501, code: 'NOT_SUPPORTED' }
  }
  const sessionController = ctx.get('sessionController') as any
  let agent: any
  if (sessionController && typeof sessionController.resolveAgent === 'function') {
    const found = await sessionController.resolveAgent(sessionId)
    if (found && 'error' in found) return { error: String(found.error?.message || found.error), status: 404, code: 'SESSION_NOT_FOUND' }
    agent = found?.agent || found
  } else {
    const agentsService = ctx.get('agents') as any
    agent = agentsService?.get ? agentsService.get(sessionId) : undefined
  }
  if (!agent?.session) return { error: `session '${sessionId}' is not active`, status: 404, code: 'SESSION_NOT_FOUND' }
  return { agent, presets }
}

function permissionView(sessionId: string, agent: any, presets: any): SessionPermissionView {
  let sandbox: string | undefined
  let approval: string | undefined
  try {
    const st = presets.permissionState?.(agent.session)
    sandbox = st?.sandbox ?? undefined
    approval = st?.approval ?? undefined
  } catch { /* 视图字段尽力而为 */ }
  return {
    sessionId,
    preset: String(presets.current(agent.session)),
    sandbox,
    approval,
    available: Array.isArray(presets.names) ? [...presets.names] : [],
  }
}

export async function readSessionPermission(ctx: Context, sessionId: string): Promise<SessionPermissionView | PermFail> {
  const t = await resolvePermissionTarget(ctx, sessionId)
  if ('error' in t) return t
  return permissionView(sessionId, t.agent, t.presets)
}

/**
 * 切换会话运行权限：与 `/permission <preset>` 命令完全同一写路径——
 * presets.apply 记录 permission/preset 并按需写 sandbox/mode；审批策略经 approval.setPolicy
 * 切换（会向下一步注入一条「策略已变更」消息，与 GUI 切换行为一致）。
 */
export async function applySessionPermission(ctx: Context, sessionId: string, rawPreset: string): Promise<SessionPermissionView | PermFail> {
  const t = await resolvePermissionTarget(ctx, sessionId)
  if ('error' in t) return t
  const { agent, presets } = t
  const name = PRESET_ALIASES[rawPreset] ?? rawPreset
  const names: string[] = Array.isArray(presets.names) ? presets.names : []
  if (names.length && !names.includes(name)) {
    return { error: `unknown preset "${rawPreset}" (available: ${names.join(', ')})`, status: 400, code: 'UNKNOWN_PRESET' }
  }
  const approvalService = ctx.get('approval') as any
  if (approvalService && typeof approvalService.setPolicy === 'function') {
    presets.apply(agent.session, name, (policy: string) => approvalService.setPolicy(agent, policy))
  } else {
    presets.set(agent.session, name)
  }
  return permissionView(sessionId, agent, presets)
}
