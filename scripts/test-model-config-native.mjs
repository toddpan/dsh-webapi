#!/usr/bin/env node
/**
 * Offline P1 native settings CAS regression suite (task-2).
 *
 * Run: node scripts/test-model-config-native.mjs
 * Compiles the CURRENT src with local tsc into a disposable directory under the
 * repository. Never runs build.sh, binds a listener, reads real DSH settings,
 * or touches ~/.dsh. The host (settingsController/llm/sessionController) is a
 * fixture; every secret-looking value is a loud sentinel trap that fails the
 * whole run if it ever reaches a response.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = await realpath(fileURLToPath(new URL('..', import.meta.url)))
const scratch = await mkdtemp(path.join(ROOT, '.model-config-native-test-'))
const out = path.join(scratch, 'compiled')
const env = { ...process.env, TMPDIR: scratch, NODE_DISABLE_COMPILE_CACHE: '1' }
const SENTINEL = 'native-fixture-secret-NEVER-SERIALIZE'
const require = createRequire(import.meta.url)
const PREFIX = '/api/v1'
let nextIp = 1

function hostFixture() {
  const namespaces = {
    'agent-default-model': {
      revision: 7,
      value: { provider: 'acme', model: 'large', reasoningEffort: 'high', extra: 'unmanaged' },
      base: { provider: 'acme', model: 'large' },
      user: { reasoningEffort: 'high' },
    },
    'llm-pi-ai': {
      revision: 3,
      value: { providers: { acme: {
        displayName: 'Acme',
        baseURL: 'https://api.acme.dev/v1',
        api: 'openai-responses',
        timeoutMs: 60000,
        get apiKey() { throw new Error(SENTINEL + ':apiKey') },
      } } },
      base: { providers: { acme: { baseURL: 'https://base.acme.dev/v1', api: 'openai-completions' } } },
      user: { providers: { acme: { displayName: 'Acme', baseURL: 'https://api.acme.dev/v1', api: 'openai-responses', timeoutMs: 60000 } } },
    },
  }
  const state = { mutations: [], refused: 0, catalog: {
    groups: [{ id: 'acme', models: [
      { id: 'small' },
      { id: 'large', reasoning: { efforts: [{ id: 'high' }, { id: 'low' }] } },
    ] }],
    routableProviders: ['acme'],
    failures: [],
  } }
  const at = (root, path) => {
    let value = root
    for (const part of path) {
      if (value === undefined) return undefined
      value = Object.hasOwn(value, part) ? value[part] : undefined
    }
    return value
  }
  const settingsController = {
    async describe() {
      return { writable: true, namespaces: Object.entries(namespaces).map(([ns, data]) => ({
        ns, revision: data.revision, value: data.value, base: data.base, user: data.user,
      })) }
    },
    async mutate(ns, ops, revision) {
      const data = namespaces[ns]
      state.mutations.push({ ns, ops, revision })
      if (!data || data.revision !== revision) {
        state.refused++
        const error = new Error('stale namespace write')
        error.code = 'settings/conflict'
        throw error
      }
      for (const op of ops) {
        // A real host applies the op to the effective value AND the user layer;
        // unset re-derives the effective value from base/defaults.
        for (const layer of [data.value, data.user]) {
          const parent = at(layer, op.path.slice(0, -1))
          if (parent === undefined) continue
          const field = op.path[op.path.length - 1]
          if (op.op === 'set') {
            parent[field] = op.value
          } else if (layer === data.user) {
            delete parent[field]
          } else {
            const baseParent = at(data.base, op.path.slice(0, -1))
            if (baseParent && Object.hasOwn(baseParent, field)) parent[field] = baseParent[field]
            else delete parent[field]
          }
        }
      }
      data.revision++
      return { ok: true }
    },
  }
  const llm = {
    async listConfigurableProviders() {
      return [{ provider: 'acme', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'acme'] }]
    },
  }
  const sessionController = {
    async modelCatalog() {
      if (state.catalog.throw) throw new Error(SENTINEL + ':catalog')
      return state.catalog
    },
  }
  return {
    state,
    bumpRevision(ns) { namespaces[ns].revision++ },
    ctx: {
      get(name) {
        if (name === 'settingsController') return settingsController
        if (name === 'llm') return llm
        if (name === 'sessionController') return sessionController
        throw new Error(SENTINEL + ':lookup:' + name)
      },
    },
  }
}

try {
  try {
    execFileSync(process.execPath, [
      require.resolve('typescript/bin/tsc'), '-p', path.join(ROOT, 'tsconfig.json'),
      '--outDir', out, '--declarationDir', path.join(scratch, 'types'),
      '--incremental', 'false', '--sourceMap', 'false', '--noEmitOnError', 'true',
    ], { cwd: ROOT, env, encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    if (error.stdout) process.stderr.write(error.stdout)
    if (error.stderr) process.stderr.write(error.stderr)
    throw error
  }
  console.log('Compiled current src into repository-local disposable output.')
  const { HttpRouter } = await import(pathToFileURL(path.join(out, 'router.js')).href)
  const { ApiKeyStore } = await import(pathToFileURL(path.join(out, 'api-keys-store.js')).href)
  const { registerNativeModelConfigRoutes } = await import(pathToFileURL(path.join(out, 'model-config-native.js')).href)
  const { modelConfigInstanceId } = await import(pathToFileURL(path.join(out, 'model-config.js')).href)

  const home = path.join(scratch, 'auth')
  const store = new ApiKeyStore('', home)
  await store.ensureReady()
  const admin = await store.ensureAdminToken()

  let fixture
  let activeRouter
  function setup() {
    fixture = hostFixture()
    const router = new HttpRouter({ pathPrefix: PREFIX, cors: true })
    router.setAuthService(store)
    registerNativeModelConfigRoutes(fixture.ctx, router, {}, store)
    activeRouter = router
    return router
  }

  async function call(method, url, body) {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = { host: 'fixture.local:3080', 'x-admin-token': admin }
    req.socket = { remoteAddress: `127.40.${Math.floor(nextIp / 250)}.${nextIp++ % 250 + 1}` }
    const response = {
      statusCode: 200, headersSent: false, headers: {}, raw: '',
      setHeader(name, value) { this.headers[name.toLowerCase()] = value },
      end(value) { this.raw = String(value ?? ''); this.headersSent = true },
    }
    const handled = activeRouter.dispatch(req, response, PREFIX)
    // dispatch() suspends before the handler registers body listeners, so the
    // body events must be delivered on a later macrotask.
    setImmediate(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
    await handled
    const result = { handled, status: response.statusCode, headers: response.headers, raw: response.raw,
      body: response.raw ? JSON.parse(response.raw) : undefined }
    assert.ok(!result.raw.includes(SENTINEL), 'No fixture secret may reach any response')
    if (handled && method !== 'OPTIONS') {
      assert.match(String(result.headers && result.headers['cache-control']), /no-store/)
    }
    return result
  }

  const inspectUrl = (target, provider) =>
    `${PREFIX}/model-config/native/inspect?runtime=dsh&target=${target}${provider ? `&provider=${provider}` : ''}`
  async function fenceOf(target, provider) {
    const result = await call('GET', inspectUrl(target, provider))
    if (result.status !== 200) console.error('fenceOf debug:', target, provider, result.status, result.raw)
    assert.equal(result.status, 200)
    return result.body.data.revision
  }

  await test('inspect fence binds instanceId + namespace revision + fingerprint, values are allowlisted only', async () => {
    setup()
    const result = await call('GET', inspectUrl('default'))
    assert.equal(result.status, 200)
    const fence = result.body.data.revision
    assert.equal(fence.instanceId, modelConfigInstanceId)
    assert.equal(fence.namespace, 'agent-default-model')
    assert.equal(fence.revision, 7)
    assert.match(fence.fingerprint, /^[a-f0-9]{64}$/)
    assert.deepEqual(Object.keys(result.body.data.values).sort(), ['model', 'provider', 'reasoningEffort'])
    const provider = await call('GET', inspectUrl('provider', 'acme'))
    assert.equal(provider.status, 200)
    assert.equal(provider.body.data.revision.namespace, 'llm-pi-ai')
    assert.deepEqual(Object.keys(provider.body.data.values).sort(),
      ['api', 'baseURL', 'displayName', 'timeoutMs'])
    assert.equal('apiKey' in provider.body.data.values, false)
    assert.equal(provider.body.data.capabilities.conditionalWrite, 'observed-namespace')
  })

  await test('preview validates against the catalog and only touches owned allowlist fields', async () => {
    setup()
    const fence = await fenceOf('default')
    const good = await call('POST', `${PREFIX}/model-config/preview`, {
      runtime: 'dsh', target: { kind: 'default' }, expectedRevision: fence, requestId: 'req-preview-ok-01',
      patch: { model: 'small', reasoningEffort: null },
    })
    assert.equal(good.status, 200)
    assert.deepEqual(good.body.data.after, { provider: 'acme', model: 'small' })
    assert.deepEqual(good.body.data.before, { provider: 'acme', model: 'large', reasoningEffort: 'high' })
    assert.equal(good.body.data.persisted, false)
    // Unknown model id fails catalog validation; unknown/credentials fields are refused outright.
    const badModel = await call('POST', `${PREFIX}/model-config/preview`, {
      runtime: 'dsh', target: { kind: 'default' }, expectedRevision: fence, requestId: 'req-preview-bad-01',
      patch: { model: 'made-up' },
    })
    assert.equal(badModel.status, 400)
    const credentials = await call('POST', `${PREFIX}/model-config/preview`, {
      runtime: 'dsh', target: { kind: 'provider', provider: 'acme' }, expectedRevision: await fenceOf('provider', 'acme'),
      requestId: 'req-preview-cred-01', patch: { apiKey: 'sk-attacker' },
    })
    assert.equal(credentials.status, 400)
    const provider = await call('POST', `${PREFIX}/model-config/preview`, {
      runtime: 'dsh', target: { kind: 'provider', provider: 'acme' }, expectedRevision: await fenceOf('provider', 'acme'),
      requestId: 'req-preview-prov-01', patch: { baseURL: 'https://user:pass@evil.dev' },
    })
    assert.equal(provider.status, 400)
    assert.equal(fixture.state.mutations.length, 0, 'preview must not write')
  })

  await test('preview/apply refuse stale revisions and foreign instanceIds (restart/change)', async () => {
    setup()
    const fence = await fenceOf('default')
    const stale = { ...fence, revision: fence.revision - 1 }
    const preview = await call('POST', `${PREFIX}/model-config/preview`, {
      runtime: 'dsh', target: { kind: 'default' }, expectedRevision: stale, requestId: 'req-stale-preview-01',
      patch: { reasoningEffort: 'low' },
    })
    assert.equal(preview.status, 409)
    assert.equal(preview.body.code, 'REVISION_CONFLICT')
    const foreign = { ...fence, instanceId: '00000000-0000-4000-8000-000000000000' }
    const restarted = await call('POST', `${PREFIX}/model-config/preview`, {
      runtime: 'dsh', target: { kind: 'default' }, expectedRevision: foreign, requestId: 'req-restart-01',
      patch: { reasoningEffort: 'low' },
    })
    assert.equal(restarted.status, 409)
    // Revision bump between preview and apply is also a conflict.
    const okPreview = await call('POST', `${PREFIX}/model-config/preview`, {
      runtime: 'dsh', target: { kind: 'default' }, expectedRevision: fence, requestId: 'req-race-01',
      patch: { reasoningEffort: 'low' },
    })
    assert.equal(okPreview.status, 200)
    fixture.bumpRevision('agent-default-model')
    const apply = await call('POST', `${PREFIX}/model-config/apply`, {
      runtime: 'dsh', previewId: okPreview.body.data.previewId, expectedRevision: fence, operationId: 'op-race-01',
    })
    assert.equal(apply.status, 409)
    assert.equal(apply.body.code, 'REVISION_CONFLICT')
  })

  await test('apply writes conditionally via host mutate with the fenced revision and verifies by read-back', async () => {
    setup()
    const fence = await fenceOf('default')
    const preview = await call('POST', `${PREFIX}/model-config/preview`, {
      runtime: 'dsh', target: { kind: 'default' }, expectedRevision: fence, requestId: 'req-apply-ok-01',
      patch: { model: 'large', reasoningEffort: 'low' },
    })
    assert.equal(preview.status, 200)
    const apply = await call('POST', `${PREFIX}/model-config/apply`, {
      runtime: 'dsh', previewId: preview.body.data.previewId, expectedRevision: fence, operationId: 'op-apply-ok-01',
    })
    assert.equal(apply.status, 200)
    assert.equal(apply.body.data.persisted, true)
    assert.equal(apply.body.data.verified, true)
    assert.equal(apply.body.data.rollbackAvailable, true)
    const mutation = fixture.state.mutations.at(-1)
    assert.deepEqual([mutation.ns, mutation.revision], ['agent-default-model', fence.revision])
    assert.deepEqual(mutation.ops, [
      { op: 'set', path: ['model'], value: 'large' },
      { op: 'set', path: ['reasoningEffort'], value: 'low' },
    ])
    const after = await fenceOf('default')
    assert.equal(after.revision, fence.revision + 1)
  })

  await test('apply replays idempotently; a consumed plan refuses a second apply', async () => {
    setup()
    const fence = await fenceOf('default')
    const preview = await call('POST', `${PREFIX}/model-config/preview`, {
      runtime: 'dsh', target: { kind: 'default' }, expectedRevision: fence, requestId: 'req-idem-01',
      patch: { reasoningEffort: 'low' },
    })
    const first = await call('POST', `${PREFIX}/model-config/apply`, {
      runtime: 'dsh', previewId: preview.body.data.previewId, expectedRevision: fence, operationId: 'op-idem-01',
    })
    assert.equal(first.status, 200)
    const replay = await call('POST', `${PREFIX}/model-config/apply`, {
      runtime: 'dsh', previewId: preview.body.data.previewId, expectedRevision: fence, operationId: 'op-idem-01',
    })
    assert.equal(replay.status, 200)
    assert.equal(replay.body.data.operationId, first.body.data.operationId)
    const second = await call('POST', `${PREFIX}/model-config/apply`, {
      runtime: 'dsh', previewId: preview.body.data.previewId, expectedRevision: fence, operationId: 'op-idem-02',
    })
    assert.equal(second.status, 409)
    assert.equal(second.body.code, 'PLAN_CONSUMED')
  })

  await test('host conflict and unconfirmed write failures are explicit and never echo error text', async () => {
    setup()
    const fence = await fenceOf('default')
    const preview = await call('POST', `${PREFIX}/model-config/preview`, {
      runtime: 'dsh', target: { kind: 'default' }, expectedRevision: fence, requestId: 'req-conflict-01',
      patch: { reasoningEffort: 'low' },
    })
    // Host-level conflict: our fence still matches, but the host mutate rejects.
    const controller = fixture.ctx.get('settingsController')
    const originalMutate = controller.mutate
    controller.mutate = async () => {
      const error = new Error(SENTINEL + ':mutate-stale')
      error.code = 'settings/conflict'
      throw error
    }
    const losing = await call('POST', `${PREFIX}/model-config/apply`, {
      runtime: 'dsh', previewId: preview.body.data.previewId, expectedRevision: fence, operationId: 'op-conflict-01',
    })
    assert.equal(losing.status, 409)
    assert.equal(losing.body.code, 'REVISION_CONFLICT')
    assert.equal(losing.body.data.persisted, false)
    // Unconfirmed failure: non-conflict host error with a secret in the message.
    const errorFence = await fenceOf('default')
    const errorPreview = await call('POST', `${PREFIX}/model-config/preview`, {
      runtime: 'dsh', target: { kind: 'default' }, expectedRevision: errorFence, requestId: 'req-error-01',
      patch: { reasoningEffort: 'high' },
    })
    controller.mutate = async () => { throw new Error(SENTINEL + ':mutate-exploded') }
    const failed = await call('POST', `${PREFIX}/model-config/apply`, {
      runtime: 'dsh', previewId: errorPreview.body.data.previewId, expectedRevision: errorFence,
      operationId: 'op-error-01',
    })
    assert.equal(failed.status, 503)
    assert.equal(failed.body.code, 'NATIVE_WRITE_UNCONFIRMED')
    assert.equal(failed.body.data.persisted, 'unknown')
    assert.ok(!failed.raw.includes(SENTINEL))
    controller.mutate = originalMutate
  })

  await test('rollback restores the previewed fields from the actual current revision, unset included', async () => {
    setup()
    const fence = await fenceOf('default')
    const preview = await call('POST', `${PREFIX}/model-config/preview`, {
      runtime: 'dsh', target: { kind: 'default' }, expectedRevision: fence, requestId: 'req-rb-01',
      patch: { model: 'small', reasoningEffort: null },
    })
    const apply = await call('POST', `${PREFIX}/model-config/apply`, {
      runtime: 'dsh', previewId: preview.body.data.previewId, expectedRevision: fence, operationId: 'op-rb-01',
    })
    assert.equal(apply.status, 200)
    // A foreign writer advanced the namespace after our apply: rollback must use
    // the ACTUAL current revision, not the one from the original receipt.
    fixture.bumpRevision('agent-default-model')
    const staleRollback = await call('POST', `${PREFIX}/model-config/rollback`, {
      runtime: 'dsh', appliedOperationId: 'op-rb-01', expectedRevision: apply.body.data.revision, operationId: 'op-rb-02',
    })
    assert.equal(staleRollback.status, 409)
    // A refused attempt (or its idempotent replay) must not consume the slot,
    // but the same operationId replays the refused receipt: retry is a new op.
    const replayStale = await call('POST', `${PREFIX}/model-config/rollback`, {
      runtime: 'dsh', appliedOperationId: 'op-rb-01', expectedRevision: apply.body.data.revision, operationId: 'op-rb-02',
    })
    assert.equal(replayStale.status, 409)
    const current = await fenceOf('default')
    const rollback = await call('POST', `${PREFIX}/model-config/rollback`, {
      runtime: 'dsh', appliedOperationId: 'op-rb-01', expectedRevision: current, operationId: 'op-rb-02b',
    })
    assert.equal(rollback.status, 200)
    assert.equal(rollback.body.data.verified, true)
    const mutation = fixture.state.mutations.at(-1)
    assert.deepEqual(mutation.revision, current.revision)
    // reasoningEffort was inherited before the preview -> set back; model had no
    // prior user override -> unset (the effective value returns to base).
    assert.deepEqual(mutation.ops, [
      { op: 'unset', path: ['model'] },
      { op: 'set', path: ['reasoningEffort'], value: 'high' },
    ])
    assert.equal((await fenceOf('default')).revision, current.revision + 1)
    const again = await call('POST', `${PREFIX}/model-config/rollback`, {
      runtime: 'dsh', appliedOperationId: 'op-rb-01', expectedRevision: await fenceOf('default'), operationId: 'op-rb-03',
    })
    assert.equal(again.status, 409)
    assert.equal(again.body.code, 'ROLLBACK_UNAVAILABLE')
  })

  await test('unauthenticated and non-admin requests are refused before any host seam is touched', async () => {
    setup()
    const router = new HttpRouter({ pathPrefix: PREFIX, cors: true })
    router.setAuthService(store)
    const lookups = []
    registerNativeModelConfigRoutes({ get(name) { lookups.push(name); throw new Error(SENTINEL) } }, router, {}, store)
    const req = new EventEmitter()
    req.method = 'GET'
    req.url = inspectUrl('default')
    req.headers = { host: 'fixture.local:3080' }
    req.socket = { remoteAddress: '127.40.9.9' }
    const response = { statusCode: 200, headersSent: false, headers: {}, raw: '',
      setHeader(n, v) { this.headers[n.toLowerCase()] = v },
      end(v) { this.raw = String(v ?? ''); this.headersSent = true } }
    await router.dispatch(req, response, PREFIX)
    assert.equal(response.statusCode, 401)
    assert.deepEqual(lookups, [], 'no host access without admin credential')
    assert.ok(!response.raw.includes(SENTINEL))
  })

  console.log('Native CAS suite finished.')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
