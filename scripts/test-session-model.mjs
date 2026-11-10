#!/usr/bin/env node
/** Run the compiled plugin through its real HTTP router with in-memory DSH services. */
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { HttpRouter } from '../lib/router.js'
import { registerSessionRoutes } from '../lib/sessions.js'
import { registerStreamingRoutes } from '../lib/streaming.js'

const selected = { provider: 'fixture-provider', model: 'org/current-model', reasoningEffort: 'high' }
const stale = { provider: 'old-provider', model: 'old-model', reasoningEffort: 'low' }

async function fixture(t, options = {}) {
  const counters = { legacy: 0, selections: [], prompts: 0 }
  const listeners = new Set()
  const agent = options.noAgent ? undefined : { status: 'idle' }
  if (agent && !options.legacyOnly) agent.model = {
    selection: options.empty ? undefined : { ...selected, apiKey: 'never-public' },
    current() {
      if (options.currentThrows) throw new Error('current model unavailable')
      return this.selection
    },
  }
  if (agent) agent.followup = () => {
    counters.prompts++
    queueMicrotask(() => {
      for (const fn of [...listeners]) fn({ id: 'fixture' }, { type: 'assistant/delta', data: { delta: 'fixture reply' } })
      for (const fn of [...listeners]) fn({ id: 'fixture' }, { type: 'turn/end', data: { reason: 'completed' } })
    })
  }
  const controller = {
    async inspect() {
      if (options.inspectThrows || options.missing) throw new Error('no persisted session')
      return { meta: { id: 'fixture', title: 'fixture', cwd: '/fixture' }, events: [] }
    },
    async selectModel(input) {
      counters.selections.push(input)
      if (options.rejectSelection) throw new Error('model not available')
      return input
    },
    async resolveAgent() { return { agent } },
  }
  if (options.legacyOnly || options.staleLegacy || options.noAgent) controller.agents = {
    selection: options.staleLegacy ? stale : selected,
    selectionFor(value) {
      assert.equal(value, agent)
      assert.ok(value, 'legacy lookup must never receive an absent agent')
      counters.legacy++
      return { current: this.selection }
    },
  }
  const services = {
    sessionController: controller,
    agents: { get: id => id === 'fixture' ? agent : undefined },
    sessions: { get: () => options.live ? {
      header: { id: 'fixture', title: 'live', cwd: '/live' },
      events: undefined,
      requestHeader: () => ({ config: stale }),
    } : undefined },
  }
  const ctx = {
    get: key => services[key],
    on: (_type, listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const router = new HttpRouter({ cors: false, apiKey: '' })
  registerSessionRoutes(ctx, router, {})
  registerStreamingRoutes(ctx, router)
  const server = http.createServer((req, res) => {
    router.dispatch(req, res, '').catch(error => { res.statusCode = 500; res.end(String(error)) })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  async function request(method, path, body) {
    const response = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    })
    return { status: response.status, body: await response.json() }
  }
  return { counters, request, agent, controller }
}

for (const [name, options] of [['modern', {}], ['legacy', { legacyOnly: true }]]) {
  test(`GET session reads ${name} model and only returns public fields`, async t => {
    const { request } = await fixture(t, options)
    const { status, body } = await request('GET', '/sessions/fixture')
    assert.equal(status, 200)
    assert.deepEqual(body.data.model, selected)
    assert.equal(body.data.id, 'fixture')
    assert.equal(body.data.cwd, '/fixture')
    assert.equal(body.data.eventCount, 0)
  })
  test(`effort-only PUT keeps the ${name} provider and slash-containing model`, async t => {
    const { request, counters } = await fixture(t, options)
    const { status } = await request('PUT', '/sessions/fixture', { reasoningEffort: 'medium' })
    assert.equal(status, 200)
    assert.deepEqual(counters.selections, [{ sessionId: 'fixture', ...selected, reasoningEffort: 'medium' }])
  })
}

test('GET modern selection takes priority over stale legacy selection', async t => {
  const { request, counters } = await fixture(t, { staleLegacy: true })
  assert.deepEqual((await request('GET', '/sessions/fixture')).body.data.model, selected)
  assert.equal(counters.legacy, 0)
})

test('GET empty modern selection stays absent instead of reporting stale legacy selection', async t => {
  const { request, counters } = await fixture(t, { empty: true, staleLegacy: true })
  const { status, body } = await request('GET', '/sessions/fixture')
  assert.equal(status, 200)
  assert.equal(Object.hasOwn(body.data, 'model'), false)
  assert.equal(counters.legacy, 0)
})

test('GET with no agent omits the model and never looks up legacy selection', async t => {
  const { request, counters } = await fixture(t, { noAgent: true })
  const { status, body } = await request('GET', '/sessions/fixture')
  assert.equal(status, 200)
  assert.equal(Object.hasOwn(body.data, 'model'), false)
  assert.equal(counters.legacy, 0)
})

test('GET preserves live-session fallback when persisted inspection fails', async t => {
  const { request } = await fixture(t, { inspectThrows: true, live: true })
  const { status, body } = await request('GET', '/sessions/fixture')
  assert.equal(status, 200)
  assert.equal(body.data.title, 'live')
  assert.equal(body.data.cwd, '/live')
  assert.equal(body.data.eventCount, 0)
  assert.deepEqual(body.data.model, selected)
})

test('GET missing session still returns 404', async t => {
  const { request } = await fixture(t, { missing: true })
  const { status, body } = await request('GET', '/sessions/fixture')
  assert.equal(status, 404)
  assert.equal(body.code, 'NOT_FOUND')
})

test('GET modern lookup errors remain visible and never use legacy selection', async t => {
  const { request, counters } = await fixture(t, { currentThrows: true, staleLegacy: true })
  const { status, body } = await request('GET', '/sessions/fixture')
  assert.equal(status, 500)
  assert.equal(body.error, 'current model unavailable')
  assert.equal(counters.legacy, 0)
})

test('effort-only PUT uses modern selection instead of stale legacy selection', async t => {
  const { request, counters } = await fixture(t, { staleLegacy: true })
  assert.equal((await request('PUT', '/sessions/fixture', { reasoningEffort: 'medium' })).status, 200)
  assert.equal(counters.selections[0].model, selected.model)
  assert.equal(counters.legacy, 0)
})

for (const [name, options] of [
  ['empty modern selection', { empty: true, staleLegacy: true }],
  ['missing agent', { noAgent: true }],
]) {
  test(`effort-only PUT rejects ${name} without changing a model`, async t => {
    const { request, counters } = await fixture(t, options)
    const { status, body } = await request('PUT', '/sessions/fixture', { reasoningEffort: 'medium' })
    assert.equal(status, 400)
    assert.equal(body.code, 'NO_MODEL_SELECTION')
    assert.deepEqual(counters.selections, [])
    assert.equal(counters.legacy, 0)
  })
}

test('explicit model PUT remains independent of current model readback', async t => {
  const { request, counters } = await fixture(t, { currentThrows: true })
  const input = { provider: 'chosen-provider', model: 'org/chosen-model', reasoningEffort: 'high' }
  assert.equal((await request('PUT', '/sessions/fixture', input)).status, 200)
  assert.deepEqual(counters.selections, [{ sessionId: 'fixture', ...input }])
})

test('explicit model PUT still reports host rejection without fallback', async t => {
  const { request, counters } = await fixture(t, { rejectSelection: true })
  const { status, body } = await request('PUT', '/sessions/fixture', { provider: 'bad', model: 'bad' })
  assert.equal(status, 500)
  assert.equal(body.error, 'model not available')
  assert.equal(counters.selections.length, 1)
})

test('GET keeps the actual selection even when a caller expects a different model', async t => {
  const { request } = await fixture(t)
  const actual = (await request('GET', '/sessions/fixture')).body.data.model
  assert.notEqual(`${actual.provider}/${actual.model}`, 'requested-provider/requested-model')
  assert.deepEqual(actual, selected)
})

for (const [name, options, model] of [
  ['modern runtime selection', { staleLegacy: true, live: true }, `${selected.provider}/${selected.model}`],
  ['legacy runtime selection', { legacyOnly: true }, `${selected.provider}/${selected.model}`],
  ['legacy header fallback', { noAgent: false, legacyOnly: true, live: true, clearLegacy: true }, `${stale.provider}/${stale.model}`],
  ['empty modern selection without stale header fallback', { empty: true, staleLegacy: true, live: true }, 'dsh-model'],
]) {
  test(`OpenAI non-streaming response respects ${name}`, async t => {
    const { request, controller, counters } = await fixture(t, options)
    if (options.clearLegacy) delete controller.agents
    const { status, body } = await request('POST', '/chat/completions', {
      sessionId: 'fixture', messages: [{ role: 'user', content: 'fixture prompt' }],
    })
    assert.equal(status, 200)
    assert.equal(body.model, model)
    assert.equal(body.choices[0].message.content, 'fixture reply')
    assert.equal(counters.prompts, 1)
    if (!options.legacyOnly) assert.equal(counters.legacy, 0)
  })
}
