/**
 * Administrator-only, read-only model configuration inspection.
 *
 * P0 deliberately does not wrap the unconditional /models/default writer or
 * expose settings/credentials/provider editing. A host settings revision alone
 * is not evidence of durable compare-and-set across native editors or restarts.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ApiKeyStore } from './api-keys-store.js';
import { HttpRouter } from './router.js';
import type { DefaultModelSelection, WebServiceConfig } from './types.js';
export declare const modelConfigInstanceId: `${string}-${string}-${string}-${string}-${string}`;
export interface ModelConfigModel {
    provider: string;
    id: string;
    name: string;
    isDefault: boolean;
    /** A provider route, NOT a verified model id or a Codex router capability. */
    routeOnly?: true;
}
export interface ModelConfigInspection {
    version: 1;
    runtime: 'dsh';
    instanceId: string;
    supported: true;
    source: 'node-manager';
    capabilities: {
        inspect: true;
        preview: false;
        apply: false;
        rollback: false;
        providers: false;
        secrets: false;
        routing: false;
        conditionalWrite: 'none';
    };
    nodeDefault?: DefaultModelSelection;
    models: ModelConfigModel[];
    activation: 'future-sessions';
}
export declare function registerModelConfigRoutes(ctx: Context, router: HttpRouter, config: WebServiceConfig, store: ApiKeyStore): void;
