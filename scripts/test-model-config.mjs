#!/usr/bin/env node
/**
 * Offline P0 model-config regression suite.
 *
 * Run: node scripts/test-model-config.mjs
 * Compiles the CURRENT src with local tsc into a disposable directory under the
 * repository. Never runs build.sh, imports index/apply, binds a listener, reads
 * real DSH settings, or uses ~/.dsh. Every key store is an explicit fixture home.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = await realpath(fileURLToPath(new URL('..', import.meta.url)))
const scratch = await mkdtemp(path.join(ROOT, '.model-config-test-'))
const out = path.join(scratch, 'compiled')
const env = { ...process.env, TMPDIR: scratch, NODE_DISABLE_COMPILE_CACHE: '1' }
const SENTINEL = 'fixture-secret-NEVER-SERIALIZE-headers-or-errors'
const require = createRequire(import.meta.url)
const PREFIX = '/api/v1'
let nextIp = 1

/** Make unallowlisted fields fail loudly if inspected or serialized. */
function withPrivateFields(value) {
  for (const field of ['headers', 'credentials', 'schema', 'apiKey', 'baseURL', 'reasoning', 'description']) {
    Object.defineProperty(value, field, {
      enumerable: true,
      get() { throw new Error(SENTINEL + ':' + field) },
    })
  }
  value.toJSON = () => { throw new Error(SENTINEL + ':toJSON') }
  return value
}

function hostFixture({ selection, catalog, services } = {}) {
  const state = {
    selection: selection === undefined ? { provider: 'acme', model: 'large', reasoningEffort: 'high' } : selection,
    catalog: catalog ?? {
      groups: [{ id: 'acme', models: [{ id: 'small', name: 'Small' }, { id: 'large', name: 'Large' }] }],
      routableProviders: ['acme', 'route-only'],
      failures: [],
    },
    lookups: [],
    reads: [],
    throwOn: null,
  }
  const available = services ?? {
    sessionController: {
      async modelCatalog() {
        state.reads.push('catalog')
        if (state.throwOn === 'catalog') throw new Error(SENTINEL)
        return state.catalog
      },
    },
    agentDefaultModel: {
      currentSelection() {
        state.reads.push('default')
        if (state.throwOn === 'default') throw new Error(SENTINEL)
        return state.selection
      },
    },
  }
  return {
    state,
    ctx: {
      get(name) {
        state.lookups.push(name)
        if (state.throwOn === 'lookup') throw new Error(SENTINEL)
        // Any fallback to broad settings, providers, credentials, or writers is
        // an error. These seams are intentionally not part of P0 inspection.
        if (!['sessionController', 'agentDefaultModel'].includes(name)) throw new Error(SENTINEL)
        return available[name]
      },
    },
  }
}

async function treeSnapshot(dir) {
  const result = {}
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) result[entry.name] = await treeSnapshot(file)
    else result[entry.name] = (await readFile(file)).toString('base64')
  }
  return result
}

try {
  // Override BOTH output destinations: tsconfig's declarationDir otherwise
  // still points at the checked-in lib/types even with --outDir overridden.
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
  console.log('Compiled current src into repository-local disposable output; no build.sh or listeners.')
  const runtimeOut = process.argv.includes('--compiled') ? path.join(ROOT, 'lib') : out
  console.log(`Fixture runtime: ${process.argv.includes('--compiled') ? 'tracked lib' : 'fresh src emission'}`)
  const { HttpRouter } = await import(pathToFileURL(path.join(runtimeOut, 'router.js')).href)
  const { ApiKeyStore } = await import(pathToFileURL(path.join(runtimeOut, 'api-keys-store.js')).href)
  const { rejectAdmin } = await import(pathToFileURL(path.join(runtimeOut, 'api-keys.js')).href)
  const { registerModelConfigRoutes } = await import(pathToFileURL(path.join(runtimeOut, 'model-config.js')).href)
  const { registerOpenApiRoutes } = await import(pathToFileURL(path.join(runtimeOut, 'openapi.js')).href)

  const homes = []
  async function fixtureStore(name, legacy = '') {
    const home = path.join(scratch, name)
    const store = new ApiKeyStore(legacy, home)
    await store.ensureReady()
    const admin = await store.ensureAdminToken()
    homes.push(home)
    return { store, admin }
  }
  const enabled = await fixtureStore('auth-enabled', 'fixture-node-api-key')
  const managed = await enabled.store.create({ name: 'fixture-managed-key' })
  const disabled = await fixtureStore('auth-disabled')
  await disabled.store.setAuthEnabled(false)
  const originalStores = await Promise.all(homes.map(treeSnapshot))

  function setup({ fixture = hostFixture(), auth = enabled, config = {} } = {}) {
    const router = new HttpRouter({ pathPrefix: PREFIX, cors: true, ...config })
    router.setAuthService(auth.store)
    const registrations = []
    const originalGet = router.get.bind(router)
    router.get = (route, handler, options) => {
      registrations.push({ route, auth: options?.auth })
      originalGet(route, handler, options)
    }
    registerModelConfigRoutes(fixture.ctx, router, config, auth.store)
    return { router, fixture, auth, registrations }
  }

  async function call(target, {
    method = 'GET', url = `${PREFIX}/model-config/inspect?runtime=dsh`,
    headers = { 'x-admin-token': target.auth.admin }, ip,
  } = {}) {
    const req = {
      method, url, headers: { host: 'fixture.local:3080', ...headers },
      socket: { remoteAddress: ip ?? `127.40.${Math.floor(nextIp / 250)}.${nextIp++ % 250 + 1}` },
    }
    const response = {
      statusCode: 200, headersSent: false, headers: {}, raw: '',
      setHeader(name, value) { this.headers[name.toLowerCase()] = value },
      end(value) { this.raw = String(value ?? ''); this.headersSent = true },
    }
    const handled = await target.router.dispatch(req, response, PREFIX)
    const result = { handled, status: response.statusCode, headers: response.headers, raw: response.raw,
      body: response.raw ? JSON.parse(response.raw) : undefined }
    assert.ok(!result.raw.includes(SENTINEL), 'No secret/header/error sentinel may reach a response')
    if (handled && method !== 'OPTIONS') assert.match(String(result.headers['cache-control']), /no-store/)
    return result
  }

  await test('registration is GET + auth:admin and index wires it with the existing store', async () => {
    assert.equal(typeof rejectAdmin, 'function')
    const target = setup()
    assert.deepEqual(target.registrations, [{ route: '/model-config/inspect', auth: 'admin' }])
    const entry = await readFile(path.join(ROOT, 'src/index.ts'), 'utf8')
    assert.match(entry, /import \{ registerModelConfigRoutes \} from '\.\/model-config\.js'/)
    assert.match(entry, /registerModelConfigRoutes\(ctx, router, config, keyStore\)/)
    const docs = new Map()
    registerOpenApiRoutes({ get: (route, handler) => docs.set(route, handler) }, {})
    let spec
    docs.get('/openapi.json')({}, { setHeader() {}, end(raw) { spec = JSON.parse(raw) } })
    const inspect = spec.paths['/model-config/inspect'].get
    assert.deepEqual(inspect.security, [{ AdminTokenAuth: [] }])
    assert.equal(inspect.parameters[0].schema.default, 'dsh')
    for (const status of [200, 401, 403, 429, 501, 503]) assert.ok(inspect.responses[status])
    const dto = inspect.responses[200].content['application/json'].schema.properties.data
    assert.equal(dto.additionalProperties, false)
    assert.equal(dto.properties.capabilities.properties.conditionalWrite.enum[0], 'none')
    assert.equal('revision' in dto.properties, false)
    for (const file of ['README.md', 'README.zh.md', 'skills/dsh-web-service/SKILL.md']) {
      const text = await readFile(path.join(ROOT, file), 'utf8')
      assert.ok(text.includes('/model-config/inspect?runtime=dsh'))
      assert.ok(text.includes('MODEL_CATALOG_UNAVAILABLE'))
      assert.ok(text.includes('Admin Token'))
    }
  })

  await test('allowlist reconstructs DTO; no settings, schema, secrets, raw headers or toJSON escape', async () => {
    const selection = withPrivateFields({ provider: 'acme', model: 'large', reasoningEffort: 'high' })
    const catalog = withPrivateFields({
      groups: [withPrivateFields({ id: 'acme', models: [
        withPrivateFields({ id: 'small', name: 'Small', isDefault: true }),
        withPrivateFields({ id: 'large', name: 'Large', isDefault: false }),
      ] })],
      routableProviders: ['acme', 'route-only'], failures: [],
    })
    const target = setup({ fixture: hostFixture({ selection, catalog }) })
    const result = await call(target)
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.deepEqual(Object.keys(result.body).sort(), ['data', 'ok', 'timestamp'])
    const data = result.body.data
    assert.match(data.instanceId, /^[0-9a-f-]{36}$/)
    assert.deepEqual(data, {
      version: 1, runtime: 'dsh', instanceId: data.instanceId, supported: true, source: 'node-manager',
      capabilities: { inspect: true, preview: false, apply: false, rollback: false,
        providers: false, secrets: false, routing: false, conditionalWrite: 'none' },
      nodeDefault: { provider: 'acme', model: 'large', reasoningEffort: 'high' },
      models: [
        { provider: 'acme', id: 'small', name: 'Small', isDefault: false },
        { provider: 'acme', id: 'large', name: 'Large', isDefault: true },
        { provider: 'route-only', id: 'route-only', name: 'route-only', isDefault: false, routeOnly: true },
      ],
      activation: 'future-sessions',
    })
    assert.ok(!('revision' in data), 'P0 must not claim a revision/CAS fence for independent reads')
    assert.deepEqual(target.fixture.state.lookups, ['sessionController', 'agentDefaultModel'])
  })

  await test('route-only semantics, duplicate providers and duplicate model pairs are preserved safely', async () => {
    const target = setup({ fixture: hostFixture({
      selection: { provider: 'route', model: 'arbitrary-upstream-model' },
      catalog: {
        groups: [{ id: 'acme', models: [
          { id: 'large', name: 'Large', routeOnly: true }, { id: 'large', name: 'duplicate' },
        ] }, { id: 'empty', models: [] }],
        routableProviders: ['acme', 'route', 'route', 'empty'],
      },
    }) })
    const result = await call(target)
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.data.models, [
      { provider: 'acme', id: 'large', name: 'Large', isDefault: false, routeOnly: true },
      { provider: 'route', id: 'route', name: 'route', isDefault: true, routeOnly: true },
      { provider: 'empty', id: 'empty', name: 'empty', isDefault: false, routeOnly: true },
    ])
    assert.equal(result.body.data.nodeDefault.model, 'arbitrary-upstream-model')
  })

  await test('no default is optional, unavailable default is not invented from the catalog', async () => {
    const target = setup({ fixture: hostFixture({ selection: null, catalog: {
      default: withPrivateFields({ provider: 'untrusted', model: 'ignored' }), groups: [], routableProviders: [],
    } }) })
    const result = await call(target)
    assert.equal(result.status, 200)
    assert.equal('nodeDefault' in result.body.data, false)
    assert.deepEqual(result.body.data.models, [])
  })

  await test('reads are live; a missing catalog pair does not silently replace the node default', async () => {
    const target = setup()
    const first = await call(target)
    target.fixture.state.selection = { provider: 'other', model: 'not-listed' }
    const second = await call(target)
    assert.equal(second.status, 200)
    assert.deepEqual(second.body.data.nodeDefault, { provider: 'other', model: 'not-listed' })
    assert.ok(second.body.data.models.every(model => model.isDefault === false))
    assert.equal(first.body.data.instanceId, second.body.data.instanceId)
    assert.equal(target.fixture.state.reads.length, 4)
  })

  await test('name is primitive text or falls back to id, without coercing arbitrary objects', async () => {
    const target = setup({ fixture: hostFixture({ catalog: {
      groups: [{ id: 'acme', models: [{ id: 'large', name: { toString() { throw new Error(SENTINEL) } } }] }],
    } }) })
    const result = await call(target)
    assert.equal(result.status, 200)
    assert.equal(result.body.data.models[0].name, 'large')
  })

  await test('allowlisted fields are snapshotted once so accessors cannot substitute objects after validation', async () => {
    const counts = new Map()
    function once(fields) {
      const value = {}
      for (const [key, safe] of Object.entries(fields)) {
        Object.defineProperty(value, key, { get() {
          const counter = value === selection ? `selection.${key}` : `${Object.keys(fields).join(',')}.${key}`
          const n = (counts.get(counter) ?? 0) + 1
          counts.set(counter, n)
          if (n !== 1) throw new Error(SENTINEL)
          return safe
        } })
      }
      return value
    }
    const selection = once({ provider: 'acme', model: 'large', reasoningEffort: 'high' })
    const catalog = once({
      groups: [once({ id: 'acme', models: [once({ id: 'large', name: 'Large', routeOnly: true })] })],
      routableProviders: ['acme'], failures: [],
    })
    const result = await call(setup({ fixture: hostFixture({ selection, catalog }) }))
    assert.equal(result.status, 200)
    assert.equal(result.body.data.nodeDefault.model, 'large')
    assert.equal(result.body.data.models[0].name, 'Large')
    assert.ok([...counts.values()].every(n => n === 1))
  })

  await test('host read methods retain their receiver and support promise results', async () => {
    const services = {
      sessionController: {
        catalog: { groups: [], routableProviders: [] },
        modelCatalog() { assert.equal(this, services.sessionController); return Promise.resolve(this.catalog) },
      },
      agentDefaultModel: {
        selection: { provider: 'acme', model: 'large' },
        currentSelection() { assert.equal(this, services.agentDefaultModel); return Promise.resolve(this.selection) },
      },
    }
    const result = await call(setup({ fixture: hostFixture({ services }) }))
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.data.nodeDefault, services.agentDefaultModel.selection)
  })

  for (const [name, auth] of [['enabled', enabled], ['disabled', disabled]]) {
    await test(`explicit admin credential required even with data auth ${name}`, async () => {
      assert.equal(enabled.store.verifyDataToken('fixture-node-api-key').ok, true)
      assert.equal(enabled.store.verifyDataToken(managed.plaintext).ok, true)
      const rejectedHeaders = [
        {}, { authorization: 'Bearer wrong-admin' },
        { authorization: 'Bearer fixture-node-api-key' },
        { authorization: `Bearer ${managed.plaintext}` },
        { 'x-api-key': 'fixture-node-api-key' }, { 'x-api-key': auth.admin },
      ]
      for (const headers of rejectedHeaders) {
        const target = setup({ auth })
        const result = await call(target, { headers })
        assert.equal(result.status, 401)
        assert.equal(result.body.code, 'ADMIN_UNAUTHORIZED')
        assert.deepEqual(target.fixture.state.lookups, [], 'reject before host access')
      }
      assert.equal((await call(setup({ auth }), { headers: { 'x-admin-token': auth.admin } })).status, 200)
      assert.equal((await call(setup({ auth }), { headers: { authorization: `Bearer ${auth.admin}` } })).status, 200)
    })
  }

  await test('remote and cross-origin requests keep the shared admin guard protections', async () => {
    const forbidden = [
      { ip: '192.0.2.80', headers: { 'x-admin-token': enabled.admin, 'x-forwarded-for': '127.0.0.1' }, code: 'FORBIDDEN_REMOTE' },
      { headers: { 'x-admin-token': enabled.admin, origin: 'https://evil.example' }, code: 'FORBIDDEN_ORIGIN' },
      { headers: { 'x-admin-token': enabled.admin, origin: 'not-a-url' }, code: 'FORBIDDEN_ORIGIN' },
    ]
    for (const { code, ...request } of forbidden) {
      const target = setup()
      const result = await call(target, request)
      assert.equal(result.status, 403)
      assert.equal(result.body.code, code)
      assert.deepEqual(target.fixture.state.lookups, [])
    }
    assert.equal((await call(setup(), { headers: { 'x-admin-token': enabled.admin, origin: 'http://fixture.local:3080' } })).status, 200)
    for (const ip of ['::1', '::ffff:127.0.0.1']) assert.equal((await call(setup(), { ip })).status, 200)
    assert.equal((await call(setup({ config: { adminRemoteAccess: true } }), { ip: '192.0.2.81' })).status, 200)
    const remoteCrossOrigin = await call(setup({ config: { adminRemoteAccess: true } }), {
      ip: '192.0.2.81', headers: { 'x-admin-token': enabled.admin, origin: 'https://evil.example' },
    })
    assert.equal(remoteCrossOrigin.body.code, 'FORBIDDEN_ORIGIN')
  })

  await test('unsupported runtimes fail closed after auth and before any host read', async () => {
    for (const runtime of ['pi', 'codex', 'claude-code', 'DSH', '']) {
      const target = setup()
      const result = await call(target, { url: `${PREFIX}/model-config/inspect?runtime=${runtime}` })
      assert.equal(result.status, 501)
      assert.equal(result.body.code, 'NOT_SUPPORTED')
      assert.deepEqual(target.fixture.state.lookups, [])
    }
    const unauthorized = setup()
    assert.equal((await call(unauthorized, { url: `${PREFIX}/model-config/inspect?runtime=pi`, headers: {} })).status, 401)
    assert.deepEqual(unauthorized.fixture.state.lookups, [])
    assert.equal((await call(setup(), { url: `${PREFIX}/model-config/inspect` })).status, 200)
  })

  await test('missing/old host seams do not use broad settings or llm fallbacks', async () => {
    for (const services of [
      {}, { sessionController: {} }, { sessionController: { modelCatalog: 'not-callable' } },
      { sessionController: { modelCatalog: () => ({ groups: [] }) }, agentDefaultModel: {} },
    ]) {
      const result = await call(setup({ fixture: hostFixture({ services }) }))
      assert.equal(result.status, 501)
      assert.equal(result.body.code, 'NOT_SUPPORTED')
    }
  })

  await test('malformed catalog structures and unsafe identifiers refuse rather than serialize raw values', async () => {
    for (const catalog of [
      [], { groups: null }, { groups: [], routableProviders: {} }, { groups: [], failures: {} },
      { groups: [null] }, { groups: [{ id: {}, models: [] }] }, { groups: [{ id: 'p', models: {} }] },
      { groups: [{ id: 'p', models: [null] }] }, { groups: [{ id: 'p', models: [{ id: {} }] }] },
      { groups: [{ id: 'p', models: [{ id: 'bad\nmodel' }] }] },
      { groups: [{ id: 'p', models: [{ id: 'x'.repeat(1025) }] }] },
      { groups: [], routableProviders: [{}] },
    ]) {
      const result = await call(setup({ fixture: hostFixture({ catalog }) }))
      assert.equal(result.status, 501)
      assert.equal(result.body.code, 'NOT_SUPPORTED')
      assert.equal(result.body.data, undefined)
    }
  })

  await test('malformed default selection refuses; optional effort is strictly projected', async () => {
    for (const selection of [
      [], {}, { provider: {}, model: 'large' }, { provider: 'acme', model: 1 },
      { provider: 'acme', model: 'large', reasoningEffort: {} },
      { provider: 'acme', model: 'large', reasoningEffort: 'bad\neffort' },
    ]) {
      const result = await call(setup({ fixture: hostFixture({ selection }) }))
      assert.equal(result.status, 501)
      assert.equal(result.body.code, 'NOT_SUPPORTED')
    }
  })

  await test('upstream lookup/default/catalog exceptions never echo error text or stacks', async () => {
    for (const source of ['lookup', 'default', 'catalog']) {
      const fixture = hostFixture()
      fixture.state.throwOn = source
      const result = await call(setup({ fixture }))
      assert.equal(result.status, 503)
      assert.equal(result.body.code, 'MODEL_CONFIG_UNAVAILABLE')
      assert.deepEqual(Object.keys(result.body).sort(), ['code', 'error', 'ok', 'timestamp'])
      assert.equal(result.body.error, 'Model configuration inspection is temporarily unavailable')
    }
  })

  await test('catalog provider failures are distinct from a successful empty or route-only catalog', async () => {
    const failure = withPrivateFields({ id: 'acme', message: SENTINEL })
    const result = await call(setup({ fixture: hostFixture({ catalog: {
      groups: [], routableProviders: ['acme'], failures: [failure],
    } }) }))
    assert.equal(result.status, 503)
    assert.equal(result.body.code, 'MODEL_CATALOG_UNAVAILABLE')
    assert.equal(result.body.data, undefined)
  })

  await test('admin store exceptions are caught before router generic error echo', async () => {
    for (const method of ['ensureReady', 'verifyAdminToken']) {
      const store = {
        ensureReady: async () => {}, verifyAdminToken: () => true,
        [method]: () => { throw new Error(SENTINEL) },
      }
      const target = setup({ auth: { store, admin: 'fixture-admin' } })
      const result = await call(target)
      assert.equal(result.status, 503)
      assert.equal(result.body.code, 'MODEL_CONFIG_UNAVAILABLE')
      assert.deepEqual(target.fixture.state.lookups, [])
    }
  })

  await test('P0 exposes no preview/apply/rollback/provider/secret/default write routes', async () => {
    const target = setup()
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const suffix of ['inspect', 'preview', 'apply', 'rollback', 'providers', 'secrets', 'default']) {
        const result = await call(target, { method, url: `${PREFIX}/model-config/${suffix}` })
        assert.equal(result.handled, false)
      }
    }
    assert.deepEqual(target.fixture.state.lookups, [])
    assert.deepEqual(await Promise.all(homes.map(treeSnapshot)), originalStores, 'Inspection must not mutate fixture stores')
  })

  await test('incarnation is stable across registrations, different in another process, and not a durable node identity', async () => {
    const first = (await call(setup())).body.data.instanceId
    assert.equal((await call(setup())).body.data.instanceId, first)
    const childSource = `
      import { registerModelConfigRoutes } from ${JSON.stringify(pathToFileURL(path.join(runtimeOut, 'model-config.js')).href)};
      let handler;
      registerModelConfigRoutes({ get: name => name === 'sessionController'
        ? { modelCatalog: () => ({ groups: [], routableProviders: [] }) }
        : { currentSelection: () => undefined } },
        { get: (_path, run) => { handler = run; } }, {},
        { ensureReady: async () => {}, verifyAdminToken: token => token === 'fixture-child-admin' });
      let body;
      await handler({ headers: { host: 'fixture', 'x-admin-token': 'fixture-child-admin' }, socket: { remoteAddress: '127.0.0.1' } },
        { headersSent: false, setHeader() {}, end: raw => { body = JSON.parse(raw); } }, {}, { runtime: 'dsh' }, null);
      if (!body.ok) throw new Error('Fixture child failed');
      process.stdout.write(body.data.instanceId);
    `
    const child = execFileSync(process.execPath, ['--input-type=module', '-e', childSource], {
      cwd: ROOT, env, encoding: 'utf8', stdio: 'pipe',
    })
    assert.match(child, /^[0-9a-f-]{36}$/)
    assert.notEqual(child, first)
  })

  await test('shared admin failure limiter short-circuits host access including a later valid credential', async () => {
    const target = setup()
    const ip = '127.99.88.77'
    for (let attempt = 0; attempt < 11; attempt++) {
      assert.equal((await call(target, { ip, headers: { 'x-admin-token': 'wrong' } })).status, 401)
    }
    const result = await call(target, { ip })
    assert.equal(result.status, 429)
    assert.equal(result.body.code, 'RATE_LIMITED')
    assert.deepEqual(target.fixture.state.lookups, [])
  })
} finally {
  // Verify the resolved absolute target before deleting ONLY this test's random
  // scratch directory. Never use an environment-selected directory for cleanup.
  const resolved = await realpath(scratch)
  assert.equal(path.dirname(resolved), ROOT)
  assert.ok(path.basename(resolved).startsWith('.model-config-test-'))
  await rm(resolved, { recursive: true, force: true })
}
