#!/usr/bin/env node
/**
 * Real plugin router/account/key store/runtime + Python + WorkBuddy auth/SQLite/
 * onboarding/access gateway. Only the ONENAT control server, release asset and
 * public transport are fixtures. No external network requests or deployment.
 * WORKBUDDY_SOURCE selects the backend source (default: sibling checkout).
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const backendSource = path.resolve(root, process.env.WORKBUDDY_SOURCE || '../onenat-workbuddy-web')
const temporary = await mkdtemp(path.join(homedir(), '.dsh-onboarding-http-test-'))
await chmod(temporary, 0o700)
after(async () => {
  assert.equal(path.dirname(temporary), homedir())
  assert.ok(path.basename(temporary).startsWith('.dsh-onboarding-http-test-'))
  await rm(temporary, { recursive: true, force: true })
})
const pkg = path.join(temporary, 'plugin')
const backendDir = path.join(temporary, 'workbuddy')
await mkdir(pkg)
await mkdir(backendDir)
await writeFile(path.join(pkg, 'package.json'), '{"type":"module"}')
await writeFile(path.join(backendDir, 'package.json'), '{"type":"module"}')
const tsc = path.join(root, 'node_modules/typescript/bin/tsc')
function compile(cwd, inputs, output, noCheck = false) {
  const result = spawnSync(process.execPath, [tsc, ...inputs, '--outDir', output,
    '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--skipLibCheck', '--esModuleInterop', '--types', 'node', ...(noCheck ? ['--noCheck'] : ['--strict'])],
  { cwd, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
  assert.equal(result.status, 0, 'Fixture compilation failed:\n' + result.stdout + result.stderr)
}
compile(root, ['src/node-onboarding.ts', 'src/node-connection-page.ts'], path.join(pkg, 'lib'))
await cp(path.join(root, 'vendor/security-node'), path.join(pkg, 'vendor/security-node'), { recursive: true })
// Backend source includes its own independent typechecked suites; transpile the
// fixture graph without rewriting source or touching its checkout build outputs.
compile(backendSource, ['src/node-onboarding.ts', 'src/access-center.ts', 'src/access-node-gateway.ts',
  'src/security-db.ts', 'src/auth.ts', 'src/store.ts'], backendDir, true)
const plugin = name => import(pathToFileURL(path.join(pkg, 'lib', name + '.js')).href)
const backend = name => import(pathToFileURL(path.join(backendDir, name + '.js')).href)
const { NodeOnboarding, registerNodeOnboardingRoutes } = await plugin('node-onboarding')
const { ApiKeyStore } = await plugin('api-keys-store')
const { HttpRouter } = await plugin('router')
const { OnenatTunnel, onenatReleaseAsset } = await plugin('onenat-tunnel')
const { NODE_CONNECTION_HTML, NODE_CONNECTION_SCRIPT } = await plugin('node-connection-page')
const { AuthService } = await backend('auth')
const { SecurityDatabase } = await backend('security-db')
const { WorkStore } = await backend('store')
const { AccessCenter } = await backend('access-center')
const { AccessNodeGateway } = await backend('access-node-gateway')
const { NodeOnboarding: BackendOnboarding } = await backend('node-onboarding')
const P = await backend('node-security')
const realFetch = globalThis.fetch
const supported = ['darwin', 'linux'].includes(process.platform) && process.getuid?.() !== 0
const smoke = (name, fn) => test(name, { skip: supported ? false : 'requires non-root macOS/Linux and Python' }, fn)
const LOGIN_PASSWORD = 'fixture-login-password-123'
const DASH_PASSWORD = 'fixture-dashboard-password-456'
const DASH_COOKIE = 'fixture-dashboard-cookie-789'
const AUTHTOKEN = 'ngk-' + 'c'.repeat(32)
const READ_KEY = 'onk-' + 'r'.repeat(32)
const prefix = '/api/v1'
let fixtureId = 0
const json = (res, status, value, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(value))
}
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return server.address().port
}
async function closeServer(server) {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
function request(port, suffix, { method = 'GET', headers = {}, body } = {}) {
  const encoded = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: prefix + '/node-connection' + suffix,
      method, headers: { ...(encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {}), ...headers } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try { resolve({ status: res.statusCode, headers: res.headers, text, body: JSON.parse(text) }) }
        catch { reject(new Error('Non-JSON response ' + res.statusCode + ': ' + text)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(20000, () => req.destroy(new Error('fixture request timeout')))
    req.end(encoded)
  })
}
function cookieToken(req) {
  return /(?:^|;\s*)wb_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1]
}

async function fixture(t) {
  const base = path.join(temporary, 'fixture-' + ++fixtureId)
  const workspace = path.join(base, 'workspace')
  await mkdir(path.join(workspace, 'project'), { recursive: true, mode: 0o700 })
  await writeFile(path.join(workspace, 'hello.txt'), 'real filesystem input', { mode: 0o600 })
  const publicOrigin = 'https://dsh-onboarding-' + fixtureId + '.example'
  const record = { calls: [], dashboard: [], release: [], spawned: [], nodeEndpoints: [], credentials: [], startService: 0 }
  let currentNode, router, mainPort = 0, mappedPort = 0
  let spawnedCount = 0, failDashboard = false
  let installation
  const children = new Set()
  const keys = new ApiKeyStore('', path.join(base, 'dsh-home'))
  await keys.ensureReady()
  const config = { pathPrefix: prefix, defaultCwd: workspace, cors: true, adminRemoteAccess: false }
  const handler = async (req, res) => {
    try {
      if (req.url.startsWith('/v1/')) record.nodeEndpoints.push(req.url)
      if (currentNode.handle(req, res)) return
      if (!await router.dispatch(req, res, prefix)) json(res, 404, { ok: false })
    } catch (err) { json(res, 500, { ok: false, error: err.message }) }
  }
  const mainServer = createServer(handler), mappedServer = createServer(handler)
  mainPort = await listen(mainServer)
  mappedPort = await listen(mappedServer)
  // This mapping substitutes only external TLS transport, retaining original URL
  // validation and all protocol signature verification in the WorkBuddy client.
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.origin === publicOrigin) return realFetch('http://127.0.0.1:' + mappedPort + url.pathname + url.search, init)
    assert.equal(url.hostname, '127.0.0.1', 'Unexpected external network request: ' + url.origin)
    return realFetch(input, init)
  }
  const dashboard = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture'), body = await readBody(req)
      record.dashboard.push({ path: url.pathname, method: req.method, body, cookie: req.headers.cookie })
      if (url.pathname === '/api/login') {
        assert.deepEqual(body, { username: 'dashboard-owner', password: DASH_PASSWORD })
        return json(res, failDashboard ? 401 : 200, { ok: !failDashboard }, { 'set-cookie': 'onenat_dash=' + DASH_COOKIE + '; HttpOnly; Path=/' })
      }
      assert.equal(req.headers.cookie, 'onenat_dash=' + DASH_COOKIE)
      if (url.pathname === '/api/client/bootstrap') {
        assert.equal(body.protocol, 'https')
        assert.ok(keys.verifyDataToken(body.api_key).ok)
        installation = { client_id: body.client_id, tunnel_id: 'tunnel-fixture', mapping_id: 'mapping-fixture',
          name: body.name, protocol: 'https', subdomain: 'fixture', remote_port: 0, local_port: body.local_port }
      }
      if (url.pathname === '/api/client/status') assert.equal(url.searchParams.get('client_id'), installation.client_id)
      const online = children.size > 0
      return json(res, 200, { ...installation, online, ...(online ? { public_url: publicOrigin } : {}),
        https_available: true, https_addr: ':443', config: 'server_addr: "control.example:4443"\ntrust_host_root_certs: false\nauthtoken: "' + AUTHTOKEN + '"\ngate: off\ninspect_addr: disabled\ntunnels: {}\n',
        read_api_key: READ_KEY, password: DASH_PASSWORD, cookie: DASH_COOKIE })
    } catch (err) { json(res, 500, { ok: false, error: err.message }) }
  })
  const dashboardPort = await listen(dashboard)
  const db = new SecurityDatabase(path.join(base, 'web-data'))
  const auth = new AuthService(path.join(base, 'web-data'), 'admin@example.test', LOGIN_PASSWORD, db)
  const user = auth.createUser('alice@example.test', LOGIN_PASSWORD)
  auth.setRole(user.id, 'user')
  const issuer = generateKeyPairSync('ed25519')
  const issuerKey = issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const issuerPublic = issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  db.putDocument('node-broker:keys', { privateKey: issuerKey, publicKey: issuerPublic })
  const oldDelay = process.env.WORKBUDDY_ARCHIVE_BOOT_DELAY_MS
  process.env.WORKBUDDY_ARCHIVE_BOOT_DELAY_MS = '3600000'
  const store = new WorkStore(path.join(base, 'web-data/store.json'), db)
  if (oldDelay === undefined) delete process.env.WORKBUDDY_ARCHIVE_BOOT_DELAY_MS
  else process.env.WORKBUDDY_ARCHIVE_BOOT_DELAY_MS = oldDelay
  const gateway = new AccessNodeGateway(db)
  const access = new AccessCenter(db, auth, store, gateway)
  const webOnboarding = new BackendOnboarding(db, auth, access,
    () => ({ baseUrl: 'http://127.0.0.1:' + dashboardPort, username: 'dashboard-owner', password: DASH_PASSWORD }),
    globalThis.fetch, (mappingId, apiKey) => record.credentials.push({ mappingId, apiKey }))
  const workBuddy = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture'), body = await readBody(req)
      record.calls.push({ path: url.pathname, method: req.method, body, cookie: req.headers.cookie })
      if (url.pathname === '/api/auth/login') {
        const token = await auth.login(body.username, body.password, '127.0.0.1')
        if (!token) return json(res, 401, { ok: false, error: 'bad credentials' })
        return json(res, 200, { ok: true, data: { username: body.username } }, { 'set-cookie': 'wb_session=' + token + '; HttpOnly; Path=/' })
      }
      const actor = auth.validateSession(cookieToken(req))
      if (!actor) return json(res, 401, { ok: false, error: 'unauthorized' })
      let data
      if (url.pathname.endsWith('/provision')) data = await webOnboarding.provision(actor, body)
      else if (url.pathname.endsWith('/status')) data = await webOnboarding.status(actor, { installationId: url.searchParams.get('installationId') })
      else if (url.pathname.endsWith('/bind')) data = await webOnboarding.bind(actor, body)
      else return json(res, 404, { ok: false })
      json(res, 200, { ok: true, data })
    } catch (err) { json(res, err.status || 500, { ok: false, code: err.code, error: err.message }) }
  })
  const workBuddyPort = await listen(workBuddy)
  const asset = onenatReleaseAsset()
  const fakeBinary = Buffer.from('#!' + process.execPath + '\nsetInterval(() => {}, 1000); process.on("SIGTERM", () => process.exit(0));\n')
  let releaseTag = 'v-fixture'
  const releases = new Map([[releaseTag, { bytes: fakeBinary, broken: false }]])
  const releaseFetch = async input => {
    const url = String(input); record.release.push(url)
    if (url === 'https://api.github.com/repos/toddpan/onenat/releases/latest') return new Response(JSON.stringify({ tag_name: releaseTag }))
    const match = /^https:\/\/github\.com\/toddpan\/onenat\/releases\/download\/([^/]+)\/(.+)$/.exec(url)
    if (match) {
      const release = releases.get(decodeURIComponent(match[1]))
      if (!release) throw new Error('Unexpected release tag: ' + match[1])
      if (match[2] === 'checksums.txt') {
        const claimed = createHash('sha256').update(release.broken ? Buffer.from('other') : release.bytes).digest('hex')
        return new Response(claimed + '  ' + asset + '\n')
      }
      if (match[2] === asset) return new Response(release.bytes)
    }
    if (new URL(url).origin === publicOrigin) return realFetch('http://127.0.0.1:' + mappedPort + new URL(url).pathname)
    throw new Error('Unexpected release URL: ' + url)
  }
  const tunnelFactory = () => new OnenatTunnel({ dir: path.join(keys.dir, 'node-connection/onenat'), onLocalPort: () => mappedPort,
    fetch: releaseFetch, spawnClient(binary, args) {
      assert.deepEqual(args.slice(0, 2), ['-log=stdout', '-log-level=INFO'])
      assert.equal(args.at(-1), 'managed')
      assert.ok(args[2].startsWith('-config='))
      const child = spawn(process.execPath, [binary, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } })
      spawnedCount++; record.spawned.push({ binary, args, pid: child.pid })
      children.add(child)
      child.once('exit', () => children.delete(child))
      return child
    } })
  const ctx = { get(name) { if (name === 'workspaceRegistry') return { list: () => [{ cwd: workspace }] } } }
  const createNode = () => {
    const node = new NodeOnboarding(ctx, config, keys, { getLocalPort: () => mappedPort, getMainPort: () => mainPort,
      async startService() { record.startService++; return { ok: true, message: 'fixture service already listening' } } },
    { tunnel: tunnelFactory() })
    router = new HttpRouter(config)
    router.setAuthService(keys)
    registerNodeOnboardingRoutes(router, config, keys, node)
    return node
  }
  currentNode = createNode()
  t.after(async () => {
    await currentNode.close()
    globalThis.fetch = realFetch
    for (const child of children) child.kill('SIGKILL')
    await Promise.all([mainServer, mappedServer, workBuddy, dashboard].map(closeServer))
    store.close(); db.close()
  })
  const localHeaders = extra => ({ origin: 'http://127.0.0.1:' + mainPort, 'sec-fetch-site': 'same-origin', ...extra })
  const nonce = async () => {
    const result = await request(mainPort, '/local-token', { headers: localHeaders() })
    assert.equal(result.status, 200, result.text)
    return result.body.data.token
  }
  const login = (token, extra = {}) => request(mainPort, '/login', { method: 'POST', headers: localHeaders({ 'x-node-setup-token': token }),
    body: { serverUrl: 'http://127.0.0.1:' + workBuddyPort, username: user.username, password: LOGIN_PASSWORD, name: 'test-node', ...extra } })
  return { base, keys, workspace, mainPort, mappedPort, workBuddyPort, publicOrigin, record, db, auth, access, user,
    issuerKey, issuerPublic, localHeaders, nonce, login, get node() { return currentNode }, get children() { return children },
    get spawnedCount() { return spawnedCount }, setFailDashboard(value) { failDashboard = value }, fakeBinary,
    setRelease(tag, bytes, broken = false) {
      releases.set(tag, { bytes, broken })
      releaseTag = tag
    },
    async restart() { await currentNode.close(); currentNode = createNode(); await currentNode.restore() },
    async client() {
      const call = record.calls.find(call => call.path.endsWith('/bind'))
      const envelope = JSON.parse(Buffer.from(call.body.connectionInfo.slice(9), 'base64url'))
      const ticket = JSON.parse(Buffer.from(envelope.pairingCode.slice(8), 'base64url'))
      return new P.NodeSecurityClient({ baseUrl: publicOrigin, pin: ticket, fetch: globalThis.fetch })
    },
  }
}

smoke('real account login provisions transport and automatically pairs a signed node without browser secrets', async t => {
  const f = await fixture(t), token = await f.nonce(), response = await f.login(token)
  assert.equal(response.status, 200, response.text)
  const result = response.body.data
  assert.equal(result.username, f.user.username)
  assert.equal(result.baseUrl, f.publicOrigin)
  assert.equal(result.nodeId, f.node.runtime.status().nodeId)
  const calls = f.record.calls.map(call => call.path.split('/').at(-1))
  assert.deepEqual(calls, ['login', 'provision', 'status', 'bind'])
  const provision = f.record.calls[1].body
  const verified = f.keys.verifyDataToken(provision.apiKey)
  assert.equal(verified.ok, true)
  const key = f.keys.get(verified.keyId)
  assert.equal(key.source, 'managed'); assert.equal(!!key.custom, false); assert.equal(!!key.expiresAt, false)
  assert.equal(f.keys.isEnforced(), true)
  assert.equal(provision.localPort, f.mappedPort)
  assert.ok(/^[A-Za-z0-9_-]{16,80}$/.test(provision.installationId))
  assert.ok(f.record.nodeEndpoints.includes('/v1/identity'))
  assert.ok(f.record.nodeEndpoints.includes('/v1/pair'))
  assert.deepEqual(f.record.credentials, [{ mappingId: 'mapping-fixture', apiKey: READ_KEY }])
  const cookie = f.record.calls[1].cookie
  const accountFile = path.join(f.keys.dir, 'node-connection/workbuddy-account.json')
  const accountText = await readFile(accountFile, 'utf8')
  assert.equal((await lstat(accountFile)).mode & 0o777, 0o600)
  assert.ok(accountText.includes(cookie))
  assert.ok(!accountText.includes(LOGIN_PASSWORD))
  const browserStatus = await request(f.mainPort, '', { headers: f.localHeaders({ 'x-node-setup-token': token }) })
  assert.equal(browserStatus.status, 200)
  const browserPayload = response.text + browserStatus.text
  for (const secret of [provision.apiKey, LOGIN_PASSWORD, DASH_PASSWORD, DASH_COOKIE, cookie, AUTHTOKEN, READ_KEY, 'wbpair1.', 'dshnode1.']) {
    assert.equal(browserPayload.includes(secret), false, 'browser payload exposed a private credential')
  }
  const managedFile = path.join(f.keys.dir, 'node-connection/managed-key.json')
  assert.deepEqual(JSON.parse(await readFile(managedFile, 'utf8')), { id: key.id })
  assert.equal((await lstat(managedFile)).mode & 0o777, 0o600)
  const configFile = path.join(f.keys.dir, 'node-connection/onenat/managed.yml')
  const managedConfig = await readFile(configFile, 'utf8')
  assert.equal((await lstat(configFile)).mode & 0o777, 0o600)
  assert.ok(managedConfig.includes(AUTHTOKEN))
  for (const secret of [provision.apiKey, LOGIN_PASSWORD, DASH_PASSWORD, DASH_COOKIE, READ_KEY]) assert.ok(!managedConfig.includes(secret))
  const nodeView = f.access.nodes(f.auth.validateSession(cookie.split('=')[1]))
  assert.equal(nodeView.length, 1)
  assert.deepEqual(nodeView[0].dshRef, { kind: 'mapping', mappingId: 'mapping-fixture' })
  assert.deepEqual(nodeView[0].roots, [f.workspace])
  const client = await f.client(), identity = await client.identity()
  const resolved = await client.control('catalog/resolve', { path: f.workspace }, f.issuerKey)
  assert.deepEqual(resolved.entries, [{ name: 'project', path: path.join(f.workspace, 'project'), isDirectory: true }])
  const holder = generateKeyPairSync('ed25519'), leaseId = randomUUID()
  const capability = () => P.issueNodeCapability({ protocol: P.NODE_SECURITY_PROTOCOL, nodeId: identity.nodeId, nodeInstanceId: identity.instanceId,
    workspaceId: resolved.workspaceId, userId: f.user.id, credentialId: 'credential-fixture', credentialVersion: 1, taskId: 'task-fixture',
    policyVersion: resolved.policyVersion, paths: ['.'], actions: ['lease.open', 'lease.revoke', 'file.list'],
    issuerKeyId: P.nodeKeyId(f.issuerPublic), operationId: randomUUID(), leaseId,
    holderPublicKey: holder.publicKey.export({ type: 'spki', format: 'pem' }).toString(), issuedAt: Date.now(), expiresAt: Date.now() + 15000 }, f.issuerKey)
  await client.openLease(capability(), holder.privateKey)
  assert.ok((await client.list(capability(), holder.privateKey)).entries.some(entry => entry.name === 'hello.txt'))
  await client.revokeLease(capability(), holder.privateKey)
  assert.equal(f.record.release.filter(url => new URL(url).hostname.endsWith('github.com')).length, 3)
  assert.equal(f.spawnedCount, 1)
})

smoke('local GUI nonce rejects mapped port, wrong Host and cross-origin access; it cannot mint manual tickets', async t => {
  const f = await fixture(t)
  const good = await request(f.mainPort, '/local-token', { headers: f.localHeaders() })
  assert.equal(good.status, 200)
  assert.equal(good.headers['cross-origin-resource-policy'], 'same-origin')
  assert.equal(good.headers['access-control-allow-origin'], undefined)
  const token = good.body.data.token
  assert.match(token, /^[a-f0-9]{64}$/)
  const rejected = [
    [f.mappedPort, { host: '127.0.0.1:' + f.mainPort, origin: 'http://127.0.0.1:' + f.mainPort }],
    [f.mainPort, { host: 'mapped.example:' + f.mainPort }],
    [f.mainPort, { host: '127.0.0.1:' + f.mappedPort }],
    [f.mainPort, { origin: 'https://evil.example' }],
    [f.mainPort, { 'sec-fetch-site': 'cross-site' }],
  ]
  for (const [port, headers] of rejected) {
    const result = await request(port, '/local-token', { headers })
    assert.equal(result.status, 403, result.text)
    assert.equal(result.text.includes(token), false)
  }
  assert.equal((await request(f.mainPort, '', { headers: f.localHeaders({ 'x-node-setup-token': token }) })).status, 200)
  assert.equal((await request(f.mappedPort, '', { headers: { 'x-node-setup-token': token } })).status, 401)
  assert.equal((await request(f.mainPort, '', { headers: f.localHeaders({ 'x-node-setup-token': 'wrong' }) })).status, 401)
  for (const endpoint of ['/pairing', '/connect']) {
    const denied = await request(f.mainPort, endpoint, { method: 'POST', headers: f.localHeaders({ 'x-node-setup-token': token }), body: {} })
    assert.equal(denied.status, 401)
  }
  assert.equal(f.record.calls.length, 0)
  assert.equal(f.node.runtime.status().running, false)
})

smoke('stop, reconnect and process restart retain node identity, account and managed key', async t => {
  const f = await fixture(t), token = await f.nonce(), login = await f.login(token)
  assert.equal(login.status, 200, login.text)
  const before = f.node.runtime.status()
  const keyIds = f.keys.list().map(key => key.id)
  const stop = await request(f.mainPort, '/stop', { method: 'POST', headers: f.localHeaders({ 'x-node-setup-token': token }) })
  assert.equal(stop.status, 200, stop.text)
  assert.equal(f.node.runtime.status().running, false)
  assert.equal(f.children.size, 0)
  const reconnect = await request(f.mainPort, '/bind', { method: 'POST', headers: f.localHeaders({ 'x-node-setup-token': token }) })
  assert.equal(reconnect.status, 200, reconnect.text)
  assert.equal(reconnect.body.data.nodeId, before.nodeId)
  assert.equal(f.record.calls.filter(call => call.path.endsWith('/login')).length, 1)
  assert.deepEqual(f.keys.list().map(key => key.id), keyIds)
  const preRestartLogins = f.record.calls.filter(call => call.path.endsWith('/login')).length
  const preRestartBinds = f.record.calls.filter(call => call.path.endsWith('/bind')).length
  const preRestartProvisions = f.record.calls.filter(call => call.path.endsWith('/provision')).length
  const pairingFile = path.join(f.keys.dir, 'workbuddy-node/state/pairing.json')
  const pairingBefore = await readFile(pairingFile, 'utf8')
  await f.restart()
  const afterStatus = f.node.runtime.status()
  assert.equal(afterStatus.running, true)
  assert.equal(afterStatus.nodeId, before.nodeId)
  assert.equal(afterStatus.publicKey, before.publicKey)
  assert.notEqual(afterStatus.instanceId, before.instanceId)
  assert.equal((await f.node.account.status()).nodeId, before.nodeId)
  assert.equal(f.record.calls.filter(call => call.path.endsWith('/login')).length, preRestartLogins)
  assert.equal(f.record.calls.filter(call => call.path.endsWith('/bind')).length, preRestartBinds)
  assert.equal(f.record.calls.filter(call => call.path.endsWith('/provision')).length, preRestartProvisions + 1)
  const provisionCalls = f.record.calls.filter(call => call.path.endsWith('/provision'))
  assert.equal(provisionCalls.at(-1).body.apiKey, provisionCalls[0].body.apiKey)
  assert.equal(provisionCalls.at(-1).body.installationId, provisionCalls[0].body.installationId)
  assert.equal(await readFile(pairingFile, 'utf8'), pairingBefore)
  assert.deepEqual(f.keys.list().map(key => key.id), keyIds)
  assert.notEqual(await f.nonce(), token)
  const client = await f.client()
  assert.equal((await client.control('catalog/resolve', { path: f.workspace }, f.issuerKey)).path, f.workspace)
  assert.equal(f.record.release.filter(url => new URL(url).hostname.endsWith('github.com')).length, 3, 'cached checksum-verified release must be reused')
  assert.equal(f.spawnedCount, 3)
})

smoke('wrong account password fails before provisioning or starting the managed client', async t => {
  const f = await fixture(t), token = await f.nonce()
  const response = await request(f.mainPort, '/login', { method: 'POST', headers: f.localHeaders({ 'x-node-setup-token': token }),
    body: { serverUrl: 'http://127.0.0.1:' + f.workBuddyPort, username: f.user.username, password: 'wrong' } })
  assert.equal(response.status, 401, response.text)
  assert.deepEqual(f.record.calls.map(call => call.path), ['/api/auth/login'])
  assert.equal(f.record.dashboard.length, 0)
  assert.equal(f.record.release.length, 0)
  assert.equal(f.node.runtime.status().running, false)
  assert.equal((await f.node.account.status()).configured, false)
})

smoke('backend provisioning failure exposes a generic error and never starts external transport', async t => {
  const f = await fixture(t), token = await f.nonce()
  f.setFailDashboard(true)
  const response = await f.login(token)
  assert.equal(response.status, 502, response.text)
  assert.equal(response.body.code, 'ONENAT_LOGIN_FAILED')
  assert.equal(f.record.calls.some(call => call.path.endsWith('/bind')), false)
  assert.equal(f.record.release.length, 0)
  assert.equal(f.children.size, 0)
  const status = await request(f.mainPort, '', { headers: f.localHeaders({ 'x-node-setup-token': token }) })
  const provision = f.record.calls.find(call => call.path.endsWith('/provision'))
  for (const secret of [LOGIN_PASSWORD, DASH_PASSWORD, DASH_COOKIE, AUTHTOKEN, READ_KEY, provision.body.apiKey]) {
    assert.equal((response.text + status.text).includes(secret), false)
  }
})

smoke('remember password seals the secret, auto relogs in after session expiry, and can be forgotten', async t => {
  const f = await fixture(t), token = await f.nonce()
  const login = await f.login(token, { rememberPassword: true })
  assert.equal(login.status, 200, login.text)
  const accountFile = path.join(f.keys.dir, 'node-connection/workbuddy-account.json')
  const accountText = await readFile(accountFile, 'utf8')
  const record = JSON.parse(accountText)
  assert.ok(typeof record.passwordSealed === 'string' && record.passwordSealed.length >= 40)
  assert.equal(accountText.includes(LOGIN_PASSWORD), false, 'remembered password must be sealed, never plaintext')
  const status = await request(f.mainPort, '', { headers: f.localHeaders({ 'x-node-setup-token': token }) })
  assert.equal(status.body.data.account.passwordSaved, true)
  const sessionToken = call => /wb_session=([a-f0-9]{64})/.exec(call.cookie || '')?.[1]
  const latestProvision = () => f.record.calls.filter(call => call.path.endsWith('/provision')).at(-1)
  // 服务端吊销当前会话（等价于 cookie 过期）
  f.auth.logout(sessionToken(latestProvision()))
  const loginsBefore = f.record.calls.filter(call => call.path.endsWith('/login')).length
  const reconnect = await request(f.mainPort, '/bind', { method: 'POST', headers: f.localHeaders({ 'x-node-setup-token': token }) })
  assert.equal(reconnect.status, 200, reconnect.text)
  assert.equal(f.record.calls.filter(call => call.path.endsWith('/login')).length, loginsBefore + 1, 'expired session must trigger exactly one auto re-login')
  const healed = JSON.parse(await readFile(accountFile, 'utf8'))
  assert.match(healed.cookie, /^wb_session=[a-f0-9]{64}$/)
  assert.notEqual(healed.cookie, record.cookie, 'auto re-login must refresh the stored session cookie')
  assert.equal(reconnect.text.includes(LOGIN_PASSWORD), false)
  // 清除记住的密码后，再次过期只能手动重新登录
  const forget = await request(f.mainPort, '/forget-password', { method: 'POST', headers: f.localHeaders({ 'x-node-setup-token': token }) })
  assert.equal(forget.status, 200, forget.text)
  assert.equal(forget.body.data.account.passwordSaved, false)
  const cleared = JSON.parse(await readFile(accountFile, 'utf8'))
  assert.equal(cleared.passwordSealed, undefined)
  f.auth.logout(sessionToken(latestProvision()))
  const manual = await request(f.mainPort, '/bind', { method: 'POST', headers: f.localHeaders({ 'x-node-setup-token': token }) })
  assert.equal(manual.status, 401, manual.text)
})

smoke('workspace roots follow the DSH registry by default and a custom list overrides them', async t => {
  const f = await fixture(t), token = await f.nonce()
  const status0 = await request(f.mainPort, '', { headers: f.localHeaders({ 'x-node-setup-token': token }) })
  assert.equal(status0.body.data.workspace.mode, 'default')
  assert.deepEqual(status0.body.data.workspace.defaults, [f.workspace])
  assert.deepEqual(status0.body.data.workspace.effective, [f.workspace])
  const dirs = await request(f.mainPort, '/fs-dirs?path=' + encodeURIComponent(f.workspace), { headers: f.localHeaders({ 'x-node-setup-token': token }) })
  assert.equal(dirs.status, 200, dirs.text)
  assert.deepEqual(dirs.body.data.dirs, ['project'], 'fs-dirs lists only subdirectories, not files or hidden entries')
  assert.equal(dirs.body.data.parent, path.dirname(f.workspace))
  assert.equal(dirs.body.data.home, homedir())
  const missing = await request(f.mainPort, '/fs-dirs?path=/nonexistent-fixture-dir', { headers: f.localHeaders({ 'x-node-setup-token': token }) })
  assert.equal(missing.status, 400, missing.text)
  assert.match(missing.body.error, /目录不存在/)
  const customDir = path.join(f.base, 'custom-root')
  await mkdir(customDir, { recursive: true, mode: 0o700 })
  // 真实开发目录常含符号链接：注册目录解析不得被目录内容阻塞（文件访问仍走严格校验）
  await symlink(f.workspace, path.join(customDir, 'inside-link'))
  const saved = await request(f.mainPort, '/workspace', { method: 'POST', headers: f.localHeaders({ 'x-node-setup-token': token }),
    body: { mode: 'custom', roots: [customDir, '   ', customDir] } })
  assert.equal(saved.status, 200, saved.text)
  assert.equal(saved.body.data.applying, false, 'saving before login must not trigger a rebind')
  assert.deepEqual(saved.body.data.effective, [customDir], 'duplicates and blanks must be dropped')
  const login = await f.login(token)
  assert.equal(login.status, 200, login.text)
  assert.deepEqual(f.node.runtime.status().roots, [customDir], 'the security node must serve the custom roots')
  for (const bad of [{ mode: 'custom', roots: [] }, { mode: 'custom', roots: ['/'] }, { mode: 'custom', roots: [42] }]) {
    const rejected = await request(f.mainPort, '/workspace', { method: 'POST', headers: f.localHeaders({ 'x-node-setup-token': token }), body: bad })
    assert.equal(rejected.status, 400, rejected.text)
  }
  const bindsBefore = f.record.calls.filter(call => call.path.endsWith('/bind')).length
  const reset = await request(f.mainPort, '/workspace', { method: 'POST', headers: f.localHeaders({ 'x-node-setup-token': token }), body: { mode: 'default' } })
  assert.equal(reset.status, 200, reset.text)
  assert.equal(reset.body.data.applying, true)
  const deadline = Date.now() + 15000
  let rebinds = 0
  while (Date.now() < deadline) {
    rebinds = f.record.calls.filter(call => call.path.endsWith('/bind')).length
    if (rebinds > bindsBefore && (await f.node.tunnel.status()).phase === 'online') break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(rebinds > bindsBefore, 'restoring defaults while bound must rebind in the background')
  assert.deepEqual(f.node.runtime.status().roots, [f.workspace], 'the restarted security node must serve the registry roots again')
  const cookie2 = f.record.calls.filter(call => call.path.endsWith('/provision')).at(-1).cookie
  const nodeView2 = f.access.nodes(f.auth.validateSession(cookie2.split('=')[1]))
  assert.deepEqual(nodeView2[0].roots, [f.workspace], 'rebind must refresh the roots registered on the WorkBuddy platform')
})

smoke('onenat client check-update and upgrade manage the release lifecycle', async t => {
  const f = await fixture(t), token = await f.nonce()
  const login = await f.login(token)
  assert.equal(login.status, 200, login.text)
  const check = await request(f.mainPort, '/onenat/update', { headers: f.localHeaders({ 'x-node-setup-token': token }) })
  assert.equal(check.status, 200, check.text)
  assert.deepEqual(check.body.data, { installed: true, current: 'v-fixture', latest: 'v-fixture', updateAvailable: false })
  const noop = await request(f.mainPort, '/onenat/upgrade', { method: 'POST', headers: f.localHeaders({ 'x-node-setup-token': token }), body: {} })
  assert.equal(noop.status, 200, noop.text)
  assert.equal(noop.body.data.noop, true)
  assert.equal(f.spawnedCount, 1, 'noop upgrade must not restart the client')
  f.setRelease('v9.0.0', f.fakeBinary)
  const check2 = await request(f.mainPort, '/onenat/update', { headers: f.localHeaders({ 'x-node-setup-token': token }) })
  assert.deepEqual(check2.body.data, { installed: true, current: 'v-fixture', latest: 'v9.0.0', updateAvailable: true })
  const spawned = f.spawnedCount
  const upgrade = await request(f.mainPort, '/onenat/upgrade', { method: 'POST', headers: f.localHeaders({ 'x-node-setup-token': token }), body: {} })
  assert.equal(upgrade.status, 200, upgrade.text)
  assert.equal(upgrade.body.data.releaseTag, 'v9.0.0')
  assert.equal(upgrade.body.data.running, true)
  assert.equal(f.spawnedCount, spawned + 1)
  f.setRelease('v10.0.0', Buffer.from('broken-bytes'), true)
  const failed = await request(f.mainPort, '/onenat/upgrade', { method: 'POST', headers: f.localHeaders({ 'x-node-setup-token': token }), body: {} })
  assert.equal(failed.status, 400, failed.text)
  assert.equal(failed.body.error.includes('SHA256'), true)
  const after = await request(f.mainPort, '', { headers: f.localHeaders({ 'x-node-setup-token': token }) })
  assert.equal(after.body.data.tunnel.releaseTag, 'v9.0.0', 'failed upgrade must keep the verified release')
  assert.equal(after.body.data.tunnel.running, true)
  const logs = await request(f.mainPort, '/onenat/logs', { headers: f.localHeaders({ 'x-node-setup-token': token }) })
  assert.equal(logs.status, 200, logs.text)
  assert.ok(Array.isArray(logs.body.data.lines))
})

test('settings account UI routes do not require the API-key management gate', () => {
  assert.ok(NODE_CONNECTION_HTML.includes('nodeWorkBuddyPassword'))
  assert.ok(NODE_CONNECTION_HTML.includes('nodeTab-account'))
  assert.ok(NODE_CONNECTION_HTML.includes('nodePanel-workspace'))
  assert.ok(NODE_CONNECTION_HTML.includes('nodePanel-onenat'))
  assert.ok(NODE_CONNECTION_HTML.includes('nodeWsPicker'), 'workspace tab must offer a directory picker dialog')
  assert.ok(NODE_CONNECTION_HTML.includes('nodeWsBrowse'))
  assert.ok(NODE_CONNECTION_SCRIPT.includes('/local-token'))
  assert.ok(NODE_CONNECTION_SCRIPT.includes("nodeApi('/login'"))
  assert.ok(NODE_CONNECTION_SCRIPT.includes("nodeApi('/bind'"))
  assert.ok(NODE_CONNECTION_SCRIPT.includes("nodeApi('/workspace'"))
  assert.ok(NODE_CONNECTION_SCRIPT.includes("nodeApi('/fs-dirs'"))
  assert.ok(NODE_CONNECTION_SCRIPT.includes("nodeApi('/onenat/update'"))
  assert.ok(NODE_CONNECTION_SCRIPT.includes("nodeApi('/onenat/upgrade'"))
  assert.ok(NODE_CONNECTION_SCRIPT.includes('rememberPassword'))
  assert.equal(NODE_CONNECTION_SCRIPT.includes('requireToken()'), false)
})
