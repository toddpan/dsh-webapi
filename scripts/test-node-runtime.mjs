#!/usr/bin/env node
/** Compile an install-like package and exercise the real runtime over HTTP. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { execFile, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const supported = ['darwin', 'linux'].includes(process.platform) && process.getuid?.() !== 0
const temporary = await mkdtemp(path.join(homedir(), '.dsh-node-runtime-test-'))
await chmod(temporary, 0o700)
after(async () => {
  assert.equal(path.dirname(temporary), homedir())
  assert.ok(path.basename(temporary).startsWith('.dsh-node-runtime-test-'))
  await rm(temporary, { recursive: true, force: true })
})
const pkg = path.join(temporary, 'installed-package')
await mkdir(pkg)
await writeFile(path.join(pkg, 'package.json'), '{"type":"module"}')
const compile = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'),
  path.join(root, 'src/node-runtime.ts'), '--outDir', path.join(pkg, 'lib'),
  '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck', '--types', 'node'],
{ cwd: root, encoding: 'utf8' })
assert.equal(compile.status, 0, compile.stdout + compile.stderr)
await cp(path.join(root, 'vendor/security-node'), path.join(pkg, 'vendor/security-node'), { recursive: true })
const { NodeRuntime } = await import(pathToFileURL(path.join(pkg, 'lib/node-runtime.js')).href)
const { ApiKeyStore } = await import(pathToFileURL(path.join(pkg, 'lib/api-keys-store.js')).href)
const P = await import(pathToFileURL(path.join(pkg, 'vendor/security-node/node-security.js')).href)
// Optionally verify with the actual sibling client, freshly compiled, never required at runtime.
let Client = P.NodeSecurityClient
if (process.env.WORKBUDDY_SOURCE) {
  const source = path.resolve(process.env.WORKBUDDY_SOURCE, 'src/node-security.ts')
  const target = path.join(temporary, 'workbuddy-client')
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), source,
    '--outDir', target, '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck', '--types', 'node'],
  { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  await writeFile(path.join(target, 'package.json'), '{"type":"module"}')
  Client = (await import(pathToFileURL(path.join(target, 'node-security.js')).href)).NodeSecurityClient
}

const keyPair = () => {
  const pair = generateKeyPairSync('ed25519')
  return { privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
}
const decode = ticket => {
  assert.ok(ticket.pairingCode.startsWith('wbpair1.'))
  return JSON.parse(Buffer.from(ticket.pairingCode.slice(8), 'base64url'))
}
const isCode = code => error => error.code === code
const sha256 = value => createHash('sha256').update(value).digest('hex')
let sequence = 0
async function fixture(t, rootsInput) {
  const base = path.join(temporary, 'fixture-' + ++sequence)
  const workspace = path.join(base, 'workspace')
  await mkdir(path.join(workspace, 'project/subdir'), { recursive: true, mode: 0o700 })
  await writeFile(path.join(workspace, 'readme.txt'), 'safe input', { mode: 0o600 })
  await writeFile(path.join(workspace, 'project/source.txt'), 'source input', { mode: 0o600 })
  const keyStore = new ApiKeyStore('', path.join(base, 'home'))
  await keyStore.ensureReady()
  const managed = await keyStore.create({ name: 'WorkBuddy runtime test' })
  let roots = rootsInput ? rootsInput(workspace) : [workspace]
  let dshRef = { baseUrl: 'https://fixture.example/api/v1', apiKey: managed.plaintext }
  let gets = 0
  const options = { dir: path.join(keyStore.dir, 'node'), keyStore, getRoots: () => roots,
    getDshRef: async () => { gets++; return dshRef } }
  let runtime = new NodeRuntime(options)
  const runtimes = [runtime]
  const server = createServer((req, res) => {
    if (runtime.handle(req, res)) return
    res.writeHead(404); res.end('unhandled')
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = 'http://127.0.0.1:' + server.address().port
  t.after(async () => {
    await Promise.all(runtimes.map(value => value.close()))
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  const client = ticket => {
    const value = decode(ticket)
    return new Client({ baseUrl: url, pin: value, allowLoopbackHttp: true })
  }
  return { workspace, keyStore, managed, options, url, client, server,
    get runtime() { return runtime }, get gets() { return gets },
    setRoots(value) { roots = value }, setDshRef(value) { dshRef = value },
    async restart() { await runtime.close(); runtime = new NodeRuntime(options); runtimes.push(runtime); await runtime.prepare() },
  }
}

async function brokerPids() {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,command='], { maxBuffer: 1024 * 1024 })
  return stdout.split('\n').filter(line => line.includes(path.join(pkg, 'vendor/security-node/security-node-fs.py')))
    .map(line => Number(line.trim().split(/\s+/)[0]))
}

const smoke = (name, run) => test(name, { skip: supported ? false : 'requires non-root macOS/Linux' }, run)

smoke('installed package identity → pair → catalog/list preserves security boundaries', async t => {
  const f = await fixture(t)
  const before = await fetch(f.url + '/v1/identity', { method: 'POST' })
  assert.equal(before.status, 503)
  const unhandled = await fetch(f.url + '/api/v1/identity')
  assert.equal(unhandled.status, 404)
  await Promise.all([f.runtime.prepare(), f.runtime.prepare()])
  const status = f.runtime.status()
  assert.equal(status.running, true)
  assert.equal(status.name.length > 0, true)
  assert.deepEqual(status.roots, [f.workspace])
  assert.equal(status.isolation.available, false)
  assert.equal(status.isolation.profile, 'unavailable')
  const ticket = await f.runtime.createPairing()
  const secret = decode(ticket)
  assert.equal(secret.expiresAt, ticket.expiresAt)
  assert.ok(ticket.expiresAt > Date.now() + 299000 && ticket.expiresAt <= Date.now() + 300000)
  const client = f.client(ticket)
  const identity = await client.identity()
  assert.equal(identity.nodeId, ticket.nodeId)
  assert.equal(identity.publicKey, secret.publicKey)
  assert.equal(identity.instanceId, status.instanceId)
  const issuer = keyPair()
  const paired = await client.control('pair', { secret: secret.secret, userId: 'user-1' }, issuer.privateKey)
  assert.deepEqual(paired.dshRef, { kind: 'direct', apiBaseUrl: 'https://fixture.example/api/v1' })
  assert.deepEqual(paired.roots, [f.workspace])
  assert.ok(!JSON.stringify(paired).includes(f.managed.plaintext))
  assert.ok(!JSON.stringify(f.runtime.status()).includes(secret.secret))
  assert.ok(!JSON.stringify(f.runtime.status()).includes(f.managed.plaintext))
  const pending = JSON.parse(await readFile(path.join(f.options.dir, 'state/pairing.json'), 'utf8'))
  assert.deepEqual(Object.keys(pending).sort(), ['digest', 'expiresAt'])
  assert.equal(pending.digest, sha256(secret.secret))
  for (const relative of ['identity.pem', 'node.json', 'state/pairing.json', 'state/paired-issuers.json']) {
    assert.equal((await lstat(path.join(f.options.dir, relative))).mode & 0o777, 0o600)
  }
  const resolved = await client.control('catalog/resolve', { path: path.join(f.workspace, 'project') }, issuer.privateKey)
  assert.equal(resolved.path, path.join(f.workspace, 'project'))
  assert.deepEqual(resolved.entries, [{ name: 'subdir', path: path.join(f.workspace, 'project/subdir'), isDirectory: true }])
  const holder = keyPair(), leaseId = randomUUID()
  const scope = { protocol: P.NODE_SECURITY_PROTOCOL, issuerKeyId: P.nodeKeyId(issuer.publicKey), nodeId: identity.nodeId,
    nodeInstanceId: identity.instanceId, workspaceId: resolved.workspaceId, policyVersion: resolved.policyVersion,
    userId: 'user-1', credentialId: 'cred-1', credentialVersion: 1, taskId: 'task-1', holderPublicKey: holder.publicKey,
    leaseId, paths: ['.'], actions: ['file.list', 'file.read', 'file.write', 'lease.open', 'lease.revoke', 'execution.start'] }
  const capability = () => P.issueNodeCapability({ ...scope, operationId: randomUUID(), issuedAt: Date.now(), expiresAt: Date.now() + 15000 }, issuer.privateKey)
  await client.openLease(capability(), holder.privateKey)
  const listed = await client.list(capability(), holder.privateKey)
  assert.ok(listed.entries.some(entry => entry.name === 'source.txt'))
  const read = await client.read(capability(), holder.privateKey, 'source.txt')
  assert.equal(Buffer.from(read.contentBase64, 'base64').toString(), 'source input')
  await client.write(capability(), holder.privateKey, 'created.txt', Buffer.from('new input'), null)
  await assert.rejects(client.write(capability(), holder.privateKey, 'created.txt', Buffer.from('overwrite'), null), isCode('CAS_MISMATCH'))
  await assert.rejects(client.start(capability(), holder.privateKey, ['/bin/sh', '-c', 'id']), isCode('ISOLATION_UNAVAILABLE'))
  await assert.rejects(client.control('agents/invoke', { agentId: 'agent-1', userId: 'user-1', credentialId: 'cred-1',
    systemPrompt: 'text only', message: 'test' }, issuer.privateKey), isCode('AGENT_RUNTIME_UNAVAILABLE'))
  await assert.rejects(client.control('catalog/resolve', { path: path.dirname(f.workspace) }, issuer.privateKey), isCode('PATH_DENIED'))
  await assert.rejects(client.control('catalog/resolve', { path: f.options.dir }, issuer.privateKey), isCode('PATH_DENIED'))
  await symlink(f.options.dir, path.join(f.workspace, 'outside-link'))
  await assert.rejects(client.control('catalog/resolve', { path: path.join(f.workspace, 'outside-link') }, issuer.privateKey))
  await rm(path.join(f.workspace, 'outside-link'))
  await client.revokeLease(capability(), holder.privateKey)
  await assert.rejects(client.list(capability(), holder.privateKey), isCode('LEASE_DENIED'))
  assert.equal((await brokerPids()).length, 1)
  await f.runtime.close()
  assert.equal(f.runtime.status().running, false)
  assert.equal((await brokerPids()).length, 0)
  assert.equal((await fetch(f.url + '/v1/identity', { method: 'POST' })).status, 503)
  await assert.rejects(f.runtime.prepare(), isCode('NODE_RUNTIME_CLOSED'))
})

smoke('pairing regeneration, expiry, durable replay protection and restart', async t => {
  const f = await fixture(t)
  const first = await f.runtime.createPairing(), oldSecret = decode(first)
  const second = await f.runtime.createPairing(), active = decode(second)
  const issuer = keyPair(), client = f.client(second)
  await assert.rejects(client.control('pair', { secret: oldSecret.secret, userId: 'user-2' }, issuer.privateKey), isCode('PAIRING_INVALID_OR_EXPIRED'))
  f.setDshRef({ baseUrl: 'https://new-fixture.example/api/v1/', apiKey: f.managed.plaintext })
  const third = await f.runtime.createPairing(), thirdSecret = decode(third)
  assert.equal(f.gets, 3)
  await assert.rejects(client.control('pair', { secret: active.secret, userId: 'user-2' }, issuer.privateKey), isCode('PAIRING_INVALID_OR_EXPIRED'))
  const pair = await client.control('pair', { secret: thirdSecret.secret, userId: 'user-2' }, issuer.privateKey)
  assert.deepEqual(pair.dshRef, { kind: 'direct', apiBaseUrl: 'https://new-fixture.example/api/v1' })
  await assert.rejects(client.control('pair', { secret: thirdSecret.secret, userId: 'user-2' }, issuer.privateKey))
  const before = await client.identity()
  await client.control('catalog/resolve', { path: path.join(f.workspace, 'project') }, issuer.privateKey)
  const identityFileBefore = await readFile(path.join(f.options.dir, 'identity.pem'), 'utf8')
  await f.restart()
  const afterIdentity = await client.identity()
  assert.equal(afterIdentity.nodeId, before.nodeId)
  assert.equal(afterIdentity.keyId, before.keyId)
  assert.equal(afterIdentity.publicKey, before.publicKey)
  assert.notEqual(afterIdentity.instanceId, before.instanceId)
  assert.equal(await readFile(path.join(f.options.dir, 'identity.pem'), 'utf8'), identityFileBefore)
  assert.equal((await client.control('catalog/resolve', { path: f.workspace }, issuer.privateKey)).path, f.workspace)
  const latest = await f.runtime.createPairing(), latestSecret = decode(latest)
  // Restoring an already consumed digest simulates replay after restart without relying on clock delays.
  await writeFile(path.join(f.options.dir, 'state/pairing.json'), JSON.stringify({ digest: sha256(thirdSecret.secret), expiresAt: Date.now() + 300000 }), { mode: 0o600 })
  await assert.rejects(client.control('pair', { secret: thirdSecret.secret, userId: 'user-2' }, issuer.privateKey))
  await writeFile(path.join(f.options.dir, 'state/pairing.json'), JSON.stringify({ digest: sha256(latestSecret.secret), expiresAt: Date.now() - 1 }), { mode: 0o600 })
  await assert.rejects(client.control('pair', { secret: latestSecret.secret, userId: 'user-2' }, issuer.privateKey), isCode('PAIRING_INVALID_OR_EXPIRED'))
  // Old instance requests must fail even when signed by a previously paired issuer.
  const now = Date.now()
  const stale = P.signNodeValue('control', { endpoint: 'catalog/resolve', payload: { path: f.workspace },
    nodeId: before.nodeId, nodeInstanceId: before.instanceId, requestId: randomUUID(), nonce: randomBytes(32).toString('hex'),
    issuedAt: now, expiresAt: now + 10000, issuerKeyId: P.nodeKeyId(issuer.publicKey), issuerPublicKey: issuer.publicKey }, issuer.privateKey)
  const response = await fetch(f.url + '/v1/catalog/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(stale) })
  const denied = P.verifyNodeValue('response', await response.json(), latestSecret.publicKey)
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'INVALID_CONTROL_REQUEST')
})

smoke('directory changes narrow roots, invalidate old instances and retain identity', async t => {
  const f = await fixture(t, workspace => ['/', workspace, path.join(workspace, 'project'), workspace])
  await f.runtime.prepare()
  assert.deepEqual(f.runtime.status().roots, [path.join(f.workspace, 'project')])
  const ticket = await f.runtime.createPairing(), client = f.client(ticket), issuer = keyPair()
  await client.control('pair', { secret: decode(ticket).secret, userId: 'user-3' }, issuer.privateKey)
  const identity = await client.identity()
  await client.control('catalog/resolve', { path: path.join(f.workspace, 'project') }, issuer.privateKey)
  f.setRoots([path.join(f.workspace, 'project/subdir')])
  const newTicket = await f.runtime.createPairing()
  const afterIdentity = await client.identity()
  assert.equal(afterIdentity.nodeId, identity.nodeId)
  assert.notEqual(afterIdentity.instanceId, identity.instanceId)
  await assert.rejects(client.control('catalog/resolve', { path: path.join(f.workspace, 'project') }, issuer.privateKey), isCode('PATH_DENIED'))
  assert.equal((await client.control('catalog/resolve', { path: path.join(f.workspace, 'project/subdir') }, issuer.privateKey)).path,
    path.join(f.workspace, 'project/subdir'))
  assert.ok(!JSON.stringify(f.runtime.status()).includes(decode(newTicket).secret))
  f.setRoots([])
  await assert.rejects(f.runtime.prepare(), isCode('NO_WORKSPACE_ROOTS'))
  assert.equal(f.runtime.status().running, false)
  assert.equal(f.runtime.status().errorCode, 'NO_WORKSPACE_ROOTS')
})

smoke('public DSH URL and managed key checks fail closed without exposing secrets', async t => {
  const f = await fixture(t)
  for (const baseUrl of ['http://127.0.0.1:3080/api/v1', 'http://localhost/api/v1', 'https://host.example/api/v1?apiKey=x']) {
    f.setDshRef({ baseUrl, apiKey: f.managed.plaintext })
    await assert.rejects(f.runtime.createPairing(), isCode('DSH_PUBLIC_URL_REQUIRED'))
  }
  f.setDshRef({ baseUrl: 'https://fixture.example/api/v1', apiKey: 'missing-secret' })
  await assert.rejects(f.runtime.createPairing(), isCode('DSH_MANAGED_KEY_REQUIRED'))
  const custom = await f.keyStore.create({ name: 'custom', plaintext: 'custom-token-for-testing-only' })
  f.setDshRef({ baseUrl: 'https://fixture.example/api/v1', apiKey: custom.plaintext })
  await assert.rejects(f.runtime.createPairing(), isCode('DSH_MANAGED_KEY_REQUIRED'))
  const expiring = await f.keyStore.create({ name: 'expiring', expiresInDays: 1 })
  f.setDshRef({ baseUrl: 'https://fixture.example/api/v1', apiKey: expiring.plaintext })
  await assert.rejects(f.runtime.createPairing(), isCode('DSH_MANAGED_KEY_REQUIRED'))
  f.setDshRef({ baseUrl: 'https://fixture.example/api/v1', apiKey: f.managed.plaintext })
  await f.runtime.createPairing()
  await f.keyStore.revoke(f.managed.view.id)
  await assert.rejects(f.runtime.createPairing(), isCode('DSH_MANAGED_KEY_REQUIRED'))
  const files = await readdir(f.options.dir)
  assert.ok(!files.some(name => name.endsWith('.tmp')))
  assert.ok(!JSON.stringify(f.runtime.status()).includes(custom.plaintext))
})

smoke('symlink, writable and sensitive roots are rejected with the original ancestor policy', async t => {
  const f = await fixture(t)
  const linkPath = path.join(path.dirname(f.workspace), 'workspace-link')
  await symlink(f.workspace, linkPath)
  f.setRoots([linkPath])
  await assert.rejects(f.runtime.prepare(), isCode('UNTRUSTED_CONFIG_PATH'))
  f.setRoots([f.workspace])
  await chmod(f.workspace, 0o777)
  await assert.rejects(f.runtime.prepare(), isCode('UNTRUSTED_CONFIG_PATH'))
  await chmod(f.workspace, 0o700)
  f.setRoots([f.options.dir])
  await assert.rejects(f.runtime.prepare(), isCode('SENSITIVE_ROOT_OVERLAP'))
  f.setRoots([f.keyStore.dir])
  await assert.rejects(f.runtime.prepare(), isCode('SENSITIVE_ROOT_OVERLAP'))
  f.setRoots([f.workspace])
  await f.runtime.prepare()
  const ticket = await f.runtime.createPairing()
  await f.runtime.close()
  await writeFile(path.join(f.options.dir, 'node.json'), '{"version":1,"nodeId":"changed"}', { mode: 0o600 })
  const corrupt = new NodeRuntime(f.options)
  t.after(() => corrupt.close())
  await assert.rejects(corrupt.prepare(), isCode('NODE_IDENTITY_INVALID'))
  assert.equal(corrupt.status().running, false)
  assert.ok(!JSON.stringify(corrupt.status()).includes(decode(ticket).secret))
})

smoke('pause resumes without rotating identity and prepare restores an unused ticket locator', async t => {
  const f = await fixture(t)
  const ticket = await f.runtime.createPairing(), secret = decode(ticket)
  const client = f.client(ticket), before = await client.identity()
  const pendingBefore = await readFile(path.join(f.options.dir, 'state/pairing.json'), 'utf8')
  await f.runtime.pause()
  assert.equal(f.runtime.status().running, false)
  assert.equal((await brokerPids()).length, 0)
  f.setDshRef({ baseUrl: 'https://restored.example/api/v1', apiKey: f.managed.plaintext })
  await f.runtime.prepare()
  const afterIdentity = await client.identity()
  assert.equal(afterIdentity.nodeId, before.nodeId)
  assert.equal(afterIdentity.publicKey, before.publicKey)
  assert.notEqual(afterIdentity.instanceId, before.instanceId)
  assert.equal(await readFile(path.join(f.options.dir, 'state/pairing.json'), 'utf8'), pendingBefore)
  const issuer = keyPair()
  const pair = await client.control('pair', { secret: secret.secret, userId: 'user-4' }, issuer.privateKey)
  assert.deepEqual(pair.dshRef, { kind: 'direct', apiBaseUrl: 'https://restored.example/api/v1' })
  assert.equal((await client.control('catalog/resolve', { path: f.workspace }, issuer.privateKey)).path, f.workspace)
  await f.restart()
  assert.equal((await client.control('catalog/resolve', { path: f.workspace }, issuer.privateKey)).path, f.workspace)
})

test('preflight reports explicit unavailable errors for simulated Windows, root and missing Python', async () => {
  for (const [name, setup, code, optionsJs = ''] of [
    ['windows', "Object.defineProperty(process, 'platform', { value: 'win32' });", 'NODE_PLATFORM_UNSUPPORTED'],
    ['root', "Object.defineProperty(process, 'platform', { value: 'linux' }); process.getuid = () => 0;", 'UNPRIVILEGED_UNIX_REQUIRED'],
    ['python', "Object.defineProperty(process, 'platform', { value: 'darwin' }); process.getuid = () => 501; child.execFile = (...args) => { queueMicrotask(() => args.at(-1)(Object.assign(new Error('missing'), {code:'ENOENT'}))); }; syncBuiltinESMExports();", 'PYTHON_UNAVAILABLE'],
    // allowRoot 放过 root 门（root 模拟用户）后应到达下一个门（Python 探测）
    ['root-allowRoot-python', "Object.defineProperty(process, 'platform', { value: 'linux' }); process.getuid = () => 0; child.execFile = (...args) => { queueMicrotask(() => args.at(-1)(Object.assign(new Error('missing'), {code:'ENOENT'}))); }; syncBuiltinESMExports();", 'PYTHON_UNAVAILABLE', 'allowRoot: true'],
  ]) {
    const dir = path.join(temporary, 'preflight-' + name)
    const source = "import child from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import assert from 'node:assert/strict'; "
      + setup + " const {NodeRuntime} = await import(" + JSON.stringify(pathToFileURL(path.join(pkg, 'lib/node-runtime.js')).href) + ");"
      + " const runtime = new NodeRuntime({dir:" + JSON.stringify(dir) + ",keyStore:{},getRoots:()=>[],getDshRef:async()=>null" + (optionsJs ? ', ' + optionsJs : '') + "});"
      + " await assert.rejects(runtime.prepare(),error=>error.code===" + JSON.stringify(code) + "); assert.equal(runtime.status().running,false); await runtime.close();"
    await execFileAsync(process.execPath, ['--input-type=module', '-e', source], { timeout: 5000, maxBuffer: 4096 })
    await assert.rejects(lstat(dir), error => error.code === 'ENOENT')
  }
})

test('unsupported platforms report unavailability before creating identity', { skip: supported }, async () => {
  const keyStore = new ApiKeyStore('', path.join(temporary, 'unsupported-home'))
  const runtime = new NodeRuntime({ dir: path.join(temporary, 'unsupported-node'), keyStore, getRoots: () => [], getDshRef: async () => null })
  await assert.rejects(runtime.prepare(), isCode(process.platform === 'win32' ? 'NODE_PLATFORM_UNSUPPORTED' : 'UNPRIVILEGED_UNIX_REQUIRED'))
  assert.equal(runtime.status().running, false)
  await runtime.close()
})
