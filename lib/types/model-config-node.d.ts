/**
 * Administrator-only bridge to the WorkBuddy model node sidecar.
 *
 * Exactly four fixed operations. Credentials live in a private bridge file that
 * only this module reads; nothing here accepts a URL, port, path or method from
 * the request. Every operation first proves the sidecar's identity matches the
 * pinned UUID from that file, then sends a reconstructed allowlisted request.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ApiKeyStore } from './api-keys-store.js';
import { HttpRouter } from './router.js';
import type { WebServiceConfig } from './types.js';
export interface NodeBridgeConfig {
    /** Home of the model node; its bridge.json is written by the daemon at startup. */
    home?: string;
    /** Loopback fetch used by tests in place of the global one. */
    fetchImpl?: typeof fetch;
    homePath?: () => string;
}
export declare function registerModelNodeBridgeRoutes(ctx: Context, router: HttpRouter, config: WebServiceConfig, store: ApiKeyStore, options?: NodeBridgeConfig): void;
