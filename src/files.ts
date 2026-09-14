/**
 * @dsh-external/dsh-web-service - 会话文件上传
 *
 * POST /sessions/:id/files
 *  - multipart/form-data：支持多文件字段（每个带 filename 的 part 都会保存）
 *  - 其余 Content-Type：按原始字节流处理，文件名取 ?filename= 或 X-Filename 头
 * 文件落盘到该会话的工作区目录（cwd），同名自动追加 -1/-2 后缀，永不覆盖已有文件。
 * 会话 AI 通过 fs 工具即可直接读取（cwd 即其文件工具根目录之一）。
 */

import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, writeFile, appendFile, readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import { sendJson, type HttpRouter } from './router.js'
import type { WebServiceConfig } from './types.js'

export interface UploadedPart {
  name?: string
  filename?: string
  mimeType?: string
  data: Buffer
}

/** 解析 multipart/form-data（无依赖最小实现，满足文件字段提取） */
export function parseMultipart(buffer: Buffer, contentType: string): UploadedPart[] {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (!m) return []
  const boundary = '--' + (m[1] || m[2]).trim()
  const delim = Buffer.from(boundary)
  const parts: UploadedPart[] = []
  let pos = buffer.indexOf(delim)
  while (pos >= 0) {
    const start = pos + delim.length
    // 终止边界 `--boundary--`
    if (buffer.slice(start, start + 2).toString('utf-8') === '--') break
    const headStart = start + 2 // 跳过 \r\n
    const headEnd = buffer.indexOf('\r\n\r\n', headStart)
    if (headEnd < 0) break
    const headerBlock = buffer.slice(headStart, headEnd).toString('utf-8')
    const bodyStart = headEnd + 4
    const next = buffer.indexOf(delim, bodyStart)
    if (next < 0) break
    let bodyEnd = next
    if (buffer.slice(bodyEnd - 2, bodyEnd).toString('utf-8') === '\r\n') bodyEnd -= 2
    const data = buffer.slice(bodyStart, bodyEnd)
    parts.push(parsePartHeaders(headerBlock, data))
    pos = next
  }
  return parts
}

function parsePartHeaders(headerBlock: string, data: Buffer): UploadedPart {
  let name: string | undefined
  let filename: string | undefined
  let mimeType: string | undefined
  for (const line of headerBlock.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (/^content-disposition$/i.test(key)) {
      name = /(?:^|;\s*)name="([^"]*)"/i.exec(value)?.[1] ?? name
      const fnStar = /filename\*=([^;\r\n]+)/i.exec(value)?.[1]
      if (fnStar) {
        // RFC 5987: charset''percent-encoded
        const decoded = /^([^']*)''(.*)$/.exec(fnStar.trim())
        filename = decodeFilename(decoded ? decoded[2] : fnStar.trim())
      }
      if (!filename) {
        const fn = /filename="([^"]*)"/i.exec(value)?.[1] ?? /filename=([^;\r\n]+)/i.exec(value)?.[1]
        if (fn !== undefined) filename = decodeFilename(fn)
      }
    } else if (/^content-type$/i.test(key)) {
      mimeType = value
    }
  }
  return { name, filename, mimeType, data }
}

function decodeFilename(raw: string): string {
  const v = raw.trim().replace(/^"|"$/g, '')
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

/** 清洗文件名：取 basename、去控制字符、限长；非法名回退为 file-<ts> */
export function sanitizeFilename(raw: string | undefined): string {
  let name = String(raw || '').split(/[\\/]/).pop() || ''
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!name || name === '.' || name === '..') name = `file-${Date.now()}`
  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 16)
    name = name.slice(0, 180 - ext.length) + ext
  }
  return name
}

/** 目标路径去重：同名自动 -1/-2 后缀，永不覆盖已有文件 */
function uniqueTarget(dir: string, name: string): string {
  const ext = path.extname(name)
  const stem = path.basename(name, ext)
  let candidate = path.join(dir, name)
  let i = 1
  while (existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${i}${ext}`)
    i += 1
  }
  return candidate
}

/** 解析会话当前工作目录：优先 live session header.cwd，回退 sessionController.inspect */
async function resolveSessionCwd(ctx: Context, sessionId: string): Promise<string | undefined> {
  const sessionsService = ctx.get('sessions') as any
  const live = sessionsService?.get ? sessionsService.get(sessionId) : undefined
  const liveCwd = live?.header?.cwd
  if (typeof liveCwd === 'string' && liveCwd.trim()) return liveCwd
  const sessionController = ctx.get('sessionController') as any
  if (sessionController && typeof sessionController.inspect === 'function') {
    try {
      const inspected = await sessionController.inspect(sessionId, new AbortController().signal)
      const cwd = inspected?.meta?.cwd
      if (typeof cwd === 'string' && cwd.trim()) return cwd
    } catch {
      // 会话不存在或已归档
    }
  }
  return undefined
}

/** 相对路径安全拼接：解析后必须仍位于 cwd 内（防 ../ 越界），否则返回 undefined */
function safeJoin(cwd: string, rel: string): string | undefined {
  const root = path.resolve(cwd)
  const target = path.resolve(root, String(rel || '').replace(/^\//, ''))
  if (target !== root && !target.startsWith(root + path.sep)) return undefined
  return target
}

const MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.json': 'application/json', '.xml': 'application/xml', '.yml': 'text/yaml', '.yaml': 'text/yaml',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.ts': 'text/plain', '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.tar': 'application/x-tar', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
}

function lookupMime(filePath: string): string {
  return MIME_MAP[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

/**
 * GET /sessions/:id/files        — 列出会话工作区目录（?path= 相对子目录）
 * GET /sessions/:id/files/download — 下载文件（?path= 相对路径；?inline=1 浏览器内联预览）
 */
export function registerFileRoutes(ctx: Context, router: HttpRouter, config: WebServiceConfig): void {
  // ---- 目录列表预览 ----
  router.get('/sessions/:id/files', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, query: Record<string, string>) => {
    const sessionId = params.id
    const cwd = await resolveSessionCwd(ctx, sessionId)
    if (!cwd) {
      sendJson(res, 404, { ok: false, error: `Session '${sessionId}' not found or has no workspace cwd`, code: 'NOT_FOUND' })
      return
    }
    const rel = String(query.path || '').trim()
    const target = safeJoin(cwd, rel)
    if (!target) {
      sendJson(res, 400, { ok: false, error: '非法路径：不允许越出会话工作区', code: 'BAD_REQUEST' })
      return
    }
    if (!existsSync(target)) {
      sendJson(res, 404, { ok: false, error: `目录不存在: ${rel || '.'}`, code: 'NOT_FOUND' })
      return
    }
    try {
      const st = await stat(target)
      if (!st.isDirectory()) {
        sendJson(res, 400, { ok: false, error: '该路径是文件，下载请用 /files/download', code: 'BAD_REQUEST' })
        return
      }
      const dirents = await readdir(target, { withFileTypes: true })
      const entries: Array<{ name: string; type: string; size: number; mtime: number; path: string }> = []
      for (const d of dirents) {
        const full = path.join(target, d.name)
        let size = 0
        let mtime = 0
        try {
          const fst = await stat(full)
          size = fst.size
          mtime = Math.round(fst.mtimeMs)
        } catch {
          // 无权限等场景保留 0 值
        }
        const type = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file'
        const relPath = rel ? `${rel.replace(/\/+$/, '')}/${d.name}` : d.name
        entries.push({ name: d.name, type, size, mtime, path: relPath })
      }
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
      sendJson(res, 200, {
        ok: true,
        data: {
          sessionId,
          cwd,
          path: rel || '.',
          count: entries.length,
          entries,
          hint: 'entry.path 为相对会话工作区的路径，可用于本接口 ?path= 逐层浏览或 /files/download 下载',
        },
      })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: `读取目录失败: ${err?.message || err}` })
    }
  })

  // ---- 文件下载 / 内联预览 ----
  router.get('/sessions/:id/files/download', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, query: Record<string, string>) => {
    const sessionId = params.id
    const cwd = await resolveSessionCwd(ctx, sessionId)
    if (!cwd) {
      sendJson(res, 404, { ok: false, error: `Session '${sessionId}' not found or has no workspace cwd`, code: 'NOT_FOUND' })
      return
    }
    const rel = String(query.path || query.name || '').trim()
    if (!rel) {
      sendJson(res, 400, { ok: false, error: '缺少 ?path=（相对会话工作区的文件路径）', code: 'BAD_REQUEST' })
      return
    }
    const target = safeJoin(cwd, rel)
    if (!target) {
      sendJson(res, 400, { ok: false, error: '非法路径：不允许越出会话工作区', code: 'BAD_REQUEST' })
      return
    }
    if (!existsSync(target)) {
      sendJson(res, 404, { ok: false, error: `文件不存在: ${rel}`, code: 'NOT_FOUND' })
      return
    }
    try {
      const st = await stat(target)
      if (st.isDirectory()) {
        sendJson(res, 400, { ok: false, error: '该路径是目录，请用 GET /sessions/:id/files 列表接口', code: 'BAD_REQUEST' })
        return
      }
      const name = path.basename(target)
      const inline = query.inline === '1' || query.inline === 'true'
      res.statusCode = 200
      res.setHeader('Content-Type', lookupMime(target))
      res.setHeader('Content-Length', String(st.size))
      res.setHeader('X-Content-Type-Options', 'nosniff')
      const asciiFallback = name.replace(/[^\x20-\x7e]/g, '_') || 'download'
      res.setHeader(
        'Content-Disposition',
        `${inline ? 'inline' : 'attachment'}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      const stream = createReadStream(target)
      stream.on('error', (err) => {
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: `读取文件失败: ${err?.message || err}` })
        } else {
          res.destroy()
        }
      })
      stream.pipe(res)
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: `读取文件失败: ${err?.message || err}` })
    }
  })

  // ---- 上传 ----
  router.post(
    '/sessions/:id/files',
    async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, query: Record<string, string>, body: any) => {
      const sessionId = params.id
      const contentType = String(_req.headers['content-type'] || '')
      const buffer: Buffer = Buffer.isBuffer(body) ? body : Buffer.alloc(0)
      const maxBytes = config.maxUploadBytes || 2 * 1024 * 1024 * 1024

      if (buffer.length === 0) {
        sendJson(res, 400, { ok: false, error: '请求体为空：请以 multipart/form-data 或原始字节流上传文件', code: 'BAD_REQUEST' })
        return
      }
      if (buffer.length > maxBytes) {
        sendJson(res, 413, { ok: false, error: `Payload too large (> ${maxBytes} bytes)`, code: 'PAYLOAD_TOO_LARGE' })
        return
      }

      // 收集待保存文件
      let files: Array<{ filename: string; mimeType?: string; data: Buffer }> = []
      if (/^multipart\/form-data/i.test(contentType)) {
        const parts = parseMultipart(buffer, contentType)
        files = parts
          .filter((p) => p.filename !== undefined && p.filename !== '' && p.data.length > 0)
          .map((p) => ({ filename: sanitizeFilename(p.filename), mimeType: p.mimeType, data: p.data }))
        if (files.length === 0) {
          sendJson(res, 400, { ok: false, error: 'multipart 请求中未找到带 filename 的文件字段', code: 'BAD_REQUEST' })
          return
        }
      } else {
        const rawName = (query.filename || (_req.headers['x-filename'] as string) || '').trim()
        files = [{ filename: sanitizeFilename(rawName || `upload-${Date.now()}`), mimeType: contentType || undefined, data: buffer }]
      }

      // 解析会话工作区
      const cwd = await resolveSessionCwd(ctx, sessionId)
      if (!cwd) {
        sendJson(res, 404, { ok: false, error: `Session '${sessionId}' not found or has no workspace cwd`, code: 'NOT_FOUND' })
        return
      }

      try {
        await mkdir(cwd, { recursive: true })
        const saved: Array<{ name: string; path: string; size: number; mimeType?: string }> = []
        for (const f of files) {
          const target = uniqueTarget(cwd, f.filename)
          await writeFile(target, f.data)
          saved.push({ name: path.basename(target), path: target, size: f.data.length, mimeType: f.mimeType })
        }
        sendJson(res, 200, {
          ok: true,
          data: {
            sessionId,
            cwd,
            count: saved.length,
            totalBytes: saved.reduce((acc, f) => acc + f.size, 0),
            files: saved,
            hint: '文件已写入会话工作区，会话中的 AI 可通过文件工具直接读取（把返回的 path 告诉它即可）',
          },
        })
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: `写入文件失败: ${err?.message || err}` })
      }
    },
    { rawBody: true },
  )

  // ---- 分片断点续传上传 ----
  // 暂存目录 <cwd>/.dsh-uploads/：分片顺序追加到 <uploadId>.part；meta 记录 name/size/mimeType。
  // received 以 .part 实际字节数为权威（服务重启/重复请求皆可恢复）。offset 不匹配返回 409 + 实际 received。
  // complete 时原子改名落入工作区（同名 -1/-2 去重），返回与 POST /files 完全一致的 files 形状。

  const stageDirOf = (cwd: string) => path.join(cwd, '.dsh-uploads')

  function stagePathsOf(cwd: string, uploadId: string): { part: string; meta: string } | undefined {
    const id = String(uploadId || '').replace(/[^A-Za-z0-9._-]/g, '')
    if (!id || id.length > 120) return undefined
    return { part: path.join(stageDirOf(cwd), id + '.part'), meta: path.join(stageDirOf(cwd), id + '.json') }
  }

  interface StageMeta {
    name: string
    size: number
    mimeType?: string
    createdAt: number
  }

  async function readStageMeta(metaFile: string): Promise<StageMeta | undefined> {
    try {
      const obj = JSON.parse(await readFile(metaFile, 'utf-8'))
      if (obj && typeof obj.name === 'string') return obj as StageMeta
    } catch {
      // 不存在或损坏 → 视为无 meta
    }
    return undefined
  }

  async function stageReceived(partFile: string): Promise<number> {
    try {
      return (await stat(partFile)).size
    } catch {
      return 0
    }
  }

  // init：POST /sessions/:id/files/resumable?name=&size=&mimeType=
  router.post(
    '/sessions/:id/files/resumable',
    async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, query: Record<string, string>) => {
      const cwd = await resolveSessionCwd(ctx, params.id)
      if (!cwd) {
        sendJson(res, 404, { ok: false, error: `Session '${params.id}' not found or has no workspace cwd`, code: 'NOT_FOUND' })
        return
      }
      const name = sanitizeFilename(query.name)
      const size = Math.max(0, Math.floor(Number(query.size) || 0))
      const mimeType = String(query.mimeType || '').slice(0, 120) || undefined
      const uploadId = `up-${randomUUID().replace(/-/g, '').slice(0, 20)}`
      try {
        await mkdir(stageDirOf(cwd), { recursive: true })
        const paths = stagePathsOf(cwd, uploadId)!
        await writeFile(paths.part, Buffer.alloc(0))
        const meta: StageMeta = { name, size, mimeType, createdAt: Date.now() }
        await writeFile(paths.meta, JSON.stringify(meta))
        sendJson(res, 200, { ok: true, data: { uploadId, name, size, received: 0 } })
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: `初始化分片上传失败: ${err?.message || err}` })
      }
    },
    { rawBody: true },
  )

  // 状态查询（断点续传恢复点）：GET /sessions/:id/files/resumable/:uploadId
  router.get('/sessions/:id/files/resumable/:uploadId', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
    const cwd = await resolveSessionCwd(ctx, params.id)
    const paths = cwd ? stagePathsOf(cwd, params.uploadId) : undefined
    if (!cwd || !paths) {
      sendJson(res, 400, { ok: false, error: '非法 uploadId', code: 'BAD_REQUEST' })
      return
    }
    const meta = await readStageMeta(paths.meta)
    if (!meta) {
      sendJson(res, 404, { ok: false, error: '上传会话不存在或已完成/清理', code: 'NOT_FOUND' })
      return
    }
    sendJson(res, 200, { ok: true, data: { uploadId: params.uploadId, name: meta.name, size: meta.size, received: await stageReceived(paths.part) } })
  })

  // 追加分片：PUT /sessions/:id/files/resumable/:uploadId?offset=<字节>（原始字节流）
  router.add(
    'PUT',
    '/sessions/:id/files/resumable/:uploadId',
    async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, query: Record<string, string>, body: any) => {
      const cwd = await resolveSessionCwd(ctx, params.id)
      const paths = cwd ? stagePathsOf(cwd, params.uploadId) : undefined
      if (!cwd || !paths) {
        sendJson(res, 400, { ok: false, error: '非法 uploadId', code: 'BAD_REQUEST' })
        return
      }
      const meta = await readStageMeta(paths.meta)
      if (!meta) {
        sendJson(res, 404, { ok: false, error: '上传会话不存在或已完成/清理', code: 'NOT_FOUND' })
        return
      }
      const chunk: Buffer = Buffer.isBuffer(body) ? body : Buffer.alloc(0)
      if (chunk.length === 0) {
        sendJson(res, 400, { ok: false, error: '分片内容为空', code: 'BAD_REQUEST' })
        return
      }
      const received = await stageReceived(paths.part)
      const offset = Number(query.offset)
      if (!Number.isFinite(offset) || offset < 0 || offset !== received) {
        // 断点不一致：告知服务端实际接收量，客户端从该处续传
        sendJson(res, 409, { ok: false, error: `offset 不匹配：服务端已接收 ${received} 字节`, code: 'OFFSET_MISMATCH', data: { received } })
        return
      }
      try {
        await appendFile(paths.part, chunk)
        sendJson(res, 200, { ok: true, data: { uploadId: params.uploadId, received: received + chunk.length } })
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: `写入分片失败: ${err?.message || err}` })
      }
    },
    { rawBody: true },
  )

  // 完成：POST /sessions/:id/files/resumable/:uploadId/complete
  router.post('/sessions/:id/files/resumable/:uploadId/complete', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
    const cwd = await resolveSessionCwd(ctx, params.id)
    const paths = cwd ? stagePathsOf(cwd, params.uploadId) : undefined
    if (!cwd || !paths) {
      sendJson(res, 400, { ok: false, error: '非法 uploadId', code: 'BAD_REQUEST' })
      return
    }
    const meta = await readStageMeta(paths.meta)
    if (!meta) {
      sendJson(res, 404, { ok: false, error: '上传会话不存在或已完成/清理', code: 'NOT_FOUND' })
      return
    }
    const received = await stageReceived(paths.part)
    if (meta.size > 0 && received !== meta.size) {
      sendJson(res, 409, {
        ok: false,
        error: `文件未传完：已接收 ${received}/${meta.size} 字节`,
        code: 'INCOMPLETE',
        data: { received, size: meta.size },
      })
      return
    }
    try {
      const target = uniqueTarget(cwd, meta.name)
      await rename(paths.part, target)
      await rm(paths.meta, { force: true })
      sendJson(res, 200, {
        ok: true,
        data: {
          sessionId: params.id,
          cwd,
          count: 1,
          files: [{ name: path.basename(target), path: target, size: received, mimeType: meta.mimeType }],
          hint: '文件已写入会话工作区，会话中的 AI 可通过文件工具直接读取（把返回的 path 告诉它即可）',
        },
      })
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: `落盘失败: ${err?.message || err}` })
    }
  })

  // 中止/清理：DELETE /sessions/:id/files/resumable/:uploadId
  router.delete('/sessions/:id/files/resumable/:uploadId', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
    const cwd = await resolveSessionCwd(ctx, params.id)
    const paths = cwd ? stagePathsOf(cwd, params.uploadId) : undefined
    if (!cwd || !paths) {
      sendJson(res, 400, { ok: false, error: '非法 uploadId', code: 'BAD_REQUEST' })
      return
    }
    await rm(paths.part, { force: true })
    await rm(paths.meta, { force: true })
    sendJson(res, 200, { ok: true, data: { uploadId: params.uploadId, aborted: true } })
  })
}
