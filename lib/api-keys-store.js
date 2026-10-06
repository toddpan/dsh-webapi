/**
 * @dsh-external/dsh-web-service - API Key 存储与鉴权服务
 *
 * 设计要点（与 src/api-keys.ts 的管理路由、src/router.ts 的数据面闸门配合）：
 * - 明文 Key 只在「新建 / 轮换」响应里出现一次，之后不可再取回；
 *   managed key 落盘只存 sha256 摘要 + 可展示前缀；
 *   遗留 config.apiKey 是用户自选文本、熵不受控，**不落任何派生物**（不落 hash、不落前缀），
 *   校验时在内存里直接常量时间比对，避免低熵密钥被离线字典爆破。
 * - 数据面鉴权（业务接口）与管理面鉴权（Key 管理接口）使用两套不同凭证：
 *   数据面 = API Key；管理面 = admin token。持有 API Key 的三方客户端不能给自己加 Key。
 * - 单文件 JSON 落盘 + 内存缓存 + 原子替换（tmp + rename，0600），进程内写队列串行化读-改-写；
 *   变更先在副本上做，落盘成功才提交到内存，失败即回滚。
 * - **fail-closed**：存储损坏 / 尚未初始化完成时一律视为需要鉴权，绝不放松。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
/** 输入层错误（重复 Key、非法值等）：路由层应映射为 400，而不是 503 */
export class ApiKeyInputError extends Error {
    code;
    constructor(message, code = 'BAD_REQUEST') {
        super(message);
        this.code = code;
        this.name = 'ApiKeyInputError';
    }
}
// ==================== 工具 ====================
const KEY_PREFIX = 'dsk_';
const KEY_BODY_BYTES = 32;
const MANAGED_ID_RE = /^ks_[A-Za-z0-9_-]{8,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
/** 展示用前缀长度：managed key 剩余熵 ≥ 160 位，前缀泄露无风险 */
const DISPLAY_PREFIX_LEN = 12;
/** 生成高熵 API Key 明文：`dsk_` + 32 字节 base64url */
export function generatePlaintextKey() {
    return KEY_PREFIX + randomBytes(KEY_BODY_BYTES).toString('base64url');
}
function hashPlaintext(plaintext) {
    return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}
/** 定长缓冲的常量时间比较；长度不等直接 false（长度本身不是秘密） */
function safeEqualHex(aHex, bHex) {
    if (aHex.length !== bHex.length)
        return false;
    try {
        return timingSafeEqual(Buffer.from(aHex, 'hex'), Buffer.from(bHex, 'hex'));
    }
    catch {
        return false;
    }
}
function safeEqualString(a, b) {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length)
        return false;
    return timingSafeEqual(ab, bb);
}
/** 解析 DSH 配置根：config.dshHome → $DSH_HOME → ~/.dsh */
export function resolveDshHome(dshHome) {
    return dshHome || process.env.DSH_HOME || path.join(homedir(), '.dsh');
}
/** 统一脱敏：对外视图 */
export function toView(rec) {
    const now = Date.now();
    const isConfig = rec.source === 'config';
    // config / 自定义 Key 都不展示明文片段：它们的熵由外部决定，前缀可能就是大半价值
    const isOpaque = isConfig || rec.custom === true;
    return {
        id: rec.id,
        name: rec.name,
        note: rec.note,
        prefix: isOpaque ? '' : rec.prefix,
        masked: isConfig
            ? '（来自插件配置 · 不展示）'
            : rec.custom === true
                ? '（自定义 Key · 不展示）'
                : `${rec.prefix}${'•'.repeat(8)}`,
        createdAt: rec.createdAt,
        lastUsedAt: rec.lastUsedAt,
        expiresAt: rec.expiresAt,
        status: rec.status,
        expired: rec.status !== 'revoked' && Boolean(rec.expiresAt && rec.expiresAt <= now),
        revokedAt: rec.revokedAt,
        revokedReason: rec.revokedReason,
        source: rec.source,
        readOnly: isConfig,
        custom: rec.custom === true,
    };
}
function cloneRecords(records) {
    return JSON.parse(JSON.stringify(records));
}
// ==================== 存储 ====================
export class ApiKeyStore {
    legacyConfigKey;
    dir;
    file;
    adminTokenFile;
    records = [];
    authEnabledFlag = null;
    writeQueue = Promise.resolve();
    initPromise = null;
    initDone = false;
    adminTokenValue = '';
    lastUsedFlushAt = 0;
    /** 读盘失败 / 文件损坏 / 初始化失败时为 true（fail-closed：一律要求鉴权） */
    degraded = false;
    /** 上一次降级原因的说明（供 /system/status 与页面提示，不含任何凭证） */
    degradedReason = '';
    constructor(legacyConfigKey, dshHome) {
        this.legacyConfigKey = legacyConfigKey;
        this.dir = path.join(resolveDshHome(dshHome), 'dsh-web-service');
        this.file = path.join(this.dir, 'api-keys.json');
        this.adminTokenFile = path.join(this.dir, 'admin-token');
    }
    // ---------- 初始化 ----------
    /** 幂等初始化；所有公开方法调用前保证已就绪 */
    ensureReady() {
        if (!this.initPromise) {
            this.initPromise = this.init().catch((err) => {
                // 初始化失败按降级处理（fail-closed：不放松鉴权）
                this.markDegraded(`密钥存储初始化失败：${err?.message || err}`);
            });
        }
        return this.initPromise;
    }
    async init() {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        await this.load();
        await this.ensureAdminToken();
        await this.syncLegacyRecord();
        this.initDone = true;
    }
    async load() {
        let raw = null;
        try {
            raw = await readFile(this.file, 'utf8');
        }
        catch {
            raw = null;
        }
        if (raw === null) {
            // 主文件缺失：尝试备份
            const backup = await this.readBackup();
            if (backup === null) {
                this.records = [];
                this.authEnabledFlag = null;
                return;
            }
            const parsed = this.parseStore(backup);
            if (!parsed) {
                this.records = [];
                this.authEnabledFlag = null;
                this.markDegraded('api-keys.json 与其备份都不可解析，按空表启动（fail-closed：不放松鉴权）');
                return;
            }
            this.records = parsed.keys;
            this.authEnabledFlag = parsed.authEnabled;
            this.markDegraded('api-keys.json 缺失，已从 .bak 恢复；请尽快人工确认密钥清单');
            return;
        }
        const parsed = this.parseStore(raw);
        if (parsed) {
            this.records = parsed.keys;
            this.authEnabledFlag = parsed.authEnabled;
            return;
        }
        // 主文件损坏：改名保留取证，再尝试从 .bak 恢复，绝不静默丢弃既有记录
        await this.quarantineCorrupt();
        const backup = await this.readBackup();
        const recovered = backup === null ? null : this.parseStore(backup);
        if (recovered) {
            this.records = recovered.keys;
            this.authEnabledFlag = recovered.authEnabled;
            this.markDegraded('api-keys.json 解析失败（原文件已改名为 .corrupt-<ts> 保留取证），已从 .bak 恢复；请人工确认密钥清单');
        }
        else {
            this.records = [];
            this.authEnabledFlag = null;
            this.markDegraded('api-keys.json 解析失败且无可用备份（原文件已改名为 .corrupt-<ts> 保留取证），按空表启动（fail-closed：不放松鉴权）');
        }
    }
    /** 解析存储文件；返回 null 表示不可用 */
    parseStore(raw) {
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return null;
        }
        if (!parsed || !Array.isArray(parsed.keys))
            return null;
        return {
            keys: parsed.keys.filter((k) => this.isValidRecord(k)),
            authEnabled: typeof parsed.authEnabled === 'boolean' ? parsed.authEnabled : null,
        };
    }
    /**
     * 记录合法性：id / hash / prefix 都必须匹配形态，防止外部注入的记录
     * 把恶意字符串带进 HTML/JS 上下文（页面渲染依赖本校验）。
     */
    isValidRecord(k) {
        if (!k || typeof k !== 'object')
            return false;
        if (typeof k.id !== 'string')
            return false;
        if (k.id !== 'cfg-legacy' && !MANAGED_ID_RE.test(k.id))
            return false;
        if (typeof k.prefix !== 'string' || k.prefix.length > 32)
            return false;
        if (typeof k.hash !== 'string')
            return false;
        if (k.hash !== '' && !HASH_RE.test(k.hash))
            return false;
        return true;
    }
    /** 把损坏文件改名保留取证，并尽量从 .bak 恢复 */
    async quarantineCorrupt() {
        try {
            await rename(this.file, `${this.file}.corrupt-${Date.now()}`);
        }
        catch {
            /* 取证失败不影响降级判定 */
        }
    }
    async readBackup() {
        try {
            return await readFile(`${this.file}.bak`, 'utf8');
        }
        catch {
            return null;
        }
    }
    markDegraded(reason) {
        this.degraded = true;
        this.degradedReason = reason;
    }
    /** 把 config.apiKey 归一为只读遗留记录；**不落明文、不落 hash、不落前缀** */
    async syncLegacyRecord() {
        const exists = this.records.some((r) => r.source === 'config');
        if (!this.legacyConfigKey) {
            if (!exists)
                return;
            this.records = this.records.filter((r) => r.source !== 'config');
            await this.persist();
            return;
        }
        if (exists) {
            return;
        }
        this.records.push({
            id: 'cfg-legacy',
            name: '(config.apiKey)',
            note: '来自插件配置的遗留 Key，只读；如需轮换请先生成新 Key 再从配置中移除。',
            prefix: '',
            hash: '',
            algo: 'sha256',
            createdAt: Date.now(),
            status: 'active',
            source: 'config',
        });
        await this.persist();
    }
    // ---------- admin token ----------
    async ensureAdminToken() {
        if (this.adminTokenValue)
            return this.adminTokenValue;
        try {
            const raw = (await readFile(this.adminTokenFile, 'utf8')).trim();
            if (raw) {
                // 已存在的令牌文件不校验权限位，这里补一次收紧
                await chmod(this.adminTokenFile, 0o600).catch(() => undefined);
                this.adminTokenValue = raw;
                return raw;
            }
        }
        catch {
            // 不存在则生成
        }
        const token = randomBytes(32).toString('base64url');
        await writeFile(this.adminTokenFile, token, { mode: 0o600 });
        this.adminTokenValue = token;
        return token;
    }
    /** 供 CLI/文档提示使用：仅返回存放路径，绝不返回值 */
    get adminTokenPath() {
        return this.adminTokenFile;
    }
    // ---------- 查询 ----------
    list(includeRevoked = true) {
        const now = Date.now();
        return this.records
            .filter((r) => includeRevoked || this.effectiveStatus(r, now) === 'active')
            .map(toView);
    }
    get(id) {
        return this.records.find((r) => r.id === id);
    }
    countActive() {
        const now = Date.now();
        return this.records.filter((r) => this.effectiveStatus(r, now) === 'active').length;
    }
    effectiveStatus(rec, now) {
        if (rec.status === 'revoked')
            return 'revoked';
        if (rec.expiresAt && rec.expiresAt <= now)
            return 'revoked';
        return 'active';
    }
    // ---------- 鉴权 ----------
    /**
     * 是否强制数据面鉴权。
     * - config.apiKey 非空时强制开启（配置文件是权威，页面开关不能放松它）；
     * - **存储降级 / 未初始化完成时一律 fail-closed**：宁可把调用挡在门外，
     *   也不能因为一个写坏的 JSON 把已开启鉴权的部署静默变成匿名全开。
     */
    isEnforced() {
        if (this.degraded || !this.initDone)
            return true;
        return this.authEnabledFlag === true || Boolean(this.legacyConfigKey);
    }
    /** 页面开关当前值（考虑 config 回落） */
    getAuthEnabled() {
        return this.isEnforced();
    }
    /** config.apiKey 是否强制开启了鉴权（页面据此禁用关闭按钮） */
    get legacyEnforced() {
        return Boolean(this.legacyConfigKey);
    }
    /**
     * 数据面 token 校验：多 Key ∪ 遗留 Key。
     * - 遗留 Key 不落派生物，这里做内存常量时间直比；
     * - managed key 走 prefix 定位 + sha256 + timingSafeEqual。
     */
    verifyDataToken(token) {
        if (!token)
            return { ok: false };
        if (this.legacyConfigKey && safeEqualString(token, this.legacyConfigKey)) {
            return { ok: true, keyId: 'cfg-legacy' };
        }
        // 降级 / 未就绪：managed key 一律拒绝（fail-closed）
        if (this.degraded || !this.initDone)
            return { ok: false };
        const hash = hashPlaintext(token);
        const now = Date.now();
        // prefix 仅用于缩小候选范围，不参与授权结论；prefix 为空的记录（自定义 Key）始终作为候选
        const prefix = token.slice(0, DISPLAY_PREFIX_LEN);
        const candidates = this.records.filter((r) => r.source === 'managed' && r.hash !== '' && (r.prefix === prefix || r.prefix === ''));
        let matched;
        for (const rec of candidates) {
            const hit = safeEqualHex(hash, rec.hash);
            if (hit && !matched && this.effectiveStatus(rec, now) === 'active') {
                matched = rec;
            }
        }
        // 无论命中与否都补一次定长比较，抹平候选数不同带来的时序差（尽力而为）
        safeEqualHex(hash, DUMMY_DIGEST);
        return matched ? { ok: true, keyId: matched.id } : { ok: false };
    }
    /** 管理面 token 校验 */
    verifyAdminToken(token) {
        if (!token || !this.adminTokenValue)
            return false;
        return safeEqualString(token, this.adminTokenValue);
    }
    /** 记录最近使用时间（节流落盘，避免每次请求都写盘） */
    touch(keyId) {
        const rec = this.records.find((r) => r.id === keyId);
        if (!rec)
            return;
        rec.lastUsedAt = Date.now();
        const now = Date.now();
        if (now - this.lastUsedFlushAt > 60_000) {
            this.lastUsedFlushAt = now;
            this.persist().catch(() => undefined);
        }
    }
    // ---------- 变更（副本变更 + 落盘失败回滚） ----------
    /**
     * 在副本上执行变更，落盘成功才提交到内存；落盘失败则回滚并抛出，
     * 保证「响应所说的状态」与「实际生效的鉴权状态」始终一致。
     */
    async mutate(fn) {
        const snapshot = this.records;
        const snapshotAuth = this.authEnabledFlag;
        const working = cloneRecords(this.records);
        const result = fn(working);
        this.records = working;
        try {
            await this.persist();
        }
        catch (err) {
            this.records = snapshot;
            this.authEnabledFlag = snapshotAuth;
            throw err;
        }
        return result;
    }
    async create(input) {
        const custom = typeof input.plaintext === 'string' && input.plaintext.length > 0;
        const plaintext = custom ? input.plaintext : generatePlaintextKey();
        const hash = hashPlaintext(plaintext);
        const now = Date.now();
        return this.mutate((records) => {
            if (custom) {
                if (this.legacyConfigKey && safeEqualString(plaintext, this.legacyConfigKey)) {
                    throw new ApiKeyInputError('该 Key 与插件配置中的 apiKey 相同，无需重复登记');
                }
                // 只有「仍然有效」的记录才阻止重复登记：已吊销/已过期的值应当允许重新登记
                if (records.some((r) => r.hash === hash && r.hash !== '' && this.effectiveStatus(r, now) === 'active')) {
                    throw new ApiKeyInputError('该 Key 值已有一条有效记录，不能重复登记');
                }
            }
            const rec = {
                id: 'ks_' + randomBytes(9).toString('base64url'),
                name: normalizeName(input.name, records.length + 1),
                note: normalizeNote(input.note),
                // 自定义 Key 不展示任何明文片段（其熵由用户决定，前缀可能是大半价值）
                prefix: custom ? '' : plaintext.slice(0, DISPLAY_PREFIX_LEN),
                hash,
                algo: 'sha256',
                createdAt: now,
                expiresAt: resolveExpires(input.expiresInDays),
                status: 'active',
                source: 'managed',
                custom,
            };
            records.push(rec);
            return { view: toView(rec), plaintext };
        });
    }
    async update(id, patch) {
        return this.mutate((records) => {
            const rec = records.find((r) => r.id === id);
            if (!rec || rec.source === 'config')
                return null;
            if (typeof patch.name === 'string')
                rec.name = normalizeName(patch.name, 1);
            if (typeof patch.note === 'string')
                rec.note = normalizeNote(patch.note);
            if (patch.expiresAt === null)
                rec.expiresAt = undefined;
            else if (typeof patch.expiresAt === 'number' && Number.isFinite(patch.expiresAt)) {
                rec.expiresAt = patch.expiresAt;
            }
            return toView(rec);
        });
    }
    /** 轮换：生成新 Key 并把旧记录标记为 revoked/'rotated' */
    async rotate(id) {
        const plaintext = generatePlaintextKey();
        const now = Date.now();
        return this.mutate((records) => {
            const old = records.find((r) => r.id === id);
            if (!old || old.source === 'config')
                return null;
            const rec = {
                id: 'ks_' + randomBytes(9).toString('base64url'),
                name: old.name,
                note: old.note,
                prefix: plaintext.slice(0, DISPLAY_PREFIX_LEN),
                hash: hashPlaintext(plaintext),
                algo: 'sha256',
                createdAt: now,
                expiresAt: old.expiresAt,
                status: 'active',
                source: 'managed',
            };
            old.status = 'revoked';
            old.revokedAt = now;
            old.revokedReason = 'rotated';
            records.push(rec);
            return { view: toView(rec), plaintext };
        });
    }
    /** 吊销（幂等）；config 来源的遗留记录不可吊销 */
    async revoke(id) {
        return this.mutate((records) => {
            const rec = records.find((r) => r.id === id);
            if (!rec || rec.source === 'config')
                return null;
            if (rec.status !== 'revoked') {
                rec.status = 'revoked';
                rec.revokedAt = Date.now();
                rec.revokedReason = 'manual';
            }
            return toView(rec);
        });
    }
    /**
     * 删除记录：仅限「已吊销」的 managed key（清理审计残留，不影响任何有效凭证）。
     * 返回 null 表示 Key 不存在、来自 config 或仍处于有效状态——不可删除。
     */
    async remove(id) {
        return this.mutate((records) => {
            const idx = records.findIndex((r) => r.id === id);
            if (idx < 0)
                return null;
            const rec = records[idx];
            if (rec.source === 'config' || rec.status !== 'revoked')
                return null;
            records.splice(idx, 1);
            return toView(rec);
        });
    }
    async setAuthEnabled(enabled) {
        await this.mutate(() => {
            this.authEnabledFlag = enabled;
        });
    }
    // ---------- 落盘 ----------
    /**
     * 原子写：写 tmp（0600，wx）→ rename 覆盖主文件 → 复制一份「最后已知良好状态」到 .bak。
     * tmp+rename 保证主文件不会出现半截内容；.bak 用于抵御主文件被外部写坏（手工编辑/磁盘故障）。
     * 进程内写队列串行化读-改-写。
     */
    async persist() {
        const run = this.writeQueue.then(async () => {
            const payload = {
                version: 1,
                authEnabled: this.authEnabledFlag,
                keys: this.records,
                updatedAt: Date.now(),
            };
            const data = JSON.stringify(payload, null, 2);
            await mkdir(this.dir, { recursive: true, mode: 0o700 });
            const tmp = `${this.file}.tmp-${randomBytes(6).toString('hex')}`;
            await writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
            await rename(tmp, this.file);
            await copyFile(this.file, `${this.file}.bak`).catch(() => undefined);
        });
        // 队列自身不因失败而中断后续写
        this.writeQueue = run.catch(() => undefined);
        await run;
    }
}
const DUMMY_DIGEST = createHash('sha256').update('dsh-web-service-dummy-digest').digest('hex');
function normalizeName(input, fallbackSeq) {
    const raw = (input ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!raw)
        return `key-${fallbackSeq}`;
    return raw.slice(0, 64) || `key-${fallbackSeq}`;
}
function normalizeNote(input) {
    const raw = (input ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!raw)
        return undefined;
    return raw.slice(0, 256);
}
function resolveExpires(expiresInDays) {
    if (typeof expiresInDays !== 'number' || !Number.isFinite(expiresInDays))
        return undefined;
    if (expiresInDays <= 0)
        return undefined;
    return Date.now() + Math.round(expiresInDays * 86_400_000);
}
// ==================== 简易限流 ====================
/** 按 IP 的滑动窗口失败计数（内存态，进程重启即清零） */
export class FailureRateLimiter {
    limit;
    windowMs;
    hits = new Map();
    constructor(limit, windowMs) {
        this.limit = limit;
        this.windowMs = windowMs;
    }
    /** 当前是否已超限（超限时调用方应直接拒绝，不做任何校验） */
    isLimited(key) {
        const arr = this.hits.get(key);
        if (!arr)
            return false;
        const now = Date.now();
        return arr.filter((t) => now - t < this.windowMs).length > this.limit;
    }
    /** 记一次失败；返回 true 表示已超限 */
    record(key) {
        const now = Date.now();
        const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
        arr.push(now);
        this.hits.set(key, arr);
        if (this.hits.size > 5000)
            this.prune(now);
        return arr.length > this.limit;
    }
    prune(now) {
        for (const [k, arr] of this.hits) {
            const kept = arr.filter((t) => now - t < this.windowMs);
            if (kept.length === 0)
                this.hits.delete(k);
            else
                this.hits.set(k, kept);
        }
    }
}
//# sourceMappingURL=api-keys-store.js.map