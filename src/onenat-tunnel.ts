import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

const RELEASE_REPO = 'toddpan/onenat'
const MAX_ASSET_BYTES = 100 * 1024 * 1024
export type OnenatProtocol = 'https' | 'tcp'
export interface OnenatTunnelSettings {
  serverUrl: string
  username: string
  password: string
  name: string
  subdomain?: string
  remotePort?: number
  protocol?: OnenatProtocol
  autoStart?: boolean
}
export interface OnenatManagedInput {
  config: string
  clientId: string
  mappingId: string
  tunnelId: string
  serverUrl?: string
  name?: string
  protocol?: OnenatProtocol
  subdomain?: string
  remotePort?: number
  autoStart?: boolean
}
export interface OnenatRemoteState { online?: boolean; public_url?: string; error?: string }
export interface OnenatTunnelState {
  configured: boolean
  /** true when the WorkBuddy account flow supplies a managed, credential-scoped tunnel. */
  managed: boolean
  installed: boolean
  running: boolean
  phase: 'stopped' | 'installing' | 'connecting' | 'online' | 'error'
  clientId: string
  serverUrl: string
  name: string
  protocol: OnenatProtocol
  subdomain: string
  remotePort: number
  localPort: number
  tunnelId?: string
  mappingId?: string
  publicUrl?: string
  origin?: string
  error?: string
  releaseTag?: string
  startedAt?: number
  restarts: number
  binaryPath?: string
  settings: Omit<OnenatTunnelSettings, 'password'> & { passwordSet: boolean }
}
interface PrivateState {
  clientId: string
  settings?: OnenatTunnelSettings
  managed?: Omit<OnenatManagedInput, 'config'>
}
export interface OnenatTunnelOptions {
  dir: string
  onLocalPort: () => number
  log?: (message: string) => void
  /** Dependency injection for isolated HTTP/process tests. */
  fetch?: typeof globalThis.fetch
  spawnClient?: (binary: string, args: string[]) => ChildProcess
  platform?: string
  arch?: string
}

/** Asset names match ONENAT's Makefile release-clients and GitHub Releases. */
export function onenatReleaseAsset(platform = process.platform as string, arch = process.arch as string): string {
  const os = ({ darwin: 'darwin', linux: 'linux', win32: 'windows' } as Record<string, string>)[platform]
  const cpu = ({ x64: 'amd64', arm64: 'arm64', arm: 'arm' } as Record<string, string>)[arch]
  if (!os || !cpu || (cpu === 'arm' && os !== 'linux')) throw new Error('ONENAT 不支持当前平台：' + platform + '/' + arch)
  return 'onenat-client_' + os + '_' + cpu + (os === 'windows' ? '.exe' : '')
}

/** 比较 v1.2.3 / r2026.11.16 形态的 release tag；解析失败的一方视为更旧（宁可漏报升级也不误报），预发布排在正式版之前。 */
export function compareVersionTags(a: string, b: string): number {
  const parse = (tag: string): { parts: number[]; pre?: string } | null => {
    const match = /^v?r?(\d+(?:\.\d+)*)(?:[-+](.*))?$/i.exec(String(tag).trim())
    return match ? { parts: match[1].split('.').map(Number), pre: match[2] || undefined } : null
  }
  const left = parse(a)
  const right = parse(b)
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1
  const width = Math.max(left.parts.length, right.parts.length)
  for (let i = 0; i < width; i++) {
    const x = left.parts[i] ?? 0
    const y = right.parts[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  if (!!left.pre !== !!right.pre) return left.pre ? -1 : 1
  return 0
}

/** GitHub API 优先，限流时退回 releases/latest 的 HTML 重定向。 */
async function latestReleaseTag(fetcher: typeof globalThis.fetch): Promise<string> {
  try {
    const response = await fetcher('https://api.github.com/repos/' + RELEASE_REPO + '/releases/latest', { signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-web-service-onenat' } })
    if (response.ok) return String((await response.json() as { tag_name?: string }).tag_name ?? '')
  } catch { /* GitHub's HTML redirect remains usable when the API is rate limited. */ }
  const response = await fetcher('https://github.com/' + RELEASE_REPO + '/releases/latest', { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error('无法查询 ONENAT GitHub Release：HTTP ' + response.status)
  const match = /^https:\/\/github\.com\/toddpan\/onenat\/releases\/tag\/([^/?#]+)$/.exec(response.url)
  await response.body?.cancel()
  if (!match) throw new Error('ONENAT GitHub latest 未返回有效的 release tag')
  return decodeURIComponent(match[1])
}
function checksumFor(text: string, asset: string): string {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-fA-F0-9]{64})\s+[*]?(.+)$/.exec(line.trim())
    if (m && m[2].replace(/^\.\//, '') === asset) return m[1].toLowerCase()
  }
  throw new Error('ONENAT checksums.txt 未包含 ' + asset)
}
async function bodyBytes(response: Response, max: number): Promise<Buffer> {
  if (!response.ok) throw new Error('下载 ONENAT 失败：HTTP ' + response.status)
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > max) throw new Error('ONENAT 下载文件超过大小限制')
  if (!response.body) throw new Error('ONENAT 下载响应为空')
  const reader = response.body.getReader()
  let length = 0
  const chunks: Buffer[] = []
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > max) throw new Error('ONENAT 下载文件超过大小限制')
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel().catch(() => {}) }
  return Buffer.concat(chunks)
}
async function privateWrite(file: string, content: string | Buffer, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + randomBytes(6).toString('hex') + '.tmp'
  try {
    await fs.writeFile(temporary, content, { mode, flag: 'wx' })
    await fs.rename(temporary, file)
    await fs.chmod(file, mode)
  } finally { await fs.unlink(temporary).catch(() => {}) }
}

async function downloadBytes(fetcher: typeof globalThis.fetch, url: string, timeoutMs: number, maxBytes: number): Promise<Buffer> {
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await bodyBytes(await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) }), maxBytes)
    } catch (error) {
      last = error
      await new Promise(resolve => setTimeout(resolve, 1_000 * (attempt + 1)))
    }
  }
  throw last
}
export async function installOnenatClient(options: Pick<OnenatTunnelOptions, 'dir' | 'fetch' | 'platform' | 'arch'> & { refresh?: boolean }): Promise<{ binary: string; releaseTag: string }> {
  const fetcher = options.fetch ?? globalThis.fetch
  const asset = onenatReleaseAsset(options.platform, options.arch)
  const binary = path.join(options.dir, asset)
  const manifestFile = path.join(options.dir, 'installed.json')
  if (!options.refresh) {
    try {
      const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as { asset: string; sha256: string; releaseTag: string }
      const bytes = await fs.readFile(binary)
      if (manifest.asset === asset && /^[a-f0-9]{64}$/.test(manifest.sha256) && createHash('sha256').update(bytes).digest('hex') === manifest.sha256) {
        await fs.chmod(binary, 0o700)
        return { binary, releaseTag: manifest.releaseTag }
      }
    } catch { /* Install only after verified cache lookup failed. */ }
  }
  const releaseTag = await latestReleaseTag(fetcher)
  if (!/^[a-zA-Z0-9._-]+$/.test(releaseTag)) throw new Error('ONENAT GitHub release tag 无效')
  const base = 'https://github.com/' + RELEASE_REPO + '/releases/download/' + encodeURIComponent(releaseTag) + '/'
  const sums = await downloadBytes(fetcher, base + 'checksums.txt', 30_000, 2 * 1024 * 1024)
  const expected = checksumFor(sums.toString('utf8'), asset)
  const bytes = await downloadBytes(fetcher, base + asset, 90_000, MAX_ASSET_BYTES)
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('ONENAT 客户端 SHA256 校验失败，未安装')
  await privateWrite(binary, bytes, 0o700)
  await privateWrite(manifestFile, JSON.stringify({ asset, releaseTag, sha256: expected }))
  return { binary, releaseTag }
}

function cleanServerUrl(value: string): string {
  const url = new URL(value)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) throw new Error('ONENAT 服务地址必须使用 HTTPS')
  if (url.username || url.password || url.search || url.hash) throw new Error('ONENAT 服务地址不能包含账号、参数或片段')
  return url.href.replace(/\/+$/, '')
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** Owns the binary, credentials/config and the child process behind one small interface. */
export class OnenatTunnel {
  private readonly opts: OnenatTunnelOptions
  private readonly fetcher: typeof globalThis.fetch
  private readonly ready: Promise<void>
  private readonly file: string
  private readonly configFile: string
  private saved: PrivateState = { clientId: randomBytes(18).toString('hex') }
  private child?: ChildProcess
  private binary?: string
  private releaseTag?: string
  private startedAt?: number
  private restarts = 0
  private readonly logs: string[] = []
  private phase: OnenatTunnelState['phase'] = 'stopped'
  private lastError?: string
  private publicUrl?: string
  private origin?: string
  private cookie?: string
  private operation: Promise<unknown> = Promise.resolve()
  private restart?: ReturnType<typeof setTimeout>
  private stopped = true
  private closed = false
  private retries = 0

  constructor(options: OnenatTunnelOptions) {
    this.opts = options; this.fetcher = options.fetch ?? globalThis.fetch
    this.file = path.join(options.dir, 'private.json'); this.configFile = path.join(options.dir, 'managed.yml')
    this.ready = this.load()
  }
  private async load(): Promise<void> {
    await fs.mkdir(this.opts.dir, { recursive: true, mode: 0o700 })
    await fs.chmod(this.opts.dir, 0o700)
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8')) as PrivateState
      if (!/^[a-zA-Z0-9_-]{16,80}$/.test(saved.clientId)) throw new Error('invalid client_id')
      this.saved = saved
      await fs.chmod(this.file, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('ONENAT 私有配置损坏；请检查后重试')
      await this.save()
    }
    const asset = onenatReleaseAsset(this.opts.platform, this.opts.arch)
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(this.opts.dir, 'installed.json'), 'utf8')) as { asset: string; sha256: string; releaseTag: string }
      const binary = path.join(this.opts.dir, asset)
      if (manifest.asset === asset && createHash('sha256').update(await fs.readFile(binary)).digest('hex') === manifest.sha256) { this.binary = binary; this.releaseTag = manifest.releaseTag }
    } catch { /* Not installed yet. */ }
  }
  private save(): Promise<void> { return privateWrite(this.file, JSON.stringify(this.saved, null, 2) + '\n') }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const pending = this.operation.then(() => this.ready).then(fn)
    this.operation = pending.catch(() => {})
    return pending
  }
  private sanitize(message: string): string {
    const password = this.saved.settings?.password
    if (password) message = message.split(password).join('[redacted]')
    return message.replace(/ngk-[a-zA-Z0-9-]+/g, '[redacted]').replace(/(authtoken|password|cookie)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]')
  }
  private fail(error: unknown): void { this.lastError = this.sanitize(errorText(error)); this.phase = 'error'; this.origin = undefined; this.publicUrl = undefined }
  private view(): OnenatTunnelState {
    const direct = this.saved.settings
    const managed = this.saved.managed
    const protocol = managed?.protocol ?? direct?.protocol ?? 'https'
    const serverUrl = managed?.serverUrl ?? direct?.serverUrl ?? ''
    const name = managed?.name ?? direct?.name ?? ''
    const subdomain = managed?.subdomain ?? direct?.subdomain ?? ''
    const remotePort = managed?.remotePort ?? direct?.remotePort ?? 0
    return {
      configured: !!managed || !!direct, managed: !!managed, installed: !!this.binary, running: !!this.child && this.child.exitCode === null && !this.child.killed,
      phase: this.phase, clientId: this.saved.clientId, serverUrl, name, protocol, subdomain, remotePort,
      localPort: this.opts.onLocalPort(), tunnelId: managed?.tunnelId, mappingId: managed?.mappingId,
      publicUrl: this.publicUrl, origin: this.origin, error: this.lastError, releaseTag: this.releaseTag,
      startedAt: this.startedAt, restarts: this.restarts, binaryPath: this.binary,
      settings: { serverUrl, username: direct?.username ?? '', name, protocol, subdomain, remotePort, autoStart: managed?.autoStart ?? direct?.autoStart ?? true, passwordSet: !!direct?.password },
    }
  }
  async status(): Promise<OnenatTunnelState> { await this.ready; return this.view() }
  private async install(): Promise<void> {
    if (this.binary) return
    this.phase = 'installing'
    const installed = await installOnenatClient({ ...this.opts, fetch: this.fetcher })
    this.binary = installed.binary; this.releaseTag = installed.releaseTag
  }
  private async terminate(): Promise<void> {
    if (this.restart) clearTimeout(this.restart)
    this.restart = undefined
    const child = this.child; this.child = undefined
    if (!child || child.exitCode !== null) return
    await new Promise<void>(resolve => {
      const kill = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3_000)
      kill.unref()
      child.once('exit', () => { clearTimeout(kill); resolve() })
      child.kill('SIGTERM')
    })
  }
  /** 环形日志缓冲：供设置页 oneNat 客户端 TAB 展示最近输出。 */
  private pushLog(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      this.logs.push(line.slice(0, 500))
    }
    if (this.logs.length > 120) this.logs.splice(0, this.logs.length - 120)
  }
  tailLogs(limit = 80): string[] { return this.logs.slice(-limit) }
  async checkUpdate(): Promise<{ installed: boolean; current: string; latest: string; updateAvailable: boolean }> {
    await this.ready
    const latest = await latestReleaseTag(this.fetcher)
    const current = this.releaseTag ?? ''
    return { installed: !!this.binary, current, latest,
      updateAvailable: !!this.binary && !!latest && compareVersionTags(latest, current) > 0 }
  }
  /** 升级 = 强制重新安装最新 release；校验通过前旧二进制不动，失败时原进程照常恢复。 */
  upgrade(options: { force?: boolean } = {}): Promise<OnenatTunnelState & { noop?: boolean; message?: string }> {
    return this.enqueue(async () => {
      if (this.closed) throw new Error('ONENAT 管理器已关闭')
      if (!this.saved.managed && !this.saved.settings) throw new Error('ONENAT 尚未配置，无需升级客户端')
      const wasRunning = !!this.child
      const latest = await latestReleaseTag(this.fetcher)
      if (!options.force && this.binary && latest && compareVersionTags(latest, this.releaseTag ?? '') <= 0) {
        return { ...this.view(), noop: true, message: '已是最新版本 ' + (this.releaseTag || latest) }
      }
      this.stopped = true
      await this.terminate()
      this.phase = 'installing'
      try {
        const installed = await installOnenatClient({ ...this.opts, fetch: this.fetcher, refresh: true })
        this.binary = installed.binary
        this.releaseTag = installed.releaseTag
        this.retries = 0
        if (wasRunning) this.launch()
        else this.phase = 'stopped'
      } catch (error) {
        this.fail(error)
        if (wasRunning) this.launch()
        throw error
      }
      return this.view()
    })
  }
  private launch(): void {
    if (!this.binary) throw new Error('ONENAT 客户端尚未安装')
    this.stopped = false; this.phase = 'connecting'; this.lastError = undefined; this.publicUrl = undefined; this.origin = undefined
    this.startedAt = Date.now()
    const child = this.opts.spawnClient ? this.opts.spawnClient(this.binary, ['-log=stdout', '-log-level=INFO', '-config=' + this.configFile, 'managed']) : spawn(this.binary, ['-log=stdout', '-log-level=INFO', '-config=' + this.configFile, 'managed'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: this.opts.dir })
    this.child = child
    const log = (chunk: Buffer) => {
      const text = this.sanitize(chunk.toString('utf8').slice(-8_000))
      this.opts.log?.(text)
      this.pushLog(text)
    }
    child.stdout?.on('data', log); child.stderr?.on('data', log)
    child.once('error', error => { if (this.child === child) { this.child = undefined; this.fail(error) } })
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined; this.publicUrl = undefined; this.origin = undefined
      if (this.stopped || this.closed) return
      this.fail(new Error('ONENAT 客户端退出：' + (signal ?? code)))
      this.restarts++
      this.restart = setTimeout(() => { if (!this.stopped && !this.closed) this.launch() }, Math.min(30_000, 1_000 * 2 ** Math.min(this.retries++, 5)))
      this.restart.unref()
    })
  }
  /** The normal WorkBuddy flow: its backend provisions ONENAT; no ONENAT login reaches this plugin. */
  startManaged(input: OnenatManagedInput): Promise<OnenatTunnelState> {
    return this.enqueue(async () => {
      try {
        if (this.closed) throw new Error('ONENAT 管理器已关闭')
        if (!/^[a-zA-Z0-9_-]{16,80}$/.test(input.clientId) || !input.mappingId || !input.tunnelId || !input.config || input.config.length > 64 * 1024) throw new Error('ONENAT 受管配置不完整')
        if (!/^server_addr:\s*.+$/m.test(input.config) || !/^(?:auth_token|authtoken):\s*.+$/m.test(input.config)) throw new Error('ONENAT 受管配置缺少控制地址或隧道凭证')
        this.stopped = true; await this.terminate()
        this.saved.clientId = input.clientId
        const { config, ...managed } = input
        this.saved.managed = { ...managed, protocol: input.protocol ?? 'https' }
        this.saved.settings = undefined; this.cookie = undefined
        await privateWrite(this.configFile, config); await this.save(); await this.install(); this.launch()
      } catch (error) { this.fail(error) }
      return this.view()
    })
  }
  /** Update with authoritative WorkBuddy-proxied ONENAT runtime status. Never synthesize an online URL. */
  updateRemoteState(input: OnenatRemoteState): Promise<OnenatTunnelState> {
    return this.enqueue(async () => {
      if (this.stopped || !this.child) { this.publicUrl = undefined; this.origin = undefined; return this.view() }
      if (input.error) { this.fail(new Error(input.error)); return this.view() }
      if (!input.online || !input.public_url) { this.phase = 'connecting'; this.publicUrl = undefined; this.origin = undefined; return this.view() }
      try {
        const url = new URL(input.public_url)
        if (url.username || url.password || url.search || url.hash || !['https:', 'tcp:'].includes(url.protocol)) throw new Error('ONENAT 返回了不安全或无效的公网 URL')
        if (this.view().protocol === 'https' && url.protocol !== 'https:') throw new Error('ONENAT HTTPS 映射未返回 HTTPS origin')
        if (url.protocol === 'https:') {
          const response = await this.fetcher(url.origin + '/', { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
          await response.body?.cancel()
          if (response.status >= 500) throw new Error('公网 HTTPS 入口尚未就绪：HTTP ' + response.status)
          this.origin = url.origin
        } else this.origin = undefined
        this.publicUrl = url.href.replace(/\/$/, ''); this.phase = 'online'; this.lastError = undefined; this.retries = 0
      } catch (error) { this.fail(error) }
      return this.view()
    })
  }
  /** Advanced direct-ONENAT fallback, not needed by the WorkBuddy account flow. */
  ensure(settings: OnenatTunnelSettings): Promise<OnenatTunnelState> {
    return this.enqueue(async () => {
      try {
        const old = this.saved.settings
        const next = { ...settings, password: settings.password || old?.password || '', serverUrl: cleanServerUrl(settings.serverUrl), protocol: settings.protocol ?? 'https', subdomain: settings.subdomain || old?.subdomain || 'dsh-' + this.saved.clientId.slice(0, 20) }
        if (!next.username || !next.password || !next.name) throw new Error('ONENAT 服务地址、账号、密码和名称必填')
        this.saved.settings = next; this.saved.managed = undefined; await this.save()
        this.stopped = true; await this.terminate(); await this.login()
        const body = await this.api('/api/client/bootstrap', { method: 'POST', body: JSON.stringify({ client_id: this.saved.clientId, name: next.name, protocol: next.protocol, subdomain: next.protocol === 'https' ? next.subdomain : '', remote_port: next.remotePort ?? 0, local_port: this.opts.onLocalPort() }) })
        if (typeof body.config !== 'string' || !body.tunnel_id || !body.mapping_id) throw new Error('ONENAT bootstrap 响应不完整')
        this.saved.managed = { clientId: this.saved.clientId, mappingId: String(body.mapping_id), tunnelId: String(body.tunnel_id), serverUrl: next.serverUrl, name: next.name, protocol: next.protocol, subdomain: String(body.subdomain ?? ''), remotePort: Number(body.remote_port ?? 0) }
        await privateWrite(this.configFile, body.config); await this.save(); await this.install(); this.launch()
      } catch (error) { this.fail(error) }
      return this.view()
    })
  }
  private async login(): Promise<void> {
    const settings = this.saved.settings
    if (!settings) throw new Error('ONENAT 账号尚未配置')
    const response = await this.fetcher(settings.serverUrl + '/api/login', { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: settings.username, password: settings.password }), signal: AbortSignal.timeout(15_000) })
    if (!response.ok) { await response.body?.cancel(); throw new Error('ONENAT 登录失败：HTTP ' + response.status) }
    const cookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? '']
    this.cookie = cookies.map(value => value.split(';')[0]).filter(value => value.startsWith('onenat_dash=')).join('; ')
    await response.body?.cancel()
    if (!this.cookie) throw new Error('ONENAT 登录未返回有效会话')
  }
  private async api(endpoint: string, init: { method?: string; body?: string } = {}): Promise<Record<string, unknown>> {
    if (!this.cookie) await this.login()
    const response = await this.fetcher(this.saved.settings!.serverUrl + endpoint, { ...init, redirect: 'error', headers: { 'Content-Type': 'application/json', Cookie: this.cookie! }, signal: AbortSignal.timeout(15_000) })
    let body: Record<string, unknown>
    try { body = await response.json() as Record<string, unknown> } catch { throw new Error('ONENAT 响应不是有效 JSON；请升级服务端以支持客户端 bootstrap') }
    if (!response.ok) throw new Error('ONENAT：' + (typeof body.error === 'string' ? body.error : 'HTTP ' + response.status))
    return body
  }
  async start(settings?: OnenatTunnelSettings): Promise<OnenatTunnelState> {
    if (settings) return this.ensure(settings)
    return this.enqueue(async () => {
      try {
        if (!this.saved.managed) throw new Error('ONENAT 尚未获得受管配置')
        if (this.closed) throw new Error('ONENAT 管理器已关闭')
        if (!this.child) { await fs.access(this.configFile); await this.install(); this.launch() }
      } catch (error) { this.fail(error) }
      return this.view()
    })
  }
  stop(): Promise<OnenatTunnelState> {
    return this.enqueue(async () => { this.stopped = true; await this.terminate(); this.phase = 'stopped'; this.lastError = undefined; this.publicUrl = undefined; this.origin = undefined; return this.view() })
  }
  async close(): Promise<void> { this.closed = true; await this.stop() }
}
