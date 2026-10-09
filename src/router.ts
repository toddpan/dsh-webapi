/**
 * dsh-web-service - HTTP Router & Dispatcher
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { ApiResponse, WebServiceConfig } from './types.js'

/** 常量时间字符串比较（未注入多 Key 鉴权服务时的回落路径用） */
function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  query: Record<string, string>,
  body: any,
) => void | Promise<void>

/**
 * 鉴权模式：
 * - public：免鉴权（文档、OpenAPI、设置页 HTML 等不含密钥的只读页面）
 * - data：  数据面鉴权（普通 API Key，多 Key ∪ 遗留 config.apiKey）
 * - admin： 跳过数据面闸门，由 handler 自行做管理面鉴权（admin token）
 */
export type RouteAuthMode = 'public' | 'data' | 'admin'

export interface RouteEntry {
  method: string
  pattern: RegExp
  paramNames: string[]
  handler: RouteHandler
  /** true = 跳过 JSON 解析，把原始请求体 Buffer 交给 handler（文件上传用） */
  rawBody?: boolean
  /** 鉴权模式，默认 data */
  auth?: RouteAuthMode
}

export interface RouteOptions {
  rawBody?: boolean
  auth?: RouteAuthMode
}

/** 数据面鉴权服务（由 api-keys-store 提供；未注入时回落到单 config.apiKey 比对） */
export interface AuthServiceLike {
  isEnforced(): boolean
  verifyDataToken(token: string): { ok: boolean; keyId?: string }
  touch(keyId: string): void
}

export class HttpRouter {
  private routes: RouteEntry[] = []
  private auth: AuthServiceLike | null = null

  constructor(private config: WebServiceConfig) {}

  /** 注入多 Key 鉴权服务 */
  setAuthService(auth: AuthServiceLike): void {
    this.auth = auth
  }

  add(method: string, pathPattern: string, handler: RouteHandler, options?: RouteOptions): void {
    const paramNames: string[] = []
    // 转换形如 /workspaces/:id/sessions 为正则表达式
    const regexStr = pathPattern
      .replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
        paramNames.push(name)
        return '([^/]+)'
      })
      .replace(/\//g, '\\/')

    const pattern = new RegExp(`^${regexStr}$`)
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      paramNames,
      handler,
      rawBody: options?.rawBody,
      auth: options?.auth,
    })
  }

  get(pathPattern: string, handler: RouteHandler, options?: RouteOptions): void {
    this.add('GET', pathPattern, handler, options)
  }

  post(pathPattern: string, handler: RouteHandler, options?: RouteOptions): void {
    this.add('POST', pathPattern, handler, options)
  }

  put(pathPattern: string, handler: RouteHandler, options?: RouteOptions): void {
    this.add('PUT', pathPattern, handler, options)
  }

  patch(pathPattern: string, handler: RouteHandler, options?: RouteOptions): void {
    this.add('PATCH', pathPattern, handler, options)
  }

  delete(pathPattern: string, handler: RouteHandler, options?: RouteOptions): void {
    this.add('DELETE', pathPattern, handler, options)
  }

  async dispatch(req: IncomingMessage, res: ServerResponse, basePath: string = ''): Promise<boolean> {
    const url = req.url || '/'
    let pathname: string
    let queryString = ''
    try {
      const parsedUrl = new URL(url, `http://${req.headers.host || 'localhost'}`)
      pathname = parsedUrl.pathname
      queryString = parsedUrl.search
    } catch {
      pathname = url.split('?')[0] || '/'
      queryString = url.includes('?') ? url.substring(url.indexOf('?')) : ''
    }

    // 剥离 basePath 前缀（如果匹配）
    let targetPath = pathname
    if (basePath && targetPath.startsWith(basePath)) {
      targetPath = targetPath.slice(basePath.length)
      if (!targetPath.startsWith('/')) targetPath = '/' + targetPath
    }

    // 处理 CORS 跨域
    if (this.config.cors !== false) {
      this.setCorsHeaders(req, res)
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return true
      }
    }

    // 匹配路由
    const reqMethod = (req.method || 'GET').toUpperCase()
    let matchedRoute: RouteEntry | null = null
    let matchedParams: Record<string, string> = {}

    for (const route of this.routes) {
      if (route.method !== reqMethod && route.method !== 'ALL') continue
      const match = targetPath.match(route.pattern)
      if (match) {
        matchedRoute = route
        route.paramNames.forEach((name, i) => {
          matchedParams[name] = decodeURIComponent(match[i + 1] || '')
        })
        break
      }
    }

    if (!matchedRoute) {
      return false
    }

    // 解析 Query
    const query: Record<string, string> = {}
    if (queryString) {
      const searchParams = new URLSearchParams(queryString)
      for (const [key, val] of searchParams.entries()) {
        query[key] = val
      }
    }

    // 鉴权拦截：按路由声明的模式执行，默认 data
    const authMode: RouteAuthMode = matchedRoute.auth || 'data'
    const isPublic =
      authMode === 'public' ||
      // 兼容旧行为：这三条始终公开
      targetPath === '/docs' ||
      targetPath === '/openapi.json' ||
      targetPath === '/'

    if (authMode === 'data' && !isPublic) {
      const enforced = this.auth ? this.auth.isEnforced() : Boolean(this.config.apiKey)
      if (enforced) {
        const authHeader = req.headers['authorization'] || ''
        const xApiKey = req.headers['x-api-key']
        let token = ''
        if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
          token = authHeader.slice(7).trim()
        } else if (typeof xApiKey === 'string') {
          token = xApiKey.trim()
        }

        const verdict = this.auth
          ? this.auth.verifyDataToken(token)
          : { ok: timingSafeEqualString(token, this.config.apiKey || ''), keyId: undefined }

        if (!verdict.ok) {
          sendJson(res, 401, {
            ok: false,
            error: 'Unauthorized: Invalid or missing API key',
            code: 'UNAUTHORIZED',
          })
          return true
        }
        if (verdict.keyId && this.auth) this.auth.touch(verdict.keyId)
      }
    }
    // auth === 'admin'：跳过数据面闸门，由 handler 内部做管理面鉴权（admin token）

    // 读取并解析 Body（针对 POST/PUT/PATCH）
    let body: any = null
    if (['POST', 'PUT', 'PATCH'].includes(reqMethod)) {
      if (matchedRoute.rawBody) {
        // 文件上传等原始体路由：整包读入 Buffer（上限取 maxUploadBytes 配置）
        try {
          body = await readRawBody(req, this.config.maxUploadBytes || 2 * 1024 * 1024 * 1024)
        } catch (err: any) {
          sendJson(res, err?.message?.includes('too large') ? 413 : 400, {
            ok: false,
            error: err?.message || 'Failed to read request body',
            code: err?.message?.includes('too large') ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
          })
          return true
        }
      } else {
        try {
          body = await readJsonBody(req)
        } catch (err: any) {
          sendJson(res, 400, {
            ok: false,
            error: `Invalid JSON body: ${err.message}`,
            code: 'BAD_REQUEST',
          })
          return true
        }
      }
    }

    // 执行业务 Handler
    try {
      await matchedRoute.handler(req, res, matchedParams, query, body)
    } catch (err: any) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          ok: false,
          error: err?.message || 'Internal Server Error',
          code: 'INTERNAL_ERROR',
        })
      }
    }

    return true
  }

  private setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers['origin'] || '*'
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Admin-Token, Accept')
    res.setHeader('Access-Control-Max-Age', '86400')
  }
}

/** 发送 JSON 格式响应 */
export function sendJson<T>(res: ServerResponse, statusCode: number, payload: ApiResponse<T>): void {
  if (res.headersSent) return
  payload.timestamp = Date.now()
  const data = JSON.stringify(payload)
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(data))
  res.end(data)
}

/** 读取请求体为 JSON */
export function readJsonBody(req: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalLength = 0

    req.on('data', (chunk: Buffer) => {
      totalLength += chunk.length
      if (totalLength > maxBytes) {
        req.destroy()
        reject(new Error(`Payload too large (> ${maxBytes} bytes)`))
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      const raw = Buffer.concat(chunks).toString('utf-8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (e: any) {
        reject(new Error(`Failed to parse JSON: ${e.message}`))
      }
    })

    req.on('error', (err) => {
      reject(err)
    })
  })
}

/** 读取请求体为原始 Buffer（文件上传用） */
export function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalLength = 0

    req.on('data', (chunk: Buffer) => {
      totalLength += chunk.length
      if (totalLength > maxBytes) {
        req.destroy()
        reject(new Error(`Payload too large (> ${maxBytes} bytes)`))
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      resolve(Buffer.concat(chunks))
    })

    req.on('error', (err) => {
      reject(err)
    })
  })
}

/** 开启 SSE 流式通道 */
export function initSseStream(res: ServerResponse): {
  send: (event: string, data: any) => void
  close: () => void
} {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // 禁用 Nginx 缓冲
  res.flushHeaders?.()

  return {
    send(event: string, data: any) {
      if (res.writableEnded) return
      const text = typeof data === 'string' ? data : JSON.stringify(data)
      res.write(`event: ${event}\ndata: ${text}\n\n`)
    },
    close() {
      if (!res.writableEnded) {
        res.end()
      }
    },
  }
}
