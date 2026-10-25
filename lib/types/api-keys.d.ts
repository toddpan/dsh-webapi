/**
 * dsh-web-service - API Key 管理（设置页 + 管理接口）
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
 *   API 服务  GET    {prefix}/api-keys/service          （端口 + 监听范围 + 运行状态 + 可访问地址）
 *   API 服务  POST   {prefix}/api-keys/service/start    （body: {port?, bindIp?}，启动/重绑）
 *   API 服务  POST   {prefix}/api-keys/service/stop     （停止，保留端口与监听范围）
 *   API 服务  GET    {prefix}/api-keys/service/free-port（建议一个空闲端口）
 *   兼容      GET    {prefix}/api-keys/port             （= /api-keys/service）
 *   兼容      PUT    {prefix}/api-keys/port             （旧客户端：fixedPort=0 停止，否则启动）
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
import type { BindIp, ServiceState } from './service-settings.js';
import type { WebServiceConfig } from './types.js';
export interface AdminGuardOptions {
    /** 允许非回环地址访问管理接口（默认 false） */
    adminRemoteAccess?: boolean;
}
export interface ApiKeyRouteOptions {
    /**
     * 解析主 webserver 实际监听端口（每次渲染页面时调用——桌面端 GUI 端口随启动变化，
     * 不能在注册期固定）。页面据此注入 http://127.0.0.1:<port><prefix> 服务地址：
     * GUI 内嵌在 dsh-app:// 等自定义协议 iframe 里，location.origin 不是可用的访问地址。
     */
    getMainPort?: () => number;
    /** 独立 API 服务当前状态（设置页「API 服务」区块数据源） */
    getServiceState?: () => ServiceState;
    /**
     * 启动（或重绑）独立服务。port 省略 / 0 表示沿用已保存端口，从未分配过则自动分配；
     * bindIp 仅接受 '127.0.0.1'（默认，仅本机）与 '0.0.0.0'（局域网可达）。
     * 实现方负责：先试绑定、成功才落盘；重绑失败回滚原监听。
     */
    startService?: (opts: {
        port?: number;
        bindIp?: BindIp;
    }) => Promise<{
        ok: true;
        message: string;
    } | {
        ok: false;
        error: string;
    }>;
    /** 停止独立服务（保留端口与监听范围，下次启动 DSH 不自动拉起） */
    stopService?: () => Promise<{
        ok: true;
        message: string;
    }>;
    /** 建议一个空闲端口（设置页「自动」按钮） */
    suggestPort?: (bindIp?: BindIp) => Promise<number>;
}
export declare function registerApiKeyRoutes(router: HttpRouter, config: WebServiceConfig, store: ApiKeyStore, options?: ApiKeyRouteOptions): void;
