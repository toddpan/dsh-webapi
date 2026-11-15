/** Narrow native settings edits. Observed-namespace fencing, NOT durable external-writer CAS. */
import { createHash, randomUUID } from 'node:crypto';
import { rejectAdmin } from './api-keys.js';
import { modelConfigInstanceId } from './model-config.js';
import { readJsonBody, sendJson } from './router.js';
class Refusal extends Error {
    status;
    code;
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
const DEFAULT_FIELDS = ['provider', 'model', 'reasoningEffort'];
const PROVIDER_FIELDS = ['displayName', 'baseURL', 'api', 'timeoutMs'];
const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'];
const PLAN_TTL = 60_000;
const OP_TTL = 5 * 60_000;
const LIMIT = 256;
const bad = () => { throw new Refusal(400, 'BAD_REQUEST'); };
const unsupported = () => { throw new Refusal(501, 'NOT_SUPPORTED'); };
const conflict = () => { throw new Refusal(409, 'REVISION_CONFLICT'); };
function object(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function plain(value) {
    return object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function short(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 1024
        && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}
function id(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)
        && !['__proto__', 'prototype', 'constructor'].includes(value);
}
function exact(value, keys) {
    if (!plain(value) || Object.keys(value).some(key => !keys.includes(key)))
        return bad();
    return value;
}
function targetOf(value) {
    const t = exact(value, ['kind', 'provider']);
    if (t.kind === 'default' && t.provider === undefined)
        return { kind: 'default' };
    if (t.kind === 'provider' && id(t.provider))
        return { kind: 'provider', provider: t.provider };
    return bad();
}
function fenceOf(value) {
    const v = exact(value, ['instanceId', 'namespace', 'revision', 'fingerprint']);
    if (typeof v.instanceId !== 'string' || !short(v.namespace)
        || !Number.isSafeInteger(v.revision) || v.revision < 0
        || typeof v.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(v.fingerprint))
        return bad();
    return { instanceId: v.instanceId, namespace: v.namespace, revision: v.revision, fingerprint: v.fingerprint };
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function checkFence(actual, expected) {
    if (!same(actual, expected))
        conflict();
}
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function at(root, path) {
    let value = root;
    for (const part of path) {
        if (value === undefined)
            return undefined;
        if (!object(value))
            return unsupported();
        value = Object.hasOwn(value, part) ? value[part] : undefined;
    }
    if (value === undefined)
        return undefined;
    if (!object(value))
        return unsupported();
    return value;
}
function validField(target, key, value) {
    if (key === 'timeoutMs')
        return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
    if (!short(value))
        return false;
    if (target.kind === 'default')
        return key !== 'provider' || id(value);
    if (key === 'api')
        return PROTOCOLS.includes(value);
    if (key === 'baseURL') {
        try {
            const url = new URL(value);
            // Never project/persist inline authentication, query tokens or fragments.
            return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
                && Boolean(url.hostname) && value.length <= 1024;
        }
        catch {
            return false;
        }
    }
    return key === 'displayName';
}
function project(root, fields, target) {
    const result = {};
    for (const field of fields) {
        const value = root && Object.hasOwn(root, field) ? root[field] : undefined;
        if (value === undefined)
            continue;
        if (!validField(target, field, value))
            return unsupported();
        result[field] = value;
    }
    return result;
}
function canonical(target) { return target.kind === 'default' ? 'agent-default-model' : `provider:${target.provider}`; }
function requestId(value) {
    if (!id(value) || value.length < 8)
        return bad();
    return value;
}
function bodyRuntime(value) { if (value !== undefined && value !== 'dsh')
    unsupported(); }
function fieldsEqual(a, b) {
    return same(Object.entries(a).sort(), Object.entries(b).sort());
}
export function registerNativeModelConfigRoutes(ctx, router, config, store) {
    const plans = new Map();
    const requests = new Map();
    const operations = new Map();
    const queues = new Map();
    const guard = { adminRemoteAccess: config.adminRemoteAccess === true };
    function prune() {
        const now = Date.now();
        for (const [key, plan] of requests)
            if (plan.expiresAt <= now)
                requests.delete(key);
        for (const [key, plan] of plans)
            if (plan.expiresAt <= now)
                plans.delete(key);
        for (const [key, op] of operations)
            if (op.expiresAt <= now)
                operations.delete(key);
    }
    function serialize(namespace, work) {
        const previous = queues.get(namespace) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(work);
        queues.set(namespace, next);
        void next.finally(() => { if (queues.get(namespace) === next)
            queues.delete(namespace); }).catch(() => undefined);
        return next;
    }
    async function read(target) {
        const controller = ctx.get('settingsController');
        const llm = ctx.get('llm');
        if (!object(controller) || !object(llm))
            return unsupported();
        const describe = controller.describe;
        const mutate = controller.mutate;
        const directory = llm.listConfigurableProviders;
        if (typeof describe !== 'function' || typeof mutate !== 'function' || typeof directory !== 'function')
            return unsupported();
        const entries = await directory.call(llm);
        if (!Array.isArray(entries))
            return unsupported();
        let namespace = 'agent-default-model';
        let path = [];
        const fields = target.kind === 'default' ? DEFAULT_FIELDS : PROVIDER_FIELDS;
        if (target.kind === 'provider') {
            const matches = entries.filter(item => object(item) && item.provider === target.provider);
            if (matches.length !== 1)
                return unsupported();
            const entry = matches[0];
            const ns = entry.settingsNs;
            const locator = entry.settingsPath;
            // Only the observed pi-ai adapter shape; never arbitrary namespaces/paths.
            if (ns !== 'llm-pi-ai' || !Array.isArray(locator) || !same(locator, ['providers', target.provider]))
                return unsupported();
            namespace = ns;
            path = ['providers', target.provider];
        }
        const description = await describe.call(controller);
        if (!object(description) || description.writable !== true || !Array.isArray(description.namespaces))
            return unsupported();
        const matches = description.namespaces.filter(item => object(item) && item.ns === namespace);
        if (matches.length !== 1)
            return unsupported();
        const descriptor = matches[0];
        const revision = descriptor.revision;
        if (!Number.isSafeInteger(revision) || revision < 0)
            return unsupported();
        const resolved = at(descriptor.value, path);
        if (!resolved)
            return unsupported(); // Provider creation is not owned here.
        const values = project(resolved, fields, target);
        const base = project(at(descriptor.base, path), fields, target);
        const user = project(at(descriptor.user, path), fields, target);
        if (target.kind === 'default' && (!values.provider || !values.model))
            return unsupported();
        // Stable ordering of the allowlisted projection. Unknown fields and secrets
        // never enter a response, hash, preview, log, or rollback snapshot.
        const fingerprint = hash([target, namespace, path, fields.map(key => [key, values[key] ?? null, base[key] ?? null, user[key] ?? null])]);
        return { target, namespace, path, fields, values, base, user,
            fence: { instanceId: modelConfigInstanceId, namespace, revision: revision, fingerprint },
            controller, mutate: mutate.bind(controller) };
    }
    function view(snapshot) {
        return { version: 1, runtime: 'dsh', instanceId: modelConfigInstanceId, source: 'node-manager',
            target: snapshot.target, revision: snapshot.fence, values: snapshot.values,
            editableFields: snapshot.fields, capabilities: { inspect: true, preview: true, apply: true,
                rollback: true, providers: snapshot.target.kind === 'provider', secrets: false, routing: false,
                conditionalWrite: 'observed-namespace' },
            scope: 'observed-namespace', persisted: false, verified: true };
    }
    async function validateDefault(values) {
        if (typeof values.provider !== 'string' || typeof values.model !== 'string')
            return bad();
        const controller = ctx.get('sessionController');
        if (!object(controller) || typeof controller.modelCatalog !== 'function')
            return unsupported();
        const catalog = await controller.modelCatalog();
        if (!object(catalog) || !Array.isArray(catalog.groups))
            return unsupported();
        if (catalog.failures !== undefined && (!Array.isArray(catalog.failures) || catalog.failures.length > 0)) {
            throw new Refusal(503, 'MODEL_CATALOG_UNAVAILABLE');
        }
        const models = catalog.groups.flatMap(group => object(group) && group.id === values.provider && Array.isArray(group.models) ? group.models : []);
        const model = models.find(item => object(item) && item.id === values.model);
        if (!object(model))
            return bad(); // No guessed model on a route-only provider.
        if (values.reasoningEffort !== undefined) {
            const reasoning = model.reasoning;
            if (!object(reasoning) || !Array.isArray(reasoning.efforts)
                || !reasoning.efforts.some(item => object(item) && item.id === values.reasoningEffort))
                return bad();
        }
    }
    function patched(snapshot, patch) {
        const p = exact(patch, snapshot.fields);
        const keys = Object.keys(p).sort();
        if (!keys.length)
            return bad();
        const user = { ...snapshot.user };
        const ops = [];
        for (const key of keys) {
            const value = p[key];
            if (value === null) {
                if (snapshot.target.kind === 'default' && key !== 'reasoningEffort')
                    return bad();
                delete user[key];
                ops.push({ op: 'unset', path: [...snapshot.path, key] });
            }
            else {
                if (!validField(snapshot.target, key, value))
                    return bad();
                user[key] = value;
                ops.push({ op: 'set', path: [...snapshot.path, key], value });
            }
        }
        const values = { ...snapshot.base, ...user };
        // Unchanged effective fields may come from schema defaults, not base/user.
        for (const key of snapshot.fields)
            if (!keys.includes(key) && snapshot.values[key] !== undefined)
                values[key] = snapshot.values[key];
        if (snapshot.target.kind === 'default' && (!values.provider || !values.model))
            return bad();
        return { values, user, ops };
    }
    function previewView(plan) {
        return { previewId: plan.id, requestId: plan.requestId, expiresAt: plan.expiresAt,
            target: plan.before.target, expectedRevision: plan.before.fence,
            before: plan.before.values, after: plan.after.values, conditionalWrite: 'observed-namespace',
            persisted: false, verified: false };
    }
    async function write(operationId, snapshot, ops, desired, op) {
        const data = { operationId, persisted: 'unknown', verified: false,
            rollbackAvailable: false, conditionalWrite: 'observed-namespace' };
        try {
            await snapshot.mutate(snapshot.namespace, ops, snapshot.fence.revision);
            data.persisted = true; // Host acknowledged persistence, not runtime activation.
        }
        catch (error) {
            const code = object(error) ? error.code : undefined;
            if (code === 'settings/conflict' || code === 'SETTINGS_CONFLICT') {
                data.persisted = false;
                return { status: 409, code: 'REVISION_CONFLICT', data };
            }
            if (code === 'settings/rejected')
                data.persisted = false;
            return { status: 503, code: 'NATIVE_WRITE_UNCONFIRMED', data };
        }
        try {
            const post = await read(snapshot.target);
            if (post.controller !== snapshot.controller || post.fence.revision < snapshot.fence.revision
                || !fieldsEqual(post.user, desired.user) || !fieldsEqual(post.values, desired.values)) {
                return { status: 503, code: 'NATIVE_READBACK_UNVERIFIED', data };
            }
            data.verified = true;
            data.revision = post.fence;
            op.post = post;
            data.rollbackAvailable = op.before !== undefined;
            return { status: 200, data };
        }
        catch {
            return { status: 503, code: 'NATIVE_READBACK_UNVERIFIED', data };
        }
    }
    function cached(id, binding) {
        const existing = operations.get(id);
        if (!existing)
            return undefined;
        if (existing.binding !== binding)
            throw new Refusal(409, 'IDEMPOTENCY_CONFLICT');
        return existing.result;
    }
    function respond(res, outcome) {
        sendJson(res, outcome.status, outcome.code
            ? { ok: false, code: outcome.code, error: 'Native model configuration operation was not confirmed', data: outcome.data }
            : { ok: true, data: outcome.data });
    }
    async function runApply(body) {
        exact(body, ['runtime', 'previewId', 'expectedRevision', 'operationId']);
        bodyRuntime(body.runtime);
        const operationId = requestId(body.operationId);
        const expected = fenceOf(body.expectedRevision);
        if (!id(body.previewId))
            return bad();
        const binding = hash(['apply', body.previewId, expected]);
        const replay = cached(operationId, binding);
        if (replay)
            return replay;
        const plan = plans.get(body.previewId);
        if (!plan || plan.expiresAt <= Date.now())
            throw new Refusal(409, 'PREVIEW_EXPIRED');
        checkFence(plan.before.fence, expected);
        if (plan.used)
            throw new Refusal(409, 'PLAN_CONSUMED');
        if (operations.size >= LIMIT)
            throw new Refusal(503, 'CAPACITY_EXCEEDED');
        plan.used = true;
        const op = { binding, expiresAt: Date.now() + OP_TTL, result: Promise.resolve(undefined), before: plan.before };
        op.result = serialize(plan.before.namespace, async () => {
            if (plan.expiresAt <= Date.now())
                throw new Refusal(409, 'PREVIEW_EXPIRED');
            const current = await read(plan.before.target);
            checkFence(current.fence, expected);
            if (current.controller !== plan.before.controller)
                return conflict();
            if (current.target.kind === 'default')
                await validateDefault(plan.after.values);
            // Re-read after catalog validation awaited: no stale user snapshot is used.
            const fresh = await read(plan.before.target);
            checkFence(fresh.fence, expected);
            if (fresh.controller !== plan.before.controller)
                return conflict();
            return write(operationId, fresh, plan.ops, plan.after, op);
        });
        operations.set(operationId, op);
        return op.result;
    }
    async function runRollback(body) {
        exact(body, ['runtime', 'appliedOperationId', 'expectedRevision', 'operationId']);
        bodyRuntime(body.runtime);
        const operationId = requestId(body.operationId);
        const appliedId = requestId(body.appliedOperationId);
        if (operationId === appliedId)
            return bad();
        const expected = fenceOf(body.expectedRevision);
        const binding = hash(['rollback', appliedId, expected]);
        const replay = cached(operationId, binding);
        if (replay)
            return replay;
        const original = operations.get(appliedId);
        if (!original?.before || !original.post || original.rolledBack)
            throw new Refusal(409, 'ROLLBACK_UNAVAILABLE');
        if (operations.size >= LIMIT)
            throw new Refusal(503, 'CAPACITY_EXCEEDED');
        const before = original.before;
        const post = original.post;
        const op = { binding, expiresAt: Date.now() + OP_TTL, result: Promise.resolve(undefined) };
        op.result = serialize(before.namespace, async () => {
            const current = await read(before.target);
            checkFence(current.fence, expected);
            if (current.controller !== post.controller || current.fence.fingerprint !== post.fence.fingerprint)
                return conflict();
            if (before.target.kind === 'default')
                await validateDefault(before.values);
            const fresh = await read(before.target);
            checkFence(fresh.fence, expected);
            if (fresh.controller !== post.controller)
                return conflict();
            // Restore only fields the preview touched. Missing prior user values mean
            // unset/inherit; never replace a whole namespace/profile from a redacted view.
            const plan = [...plans.values()].find(p => p.before === before);
            if (!plan)
                throw new Refusal(409, 'ROLLBACK_UNAVAILABLE');
            const ops = plan.ops.map(item => {
                const field = item.path[item.path.length - 1];
                return Object.hasOwn(before.user, field)
                    ? { op: 'set', path: [...item.path], value: before.user[field] }
                    : { op: 'unset', path: [...item.path] };
            });
            const outcome = await write(operationId, fresh, ops, { values: before.values, user: before.user }, op);
            // A refused/conflicted attempt must not consume the single rollback slot:
            // the caller may retry with the actual current revision.
            if (outcome.status === 200)
                original.rolledBack = true;
            return outcome;
        });
        operations.set(operationId, op);
        return op.result;
    }
    async function handle(req, res, work) {
        try {
            if (await rejectAdmin(req, res, store, guard))
                return;
            prune();
            await work();
        }
        catch (error) {
            sendJson(res, error instanceof Refusal ? error.status : 503, {
                ok: false, code: error instanceof Refusal ? error.code : 'NATIVE_CONFIG_UNAVAILABLE',
                error: 'Native model configuration request was refused',
            });
        }
    }
    router.get('/model-config/native/inspect', (req, res, _params, query) => handle(req, res, async () => {
        exact(query, ['runtime', 'target', 'provider']);
        bodyRuntime(query.runtime);
        const target = targetOf(query.target === 'default' ? { kind: 'default' }
            : query.target === 'provider' ? { kind: 'provider', provider: query.provider } : null);
        if (target.kind === 'default' && query.provider !== undefined)
            return bad();
        sendJson(res, 200, { ok: true, data: view(await read(target)) });
    }), { auth: 'admin' });
    for (const action of ['preview', 'apply', 'rollback']) {
        router.post(`/model-config/${action}`, (req, res) => handle(req, res, async () => {
            let body;
            try {
                body = await readJsonBody(req, 64 * 1024);
            }
            catch {
                return bad();
            }
            if (!plain(body))
                return bad();
            if (action === 'apply') {
                respond(res, await runApply(body));
                return;
            }
            if (action === 'rollback') {
                respond(res, await runRollback(body));
                return;
            }
            exact(body, ['runtime', 'target', 'expectedRevision', 'requestId', 'patch']);
            bodyRuntime(body.runtime);
            const target = targetOf(body.target);
            const expected = fenceOf(body.expectedRevision);
            const request = requestId(body.requestId);
            const current = await read(target);
            checkFence(current.fence, expected);
            const after = patched(current, body.patch);
            if (target.kind === 'default')
                await validateDefault(after.values);
            const binding = hash([target, expected, after.ops]);
            const previous = requests.get(request);
            if (previous) {
                if (previous.binding !== binding)
                    throw new Refusal(409, 'IDEMPOTENCY_CONFLICT');
                sendJson(res, 200, { ok: true, data: previewView(previous) });
                return;
            }
            if (plans.size >= LIMIT)
                throw new Refusal(503, 'CAPACITY_EXCEEDED');
            const plan = { id: randomUUID(), binding, requestId: request, expiresAt: Date.now() + PLAN_TTL,
                before: current, after: { values: after.values, user: after.user }, ops: after.ops, used: false };
            plans.set(plan.id, plan);
            requests.set(request, plan);
            sendJson(res, 200, { ok: true, data: previewView(plan) });
        }), { auth: 'admin', deferBody: true });
    }
}
//# sourceMappingURL=model-config-native.js.map