/**
 * @dsh-external/dsh-web-service - 检查更新
 *
 * 版本单一来源：GitHub Releases（仓库 homepage/bugs 同源 toddpan/dsh-webapi）。
 * - 成功结果缓存 10 分钟，避免公开端点被刷成 GitHub 的出站代理；
 * - 失败结果缓存 60 秒（网络抖动时不反复打超时请求）；
 * - 检查更新是尽力而为的能力：任何失败都不抛错，返回带 error 说明的结果，
 *   由页面友好展示「检查失败」，不影响服务本身。
 */
const RELEASE_API = 'https://api.github.com/repos/toddpan/dsh-webapi/releases/latest';
const RELEASE_PAGE = 'https://github.com/toddpan/dsh-webapi/releases';
const OK_CACHE_TTL_MS = 10 * 60_000;
const FAIL_CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;
let okCache = null;
let failCache = null;
/** 语义化版本比较：>0 表示 a 更新。忽略前缀 v 与预发布段（预发布 < 正式版） */
export function compareVersions(a, b) {
    const parse = (v) => {
        const [core, pre] = v.trim().replace(/^v/i, '').split('-');
        const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
        while (nums.length < 3)
            nums.push(0);
        return { core: nums.slice(0, 3), pre: Boolean(pre) };
    };
    const pa = parse(a);
    const pb = parse(b);
    for (let i = 0; i < 3; i++) {
        if (pa.core[i] !== pb.core[i])
            return pa.core[i] - pb.core[i];
    }
    if (pa.pre !== pb.pre)
        return pa.pre ? -1 : 1;
    return 0;
}
export async function checkForUpdate(current) {
    const now = Date.now();
    if (okCache && now - okCache.at < OK_CACHE_TTL_MS)
        return okCache.data;
    if (failCache && now - failCache.at < FAIL_CACHE_TTL_MS)
        return failCache.data;
    const base = {
        current,
        latest: null,
        updateAvailable: null,
        releaseUrl: RELEASE_PAGE,
        checkedAt: now,
    };
    try {
        const resp = await fetch(RELEASE_API, {
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'dsh-web-service-update-check',
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (resp.status === 404) {
            // 仓库还没有任何 Release：不是故障，视为已是最新
            const data = {
                ...base,
                updateAvailable: false,
                error: '仓库还没有发布任何 Release',
            };
            okCache = { at: now, data };
            return data;
        }
        if (!resp.ok)
            throw new Error('GitHub API 返回 HTTP ' + resp.status);
        const body = await resp.json();
        const rawTag = typeof body?.tag_name === 'string' ? body.tag_name : '';
        if (!rawTag)
            throw new Error('响应缺少 tag_name');
        // 归一化 tag 前缀（v0.1.11 → 0.1.11），调用方展示时再统一补 v，避免出现「vv0.1.11」
        const latest = rawTag.replace(/^v/i, '');
        const data = {
            ...base,
            latest,
            updateAvailable: compareVersions(latest, current) > 0,
            releaseUrl: typeof body?.html_url === 'string' && body.html_url ? body.html_url : RELEASE_PAGE,
        };
        okCache = { at: now, data };
        return data;
    }
    catch (err) {
        const msg = err?.name === 'TimeoutError' ? '请求超时' : String(err?.message || err);
        const data = { ...base, error: msg };
        failCache = { at: now, data };
        return data;
    }
}
//# sourceMappingURL=updates.js.map