/**
 * Isolated node protocol v1. No legacy DSH fallback and no management credentials.
 * Trust (nodeId + SPKI key + deployment profile) is provisioned out of band.
 * A route/ONENAT mapping is only a locator and can change without changing this pin.
 *
 * POST /v1/identity { nonce } -> Signed<NodeIdentity>
 * POST /v1/{files/read,files/list,files/write,leases/open,leases/renew,leases/revoke,
 *           executions/start,executions/status,executions/stop} -> Signed<NodeReply<T>>
 * All authenticated requests are NodeRequest, all responses bind the entire request.
 * Time values are Unix milliseconds. Paths are canonical relative POSIX paths;
 * '.' means the workspace root, never an absolute host path. Write CAS uses null
 * for create-only, or the exact SHA-256 returned by read for overwrite.
 *
 * Issuance/renewal belongs in the authoritative platform transaction after checking
 * the original user/credential/object/grants. This client never decides those ACLs.
 */
import { type KeyObject } from 'node:crypto';
export declare const NODE_SECURITY_PROTOCOL: "workbuddy.node-security/1";
export declare const NODE_CAPABILITY_MAX_MS = 60000;
export declare const NODE_LEASE_MAX_MS = 15000;
/** Conservative issuer backdating; verification still rejects claims >1s in the future. */
export declare const NODE_CLOCK_SKEW_MS = 1000;
export type NodeAction = 'file.read' | 'file.list' | 'file.write' | 'lease.open' | 'lease.renew' | 'lease.revoke' | 'execution.start' | 'execution.status' | 'execution.stop';
export type NodeEndpoint = 'files/read' | 'files/list' | 'files/write' | 'leases/open' | 'leases/renew' | 'leases/revoke' | 'executions/start' | 'executions/status' | 'executions/stop';
export interface NodeScope {
    nodeId: string;
    workspaceId: string;
    userId: string;
    credentialId: string;
    credentialVersion: number;
    taskId: string;
    projectId?: string;
    groupId?: string;
    policyVersion: number;
    paths: string[];
    actions: NodeAction[];
}
export interface NodeCapabilityClaims extends NodeScope {
    protocol: typeof NODE_SECURITY_PROTOCOL;
    issuerKeyId: string;
    nodeInstanceId: string;
    holderPublicKey: string;
    operationId: string;
    leaseId: string;
    issuedAt: number;
    expiresAt: number;
}
export interface NodeSigned<T> {
    value: T;
    signature: string;
}
export type NodeCapability = NodeSigned<NodeCapabilityClaims>;
export interface NodeRequest {
    protocol: typeof NODE_SECURITY_PROTOCOL;
    requestId: string;
    nonce: string;
    endpoint: NodeEndpoint;
    capability: NodeCapability;
    payload: Record<string, unknown>;
    proof: string;
}
export interface NodeIsolation {
    available: boolean;
    profile: 'linux-bwrap-snapshot-v1' | 'unavailable';
    reason?: string;
    probe?: {
        checkedAt: number;
        digest: string;
        checks: string[];
    };
    workspace: 'scoped-read-only-snapshot';
    network: 'none';
    limits: {
        leaseMs: number;
        fileBytes: number;
        outputBytes: number;
        processes: number;
    };
}
export interface NodeIdentity {
    protocol: typeof NODE_SECURITY_PROTOCOL;
    nodeId: string;
    keyId: string;
    publicKey: string;
    nonce: string;
    issuedAt: number;
    expiresAt: number;
    instanceId: string;
    isolation: NodeIsolation;
    workspaces: {
        workspaceId: string;
        policyVersion: number;
    }[];
}
export interface NodeReply<T> {
    protocol: typeof NODE_SECURITY_PROTOCOL;
    nodeId: string;
    instanceId: string;
    requestId: string;
    requestHash: string;
    issuedAt: number;
    expiresAt: number;
    ok: boolean;
    result?: T;
    error?: {
        code: string;
    };
}
export interface NodeLease {
    leaseId: string;
    expiresAt: number;
}
export interface NodeFile {
    path: string;
    contentBase64: string;
    sha256: string;
    size: number;
}
export interface NodeFileEntry {
    name: string;
    type: 'file' | 'directory';
    size: number;
}
export interface NodeExecution {
    executionId: string;
    state: 'running' | 'exited' | 'stopped';
    exitCode: number | null;
    stdout: string;
    stderr: string;
    reason?: string;
}
export interface NodeSecurityPin {
    nodeId: string;
    publicKey: string;
}
export declare class NodeSecurityError extends Error {
    readonly code: string;
    readonly status?: number;
    constructor(code: string);
}
/** Restricted deterministic JSON, shared with the standalone service. */
export declare function nodeCanonical(value: unknown): string;
export declare function nodeHash(value: unknown): string;
export declare function nodeKeyId(key: string | KeyObject): string;
export declare function signNodeValue<T>(domain: string, value: T, key: string | KeyObject): NodeSigned<T>;
export declare function verifyNodeValue<T>(domain: string, signed: NodeSigned<T>, key: string | KeyObject): T;
export declare function nodeRelativePath(path: string): string;
export declare function issueNodeCapability(claims: NodeCapabilityClaims, issuerPrivateKey: string | KeyObject): NodeCapability;
export declare function validateNodeClaims(c: NodeCapabilityClaims, now?: number): void;
export declare function makeNodeRequest(endpoint: NodeEndpoint, capability: NodeCapability, payload: Record<string, unknown>, holderKey: string | KeyObject): NodeRequest;
export interface NodeSecurityClientOptions {
    baseUrl: string;
    pin: NodeSecurityPin;
    /** Only for explicit loopback tests. Remote deployment needs HTTPS or an authenticated encrypted tunnel. */
    allowLoopbackHttp?: boolean;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    clock?: () => number;
}
export declare class NodeSecurityClient {
    private readonly options;
    constructor(options: NodeSecurityClientOptions);
    private now;
    private post;
    private freshness;
    identity(): Promise<NodeIdentity>;
    /** Node-local pairing or issuer-authenticated directory discovery; never executes host code. */
    control<T>(endpoint: 'pair' | 'catalog/resolve' | 'agents/invoke', payload: Record<string, unknown>, issuerPrivateKey: string): Promise<T>;
    /** Retain the returned request to retry exactly after a lost response; never reuse its operationId for different content. */
    prepare(endpoint: NodeEndpoint, capability: NodeCapability, payload: Record<string, unknown>, holderKey: string | KeyObject): NodeRequest;
    send<T>(request: NodeRequest): Promise<T>;
    call<T>(endpoint: NodeEndpoint, capability: NodeCapability, payload: Record<string, unknown>, holderKey: string | KeyObject): Promise<T>;
    openLease(cap: NodeCapability, key: string | KeyObject, ttlMs?: number): Promise<NodeLease>;
    renewLease(cap: NodeCapability, key: string | KeyObject, ttlMs?: number): Promise<NodeLease>;
    revokeLease(cap: NodeCapability, key: string | KeyObject): Promise<{
        revoked: true;
    }>;
    read(cap: NodeCapability, key: string | KeyObject, path: string): Promise<NodeFile>;
    list(cap: NodeCapability, key: string | KeyObject, path?: string): Promise<{
        entries: NodeFileEntry[];
    }>;
    write(cap: NodeCapability, key: string | KeyObject, path: string, content: Uint8Array, expectedSha256: string | null): Promise<{
        sha256: string;
        size: number;
    }>;
    start(cap: NodeCapability, key: string | KeyObject, argv: string[]): Promise<{
        executionId: string;
    }>;
    status(cap: NodeCapability, key: string | KeyObject, executionId: string): Promise<NodeExecution>;
    stop(cap: NodeCapability, key: string | KeyObject, executionId: string): Promise<NodeExecution>;
}
