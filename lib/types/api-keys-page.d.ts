/**
 * dsh-web-service - API Key 设置页（服务端渲染 HTML）
 *
 * 与 src/openapi.ts 的 generateDocsHtml() 同构：一条路由 + 一个返回整页内联 HTML 的纯函数，
 * 零构建链、零依赖。视觉沿用 /docs 的 :root 变量与 kebab-case 命名。
 *
 * 安全约定：
 * - 页面 HTML 本身不含任何密钥，公开可访问（与 /docs 一致）；
 * - 所有数据请求都走 /api-keys*，服务端要求管理令牌；页面只把令牌存在 localStorage；
 * - 新建 / 轮换成功后弹层展示完整 Key（关闭即从 DOM 清除）；列表页另有「复制」按钮，
 *   通过管理令牌鉴权的 /api-keys/:id/reveal 现取现用，明文只进剪贴板、不落 DOM。
 */
export interface ApiKeysPageOptions {
    /** API 路由前缀，如 /api/v1 */
    prefix: string;
    /** 管理令牌文件绝对路径（令牌门给出 cat 命令） */
    adminTokenPath?: string;
    /** GUI 侧边栏内嵌模式 */
    embed?: boolean;
    /** 主 webserver 的 HTTP 地址（GUI 内嵌在自定义协议 iframe 里时 location.origin 不可用） */
    httpBase?: string;
    /** 主 webserver 的其他可用地址（局域网） */
    extraBases?: string[];
    /** 独立 API 服务当前可访问地址（运行中才有值） */
    serviceUrls?: string[];
    /** 独立 API 服务是否运行中 */
    serviceRunning?: boolean;
}
export declare function generateApiKeysHtml(options: ApiKeysPageOptions): string;
