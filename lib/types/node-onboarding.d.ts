import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { ApiKeyStore } from './api-keys-store.js';
import { HttpRouter } from './router.js';
import type { WebServiceConfig } from './types.js';
import { NodeRuntime } from './node-runtime.js';
import { OnenatTunnel, type OnenatTunnelSettings } from './onenat-tunnel.js';
import { WorkBuddyAccount, type WorkBuddyLogin } from './workbuddy-account.js';
export interface NodeOnboardingOptions {
    getLocalPort(): number;
    getMainPort(): number;
    startService(): Promise<{
        ok: true;
        message: string;
    } | {
        ok: false;
        error: string;
    }>;
}
/** Test seams; production always uses the real tunnel, node runtime and account session. */
export interface NodeOnboardingDependencies {
    tunnel?: OnenatTunnel;
    runtime?: NodeRuntime;
    account?: WorkBuddyAccount;
}
/** Separate from API Keys: consuming a pairing ticket cannot mint or reveal a data key. */
export declare class NodeOnboarding {
    private readonly ctx;
    private readonly config;
    private readonly keys;
    private readonly options;
    readonly tunnel: OnenatTunnel;
    readonly runtime: NodeRuntime;
    readonly account: WorkBuddyAccount;
    private remoteStatusTimer?;
    private queue;
    private lastError;
    private closed;
    private readonly setupToken;
    private readonly dir;
    /** 工作区目录覆盖：default 跟随 DSH 注册表；custom 使用用户保存的目录列表。 */
    private workspace;
    private readonly workspaceReady;
    private loadWorkspace;
    private writeWorkspace;
    constructor(ctx: Context, config: WebServiceConfig, keys: ApiKeyStore, options: NodeOnboardingOptions, dependencies?: NodeOnboardingDependencies);
    private defaultRoots;
    private roots;
    private managedKey;
    private serial;
    handle(req: IncomingMessage, res: ServerResponse): boolean;
    /** Only the local, unmapped DSH GUI may obtain a node-setup token. */
    private localGui;
    localSetupToken(req: IncomingMessage): string | undefined;
    localSetupAuthorized(req: IncomingMessage): boolean;
    status(): Promise<unknown>;
    /** 保存工作区目录覆盖；已绑定时后台重跑绑定流程，让 WorkBuddy 看到新目录。 */
    saveWorkspace(input: {
        mode?: unknown;
        roots?: unknown;
    }): Promise<unknown>;
    forgetPassword(): Promise<unknown>;
    /** 本机目录浏览：供设置页的工作区目录选择器逐级进入（只列子目录，不读文件内容）。 */
    listDirectories(requestUrl?: string): Promise<unknown>;
    checkOnenatUpdate(): Promise<{
        installed: boolean;
        current: string;
        latest: string;
        updateAvailable: boolean;
    }>;
    upgradeOnenat(force: boolean): Promise<unknown>;
    /** 手动下载/安装 ONENAT 客户端：不要求已配置隧道（Windows 预装/排障用），进度经 tunnel.installProgress 透出。 */
    installOnenatClient(options?: {
        force?: boolean;
    }): Promise<unknown>;
    onenatLogs(): Promise<{
        lines: string[];
    }>;
    private refreshRemote;
    private monitorRemote;
    /** Account login is the only human action; one-time pairing happens inside this operation. */
    loginAndBind(input?: WorkBuddyLogin): Promise<unknown>;
    connect(settings?: OnenatTunnelSettings): Promise<unknown>;
    stop(): Promise<unknown>;
    /** Restart restores transport and pinned identity, but never creates a fresh pairing ticket. */
    restore(): Promise<void>;
    close(): Promise<void>;
}
export declare function registerNodeOnboardingRoutes(router: HttpRouter, config: WebServiceConfig, keys: ApiKeyStore, node: NodeOnboarding): void;
