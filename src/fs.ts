/**
 * @dsh-external/dsh-web-service - 远端文件系统目录浏览（对齐 DSH directory-picker-browse 语义）
 *
 * GET  /fs/list  ?path=            — 列出某目录下的子目录（缺省 = 进程 home）；只返回目录行
 * POST /fs/mkdir { path, name }    — 在 path 下新建子目录
 *
 * 语义对齐 packages/host/directory-picker-browse：
 *  - 只返回可进入的目录（普通目录 + 指向目录的符号链接；坏链静默跳过）
 *  - 行结构 { name, path, hidden }，hidden 采用 POSIX 约定（. 开头），是否展示由客户端决定
 *  - 名称排序、maxEntries 截断（默认 1000，truncated 标记）
 *  - path 必须是绝对路径；缺省解析为 home
 */

import { opendir } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, type HttpRouter } from './router.js'
import type { WebServiceConfig } from './types.js'

const MAX_ENTRIES = 1000

function isAbsolutePosix(p: string): boolean {
  return path.isAbsolute(p)
}

function sendErr(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, error: message, code })
}

interface DirRow {
  name: string
  path: string
  hidden: boolean
}

async function listDirectories(target: string): Promise<{ entries: DirRow[]; truncated: boolean }> {
  const rows: DirRow[] = []
  let truncated = false
  const dir = await opendir(target)
  try {
    for await (const dirent of dir) {
      const isDir = dirent.isDirectory()
      let enterable = isDir
      if (!enterable && dirent.isSymbolicLink()) {
        // 符号链接：stat 探测目标是否为目录；坏链/环链静默跳过
        try {
          enterable = statSync(path.join(target, dirent.name)).isDirectory()
        } catch {
          continue
        }
      }
      if (!enterable) continue
      if (rows.length >= MAX_ENTRIES) {
        truncated = true
        break
      }
      rows.push({ name: dirent.name, path: path.join(target, dirent.name), hidden: dirent.name.startsWith('.') })
    }
  } finally {
    void dir.close().catch(() => {})
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return { entries: rows, truncated }
}

export function registerFsRoutes(router: HttpRouter, config: WebServiceConfig): void {
  // ---- 目录浏览 ----
  router.get('/fs/list', async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, query: Record<string, string>) => {
    const raw = String(query.path || '').trim()
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
      const { entries, truncated } = await listDirectories(target)
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
      const { mkdir } = await import('node:fs/promises')
      await mkdir(target)
      sendJson(res, 200, { ok: true, data: { path: target, name } })
    } catch (err: any) {
      sendErr(res, 500, 'MKDIR_FAILED', err?.message || String(err))
    }
  })
}

// tmpdir 引用保留：未来临时目录快捷入口使用
void tmpdir
