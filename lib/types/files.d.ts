/**
 * @dsh-external/dsh-web-service - 会话文件上传
 *
 * POST /sessions/:id/files
 *  - multipart/form-data：支持多文件字段（每个带 filename 的 part 都会保存）
 *  - 其余 Content-Type：按原始字节流处理，文件名取 ?filename= 或 X-Filename 头
 * 文件落盘到该会话的工作区目录（cwd），同名自动追加 -1/-2 后缀，永不覆盖已有文件。
 * 会话 AI 通过 fs 工具即可直接读取（cwd 即其文件工具根目录之一）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type HttpRouter } from './router.js';
import type { WebServiceConfig } from './types.js';
export interface UploadedPart {
    name?: string;
    filename?: string;
    mimeType?: string;
    data: Buffer;
}
/** 解析 multipart/form-data（无依赖最小实现，满足文件字段提取） */
export declare function parseMultipart(buffer: Buffer, contentType: string): UploadedPart[];
/** 清洗文件名：取 basename、去控制字符、限长；非法名回退为 file-<ts> */
export declare function sanitizeFilename(raw: string | undefined): string;
/**
 * GET /sessions/:id/files        — 列出会话工作区目录（?path= 相对子目录）
 * GET /sessions/:id/files/download — 下载文件（?path= 相对路径；?inline=1 浏览器内联预览）
 */
export declare function registerFileRoutes(ctx: Context, router: HttpRouter, config: WebServiceConfig): void;
