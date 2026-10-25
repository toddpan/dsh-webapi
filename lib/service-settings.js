/**
 * dsh-web-service - 独立 API 服务设置（端口 / 监听范围 / 期望运行状态）
 *
 * 设置与 API Key 一样属于插件自身数据，落在 <dshHome>/dsh-web-service/service-settings.json，
 * 与 api-keys.json 同目录、同持久化约定：单文件 JSON + 内存缓存 + 原子替换（tmp + rename，0600）。
 *
 * 为什么不写回 cordis 配置：cordis.patch.yml 由 profile 加载器拥有，插件运行期改写
 * 会在下次加载被覆盖，也污染用户的补丁层。
 *
 * 语义（v0.5.0 起）：
 *   - port：监听端口。0 = 尚未分配，首次启动时自动分配一个空闲端口并落盘。
 *   - bindIp：监听范围。127.0.0.1（默认，仅本机）或 0.0.0.0（局域网可达）。
 *   - autoStart：期望运行状态。true = DSH 启动时自动拉起服务；false = 用户主动停止，
 *     下次启动保持停止（端口与监听范围仍保留，一键即可重新启动）。
 *
 * 兼容旧版持久化：旧文件只有 { fixedPort, bindIp }，读取时迁移为
 *   port = fixedPort、autoStart = fixedPort > 0（旧语义正是「有固定端口就自动监听」）。
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveDshHome } from './api-keys-store.js';
export const BIND_IP_LOOPBACK = '127.0.0.1';
export const BIND_IP_ALL = '0.0.0.0';
/** 首次启动自动分配端口时优先尝试的起始端口（31800-31899，避开常见开发端口） */
export const DEFAULT_PORT = 31800;
/** 自动分配端口的扫描长度；全部占用时回退系统临时端口 */
export const PORT_SCAN_LIMIT = 100;
/** bindIp 合法值校验：仅 '127.0.0.1' / '0.0.0.0'（容忍首尾空白）；非法返回 null */
export function normalizeBindIp(v) {
    if (typeof v !== 'string')
        return null;
    const s = v.trim();
    if (s === BIND_IP_LOOPBACK || s === BIND_IP_ALL)
        return s;
    return null;
}
export class ServiceSettingsStore {
    file;
    cache;
    writeQueue = Promise.resolve();
    constructor(options = {}) {
        const dir = path.join(resolveDshHome(options.dshHome), 'dsh-web-service');
        this.file = path.join(dir, 'service-settings.json');
    }
    /** 读当前设置（文件缺失/损坏按「首次安装」处理，绝不抛错阻塞启动） */
    async get() {
        if (this.cache)
            return this.cache;
        let parsed;
        try {
            const raw = await readFile(this.file, 'utf8');
            const json = JSON.parse(raw);
            if (json && typeof json === 'object') {
                parsed = migrate(json);
            }
        }
        catch {
            /* 缺失或损坏都按首次安装处理 */
        }
        this.cache = parsed || { port: 0, bindIp: BIND_IP_LOOPBACK, autoStart: true };
        return this.cache;
    }
    /** 同步视图：启动路径已 get() 过后使用（未加载过时返回默认值） */
    peek() {
        return this.cache || { port: 0, bindIp: BIND_IP_LOOPBACK, autoStart: true };
    }
    /**
     * 补丁式保存：只写提供的字段，未提供字段保持原值。
     * 非法值按「不修改」处理（端口非法保持原值，bindIp 非法保持原值）。
     */
    async set(patch) {
        const cur = this.peek();
        const next = { ...cur };
        if (patch.port !== undefined && normalizePort(patch.port))
            next.port = patch.port;
        if (patch.bindIp !== undefined) {
            const bindIp = normalizeBindIp(patch.bindIp);
            if (bindIp)
                next.bindIp = bindIp;
        }
        if (patch.autoStart !== undefined)
            next.autoStart = patch.autoStart === true;
        next.updatedAt = Date.now();
        // 串行化读-改-写：并发提交时按到达顺序落盘，后写胜出与内存 cache 一致
        const run = this.writeQueue.then(() => this.persist(next));
        this.writeQueue = run.then(() => undefined, () => undefined);
        await run;
        this.cache = next;
        return next;
    }
    async persist(next) {
        const dir = path.dirname(this.file);
        const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(tmp, this.file);
        await chmod(this.file, 0o600).catch(() => undefined);
    }
}
/** 旧文件迁移：{ fixedPort, bindIp } → { port, bindIp, autoStart }；非法值归一 */
function migrate(json) {
    const bindIp = normalizeBindIp(json.bindIp) || BIND_IP_LOOPBACK;
    const rawPort = typeof json.port === 'number' ? json.port : json.fixedPort;
    const port = normalizePort(rawPort) ? Number(rawPort) : 0;
    // 旧语义：有固定端口 = 期望自动监听；旧文件 fixedPort=0 视为用户关闭过
    const legacy = 'fixedPort' in json && !('autoStart' in json);
    const autoStart = typeof json.autoStart === 'boolean' ? json.autoStart : legacy ? port > 0 : true;
    return { port, bindIp, autoStart };
}
/** 端口合法性：0（未分配）或 1024-65535（<1024 需特权，DSH 以普通用户运行必失败） */
export function normalizePort(v) {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isInteger(n) && (n === 0 || (n >= 1024 && n <= 65535));
}
//# sourceMappingURL=service-settings.js.map