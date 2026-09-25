/**
 * @dsh-external/dsh-web-service - Skill 管理 API
 *
 * 提供远端 DSH 技能全生命周期管理（供 onenat-workbuddy「技能中心」消费）：
 *   GET    /skills                列表（管理视图：见全部，含 root/path）
 *   GET    /skills/:name          单技能详情（含全文，供预览）
 *   GET    /skills/:name/body     原始 SKILL.md 全文（下载/预览）
 *   GET    /skills/:name/archive  整个技能目录归档 (.tgz)（含 references/ 等资源）
 *   POST   /skills                上传/创建技能（multipart 压缩包 或 JSON）
 *   PUT    /skills/:name          更新技能正文/元数据（JSON）
 *   DELETE /skills/:name          删除技能
 *
 * 落盘到技能根目录（默认 ~/.dsh/skills），写入后尝试触发 ctx.skills 失效；
 * 配套技能文件系统 watcher 会自行感知变更。
 */

import { mkdir, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises'
import { existsSync, createReadStream } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { sendJson, type HttpRouter } from './router.js'
import {
  discoverSkills,
  extractTar,
  extractZip,
  isSkillName,
  parseSkillFile,
  parseYamlSubset,
  resolveSkillRoot,
  serializeFrontmatter,
  type SkillRoot,
} from './skill-utils.js'
import type { WebServiceConfig } from './types.js'

const execFileAsync = promisify(execFile)

export function registerSkillRoutes(ctx: Context, router: HttpRouter, config: WebServiceConfig): void {
  const maxBytes = config.maxUploadBytes || 2 * 1024 * 1024 * 1024
  const customDirs = config.customSkillDirs || []

  const rootOf = (kind: string | undefined, cwd: string | undefined): SkillRoot | { error: string } => {
    const resolved = resolveSkillRoot(kind, cwd, customDirs, config.dshHome, config.agentsHome, config.bundledSkillDir)
    if ('error' in resolved) return { error: resolved.error }
    return resolved.root
  }

  const invalidateSkills = (): void => {
    const skills = ctx.get('skills') as any
    if (skills?.invalidateCache) skills.invalidateCache()
    // 触发变更通知（即便无 skills 服务也不报错）
    try {
      ctx.events.emit('emit', ['skills/change'])
    } catch {
      /* 事件总线可能未挂载 */
    }
  }

  // ---- 列表 ----
  router.get('/skills', async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, query: Record<string, string>) => {
    const root = rootOf(query.root, query.cwd)
    if ('error' in root) return sendJson(res, 400, { ok: false, error: root.error, code: 'BAD_REQUEST' })
    try {
      const skills = await discoverSkills(root.path)
      const kw = (query.search || '').trim().toLowerCase()
      const filtered = kw
        ? skills.filter((s) => s.name.toLowerCase().includes(kw) || s.description.toLowerCase().includes(kw))
        : skills
      return sendJson(res, 200, { ok: true, data: { root: { kind: root.kind, path: root.path }, count: filtered.length, skills: filtered } })
    } catch (err: any) {
      return sendJson(res, 500, { ok: false, error: `读取技能失败: ${err?.message || err}` })
    }
  })

  // ---- 单技能详情（含全文） ----
  router.get('/skills/:name', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, query: Record<string, string>) => {
    const root = rootOf(query.root, query.cwd)
    if ('error' in root) return sendJson(res, 400, { ok: false, error: root.error, code: 'BAD_REQUEST' })
    const name = params.name
    if (!isSkillName(name)) return sendJson(res, 400, { ok: false, error: `非法技能名: ${name}`, code: 'BAD_REQUEST' })
    const skillPath = skillPathFor(name, root.path)
    if (!existsSync(skillPath)) return sendJson(res, 404, { ok: false, error: `技能 ${name} 不存在`, code: 'NOT_FOUND' })
    try {
      const raw = await readFile(skillPath, 'utf-8')
      const parsed = parseSkillFile(raw)
      if (!parsed) return sendJson(res, 400, { ok: false, error: `技能文件 ${skillPath} 解析失败`, code: 'BAD_REQUEST' })
      return sendJson(res, 200, {
        ok: true,
        data: {
          name,
          path: skillPath,
          root: root.path,
          description: parsed.description,
          whenToUse: parsed.whenToUse,
          modelInvocable: parsed.frontmatter.modelInvocable,
          userInvocable: parsed.frontmatter.userInvocable,
          content: parsed.body,
          raw,
          size: raw.length,
        },
      })
    } catch (err: any) {
      return sendJson(res, 500, { ok: false, error: `读取技能失败: ${err?.message || err}` })
    }
  })

  // ---- SKILL.md 原始全文（下载/预览） ----
  router.get('/skills/:name/body', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, query: Record<string, string>) => {
    const root = rootOf(query.root, query.cwd)
    if ('error' in root) return sendJson(res, 400, { ok: false, error: root.error, code: 'BAD_REQUEST' })
    const name = params.name
    if (!isSkillName(name)) return sendJson(res, 400, { ok: false, error: `非法技能名: ${name}`, code: 'BAD_REQUEST' })
    const skillPath = skillPathFor(name, root.path)
    if (!existsSync(skillPath)) return sendJson(res, 404, { ok: false, error: `技能 ${name} 不存在`, code: 'NOT_FOUND' })
    try {
      const raw = await readFile(skillPath, 'utf-8')
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
      res.setHeader('Content-Length', String(Buffer.byteLength(raw)))
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Disposition', `attachment; filename="${name}.md"`)
      res.end(raw)
    } catch (err: any) {
      return sendJson(res, 500, { ok: false, error: `读取技能失败: ${err?.message || err}` })
    }
  })

  // ---- 整个技能目录归档 (.tgz) ----
  router.get('/skills/:name/archive', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, query: Record<string, string>) => {
    const root = rootOf(query.root, query.cwd)
    if ('error' in root) return sendJson(res, 400, { ok: false, error: root.error, code: 'BAD_REQUEST' })
    const name = params.name
    if (!isSkillName(name)) return sendJson(res, 400, { ok: false, error: `非法技能名: ${name}`, code: 'BAD_REQUEST' })
    // 目录版或扁平 .md
    const dir = path.join(root.path, name)
    const flat = path.join(root.path, `${name}.md`)
    const targetDir = existsSync(dir) ? dir : undefined
    if (!targetDir && !existsSync(flat)) return sendJson(res, 404, { ok: false, error: `技能 ${name} 不存在`, code: 'NOT_FOUND' })
    const archName = `${name}.tgz`
    const tmpFile = path.join(tmpdir(), `dsh-skill-${name}-${Date.now()}.tgz`)
    try {
      await execFileAsync('tar', [
        'czf', tmpFile, '-C', targetDir ? path.dirname(targetDir) : root.path,
        '--exclude=__pycache__', '--exclude=node_modules',
        targetDir ? name : `${name}.md`,
      ], { timeout: 60_000 })
      const st = await stat(tmpFile)
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/gzip')
      res.setHeader('Content-Length', String(st.size))
      res.setHeader('Content-Disposition', `attachment; filename="${archName}"`)
      const readStream = createReadStream(tmpFile)
      readStream.on('error', () => { res.destroy() })
      readStream.on('end', () => { void rm(tmpFile, { force: true }).catch(() => {}) })
      readStream.pipe(res)
    } catch (err: any) {
      return sendJson(res, 500, { ok: false, error: `归档失败: ${err?.message || err}` })
    }
  })

  // ---- 上传/创建（multipart 压缩包 或 JSON） ----
  router.post(
    '/skills',
    async (_req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, query: Record<string, string>, body: any) => {
      const contentType = String(_req.headers['content-type'] || '')
      const buffer: Buffer = Buffer.isBuffer(body) ? body : Buffer.alloc(0)
      if (buffer.length === 0) return sendJson(res, 400, { ok: false, error: '请求体为空：请以 multipart/压缩包或 JSON 上传技能', code: 'BAD_REQUEST' })
      if (buffer.length > maxBytes) return sendJson(res, 413, { ok: false, error: `Payload too large (> ${maxBytes} bytes)`, code: 'PAYLOAD_TOO_LARGE' })

      // multipart → 压缩包上传
      if (/^multipart\/form-data/i.test(contentType)) {
        const { parseMultipart } = await import('./files.js')
        const parts = parseMultipart(buffer, contentType)
        const fields: Record<string, string> = {}
        let file: { filename?: string; data: Buffer } | undefined
        for (const p of parts) {
          if (p.filename !== undefined && p.data.length > 0) file = p
          else if (p.name !== undefined) fields[p.name] = p.data.toString('utf-8')
        }
        if (!file) return sendJson(res, 400, { ok: false, error: 'multipart 中未找到技能压缩包文件字段', code: 'BAD_REQUEST' })
        const root = rootOf(fields.root || query.root, fields.cwd || query.cwd)
        if ('error' in root) return sendJson(res, 400, { ok: false, error: root.error, code: 'BAD_REQUEST' })
        const name = (fields.name || '').trim() || undefined
        try {
          const result = await installSkillArchive(root.path, file.data, file.filename, name)
          if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error, code: 'BAD_REQUEST' })
          invalidateSkills()
          return sendJson(res, 200, { ok: true, data: result })
        } catch (err: any) {
          return sendJson(res, 500, { ok: false, error: `解压落盘失败: ${err?.message || err}` })
        }
      }

      // JSON → 直接创建/覆盖
      let json: any
      try {
        json = JSON.parse(buffer.toString('utf-8'))
      } catch (err: any) {
        return sendJson(res, 400, { ok: false, error: `JSON 解析失败: ${err?.message || err}`, code: 'BAD_REQUEST' })
      }
      const root = rootOf(json.root || query.root, json.cwd || query.cwd)
      if ('error' in root) return sendJson(res, 400, { ok: false, error: root.error, code: 'BAD_REQUEST' })
      const name = String(json.name || '').trim()
      if (!isSkillName(name)) return sendJson(res, 400, { ok: false, error: `非法技能名: ${name || '(空)'}`, code: 'BAD_REQUEST' })
      const description = String(json.description || '').trim()
      if (!description) return sendJson(res, 400, { ok: false, error: 'description 不能为空', code: 'BAD_REQUEST' })
      try {
        const result = await createSkillFromJson(root.path, json)
        invalidateSkills()
        return sendJson(res, 200, { ok: true, data: result })
      } catch (err: any) {
        return sendJson(res, 500, { ok: false, error: `写入技能失败: ${err?.message || err}` })
      }
    },
    { rawBody: true },
  )

  // ---- 更新 ----
  router.put('/skills/:name', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, query: Record<string, string>, body: any) => {
    const root = rootOf(query.root, query.cwd)
    if ('error' in root) return sendJson(res, 400, { ok: false, error: root.error, code: 'BAD_REQUEST' })
    const name = params.name
    if (!isSkillName(name)) return sendJson(res, 400, { ok: false, error: `非法技能名: ${name}`, code: 'BAD_REQUEST' })
    const skillPath = skillPathFor(name, root.path)
    if (!existsSync(skillPath)) return sendJson(res, 404, { ok: false, error: `技能 ${name} 不存在`, code: 'NOT_FOUND' })
    try {
      const existing = await readFile(skillPath, 'utf-8')
      const parsed = parseSkillFile(existing) || { frontmatter: parseYamlSubset(''), body: existing }
      const fm = parsed.frontmatter
      if (body?.description !== undefined) fm.description = String(body.description).trim()
      if (body?.whenToUse !== undefined) fm.whenToUse = String(body.whenToUse).trim()
      if (typeof body?.modelInvocable === 'boolean') {
        fm['disable-model-invocation'] = !body.modelInvocable
        fm.modelInvocable = body.modelInvocable
      }
      if (typeof body?.userInvocable === 'boolean') {
        fm['user-invocable'] = body.userInvocable
        fm.userInvocable = body.userInvocable
      }
      const content = body?.content !== undefined ? String(body.content).trim() : undefined
      const frontmatterStr = serializeFrontmatter(fm as Record<string, unknown>)
      const newRaw = `${frontmatterStr}\n\n${content ?? parsed.body}\n`
      await writeFile(skillPath, newRaw, 'utf-8')
      invalidateSkills()
      return sendJson(res, 200, { ok: true, data: { name, path: skillPath, size: Buffer.byteLength(newRaw) } })
    } catch (err: any) {
      return sendJson(res, 500, { ok: false, error: `更新技能失败: ${err?.message || err}` })
    }
  })

  // ---- 删除 ----
  router.delete('/skills/:name', async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, query: Record<string, string>) => {
    const root = rootOf(query.root, query.cwd)
    if ('error' in root) return sendJson(res, 400, { ok: false, error: root.error, code: 'BAD_REQUEST' })
    const name = params.name
    if (!isSkillName(name)) return sendJson(res, 400, { ok: false, error: `非法技能名: ${name}`, code: 'BAD_REQUEST' })
    const dir = path.join(root.path, name)
    const flat = path.join(root.path, `${name}.md`)
    const target = existsSync(dir) ? dir : existsSync(flat) ? flat : undefined
    if (!target) return sendJson(res, 404, { ok: false, error: `技能 ${name} 不存在`, code: 'NOT_FOUND' })
    try {
      await rm(target, { recursive: true, force: true })
      invalidateSkills()
      return sendJson(res, 200, { ok: true, data: { name, deleted: true } })
    } catch (err: any) {
      return sendJson(res, 500, { ok: false, error: `删除技能失败: ${err?.message || err}` })
    }
  })
}

/** 技能文件/目录定位：目录版 <root>/<name>/SKILL.md 或扁平 <root>/<name>.md */
function skillPathFor(name: string, rootPath: string): string {
  const dir = path.join(rootPath, name)
  if (existsSync(path.join(dir, 'SKILL.md'))) return path.join(dir, 'SKILL.md')
  const flat = path.join(rootPath, `${name}.md`)
  return existsSync(flat) ? flat : path.join(dir, 'SKILL.md')
}

/**
 * 安装技能压缩包（zip / tgz / tar.gz）。
 * 兼容两种形态：压缩包内为 <name>/SKILL.md 目录结构，或扁平 SKILL.md；
 * 可选 strip 顶层包装目录。返回 { name, path }。
 */
async function installSkillArchive(rootPath: string, data: Buffer, filename: string | undefined, explicitName?: string): Promise<{ ok: boolean; name?: string; path?: string; error?: string }> {
  await mkdir(rootPath, { recursive: true })
  const fname = (filename || '').toLowerCase()
  const tmpDir = path.join(tmpdir(), `dsh-skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const extractResult = fname.endsWith('.zip')
    ? await extractZip(data, tmpDir)
    : await extractTar(data, tmpDir, 0)
  if (!extractResult.ok) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: extractResult.error }
  }
  try {
    const located = await locateSkillInTree(tmpDir)
    if (!located) {
      // 单一包装目录：strip 后重新定位
      const topDirs = (await readdir(tmpDir, { withFileTypes: true })).filter((d) => d.isDirectory())
      if (topDirs.length === 1) {
        const inner = await locateSkillInTree(path.join(tmpDir, topDirs[0].name))
        if (inner) return finalizeSkill(inner, tmpDir, rootPath, explicitName)
      }
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      return { ok: false, error: '压缩包内未找到有效的 SKILL.md' }
    }
    return finalizeSkill(located, tmpDir, rootPath, explicitName)
  } catch (err: any) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: err?.message || err }
  }
}

/** 在目录树中定位技能：优先 dir/SKILL.md，其次单一子目录含 SKILL.md，最后扁平 .md。 */
async function locateSkillInTree(dir: string): Promise<{ dir: string; skillPath: string; name?: string; flat: boolean } | undefined> {
  const direct = path.join(dir, 'SKILL.md')
  if (existsSync(direct)) {
    const parsed = parseSkillFile(await readFile(direct, 'utf-8'))
    return { dir, skillPath: direct, name: parsed?.name, flat: false }
  }
  // 单一子目录含 SKILL.md
  const sub = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory())
  if (sub.length === 1) {
    const innerSkill = path.join(dir, sub[0].name, 'SKILL.md')
    if (existsSync(innerSkill)) {
      const parsed = parseSkillFile(await readFile(innerSkill, 'utf-8'))
      return { dir: path.join(dir, sub[0].name), skillPath: innerSkill, name: parsed?.name, flat: false }
    }
  }
  // 扁平 <name>.md
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.md'))) {
    const p = path.join(dir, f)
    const parsed = parseSkillFile(await readFile(p, 'utf-8'))
    if (parsed) return { dir, skillPath: p, name: parsed.name, flat: true }
  }
  return undefined
}

/** 将已解压的技能内容落盘为 <root>/<name>/（目录形式，统一含 SKILL.md）。 */
async function finalizeSkill(located: { dir: string; skillPath: string; name?: string; flat: boolean }, tmpDir: string, rootPath: string, explicitName?: string): Promise<{ ok: boolean; name?: string; path?: string; error?: string }> {
  const parsed = parseSkillFile(await readFile(located.skillPath, 'utf-8'))
  const defaultName = parsed?.name || (!located.flat ? path.basename(located.dir) : undefined)
  const name = explicitName || defaultName
  if (!name || !isSkillName(name)) return { ok: false, error: `无法确定技能名: ${name || '(空)'}` }

  const targetDir = path.join(rootPath, name)
  await rm(targetDir, { recursive: true, force: true }).catch(() => {})
  await mkdir(targetDir, { recursive: true })

  if (located.flat) {
    // 扁平 .md → <root>/<name>/SKILL.md
    await writeFile(path.join(targetDir, 'SKILL.md'), await readFile(located.skillPath))
  } else {
    // 目录形式：把 located.dir（即 SKILL.md 所在目录）内容拷入 targetDir
    await copyDirContents(located.dir, targetDir)
  }
  const finalSkill = path.join(targetDir, 'SKILL.md')
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  if (!existsSync(finalSkill)) return { ok: false, error: '技能目录缺少 SKILL.md' }
  return { ok: true, name, path: finalSkill }
}

async function copyDirContents(srcDir: string, dstDir: string): Promise<void> {
  for (const it of await readdir(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, it.name)
    const d = path.join(dstDir, it.name)
    if (it.isDirectory()) await copyDir(s, d)
    else if (it.isFile()) await writeFile(d, await readFile(s))
  }
}

/** JSON 创建技能：<root>/<name>/SKILL.md。 */
async function createSkillFromJson(rootPath: string, json: any): Promise<{ name: string; path: string; size: number }> {
  const name = String(json.name).trim()
  const targetDir = path.join(rootPath, name)
  await mkdir(targetDir, { recursive: true })
  const fm: Record<string, unknown> = {
    name,
    description: String(json.description).trim(),
    ...(json.whenToUse ? { whenToUse: String(json.whenToUse).trim() } : {}),
    ...(typeof json.modelInvocable === 'boolean' ? { 'disable-model-invocation': !json.modelInvocable } : {}),
    ...(typeof json.userInvocable === 'boolean' ? { 'user-invocable': json.userInvocable } : {}),
  }
  const raw = `${serializeFrontmatter(fm)}\n\n${String(json.content || '').trim()}\n`
  const skillPath = path.join(targetDir, 'SKILL.md')
  await writeFile(skillPath, raw, 'utf-8')
  return { name, path: skillPath, size: Buffer.byteLength(raw) }
}

async function copyDir(src: string, dst: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true })
  await mkdir(dst, { recursive: true })
  for (const e of entries) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) await copyDir(s, d)
    else if (e.isFile()) await writeFile(d, await readFile(s))
  }
}
