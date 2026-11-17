/**
 * Isolated node protocol v1. No legacy DSH fallback and no management credentials.
 * Trust (nodeId + SPKI key + deployment profile) is provisioned out of band.
 * A route/ONENAT mapping is only a locator and can change without changing this pin.
 *
 * POST /v1/identity { nonce } -> Signed<NodeIdentity>
 * POST /v1/{files/read,files/list,files/write,leases/open,leases/renew,leases/revoke,
 *           executions/start,executions/status,executions/stop} -> Signed<NodeReply<T>>
 * All authenticated requests are NodeRequest, all responses bind the entire request.
 * Time values are Unix milliseconds. Paths are canonical relative POSIX paths;
 * '.' means the workspace root, never an absolute host path. Write CAS uses null
 * for create-only, or the exact SHA-256 returned by read for overwrite.
 *
 * Issuance/renewal belongs in the authoritative platform transaction after checking
 * the original user/credential/object/grants. This client never decides those ACLs.
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto'

export const NODE_SECURITY_PROTOCOL = 'workbuddy.node-security/1' as const
export const NODE_CAPABILITY_MAX_MS = 60_000
export const NODE_LEASE_MAX_MS = 15_000
/** Conservative issuer backdating; verification still rejects claims >1s in the future. */
export const NODE_CLOCK_SKEW_MS = 1_000
export type NodeAction = 'file.read' | 'file.list' | 'file.write' | 'lease.open' | 'lease.renew' | 'lease.revoke'
  | 'execution.start' | 'execution.status' | 'execution.stop'
export type NodeEndpoint = 'files/read' | 'files/list' | 'files/write' | 'leases/open' | 'leases/renew'
  | 'leases/revoke' | 'executions/start' | 'executions/status' | 'executions/stop'
export interface NodeScope {
  nodeId: string
  workspaceId: string
  userId: string
  credentialId: string
  credentialVersion: number
  taskId: string
  projectId?: string
  groupId?: string
  policyVersion: number
  paths: string[]
  actions: NodeAction[]
}
export interface NodeCapabilityClaims extends NodeScope {
  protocol: typeof NODE_SECURITY_PROTOCOL
  issuerKeyId: string
  nodeInstanceId: string
  holderPublicKey: string
  operationId: string
  leaseId: string
  issuedAt: number
  expiresAt: number
}
export interface NodeSigned<T> { value: T; signature: string }
export type NodeCapability = NodeSigned<NodeCapabilityClaims>
export interface NodeRequest {
  protocol: typeof NODE_SECURITY_PROTOCOL
  requestId: string
  nonce: string
  endpoint: NodeEndpoint
  capability: NodeCapability
  payload: Record<string, unknown>
  proof: string
}
export interface NodeIsolation {
  available: boolean
  profile: 'linux-bwrap-snapshot-v1' | 'unavailable'
  reason?: string
  probe?: { checkedAt: number; digest: string; checks: string[] }
  workspace: 'scoped-read-only-snapshot'
  network: 'none'
  limits: { leaseMs: number; fileBytes: number; outputBytes: number; processes: number }
}
export interface NodeIdentity {
  protocol: typeof NODE_SECURITY_PROTOCOL
  nodeId: string
  keyId: string
  publicKey: string
  nonce: string
  issuedAt: number
  expiresAt: number
  instanceId: string
  isolation: NodeIsolation
  workspaces: { workspaceId: string; policyVersion: number }[]
}
export interface NodeReply<T> {
  protocol: typeof NODE_SECURITY_PROTOCOL
  nodeId: string
  instanceId: string
  requestId: string
  requestHash: string
  issuedAt: number
  expiresAt: number
  ok: boolean
  result?: T
  error?: { code: string }
}
export interface NodeLease { leaseId: string; expiresAt: number }
export interface NodeFile { path: string; contentBase64: string; sha256: string; size: number }
export interface NodeFileEntry { name: string; type: 'file' | 'directory'; size: number }
export interface NodeExecution {
  executionId: string
  state: 'running' | 'exited' | 'stopped'
  exitCode: number | null
  stdout: string
  stderr: string
  reason?: string
}
export interface NodeSecurityPin { nodeId: string; publicKey: string }
export class NodeSecurityError extends Error {
  readonly status?: number
  constructor(public readonly code: string) {
    super(code); this.name = 'NodeSecurityError'
    if (code === 'CAS_MISMATCH') this.status = 409
  }
}

/** Restricted deterministic JSON, shared with the standalone service. */
export function nodeCanonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (Array.isArray(value)) return `[${value.map(nodeCanonical).join(',')}]`
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${nodeCanonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  throw new NodeSecurityError('NON_CANONICAL_JSON')
}
export function nodeHash(value: unknown): string { return createHash('sha256').update(nodeCanonical(value)).digest('hex') }
function message(domain: string, value: unknown): Buffer { return Buffer.from(`${NODE_SECURITY_PROTOCOL}:${domain}\n${nodeCanonical(value)}`) }
function publicKey(key: string | KeyObject): KeyObject {
  const result = typeof key === 'string' ? createPublicKey(key) : key
  if (result.type !== 'public' || result.asymmetricKeyType !== 'ed25519') throw new NodeSecurityError('ED25519_REQUIRED')
  return result
}
export function nodeKeyId(key: string | KeyObject): string {
  return createHash('sha256').update(publicKey(key).export({ format: 'der', type: 'spki' })).digest('hex')
}
export function signNodeValue<T>(domain: string, value: T, key: string | KeyObject): NodeSigned<T> {
  const signingKey = typeof key === 'string' ? createPrivateKey(key) : key
  if (signingKey.type !== 'private' || signingKey.asymmetricKeyType !== 'ed25519') throw new NodeSecurityError('ED25519_REQUIRED')
  return { value, signature: sign(null, message(domain, value), signingKey).toString('base64url') }
}
export function verifyNodeValue<T>(domain: string, signed: NodeSigned<T>, key: string | KeyObject): T {
  try {
    if (!signed || typeof signed.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signed.signature)
      || !verify(null, message(domain, signed.value), publicKey(key), Buffer.from(signed.signature, 'base64url'))) {
      throw new Error('signature')
    }
    return signed.value
  } catch { throw new NodeSecurityError('BAD_SIGNATURE') }
}
export function nodeRelativePath(path: string): string {
  if (path === '.') return path
  if (typeof path !== 'string' || path.length > 2048 || !path || path.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(path)
    || path.split('/').some(p => !p || p === '.' || p === '..' || Buffer.byteLength(p) > 255)) {
    throw new NodeSecurityError('INVALID_PATH')
  }
  return path
}
export function issueNodeCapability(claims: NodeCapabilityClaims, issuerPrivateKey: string | KeyObject): NodeCapability {
  validateNodeClaims(claims)
  return signNodeValue('capability', claims, issuerPrivateKey)
}
export function validateNodeClaims(c: NodeCapabilityClaims, now = Date.now()): void {
  const strings = [c?.nodeId, c?.workspaceId, c?.userId, c?.credentialId, c?.taskId, c?.issuerKeyId, c?.operationId, c?.leaseId, c?.nodeInstanceId]
  if (!c || c.protocol !== NODE_SECURITY_PROTOCOL || strings.some(v => typeof v !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(v))
    || !Number.isSafeInteger(c.policyVersion) || c.policyVersion < 1 || !Number.isSafeInteger(c.credentialVersion) || c.credentialVersion < 1
    || !Number.isSafeInteger(c.issuedAt) || !Number.isSafeInteger(c.expiresAt) || c.issuedAt > now + NODE_CLOCK_SKEW_MS
    || c.expiresAt <= now || c.expiresAt <= c.issuedAt || c.expiresAt - c.issuedAt > NODE_CAPABILITY_MAX_MS
    || !Array.isArray(c.paths) || !c.paths.length || c.paths.length > 64 || !Array.isArray(c.actions) || !c.actions.length
    || c.actions.some(a => !['file.read', 'file.write', 'file.list', 'lease.open', 'lease.renew', 'lease.revoke', 'execution.start', 'execution.status', 'execution.stop'].includes(a))
    || [c.projectId, c.groupId].some(v => v !== undefined && (typeof v !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(v)))) {
    throw new NodeSecurityError('INVALID_CAPABILITY')
  }
  c.paths.forEach(nodeRelativePath)
  publicKey(c.holderPublicKey)
}
export function makeNodeRequest(endpoint: NodeEndpoint, capability: NodeCapability, payload: Record<string, unknown>, holderKey: string | KeyObject): NodeRequest {
  const unsigned = { protocol: NODE_SECURITY_PROTOCOL, requestId: capability.value.operationId, nonce: randomBytes(32).toString('hex'), endpoint, capability, payload }
  return { ...unsigned, proof: signNodeValue('request', unsigned, holderKey).signature }
}

export interface NodeSecurityClientOptions {
  baseUrl: string
  pin: NodeSecurityPin
  /** Only for explicit loopback tests. Remote deployment needs HTTPS or an authenticated encrypted tunnel. */
  allowLoopbackHttp?: boolean
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  clock?: () => number
}
export class NodeSecurityClient {
  private readonly options: NodeSecurityClientOptions
  constructor(options: NodeSecurityClientOptions) {
    const url = new URL(options.baseUrl)
    if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)
      || (url.protocol !== 'https:' && !(options.allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
      throw new NodeSecurityError('SECURE_TRANSPORT_REQUIRED')
    }
    nodeKeyId(options.pin.publicKey)
    this.options = { ...options, baseUrl: url.origin, pin: { ...options.pin } }
  }
  private now(): number { return (this.options.clock ?? Date.now)() }
  private async post<T>(endpoint: string, body: unknown): Promise<T> {
    const response = await (this.options.fetch ?? globalThis.fetch)(`${this.options.baseUrl}/v1/${endpoint}`, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: nodeCanonical(body), signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    })
    // Bound even malicious/unpinned servers before parsing or verifying their response.
    if (!response.body) throw new NodeSecurityError('EMPTY_RESPONSE')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.length
        if (size > 2_000_000) throw new NodeSecurityError('RESPONSE_TOO_LARGE')
        chunks.push(part.value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
    } finally { await reader.cancel().catch(() => {}) }
  }
  private freshness(v: { issuedAt: number; expiresAt: number }): void {
    if (!Number.isSafeInteger(v.issuedAt) || !Number.isSafeInteger(v.expiresAt) || v.issuedAt > this.now() + NODE_CLOCK_SKEW_MS
      || v.expiresAt <= this.now() || v.expiresAt - v.issuedAt > 30_000 || v.expiresAt <= v.issuedAt) throw new NodeSecurityError('STALE_RESPONSE')
  }
  async identity(): Promise<NodeIdentity> {
    const nonce = randomBytes(32).toString('hex')
    const identity = verifyNodeValue('identity', await this.post<NodeSigned<NodeIdentity>>('identity', { nonce }), this.options.pin.publicKey)
    if (identity.protocol !== NODE_SECURITY_PROTOCOL || identity.nodeId !== this.options.pin.nodeId || identity.nonce !== nonce
      || identity.keyId !== nodeKeyId(this.options.pin.publicKey) || nodeKeyId(identity.publicKey) !== identity.keyId) throw new NodeSecurityError('NODE_IDENTITY_MISMATCH')
    this.freshness(identity)
    return identity
  }
  /** Node-local pairing or issuer-authenticated directory discovery; never executes host code. */
  async control<T>(endpoint: 'pair' | 'catalog/resolve' | 'agents/invoke', payload: Record<string, unknown>, issuerPrivateKey: string): Promise<T> {
    const identity = await this.identity()
    const issuerPublicKey = createPublicKey(issuerPrivateKey).export({ format: 'pem', type: 'spki' }).toString()
    const now = this.now()
    const value = { endpoint, payload, nodeId: identity.nodeId, nodeInstanceId: identity.instanceId,
      requestId: randomBytes(24).toString('hex'), nonce: randomBytes(32).toString('hex'),
      issuedAt: now, expiresAt: now + 10_000, issuerKeyId: nodeKeyId(issuerPublicKey), issuerPublicKey }
    const request = signNodeValue('control', value, issuerPrivateKey)
    const reply = verifyNodeValue('response', await this.post<NodeSigned<NodeReply<T>>>(endpoint, request), this.options.pin.publicKey)
    if (reply.nodeId !== identity.nodeId || reply.instanceId !== identity.instanceId || reply.requestId !== value.requestId
      || reply.requestHash !== nodeHash(request)) throw new NodeSecurityError('RESPONSE_BINDING_MISMATCH')
    this.freshness(reply)
    if (!reply.ok) throw new NodeSecurityError(reply.error?.code ?? 'NODE_REJECTED')
    if (reply.result === undefined) throw new NodeSecurityError('INVALID_RESPONSE')
    return reply.result
  }
  /** Retain the returned request to retry exactly after a lost response; never reuse its operationId for different content. */
  prepare(endpoint: NodeEndpoint, capability: NodeCapability, payload: Record<string, unknown>, holderKey: string | KeyObject): NodeRequest {
    validateNodeClaims(capability.value, this.now())
    if (capability.value.nodeId !== this.options.pin.nodeId) throw new NodeSecurityError('NODE_IDENTITY_MISMATCH')
    if (nodeKeyId(createPublicKey(holderKey)) !== nodeKeyId(capability.value.holderPublicKey)) throw new NodeSecurityError('HOLDER_MISMATCH')
    return makeNodeRequest(endpoint, capability, payload, holderKey)
  }
  async send<T>(request: NodeRequest): Promise<T> {
    // Challenge on every connection/operation, including retries and port drift. No capability is sent first.
    const identity = await this.identity()
    if (request.capability.value.nodeId !== identity.nodeId || request.capability.value.nodeInstanceId !== identity.instanceId) throw new NodeSecurityError('NODE_IDENTITY_MISMATCH')
    const reply = verifyNodeValue('response', await this.post<NodeSigned<NodeReply<T>>>(request.endpoint, request), this.options.pin.publicKey)
    if (reply.protocol !== NODE_SECURITY_PROTOCOL || reply.nodeId !== identity.nodeId || reply.instanceId !== identity.instanceId
      || reply.requestId !== request.requestId || reply.requestHash !== nodeHash(request)) throw new NodeSecurityError('RESPONSE_BINDING_MISMATCH')
    this.freshness(reply)
    if (!reply.ok) throw new NodeSecurityError(reply.error?.code ?? 'NODE_REJECTED')
    if (reply.result === undefined) throw new NodeSecurityError('INVALID_RESPONSE')
    return reply.result
  }
  call<T>(endpoint: NodeEndpoint, capability: NodeCapability, payload: Record<string, unknown>, holderKey: string | KeyObject): Promise<T> {
    return this.send<T>(this.prepare(endpoint, capability, payload, holderKey))
  }
  openLease(cap: NodeCapability, key: string | KeyObject, ttlMs = NODE_LEASE_MAX_MS): Promise<NodeLease> {
    return this.call('leases/open', cap, { ttlMs }, key)
  }
  renewLease(cap: NodeCapability, key: string | KeyObject, ttlMs = NODE_LEASE_MAX_MS): Promise<NodeLease> {
    return this.call('leases/renew', cap, { ttlMs }, key)
  }
  revokeLease(cap: NodeCapability, key: string | KeyObject): Promise<{ revoked: true }> {
    return this.call('leases/revoke', cap, {}, key)
  }
  read(cap: NodeCapability, key: string | KeyObject, path: string): Promise<NodeFile> {
    return this.call('files/read', cap, { path: nodeRelativePath(path) }, key)
  }
  list(cap: NodeCapability, key: string | KeyObject, path = '.'): Promise<{ entries: NodeFileEntry[] }> {
    return this.call('files/list', cap, { path: nodeRelativePath(path) }, key)
  }
  write(cap: NodeCapability, key: string | KeyObject, path: string, content: Uint8Array, expectedSha256: string | null): Promise<{ sha256: string; size: number }> {
    return this.call('files/write', cap, { path: nodeRelativePath(path), contentBase64: Buffer.from(content).toString('base64'), expectedSha256 }, key)
  }
  start(cap: NodeCapability, key: string | KeyObject, argv: string[]): Promise<{ executionId: string }> {
    return this.call('executions/start', cap, { argv }, key)
  }
  status(cap: NodeCapability, key: string | KeyObject, executionId: string): Promise<NodeExecution> {
    return this.call('executions/status', cap, { executionId }, key)
  }
  stop(cap: NodeCapability, key: string | KeyObject, executionId: string): Promise<NodeExecution> {
    return this.call('executions/stop', cap, { executionId }, key)
  }
}
