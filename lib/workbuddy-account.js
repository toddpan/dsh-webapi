/** WorkBuddy account session remains on the node; only non-secret status reaches the settings UI. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
export function workBuddyServerUrl(input) {
    if (typeof input !== 'string' || input.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(input))
        throw new Error('WorkBuddy 地址无效');
    const url = new URL(input);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || url.protocol === 'http:' && local) || url.username || url.password || url.search || url.hash) {
        throw new Error('WorkBuddy 地址需要 HTTPS；本机测试可使用回环 HTTP 地址');
    }
    return url.href.replace(/\/+$/, '');
}
export class WorkBuddyAccount {
    dir;
    crypto;
    record;
    loaded = false;
    relogin;
    file;
    constructor(dir, crypto) {
        this.dir = dir;
        this.crypto = crypto;
        this.file = path.join(dir, 'workbuddy-account.json');
    }
    async load() {
        if (this.loaded)
            return;
        try {
            const data = JSON.parse(await readFile(this.file, 'utf8'));
            if (typeof data.username !== 'string' || typeof data.cookie !== 'string' || !/^wb_session=[a-f0-9]{64}$/.test(data.cookie))
                throw new Error();
            if (data.passwordSealed !== undefined && typeof data.passwordSealed !== 'string')
                delete data.passwordSealed;
            this.record = { ...data, serverUrl: workBuddyServerUrl(data.serverUrl) };
        }
        catch (err) {
            if (err.code !== 'ENOENT')
                throw new Error('WorkBuddy 登录记录无效，请重新登录');
        }
        this.loaded = true;
    }
    async save() {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        const tmp = this.file + '.' + randomBytes(6).toString('hex');
        await writeFile(tmp, JSON.stringify(this.record), { mode: 0o600 });
        await rename(tmp, this.file);
    }
    async status() {
        await this.load();
        return { configured: !!this.record, serverUrl: this.record?.serverUrl || '', username: this.record?.username || '',
            passwordSaved: !!this.record?.passwordSealed,
            ...(this.record?.nodeId ? { nodeId: this.record.nodeId } : {}), ...(this.record?.name ? { name: this.record.name } : {}) };
    }
    async performLogin(serverUrl, username, password) {
        const response = await fetch(serverUrl + '/api/auth/login', { method: 'POST', redirect: 'error',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
            signal: AbortSignal.timeout(30_000) });
        const body = await this.json(response);
        const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).find(value => /^wb_session=[a-f0-9]{64}$/.test(value));
        if (!cookie || !body.ok)
            throw new Error('WorkBuddy 登录失败，请检查账号和密码');
        return { cookie, username: body.data?.username || username };
    }
    async login(input) {
        const serverUrl = workBuddyServerUrl(input.serverUrl);
        if (typeof input.username !== 'string' || !input.username.trim() || input.username.length > 320
            || typeof input.password !== 'string' || !input.password || input.password.length > 4096)
            throw new Error('请填写 WorkBuddy 账号和密码');
        const session = await this.performLogin(serverUrl, input.username.trim(), input.password);
        // 未勾选（或密封不可用）时 fresh record 自带「清除已记住密码」的语义
        const passwordSealed = input.rememberPassword && this.crypto ? this.crypto.seal(input.password) ?? undefined : undefined;
        this.record = { serverUrl, username: session.username, cookie: session.cookie, name: input.name?.trim(),
            ...(passwordSealed ? { passwordSealed } : {}) };
        this.loaded = true;
        await this.save();
    }
    async json(response) {
        const text = await response.text();
        if (text.length > 256 * 1024)
            throw new Error('WorkBuddy 返回的响应过大');
        let data;
        try {
            data = JSON.parse(text);
        }
        catch {
            throw new Error('WorkBuddy 接口不可用，请检查服务地址及后台版本');
        }
        if (!response.ok || !data.ok)
            throw Object.assign(new Error(response.status === 401 ? 'WorkBuddy 登录已过期，请重新登录' : data.error || 'WorkBuddy 节点接入失败'), { code: data.code, status: response.status });
        return data;
    }
    /** 会话过期时的自动重登：仅当用户勾选过记住密码；并发 401 共享同一次重登。 */
    async reloginOnce() {
        this.relogin ??= (async () => {
            const record = this.record;
            if (!record?.passwordSealed)
                return;
            if (!this.crypto) {
                delete record.passwordSealed;
                await this.save();
                return;
            }
            try {
                const password = this.crypto.open(record.passwordSealed);
                if (!password)
                    throw new Error('已记住的密码无法解密（管理令牌可能已重建），请重新登录');
                const session = await this.performLogin(record.serverUrl, record.username, password);
                record.cookie = session.cookie;
                await this.save();
            }
            catch (err) {
                const message = err.message || '';
                // 密文失效或记住的密码已被用户改掉：留着只会每次 401 都重试，直接清除
                if (err.status === 401 || /已记住的密码无法解密/.test(message)) {
                    delete record.passwordSealed;
                    await this.save().catch(() => { });
                }
                throw /已记住的密码|登录失败/.test(message) ? err : new Error('自动重新登录失败：' + message);
            }
        })();
        try {
            await this.relogin;
        }
        finally {
            this.relogin = undefined;
        }
    }
    request(endpoint, body) {
        return fetch(this.record.serverUrl + '/api/me/node-onboarding/' + endpoint, {
            method: body === undefined ? 'GET' : 'POST', redirect: 'error',
            headers: { cookie: this.record.cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40_000)
        });
    }
    async call(endpoint, body) {
        await this.load();
        if (!this.record)
            throw new Error('请先登录 WorkBuddy 账号');
        let response = await this.request(endpoint, body);
        if (response.status === 401) {
            await this.reloginOnce();
            response = await this.request(endpoint, body);
        }
        return (await this.json(response)).data;
    }
    async bound(nodeId) {
        await this.load();
        if (this.record) {
            this.record.nodeId = nodeId;
            await this.save();
        }
    }
    /** 清除已记住的密码（密文一并删除；会话 cookie 保留）。 */
    async forgetPassword() {
        await this.load();
        if (this.record?.passwordSealed) {
            delete this.record.passwordSealed;
            await this.save();
        }
    }
}
//# sourceMappingURL=workbuddy-account.js.map