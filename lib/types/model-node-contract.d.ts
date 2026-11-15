/** Exact public/request projections for the four Model Node management operations. */
export declare class ModelNodeBridgeError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string);
}
export declare const UUID: RegExp;
export type BridgeAction = 'inspect' | 'preview' | 'apply' | 'rollback';
type Obj = Record<string, unknown>;
/** No raw sidecar object/error/toJSON is ever sent to the client. */
export declare function projectModelNodeResponse(action: BridgeAction, value: unknown, pinned: string): unknown;
/** Rebuild the exact sidecar request; a URL/path/header/method cannot ride input. */
export declare function projectModelNodeRequest(action: Exclude<BridgeAction, 'inspect'>, value: unknown, pinned: string): Obj;
export {};
