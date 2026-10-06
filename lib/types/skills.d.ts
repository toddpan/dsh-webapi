/**
 * @dsh-external/dsh-web-service - Skill 管理 API
 *
 * 提供远端 DSH 技能全生命周期管理（供 onenat-workbuddy「技能中心」消费）：
 *   GET    /skills                列表（管理视图：见全部，含 root/path）
 *   GET    /skills/:name          单技能详情（含全文，供预览）
 *   GET    /skills/:name/body     原始 SKILL.md 全文（下载/预览）
 *   GET    /skills/:name/archive  整个技能目录归档 (.tgz)（含 references/ 等资源）
 *   POST   /skills                上传/创建技能（multipart 压缩包 或 JSON）
 *   PUT    /skills/:name          更新技能正文/元数据（JSON）
 *   DELETE /skills/:name          删除技能
 *
 * 落盘到技能根目录（默认 ~/.dsh/skills），写入后尝试触发 ctx.skills 失效；
 * 配套技能文件系统 watcher 会自行感知变更。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type HttpRouter } from './router.js';
import type { WebServiceConfig } from './types.js';
export declare function registerSkillRoutes(ctx: Context, router: HttpRouter, config: WebServiceConfig): void;
