/**
 * @dsh-external/dsh-web-service - 远端文件系统目录浏览与文件管理（对齐 DSH directory-picker-browse 语义并扩展工作区文件管理）
 *
 * GET    /fs/list     ?path=&all=1       — 列出目录（all=1 包含文件与子目录，缺省只返回目录）
 * GET    /fs/download ?path=&inline=1    — 下载/内联预览绝对路径文件
 * POST   /fs/mkdir    { path, name }     — 在 path 目录下新建子目录
 * POST   /fs/upload   ?path=             — 向 path 目录上传文件（multipart 或原始流）
 * DELETE /fs/remove   ?path=             — 删除文件或目录
 */

import { opendir, stat, rm, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, statSync, createReadStream } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, type HttpRouter } from './router.js'
import type { WebServiceConfig } from './types.js'
import { parseMultipart, sanitizeFilename } from './files.js'

const MAX_ENTRIES = 2000

function isAbsolutePosix(p: string): boolean {
  return path.isAbsolute(p)
}

function sendErr(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, error: message, code })
}

export interface FsEntryRow {
  name: string
  path: string
  type: 'dir' | 'file' | 'link'
  size?: number
  mtime?: number
  hidden: boolean
}

const MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.yml': 'text/yaml; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.ts': 'text/plain; charset=utf-8', '.tsx': 'text/plain; charset=utf-8', '.jsx': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8', '.sh': 'text/plain; charset=utf-8', '.bash': 'text/plain; charset=utf-8', '.zsh': 'text/plain; charset=utf-8',
  '.rs': 'text/plain; charset=utf-8', '.go': 'text/plain; charset=utf-8', '.java': 'text/plain; charset=utf-8', '.c': 'text/plain; charset=utf-8',
  '.cpp': 'text/plain; charset=utf-8', '.h': 'text/plain; charset=utf-8', '.hpp': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.tar': 'application/x-tar', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
}

function lookupMime(filePath: string): string {
  return MIME_MAP[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

async function listFsEntries(target: string, includeFiles: boolean): Promise<{ entries: FsEntryRow[]; truncated: boolean }> {
  const rows: FsEntryRow[] = []
  let truncated = false
  const dir = await opendir(target)
  try {
    for await (const dirent of dir) {
      const isDir = dirent.isDirectory()
      const isLink = dirent.isSymbolicLink()
      let enterable = isDir
      let targetType: 'dir' | 'file' | 'link' = isDir ? 'dir' : isLink ? 'link' : 'file'
      let size = 0
      let mtime = 0

      const fullPath = path.join(target, dirent.name)

      if (isLink) {
        try {
          const st = statSync(fullPath)
          enterable = st.isDirectory()
          targetType = enterable ? 'dir' : 'file'
          size = st.size
          mtime = Math.round(st.mtimeMs)
        } catch {
          // 坏链跳过
          if (!includeFiles) continue
        }
      } else {
        try {
          const st = await stat(fullPath)
          size = st.size
          mtime = Math.round(st.mtimeMs)
        } catch {
          // 读取元数据失败
        }
      }

      if (!includeFiles && !enterable) continue

      if (rows.length >= MAX_ENTRIES) {
        truncated = true
        break
      }

      rows.push({
        name: dirent.name,
        path: fullPath,
        type: targetType,
        size: targetType === 'dir' ? undefined : size,
        mtime: mtime || undefined,
        hidden: dirent.name.startsWith('.'),
      })
    }
  } finally {
    void dir.close().catch(() => {})
  }

  // 目录排前面，同类型按名称自然排序
  rows.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1
    if (a.type !== 'dir' && b.type === 'dir') return 1
    return a.name.localeCompare(b.name)
  })

  return { entries: rows, truncated }
}

export function registerFsRoutes(router: HttpRouter, config: WebServiceConfig): void {
  // ---- 目录与文件列表浏览 ----
  router.get('/fs/list', async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, query: Record<string, string>) => {
    const raw = String(query.path || '').trim()
    const includeFiles = query.all === '1' || query.all === 'true' || query.files === '1'
    const home = homedir()
    let target: string
    if (!raw) {
      target = path.resolve(home)
    } else {
      if (!isAbsolutePosix(raw)) {
        sendErr(res, 400, 'BAD_REQUEST', `cannot list "${raw}": not a fully qualified path`)
        return
      }
      target = path.resolve(raw)
    }
    try {
      if (!existsSync(target)) {
        sendErr(res, 400, 'DIRECTORY_UNREADABLE', `cannot list "${target}": 目录不存在`)
        return
      }
      const st = statSync(target)
      if (!st.isDirectory()) {
        sendErr(res, 400, 'DIRECTORY_UNREADABLE', `cannot list "${target}": 不是目录`)
        return
      }
      const { entries, truncated } = await listFsEntries(target, includeFiles)
      const parent = target === path.parse(target).root ? undefined : path.dirname(target)
      sendJson(res, 200, {
        ok: true,
        data: { path: target, home, parent, entries, truncated, maxEntries: MAX_ENTRIES },
      })
    } catch (err: any) {
      if (err?.code === 'EACCES' || err?.code === 'EPERM') {
        sendErr(res, 400, 'DIRECTORY_UNREADABLE', `cannot list "${target}": 权限不足`)
        return
      }
      sendErr(res, 500, 'LIST_FAILED', err?.message || String(err))
    }
  })

  // ---- 绝对路径文件下载 / 内联预览 ----
  router.get('/fs/download', async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, query: Record<string, string>) => {
    const raw = String(query.path || '').trim()
    if (!raw || !isAbsolutePosix(raw)) {
      sendErr(res, 400, 'BAD_REQUEST', 'path 必须是绝对路径')
      return
    }
    const target = path.resolve(raw)
    if (!existsSync(target)) {
      sendErr(res, 404, 'NOT_FOUND', `文件不存在: ${target}`)
      return
    }
    try {
      const st = statSync(target)
      if (st.isDirectory()) {
        sendErr(res, 400, 'BAD_REQUEST', '该路径是目录，请使用 /fs/list 浏览')
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
      sendErr(res, 500, 'DOWNLOAD_FAILED', err?.message || String(err))
    }
  })

  // ---- 新建文件夹 ----
  router.post('/fs/mkdir', async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, _query: Record<string, string>, body: any) => {
    const parent = String(body?.path || '').trim()
    const name = String(body?.name || '').trim()
    if (!parent || !isAbsolutePosix(parent)) {
      sendErr(res, 400, 'BAD_REQUEST', 'path 必须是绝对路径')
      return
    }
    if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      sendErr(res, 400, 'BAD_REQUEST', 'name 不合法（不能为空、不含路径分隔符、不能是 . 或 ..）')
      return
    }
    const target = path.join(path.resolve(parent), name)
    try {
      if (!existsSync(parent)) {
        sendErr(res, 400, 'DIRECTORY_UNREADABLE', `父目录不存在: ${parent}`)
        return
      }
      if (existsSync(target)) {
        sendErr(res, 409, 'ALREADY_EXISTS', `同名条目已存在: ${target}`)
        return
      }
      await mkdir(target, { recursive: true })
      sendJson(res, 200, { ok: true, data: { path: target, name } })
    } catch (err: any) {
      sendErr(res, 500, 'MKDIR_FAILED', err?.message || String(err))
    }
  })

  // ---- 文件 / 目录删除 ----
  router.delete('/fs/remove', async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, query: Record<string, string>) => {
    const raw = String(query.path || '').trim()
    if (!raw || !isAbsolutePosix(raw)) {
      sendErr(res, 400, 'BAD_REQUEST', 'path 必须是绝对路径')
      return
    }
    const target = path.resolve(raw)
    const home = homedir()
    // 安全保护：禁止删除系统根目录或用户主目录根
    if (target === '/' || target === home) {
      sendErr(res, 403, 'FORBIDDEN', '禁止删除根目录或用户主目录根')
      return
    }
    if (!existsSync(target)) {
      sendErr(res, 404, 'NOT_FOUND', `目标不存在: ${target}`)
      return
    }
    try {
      await rm(target, { recursive: true, force: true })
      sendJson(res, 200, { ok: true, data: { path: target, removed: true } })
    } catch (err: any) {
      sendErr(res, 500, 'REMOVE_FAILED', err?.message || String(err))
    }
  })

  // ---- 向指定目录上传文件 ----
  router.post(
    '/fs/upload',
    async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, query: Record<string, string>, body: any) => {
      const destDir = String(query.path || '').trim()
      if (!destDir || !isAbsolutePosix(destDir)) {
        sendErr(res, 400, 'BAD_REQUEST', 'path 必须是目标目录绝对路径')
        return
      }
      const targetDir = path.resolve(destDir)
      if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
        sendErr(res, 400, 'DIRECTORY_UNREADABLE', `目标目录不存在: ${targetDir}`)
        return
      }

      const contentType = String(_req.headers['content-type'] || '')
      const buffer: Buffer = Buffer.isBuffer(body) ? body : Buffer.alloc(0)
      const maxBytes = config.maxUploadBytes || 2 * 1024 * 1024 * 1024

      if (buffer.length === 0) {
        sendErr(res, 400, 'BAD_REQUEST', '请求体为空')
        return
      }
      if (buffer.length > maxBytes) {
        sendErr(res, 413, 'PAYLOAD_TOO_LARGE', `Payload too large (> ${maxBytes} bytes)`)
        return
      }

      let files: Array<{ filename: string; mimeType?: string; data: Buffer }> = []
      if (/^multipart\/form-data/i.test(contentType)) {
        const parts = parseMultipart(buffer, contentType)
        files = parts
          .filter((p) => p.filename !== undefined && p.filename !== '' && p.data.length > 0)
          .map((p) => ({ filename: sanitizeFilename(p.filename), mimeType: p.mimeType, data: p.data }))
        if (files.length === 0) {
          sendErr(res, 400, 'BAD_REQUEST', 'multipart 请求中未找到文件')
          return
        }
      } else {
        const rawName = (query.filename || (_req.headers['x-filename'] as string) || '').trim()
        files = [{ filename: sanitizeFilename(rawName || `upload-${Date.now()}`), mimeType: contentType || undefined, data: buffer }]
      }

      try {
        const saved: Array<{ name: string; path: string; size: number; mimeType?: string }> = []
        for (const f of files) {
          let candidate = path.join(targetDir, f.filename)
          const ext = path.extname(f.filename)
          const stem = path.basename(f.filename, ext)
          let i = 1
          while (existsSync(candidate)) {
            candidate = path.join(targetDir, `${stem}-${i}${ext}`)
            i++
          }
          await writeFile(candidate, f.data)
          saved.push({ name: path.basename(candidate), path: candidate, size: f.data.length, mimeType: f.mimeType })
        }
        sendJson(res, 200, { ok: true, data: { count: saved.length, files: saved } })
      } catch (err: any) {
        sendErr(res, 500, 'UPLOAD_FAILED', err?.message || String(err))
      }
    },
    { rawBody: true },
  )
}

// tmpdir 引用保留：未来临时目录快捷入口使用
void tmpdir
