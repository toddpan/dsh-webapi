/**
 * @dsh-external/dsh-web-service - Model Management & Settings API Handlers
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson } from './router.js'
import type { DefaultModelSelection, ModelItem, ProviderItem } from './types.js'

export function registerModelRoutes(ctx: Context, router: any): void {
  // 1. 获取所有可用模型列表
  router.get('/models', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const sessionController = ctx.get('sessionController') as any
      const defaultModelService = ctx.get('agentDefaultModel') as any
      const defaultSelection = defaultModelService?.currentSelection ? defaultModelService.currentSelection() : undefined

      const models: ModelItem[] = []

      // 优先从 sessionController.modelCatalog 读取
      if (sessionController && typeof sessionController.modelCatalog === 'function') {
        const catalog = await sessionController.modelCatalog()
        if (catalog && Array.isArray(catalog.groups)) {
          for (const group of catalog.groups) {
            for (const m of group.models) {
              const isDefault = defaultSelection &&
                defaultSelection.provider === group.id &&
                defaultSelection.model === m.id

              models.push({
                id: m.id,
                provider: group.id,
                name: m.name || m.id,
                description: m.description,
                reasoning: m.reasoning,
                isDefault: Boolean(isDefault),
              })
            }
          }
        }
        // 路由型 provider（没有模型目录但可直接路由）
        if (Array.isArray(catalog.routableProviders)) {
          for (const pid of catalog.routableProviders) {
            if (!models.some(m => m.provider === pid)) {
              models.push({
                id: pid,
                provider: pid,
                name: pid,
                isDefault: defaultSelection?.provider === pid,
                routeOnly: true,
              })
            }
          }
        }
      }

      // 补充从 llm 服务的 providers
      const llmService = ctx.get('llm') as any
      if (models.length === 0 && llmService && typeof llmService.listProviders === 'function') {
        const providers = llmService.listProviders()
        for (const p of providers) {
          // provider 本身也是一个基础模型或路由
          models.push({
            id: p.id,
            provider: p.id,
            name: p.id,
            isDefault: defaultSelection?.provider === p.id,
          })
        }
      }

      sendJson(res, 200, {
        ok: true,
        data: {
          defaultModel: defaultSelection,
          models,
        },
      })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 2. 获取全局默认模型设置
  router.get('/models/default', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const defaultModelService = ctx.get('agentDefaultModel') as any
      if (!defaultModelService || typeof defaultModelService.currentSelection !== 'function') {
        sendJson(res, 503, { ok: false, error: 'AgentDefaultModel service unavailable', code: 'SERVICE_UNAVAILABLE' })
        return
      }

      const current = defaultModelService.currentSelection()
      sendJson(res, 200, { ok: true, data: current })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 3. 修改全局默认模型设置
  router.put('/models/default', async (_req: IncomingMessage, res: ServerResponse, _params: any, _query: any, body: DefaultModelSelection) => {
    try {
      const defaultModelService = ctx.get('agentDefaultModel') as any
      if (!defaultModelService || typeof defaultModelService.saveSelection !== 'function') {
        sendJson(res, 503, { ok: false, error: 'AgentDefaultModel service unavailable', code: 'SERVICE_UNAVAILABLE' })
        return
      }

      if (!body || !body.provider || !body.model) {
        sendJson(res, 400, { ok: false, error: "Missing required fields 'provider' and 'model'", code: 'BAD_REQUEST' })
        return
      }

      await defaultModelService.saveSelection({
        provider: body.provider,
        model: body.model,
        reasoningEffort: body.reasoningEffort,
      })

      const updated = defaultModelService.currentSelection()
      sendJson(res, 200, { ok: true, data: updated })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 4. 列出所有 LLM 提供方 (Providers)
  router.get('/providers', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const llmService = ctx.get('llm') as any
      if (!llmService || typeof llmService.listProviders !== 'function') {
        sendJson(res, 503, { ok: false, error: 'LLM service unavailable', code: 'SERVICE_UNAVAILABLE' })
        return
      }

      const providers = llmService.listProviders()
      const result: ProviderItem[] = []
      for (const p of providers) {
        // 从 LLM 注册表读取每个 provider 的模型清单
        let modelIds: string[] = []
        try {
          if (typeof llmService.listModels === 'function') {
            const models = await llmService.listModels(p.id)
            modelIds = (models || []).map((m: any) => m.id || m)
          }
        } catch {}
        result.push({
          id: p.id,
          displayName: p.name || p.displayName || p.id,
          models: modelIds,
        })
      }

      sendJson(res, 200, { ok: true, data: result })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 5. 列出可用 Agent Preset（供会话创建时的 agentPreset 参数选择）
  router.get('/presets', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const presetsService = ctx.get('agentPresets') as any
      if (!presetsService) {
        sendJson(res, 503, { ok: false, error: 'Agent presets service unavailable', code: 'SERVICE_UNAVAILABLE' })
        return
      }
      let presets: any[] = []
      if (typeof presetsService.remoteExportList === 'function') {
        const roster = await presetsService.remoteExportList()
        presets = roster?.presets || []
      } else if (typeof presetsService.list === 'function') {
        presets = await presetsService.list()
      }
      sendJson(res, 200, {
        ok: true,
        data: {
          presets: presets.map((p: any) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            isDefault: Boolean(p.isDefault),
          })),
        },
      })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 6. 获取系统设置列表
  router.get('/settings', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const settingsController = ctx.get('settingsController') as any
      if (!settingsController || typeof settingsController.describe !== 'function') {
        sendJson(res, 503, { ok: false, error: 'Settings service unavailable', code: 'SERVICE_UNAVAILABLE' })
        return
      }

      const description = settingsController.describe()
      sendJson(res, 200, { ok: true, data: description })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })

  // 7. 更新指定命名空间的系统设置
  router.patch('/settings/:namespace', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, _query: any, body: any) => {
    try {
      const settingsController = ctx.get('settingsController') as any
      if (!settingsController || typeof settingsController.update !== 'function') {
        sendJson(res, 503, { ok: false, error: 'Settings service unavailable', code: 'SERVICE_UNAVAILABLE' })
        return
      }

      const ns = params.namespace
      if (!body || typeof body !== 'object') {
        sendJson(res, 400, { ok: false, error: 'Invalid settings patch body', code: 'BAD_REQUEST' })
        return
      }

      const result = await settingsController.update(ns, body, undefined)
      sendJson(res, 200, { ok: true, data: result })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  })
}
