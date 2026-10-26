/**
 * dsh-web-service
 * DSH 全功能 Web Service API 插件
 * 提供标准 RESTful API、SSE 会话流式接口、OpenAI 协议兼容、工作区管理、会话生命周期与模型设置
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
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
import { registerPluginRoutes } from './plugins.js'
import { registerUserQuestionBridge } from './user-questions.js'
import { registerCollaborationRoutes } from './collaboration.js'
import { registerOpenApiRoutes } from './openapi.js'
import { ApiKeyStore } from './api-keys-store.js'
import { registerApiKeyRoutes } from './api-keys.js'
import { ServiceSettingsStore } from './service-settings.js'
import type { BindIp, ServiceSettingsPatch, ServiceState } from './service-settings.js'
import {
  BIND_IP_ALL,
  BIND_IP_LOOPBACK,
  DEFAULT_PORT,
  PORT_SCAN_LIMIT,
  normalizeBindIp,
  normalizePort,
} from './service-settings.js'
import { pluginVersion } from './version.js'
import { checkForUpdate } from './updates.js'
import { collectMachineIdentity, collectLanIpv4 } from './netinfo.js'
import type { WebServiceConfig } from './types.js'


export const name = 'dsh-web-service'
export const inject = ['webServer', 'tools']

export interface Config extends WebServiceConfig {}

export const Config: z<Config> = z.object({
  pathPrefix: z.string().default('/api/v1').description('Web Service API 路由前缀'),
  apiKey: z.string().default('').role('secret').description('三方调用鉴权 API Key（留空则不开启鉴权）'),
  standalonePort: z.natural().default(0)
    .description('首次安装时的初始端口（0 = 自动分配，31800 起）；分配后在设置页「API 服务」管理'),
  standaloneBindIp: z.union(['127.0.0.1', '0.0.0.0']).default('127.0.0.1')
    .description('首次安装时的初始监听范围：127.0.0.1=仅本机可达（默认），0.0.0.0=局域网可达；之后以设置页为准'),
  cors: z.boolean().default(true).description('是否允许跨域请求'),
  defaultCwd: z.string().default('').description('默认工作目录（留空则为 process.cwd()）'),
  maxUploadBytes: z.natural().default(2 * 1024 * 1024 * 1024).description('文件上传大小上限（字节，默认 2GB；大文件建议走 /files/resumable 分片接口）'),
  adminRemoteAccess: z.boolean().default(false).description('是否允许非回环地址访问 API Key 管理接口（默认 false，仅本机可管理密钥）'),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  const router = new HttpRouter(config)
  const prefix = config.pathPrefix || '/api/v1'

  // 0. API Key 存储 + 多 Key 鉴权服务（数据面鉴权由 router 委托给它）
  const keyStore = new ApiKeyStore(config.apiKey || '', config.dshHome)
  router.setAuthService(keyStore)
  // 启动即初始化密钥存储：数据面鉴权在首个请求就会执行，若等首个 handler 再
  // ensureReady()，新启动窗口内 verifyDataToken 因 initDone=false fail-closed，
  // 合法 Key 也会被拒（实测：重启后首批探测/任务全部 401，直到某次管理调用才恢复）。
  void keyStore.ensureReady()

  // 0.1 独立 API 服务状态（必须在任何路由注册前声明：/system/status 随时可能被访问）
  const settingsStore = new ServiceSettingsStore({ dshHome: config.dshHome })
  let standaloneServer: ReturnType<typeof createServer> | undefined
  let standaloneListeningPort = 0
  let standaloneBindIp: BindIp | undefined
  let standaloneError = ''
  /** 已关闭监听器的收尾队列（存量 keep-alive 连接结束才算真正释放） */
  let closing: Promise<void> = Promise.resolve()

  // 1. 系统状态接口
  router.get('/system/status', async (_req: IncomingMessage, res: ServerResponse) => {
    await keyStore.ensureReady()
    const webServer = ctx.get('webServer') as any
    const llm = ctx.get('llm') as any
    const workspaceRegistry = ctx.get('workspaceRegistry') as any

    sendJson(res, 200, {
      ok: true,
      data: {
        name: 'dsh-web-service',
        version: pluginVersion,
        status: 'running',
        port: webServer?.port || 3080,
        // 独立 API 服务：监听中才给出端口；桌面端主端口随启动变化，三方集成应以本端口为准
        standalonePort: standaloneListeningPort || undefined,
        standaloneRunning: standaloneListeningPort > 0,
        standaloneBindIp: standaloneBindIp || settingsStore.peek().bindIp,
        standaloneError: standaloneError || undefined,
        prefix,
        workspacesCount: workspaceRegistry?.list?.()?.length ?? 0,
        providers: llm?.listProviders?.()?.map((p: any) => p.id) ?? [],
        authEnabled: keyStore.getAuthEnabled(),
        apiKeyCount: keyStore.countActive(),
        keysStoreDegraded: keyStore.degraded,
        uptime: process.uptime(),
      },
    })
  })

  // 1.1 检查更新（公开：只暴露当前版本号与 GitHub Release 信息；内部带缓存与超时降级）
  router.get('/system/updates', async (_req: IncomingMessage, res: ServerResponse) => {
    const result = await checkForUpdate(pluginVersion)
    sendJson(res, 200, { ok: true, data: result })
  }, { auth: 'public' })

  // 1.2 机器指纹 ping：返回本机 IP/MAC，用于判定 127.0.0.1（natpass 等隧道）节点是否本机
  router.get('/ping', async (_req: IncomingMessage, res: ServerResponse) => {
    sendJson(res, 200, {
      ok: true,
      data: {
        ...collectMachineIdentity(),
        hint: '比较 data.macs（首选，主机级稳定标识）或 data.ips 与调用方自身网卡即可判定该节点是否本机；127.0.0.1 节点 MAC 命中本机则为本地 DSH，否则是隧道转发的远端 DSH',
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
  registerPluginRoutes(router)
  registerUserQuestionBridge(ctx, router)
  registerCollaborationRoutes(ctx, router)
  registerOpenApiRoutes(router, config)
  // API Key 管理（页面 + 管理端点）的注册在 §4 之后：需传入固定端口回调

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
  }, 'dsh-web-service: webServer prefix route')

  // 4. 独立 API 服务（固定端口 + 启动/停止）
  // 与 DSH 主 webserver 解耦：主端口随每次启动变化，独立服务端口固定，便于三方集成
  // 与自动化脚本。设置页「API 服务」管理端口、监听范围（127.0.0.1 / 0.0.0.0）与运行
  // 状态；首次安装自动分配一个空闲端口（从 31800 起），此后端口固定不变，用户可随时
  // 停止 / 启动。状态持久化在 service-settings.json，保存即时生效、无需重启 DSH。
  const standaloneHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const handled = await router.dispatch(req, res, prefix)
    if (!handled && !res.headersSent) {
      sendJson(res, 404, {
        ok: false,
        error: `Endpoint not found: ${req.url}`,
        code: 'NOT_FOUND',
      })
    }
  }

  /**
   * 关闭当前监听并返回「完全释放」的 promise。
   * 注意：调用方通常不应 await 它再发响应——设置页可能正由这个监听器提供服务，
   * close 回调要等当前响应结束才触发。监听套接字在 close() 调用时即释放，
   * 同端口重新绑定由 bindServer 的短退避重试兜底。
   */
  function closeCurrentServer(): Promise<void> {
    const s = standaloneServer
    standaloneServer = undefined
    standaloneListeningPort = 0
    standaloneBindIp = undefined
    if (!s) return closing
    const closed = new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      s.once('close', done)
      // 立即释放空闲 keep-alive 连接；存量连接由 close 回调兜底
      try { s.closeIdleConnections?.() } catch { /* 老版本 Node 无此方法 */ }
      try {
        s.close(() => done())
      } catch {
        done()
      }
      // 兜底：close 回调理论上必达，极端情况下也不让后续启停挂死
      const t = setTimeout(done, 2000)
      t.unref?.()
    })
    closing = closing.then(() => closed, () => closed)
    return closing
  }

  /** 单次监听尝试：成功返回 server，失败 reject（带 err.code） */
  function listenOnce(port: number, bindIp: BindIp): Promise<ReturnType<typeof createServer>> {
    return new Promise((resolve, reject) => {
      const server = createServer(standaloneHandler)
      const onError = (err: Error): void => {
        try {
          server.close()
        } catch { /* 忽略 */ }
        reject(err)
      }
      server.once('error', onError)
      server.listen(port, bindIp, () => {
        server.removeListener('error', onError)
        // 监听建立后仍保留兜底 error 记录（不 crash 插件进程）
        server.on('error', (err) => {
          standaloneError = err.message
        })
        resolve(server)
      })
    })
  }

  /** 绑定监听（幂等重试：刚关闭的同端口监听需要极短时间释放套接字） */
  async function bindServer(port: number, bindIp: BindIp): Promise<ReturnType<typeof createServer>> {
    let lastErr: any
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await listenOnce(port, bindIp)
      } catch (err: any) {
        lastErr = err
        if (err?.code !== 'EADDRINUSE' || attempt === 3) throw err
        await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)))
      }
    }
    throw lastErr
  }

  /** 接管监听器并刷新运行时状态 */
  async function adoptServer(server: ReturnType<typeof createServer>, bindIp: BindIp): Promise<number> {
    const address = server.address()
    const port = address && typeof address === 'object' ? address.port : 0
    standaloneServer = server
    standaloneListeningPort = port
    standaloneBindIp = bindIp
    standaloneError = ''
    unrefIfPossible(server)
    return port
  }

  /** 监听器不应阻止进程退出 */
  function unrefIfPossible(server: { unref?: () => void }): void {
    try { server.unref?.() } catch { /* 忽略 */ }
  }

  /** 自动分配端口并监听：31800-31899 依次尝试，全被占用时交给系统分配 */
  async function startAuto(bindIp: BindIp): Promise<number> {
    closeCurrentServer()
    for (let i = 0; i < PORT_SCAN_LIMIT; i++) {
      const candidate = DEFAULT_PORT + i
      try {
        const server = await listenOnce(candidate, bindIp)
        return await adoptServer(server, bindIp)
      } catch (err: any) {
        if (err?.code !== 'EADDRINUSE') throw err
      }
    }
    const server = await listenOnce(0, bindIp)
    return await adoptServer(server, bindIp)
  }

  /**
   * 启动（或重绑）独立服务。
   * - port 省略 / 0：沿用已保存端口；从未分配过则自动分配。
   * - 已在目标地址监听：只更新期望状态，不打断现有连接。
   * - 重绑失败：回滚到原监听，现状不变并返回可操作的错误文案。
   */
  async function startService(
    opts: { port?: number; bindIp?: BindIp } = {},
  ): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
    const settings = settingsStore.peek()
    const bindIp = normalizeBindIp(opts.bindIp) || settings.bindIp
    const explicit = normalizePort(opts.port) && Number(opts.port) > 0 ? Number(opts.port) : 0
    const wantPort = explicit || settings.port
    const prevPort = standaloneListeningPort
    const prevBindIp = standaloneBindIp
    try {
      let port = wantPort
      if (!port) {
        port = await startAuto(bindIp)
      } else if (!(standaloneServer && standaloneListeningPort === port && standaloneBindIp === bindIp)) {
        closeCurrentServer()
        const server = await bindServer(port, bindIp)
        await adoptServer(server, bindIp)
      }
      await settingsStore.set({ port, bindIp, autoStart: true })
      standaloneError = ''
      return { ok: true, message: startedMessage(bindIp, port) }
    } catch (err: any) {
      const message = startErrorMessage(err, wantPort, bindIp)
      // 回滚：恢复原监听（原地址已释放时尽力而为；失败则停在停止状态）
      if (prevPort > 0 && prevBindIp) {
        closeCurrentServer()
        const restored = await bindServer(prevPort, prevBindIp).catch(() => undefined)
        if (restored) await adoptServer(restored, prevBindIp)
      } else {
        closeCurrentServer()
      }
      // 回滚成功会清空 standaloneError，这里重新写入本次失败原因（状态页据此提示）
      standaloneError = message
      return { ok: false, error: message }
    }
  }

  /** 停止服务：保留端口与监听范围，只清除期望运行状态（下次启动 DSH 不自动拉起） */
  async function stopService(): Promise<{ ok: true; message: string }> {
    closeCurrentServer()
    standaloneError = ''
    await settingsStore.set({ autoStart: false }).catch(() => undefined)
    return { ok: true, message: '服务已停止' }
  }

  /** 设置页与 /api-keys/service 共用的状态视图 */
  function getServiceState(): ServiceState {
    const settings = settingsStore.peek()
    const listening = standaloneListeningPort > 0
    const lanIps = collectLanIpv4()
    const urls: string[] = []
    if (listening) {
      // 回环地址始终可达；仅 0.0.0.0 绑定时补充局域网地址
      urls.push(`http://127.0.0.1:${standaloneListeningPort}${prefix}`)
      if (standaloneBindIp === BIND_IP_ALL) {
        for (const ip of lanIps) {
          if (ip.includes(':')) continue // 展示仅取 IPv4
          const url = `http://${ip}:${standaloneListeningPort}${prefix}`
          if (!urls.includes(url)) urls.push(url)
        }
      }
    }
    return {
      running: listening,
      port: settings.port,
      bindIp: settings.bindIp,
      listeningPort: standaloneListeningPort,
      mainPort: (ctx.get('webServer') as any)?.port || 0,
      lanIps,
      urls,
      exposedToLan: listening && standaloneBindIp === BIND_IP_ALL,
      autoStart: settings.autoStart,
      ...(standaloneError ? { error: standaloneError } : {}),
    }
  }

  /** 建议一个空闲端口（设置页「自动」按钮）：31800 起扫描，全占用时给系统临时端口 */
  async function suggestPort(bindIp: BindIp = BIND_IP_LOOPBACK): Promise<number> {
    const probe = (port: number): Promise<boolean> => new Promise((resolve) => {
      const probeServer = createNetServer()
      const done = (free: boolean): void => {
        try {
          probeServer.close()
        } catch { /* 忽略 */ }
        resolve(free)
      }
      probeServer.once('error', () => done(false))
      probeServer.listen(port, bindIp, () => done(true))
    })
    for (let i = 0; i < PORT_SCAN_LIMIT; i++) {
      const candidate = DEFAULT_PORT + i
      if (candidate === standaloneListeningPort) continue
      if (await probe(candidate)) return candidate
    }
    return new Promise((resolve) => {
      const probeServer = createNetServer()
      probeServer.once('error', () => resolve(0))
      probeServer.listen(0, bindIp, () => {
        const address = probeServer.address()
        const port = address && typeof address === 'object' ? address.port : 0
        probeServer.close(() => resolve(port))
      })
    })
  }

  function startedMessage(bindIp: BindIp, port: number): string {
    return bindIp === BIND_IP_ALL
      ? `服务已启动 · ${bindIp}:${port}（局域网可达）`
      : `服务已启动 · ${bindIp}:${port}`
  }

  /** 启动失败的清晰文案（不透传堆栈，给可操作的提示） */
  function startErrorMessage(err: any, port: number, bindIp: string): string {
    switch (err?.code) {
      case 'EADDRINUSE':
        return `端口 ${port} 已被占用，请换一个端口`
      case 'EACCES':
        return `没有权限监听 ${bindIp}:${port}（1024 以下的端口需要管理员权限）`
      case 'EADDRNOTAVAIL':
        return `无法绑定 ${bindIp}：该地址不属于本机`
      default:
        return `启动失败：${err?.message || err}`
    }
  }

  // 启动：首次安装先补端口（配置值优先，否则自动分配），再按期望状态拉起
  await settingsStore.get()
  {
    const boot = settingsStore.peek()
    if (boot.port === 0) {
      const patch: ServiceSettingsPatch = {}
      if (config.standalonePort && normalizePort(config.standalonePort) && config.standalonePort > 0) {
        patch.port = config.standalonePort
      }
      const cfgBind = normalizeBindIp(config.standaloneBindIp)
      if (cfgBind) patch.bindIp = cfgBind
      if (Object.keys(patch).length > 0) await settingsStore.set(patch)
    }
    const ready = settingsStore.peek()
    if (ready.autoStart) {
      const started = await startService({ port: ready.port || undefined, bindIp: ready.bindIp })
      if (!started.ok) standaloneError = started.error
    } else if (ready.port === 0) {
      await settingsStore.set({ port: await suggestPort(ready.bindIp) })
    }
  }
  ctx.effect(() => () => { void closeCurrentServer() }, 'dsh-web-service: standalone api server')

  // 4.1 API Key 管理页 + 管理端点（含「API 服务」启停管理）
  registerApiKeyRoutes(router, config, keyStore, {
    // 页面每次渲染时解析主 webserver 实际监听端口（桌面端 GUI 端口随启动变化，不能固定）
    getMainPort: () => (ctx.get('webServer') as any)?.port || 0,
    getServiceState,
    startService,
    stopService,
    suggestPort,
  })

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
        await keyStore.ensureReady()
        const webServer = ctx.get('webServer') as any
        const mainPort = webServer?.port || 3080
        const mainBase = `http://127.0.0.1:${mainPort}${prefix}`
        // 独立服务运行中时优先给出固定端口地址（主端口每次启动都会漂移）
        const service = getServiceState()
        const baseUrl = service.urls[0] || mainBase
        const info = {
          baseUrl,
          serviceRunning: service.running,
          serviceUrl: service.urls[0],
          serviceUrls: service.urls,
          servicePort: service.port || undefined,
          serviceBindIp: service.bindIp,
          mainBaseUrl: mainBase,
          docsUrl: `${baseUrl}/docs`,
          apiReferenceUrl: `${baseUrl}/docs/reference`,
          apiKeysSettingsUrl: `${baseUrl}/settings/api-keys`,
          openApiUrl: `${baseUrl}/openapi.json`,
          authEnabled: keyStore.getAuthEnabled(),
          apiKeyConfigured: keyStore.getAuthEnabled(),
          apiKeyCount: keyStore.countActive(),
          adminTokenPath: keyStore.adminTokenPath,
        }
        return JSON.stringify(info, null, 2)
      },
    })), 'dsh-web-service: info tool')
  }
}
