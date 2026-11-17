export interface WorkBuddyLogin {
    serverUrl: string;
    username: string;
    password: string;
    name?: string;
    /** 勾选记住密码后以密封密文（AES-256-GCM，密钥派生自管理令牌）落盘；明文密码永不落盘。 */
    rememberPassword?: boolean;
}
/** 由 ApiKeyStore 提供（sealCredential/openCredential）；未注入时记住密码不可用。 */
export interface WorkBuddySeal {
    seal(plaintext: string): string | null;
    open(sealed: string): string | null;
}
export declare function workBuddyServerUrl(input: unknown): string;
export declare class WorkBuddyAccount {
    private readonly dir;
    private readonly crypto?;
    private record?;
    private loaded;
    private relogin?;
    private readonly file;
    constructor(dir: string, crypto?: WorkBuddySeal | undefined);
    private load;
    private save;
    status(): Promise<{
        configured: boolean;
        serverUrl: string;
        username: string;
        nodeId?: string;
        name?: string;
        passwordSaved: boolean;
    }>;
    private performLogin;
    login(input: WorkBuddyLogin): Promise<void>;
    private json;
    /** 会话过期时的自动重登：仅当用户勾选过记住密码；并发 401 共享同一次重登。 */
    private reloginOnce;
    private request;
    call<T = any>(endpoint: string, body?: unknown): Promise<T>;
    bound(nodeId: string): Promise<void>;
    /** 清除已记住的密码（密文一并删除；会话 cookie 保留）。 */
    forgetPassword(): Promise<void>;
}
