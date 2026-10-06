/**
 * @dsh-external/dsh-web-service - HTTP Router & Dispatcher
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiResponse, WebServiceConfig } from './types.js';
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, query: Record<string, string>, body: any) => void | Promise<void>;
/**
 * 鉴权模式：
 * - public：免鉴权（文档、OpenAPI、设置页 HTML 等不含密钥的只读页面）
 * - data：  数据面鉴权（普通 API Key，多 Key ∪ 遗留 config.apiKey）
 * - admin： 跳过数据面闸门，由 handler 自行做管理面鉴权（admin token）
 */
export type RouteAuthMode = 'public' | 'data' | 'admin';
export interface RouteEntry {
    method: string;
    pattern: RegExp;
    paramNames: string[];
    handler: RouteHandler;
    /** true = 跳过 JSON 解析，把原始请求体 Buffer 交给 handler（文件上传用） */
    rawBody?: boolean;
    /** 鉴权模式，默认 data */
    auth?: RouteAuthMode;
}
export interface RouteOptions {
    rawBody?: boolean;
    auth?: RouteAuthMode;
}
/** 数据面鉴权服务（由 api-keys-store 提供；未注入时回落到单 config.apiKey 比对） */
export interface AuthServiceLike {
    isEnforced(): boolean;
    verifyDataToken(token: string): {
        ok: boolean;
        keyId?: string;
    };
    touch(keyId: string): void;
}
export declare class HttpRouter {
    private config;
    private routes;
    private auth;
    constructor(config: WebServiceConfig);
    /** 注入多 Key 鉴权服务 */
    setAuthService(auth: AuthServiceLike): void;
    add(method: string, pathPattern: string, handler: RouteHandler, options?: RouteOptions): void;
    get(pathPattern: string, handler: RouteHandler, options?: RouteOptions): void;
    post(pathPattern: string, handler: RouteHandler, options?: RouteOptions): void;
    put(pathPattern: string, handler: RouteHandler, options?: RouteOptions): void;
    patch(pathPattern: string, handler: RouteHandler, options?: RouteOptions): void;
    delete(pathPattern: string, handler: RouteHandler, options?: RouteOptions): void;
    dispatch(req: IncomingMessage, res: ServerResponse, basePath?: string): Promise<boolean>;
    private setCorsHeaders;
}
/** 发送 JSON 格式响应 */
export declare function sendJson<T>(res: ServerResponse, statusCode: number, payload: ApiResponse<T>): void;
/** 读取请求体为 JSON */
export declare function readJsonBody(req: IncomingMessage, maxBytes?: number): Promise<any>;
/** 读取请求体为原始 Buffer（文件上传用） */
export declare function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer>;
/** 开启 SSE 流式通道 */
export declare function initSseStream(res: ServerResponse): {
    send: (event: string, data: any) => void;
    close: () => void;
};
