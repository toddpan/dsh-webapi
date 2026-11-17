/** Local lifecycle adapter for the vendored WorkBuddy security node protocol. */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as F } from 'node:fs';
import { chmod, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { hostname } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as protocol from '../vendor/security-node/node-security.js';
import { startSecurityNode } from '../vendor/security-node/security-node-service.mjs';
const PAIRING_TTL_MS = 5 * 60 * 1000;
const execFileAsync = promisify(execFile);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const within = (root, target) => {
    const rel = path.relative(root, target);
    return !rel || rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel);
};
const overlaps = (a, b) => within(a, b) || within(b, a);
const sameRoots = (a, b) => a.length === b.length && a.every((root, i) => root === b[i]);
const errorMessages = {
    NODE_PLATFORM_UNSUPPORTED: '安全节点仅支持 macOS/Linux；Windows 不提供路径隔离。',
    UNPRIVILEGED_UNIX_REQUIRED: '安全节点必须以非 root 的 Unix 用户运行。',
    PYTHON_UNAVAILABLE: '安全节点需要可运行的 /usr/bin/python3（Python 3.8+）；文件隔离不可用。',
    NO_WORKSPACE_ROOTS: '没有可导出的工作目录，请配置真实的工作区目录。',
    INVALID_WORKSPACE_ROOT: '工作区必须是规范的绝对目录路径。',
    SENSITIVE_ROOT_OVERLAP: '工作区不能覆盖节点身份、状态或 API Key 存储目录。',
    UNTRUSTED_CONFIG_PATH: '安全节点目录及其祖先必须为当前用户/root 所有，不能是符号链接或允许其他用户写入。',
    PRIVATE_CONFIG_REQUIRED: '节点身份及状态必须为当前用户所有的 0600 独立普通文件。',
    NODE_IDENTITY_MISSING: '节点身份文件丢失；拒绝自动更换已有节点身份。',
    NODE_IDENTITY_INVALID: '节点身份或元数据无效；拒绝自动更换身份。',
    DSH_PUBLIC_URL_REQUIRED: '配对前需要公网 DSH API 地址。',
    DSH_MANAGED_KEY_REQUIRED: '配对前需要有效、自动生成且永不过期的 managed API Key。',
    KEY_STORE_UNAVAILABLE: 'API Key 存储不可用，安全节点不能配对。',
    NODE_RUNTIME_CLOSED: '安全节点已关闭。',
};
export class NodeRuntimeError extends Error {
    code;
    constructor(code) {
        super(errorMessages[code] || '安全节点运行时不可用（' + code + '）');
        this.code = code;
        this.name = 'NodeRuntimeError';
    }
}
function requireThat(condition, code) {
    if (!condition)
        throw new NodeRuntimeError(code);
}
function safeError(error) {
    if (error instanceof NodeRuntimeError)
        return error;
    const code = error?.code;
    return new NodeRuntimeError(typeof code === 'string' && /^[A-Z_]{2,80}$/.test(code) ? code : 'NODE_RUNTIME_UNAVAILABLE');
}
/** Keep the original runtime's private-ancestor and no-symlink contract. */
async function privateDirectory(target, own = false) {
    requireThat(path.isAbsolute(target) && path.normalize(target) === target && target !== '/', 'UNTRUSTED_CONFIG_PATH');
    let current = path.parse(target).root;
    for (const part of target.slice(current.length).split(path.sep)) {
        current = path.join(current, part);
        const st = await lstat(current);
        requireThat(st.isDirectory() && !st.isSymbolicLink() && [0, process.getuid()].includes(st.uid)
            && !(st.mode & 0o022), 'UNTRUSTED_CONFIG_PATH');
        if (current === target && own)
            requireThat(st.uid === process.getuid(), 'ROOT_OWNER_REQUIRED');
    }
}
async function readPrivate(file) {
    let st;
    try {
        st = await lstat(file);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    requireThat(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.uid === process.getuid()
        && !(st.mode & 0o077) && st.size <= 1_000_000, 'PRIVATE_CONFIG_REQUIRED');
    const handle = await open(file, F.O_RDONLY | F.O_NOFOLLOW);
    try {
        const opened = await handle.stat();
        requireThat(opened.ino === st.ino && opened.dev === st.dev && opened.nlink === 1
            && opened.size <= 1_000_000 && !(opened.mode & 0o077), 'PRIVATE_CONFIG_REQUIRED');
        return await handle.readFile('utf8');
    }
    finally {
        await handle.close();
    }
}
/** Atomic replacement with private files, fsync and no partial plaintext on disk. */
async function writePrivate(file, content, createOnly = false) {
    await readPrivate(file);
    const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '-' + randomUUID() + '.tmp');
    const handle = await open(temporary, F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
    let exists = true;
    try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
        await handle.close();
        if (createOnly)
            await link(temporary, file);
        else {
            await rename(temporary, file);
            exists = false;
        }
        const directory = await open(path.dirname(file), F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
        try {
            await directory.sync();
        }
        finally {
            await directory.close();
        }
    }
    finally {
        await handle.close().catch(() => { });
        // temporary is an exclusive file in the already verified private parent.
        if (exists)
            await unlink(temporary).catch(() => { });
    }
}
/**
 * Owns identity/state and the existing security runtime, including its Python broker.
 * All public mutations serialize; close is terminal. No DSH fallback or host tools.
 */
export class NodeRuntime {
    options;
    dir;
    stateDir;
    identityFile;
    metadataFile;
    queue = Promise.resolve();
    closed = false;
    preflightDone = false;
    metadata;
    runtime;
    config;
    roots = [];
    lastError;
    responses = new Set();
    constructor(options) {
        this.options = options;
        this.dir = path.resolve(options.dir);
        this.stateDir = path.join(this.dir, 'state');
        this.identityFile = path.join(this.dir, 'identity.pem');
        this.metadataFile = path.join(this.dir, 'node.json');
    }
    serial(action) {
        const operation = this.queue.then(action).catch(error => {
            this.lastError = safeError(error);
            throw this.lastError;
        });
        this.queue = operation.then(() => { }, () => { });
        return operation;
    }
    async preflight() {
        requireThat(['darwin', 'linux'].includes(process.platform), 'NODE_PLATFORM_UNSUPPORTED');
        requireThat(typeof process.getuid === 'function' && process.getuid() !== 0, 'UNPRIVILEGED_UNIX_REQUIRED');
        if (this.preflightDone)
            return;
        try {
            await execFileAsync('/usr/bin/python3', ['-I', '-c',
                'import os,sys; assert sys.version_info >= (3,8); assert os.O_NOFOLLOW and os.O_DIRECTORY; import ctypes,fcntl,resource'], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 5000, maxBuffer: 4096 });
        }
        catch {
            throw new NodeRuntimeError('PYTHON_UNAVAILABLE');
        }
        this.preflightDone = true;
    }
    async identity() {
        if (this.metadata)
            return;
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        await privateDirectory(this.dir, true);
        await chmod(this.dir, 0o700);
        await mkdir(this.stateDir, { mode: 0o700, recursive: true });
        await privateDirectory(this.stateDir, true);
        await chmod(this.stateDir, 0o700);
        const stored = await readPrivate(this.metadataFile);
        let privatePem = await readPrivate(this.identityFile);
        if (!privatePem) {
            requireThat(!stored, 'NODE_IDENTITY_MISSING');
            const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
            try {
                await writePrivate(this.identityFile, key, true);
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw error;
            }
            privatePem = await readPrivate(this.identityFile);
        }
        requireThat(privatePem, 'NODE_IDENTITY_MISSING');
        let publicKey;
        try {
            const key = createPrivateKey(privatePem);
            requireThat(key.asymmetricKeyType === 'ed25519', 'NODE_IDENTITY_INVALID');
            publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
        }
        catch {
            throw new NodeRuntimeError('NODE_IDENTITY_INVALID');
        }
        const nodeId = 'wb-node-' + protocol.nodeKeyId(publicKey).slice(0, 40);
        if (stored) {
            let value;
            try {
                value = JSON.parse(stored);
            }
            catch {
                throw new NodeRuntimeError('NODE_IDENTITY_INVALID');
            }
            requireThat(value?.version === 1 && value.nodeId === nodeId && value.publicKey === publicKey
                && typeof value.name === 'string' && value.name.trim() && value.name.length <= 255
                && Number.isSafeInteger(value.createdAt), 'NODE_IDENTITY_INVALID');
            this.metadata = value;
        }
        else {
            const value = { version: 1, nodeId, publicKey, name: hostname().slice(0, 255) || nodeId, createdAt: Date.now() };
            await writePrivate(this.metadataFile, JSON.stringify(value));
            this.metadata = value;
        }
    }
    async readRoots() {
        const input = await this.options.getRoots();
        requireThat(Array.isArray(input), 'INVALID_WORKSPACE_ROOT');
        const candidates = new Set();
        for (const value of input) {
            requireThat(typeof value === 'string' && path.isAbsolute(value) && !/[\\\x00-\x1f\x7f]/.test(value), 'INVALID_WORKSPACE_ROOT');
            const root = path.normalize(value);
            if (root === '/')
                continue;
            candidates.add(root);
        }
        // When the registry includes a parent and child, keep only the narrower roots.
        const roots = [...candidates].filter(root => ![...candidates].some(other => root !== other && within(root, other))).sort();
        requireThat(roots.length > 0, 'NO_WORKSPACE_ROOTS');
        requireThat(roots.length <= 64, 'INVALID_WORKSPACES');
        for (const root of roots) {
            requireThat(![this.dir, path.resolve(this.options.keyStore.dir)].some(sensitive => overlaps(root, sensitive)), 'SENSITIVE_ROOT_OVERLAP');
            await privateDirectory(root, true);
        }
        return roots;
    }
    async stop() {
        const runtime = this.runtime;
        this.runtime = undefined;
        for (const response of this.responses)
            response.destroy();
        this.responses.clear();
        if (runtime)
            await runtime.close();
    }
    async prepareInternal(refreshReference = false) {
        requireThat(!this.closed, 'NODE_RUNTIME_CLOSED');
        try {
            await this.preflight();
            await this.options.keyStore.ensureReady();
            requireThat(!this.options.keyStore.degraded, 'KEY_STORE_UNAVAILABLE');
            await this.identity();
            const roots = await this.readRoots();
            let reference = this.config?.dshRef;
            if (refreshReference) {
                // Startup may precede tunnel discovery; only pairing requires a public locator.
                try {
                    reference = await this.dshReference();
                }
                catch {
                    reference = undefined;
                }
                if (this.config)
                    this.config.dshRef = reference;
            }
            if (this.runtime?.running && sameRoots(roots, this.roots)) {
                this.lastError = undefined;
                return;
            }
            await this.stop();
            const previousRoots = await readPrivate(path.join(this.stateDir, 'roots.json'));
            if (previousRoots && !sameRoots(JSON.parse(previousRoots), roots)) {
                await writePrivate(path.join(this.stateDir, 'pairing.json'), JSON.stringify({ digest: '', expiresAt: 0 }));
            }
            const catalogFile = path.join(this.stateDir, 'catalog-workspaces.json');
            const stored = await readPrivate(catalogFile);
            if (stored) {
                const catalog = JSON.parse(stored);
                requireThat(Array.isArray(catalog), 'INVALID_WORKSPACE_CATALOG');
                const retained = catalog.filter(ws => ws && typeof ws.root === 'string' && roots.some(root => within(root, ws.root)));
                if (retained.length !== catalog.length)
                    await writePrivate(catalogFile, JSON.stringify(retained));
            }
            this.config = {
                nodeId: this.metadata.nodeId, name: this.metadata.name, privateKeyFile: this.identityFile,
                issuerKeys: {}, stateDir: this.stateDir, host: '127.0.0.1', port: 0, allowFileOnly: true,
                workspaces: roots.map(root => ({ workspaceId: 'root-' + sha256(root).slice(0, 40), root, policyVersion: 1 })),
                ...(reference ? { dshRef: reference } : {}),
            };
            this.roots = roots;
            await writePrivate(path.join(this.stateDir, 'roots.json'), JSON.stringify(roots));
            this.runtime = await startSecurityNode(this.config, protocol);
            this.lastError = undefined;
        }
        catch (error) {
            await this.stop();
            throw error;
        }
    }
    /** Idempotent startup. Reconciles exact roots and restarts if the registry changes. */
    prepare() { return this.serial(() => this.prepareInternal(true)); }
    /** Called before API-key/CORS middleware; the security runtime owns the entire /v1/ protocol. */
    handle(req, res) {
        if (!req.url?.startsWith('/v1/'))
            return false;
        if (!this.runtime?.running || this.closed || this.responses.size >= 64) {
            res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: false, error: { code: 'NODE_RUNTIME_UNAVAILABLE' } }));
            return true;
        }
        this.responses.add(res);
        const timer = setTimeout(() => res.destroy(), 10_000);
        const done = () => { clearTimeout(timer); this.responses.delete(res); };
        res.once('finish', done);
        res.once('close', done);
        this.runtime.server.emit('request', req, res);
        return true;
    }
    status() {
        const identity = this.runtime?.identity;
        return {
            nodeId: this.metadata?.nodeId, name: this.metadata?.name || hostname(),
            running: !this.closed && this.runtime?.running === true, roots: [...this.roots],
            publicKey: this.metadata?.publicKey, keyId: identity?.keyId, instanceId: identity?.instanceId,
            isolation: identity ? structuredClone(identity.isolation) : undefined,
            platform: process.platform,
            ...(this.lastError ? { error: this.lastError.message, errorCode: this.lastError.code } : {}),
        };
    }
    async dshReference() {
        const value = await this.options.getDshRef();
        let url;
        try {
            url = new URL(value?.baseUrl);
        }
        catch {
            throw new NodeRuntimeError('DSH_PUBLIC_URL_REQUIRED');
        }
        const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
            || host === '::' || host === '::1' || host.startsWith('fc') && isIP(host) === 6 || host.startsWith('fd') && isIP(host) === 6
            || host.startsWith('fe80:') || /^(0|10|127|169\.254|192\.168)\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
        requireThat(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && !local, 'DSH_PUBLIC_URL_REQUIRED');
        requireThat(typeof value?.apiKey === 'string' && value.apiKey.length <= 8192 && !/[\r\n]/.test(value.apiKey), 'DSH_MANAGED_KEY_REQUIRED');
        const verified = this.options.keyStore.verifyDataToken(value.apiKey);
        const record = verified.ok && verified.keyId ? this.options.keyStore.get(verified.keyId) : undefined;
        requireThat(record?.source === 'managed' && record.status === 'active' && !record.custom && !record.expiresAt, 'DSH_MANAGED_KEY_REQUIRED');
        // Only a stable locator crosses the protocol boundary. The key stays in ApiKeyStore.
        // WorkBuddy resolves a mapping's one-time read credential, so the public URL may drift safely.
        if (value?.mappingId !== undefined) {
            requireThat(typeof value.mappingId === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value.mappingId), 'DSH_MAPPING_REQUIRED');
            return { kind: 'mapping', mappingId: value.mappingId };
        }
        return { kind: 'direct', apiBaseUrl: url.href.replace(/\/$/, '') };
    }
    createPairing() {
        return this.serial(async () => {
            await this.prepareInternal();
            const dshRef = await this.dshReference();
            requireThat(this.runtime?.running && this.config && this.metadata, 'NODE_RUNTIME_UNAVAILABLE');
            // startSecurityNode closes over this exact object; never replace it here.
            this.config.dshRef = dshRef;
            const secret = randomBytes(32).toString('hex');
            const expiresAt = Date.now() + PAIRING_TTL_MS;
            await writePrivate(path.join(this.stateDir, 'pairing.json'), JSON.stringify({ digest: sha256(secret), expiresAt }));
            const pairingCode = 'wbpair1.' + Buffer.from(JSON.stringify({ nodeId: this.metadata.nodeId,
                publicKey: this.metadata.publicKey, secret, expiresAt })).toString('base64url');
            this.lastError = undefined;
            return { pairingCode, expiresAt, nodeId: this.metadata.nodeId, name: this.metadata.name };
        });
    }
    /** Stop transport/broker without discarding identity; prepare can resume it. */
    pause() {
        return this.serial(async () => {
            requireThat(!this.closed, 'NODE_RUNTIME_CLOSED');
            await this.stop();
        });
    }
    /** Destroy forwarded responses, close the loopback listener and await broker exit. */
    close() {
        this.closed = true;
        return this.serial(() => this.stop());
    }
}
//# sourceMappingURL=node-runtime.js.map