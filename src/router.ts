/**
 * @dsh-external/dsh-web-service - HTTP Router & Dispatcher
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiResponse, WebServiceConfig } from './types.js'

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  query: Record<string, string>,
  body: any,
) => void | Promise<void>

export interface RouteEntry {
  method: string
  pattern: RegExp
  paramNames: string[]
  handler: RouteHandler
}

export class HttpRouter {
  private routes: RouteEntry[] = []

  constructor(private config: WebServiceConfig) {}

  add(method: string, pathPattern: string, handler: RouteHandler): void {
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
    })
  }

  get(pathPattern: string, handler: RouteHandler): void {
    this.add('GET', pathPattern, handler)
  }

  post(pathPattern: string, handler: RouteHandler): void {
    this.add('POST', pathPattern, handler)
  }

  put(pathPattern: string, handler: RouteHandler): void {
    this.add('PUT', pathPattern, handler)
  }

  patch(pathPattern: string, handler: RouteHandler): void {
    this.add('PATCH', pathPattern, handler)
  }

  delete(pathPattern: string, handler: RouteHandler): void {
    this.add('DELETE', pathPattern, handler)
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

    // 鉴权拦截 (除了文档和 openapi)
    const isPublic = targetPath === '/docs' || targetPath === '/openapi.json' || targetPath === '/'
    if (!isPublic && this.config.apiKey) {
      const authHeader = req.headers['authorization'] || ''
      const xApiKey = req.headers['x-api-key']
      let token = ''
      if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7).trim()
      } else if (typeof xApiKey === 'string') {
        token = xApiKey.trim()
      }

      if (token !== this.config.apiKey) {
        sendJson(res, 401, {
          ok: false,
          error: 'Unauthorized: Invalid or missing API key',
          code: 'UNAUTHORIZED',
        })
        return true
      }
    }

    // 读取并解析 Body（针对 POST/PUT/PATCH）
    let body: any = null
    if (['POST', 'PUT', 'PATCH'].includes(reqMethod)) {
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, Accept')
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
