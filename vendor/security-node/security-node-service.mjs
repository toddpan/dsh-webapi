#!/usr/bin/env node
/**
 * Standalone TEST NODE, separate port/account/root; never replaces DSH.
 *
 * Build protocol (no existing build scripts need editing):
 *   node_modules/.bin/tsc src/node-security.ts --outDir /absolute/build --target ES2023 \
 *     --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types node
 *   node scripts/security-node-service.mjs --config /absolute/node.json --protocol /absolute/build/node-security.js
 *
 * Administrator-provisioned config (chmod 600, dedicated non-root service uid):
 * { "nodeId":"test-node-a", "privateKeyFile":"/home/node/identity.pem",
 *   "issuerKeys":{"platform-key-1":"-----BEGIN PUBLIC KEY-----\n..."},
 *   "workspaces":[{"workspaceId":"test-ws", "root":"/home/node/workspace", "policyVersion":1}],
 *   "runtimeRoot":"/home/node/runtime", "runtimeSha256":"<--runtime-digest result>",
 *   "stateDir":"/home/node/state", "host":"127.0.0.1", "port":17841 }
 * Runtime: secret-free minimal rootfs with /bin/sh, id, ls, awk, readlink,
 * touch, sleep, cp, chmod, plus empty /proc,/dev,/tmp,/workspace,/sys dirs. Static busybox
 * COPIES work; symlinks and hardlinks in the runtime are intentionally rejected.
 *   node scripts/security-node-service.mjs --runtime-digest /absolute/runtime
 * File/config/runtime/state ancestors must be root/service-owned and not group/
 * world writable (do not place under /tmp). Workspaces must be disjoint.
 * Ingress must use TLS or an authenticated encrypted tunnel; bind is loopback.
 * No admin HTTP/root-registration API, node master key, arbitrary host eval,
 * host network, host environment, live workspace execution mount, or DSH fallback.
 *
 * A capability is bound to instanceId obtained via pinned identity before issue.
 * Lease state is node-authoritative in memory, never reconstructed after restart.
 * Renewal must be newly issued after platform authoritative ACL checks. Offline
 * revocation is bounded by max 15s lease + ~50ms supervisor polling/scheduling;
 * already completed effects cannot be undone. Files have max 1MiB operations.
 * Execution copies a read-only scoped snapshot into disposable /tmp/project.
 * Build outputs never write the repository; deliberate edits use the signed CAS API.
 * Supervisor independently kills the bwrap PID namespace on expiry/EOF; a service
 * SIGKILL triggers supervisor PDEATHSIG(SIGTERM)/EOF; its subreaper kills the
 * bwrap namespace and reaps descendants, with --die-with-parent as another guard.
 */
import http from 'node:http'
import { createHash, createPrivateKey, createPublicKey, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promises as fs, constants as F } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const here = path.dirname(fileURLToPath(import.meta.url))
const helper = path.join(here, 'security-node-fs.py')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const requireThat = (condition, code) => { if (!condition) fail(code) }
const identifier = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(v)
const strictPayload = (p, keys) => requireThat(p && Object.getPrototypeOf(p) === Object.prototype
  && Object.keys(p).sort().join(',') === [...keys].sort().join(','), 'INVALID_PAYLOAD')

/** Explicit, administrator-configured text inference. It never creates a host agent session. */
export async function invokeTextAgent(runtime, input) {
  strictPayload(input, ['agentId', 'userId', 'credentialId', 'systemPrompt', 'message'])
  requireThat([input.agentId, input.userId, input.credentialId].every(identifier)
    && typeof input.systemPrompt === 'string' && Buffer.byteLength(input.systemPrompt) <= 128000
    && typeof input.message === 'string' && input.message.trim() && Buffer.byteLength(input.message) <= 64000, 'INVALID_AGENT_INVOCATION')
  requireThat(runtime && typeof runtime.model === 'string' && runtime.model.length > 0 && runtime.model.length <= 200
    && typeof runtime.apiKey === 'string' && runtime.apiKey.length <= 8192 && !/[\r\n]/.test(runtime.apiKey), 'AGENT_RUNTIME_UNAVAILABLE')
  let url
  try { url = new URL(runtime.baseUrl) } catch { fail('AGENT_RUNTIME_UNAVAILABLE') }
  requireThat(!url.username && !url.password && !url.search && !url.hash
    && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)), 'AGENT_RUNTIME_UNAVAILABLE')
  const response = await fetch(url.href.replace(/\/$/, '') + '/chat/completions', { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', ...(runtime.apiKey ? { authorization: 'Bearer ' + runtime.apiKey } : {}) },
    body: JSON.stringify({ model: runtime.model, messages: [{ role: 'system', content: input.systemPrompt }, { role: 'user', content: input.message }],
      stream: false, max_tokens: 4096, tools: [], tool_choice: 'none' }), signal: AbortSignal.timeout(30000) })
  requireThat(response.ok && response.body, 'AGENT_INFERENCE_FAILED')
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      requireThat(size <= 512000, 'AGENT_RESPONSE_TOO_LARGE')
      chunks.push(part.value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.choices?.[0]?.message
  requireThat(result && typeof result.content === 'string' && Buffer.byteLength(result.content) <= 256000
    && !result.function_call && (!result.tool_calls || Array.isArray(result.tool_calls) && result.tool_calls.length === 0), 'INVALID_AGENT_RESPONSE')
  return { content: result.content }
}

async function privatePath(target, directory = false) {
  requireThat(path.isAbsolute(target) && path.normalize(target) === target && target !== '/', 'INVALID_CONFIG_PATH')
  const parts = target.split('/').filter(Boolean)
  let current = '/'
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i])
    const st = await fs.lstat(current)
    requireThat(!st.isSymbolicLink() && [0, process.getuid()].includes(st.uid) && !(st.mode & 0o022), 'UNTRUSTED_CONFIG_PATH')
    if (i < parts.length - 1 || directory) requireThat(st.isDirectory(), 'DIRECTORY_REQUIRED')
    else requireThat(st.isFile() && st.nlink === 1, 'REGULAR_FILE_REQUIRED')
  }
}
async function readPrivate(file) {
  await privatePath(file)
  const handle = await fs.open(file, F.O_RDONLY | F.O_NOFOLLOW)
  try {
    const st = await handle.stat()
    requireThat(!(st.mode & 0o077) && st.size <= 1_000_000, 'PRIVATE_CONFIG_REQUIRED')
    return await handle.readFile('utf8')
  } finally { await handle.close() }
}
export async function runtimeDigest(root) {
  await privatePath(root, true)
  const hash = createHash('sha256')
  let count = 0
  async function walk(dir, prefix) {
    for (const name of (await fs.readdir(dir)).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name
      const full = path.join(dir, name)
      const st = await fs.lstat(full)
      requireThat(++count <= 2048 && !st.isSymbolicLink() && [0, process.getuid()].includes(st.uid)
        && !(st.mode & 0o022) && (st.isDirectory() || st.isFile() && st.nlink === 1), 'UNSAFE_RUNTIME')
      requireThat(!['etc', 'root', 'home', 'host', 'Users'].includes(rel.split('/')[0]), 'SENSITIVE_RUNTIME_PATH')
      hash.update(`${rel}\0${st.mode & 0o777}\0`)
      if (st.isDirectory()) await walk(full, rel)
      else {
        requireThat(st.size <= 32 * 1024 * 1024, 'RUNTIME_FILE_TOO_LARGE')
        hash.update(await fs.readFile(full))
      }
    }
  }
  await walk(root, '')
  for (const dir of ['proc', 'dev', 'tmp', 'workspace', 'sys']) {
    requireThat((await fs.lstat(path.join(root, dir))).isDirectory(), 'RUNTIME_MOUNTPOINT_MISSING')
    requireThat((await fs.readdir(path.join(root, dir))).length === 0, 'RUNTIME_MOUNTPOINT_NOT_EMPTY')
  }
  requireThat((await fs.lstat(path.join(root, 'bin/sh'))).isFile(), 'RUNTIME_SHELL_MISSING')
  return hash.digest('hex')
}

function python(args) {
  // Explicit minimal environment: neither platform credentials nor management keys
  // from the launching process are inherited by broker/supervisor/user command.
  return spawn('/usr/bin/python3', [helper, ...args], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
}
function createBroker() {
  const child = python(process.platform === 'darwin' ? ['--darwin-files'] : [])
  const pending = new Map()
  let dead = false
  let sequence = 0
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    try {
      const value = JSON.parse(line)
      const p = pending.get(value.id)
      if (p) { pending.delete(value.id); clearTimeout(p.timer); value.ok ? p.resolve(value.result) : p.reject(Object.assign(new Error(value.error), { code: value.error })) }
    } catch { child.kill('SIGKILL') }
  })
  const die = () => {
    dead = true
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error('BROKER_CLOSED'), { code: 'BROKER_CLOSED' })) }
    pending.clear()
  }
  child.on('error', die)
  child.on('exit', die)
  child.stderr.resume()
  child.stdin.on('error', die)
  const done = new Promise(resolve => child.once('close', resolve))
  return {
    child, done,
    get running() { return !dead && !child.killed },
    call(body) {
      requireThat(!dead && pending.size < 128, 'BROKER_UNAVAILABLE')
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); die() }, 20_000)
        pending.set(id, { resolve, reject, timer })
        child.stdin.write(JSON.stringify({ ...body, id }) + '\n', err => { if (err) die() })
      })
    },
  }
}
async function isolationProbe(config) {
  if (process.platform !== 'linux' || process.getuid?.() === 0) fail('LINUX_UNPRIVILEGED_REQUIRED')
  requireThat(typeof config.runtimeRoot === 'string' && typeof config.runtimeSha256 === 'string', 'RUNTIME_NOT_CONFIGURED')
  requireThat(await runtimeDigest(config.runtimeRoot) === config.runtimeSha256, 'RUNTIME_DIGEST_MISMATCH')
  const child = python(['--probe', config.runtimeRoot])
  let out = ''
  child.stdout.on('data', b => { out += b; if (out.length > 32_768) child.kill('SIGKILL') })
  child.stderr.resume()
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }).finally(() => clearTimeout(timer))
  requireThat(code === 0, 'ISOLATION_PROBE_FAILED')
  const result = JSON.parse(out)
  requireThat(result.digest && Array.isArray(result.checks), 'ISOLATION_PROBE_FAILED')
  return result
}

export async function startSecurityNode(config, protocol) {
  const P = protocol
  // 宿主显式开启 allowRoot 时放行 root：uid 归属校验失去隔离意义，路径范围防线
  // （pinned 目录 + O_NOFOLLOW + 祖先目录校验）保留；仅限 DSH 宿主本身即 root 的单用户机器。
  requireThat(['linux', 'darwin'].includes(process.platform)
    && (process.getuid?.() !== 0 || config.allowRoot === true), 'UNPRIVILEGED_UNIX_REQUIRED')
  requireThat(identifier(config.nodeId) && config.issuerKeys && typeof config.issuerKeys === 'object', 'INVALID_NODE_CONFIG')
  requireThat(['127.0.0.1', '::1'].includes(config.host ?? '127.0.0.1'), 'LOOPBACK_BIND_REQUIRED')
  requireThat(Number.isSafeInteger(config.port) && config.port >= 0 && config.port <= 65535, 'INVALID_PORT')
  requireThat(Array.isArray(config.workspaces) && config.workspaces.length > 0 && config.workspaces.length <= 64, 'INVALID_WORKSPACES')
  const signingKey = createPrivateKey(await readPrivate(config.privateKeyFile))
  const publicKey = createPublicKey(signingKey).export({ type: 'spki', format: 'pem' }).toString()
  const keyId = P.nodeKeyId(publicKey)
  const instanceId = randomUUID()
  const issuerKeys = new Map(Object.entries(config.issuerKeys).map(([id, key]) => {
    requireThat(identifier(id), 'INVALID_ISSUER_ID'); P.nodeKeyId(key); return [id, key]
  }))
  const workspaces = new Map()
  const rootPaths = []
  for (const ws of config.workspaces) {
    requireThat(identifier(ws.workspaceId) && !workspaces.has(ws.workspaceId) && Number.isSafeInteger(ws.policyVersion) && ws.policyVersion > 0, 'INVALID_WORKSPACE')
    await privatePath(ws.root, true)
    requireThat((await fs.stat(ws.root)).uid === process.getuid(), 'ROOT_OWNER_REQUIRED')
    requireThat(!rootPaths.some(r => r === ws.root || r.startsWith(ws.root + '/') || ws.root.startsWith(r + '/')), 'OVERLAPPING_ROOTS')
    rootPaths.push(ws.root)
    workspaces.set(ws.workspaceId, Object.freeze({ ...ws, nodeId: config.nodeId }))
  }
  await privatePath(config.stateDir, true)
  requireThat((await fs.stat(config.stateDir)).uid === process.getuid(), 'STATE_OWNER_REQUIRED')
  const stateFile = name => path.join(config.stateDir, name)
  const readState = async (name, fallback) => {
    try { return JSON.parse(await readPrivate(stateFile(name))) }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
  }
  const writeState = async (name, value) => {
    const tmp = stateFile(`${name}.${randomUUID()}.tmp`)
    await fs.writeFile(tmp, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    await fs.rename(tmp, stateFile(name))
  }
  const pairedIssuers = await readState('paired-issuers.json', {})
  for (const [id, row] of Object.entries(pairedIssuers)) {
    requireThat(identifier(id) && row && P.nodeKeyId(row.publicKey) === id, 'INVALID_PAIRED_ISSUER')
    issuerKeys.set(id, row.publicKey)
  }
  const privateRoots = [config.stateDir, config.runtimeRoot, config.privateKeyFile]
  for (const r of rootPaths) requireThat(!privateRoots.some(s => s && (s === r || s.startsWith(r + '/') || r.startsWith(s + '/'))), 'SENSITIVE_ROOT_OVERLAP')
  let probe
  let probeError
  try { probe = await isolationProbe(config) } catch (err) { probeError = err.code ?? 'ISOLATION_UNAVAILABLE' }
  requireThat(probe || config.allowFileOnly === true, probeError ?? 'ISOLATION_UNAVAILABLE')
  const baseWorkspaces = [...workspaces.values()]
  const dynamicWorkspaces = await readState('catalog-workspaces.json', [])
  requireThat(Array.isArray(dynamicWorkspaces) && dynamicWorkspaces.length <= 4096, 'INVALID_WORKSPACE_CATALOG')
  const within = (root, target) => { const rel = path.relative(root, target); return !rel || rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel) }
  const broker = createBroker()
  try {
    await broker.call({ op: 'init', workspaces: [...workspaces.values()] })
    for (const ws of dynamicWorkspaces) {
      const parent = baseWorkspaces.find(root => within(root.root, ws.root))
      requireThat(parent && identifier(ws.workspaceId) && ws.policyVersion === parent.policyVersion, 'INVALID_WORKSPACE_CATALOG')
      try {
        await broker.call({ op: 'register-child', parentWorkspaceId: parent.workspaceId, relative: path.relative(parent.root, ws.root) || '.', workspace: ws })
      } catch (error) {
        // 重放目录枚举被安全策略拒绝（符号链接/不受信条目等）：与 catalog/resolve 的降级一致，
        // 工作区登记保留；实际文件访问仍按各自工作区走严格校验。
        if (!/^(UNSAFE_FILE|UNTRUSTED_FILE|FILE_TOO_LARGE|DIRECTORY_TOO_LARGE)$/.test(String(error?.code ?? ''))) throw error
      }
      workspaces.set(ws.workspaceId, Object.freeze(ws))
    }
  } catch (err) { broker.child.kill(); await broker.done; throw err }
  let catalogQueue = Promise.resolve()
  const serializedCatalog = action => {
    const result = catalogQueue.then(action)
    catalogQueue = result.catch(() => {})
    return result
  }
  const isolation = {
    available: !!probe, profile: probe ? 'linux-bwrap-snapshot-v1' : 'unavailable',
    ...(probe ? { probe } : { reason: probeError }),
    workspace: 'scoped-read-only-snapshot', network: 'none',
    limits: { leaseMs: P.NODE_LEASE_MAX_MS, fileBytes: 1048576, outputBytes: 65536, processes: 64 },
  }
  const leases = new Map()
  const receipts = new Map()
  const executions = new Map()
  const binding = c => P.nodeHash({ nodeId: c.nodeId, nodeInstanceId: c.nodeInstanceId, workspaceId: c.workspaceId,
    userId: c.userId, credentialId: c.credentialId, credentialVersion: c.credentialVersion, taskId: c.taskId,
    projectId: c.projectId ?? null, groupId: c.groupId ?? null, policyVersion: c.policyVersion,
    paths: [...c.paths].sort(), holder: P.nodeKeyId(c.holderPublicKey) })
  const stopExecution = (execution, reason) => {
    if (execution.state === 'running') {
      execution.reason = reason
      execution.child.stdin.write(JSON.stringify({ stop: true }) + '\n', () => {})
    }
  }
  const expire = (lease, reason = 'LEASE_EXPIRED') => {
    lease.revoked = true
    for (const ex of executions.values()) if (ex.leaseId === lease.id) stopExecution(ex, reason)
  }
  const currentLease = c => {
    const lease = leases.get(c.leaseId)
    requireThat(c.expiresAt > Date.now(), 'CAPABILITY_EXPIRED')
    requireThat(lease && !lease.revoked && lease.binding === binding(c), 'LEASE_DENIED')
    if (Date.now() >= lease.expiresAt || performance.now() >= lease.deadline) { expire(lease); fail('LEASE_EXPIRED') }
    return lease
  }
  const ticker = setInterval(() => {
    for (const lease of leases.values()) if (!lease.revoked && (Date.now() >= lease.expiresAt || performance.now() >= lease.deadline)) expire(lease)
    for (const [id, receipt] of receipts) if (receipt.expiresAt <= Date.now()) receipts.delete(id)
  }, 25)
  const resultExecution = ex => ({ executionId: ex.id, state: ex.state, exitCode: ex.exitCode,
    stdout: ex.stdout, stderr: ex.stderr, ...(ex.reason ? { reason: ex.reason } : {}) })

  async function dispatch(req) {
    const c = req.capability.value
    const p = req.payload
    const endpoint = req.endpoint
    if (endpoint.startsWith('leases/')) {
      if (endpoint === 'leases/revoke') {
        strictPayload(p, [])
        const lease = leases.get(c.leaseId)
        requireThat(lease && lease.binding === binding(c), 'LEASE_DENIED')
        expire(lease, 'REVOKED')
        // A revoke acknowledgement is a barrier for previously admitted file operations.
        await Promise.allSettled([...(lease.pendingFiles ?? [])])
        await Promise.all([...executions.values()].filter(ex => ex.leaseId === lease.id).map(ex => ex.done))
        return { revoked: true }
      }
      strictPayload(p, ['ttlMs'])
      requireThat(Number.isSafeInteger(p.ttlMs) && p.ttlMs > 0 && p.ttlMs <= P.NODE_LEASE_MAX_MS, 'INVALID_LEASE_TTL')
      const expiresAt = Math.min(Date.now() + p.ttlMs, c.expiresAt)
      let lease
      if (endpoint === 'leases/open') {
        requireThat(!leases.has(c.leaseId) && leases.size < 10000, 'LEASE_EXISTS_OR_LIMIT')
        lease = { id: c.leaseId, binding: binding(c), revoked: false, pendingFiles: new Set() }
        leases.set(c.leaseId, lease)
      } else lease = currentLease(c)
      lease.expiresAt = expiresAt
      lease.deadline = performance.now() + Math.max(0, expiresAt - Date.now())
      for (const ex of executions.values()) if (ex.leaseId === lease.id && ex.state === 'running') {
        ex.child.stdin.write(JSON.stringify({ expiresAt }) + '\n', () => {})
      }
      return { leaseId: lease.id, expiresAt }
    }
    const lease = currentLease(c)
    if (endpoint.startsWith('files/')) {
      const op = endpoint.split('/')[1]
      strictPayload(p, op === 'write' ? ['path', 'contentBase64', 'expectedSha256'] : ['path'])
      P.nodeRelativePath(p.path)
      const operation = broker.call({ op, claims: c, payload: p, leaseExpiresAt: Math.min(lease.expiresAt, Date.now() + Math.max(0, lease.deadline - performance.now())) })
      lease.pendingFiles.add(operation)
      try {
        const result = await operation
        currentLease(c) // Withhold read results after a concurrent revoke; committed writes cannot be undone.
        return result
      } finally { lease.pendingFiles.delete(operation) }
    }
    if (endpoint === 'executions/start') {
      strictPayload(p, ['argv'])
      requireThat(isolation.available, 'ISOLATION_UNAVAILABLE')
      requireThat(c.actions.includes('file.read'), 'SNAPSHOT_READ_REQUIRED')
      requireThat(Array.isArray(p.argv) && p.argv.length > 0 && p.argv.length <= 64
        && p.argv.every(a => typeof a === 'string' && !a.includes('\0') && a.length <= 8192)
        && (/^\/bin\/[A-Za-z0-9_.-]+$/.test(p.argv[0]) || p.argv[0].startsWith('./')
          && P.nodeRelativePath(p.argv[0].slice(2))), 'INVALID_ARGV')
      requireThat([...executions.values()].filter(ex => ex.state === 'running').length < 4 && executions.size < 4096, 'EXECUTION_LIMIT')
      // Runtime immutability is a deployment contract, with digest checked on every start.
      requireThat(await runtimeDigest(config.runtimeRoot) === config.runtimeSha256, 'RUNTIME_DIGEST_MISMATCH')
      const snapshot = await fs.mkdtemp(path.join(config.stateDir, 'snapshot-'))
      let ex
      try {
        await broker.call({ op: 'snapshot', claims: c, payload: {}, leaseExpiresAt: lease.expiresAt, destination: snapshot })
        currentLease(c)
        const makeReadable = async dir => {
          await fs.chmod(dir, 0o755)
          for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) await makeReadable(full)
            else { const st = await fs.stat(full); await fs.chmod(full, st.mode & 0o111 ? 0o555 : 0o444) }
          }
        }
        await makeReadable(snapshot)
        // No asynchronous boundary may separate this final lease/quota check from process creation.
        currentLease(c)
        requireThat([...executions.values()].filter(ex => ex.state === 'running').length < 4 && executions.size < 4096, 'EXECUTION_LIMIT')
        const child = python(['--supervise'])
        const id = randomUUID()
        ex = { id, child, leaseId: lease.id, binding: binding(c), state: 'running', exitCode: null, stdout: '', stderr: '' }
        let output = ''
        child.stdout.on('data', b => { output += b; if (output.length > 300000) child.kill('SIGKILL') })
        child.stderr.resume()
        child.stdin.on('error', () => {})
        ex.done = new Promise(resolve => {
          let finished = false
          const ended = async () => {
            if (finished) return
            finished = true
            try {
              const report = JSON.parse(output)
              ex.exitCode = report.exitCode ?? null
              ex.stdout = report.stdout ?? ''
              ex.stderr = report.stderr ?? ''
              ex.reason = ex.reason ?? report.reason ?? undefined
            } catch { ex.reason = ex.reason ?? 'SUPERVISOR_FAILED' }
            ex.state = ex.reason ? 'stopped' : 'exited'
            await fs.rm(snapshot, { recursive: true, force: true }).catch(() => {})
            resolve()
          }
          child.once('error', ended)
          // exit can precede the final stdout bytes; close is the stdio completion barrier.
          child.once('close', ended)
        })
        executions.set(id, ex)
        child.stdin.write(JSON.stringify({ runtime: config.runtimeRoot, snapshot, argv: p.argv, expiresAt: lease.expiresAt }) + '\n')
        return { executionId: id }
      } catch (err) {
        if (!ex) await fs.rm(snapshot, { recursive: true, force: true })
        throw err
      }
    }
    strictPayload(p, ['executionId'])
    requireThat(identifier(p.executionId), 'INVALID_EXECUTION_ID')
    const ex = executions.get(p.executionId)
    requireThat(ex && ex.leaseId === lease.id && ex.binding === binding(c), 'EXECUTION_DENIED')
    if (endpoint === 'executions/stop') { stopExecution(ex, 'STOPPED'); await ex.done }
    return resultExecution(ex)
  }

  const endpointActions = { 'files/read': 'file.read', 'files/list': 'file.list', 'files/write': 'file.write',
    'leases/open': 'lease.open', 'leases/renew': 'lease.renew', 'leases/revoke': 'lease.revoke',
    'executions/start': 'execution.start', 'executions/status': 'execution.status', 'executions/stop': 'execution.stop' }
  const sign = (domain, value) => P.signNodeValue(domain, value, signingKey)
  const server = http.createServer(async (incoming, outgoing) => {
    const respond = (status, value) => { outgoing.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); outgoing.end(JSON.stringify(value)) }
    let request
    try {
      requireThat(incoming.method === 'POST' && incoming.headers['content-type'] === 'application/json'
        && !incoming.headers['content-encoding'], 'INVALID_HTTP_REQUEST')
      let size = 0
      const chunks = []
      for await (const chunk of incoming) { size += chunk.length; requireThat(size <= 1_500_000, 'REQUEST_TOO_LARGE'); chunks.push(chunk) }
      request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const endpoint = incoming.url?.replace(/^\/v1\//, '')
      if (endpoint === 'identity') {
        strictPayload(request, ['nonce'])
        requireThat(typeof request.nonce === 'string' && /^[a-f0-9]{64}$/.test(request.nonce), 'INVALID_NONCE')
        const now = Date.now()
        return respond(200, sign('identity', { protocol: P.NODE_SECURITY_PROTOCOL, nodeId: config.nodeId, keyId, publicKey,
          nonce: request.nonce, issuedAt: now, expiresAt: now + 10000, instanceId, isolation,
          workspaces: [...workspaces.values()].map(ws => ({ workspaceId: ws.workspaceId, policyVersion: ws.policyVersion })) }))
      }
      if (endpoint === 'pair' || endpoint === 'catalog/resolve' || endpoint === 'agents/invoke') {
        const value = request?.value
        requireThat(value && value.endpoint === endpoint && value.nodeId === config.nodeId && value.nodeInstanceId === instanceId
          && identifier(value.requestId) && /^[a-f0-9]{64}$/.test(value.nonce)
          && Number.isSafeInteger(value.issuedAt) && Number.isSafeInteger(value.expiresAt)
          && value.issuedAt <= Date.now() + 1000 && value.expiresAt > Date.now()
          && value.expiresAt - value.issuedAt <= 10000 && value.expiresAt > value.issuedAt
          && P.nodeKeyId(value.issuerPublicKey) === value.issuerKeyId, 'INVALID_CONTROL_REQUEST')
        P.verifyNodeValue('control', request, value.issuerPublicKey)
        if (endpoint === 'agents/invoke') {
          requireThat(issuerKeys.get(value.issuerKeyId) === value.issuerPublicKey, 'UNKNOWN_ISSUER')
          const requestHash = P.nodeHash(request), receiptId = 'invoke:' + value.issuerKeyId + ':' + value.requestId
          let receipt = receipts.get(receiptId)
          if (receipt) requireThat(receipt.hash === requestHash, 'OPERATION_REPLAY_MISMATCH')
          else {
            requireThat(receipts.size < 10000, 'RECEIPT_LIMIT')
            receipt = { hash: requestHash, expiresAt: Date.now() + 35000,
              promise: Promise.resolve().then(() => invokeTextAgent(config.agentInference, value.payload)) }
            receipts.set(receiptId, receipt)
          }
          const result = await receipt.promise, now = Date.now()
          return respond(200, sign('response', { protocol: P.NODE_SECURITY_PROTOCOL, nodeId: config.nodeId, instanceId,
            requestId: value.requestId, requestHash, issuedAt: now, expiresAt: now + 10000, ok: true, result }))
        }
        const result = await serializedCatalog(async () => {
          requireThat(value.expiresAt > Date.now(), 'STALE_CONTROL_REQUEST')
          if (endpoint === 'pair') {
            requireThat(config.dshRef && typeof config.dshRef === 'object', 'DSH_REFERENCE_REQUIRED')
            const input = value.payload
            requireThat(input && typeof input.secret === 'string' && /^[a-f0-9]{64}$/.test(input.secret)
              && identifier(input.userId), 'PAIRING_REQUIRED')
            const pending = await readState('pairing.json', null)
            const digest = createHash('sha256').update(input.secret).digest('hex')
            requireThat(pending && pending.expiresAt > Date.now() && typeof pending.digest === 'string'
              && pending.digest.length === digest.length && timingSafeEqual(Buffer.from(pending.digest), Buffer.from(digest)), 'PAIRING_INVALID_OR_EXPIRED')
            // Exclusive durable consumption precedes any new issuer or ownership. Restart/retry cannot reuse it.
            await fs.writeFile(stateFile(`pair-used-${digest}`), value.issuerKeyId, { flag: 'wx', mode: 0o600 })
            pairedIssuers[value.issuerKeyId] = { publicKey: value.issuerPublicKey, userId: input.userId }
            await writeState('paired-issuers.json', pairedIssuers)
            issuerKeys.set(value.issuerKeyId, value.issuerPublicKey)
            return { nodeId: config.nodeId, name: config.name || config.nodeId, dshRef: config.dshRef,
              roots: baseWorkspaces.map(ws => ws.root), isolation }
          }
          requireThat(issuerKeys.get(value.issuerKeyId) === value.issuerPublicKey, 'UNKNOWN_ISSUER')
          const target = value.payload?.path
          requireThat(typeof target === 'string' && path.isAbsolute(target) && path.normalize(target) === target
            && target !== '/' && !/[\\\x00-\x1f\x7f]/.test(target), 'INVALID_CATALOG_PATH')
          const parent = baseWorkspaces.filter(root => within(root.root, target)).sort((a, b) => b.root.length - a.root.length)[0]
          requireThat(parent, 'PATH_DENIED')
          const ws = { workspaceId: 'catalog-' + createHash('sha256').update(target).digest('hex').slice(0, 40),
            root: target, nodeId: config.nodeId, policyVersion: parent.policyVersion }
          let checked
          try {
            checked = await broker.call({ op: 'register-child', parentWorkspaceId: parent.workspaceId,
              relative: path.relative(parent.root, target) || '.', workspace: ws })
          } catch (error) {
            // 枚举被安全策略拒绝（符号链接/不受信条目等，真实开发目录常见）：注册解析不被目录内容
            // 阻塞，工作区仍按 base 范围登记；各工作区的实际文件访问继续走严格校验。
            if (!/^(UNSAFE_FILE|UNTRUSTED_FILE|FILE_TOO_LARGE|DIRECTORY_TOO_LARGE)$/.test(String(error?.code ?? ''))) throw error
            if (!workspaces.has(ws.workspaceId)) {
              requireThat(dynamicWorkspaces.length < 4096, 'WORKSPACE_LIMIT')
              dynamicWorkspaces.push(ws)
              await writeState('catalog-workspaces.json', dynamicWorkspaces)
              workspaces.set(ws.workspaceId, Object.freeze(ws))
            }
            return { path: target, entries: [], workspaceId: ws.workspaceId,
              policyVersion: ws.policyVersion, isolation }
          }
          if (!workspaces.has(ws.workspaceId)) {
            requireThat(dynamicWorkspaces.length < 4096, 'WORKSPACE_LIMIT')
            dynamicWorkspaces.push(ws)
            await writeState('catalog-workspaces.json', dynamicWorkspaces)
            workspaces.set(ws.workspaceId, Object.freeze(ws))
          }
          return { path: checked.path, entries: checked.entries.filter(e => e.type === 'directory').map(e => ({ name: e.name, path: path.join(target, e.name), isDirectory: true })),
            workspaceId: ws.workspaceId, policyVersion: ws.policyVersion, isolation }
        })
        const now = Date.now()
        return respond(200, sign('response', { protocol: P.NODE_SECURITY_PROTOCOL, nodeId: config.nodeId, instanceId,
          requestId: value.requestId, requestHash: P.nodeHash(request), issuedAt: now, expiresAt: now + 10000, ok: true, result }))
      }
      requireThat(Object.hasOwn(endpointActions, endpoint) && request.endpoint === endpoint
        && request.protocol === P.NODE_SECURITY_PROTOCOL && /^[a-f0-9]{64}$/.test(request.nonce), 'INVALID_ENDPOINT')
      strictPayload(request, ['protocol', 'requestId', 'nonce', 'endpoint', 'capability', 'payload', 'proof'])
      const c = request.capability?.value
      const issuer = issuerKeys.get(c?.issuerKeyId)
      requireThat(issuer, 'UNKNOWN_ISSUER')
      P.verifyNodeValue('capability', request.capability, issuer)
      P.validateNodeClaims(c)
      requireThat(c.nodeId === config.nodeId && c.nodeInstanceId === instanceId, 'NODE_IDENTITY_MISMATCH')
      const ws = workspaces.get(c.workspaceId)
      requireThat(ws && ws.policyVersion === c.policyVersion, 'WORKSPACE_POLICY_MISMATCH')
      requireThat(request.requestId === c.operationId && c.actions.includes(endpointActions[endpoint]), 'ACTION_DENIED')
      const { proof, ...unsigned } = request
      P.verifyNodeValue('request', { value: unsigned, signature: proof }, c.holderPublicKey)
      const requestHash = P.nodeHash(request)
      const receiptId = `${c.issuerKeyId}:${c.operationId}`
      const previous = receipts.get(receiptId)
      let promise
      if (previous) {
        requireThat(previous.hash === requestHash, 'OPERATION_REPLAY_MISMATCH')
        if (endpoint !== 'leases/open' && endpoint !== 'leases/revoke') currentLease(c)
        promise = previous.promise
      } else {
        requireThat(receipts.size < 10000, 'RECEIPT_LIMIT')
        // Install the promise before any await so simultaneous retries share one effect.
        promise = Promise.resolve().then(() => dispatch(request)).then(result => ({ ok: true, result }), err => ({ ok: false, error: { code: /^[A-Z_]+$/.test(err.code ?? '') ? err.code : 'NODE_REJECTED' } }))
        receipts.set(receiptId, { hash: requestHash, expiresAt: c.expiresAt, promise })
      }
      const outcome = await promise
      const now = Date.now()
      respond(200, sign('response', { protocol: P.NODE_SECURITY_PROTOCOL, nodeId: config.nodeId, instanceId,
        requestId: request.requestId, requestHash, issuedAt: now, expiresAt: now + 10000, ...outcome }))
    } catch (err) {
      // Even rejections are signed and bound when the request is canonical JSON.
      try {
        const now = Date.now()
        respond(403, sign('response', { protocol: P.NODE_SECURITY_PROTOCOL, nodeId: config.nodeId, instanceId,
          requestId: request?.value?.requestId ?? (typeof request?.requestId === 'string' ? request.requestId : ''), requestHash: P.nodeHash(request ?? null),
          issuedAt: now, expiresAt: now + 10000, ok: false,
          error: { code: /^[A-Z_]+$/.test(err.code ?? '') ? err.code : 'NODE_REJECTED' } }))
      } catch { outgoing.destroy() }
    }
  })
  server.requestTimeout = 10000
  server.headersTimeout = 5000
  server.maxConnections = 64
  server.on('clientError', (_err, socket) => socket.destroy())
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host ?? '127.0.0.1', resolve) }) }
  catch (err) { clearInterval(ticker); broker.child.kill(); await broker.done; throw err }
  broker.child.once('exit', () => {
    clearInterval(ticker)
    server.closeAllConnections()
    server.close()
  })
  let closing
  const close = () => closing ??= (async () => {
    clearInterval(ticker)
    for (const lease of leases.values()) expire(lease, 'SERVICE_STOPPED')
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await catalogQueue
    broker.child.stdin.end()
    await Promise.all([...executions.values()].map(ex => ex.done))
    await broker.done
  })()
  return { server, close, get running() { return server.listening && broker.running },
    identity: { nodeId: config.nodeId, keyId, publicKey, instanceId, isolation } }
}

const launchedEntry = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => undefined) : undefined
if (launchedEntry && launchedEntry === await fs.realpath(fileURLToPath(import.meta.url))) {
  try {
    const args = process.argv.slice(2)
    if (args[0] === '--runtime-digest' && args.length === 2) console.log(await runtimeDigest(path.resolve(args[1])))
    else {
      const get = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
      const configPath = get('--config')
      requireThat(configPath, 'USAGE_CONFIG_REQUIRED')
      const config = JSON.parse(await readPrivate(configPath))
      if (args.includes('--pairing-code')) {
        await privatePath(config.stateDir, true)
        requireThat(config.dshRef, 'DSH_REFERENCE_REQUIRED')
        const secret = randomBytes(32).toString('hex')
        const publicKey = createPublicKey(createPrivateKey(await readPrivate(config.privateKeyFile))).export({ type: 'spki', format: 'pem' }).toString()
        const expiresAt = Date.now() + 5 * 60 * 1000
        const temporary = path.join(config.stateDir, `pairing-${randomUUID()}.tmp`)
        await fs.writeFile(temporary, JSON.stringify({ digest: createHash('sha256').update(secret).digest('hex'), expiresAt }), { mode: 0o600, flag: 'wx' })
        await fs.rename(temporary, path.join(config.stateDir, 'pairing.json'))
        console.log('wbpair1.' + Buffer.from(JSON.stringify({ nodeId: config.nodeId, publicKey, secret, expiresAt })).toString('base64url'))
      } else {
      const protocolPath = path.resolve(get('--protocol') ?? path.join(here, '../dist/node-security.js'))
      const P = await import(pathToFileURL(protocolPath).href)
      const node = await startSecurityNode(config, P)
      console.log(JSON.stringify({ ready: true, address: node.server.address(), ...node.identity }))
      let closing = false
      const shutdown = () => { if (!closing) { closing = true; node.close().then(() => process.exit(0), () => process.exit(1)) } }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
      }
    }
  } catch (err) { console.error(JSON.stringify({ ready: false, code: err.code ?? err.message })); process.exitCode = 1 }
}
