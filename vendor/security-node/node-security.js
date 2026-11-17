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
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
export const NODE_SECURITY_PROTOCOL = 'workbuddy.node-security/1';
export const NODE_CAPABILITY_MAX_MS = 60_000;
export const NODE_LEASE_MAX_MS = 15_000;
/** Conservative issuer backdating; verification still rejects claims >1s in the future. */
export const NODE_CLOCK_SKEW_MS = 1_000;
export class NodeSecurityError extends Error {
    code;
    status;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'NodeSecurityError';
        if (code === 'CAS_MISMATCH')
            this.status = 409;
    }
}
/** Restricted deterministic JSON, shared with the standalone service. */
export function nodeCanonical(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return JSON.stringify(value);
    if (typeof value === 'number' && Number.isSafeInteger(value))
        return String(value);
    if (Array.isArray(value))
        return `[${value.map(nodeCanonical).join(',')}]`;
    if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${nodeCanonical(value[k])}`).join(',')}}`;
    }
    throw new NodeSecurityError('NON_CANONICAL_JSON');
}
export function nodeHash(value) { return createHash('sha256').update(nodeCanonical(value)).digest('hex'); }
function message(domain, value) { return Buffer.from(`${NODE_SECURITY_PROTOCOL}:${domain}\n${nodeCanonical(value)}`); }
function publicKey(key) {
    const result = typeof key === 'string' ? createPublicKey(key) : key;
    if (result.type !== 'public' || result.asymmetricKeyType !== 'ed25519')
        throw new NodeSecurityError('ED25519_REQUIRED');
    return result;
}
export function nodeKeyId(key) {
    return createHash('sha256').update(publicKey(key).export({ format: 'der', type: 'spki' })).digest('hex');
}
export function signNodeValue(domain, value, key) {
    const signingKey = typeof key === 'string' ? createPrivateKey(key) : key;
    if (signingKey.type !== 'private' || signingKey.asymmetricKeyType !== 'ed25519')
        throw new NodeSecurityError('ED25519_REQUIRED');
    return { value, signature: sign(null, message(domain, value), signingKey).toString('base64url') };
}
export function verifyNodeValue(domain, signed, key) {
    try {
        if (!signed || typeof signed.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signed.signature)
            || !verify(null, message(domain, signed.value), publicKey(key), Buffer.from(signed.signature, 'base64url'))) {
            throw new Error('signature');
        }
        return signed.value;
    }
    catch {
        throw new NodeSecurityError('BAD_SIGNATURE');
    }
}
export function nodeRelativePath(path) {
    if (path === '.')
        return path;
    if (typeof path !== 'string' || path.length > 2048 || !path || path.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(path)
        || path.split('/').some(p => !p || p === '.' || p === '..' || Buffer.byteLength(p) > 255)) {
        throw new NodeSecurityError('INVALID_PATH');
    }
    return path;
}
export function issueNodeCapability(claims, issuerPrivateKey) {
    validateNodeClaims(claims);
    return signNodeValue('capability', claims, issuerPrivateKey);
}
export function validateNodeClaims(c, now = Date.now()) {
    const strings = [c?.nodeId, c?.workspaceId, c?.userId, c?.credentialId, c?.taskId, c?.issuerKeyId, c?.operationId, c?.leaseId, c?.nodeInstanceId];
    if (!c || c.protocol !== NODE_SECURITY_PROTOCOL || strings.some(v => typeof v !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(v))
        || !Number.isSafeInteger(c.policyVersion) || c.policyVersion < 1 || !Number.isSafeInteger(c.credentialVersion) || c.credentialVersion < 1
        || !Number.isSafeInteger(c.issuedAt) || !Number.isSafeInteger(c.expiresAt) || c.issuedAt > now + NODE_CLOCK_SKEW_MS
        || c.expiresAt <= now || c.expiresAt <= c.issuedAt || c.expiresAt - c.issuedAt > NODE_CAPABILITY_MAX_MS
        || !Array.isArray(c.paths) || !c.paths.length || c.paths.length > 64 || !Array.isArray(c.actions) || !c.actions.length
        || c.actions.some(a => !['file.read', 'file.write', 'file.list', 'lease.open', 'lease.renew', 'lease.revoke', 'execution.start', 'execution.status', 'execution.stop'].includes(a))
        || [c.projectId, c.groupId].some(v => v !== undefined && (typeof v !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(v)))) {
        throw new NodeSecurityError('INVALID_CAPABILITY');
    }
    c.paths.forEach(nodeRelativePath);
    publicKey(c.holderPublicKey);
}
export function makeNodeRequest(endpoint, capability, payload, holderKey) {
    const unsigned = { protocol: NODE_SECURITY_PROTOCOL, requestId: capability.value.operationId, nonce: randomBytes(32).toString('hex'), endpoint, capability, payload };
    return { ...unsigned, proof: signNodeValue('request', unsigned, holderKey).signature };
}
export class NodeSecurityClient {
    options;
    constructor(options) {
        const url = new URL(options.baseUrl);
        if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)
            || (url.protocol !== 'https:' && !(options.allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
            throw new NodeSecurityError('SECURE_TRANSPORT_REQUIRED');
        }
        nodeKeyId(options.pin.publicKey);
        this.options = { ...options, baseUrl: url.origin, pin: { ...options.pin } };
    }
    now() { return (this.options.clock ?? Date.now)(); }
    async post(endpoint, body) {
        const response = await (this.options.fetch ?? globalThis.fetch)(`${this.options.baseUrl}/v1/${endpoint}`, {
            method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
            body: nodeCanonical(body), signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
        });
        // Bound even malicious/unpinned servers before parsing or verifying their response.
        if (!response.body)
            throw new NodeSecurityError('EMPTY_RESPONSE');
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
            for (;;) {
                const part = await reader.read();
                if (part.done)
                    break;
                size += part.value.length;
                if (size > 2_000_000)
                    throw new NodeSecurityError('RESPONSE_TOO_LARGE');
                chunks.push(part.value);
            }
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        finally {
            await reader.cancel().catch(() => { });
        }
    }
    freshness(v) {
        if (!Number.isSafeInteger(v.issuedAt) || !Number.isSafeInteger(v.expiresAt) || v.issuedAt > this.now() + NODE_CLOCK_SKEW_MS
            || v.expiresAt <= this.now() || v.expiresAt - v.issuedAt > 30_000 || v.expiresAt <= v.issuedAt)
            throw new NodeSecurityError('STALE_RESPONSE');
    }
    async identity() {
        const nonce = randomBytes(32).toString('hex');
        const identity = verifyNodeValue('identity', await this.post('identity', { nonce }), this.options.pin.publicKey);
        if (identity.protocol !== NODE_SECURITY_PROTOCOL || identity.nodeId !== this.options.pin.nodeId || identity.nonce !== nonce
            || identity.keyId !== nodeKeyId(this.options.pin.publicKey) || nodeKeyId(identity.publicKey) !== identity.keyId)
            throw new NodeSecurityError('NODE_IDENTITY_MISMATCH');
        this.freshness(identity);
        return identity;
    }
    /** Node-local pairing or issuer-authenticated directory discovery; never executes host code. */
    async control(endpoint, payload, issuerPrivateKey) {
        const identity = await this.identity();
        const issuerPublicKey = createPublicKey(issuerPrivateKey).export({ format: 'pem', type: 'spki' }).toString();
        const now = this.now();
        const value = { endpoint, payload, nodeId: identity.nodeId, nodeInstanceId: identity.instanceId,
            requestId: randomBytes(24).toString('hex'), nonce: randomBytes(32).toString('hex'),
            issuedAt: now, expiresAt: now + 10_000, issuerKeyId: nodeKeyId(issuerPublicKey), issuerPublicKey };
        const request = signNodeValue('control', value, issuerPrivateKey);
        const reply = verifyNodeValue('response', await this.post(endpoint, request), this.options.pin.publicKey);
        if (reply.nodeId !== identity.nodeId || reply.instanceId !== identity.instanceId || reply.requestId !== value.requestId
            || reply.requestHash !== nodeHash(request))
            throw new NodeSecurityError('RESPONSE_BINDING_MISMATCH');
        this.freshness(reply);
        if (!reply.ok)
            throw new NodeSecurityError(reply.error?.code ?? 'NODE_REJECTED');
        if (reply.result === undefined)
            throw new NodeSecurityError('INVALID_RESPONSE');
        return reply.result;
    }
    /** Retain the returned request to retry exactly after a lost response; never reuse its operationId for different content. */
    prepare(endpoint, capability, payload, holderKey) {
        validateNodeClaims(capability.value, this.now());
        if (capability.value.nodeId !== this.options.pin.nodeId)
            throw new NodeSecurityError('NODE_IDENTITY_MISMATCH');
        if (nodeKeyId(createPublicKey(holderKey)) !== nodeKeyId(capability.value.holderPublicKey))
            throw new NodeSecurityError('HOLDER_MISMATCH');
        return makeNodeRequest(endpoint, capability, payload, holderKey);
    }
    async send(request) {
        // Challenge on every connection/operation, including retries and port drift. No capability is sent first.
        const identity = await this.identity();
        if (request.capability.value.nodeId !== identity.nodeId || request.capability.value.nodeInstanceId !== identity.instanceId)
            throw new NodeSecurityError('NODE_IDENTITY_MISMATCH');
        const reply = verifyNodeValue('response', await this.post(request.endpoint, request), this.options.pin.publicKey);
        if (reply.protocol !== NODE_SECURITY_PROTOCOL || reply.nodeId !== identity.nodeId || reply.instanceId !== identity.instanceId
            || reply.requestId !== request.requestId || reply.requestHash !== nodeHash(request))
            throw new NodeSecurityError('RESPONSE_BINDING_MISMATCH');
        this.freshness(reply);
        if (!reply.ok)
            throw new NodeSecurityError(reply.error?.code ?? 'NODE_REJECTED');
        if (reply.result === undefined)
            throw new NodeSecurityError('INVALID_RESPONSE');
        return reply.result;
    }
    call(endpoint, capability, payload, holderKey) {
        return this.send(this.prepare(endpoint, capability, payload, holderKey));
    }
    openLease(cap, key, ttlMs = NODE_LEASE_MAX_MS) {
        return this.call('leases/open', cap, { ttlMs }, key);
    }
    renewLease(cap, key, ttlMs = NODE_LEASE_MAX_MS) {
        return this.call('leases/renew', cap, { ttlMs }, key);
    }
    revokeLease(cap, key) {
        return this.call('leases/revoke', cap, {}, key);
    }
    read(cap, key, path) {
        return this.call('files/read', cap, { path: nodeRelativePath(path) }, key);
    }
    list(cap, key, path = '.') {
        return this.call('files/list', cap, { path: nodeRelativePath(path) }, key);
    }
    write(cap, key, path, content, expectedSha256) {
        return this.call('files/write', cap, { path: nodeRelativePath(path), contentBase64: Buffer.from(content).toString('base64'), expectedSha256 }, key);
    }
    start(cap, key, argv) {
        return this.call('executions/start', cap, { argv }, key);
    }
    status(cap, key, executionId) {
        return this.call('executions/status', cap, { executionId }, key);
    }
    stop(cap, key, executionId) {
        return this.call('executions/stop', cap, { executionId }, key);
    }
}
