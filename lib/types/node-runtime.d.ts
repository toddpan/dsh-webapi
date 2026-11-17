import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiKeyStore } from './api-keys-store.js';
import * as protocol from '../vendor/security-node/node-security.js';
export interface NodeRuntimeOptions {
    /** Private, persistent directory outside every exported workspace root. */
    dir: string;
    keyStore: ApiKeyStore;
    /** Exact registered roots; the caller supplies defaultCwd/process.cwd() fallback. */
    getRoots: () => Promise<string[]> | string[];
    /** Public DSH API URL and a non-expiring, randomly generated managed API key. */
    getDshRef: () => Promise<any>;
    /**
     * 以 root 运行安全节点（默认 false，preflight 显式拒绝）。uid 归属校验在 root 下失去
     * 隔离意义，仅保留路径范围防线；仅限 DSH 宿主本身即 root 的单用户机器显式开启。
     */
    allowRoot?: boolean;
}
export interface NodePairing {
    pairingCode: string;
    expiresAt: number;
    nodeId: string;
    name: string;
}
export interface NodeRuntimeStatus {
    nodeId?: string;
    name: string;
    running: boolean;
    roots: string[];
    publicKey?: string;
    keyId?: string;
    instanceId?: string;
    isolation?: protocol.NodeIsolation;
    platform: string;
    error?: string;
    errorCode?: string;
}
export declare class NodeRuntimeError extends Error {
    readonly code: string;
    constructor(code: string);
}
/**
 * Owns identity/state and the existing security runtime, including its Python broker.
 * All public mutations serialize; close is terminal. No DSH fallback or host tools.
 */
export declare class NodeRuntime {
    private readonly options;
    readonly dir: string;
    private readonly stateDir;
    private readonly identityFile;
    private readonly metadataFile;
    private queue;
    private closed;
    private preflightDone;
    private metadata?;
    private runtime?;
    private config?;
    private roots;
    private lastError?;
    private readonly responses;
    constructor(options: NodeRuntimeOptions);
    private serial;
    private preflight;
    private identity;
    private readRoots;
    private stop;
    private prepareInternal;
    /** Idempotent startup. Reconciles exact roots and restarts if the registry changes. */
    prepare(): Promise<void>;
    /** Called before API-key/CORS middleware; the security runtime owns the entire /v1/ protocol. */
    handle(req: IncomingMessage, res: ServerResponse): boolean;
    status(): NodeRuntimeStatus;
    private dshReference;
    createPairing(): Promise<NodePairing>;
    /** Stop transport/broker without discarding identity; prepare can resume it. */
    pause(): Promise<void>;
    /** Destroy forwarded responses, close the loopback listener and await broker exit. */
    close(): Promise<void>;
}
