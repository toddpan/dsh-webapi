/**
 * @dsh-external/dsh-web-service - API Key 管理（设置页 + 管理接口）
 *
 * 路由：
 *   页面      GET    {prefix}/settings/api-keys        （公开，与 /docs 一致）
 *   列表      GET    {prefix}/api-keys
 *   新建      POST   {prefix}/api-keys                 → 201，返回明文（之后可复制）
 *   改名/过期 PATCH  {prefix}/api-keys/:id
 *   轮换      POST   {prefix}/api-keys/:id/rotate      → 返回明文（之后可复制）
 *   复制      POST   {prefix}/api-keys/:id/reveal      → 取回明文（管理令牌；历史 Key 409）
 *   吊销      POST   {prefix}/api-keys/:id/revoke      （幂等）
 *   删除      DELETE {prefix}/api-keys/:id             （仅限已吊销的 managed Key）
 *   鉴权开关  GET    {prefix}/api-keys/auth
 *   鉴权开关  PUT    {prefix}/api-keys/auth
 *
 * 注册顺序约束：字面量路由（/api-keys/auth）不得被参数路由（/api-keys/:id*）抢先匹配，
 * 新增路由时请保持「字面量优先」，或使用互不重叠的 method。
 *
 * 管理面鉴权（全部 /api-keys* 路由）：
 *   1) 远端地址必须是回环（config.adminRemoteAccess=true 才放开）
 *   2) 浏览器请求做同源校验（防 CSRF；DNS rebinding 由 admin token 的高熵性兜底）
 *   3) 必须携带 admin token（Authorization: Bearer / X-Admin-Token）；失败限流后短路拒绝
 *   —— 持有普通 API Key 的三方客户端不能调用这些接口。
 */
import { sendJson } from './router.js';
import { ApiKeyInputError, FailureRateLimiter } from './api-keys-store.js';
import { generateApiKeysHtml } from './api-keys-page.js';
const adminFailLimiter = new FailureRateLimiter(10, 60_000);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
function clientIp(req) {
    return req.socket?.remoteAddress || 'unknown';
}
function isLoopback(req) {
    const addr = clientIp(req);
    return (addr === '127.0.0.1' ||
        addr === '::1' ||
        addr === '::ffff:127.0.0.1' ||
        addr.startsWith('127.'));
}
/** 浏览器跨源请求一律拒绝；无 Origin（curl / 服务端调用）不校验 */
function isCrossOrigin(req) {
    const origin = req.headers['origin'];
    if (typeof origin !== 'string' || !origin)
        return false;
    const host = req.headers['host'];
    if (typeof host !== 'string' || !host)
        return true;
    try {
        return new URL(origin).host !== host;
    }
    catch {
        return true;
    }
}
function extractToken(req, headerName, bearer) {
    const authHeader = req.headers['authorization'];
    if (bearer && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7).trim();
    }
    const raw = req.headers[headerName];
    return typeof raw === 'string' ? raw.trim() : '';
}
function noStore(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
}
/** 输入校验：只做长度与控制字符校验，不删用户的合法字符 */
function validateInput(body) {
    if (!body || typeof body !== 'object')
        return null;
    if (body.name !== undefined) {
        if (typeof body.name !== 'string')
            return 'name 必须是字符串';
        if (body.name.length > 64)
            return 'name 最长 64 个字符';
        if (CONTROL_CHARS.test(body.name))
            return 'name 含非法控制字符';
    }
    if (body.note !== undefined && body.note !== null) {
        if (typeof body.note !== 'string')
            return 'note 必须是字符串';
        if (body.note.length > 256)
            return 'note 最长 256 个字符';
        if (CONTROL_CHARS.test(body.note))
            return 'note 含非法控制字符';
    }
    if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
        const d = body.expiresInDays;
        if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0 || d > 3650) {
            return 'expiresInDays 必须是 0 到 3650 之间的数字';
        }
    }
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
        const t = body.expiresAt;
        if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1e15) {
            return 'expiresAt 必须是合法的 epoch 毫秒数';
        }
    }
    if (body.plaintext !== undefined && body.plaintext !== null) {
        if (typeof body.plaintext !== 'string')
            return 'plaintext 必须是字符串';
        const p = body.plaintext;
        if (p.length < 16 || p.length > 256) {
            return '自定义 Key 长度需在 16-256 个字符之间';
        }
        // 只允许可见 ASCII：Key 会放进 Authorization 头，换行/空格会让请求体非法
        if (!/^[\x21-\x7e]+$/.test(p)) {
            return '自定义 Key 只能包含可见 ASCII 字符（不能含空格或换行）';
        }
    }
    return null;
}
/** 返回 true 表示请求已被本函数终结（未通过管理面鉴权） */
async function rejectAdmin(req, res, store, opts) {
    noStore(res);
    const ip = clientIp(req);
    if (isCrossOrigin(req)) {
        sendJson(res, 403, {
            ok: false,
            error: 'Forbidden: cross-origin request rejected',
            code: 'FORBIDDEN_ORIGIN',
        });
        return true;
    }
    if (!opts.adminRemoteAccess && !isLoopback(req)) {
        sendJson(res, 403, {
            ok: false,
            error: 'Forbidden: API Key 管理接口仅允许本机（回环）访问。' +
                '确需远程管理时，请在插件配置中设置 adminRemoteAccess: true。',
            code: 'FORBIDDEN_REMOTE',
        });
        return true;
    }
    // 超限直接短路，不做任何令牌比对（不给暴力试探保留反馈回路）
    if (adminFailLimiter.isLimited(ip)) {
        sendJson(res, 429, {
            ok: false,
            error: 'Too many failed admin authentication attempts, please retry later',
            code: 'RATE_LIMITED',
        });
        return true;
    }
    await store.ensureReady();
    const token = extractToken(req, 'x-admin-token', true);
    if (!store.verifyAdminToken(token)) {
        adminFailLimiter.record(ip);
        sendJson(res, 401, {
            ok: false,
            error: 'Unauthorized: 缺少或错误的管理令牌（Admin Token）。' +
                '令牌存放于 DSH 配置根下的 dsh-web-service/admin-token 文件。',
            code: 'ADMIN_UNAUTHORIZED',
        });
        return true;
    }
    return false;
}
export function registerApiKeyRoutes(router, config, store) {
    const prefix = config.pathPrefix || '/api/v1';
    const guardOpts = {
        adminRemoteAccess: config.adminRemoteAccess === true,
    };
    // ---------- 页面（公开，页面本身不含任何密钥） ----------
    router.get('/settings/api-keys', (_req, res, _p, query) => {
        noStore(res);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        // 注入管理令牌文件的绝对路径，让令牌门直接给出可复制的 cat 命令；
        // embed=1 供 DSH GUI 侧边栏 iframe 使用（隐藏面包屑等导航冗余）
        const embed = query.embed === '1';
        res.end(generateApiKeysHtml(prefix, store.adminTokenPath, embed));
    }, { auth: 'public' });
    // ---------- 列表 ----------
    router.get('/api-keys', async (req, res, _p, query) => {
        if (await rejectAdmin(req, res, store, guardOpts))
            return;
        await store.ensureReady();
        const includeRevoked = query.includeRevoked !== 'false';
        sendJson(res, 200, {
            ok: true,
            data: {
                authEnabled: store.getAuthEnabled(),
                authEnforcedByConfig: store.legacyEnforced,
                activeKeyCount: store.countActive(),
                storeDegraded: store.degraded,
                storeDegradedReason: store.degradedReason || undefined,
                keys: store.list(includeRevoked),
            },
        });
    }, { auth: 'admin' });
    // ---------- 新建 ----------
    router.post('/api-keys', async (req, res, _p, _q, body) => {
        if (await rejectAdmin(req, res, store, guardOpts))
            return;
        const bad = validateInput(body);
        if (bad) {
            sendJson(res, 400, { ok: false, error: bad, code: 'BAD_REQUEST' });
            return;
        }
        try {
            const input = body && typeof body === 'object' ? body : {};
            const created = await store.create({
                name: typeof input.name === 'string' ? input.name : undefined,
                note: typeof input.note === 'string' ? input.note : undefined,
                expiresInDays: typeof input.expiresInDays === 'number' ? input.expiresInDays : undefined,
                plaintext: typeof input.plaintext === 'string' ? input.plaintext : undefined,
            });
            sendJson(res, 201, {
                ok: true,
                data: {
                    key: created.view,
                    plaintext: created.plaintext,
                    warning: created.view.custom
                        ? '这是你自行指定的 Key；本服务只保存它的哈希，之后无法再查看或找回它。'
                        : '完整 Key 之后仍可在列表中「复制」，但建议现在就存到安全的地方。',
                },
            });
        }
        catch (err) {
            if (err instanceof ApiKeyInputError) {
                sendJson(res, 400, { ok: false, error: err.message, code: err.code });
                return;
            }
            // 不透传 err.message（可能含文件系统绝对路径）
            sendJson(res, 503, {
                ok: false,
                error: 'Key 存储写入失败，本次没有产生 Key，也未改变任何既有 Key 的状态。',
                code: 'KEYS_STORE_UNAVAILABLE',
            });
        }
    }, { auth: 'admin' });
    // ---------- 改名 / 过期 ----------
    router.patch('/api-keys/:id', async (req, res, params, _q, body) => {
        if (await rejectAdmin(req, res, store, guardOpts))
            return;
        const bad = validateInput(body);
        if (bad) {
            sendJson(res, 400, { ok: false, error: bad, code: 'BAD_REQUEST' });
            return;
        }
        const id = params.id;
        const patch = body && typeof body === 'object' ? body : {};
        try {
            const updated = await store.update(id, {
                name: typeof patch.name === 'string' ? patch.name : undefined,
                note: typeof patch.note === 'string' ? patch.note : undefined,
                expiresAt: patch.expiresAt === null
                    ? null
                    : typeof patch.expiresAt === 'number'
                        ? patch.expiresAt
                        : undefined,
            });
            if (!updated) {
                sendJson(res, 404, {
                    ok: false,
                    error: 'Key 不存在，或该 Key 来自插件配置、不支持修改',
                    code: 'KEY_NOT_FOUND',
                });
                return;
            }
            sendJson(res, 200, { ok: true, data: updated });
        }
        catch {
            sendJson(res, 503, {
                ok: false,
                error: 'Key 存储写入失败，本次修改没有生效。',
                code: 'KEYS_STORE_UNAVAILABLE',
            });
        }
    }, { auth: 'admin' });
    // ---------- 轮换 ----------
    router.post('/api-keys/:id/rotate', async (req, res, params) => {
        if (await rejectAdmin(req, res, store, guardOpts))
            return;
        try {
            const rotated = await store.rotate(params.id);
            if (!rotated) {
                sendJson(res, 404, {
                    ok: false,
                    error: 'Key 不存在，或该 Key 来自插件配置、不支持轮换',
                    code: 'KEY_NOT_FOUND',
                });
                return;
            }
            sendJson(res, 200, {
                ok: true,
                data: {
                    key: rotated.view,
                    plaintext: rotated.plaintext,
                    warning: '旧 Key 已立即失效；新 Key 之后仍可在列表中复制。',
                },
            });
        }
        catch {
            sendJson(res, 503, {
                ok: false,
                error: 'Key 存储写入失败，本次没有产生新 Key，旧 Key 仍然有效。',
                code: 'KEYS_STORE_UNAVAILABLE',
            });
        }
    }, { auth: 'admin' });
    // ---------- 复制（解密返回明文） ----------
    // 历史记录只落了 sha256，明文不可恢复；此时返回 409 并引导轮换，而不是静默给错值。
    router.post('/api-keys/:id/reveal', async (req, res, params) => {
        if (await rejectAdmin(req, res, store, guardOpts))
            return;
        let result;
        try {
            result = await store.reveal(params.id);
        }
        catch {
            sendJson(res, 503, {
                ok: false,
                error: 'Key 存储读取失败',
                code: 'KEYS_STORE_UNAVAILABLE',
            });
            return;
        }
        if (result === null) {
            sendJson(res, 404, {
                ok: false,
                error: 'Key 不存在，或该 Key 来自插件配置、没有可复制的明文',
                code: 'KEY_NOT_FOUND',
            });
            return;
        }
        if (result === 'unrecoverable') {
            sendJson(res, 409, {
                ok: false,
                error: '该 Key 的明文不可恢复（创建于加密存储启用之前，或已吊销、密文失效）。请用「轮换」生成一条可复制的新 Key。',
                code: 'KEY_NOT_RECOVERABLE',
            });
            return;
        }
        sendJson(res, 200, { ok: true, data: { plaintext: result.plaintext } });
    }, { auth: 'admin' });
    // ---------- 吊销 ----------
    router.post('/api-keys/:id/revoke', async (req, res, params) => {
        if (await rejectAdmin(req, res, store, guardOpts))
            return;
        try {
            const revoked = await store.revoke(params.id);
            if (!revoked) {
                sendJson(res, 404, {
                    ok: false,
                    error: 'Key 不存在，或该 Key 来自插件配置、不支持吊销',
                    code: 'KEY_NOT_FOUND',
                });
                return;
            }
            sendJson(res, 200, {
                ok: true,
                data: {
                    id: revoked.id,
                    status: revoked.status,
                    revokedAt: revoked.revokedAt,
                    message: `已吊销「${revoked.name}」。使用该 Key 的客户端从现在起会被拒绝。`,
                },
            });
        }
        catch {
            sendJson(res, 503, {
                ok: false,
                error: 'Key 存储写入失败，「该 Key」仍然有效，请重试。',
                code: 'KEYS_STORE_UNAVAILABLE',
            });
        }
    }, { auth: 'admin' });
    // ---------- 删除（仅限已吊销的 Key；清理记录，不影响任何有效凭证） ----------
    router.delete('/api-keys/:id', async (req, res, params) => {
        if (await rejectAdmin(req, res, store, guardOpts))
            return;
        try {
            const removed = await store.remove(params.id);
            if (!removed) {
                sendJson(res, 404, {
                    ok: false,
                    error: 'Key 不存在，或该 Key 不是「已吊销」状态（仅已吊销的 Key 可删除）',
                    code: 'KEY_NOT_FOUND',
                });
                return;
            }
            sendJson(res, 200, {
                ok: true,
                data: {
                    id: removed.id,
                    message: `已删除「${removed.name}」的记录。`,
                },
            });
        }
        catch {
            sendJson(res, 503, {
                ok: false,
                error: 'Key 存储写入失败，删除没有生效，记录仍保留。',
                code: 'KEYS_STORE_UNAVAILABLE',
            });
        }
    }, { auth: 'admin' });
    // ---------- 鉴权状态 ----------
    router.get('/api-keys/auth', async (req, res) => {
        if (await rejectAdmin(req, res, store, guardOpts))
            return;
        await store.ensureReady();
        sendJson(res, 200, {
            ok: true,
            data: {
                authEnabled: store.getAuthEnabled(),
                authEnforcedByConfig: store.legacyEnforced,
                activeKeyCount: store.countActive(),
                legacyKeyPresent: store.legacyEnforced,
                adminRemoteAccess: guardOpts.adminRemoteAccess === true,
                storeDegraded: store.degraded,
                storeDegradedReason: store.degradedReason || undefined,
            },
        });
    }, { auth: 'admin' });
    // ---------- 鉴权开关 ----------
    router.put('/api-keys/auth', async (req, res, _p, _q, body) => {
        if (await rejectAdmin(req, res, store, guardOpts))
            return;
        const patch = body && typeof body === 'object' ? body : {};
        if (typeof patch.enabled !== 'boolean') {
            sendJson(res, 400, {
                ok: false,
                error: 'Invalid body: enabled 必须是 boolean',
                code: 'BAD_REQUEST',
            });
            return;
        }
        if (!patch.enabled) {
            if (store.legacyEnforced) {
                sendJson(res, 400, {
                    ok: false,
                    error: '无法关闭鉴权：插件配置中的 apiKey 强制开启了鉴权。' +
                        '请先从配置中移除 apiKey，再回到本页面操作。',
                    code: 'BAD_REQUEST',
                });
                return;
            }
            if (patch.confirm !== 'disable-auth') {
                sendJson(res, 400, {
                    ok: false,
                    error: '关闭鉴权会让任何能访问本服务端口的程序无需 Key 即可调用全部接口。' +
                        '确认关闭请传 confirm: "disable-auth"。',
                    code: 'BAD_REQUEST',
                });
                return;
            }
        }
        if (patch.enabled && store.countActive() === 0 && !store.legacyEnforced) {
            sendJson(res, 400, {
                ok: false,
                error: '当前没有任何有效的 API Key，开启鉴权会拒绝所有 API 请求（把自己锁在外面）。' +
                    '请先生成一条 Key。',
                code: 'BAD_REQUEST',
            });
            return;
        }
        try {
            await store.setAuthEnabled(patch.enabled);
        }
        catch {
            sendJson(res, 503, {
                ok: false,
                error: '设置保存失败，鉴权状态未改变。',
                code: 'KEYS_STORE_UNAVAILABLE',
            });
            return;
        }
        sendJson(res, 200, {
            ok: true,
            data: {
                authEnabled: store.getAuthEnabled(),
                authEnforcedByConfig: store.legacyEnforced,
                activeKeyCount: store.countActive(),
                message: patch.enabled
                    ? '鉴权已开启。客户端请求需携带有效 API Key。'
                    : '鉴权已关闭。任何能访问本服务端口的程序都可调用全部接口，请尽快恢复。',
            },
        });
    }, { auth: 'admin' });
}
//# sourceMappingURL=api-keys.js.map