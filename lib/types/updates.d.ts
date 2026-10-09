/**
 * dsh-web-service - 检查更新
 *
 * 版本单一来源：GitHub Releases（仓库 homepage/bugs 同源 toddpan/dsh-webapi）。
 * - 成功结果缓存 10 分钟，避免公开端点被刷成 GitHub 的出站代理；
 * - 失败结果缓存 60 秒（网络抖动时不反复打超时请求）；
 * - 检查更新是尽力而为的能力：任何失败都不抛错，返回带 error 说明的结果，
 *   由页面友好展示「检查失败」，不影响服务本身。
 */
export interface UpdateCheckResult {
    /** 当前运行版本 */
    current: string;
    /** 最新 Release 版本号（tag）；null = 未能取得 */
    latest: string | null;
    /** true = 有新版本；false = 已是最新（含仓库尚无 Release）；null = 检查失败 */
    updateAvailable: boolean | null;
    /** Releases 页 / 最新 Release 链接 */
    releaseUrl: string;
    checkedAt: number;
    /** 检查失败原因（latest 为 null 时给出，不含任何内部路径） */
    error?: string;
}
/** 语义化版本比较：>0 表示 a 更新。忽略前缀 v 与预发布段（预发布 < 正式版） */
export declare function compareVersions(a: string, b: string): number;
export declare function checkForUpdate(current: string): Promise<UpdateCheckResult>;
