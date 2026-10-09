/**
 * dsh-web-service - 远端文件系统目录浏览与文件管理（对齐 DSH directory-picker-browse 语义并扩展工作区文件管理）
 *
 * GET    /fs/list     ?path=&all=1       — 列出目录（all=1 包含文件与子目录，缺省只返回目录）
 * GET    /fs/download ?path=&inline=1    — 下载/内联预览绝对路径文件
 * POST   /fs/mkdir    { path, name }     — 在 path 目录下新建子目录
 * POST   /fs/upload   ?path=             — 向 path 目录上传文件（multipart 或原始流）
 * DELETE /fs/remove   ?path=             — 删除文件或目录
 */
import { type HttpRouter } from './router.js';
import type { WebServiceConfig } from './types.js';
export interface FsEntryRow {
    name: string;
    path: string;
    type: 'dir' | 'file' | 'link';
    size?: number;
    mtime?: number;
    hidden: boolean;
}
export declare function registerFsRoutes(router: HttpRouter, config: WebServiceConfig): void;
