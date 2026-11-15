/**
 * Administrator-only, read-only model configuration inspection.
 *
 * P0 deliberately does not wrap the unconditional /models/default writer or
 * expose settings/credentials/provider editing. A host settings revision alone
 * is not evidence of durable compare-and-set across native editors or restarts.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { rejectAdmin } from './api-keys.js'
import type { ApiKeyStore } from './api-keys-store.js'
import { HttpRouter, sendJson } from './router.js'
import type { DefaultModelSelection, WebServiceConfig } from './types.js'

// Opaque incarnation, not a machine/profile identity or durable configuration id.
// Stable for this module's lifetime; a process restart/plugin reload replaces it.
export const modelConfigInstanceId = randomUUID()
const instanceId = modelConfigInstanceId

export interface ModelConfigModel {
  provider: string
  id: string
  name: string
  isDefault: boolean
  /** A provider route, NOT a verified model id or a Codex router capability. */
  routeOnly?: true
}

export interface ModelConfigInspection {
  version: 1
  runtime: 'dsh'
  instanceId: string
  supported: true
  source: 'node-manager'
  capabilities: {
    inspect: true
    preview: false
    apply: false
    rollback: false
    providers: false
    secrets: false
    routing: false
    conditionalWrite: 'none'
  }
  nodeDefault?: DefaultModelSelection
  models: ModelConfigModel[]
  activation: 'future-sessions'
}

class UnsupportedModelConfig extends Error {}
class UnavailableModelCatalog extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Accept only bounded primitive text; never coerce a host object/toJSON. */
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
}

function projectDefault(value: unknown): DefaultModelSelection | undefined {
  if (value === undefined || value === null) return undefined
  if (!record(value)) throw new UnsupportedModelConfig()
  // Snapshot each permitted value once before validating; an accessor must not
  // swap an object into a field between validation and serialization.
  const provider = value.provider
  const model = value.model
  const reasoningEffort = value.reasoningEffort
  if (!text(provider) || !text(model)) throw new UnsupportedModelConfig()
  const selection: DefaultModelSelection = { provider, model }
  if (reasoningEffort !== undefined) {
    if (!text(reasoningEffort)) throw new UnsupportedModelConfig()
    selection.reasoningEffort = reasoningEffort
  }
  return selection
}

/**
 * Construct the complete response from explicitly permitted fields only. In
 * particular, catalog failures can contain upstream Authorization/error bodies;
 * neither they nor settings/schema/headers/credential records are serialized.
 */
function projectModels(catalog: unknown, selection?: DefaultModelSelection): ModelConfigModel[] {
  if (!record(catalog)) throw new UnsupportedModelConfig()
  const groups = catalog.groups
  const routableProviders = catalog.routableProviders
  const failures = catalog.failures
  if (!Array.isArray(groups)
    || (routableProviders !== undefined && !Array.isArray(routableProviders))
    || (failures !== undefined && !Array.isArray(failures))) {
    throw new UnsupportedModelConfig()
  }
  // A failed catalog lookup must not masquerade as an empty/route-only catalog.
  // Do not forward the provider's error body (which may include credentials).
  if (Array.isArray(failures) && failures.length > 0) {
    throw new UnavailableModelCatalog()
  }
  const models: ModelConfigModel[] = []
  const pairs = new Set<string>()
  const providers = new Set<string>()
  const append = (model: ModelConfigModel): void => {
    const pair = JSON.stringify([model.provider, model.id])
    if (pairs.has(pair)) return
    pairs.add(pair)
    providers.add(model.provider)
    models.push(model)
  }

  for (const group of groups) {
    if (!record(group)) throw new UnsupportedModelConfig()
    const provider = group.id
    const entries = group.models
    if (!text(provider) || !Array.isArray(entries)) throw new UnsupportedModelConfig()
    for (const item of entries) {
      if (!record(item)) throw new UnsupportedModelConfig()
      const id = item.id
      const name = item.name
      const routeOnly = item.routeOnly
      if (!text(id)) throw new UnsupportedModelConfig()
      append({
        provider,
        id,
        name: text(name) ? name : id,
        isDefault: selection?.provider === provider && selection.model === id,
        ...(routeOnly === true ? { routeOnly: true } : {}),
      })
    }
  }

  for (const provider of routableProviders ?? []) {
    if (!text(provider)) throw new UnsupportedModelConfig()
    if (providers.has(provider)) continue
    append({
      provider,
      // Match the existing catalog contract: this is a route placeholder, not
      // permission to send provider as the upstream model id.
      id: provider,
      name: provider,
      isDefault: selection?.provider === provider,
      routeOnly: true,
    })
  }
  return models
}

export function registerModelConfigRoutes(
  ctx: Context,
  router: HttpRouter,
  config: WebServiceConfig,
  store: ApiKeyStore,
): void {
  const guardOptions = { adminRemoteAccess: config.adminRemoteAccess === true }
  router.get('/model-config/inspect', async (req, res, _params, query) => {
    // Catch guard/store failures too: HttpRouter's generic catch echoes message.
    try {
      if (await rejectAdmin(req, res, store, guardOptions)) return
      if (query.runtime !== undefined && query.runtime !== 'dsh') {
        throw new UnsupportedModelConfig()
      }

      // Feature detect only the read seams actually used here. Missing/older
      // hosts must not fall back to raw settings or unconditional write APIs.
      const controller = ctx.get('sessionController') as unknown
      const defaults = ctx.get('agentDefaultModel') as unknown
      if (!record(controller) || !record(defaults)) throw new UnsupportedModelConfig()
      const modelCatalog = controller.modelCatalog
      const currentSelection = defaults.currentSelection
      if (typeof modelCatalog !== 'function' || typeof currentSelection !== 'function') {
        throw new UnsupportedModelConfig()
      }
      const nodeDefault = projectDefault(await currentSelection.call(defaults))
      const models = projectModels(await modelCatalog.call(controller), nodeDefault)
      const data: ModelConfigInspection = {
        version: 1,
        runtime: 'dsh',
        instanceId,
        supported: true,
        source: 'node-manager',
        capabilities: {
          inspect: true,
          preview: false,
          apply: false,
          rollback: false,
          providers: false,
          secrets: false,
          routing: false,
          conditionalWrite: 'none',
        },
        ...(nodeDefault === undefined ? {} : { nodeDefault }),
        models,
        activation: 'future-sessions',
      }
      // No revision is advertised in P0: catalog + default are independent reads,
      // not an atomic settings snapshot or a fence usable by a future writer.
      sendJson(res, 200, { ok: true, data })
    } catch (error: unknown) {
      if (error instanceof UnsupportedModelConfig) {
        sendJson(res, 501, {
          ok: false,
          error: 'Model configuration inspection is not supported for this runtime or host',
          code: 'NOT_SUPPORTED',
        })
        return
      }
      if (error instanceof UnavailableModelCatalog) {
        sendJson(res, 503, {
          ok: false,
          error: 'The host model catalog could not be fully inspected',
          code: 'MODEL_CATALOG_UNAVAILABLE',
        })
        return
      }
      // Never send or log upstream exceptions: they may embed tokens, request
      // headers, settings paths or entire provider response bodies.
      sendJson(res, 503, {
        ok: false,
        error: 'Model configuration inspection is temporarily unavailable',
        code: 'MODEL_CONFIG_UNAVAILABLE',
      })
    }
  }, { auth: 'admin' })
}
