/**
 * Administrator-only bridge to the WorkBuddy model node sidecar.
 *
 * Exactly four fixed operations. Credentials live in a private bridge file that
 * only this module reads; nothing here accepts a URL, port, path or method from
 * the request. Every operation first proves the sidecar's identity matches the
 * pinned UUID from that file, then sends a reconstructed allowlisted request.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rejectAdmin } from './api-keys.js';
import { readJsonBody, sendJson } from './router.js';
import { ModelNodeBridgeError, projectModelNodeRequest, projectModelNodeResponse, } from './model-node-contract.js';
const MAX_BRIDGE_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ADMIN_BODY = 64 * 1024;
const TIMEOUT_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class BridgeUnavailable extends Error {
    code;
    status;
    message;
    constructor(code, status, message) {
        super(code);
        this.code = code;
        this.status = status;
        this.message = message;
    }
}
function bridgeHome(options) {
    return options.home || process.env.WORKBUDDY_MODEL_NODE_HOME || join(homedir(), '.workbuddy-model-node');
}
/** Read the private bridge file. Any unsafe mode, owner, link or shape fails closed. */
async function readBridgeFile(home) {
    const file = join(home, 'bridge.json');
    let handle;
    try {
        handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    catch {
        throw new BridgeUnavailable('MODEL_NODE_NOT_INSTALLED', 503, 'This node has no model node bridge; install the node agent skill first');
    }
    try {
        const stat = await handle.stat();
        const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BRIDGE_BYTES
            || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) {
            throw new BridgeUnavailable('MODEL_NODE_BRIDGE_UNSAFE', 503, 'The node bridge file is not a private owned file');
        }
        let parsed;
        try {
            parsed = JSON.parse(await handle.readFile('utf8'));
        }
        catch {
            throw new BridgeUnavailable('MODEL_NODE_BRIDGE_UNSAFE', 503, 'The node bridge file is invalid');
        }
        const value = parsed;
        if (!value || typeof value !== 'object' || value.version !== 1
            || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535
            || typeof value.adminToken !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(value.adminToken)
            || typeof value.nodeId !== 'string' || !UUID.test(value.nodeId)) {
            throw new BridgeUnavailable('MODEL_NODE_BRIDGE_UNSAFE', 503, 'The node bridge file is invalid');
        }
        return { version: 1, port: value.port, adminToken: value.adminToken, nodeId: value.nodeId };
    }
    finally {
        await handle.close();
    }
}
/** One bounded loopback round trip. Redirects, cross-origin and wrong identity all fail closed. */
async function callSidecar(bridge, action, payload, fetchImpl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetchImpl(`http://127.0.0.1:${bridge.port}/management/${action}`, {
            method: action === 'inspect' ? 'GET' : 'POST',
            redirect: 'manual',
            signal: controller.signal,
            headers: {
                authorization: `Bearer ${bridge.adminToken}`,
                'x-workbuddy-node-id': bridge.nodeId,
                accept: 'application/json',
                ...(action === 'inspect' ? {} : { 'content-type': 'application/json' }),
            },
            ...(action === 'inspect' ? {} : { body: JSON.stringify(payload) }),
        });
        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel().catch(() => { });
            throw new BridgeUnavailable('MODEL_NODE_REDIRECT', 502, 'The node bridge redirected a management call');
        }
        if (response.status === 409) {
            await response.body?.cancel().catch(() => { });
            throw new ModelNodeBridgeError(409, 'REVISION_CONFLICT');
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => { });
            throw new BridgeUnavailable('MODEL_NODE_UNAVAILABLE', 502, 'The node bridge rejected this management call');
        }
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
            await response.body?.cancel().catch(() => { });
            throw new BridgeUnavailable('MODEL_NODE_PROTOCOL_ERROR', 502, 'The node bridge response was too large');
        }
        const reader = response.body?.getReader();
        if (!reader)
            throw new BridgeUnavailable('MODEL_NODE_PROTOCOL_ERROR', 502, 'The node bridge returned an empty response');
        const chunks = [];
        let total = 0;
        try {
            for (;;) {
                const next = await reader.read();
                if (next.done)
                    break;
                total += next.value.byteLength;
                if (total > MAX_RESPONSE_BYTES)
                    throw new BridgeUnavailable('MODEL_NODE_PROTOCOL_ERROR', 502, 'The node bridge response was too large');
                chunks.push(next.value);
            }
        }
        finally {
            await reader.cancel().catch(() => { });
        }
        let envelope;
        try {
            envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        catch {
            throw new BridgeUnavailable('MODEL_NODE_PROTOCOL_ERROR', 502, 'The node bridge returned invalid JSON');
        }
        const record = envelope;
        if (!record || typeof record !== 'object' || record.ok !== true)
            throw new BridgeUnavailable('MODEL_NODE_PROTOCOL_ERROR', 502, 'The node bridge response was not successful');
        return record.data;
    }
    catch (error) {
        if (error instanceof BridgeUnavailable || error instanceof ModelNodeBridgeError)
            throw error;
        throw new BridgeUnavailable('MODEL_NODE_UNREACHABLE', 502, 'The model node is not reachable on loopback');
    }
    finally {
        clearTimeout(timer);
    }
}
async function run(options, action, input) {
    const fetchImpl = options.fetchImpl || fetch;
    const home = bridgeHome(options);
    const bridge = await readBridgeFile(home);
    // Identity proof first: never send a write to a sidecar we cannot attribute.
    const inspection = await callSidecar(bridge, 'inspect', undefined, fetchImpl);
    const state = projectModelNodeResponse('inspect', inspection, bridge.nodeId);
    if (action === 'inspect')
        return state;
    const raw = await input.body?.();
    const payload = projectModelNodeRequest(action, raw, bridge.nodeId);
    const currentRevision = state.revision;
    if (action === 'apply') {
        const expected = raw?.expectedRevision;
        if (expected !== undefined && expected !== currentRevision)
            throw new ModelNodeBridgeError(409, 'REVISION_CONFLICT');
    }
    return projectModelNodeResponse(action, await callSidecar(bridge, action, payload, fetchImpl), bridge.nodeId);
}
export function registerModelNodeBridgeRoutes(ctx, router, config, store, options = {}) {
    const guardOptions = { adminRemoteAccess: config.adminRemoteAccess === true };
    const unavailable = (res, error) => {
        if (error instanceof ModelNodeBridgeError) {
            sendJson(res, error.status, { ok: false, code: error.code, error: error.status === 409 ? 'The node configuration changed; inspect again before writing' : 'Invalid node management request' });
            return true;
        }
        if (error instanceof BridgeUnavailable) {
            sendJson(res, error.status, { ok: false, code: error.code, error: error.message });
            return true;
        }
        return false;
    };
    router.get('/model-config/node/inspect', async (req, res) => {
        try {
            if (await rejectAdmin(req, res, store, guardOptions))
                return;
            sendJson(res, 200, { ok: true, data: await run(options, 'inspect', {}) });
        }
        catch (error) {
            if (unavailable(res, error))
                return;
            sendJson(res, 503, { ok: false, code: 'MODEL_NODE_UNAVAILABLE', error: 'The node management bridge is unavailable' });
        }
    }, { auth: 'admin' });
    for (const action of ['preview', 'apply', 'rollback']) {
        router.post(`/model-config/node/${action}`, async (req, res) => {
            try {
                if (await rejectAdmin(req, res, store, guardOptions))
                    return;
                // Authenticate and authorize BEFORE any body read; the body is bounded and never echoed.
                let raw;
                try {
                    raw = await readJsonBody(req, MAX_ADMIN_BODY);
                }
                catch {
                    sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'Invalid node management body' });
                    return;
                }
                sendJson(res, 200, { ok: true, data: await run(options, action, { body: async () => raw }) });
            }
            catch (error) {
                if (unavailable(res, error))
                    return;
                sendJson(res, 503, { ok: false, code: 'MODEL_NODE_UNAVAILABLE', error: 'The node management bridge is unavailable' });
            }
        }, { auth: 'admin', deferBody: true });
    }
}
//# sourceMappingURL=model-config-node.js.map