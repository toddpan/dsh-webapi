/** Node onboarding owns credential provisioning; the browser receives one expiring ticket. */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { ApiKeyStore } from './api-keys-store.js'
import { rejectAdmin } from './api-keys.js'
import { HttpRouter, sendJson } from './router.js'
import type { WebServiceConfig } from './types.js'
import { NodeRuntime } from './node-runtime.js'
import { OnenatTunnel, type OnenatTunnelSettings } from './onenat-tunnel.js'
import { WorkBuddyAccount, type WorkBuddyLogin } from './workbuddy-account.js'

export interface NodeOnboardingOptions {
  getLocalPort(): number
  getMainPort(): number
  startService(): Promise<{ ok: true; message: string } | { ok: false; error: string }>
}

/** Test seams; production always uses the real tunnel, node runtime and account session. */
export interface NodeOnboardingDependencies {
  tunnel?: OnenatTunnel
  runtime?: NodeRuntime
  account?: WorkBuddyAccount
}

/** Separate from API Keys: consuming a pairing ticket cannot mint or reveal a data key. */
export class NodeOnboarding {
  readonly tunnel: OnenatTunnel
  readonly runtime: NodeRuntime
  readonly account: WorkBuddyAccount
  private remoteStatusTimer?: ReturnType<typeof setInterval>
  private queue: Promise<unknown> = Promise.resolve()
  private lastError = ''
  private closed = false
  private readonly setupToken = randomBytes(32).toString('hex')
  private readonly dir: string
  /** 工作区目录覆盖：default 跟随 DSH 注册表；custom 使用用户保存的目录列表。 */
  private workspace: { mode: 'default' | 'custom'; roots: string[] } = { mode: 'default', roots: [] }
  private readonly workspaceReady: Promise<void>

  private async loadWorkspace(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(path.join(this.dir, 'workspace.json'), 'utf8'))
      if (data.mode === 'custom' && Array.isArray(data.roots)) {
        this.workspace = { mode: 'custom', roots: data.roots
          .filter((item: unknown): item is string => typeof item === 'string' && !!item.trim())
          .map((item: string) => path.resolve(item.trim())) }
      }
    } catch (err: any) { if (err.code !== 'ENOENT') this.lastError = '工作区目录配置损坏，已回退为默认' }
  }

  private async writeWorkspace(workspace: { mode: 'default' | 'custom'; roots: string[] }): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const file = path.join(this.dir, 'workspace.json')
    const tmp = file + '.' + randomBytes(6).toString('hex')
    await writeFile(tmp, JSON.stringify(workspace), { mode: 0o600 })
    await rename(tmp, file)
    this.workspace = workspace
  }

  constructor(private readonly ctx: Context, private readonly config: WebServiceConfig,
    private readonly keys: ApiKeyStore, private readonly options: NodeOnboardingOptions,
    dependencies: NodeOnboardingDependencies = {}) {
    this.dir = path.join(keys.dir, 'node-connection')
    this.account = dependencies.account ?? new WorkBuddyAccount(this.dir,
      { seal: plaintext => keys.sealCredential(plaintext), open: sealed => keys.openCredential(sealed) })
    this.workspaceReady = this.loadWorkspace()
    this.tunnel = dependencies.tunnel ?? new OnenatTunnel({ dir: path.join(this.dir, 'onenat'), onLocalPort: options.getLocalPort })
    this.runtime = dependencies.runtime ?? new NodeRuntime({ dir: path.join(keys.dir, 'workbuddy-node'), keyStore: keys,
      allowRoot: config.nodeAllowRoot === true,
      getRoots: () => this.roots(), getDshRef: async () => {
        const tunnel = await this.tunnel.status()
        if (!tunnel.origin || tunnel.phase !== 'online') throw new Error('公网映射尚未就绪，请先连接 ONENAT')
        const baseUrl = tunnel.origin + (this.config.pathPrefix || '/api/v1')
        return { baseUrl, ...(tunnel.managed && tunnel.mappingId ? { mappingId: tunnel.mappingId } : {}), apiKey: await this.managedKey() }
      } })
  }

  private defaultRoots(): string[] {
    const registry = this.ctx.get('workspaceRegistry') as any
    const roots = (registry?.list?.() || []).map((ws: any) => ws.cwd).filter((cwd: unknown): cwd is string => typeof cwd === 'string' && !!cwd.trim())
    return [...new Set<string>(roots.length ? roots : [this.config.defaultCwd || process.cwd()])]
  }

  private roots(): string[] {
    if (this.workspace.mode === 'custom' && this.workspace.roots.length) return this.workspace.roots
    return this.defaultRoots()
  }

  private async managedKey(): Promise<string> {
    await this.keys.ensureReady()
    const file = path.join(this.dir, 'managed-key.json')
    let id: string | undefined
    try { id = JSON.parse(await readFile(file, 'utf8')).id }
    catch (err: any) { if (err.code !== 'ENOENT') throw new Error('节点密钥记录损坏，请在设置中修复后重试') }
    if (id) {
      const known = this.keys.list().find(key => key.id === id && key.source === 'managed' && !key.custom && key.status === 'active' && !key.expiresAt)
      if (known) {
        const revealed = await this.keys.reveal(id)
        if (revealed && revealed !== 'unrecoverable' && this.keys.verifyDataToken(revealed.plaintext).ok) {
          await this.keys.setAuthEnabled(true)
          return revealed.plaintext
        }
      }
    }
    const created = await this.keys.create({ name: 'WorkBuddy 节点连接（自动管理）', note: '节点私有对话凭据；连接信息不包含此 Key' })
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const tmp = file + '.' + randomBytes(6).toString('hex')
    await writeFile(tmp, JSON.stringify({ id: created.view.id }), { mode: 0o600 })
    await rename(tmp, file)
    await this.keys.setAuthEnabled(true)
    return created.plaintext
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.closed) throw new Error('节点连接服务已停止')
      return work()
    })
    this.queue = result.catch(() => {})
    return result
  }

  handle(req: IncomingMessage, res: ServerResponse): boolean { return this.runtime.handle(req, res) }

  /** Only the local, unmapped DSH GUI may obtain a node-setup token. */
  private localGui(req: IncomingMessage): boolean {
    const port = this.options.getMainPort()
    if (!port || req.socket.localPort !== port) return false
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')) return false
    try {
      const host = new URL('http://' + req.headers.host)
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) || Number(host.port) !== port) return false
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) return false
      if (req.headers.origin && req.headers.origin !== host.origin) return false
      return true
    } catch { return false }
  }
  localSetupToken(req: IncomingMessage): string | undefined { return this.localGui(req) ? this.setupToken : undefined }
  localSetupAuthorized(req: IncomingMessage): boolean {
    return this.localGui(req) && req.headers['x-node-setup-token'] === this.setupToken
  }

  async status(): Promise<unknown> {
    await this.workspaceReady
    return { tunnel: await this.tunnel.status(), node: this.runtime.status(), account: await this.account.status(), name: hostname(),
      workspace: { mode: this.workspace.mode, defaults: this.defaultRoots(), custom: this.workspace.roots, effective: this.roots() },
      ...(this.lastError ? { error: this.lastError } : {}) }
  }

  /** 保存工作区目录覆盖；已绑定时后台重跑绑定流程，让 WorkBuddy 看到新目录。 */
  async saveWorkspace(input: { mode?: unknown; roots?: unknown }): Promise<unknown> {
    await this.workspaceReady
    const mode = input.mode === 'custom' ? 'custom' : 'default'
    let custom: string[] = []
    if (mode === 'custom') {
      const list = Array.isArray(input.roots) ? input.roots : []
      const seen = new Set<string>()
      for (const item of list) {
        if (typeof item !== 'string') throw new Error('工作区目录格式无效')
        const trimmed = item.trim()
        if (!trimmed) continue
        const resolved = path.resolve(trimmed)
        if (resolved === path.parse(resolved).root) throw new Error('工作区目录不能是根目录：' + resolved)
        seen.add(resolved)
      }
      if (!seen.size) throw new Error('自定义工作区目录不能为空')
      if (seen.size > 64) throw new Error('工作区目录数量过多（最多 64 个）')
      custom = [...seen]
    }
    await this.writeWorkspace({ mode, roots: custom })
    const account = await this.account.status()
    const tunnel = await this.tunnel.status()
    // 根目录变化会使 pairing 失效：重跑绑定流程（provision → pair → bind）
    const applying = account.configured && !!tunnel.configured
    if (applying) void this.loginAndBind().catch(() => {})
    return { mode, custom, effective: this.roots(), applying }
  }

  forgetPassword(): Promise<unknown> {
    return this.serial(async () => { await this.account.forgetPassword(); return this.status() })
  }

  /** 本机目录浏览：供设置页的工作区目录选择器逐级进入（只列子目录，不读文件内容）。 */
  async listDirectories(requestUrl?: string): Promise<unknown> {
    const raw = (new URL('http://local' + (requestUrl ?? '/')).searchParams.get('path') ?? '').trim()
    let target = raw
    if (target.startsWith('~')) target = homedir() + target.slice(1)
    if (!target) target = homedir()
    if (!path.isAbsolute(target)) throw new Error('目录路径无效')
    const resolved = path.resolve(target)
    const entries = await readdir(resolved, { withFileTypes: true }).catch((err: any) => {
      const reason = err.code === 'EACCES' || err.code === 'EPERM' ? '没有权限' : err.code === 'ENOENT' ? '目录不存在'
        : err.code === 'ENOTDIR' ? '不是目录' : err.code || err.message
      throw new Error('无法读取目录：' + reason)
    })
    const dirs = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base', numeric: true }))
      .slice(0, 500)
    const parent = path.dirname(resolved)
    return { path: resolved, parent: parent === resolved ? '' : parent, home: homedir(), dirs }
  }

  checkOnenatUpdate(): Promise<{ installed: boolean; current: string; latest: string; updateAvailable: boolean }> {
    return this.tunnel.checkUpdate()
  }

  upgradeOnenat(force: boolean): Promise<unknown> {
    return this.serial(() => this.tunnel.upgrade({ force }))
  }

  async onenatLogs(): Promise<{ lines: string[] }> { return { lines: this.tunnel.tailLogs(80) } }

  private async refreshRemote(): Promise<void> {
    const state = await this.tunnel.status()
    if (!state.running || !state.clientId) return
    const account = await this.account.status()
    if (!account.configured) return
    const remote = await this.account.call('status?installationId=' + encodeURIComponent(state.clientId))
    await this.tunnel.updateRemoteState(remote)
  }

  private monitorRemote(): void {
    clearInterval(this.remoteStatusTimer)
    let pending = false
    this.remoteStatusTimer = setInterval(() => {
      if (pending || this.closed) return
      pending = true
      void this.refreshRemote().catch((err: Error) => { this.lastError = err.message }).finally(() => { pending = false })
    }, 15_000)
    this.remoteStatusTimer.unref?.()
  }

  /** Account login is the only human action; one-time pairing happens inside this operation. */
  async loginAndBind(input?: WorkBuddyLogin): Promise<unknown> {
    return this.serial(async () => {
      try {
        if (input) await this.account.login(input)
        const account = await this.account.status()
        if (!account.configured) throw new Error('请先登录 WorkBuddy 账号')
        const service = await this.options.startService()
        if (!service.ok) throw new Error(service.error)
        const apiKey = await this.managedKey()
        await this.workspaceReady
        await this.runtime.prepare()
        const state = await this.tunnel.status()
        const installationId = state.clientId
        const provision = await this.account.call('provision', { installationId,
          localPort: this.options.getLocalPort(), name: input?.name || account.name || hostname(), apiKey })
        await this.tunnel.startManaged({ config: provision.config, clientId: provision.client_id,
          mappingId: provision.mapping_id, tunnelId: provision.tunnel_id, serverUrl: account.serverUrl,
          name: provision.name, protocol: provision.protocol, subdomain: provision.subdomain, remotePort: provision.remote_port })
        // The managed client must connect before the backend can return the real TLS origin.
        const deadline = Date.now() + 60_000
        let online = await this.tunnel.status()
        while (Date.now() < deadline) {
          await this.refreshRemote()
          online = await this.tunnel.status()
          if (online.phase === 'online' && online.origin) break
          if (online.error) throw new Error(online.error)
          await new Promise(resolve => setTimeout(resolve, 750))
        }
        if (!online.origin || online.phase !== 'online') throw new Error('等待 ONENAT 外网映射超时，请重试')
        const ticket = await this.runtime.createPairing()
        const payload = { version: 1, baseUrl: online.origin, pairingCode: ticket.pairingCode,
          name: input?.name || ticket.name, expiresAt: ticket.expiresAt }
        const connectionInfo = 'dshnode1.' + Buffer.from(JSON.stringify(payload)).toString('base64url')
        const node = await this.account.call('bind', { installationId, connectionInfo })
        await this.account.bound(node.id)
        this.lastError = ''
        this.monitorRemote()
        return { nodeId: node.id, name: node.name, baseUrl: online.origin,
          workBuddyUrl: account.serverUrl, username: account.username }
      } catch (err: any) { this.lastError = err.message || 'WorkBuddy 节点绑定失败'; throw err }
    })
  }

  async connect(settings?: OnenatTunnelSettings): Promise<unknown> {
    return this.serial(async () => {
      try {
        const service = await this.options.startService()
        if (!service.ok) throw new Error(service.error)
        // Enforce data authentication before the first byte can leave via the new tunnel.
        await this.managedKey()
        const tunnel = settings ? await this.tunnel.ensure(settings) : await this.tunnel.start()
        if (!tunnel.origin || tunnel.phase !== 'online') throw new Error(tunnel.error || '需要有效证书的 HTTPS 映射才能接入节点')
        await this.runtime.prepare()
        const ticket = await this.runtime.createPairing()
        const payload = { version: 1, baseUrl: tunnel.origin, pairingCode: ticket.pairingCode,
          name: ticket.name, expiresAt: ticket.expiresAt }
        this.lastError = ''
        return { ...payload, connectionInfo: 'dshnode1.' + Buffer.from(JSON.stringify(payload)).toString('base64url'),
          nodeId: ticket.nodeId }
      } catch (err: any) {
        this.lastError = err.message || '节点连接失败'
        throw err
      }
    })
  }

  stop(): Promise<unknown> {
    return this.serial(async () => {
      clearInterval(this.remoteStatusTimer)
      await this.runtime.pause()
      await this.tunnel.stop()
      return this.status()
    })
  }

  /** Restart restores transport and pinned identity, but never creates a fresh pairing ticket. */
  async restore(): Promise<void> {
    try {
      const state = await this.tunnel.status()
      if (!state.configured || !state.settings.autoStart) return
      const service = await this.options.startService()
      if (!service.ok) throw new Error(service.error)
      const apiKey = await this.managedKey()
      const account = await this.account.status()
      if (account.configured) {
        // Reprovision on every restart: refreshes the local port and the mapping's
        // short-lived read credential without rotating the node identity.
        const state = await this.tunnel.status()
        const provision = await this.account.call('provision', { installationId: state.clientId,
          localPort: this.options.getLocalPort(), name: account.name || hostname(), apiKey })
        await this.tunnel.startManaged({ config: provision.config, clientId: provision.client_id, mappingId: provision.mapping_id,
          tunnelId: provision.tunnel_id, serverUrl: account.serverUrl, name: provision.name, protocol: provision.protocol,
          subdomain: provision.subdomain, remotePort: provision.remote_port })
        await this.refreshRemote(); this.monitorRemote()
      } else await this.tunnel.start()
      await this.workspaceReady
      await this.runtime.prepare()
    } catch (err: any) { this.lastError = err.message || '节点连接恢复失败' }
  }

  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.remoteStatusTimer)
    await this.queue.catch(() => {})
    await this.runtime.close()
    await this.tunnel.close()
  }
}

/** Authenticate first, then parse a small JSON object; no long client body occupies memory pre-auth. */
async function readSettings(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-encoding'] || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw Object.assign(new Error('请使用 JSON 请求'), { status: 415 })
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16_384) throw Object.assign(new Error('节点配置过大'), { status: 413 })
    chunks.push(Buffer.from(chunk))
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error()
    return value
  } catch { throw Object.assign(new Error('节点配置 JSON 无效'), { status: 400 }) }
}

export function registerNodeOnboardingRoutes(router: HttpRouter, config: WebServiceConfig,
  keys: ApiKeyStore, node: NodeOnboarding): void {
  router.get('/node-connection/local-token', (req, res) => {
    res.removeHeader('Access-Control-Allow-Origin')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    const token = node.localSetupToken(req)
    sendJson(res, token ? 200 : 403, token ? { ok: true, data: { token } } : { ok: false, error: '请在这台机器的 DSH 界面中登录绑定，或使用管理令牌' })
  }, { auth: 'admin' })
  const register = (method: 'GET' | 'POST', endpoint: string, action: (req: IncomingMessage) => Promise<unknown>): void => {
    router.add(method, '/node-connection' + endpoint, async (req, res) => {
      if (!(endpoint !== '/connect' && endpoint !== '/pairing' && node.localSetupAuthorized(req))
        && await rejectAdmin(req, res, keys, config)) return
      try { sendJson(res, 200, { ok: true, data: await action(req) }) }
      catch (err: any) {
        sendJson(res, err.status || 400, { ok: false, code: err.code || 'NODE_CONNECTION_FAILED', error: err.message || '节点连接失败' })
      }
    }, { auth: 'admin', deferBody: method === 'POST' })
  }
  register('GET', '', () => node.status())
  register('POST', '/login', async req => node.loginAndBind(await readSettings(req) as unknown as WorkBuddyLogin))
  register('POST', '/bind', () => node.loginAndBind())
  register('POST', '/connect', async req => {
    const settings = await readSettings(req)
    return node.connect(settings as unknown as OnenatTunnelSettings)
  })
  register('POST', '/pairing', () => node.connect())
  register('POST', '/stop', () => node.stop())
  register('POST', '/workspace', async req => node.saveWorkspace(await readSettings(req)))
  register('POST', '/forget-password', () => node.forgetPassword())
  register('GET', '/fs-dirs', req => node.listDirectories(req.url))
  register('GET', '/onenat/update', () => node.checkOnenatUpdate())
  register('POST', '/onenat/upgrade', async req => {
    const body = await readSettings(req).catch(() => ({}) as Record<string, unknown>)
    return node.upgradeOnenat(body.force === true)
  })
  register('GET', '/onenat/logs', () => node.onenatLogs())
}
