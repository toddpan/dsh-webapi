/** Exact public/request projections for the four Model Node management operations. */
export class ModelNodeBridgeError extends Error {
    status;
    code;
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVISION = /^[0-9a-f-]{36}:[0-9a-f]{64}$/;
const PROTOCOLS = ['responses', 'anthropic', 'chat-completions'];
const RESERVED = ['__proto__', 'constructor', 'prototype'];
function object(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail() { throw new ModelNodeBridgeError(502, 'MODEL_NODE_PROTOCOL_ERROR'); }
function bad() { throw new ModelNodeBridgeError(400, 'BAD_REQUEST'); }
function text(value, max = 200) {
    return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function identifier(value) {
    return text(value, 64) && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value) && !RESERVED.includes(value);
}
function shape(value, keys) {
    if (!object(value) || Object.keys(value).some(key => !keys.includes(key)))
        return bad();
    return value;
}
function nodeId(value, pinned) {
    if (value !== pinned)
        throw new ModelNodeBridgeError(409, 'NODE_ID_MISMATCH');
    return pinned;
}
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value))
    return fail(); return value; }
function revision(value) { if (typeof value !== 'string' || !REVISION.test(value))
    return fail(); return value; }
function endpoint(value) {
    if (!text(value, 2048))
        return fail();
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return fail();
    }
    if (url.username || url.password || url.search || url.hash)
        return fail();
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
        return fail();
    return value;
}
function models(value) {
    if (!object(value))
        return fail();
    const entries = Object.entries(value);
    if (entries.length === 0 || entries.length > 200)
        return fail();
    const result = Object.create(null);
    for (const [alias, upstream] of entries) {
        if (!text(alias) || RESERVED.includes(alias) || !text(upstream))
            return fail();
        result[alias] = upstream;
    }
    return result;
}
function provider(value) {
    if (!object(value) || !identifier(value.id) || !text(value.name) || !PROTOCOLS.includes(String(value.protocol)))
        return fail();
    const c = value.credential;
    if (!object(c) || typeof c.configured !== 'boolean' || !['literal', 'env', 'none'].includes(String(c.source)))
        return fail();
    let reference;
    if (c.source === 'env') {
        if (typeof c.reference !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(c.reference))
            return fail();
        reference = c.reference;
    }
    return { id: value.id, name: value.name, protocol: value.protocol,
        baseUrl: endpoint(value.baseUrl), models: models(value.models),
        credential: { configured: c.configured, source: c.source, ...(reference === undefined ? {} : { reference }) } };
}
function state(value, pinned) {
    if (!object(value) || value.version !== 1 || !Array.isArray(value.providers) || value.providers.length > 64)
        return fail();
    const providers = value.providers.map(provider);
    if (new Set(providers.map(p => p.id)).size !== providers.length)
        return fail();
    const route = value.route;
    if (!object(route) || typeof route.enabled !== 'boolean' || (route.providerId !== undefined && !identifier(route.providerId)))
        return fail();
    return { version: 1, nodeId: nodeId(value.nodeId, pinned), revision: revision(value.revision), providers,
        route: { enabled: route.enabled, ...(route.providerId === undefined ? {} : { providerId: route.providerId }) } };
}
function capabilities(value) {
    if (!object(value) || value.conditionalWrite !== 'observed-state-file')
        return fail();
    const result = { conditionalWrite: 'observed-state-file' };
    for (const key of ['inspect', 'preview', 'apply', 'rollback', 'providers', 'secrets', 'routing', 'responsesHttpSse', 'websocketRelay', 'websocketFallback']) {
        if (typeof value[key] !== 'boolean')
            return fail();
        result[key] = value[key];
    }
    if (value.websocketRelay !== false || value.websocketFallback !== true)
        return fail();
    // Native runtime-file forwarding is not in this bridge's fixed allowlist.
    result.nativeRuntimeFiles = false;
    return result;
}
/** No raw sidecar object/error/toJSON is ever sent to the client. */
export function projectModelNodeResponse(action, value, pinned) {
    if (!object(value))
        return fail();
    if (action === 'inspect')
        return { ...state(value, pinned), capabilities: capabilities(value.capabilities) };
    if (action === 'preview' || action === 'rollback') {
        const result = { planId: uuid(value.planId), before: state(value.before, pinned), after: state(value.after, pinned) };
        if (action === 'rollback')
            return result;
        if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0
            || !['provider.upsert', 'provider.delete', 'route.select', 'route.disable', 'rollback'].includes(String(value.changeType)))
            return fail();
        return { ...result, expiresAt: value.expiresAt, expectedRevision: revision(value.expectedRevision), changeType: value.changeType };
    }
    if (value.persisted !== true || value.verified !== true || value.effectiveScope !== 'node-configuration'
        || value.activation !== 'configuration-only')
        return fail();
    return { operationId: uuid(value.operationId), backupId: uuid(value.backupId), persisted: true, verified: true,
        revision: revision(value.revision), effectiveScope: 'node-configuration', activation: 'configuration-only' };
}
/** Rebuild the exact sidecar request; a URL/path/header/method cannot ride input. */
export function projectModelNodeRequest(action, value, pinned) {
    const keys = action === 'preview' ? ['expectedNodeId', 'expectedRevision', 'change']
        : action === 'apply' ? ['expectedNodeId', 'planId', 'idempotencyKey'] : ['expectedNodeId', 'backupId', 'expectedRevision'];
    const body = shape(value, keys);
    nodeId(body.expectedNodeId, pinned);
    if (action === 'apply') {
        if (typeof body.planId !== 'string' || !UUID.test(body.planId) || !text(body.idempotencyKey, 128))
            return bad();
        return { expectedNodeId: pinned, planId: body.planId, idempotencyKey: body.idempotencyKey };
    }
    if (typeof body.expectedRevision !== 'string' || !REVISION.test(body.expectedRevision))
        return bad();
    if (action === 'rollback') {
        if (typeof body.backupId !== 'string' || !UUID.test(body.backupId))
            return bad();
        return { expectedNodeId: pinned, backupId: body.backupId, expectedRevision: body.expectedRevision };
    }
    const change = body.change;
    if (!object(change))
        return bad();
    let result;
    if (change.type === 'provider.upsert') {
        shape(change, ['type', 'provider']);
        const p = shape(change.provider, ['id', 'name', 'protocol', 'baseUrl', 'models', 'secret']);
        if (!identifier(p.id) || (p.name !== undefined && !text(p.name)) || !PROTOCOLS.includes(String(p.protocol)))
            return bad();
        const secret = p.secret === undefined ? { action: 'keep' } : shape(p.secret, ['action', 'value', 'env']);
        let safeSecret;
        if (secret.action === 'replace' && text(secret.value, 4096) && /^[\x21-\x7e]+$/.test(secret.value) && secret.env === undefined) {
            safeSecret = { action: 'replace', value: secret.value };
        }
        else if (secret.action === 'reference' && typeof secret.env === 'string' && /^[A-Z_][A-Z0-9_]{0,127}$/.test(secret.env) && secret.value === undefined) {
            safeSecret = { action: 'reference', env: secret.env };
        }
        else if (['keep', 'clear'].includes(String(secret.action)) && secret.value === undefined && secret.env === undefined) {
            safeSecret = { action: secret.action };
        }
        else
            return bad();
        try {
            result = { type: 'provider.upsert', provider: { id: p.id, ...(p.name === undefined ? {} : { name: p.name }),
                    protocol: p.protocol, baseUrl: endpoint(p.baseUrl), models: models(p.models), secret: safeSecret } };
        }
        catch {
            return bad();
        }
    }
    else if (change.type === 'provider.delete') {
        shape(change, ['type', 'id']);
        if (!identifier(change.id))
            return bad();
        result = { type: change.type, id: change.id };
    }
    else if (change.type === 'route.select') {
        shape(change, ['type', 'providerId', 'enabled']);
        if (!identifier(change.providerId) || (change.enabled !== undefined && typeof change.enabled !== 'boolean'))
            return bad();
        result = { type: change.type, providerId: change.providerId, ...(change.enabled === undefined ? {} : { enabled: change.enabled }) };
    }
    else if (change.type === 'route.disable') {
        shape(change, ['type']);
        result = { type: change.type };
    }
    else
        return bad();
    return { expectedNodeId: pinned, expectedRevision: body.expectedRevision, change: result };
}
//# sourceMappingURL=model-node-contract.js.map