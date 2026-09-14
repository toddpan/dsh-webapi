/**
 * @dsh-external/dsh-web-service
 * DSH 全功能 Web Service API 插件
 * 提供标准 RESTful API、SSE 会话流式接口、OpenAI 协议兼容、工作区管理、会话生命周期与模型设置
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import z from 'schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'

import { HttpRouter, sendJson } from './router.js'
import { registerWorkspaceRoutes } from './workspaces.js'
import { registerSessionRoutes } from './sessions.js'
import { registerModelRoutes } from './models.js'
import { registerStreamingRoutes } from './streaming.js'
import { registerFileRoutes } from './files.js'
import { registerFsRoutes } from './fs.js'
import { registerSkillRoutes } from './skills.js'
import { registerUserQuestionBridge } from './user-questions.js'
import { registerOpenApiRoutes } from './openapi.js'
import type { WebServiceConfig } from './types.js'


export const name = '@dsh-external/dsh-web-service'
export const inject = ['webServer', 'tools']

export interface Config extends WebServiceConfig {}

export const Config: z<Config> = z.object({
  pathPrefix: z.string().default('/api/v1').description('Web Service API 路由前缀'),
  apiKey: z.string().default('').description('三方调用鉴权 API Key（留空则不开启鉴权）'),
  standalonePort: z.natural().default(0).description('独立 HTTP 监听端口（0 表示仅使用主 webserver）'),
  cors: z.boolean().default(true).description('是否允许跨域请求'),
  defaultCwd: z.string().default('').description('默认工作目录（留空则为 process.cwd()）'),
  maxUploadBytes: z.natural().default(2 * 1024 * 1024 * 1024).description('文件上传大小上限（字节，默认 2GB；大文件建议走 /files/resumable 分片接口）'),
})

export function apply(ctx: Context, config: Config): void {
  const router = new HttpRouter(config)
  const prefix = config.pathPrefix || '/api/v1'

  // 1. 系统状态接口
  router.get('/system/status', (_req: IncomingMessage, res: ServerResponse) => {
    const webServer = ctx.get('webServer') as any
    const llm = ctx.get('llm') as any
    const workspaceRegistry = ctx.get('workspaceRegistry') as any

    sendJson(res, 200, {
      ok: true,
      data: {
        name: '@dsh-external/dsh-web-service',
        version: '1.0.0',
        status: 'running',
        port: webServer?.port || 3080,
        standalonePort: config.standalonePort || undefined,
        prefix,
        workspacesCount: workspaceRegistry?.list?.()?.length ?? 0,
        providers: llm?.listProviders?.()?.map((p: any) => p.id) ?? [],
        authEnabled: Boolean(config.apiKey),
        uptime: process.uptime(),
      },
    })
  })

  // 2. 注册各子业务模块路由
  registerWorkspaceRoutes(ctx, router)
  registerSessionRoutes(ctx, router, config)
  registerModelRoutes(ctx, router)
  registerStreamingRoutes(ctx, router)
  registerFileRoutes(ctx, router, config)
  registerFsRoutes(router, config)
  registerSkillRoutes(ctx, router, config)
  registerUserQuestionBridge(ctx, router)
  registerOpenApiRoutes(router, config)

  // 3. 挂载到 DSH 主 Web 服务器 (ctx.webServer)
  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'prefix',
      path: prefix,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const handled = await router.dispatch(req, res, prefix)
        if (!handled && !res.headersSent) {
          sendJson(res, 404, {
            ok: false,
            error: `Endpoint not found: ${req.url}`,
            code: 'NOT_FOUND',
          })
        }
      },
    })
  }, '@dsh-external/dsh-web-service: webServer prefix route')

  // 4. 可选：开启独立 HTTP 监听端口
  if (config.standalonePort && config.standalonePort > 0) {
    ctx.effect(() => {
      const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const handled = await router.dispatch(req, res, prefix)
        if (!handled && !res.headersSent) {
          sendJson(res, 404, {
            ok: false,
            error: `Endpoint not found: ${req.url}`,
            code: 'NOT_FOUND',
          })
        }
      })

      server.listen(config.standalonePort, '0.0.0.0')

      return () => {
        server.close()
      }
    }, '@dsh-external/dsh-web-service: standalone http server')
  }

  // 5. 注册模型 Tool，方便 LLM 获知 Web Service 的运行端点与说明
  if (ctx.get('tools')) {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'dsh_web_service_info',
      description: '获取当前 DSH Web Service API 的服务地址、文档入口和端点信息',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute() {
        const webServer = ctx.get('webServer') as any
        const mainPort = webServer?.port || 3080
        const info = {
          baseUrl: `http://127.0.0.1:${mainPort}${prefix}`,
          docsUrl: `http://127.0.0.1:${mainPort}${prefix}/docs`,
          openApiUrl: `http://127.0.0.1:${mainPort}${prefix}/openapi.json`,
          standalonePort: config.standalonePort || undefined,
          apiKeyConfigured: Boolean(config.apiKey),
        }
        return JSON.stringify(info, null, 2)
      },
    })), '@dsh-external/dsh-web-service: info tool')
  }
}
