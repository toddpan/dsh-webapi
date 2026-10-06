/**
 * @dsh-external/dsh-web-service - API Key 管理（设置页 + 管理接口）
 *
 * 路由：
 *   页面      GET    {prefix}/settings/api-keys        （公开，与 /docs 一致）
 *   列表      GET    {prefix}/api-keys
 *   新建      POST   {prefix}/api-keys                 → 201，返回明文（之后可复制）
 *   改名/过期 PATCH  {prefix}/api-keys/:id
 *   轮换      POST   {prefix}/api-keys/:id/rotate      → 返回明文（之后可复制）
 *   复制      POST   {prefix}/api-keys/:id/reveal      → 取回明文（管理令牌；历史 Key 409）
 *   吊销      POST   {prefix}/api-keys/:id/revoke      （幂等）
 *   删除      DELETE {prefix}/api-keys/:id             （仅限已吊销的 managed Key）
 *   鉴权开关  GET    {prefix}/api-keys/auth
 *   鉴权开关  PUT    {prefix}/api-keys/auth
 *
 * 注册顺序约束：字面量路由（/api-keys/auth）不得被参数路由（/api-keys/:id*）抢先匹配，
 * 新增路由时请保持「字面量优先」，或使用互不重叠的 method。
 *
 * 管理面鉴权（全部 /api-keys* 路由）：
 *   1) 远端地址必须是回环（config.adminRemoteAccess=true 才放开）
 *   2) 浏览器请求做同源校验（防 CSRF；DNS rebinding 由 admin token 的高熵性兜底）
 *   3) 必须携带 admin token（Authorization: Bearer / X-Admin-Token）；失败限流后短路拒绝
 *   —— 持有普通 API Key 的三方客户端不能调用这些接口。
 */
import { HttpRouter } from './router.js';
import { ApiKeyStore } from './api-keys-store.js';
import type { WebServiceConfig } from './types.js';
export interface AdminGuardOptions {
    /** 允许非回环地址访问管理接口（默认 false） */
    adminRemoteAccess?: boolean;
}
export declare function registerApiKeyRoutes(router: HttpRouter, config: WebServiceConfig, store: ApiKeyStore): void;
