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
/** 独立服务监听范围：仅这两个值（校验在 normalizeBindIp） */
export type BindIp = '127.0.0.1' | '0.0.0.0';
export declare const BIND_IP_LOOPBACK: BindIp;
export declare const BIND_IP_ALL: BindIp;
/** 首次启动自动分配端口时优先尝试的起始端口（31800-31899，避开常见开发端口） */
export declare const DEFAULT_PORT = 31800;
/** 自动分配端口的扫描长度；全部占用时回退系统临时端口 */
export declare const PORT_SCAN_LIMIT = 100;
/** bindIp 合法值校验：仅 '127.0.0.1' / '0.0.0.0'（容忍首尾空白）；非法返回 null */
export declare function normalizeBindIp(v: unknown): BindIp | null;
export interface ServiceSettings {
    /** 监听端口；0 = 尚未分配（首次启动自动分配） */
    port: number;
    /** 监听范围；默认 127.0.0.1 */
    bindIp: BindIp;
    /** 期望运行状态：true = 随 DSH 启动自动拉起 */
    autoStart: boolean;
    updatedAt?: number;
}
/** 设置补丁（只写提供的字段，未提供字段保持原值） */
export interface ServiceSettingsPatch {
    port?: number;
    bindIp?: BindIp;
    autoStart?: boolean;
}
export interface ServiceSettingsStoreOptions {
    dshHome?: string;
}
/** 独立 API 服务状态（设置页与 GET /api-keys/service 共用） */
export interface ServiceState {
    /** 当前是否在监听 */
    running: boolean;
    /** 配置端口（0 = 尚未分配） */
    port: number;
    /** 配置的监听范围 */
    bindIp: BindIp;
    /** 实际监听端口；未运行时为 0（自动分配后与 port 一致） */
    listeningPort: number;
    /** DSH 主 webserver 端口（随启动变化，仅作对照） */
    mainPort: number;
    /** 本机局域网 IPv4（非回环、去重） */
    lanIps: string[];
    /** 运行中时可直接访问的服务地址（含 /api/v1 前缀）；未运行时为空数组 */
    urls: string[];
    /** 是否暴露到局域网（运行中且监听 0.0.0.0） */
    exposedToLan: boolean;
    /** 期望运行状态：false 表示用户主动停止，重载插件后不会自动启动 */
    autoStart: boolean;
    /** 最近一次启动失败原因（如端口被占用） */
    error?: string;
}
export declare class ServiceSettingsStore {
    readonly file: string;
    private cache;
    private writeQueue;
    constructor(options?: ServiceSettingsStoreOptions);
    /** 读当前设置（文件缺失/损坏按「首次安装」处理，绝不抛错阻塞启动） */
    get(): Promise<ServiceSettings>;
    /** 同步视图：启动路径已 get() 过后使用（未加载过时返回默认值） */
    peek(): ServiceSettings;
    /**
     * 补丁式保存：只写提供的字段，未提供字段保持原值。
     * 非法值按「不修改」处理（端口非法保持原值，bindIp 非法保持原值）。
     */
    set(patch: ServiceSettingsPatch): Promise<ServiceSettings>;
    private persist;
}
/** 端口合法性：0（未分配）或 1024-65535（<1024 需特权，DSH 以普通用户运行必失败） */
export declare function normalizePort(v: unknown): boolean;
