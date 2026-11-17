import { type ChildProcess } from 'node:child_process';
export type OnenatProtocol = 'https' | 'tcp';
export interface OnenatTunnelSettings {
    serverUrl: string;
    username: string;
    password: string;
    name: string;
    subdomain?: string;
    remotePort?: number;
    protocol?: OnenatProtocol;
    autoStart?: boolean;
}
export interface OnenatManagedInput {
    config: string;
    clientId: string;
    mappingId: string;
    tunnelId: string;
    serverUrl?: string;
    name?: string;
    protocol?: OnenatProtocol;
    subdomain?: string;
    remotePort?: number;
    autoStart?: boolean;
}
export interface OnenatInstallProgress {
    phase: 'resolving' | 'checksums' | 'downloading' | 'verifying' | 'installing' | 'done';
    message: string;
    startedAt: number;
    bytesDone?: number;
    bytesTotal?: number;
    percent?: number;
    attempt?: number;
}
export interface OnenatRemoteState {
    online?: boolean;
    public_url?: string;
    error?: string;
}
export interface OnenatTunnelState {
    configured: boolean;
    /** true when the WorkBuddy account flow supplies a managed, credential-scoped tunnel. */
    managed: boolean;
    installed: boolean;
    running: boolean;
    phase: 'stopped' | 'installing' | 'connecting' | 'online' | 'error';
    clientId: string;
    serverUrl: string;
    name: string;
    protocol: OnenatProtocol;
    subdomain: string;
    remotePort: number;
    localPort: number;
    tunnelId?: string;
    mappingId?: string;
    publicUrl?: string;
    origin?: string;
    error?: string;
    releaseTag?: string;
    startedAt?: number;
    restarts: number;
    binaryPath?: string;
    installProgress?: OnenatInstallProgress;
    settings: Omit<OnenatTunnelSettings, 'password'> & {
        passwordSet: boolean;
    };
}
export interface OnenatTunnelOptions {
    dir: string;
    onLocalPort: () => number;
    log?: (message: string) => void;
    /** Dependency injection for isolated HTTP/process tests. */
    fetch?: typeof globalThis.fetch;
    spawnClient?: (binary: string, args: string[]) => ChildProcess;
    platform?: string;
    arch?: string;
}
/** Asset names match ONENAT's Makefile release-clients and GitHub Releases. */
export declare function onenatReleaseAsset(platform?: string, arch?: string): string;
/** 比较 v1.2.3 / r2026.11.16 形态的 release tag；解析失败的一方视为更旧（宁可漏报升级也不误报），预发布排在正式版之前。 */
export declare function compareVersionTags(a: string, b: string): number;
export declare function installOnenatClient(options: Pick<OnenatTunnelOptions, 'dir' | 'fetch' | 'platform' | 'arch'> & {
    refresh?: boolean;
    onProgress?: (progress: OnenatInstallProgress) => void;
}): Promise<{
    binary: string;
    releaseTag: string;
}>;
/** Owns the binary, credentials/config and the child process behind one small interface. */
export declare class OnenatTunnel {
    private readonly opts;
    private readonly fetcher;
    private readonly ready;
    private readonly file;
    private readonly configFile;
    private saved;
    private child?;
    private binary?;
    private releaseTag?;
    private installProgress?;
    private startedAt?;
    private restarts;
    private readonly logs;
    private phase;
    private lastError?;
    private publicUrl?;
    private origin?;
    private cookie?;
    private operation;
    private restart?;
    private stopped;
    private closed;
    private retries;
    constructor(options: OnenatTunnelOptions);
    private load;
    private save;
    private enqueue;
    private sanitize;
    private fail;
    private view;
    status(): Promise<OnenatTunnelState>;
    private install;
    private terminate;
    /** 环形日志缓冲：供设置页 oneNat 客户端 TAB 展示最近输出。 */
    private pushLog;
    tailLogs(limit?: number): string[];
    checkUpdate(): Promise<{
        installed: boolean;
        current: string;
        latest: string;
        updateAvailable: boolean;
    }>;
    /** 升级 = 强制重新安装最新 release；校验通过前旧二进制不动，失败时原进程照常恢复。 */
    upgrade(options?: {
        force?: boolean;
    }): Promise<OnenatTunnelState & {
        noop?: boolean;
        message?: string;
    }>;
    private launch;
    /** The normal WorkBuddy flow: its backend provisions ONENAT; no ONENAT login reaches this plugin. */
    startManaged(input: OnenatManagedInput): Promise<OnenatTunnelState>;
    /** Update with authoritative WorkBuddy-proxied ONENAT runtime status. Never synthesize an online URL. */
    updateRemoteState(input: OnenatRemoteState): Promise<OnenatTunnelState>;
    /** Advanced direct-ONENAT fallback, not needed by the WorkBuddy account flow. */
    ensure(settings: OnenatTunnelSettings): Promise<OnenatTunnelState>;
    private login;
    private api;
    start(settings?: OnenatTunnelSettings): Promise<OnenatTunnelState>;
    stop(): Promise<OnenatTunnelState>;
    close(): Promise<void>;
}
