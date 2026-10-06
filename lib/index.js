/**
 * @dsh-external/dsh-web-service
 * DSH 全功能 Web Service API 插件
 * 提供标准 RESTful API、SSE 会话流式接口、OpenAI 协议兼容、工作区管理、会话生命周期与模型设置
 */
import { createServer } from 'node:http';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { HttpRouter, sendJson } from './router.js';
import { registerWorkspaceRoutes } from './workspaces.js';
import { registerSessionRoutes } from './sessions.js';
import { registerModelRoutes } from './models.js';
import { registerStreamingRoutes } from './streaming.js';
import { registerFileRoutes } from './files.js';
import { registerFsRoutes } from './fs.js';
import { registerSkillRoutes } from './skills.js';
import { registerUserQuestionBridge } from './user-questions.js';
import { registerOpenApiRoutes } from './openapi.js';
import { ApiKeyStore } from './api-keys-store.js';
import { registerApiKeyRoutes } from './api-keys.js';
import { pluginVersion } from './version.js';
import { checkForUpdate } from './updates.js';
export const name = '@dsh-external/dsh-web-service';
export const inject = ['webServer', 'tools'];
export const Config = z.object({
    pathPrefix: z.string().default('/api/v1').description('Web Service API 路由前缀'),
    apiKey: z.string().default('').role('secret').description('三方调用鉴权 API Key（留空则不开启鉴权）'),
    standalonePort: z.natural().default(0).description('独立 HTTP 监听端口（0 表示仅使用主 webserver）'),
    cors: z.boolean().default(true).description('是否允许跨域请求'),
    defaultCwd: z.string().default('').description('默认工作目录（留空则为 process.cwd()）'),
    maxUploadBytes: z.natural().default(2 * 1024 * 1024 * 1024).description('文件上传大小上限（字节，默认 2GB；大文件建议走 /files/resumable 分片接口）'),
    adminRemoteAccess: z.boolean().default(false).description('是否允许非回环地址访问 API Key 管理接口（默认 false，仅本机可管理密钥）'),
});
export function apply(ctx, config) {
    const router = new HttpRouter(config);
    const prefix = config.pathPrefix || '/api/v1';
    // 0. API Key 存储 + 多 Key 鉴权服务（数据面鉴权由 router 委托给它）
    const keyStore = new ApiKeyStore(config.apiKey || '', config.dshHome);
    router.setAuthService(keyStore);
    // 1. 系统状态接口
    router.get('/system/status', async (_req, res) => {
        await keyStore.ensureReady();
        const webServer = ctx.get('webServer');
        const llm = ctx.get('llm');
        const workspaceRegistry = ctx.get('workspaceRegistry');
        sendJson(res, 200, {
            ok: true,
            data: {
                name: '@dsh-external/dsh-web-service',
                version: pluginVersion,
                status: 'running',
                port: webServer?.port || 3080,
                standalonePort: config.standalonePort || undefined,
                prefix,
                workspacesCount: workspaceRegistry?.list?.()?.length ?? 0,
                providers: llm?.listProviders?.()?.map((p) => p.id) ?? [],
                authEnabled: keyStore.getAuthEnabled(),
                apiKeyCount: keyStore.countActive(),
                keysStoreDegraded: keyStore.degraded,
                uptime: process.uptime(),
            },
        });
    });
    // 1.1 检查更新（公开：只暴露当前版本号与 GitHub Release 信息；内部带缓存与超时降级）
    router.get('/system/updates', async (_req, res) => {
        const result = await checkForUpdate(pluginVersion);
        sendJson(res, 200, { ok: true, data: result });
    }, { auth: 'public' });
    // 2. 注册各子业务模块路由
    registerWorkspaceRoutes(ctx, router);
    registerSessionRoutes(ctx, router, config);
    registerModelRoutes(ctx, router);
    registerStreamingRoutes(ctx, router);
    registerFileRoutes(ctx, router, config);
    registerFsRoutes(router, config);
    registerSkillRoutes(ctx, router, config);
    registerUserQuestionBridge(ctx, router);
    registerOpenApiRoutes(router, config);
    registerApiKeyRoutes(router, config, keyStore);
    // 3. 挂载到 DSH 主 Web 服务器 (ctx.webServer)
    ctx.effect(() => {
        return ctx.webServer.register({
            kind: 'prefix',
            path: prefix,
            handler: async (req, res) => {
                const handled = await router.dispatch(req, res, prefix);
                if (!handled && !res.headersSent) {
                    sendJson(res, 404, {
                        ok: false,
                        error: `Endpoint not found: ${req.url}`,
                        code: 'NOT_FOUND',
                    });
                }
            },
        });
    }, '@dsh-external/dsh-web-service: webServer prefix route');
    // 4. 可选：开启独立 HTTP 监听端口
    if (config.standalonePort && config.standalonePort > 0) {
        ctx.effect(() => {
            const server = createServer(async (req, res) => {
                const handled = await router.dispatch(req, res, prefix);
                if (!handled && !res.headersSent) {
                    sendJson(res, 404, {
                        ok: false,
                        error: `Endpoint not found: ${req.url}`,
                        code: 'NOT_FOUND',
                    });
                }
            });
            server.listen(config.standalonePort, '0.0.0.0');
            return () => {
                server.close();
            };
        }, '@dsh-external/dsh-web-service: standalone http server');
    }
    // 5. 注册模型 Tool，方便 LLM 获知 Web Service 的运行端点与说明
    if (ctx.get('tools')) {
        ctx.effect(() => ctx.tools.register(defineTool({
            name: 'dsh_web_service_info',
            description: '获取当前 DSH Web Service API 的服务地址、文档入口和端点信息',
            parameters: {},
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [{ type: 'text', text: String(value) }],
            },
            async execute() {
                await keyStore.ensureReady();
                const webServer = ctx.get('webServer');
                const mainPort = webServer?.port || 3080;
                const info = {
                    baseUrl: `http://127.0.0.1:${mainPort}${prefix}`,
                    docsUrl: `http://127.0.0.1:${mainPort}${prefix}/docs`,
                    apiReferenceUrl: `http://127.0.0.1:${mainPort}${prefix}/docs/reference`,
                    apiKeysSettingsUrl: `http://127.0.0.1:${mainPort}${prefix}/settings/api-keys`,
                    openApiUrl: `http://127.0.0.1:${mainPort}${prefix}/openapi.json`,
                    standalonePort: config.standalonePort || undefined,
                    authEnabled: keyStore.getAuthEnabled(),
                    apiKeyConfigured: keyStore.getAuthEnabled(),
                    apiKeyCount: keyStore.countActive(),
                    adminTokenPath: keyStore.adminTokenPath,
                };
                return JSON.stringify(info, null, 2);
            },
        })), '@dsh-external/dsh-web-service: info tool');
    }
}
//# sourceMappingURL=index.js.map