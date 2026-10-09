/**
 * dsh-web-service
 * DSH 全功能 Web Service API 插件
 * 提供标准 RESTful API、SSE 会话流式接口、OpenAI 协议兼容、工作区管理、会话生命周期与模型设置
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { WebServiceConfig } from './types.js';
export declare const name = "dsh-web-service";
export declare const inject: string[];
export interface Config extends WebServiceConfig {
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
