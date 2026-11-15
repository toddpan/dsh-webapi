import type { Context } from '@deepseek-ai/cordis';
import type { ApiKeyStore } from './api-keys-store.js';
import { HttpRouter } from './router.js';
import type { WebServiceConfig } from './types.js';
export interface NativeRevision {
    instanceId: string;
    namespace: string;
    revision: number;
    fingerprint: string;
}
export declare function registerNativeModelConfigRoutes(ctx: Context, router: HttpRouter, config: WebServiceConfig, store: ApiKeyStore): void;
