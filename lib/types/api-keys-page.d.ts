/**
 * @dsh-external/dsh-web-service - API Key 设置页（服务端渲染 HTML）
 *
 * 与 src/openapi.ts 的 generateDocsHtml() 同构：一条路由 + 一个返回整页内联 HTML 的纯函数，
 * 零构建链、零依赖。视觉沿用 /docs 的 :root 变量与 kebab-case 命名。
 *
 * 安全约定：
 * - 页面 HTML 本身不含任何密钥，公开可访问（与 /docs 一致）；
 * - 所有数据请求都走 /api-keys*，服务端要求管理令牌；页面只把令牌存在 localStorage；
 * - 完整 Key 只在「新建 / 轮换」成功的一次性弹层内出现，关闭即从 DOM 清除。
 */
export declare function generateApiKeysHtml(prefix: string, adminTokenPath?: string, embed?: boolean): string;
