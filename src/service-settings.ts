/**
 * dsh-web-service - 独立 API 服务设置（端口 / 监听范围 / 期望运行状态）
 *
 * 设置与 API Key 一样属于插件自身数据，落在 <dshHome>/dsh-web-service/service-settings.json，
 * 与 api-keys.json 同目录、同持久化约定：单文件 JSON + 内存缓存 + 原子替换（tmp + rename，0600）。
 *
 * 为什么不写回 cordis 配置：cordis.patch.yml 由 profile 加载器拥有，插件运行期改写
 * 会在下次加载被覆盖，也污染用户的补丁层。
 *
 * 语义（v0.5.0 起）：
 *   - port：监听端口。0 = 尚未分配，首次启动时自动分配一个空闲端口并落盘。
 *   - bindIp：监听范围。127.0.0.1（默认，仅本机）或 0.0.0.0（局域网可达）。
 *   - autoStart：期望运行状态。true = DSH 启动时自动拉起服务；false = 用户主动停止，
 *     下次启动保持停止（端口与监听范围仍保留，一键即可重新启动）。
 *
 * 兼容旧版持久化：旧文件只有 { fixedPort, bindIp }，读取时迁移为
 *   port = fixedPort、autoStart = fixedPort > 0（旧语义正是「有固定端口就自动监听」）。
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveDshHome } from './api-keys-store.js'

/** 独立服务监听范围：仅这两个值（校验在 normalizeBindIp） */
export type BindIp = '127.0.0.1' | '0.0.0.0'

export const BIND_IP_LOOPBACK: BindIp = '127.0.0.1'
export const BIND_IP_ALL: BindIp = '0.0.0.0'

/** 首次启动自动分配端口时优先尝试的起始端口（31800-31899，避开常见开发端口） */
export const DEFAULT_PORT = 31800
/** 自动分配端口的扫描长度；全部占用时回退系统临时端口 */
export const PORT_SCAN_LIMIT = 100

/** bindIp 合法值校验：仅 '127.0.0.1' / '0.0.0.0'（容忍首尾空白）；非法返回 null */
export function normalizeBindIp(v: unknown): BindIp | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (s === BIND_IP_LOOPBACK || s === BIND_IP_ALL) return s
  return null
}

export interface ServiceSettings {
  /** 监听端口；0 = 尚未分配（首次启动自动分配） */
  port: number
  /** 监听范围；默认 127.0.0.1 */
  bindIp: BindIp
  /** 期望运行状态：true = 随 DSH 启动自动拉起 */
  autoStart: boolean
  updatedAt?: number
}

/** 设置补丁（只写提供的字段，未提供字段保持原值） */
export interface ServiceSettingsPatch {
  port?: number
  bindIp?: BindIp
  autoStart?: boolean
}

export interface ServiceSettingsStoreOptions {
  dshHome?: string
}

/** 独立 API 服务状态（设置页与 GET /api-keys/service 共用） */
export interface ServiceState {
  /** 当前是否在监听 */
  running: boolean
  /** 配置端口（0 = 尚未分配） */
  port: number
  /** 配置的监听范围 */
  bindIp: BindIp
  /** 实际监听端口；未运行时为 0（自动分配后与 port 一致） */
  listeningPort: number
  /** DSH 主 webserver 端口（随启动变化，仅作对照） */
  mainPort: number
  /** 本机局域网 IPv4（非回环、去重） */
  lanIps: string[]
  /** 运行中时可直接访问的服务地址（含 /api/v1 前缀）；未运行时为空数组 */
  urls: string[]
  /** 是否暴露到局域网（运行中且监听 0.0.0.0） */
  exposedToLan: boolean
  /** 期望运行状态：false 表示用户主动停止，重载插件后不会自动启动 */
  autoStart: boolean
  /** 最近一次启动失败原因（如端口被占用） */
  error?: string
}

export class ServiceSettingsStore {
  readonly file: string

  private cache: ServiceSettings | undefined
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options: ServiceSettingsStoreOptions = {}) {
    const dir = path.join(resolveDshHome(options.dshHome), 'dsh-web-service')
    this.file = path.join(dir, 'service-settings.json')
  }

  /** 读当前设置（文件缺失/损坏按「首次安装」处理，绝不抛错阻塞启动） */
  public async get(): Promise<ServiceSettings> {
    if (this.cache) return this.cache
    let parsed: ServiceSettings | undefined
    try {
      const raw = await readFile(this.file, 'utf8')
      const json = JSON.parse(raw)
      if (json && typeof json === 'object') {
        parsed = migrate(json)
      }
    } catch {
      /* 缺失或损坏都按首次安装处理 */
    }
    this.cache = parsed || { port: 0, bindIp: BIND_IP_LOOPBACK, autoStart: true }
    return this.cache
  }

  /** 同步视图：启动路径已 get() 过后使用（未加载过时返回默认值） */
  public peek(): ServiceSettings {
    return this.cache || { port: 0, bindIp: BIND_IP_LOOPBACK, autoStart: true }
  }

  /**
   * 补丁式保存：只写提供的字段，未提供字段保持原值。
   * 非法值按「不修改」处理（端口非法保持原值，bindIp 非法保持原值）。
   */
  public async set(patch: ServiceSettingsPatch): Promise<ServiceSettings> {
    const cur = this.peek()
    const next: ServiceSettings = { ...cur }
    if (patch.port !== undefined && normalizePort(patch.port)) next.port = patch.port
    if (patch.bindIp !== undefined) {
      const bindIp = normalizeBindIp(patch.bindIp)
      if (bindIp) next.bindIp = bindIp
    }
    if (patch.autoStart !== undefined) next.autoStart = patch.autoStart === true
    next.updatedAt = Date.now()
    // 串行化读-改-写：并发提交时按到达顺序落盘，后写胜出与内存 cache 一致
    const run = this.writeQueue.then(() => this.persist(next))
    this.writeQueue = run.then(() => undefined, () => undefined)
    await run
    this.cache = next
    return next
  }

  private async persist(next: ServiceSettings): Promise<void> {
    const dir = path.dirname(this.file)
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(tmp, this.file)
    await chmod(this.file, 0o600).catch(() => undefined)
  }
}

/** 旧文件迁移：{ fixedPort, bindIp } → { port, bindIp, autoStart }；非法值归一 */
function migrate(json: Record<string, unknown>): ServiceSettings {
  const bindIp = normalizeBindIp(json.bindIp) || BIND_IP_LOOPBACK
  const rawPort = typeof json.port === 'number' ? json.port : json.fixedPort
  const port = normalizePort(rawPort) ? Number(rawPort) : 0
  // 旧语义：有固定端口 = 期望自动监听；旧文件 fixedPort=0 视为用户关闭过
  const legacy = 'fixedPort' in json && !('autoStart' in json)
  const autoStart = typeof json.autoStart === 'boolean' ? json.autoStart : legacy ? port > 0 : true
  return { port, bindIp, autoStart }
}

/** 端口合法性：0（未分配）或 1024-65535（<1024 需特权，DSH 以普通用户运行必失败） */
export function normalizePort(v: unknown): boolean {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isInteger(n) && (n === 0 || (n >= 1024 && n <= 65535))
}
