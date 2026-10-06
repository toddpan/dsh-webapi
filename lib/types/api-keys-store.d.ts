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
export type ApiKeyStatus = 'active' | 'revoked';
export interface ApiKeyRecord {
    /** 记录标识（非凭证）：`ks_` + base64url，或 'cfg-legacy' */
    id: string;
    /** 名称，用于识别（可修改） */
    name: string;
    /** 备注 */
    note?: string;
    /**
     * 明文前缀，用于展示与 O(1) 定位候选。
     * 仅 managed key 有值；config 来源固定为空串（不泄露低熵密钥的任何部分）。
     */
    prefix: string;
    /** sha256(明文) 的 hex；config 来源固定为空串（不落派生物） */
    hash: string;
    /**
     * 明文的可逆密文（AES-256-GCM，密钥由管理令牌 HKDF 派生），仅 managed key 有值。
     * 用于列表页「复制」；缺失表示明文不可恢复（加密存储上线前的历史记录）。
     * 绝不返回给任何视图层，只在 reveal() 内部解开。
     */
    sealed?: string;
    /** 哈希算法位，为将来升级留迁移余地 */
    algo: 'sha256';
    createdAt: number;
    /** 最近一次鉴权成功时间 */
    lastUsedAt?: number;
    expiresAt?: number;
    status: ApiKeyStatus;
    revokedAt?: number;
    revokedReason?: 'manual' | 'rotated';
    /** managed = 页面生成；config = 由 config.apiKey 合成的只读遗留记录 */
    source: 'managed' | 'config';
    /** true = 管理员自行粘贴的 Key 值（熵取决于用户选的值） */
    custom?: boolean;
}
/** 对外只暴露脱敏视图，绝不返回 hash / 明文 */
export interface ApiKeyView {
    id: string;
    name: string;
    note?: string;
    prefix: string;
    masked: string;
    createdAt: number;
    lastUsedAt?: number;
    expiresAt?: number;
    status: ApiKeyStatus;
    /** 已过期（status 仍为 active，但已不可用） */
    expired: boolean;
    revokedAt?: number;
    revokedReason?: string;
    source: 'managed' | 'config';
    readOnly: boolean;
    /** true = 自定义 Key 值（非随机生成），页面需提示熵风险 */
    custom: boolean;
    /**
     * true = 该记录持有可解密的密文，列表页可提供「复制」。
     * 历史记录（加密存储上线前创建）为 false，只能「轮换」。
     */
    recoverable: boolean;
}
/** 输入层错误（重复 Key、非法值等）：路由层应映射为 400，而不是 503 */
export declare class ApiKeyInputError extends Error {
    readonly code: string;
    constructor(message: string, code?: string);
}
export interface CreateKeyInput {
    name?: string;
    note?: string;
    /** 从现在起多少天后过期；缺省 = 永不过期 */
    expiresInDays?: number;
    /**
     * 自定义明文 Key（粘贴已有 Key）；不传则随机生成 256 位高熵 Key。
     * 长度与字符集由路由层校验。
     */
    plaintext?: string;
}
export interface CreateKeyResult {
    view: ApiKeyView;
    /** 完整明文 Key，仅此一次返回 */
    plaintext: string;
}
/** 生成高熵 API Key 明文：`dsk_` + 32 字节 base64url */
export declare function generatePlaintextKey(): string;
/** 解析 DSH 配置根：config.dshHome → $DSH_HOME → ~/.dsh */
export declare function resolveDshHome(dshHome?: string): string;
/** 统一脱敏：对外视图 */
export declare function toView(rec: ApiKeyRecord): ApiKeyView;
export declare class ApiKeyStore {
    private readonly legacyConfigKey;
    readonly dir: string;
    readonly file: string;
    readonly adminTokenFile: string;
    private records;
    private authEnabledFlag;
    private writeQueue;
    private initPromise;
    private initDone;
    private adminTokenValue;
    /** 由管理令牌派生的封装密钥（惰性计算并缓存） */
    private sealKey;
    private lastUsedFlushAt;
    /** 读盘失败 / 文件损坏 / 初始化失败时为 true（fail-closed：一律要求鉴权） */
    degraded: boolean;
    /** 上一次降级原因的说明（供 /system/status 与页面提示，不含任何凭证） */
    degradedReason: string;
    constructor(legacyConfigKey: string, dshHome?: string);
    /** 幂等初始化；所有公开方法调用前保证已就绪 */
    ensureReady(): Promise<void>;
    init(): Promise<void>;
    private load;
    /** 解析存储文件；返回 null 表示不可用 */
    private parseStore;
    /**
     * 记录合法性：id / hash / prefix 都必须匹配形态，防止外部注入的记录
     * 把恶意字符串带进 HTML/JS 上下文（页面渲染依赖本校验）。
     */
    private isValidRecord;
    /** 把损坏文件改名保留取证，并尽量从 .bak 恢复 */
    private quarantineCorrupt;
    private readBackup;
    private markDegraded;
    /** 把 config.apiKey 归一为只读遗留记录；**不落明文、不落 hash、不落前缀** */
    private syncLegacyRecord;
    ensureAdminToken(): Promise<string>;
    /** 供 CLI/文档提示使用：仅返回存放路径，绝不返回值 */
    get adminTokenPath(): string;
    /** 封装密钥：需要管理令牌已就绪（init 中 ensureAdminToken 之后即可用） */
    private sealKeyOrNull;
    /**
     * 复制：返回某条记录的明文。
     * - `{ plaintext }`：可复制；
     * - `'unrecoverable'`：记录存在但明文不可恢复（历史记录 / 已吊销 / 密文失效）；
     * - `null`：记录不存在，或来自插件配置（只读遗留记录）。
     */
    reveal(id: string): Promise<{
        plaintext: string;
    } | 'unrecoverable' | null>;
    list(includeRevoked?: boolean): ApiKeyView[];
    get(id: string): ApiKeyRecord | undefined;
    countActive(): number;
    private effectiveStatus;
    /**
     * 是否强制数据面鉴权。
     * - config.apiKey 非空时强制开启（配置文件是权威，页面开关不能放松它）；
     * - **存储降级 / 未初始化完成时一律 fail-closed**：宁可把调用挡在门外，
     *   也不能因为一个写坏的 JSON 把已开启鉴权的部署静默变成匿名全开。
     */
    isEnforced(): boolean;
    /** 页面开关当前值（考虑 config 回落） */
    getAuthEnabled(): boolean;
    /** config.apiKey 是否强制开启了鉴权（页面据此禁用关闭按钮） */
    get legacyEnforced(): boolean;
    /**
     * 数据面 token 校验：多 Key ∪ 遗留 Key。
     * - 遗留 Key 不落派生物，这里做内存常量时间直比；
     * - managed key 走 prefix 定位 + sha256 + timingSafeEqual。
     */
    verifyDataToken(token: string): {
        ok: boolean;
        keyId?: string;
    };
    /** 管理面 token 校验 */
    verifyAdminToken(token: string): boolean;
    /** 记录最近使用时间（节流落盘，避免每次请求都写盘） */
    touch(keyId: string): void;
    /**
     * 在副本上执行变更，落盘成功才提交到内存；落盘失败则回滚并抛出，
     * 保证「响应所说的状态」与「实际生效的鉴权状态」始终一致。
     */
    private mutate;
    create(input: CreateKeyInput): Promise<CreateKeyResult>;
    update(id: string, patch: {
        name?: string;
        note?: string;
        expiresAt?: number | null;
    }): Promise<ApiKeyView | null>;
    /** 轮换：生成新 Key 并把旧记录标记为 revoked/'rotated' */
    rotate(id: string): Promise<CreateKeyResult | null>;
    /** 吊销（幂等）；config 来源的遗留记录不可吊销 */
    revoke(id: string): Promise<ApiKeyView | null>;
    /**
     * 删除记录：仅限「已吊销」的 managed key（清理审计残留，不影响任何有效凭证）。
     * 返回 null 表示 Key 不存在、来自 config 或仍处于有效状态——不可删除。
     */
    remove(id: string): Promise<ApiKeyView | null>;
    setAuthEnabled(enabled: boolean): Promise<void>;
    /**
     * 原子写：写 tmp（0600，wx）→ rename 覆盖主文件 → 复制一份「最后已知良好状态」到 .bak。
     * tmp+rename 保证主文件不会出现半截内容；.bak 用于抵御主文件被外部写坏（手工编辑/磁盘故障）。
     * 进程内写队列串行化读-改-写。
     */
    private persist;
}
/** 按 IP 的滑动窗口失败计数（内存态，进程重启即清零） */
export declare class FailureRateLimiter {
    private readonly limit;
    private readonly windowMs;
    private hits;
    constructor(limit: number, windowMs: number);
    /** 当前是否已超限（超限时调用方应直接拒绝，不做任何校验） */
    isLimited(key: string): boolean;
    /** 记一次失败；返回 true 表示已超限 */
    record(key: string): boolean;
    private prune;
}
