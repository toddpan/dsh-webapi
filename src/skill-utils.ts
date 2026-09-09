/**
 * @dsh-external/dsh-web-service - Skill 工具函数
 *
 * 无第三方依赖：
 *  - frontmatter 解析/序列化（YAML 子集：顶层标量 + 续行折叠）
 *  - .zip 安全解压（Node 内置 zlib，拒绝 zip-slip / 绝对路径 / ..）
 *  - .tar / .tgz / .tar.gz 走系统 tar（macOS/Linux）
 *  - 技能根解析（user-dsh / user-agents / custom / project + cwd）
 */

import { mkdir, readdir, readFile, stat, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { inflateRawSync } from 'node:zlib'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)

export interface SkillFrontmatter {
  name?: string
  description?: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  /** 原样保留的未知字段（用于回写） */
  [key: string]: unknown
}

/** kebab-case 技能名校验（对齐 dsh-skill 的 SKILL_NAME） */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name)
}

export type SkillRootKind = 'user-dsh' | 'user-agents' | 'custom' | 'project' | 'bundled'

export interface SkillRoot {
  kind: SkillRootKind
  path: string
}

const DEFAULT_CUSTOM_SKILL_DIRS: string[] = []

/** 解析技能根目录（缺省 user-dsh）。project 需要 cwd；custom 取服务配置。 */
export function resolveSkillRoot(
  kind: string | undefined,
  cwd: string | undefined,
  customSkillDirs: string[] = DEFAULT_CUSTOM_SKILL_DIRS,
  dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  agentsHome = process.env.DSH_AGENTS_HOME || path.join(homedir(), '.agents'),
  bundledDir = process.env.DSH_BUNDLED_SKILL_DIR,
): { ok: true; root: SkillRoot } | { ok: false; error: string } {
  switch (kind || 'user-dsh') {
    case 'user-dsh':
      return { ok: true, root: { kind: 'user-dsh', path: path.join(dshHome, 'skills') } }
    case 'user-agents':
      return { ok: true, root: { kind: 'user-agents', path: path.join(agentsHome, 'skills') } }
    case 'custom': {
      if (customSkillDirs.length === 0) return { ok: false, error: '该服务未配置自定义技能目录 (customSkillDirs)' }
      return { ok: true, root: { kind: 'custom', path: customSkillDirs[0] } }
    }
    case 'project': {
      if (!cwd) return { ok: false, error: 'root=project 需要提供 cwd 参数' }
      const projectRoot = findProjectRoot(path.resolve(cwd))
      const agents = path.join(projectRoot, '.agents', 'skills')
      const dsh = path.join(projectRoot, '.dsh', 'skills')
      // 两个项目根：优先 .agents/skills（截图即此），回退 .dsh/skills
      return { ok: true, root: { kind: 'project', path: existsSync(agents) ? agents : dsh } }
    }
    case 'bundled': {
      if (!bundledDir) return { ok: false, error: '该服务未内置 bundle 技能目录 (DSH_BUNDLED_SKILL_DIR)' }
      return { ok: true, root: { kind: 'bundled', path: bundledDir } }
    }
    default:
      return { ok: false, error: `未知技能根: ${kind}` }
  }
}

/** 向上查找 .git 作为项目根；找不到回退 cwd */
function findProjectRoot(cwd: string): string {
  let current = path.resolve(cwd)
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(cwd)
    current = parent
  }
}

export interface ParsedSkillFile {
  name: string
  description: string
  whenToUse?: string
  frontmatter: SkillFrontmatter
  body: string
  raw: string
}

/** 解析 SKILL.md / .md 的技能文件（frontmatter 用 YAML 子集解析）。 */
export function parseSkillFile(raw: string): ParsedSkillFile | undefined {
  if (!raw.startsWith('---')) return undefined
  const firstEnd = raw.indexOf('\n')
  if (firstEnd < 0) return undefined
  let start = firstEnd + 1
  let bodyStart = -1
  // 找第二个 '---' 行
  let lineStart = start
  while (lineStart <= raw.length) {
    const next = raw.indexOf('\n', lineStart)
    const lineEnd = next < 0 ? raw.length : next
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      bodyStart = next < 0 ? raw.length : next + 1
      break
    }
    if (next < 0) return undefined
    lineStart = next + 1
  }
  if (bodyStart < 0) return undefined
  const yamlPart = raw.slice(start, bodyStart - 1) // 去掉结尾 \n
  const data = parseYamlSubset(yamlPart)
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : undefined
  const description = typeof data.description === 'string' && data.description.trim() ? data.description.trim() : undefined
  if (!name || !description || !isSkillName(name)) return undefined
  return {
    name,
    description,
    ...(typeof data.whenToUse === 'string' ? { whenToUse: data.whenToUse } : {}),
    frontmatter: data,
    body: raw.slice(bodyStart).trim(),
    raw,
  }
}

/** YAML 子集解析：顶层 `key: value`，2+ 空格续行进 value，支持布尔/数字/引号。 */
export function parseYamlSubset(text: string): SkillFrontmatter {
  const result: SkillFrontmatter = { modelInvocable: true, userInvocable: true }
  const lines = text.split(/\r?\n/)
  let lastKey: string | undefined
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(line)
    if (m) {
      const key = m[1]
      const value = m[2]
      lastKey = key
      result[key] = scalarValue(value)
      continue
    }
    // 续行：2+ 空格开头 → 追加到上一个字符串值
    if (lastKey && /^\s{2,}/.test(line)) {
      const prev = result[lastKey]
      if (typeof prev === 'string' && prev.length > 0) {
        result[lastKey] = `${prev} ${line.trim()}`
      }
    }
  }
  // 提取 invocation 语义
  if (typeof result['disable-model-invocation'] === 'boolean') {
    result.modelInvocable = !(result['disable-model-invocation'] as boolean)
  }
  if (typeof result['user-invocable'] === 'boolean') {
    result.userInvocable = result['user-invocable'] as boolean
  }
  return result
}

function scalarValue(raw: string): unknown {
  let v = raw.trim()
  if (!v) return ''
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1)
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1)
  if (v === 'true') return true
  if (v === 'false') return false
  const n = Number(v)
  if (v !== '' && !Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(v)) return n
  // inline comment 去除
  const hash = v.indexOf(' #')
  if (hash > 0) v = v.slice(0, hash).trim()
  return v
}

/** 序列化 frontmatter（key: value 单行；多行 value 用 > 折叠）。 */
export function serializeFrontmatter(data: Record<string, unknown>): string {
  const lines: string[] = ['---']
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'boolean') {
      lines.push(`${k}: ${v}`)
    } else if (typeof v === 'number') {
      lines.push(`${k}: ${v}`)
    } else {
      const s = String(v)
      // 多行 → 折叠
      if (s.includes('\n')) {
        lines.push(`${k}: >`)
        for (const l of s.split('\n')) lines.push(`  ${l}`)
      } else if (s.includes(':')) {
        lines.push(`${k}: "${s.replace(/"/g, '\\"')}"`)
      } else {
        lines.push(`${k}: ${s}`)
      }
    }
  }
  lines.push('---')
  return lines.join('\n')
}

/**
 * 依赖零的 .zip 安全解压（store/deflate），落盘到 destDir。
 * 拒绝绝对路径、.. 段、\0、符号链接；每个文件先建父目录再写。
 */
export async function extractZip(buffer: Buffer, destDir: string): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  try {
    const eocd = findEocd(buffer)
    if (!eocd) return { ok: false, error: '无法定位 ZIP 中央目录 (EOCD)' }
    const { count, centralOffset } = eocd
    await mkdir(destDir, { recursive: true })
    let pos = centralOffset
    let extracted = 0
    for (let i = 0; i < count; i += 1) {
      if (buffer.readUInt32LE(pos) !== 0x02014b50) return { ok: false, error: '中央目录条目签名错误' }
      const method = buffer.readUInt16LE(pos + 10)
      const compSize = buffer.readUInt32LE(pos + 20)
      const nameLen = buffer.readUInt16LE(pos + 28)
      const extraLen = buffer.readUInt16LE(pos + 30)
      const commentLen = buffer.readUInt16LE(pos + 32)
      const localOffset = buffer.readUInt32LE(pos + 42)
      const fname = buffer.toString('utf-8', pos + 46, pos + 46 + nameLen)
      pos += 46 + nameLen + extraLen + commentLen

      // 目录条目：跳过（父目录由文件写入时创建）
      if (fname.endsWith('/')) continue
      const safe = safeZipName(fname)
      if (!safe) continue

      // 读取 local header 定位数据
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) return { ok: false, error: `local header 签名错误: ${fname}` }
      const lnameLen = buffer.readUInt16LE(localOffset + 26)
      const lextraLen = buffer.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + lnameLen + lextraLen
      const comp = buffer.subarray(dataStart, dataStart + compSize)
      let out: Buffer
      if (method === 0) {
        out = comp
      } else if (method === 8) {
        out = inflateRawSync(comp)
      } else {
        continue // 不支持的方法（如 bzip2），跳过该文件
      }
      const target = path.join(destDir, safe)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, out)
      extracted += 1
    }
    return { ok: true, count: extracted }
  } catch (err: any) {
    return { ok: false, error: `zip 解压失败: ${err?.message || err}` }
  }
}

function findEocd(buffer: Buffer): { count: number; centralOffset: number } | undefined {
  const min = Math.max(0, buffer.length - 65557)
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      const count = buffer.readUInt16LE(i + 10)
      const centralOffset = buffer.readUInt32LE(i + 16)
      return { count, centralOffset }
    }
  }
  return undefined
}

/** zip 条目名安全化：拒绝绝对路径、.. 段、\0、反斜杠路径分隔（zip-slip 防护）。 */
function safeZipName(name: string): string | undefined {
  if (name.includes('\0')) return undefined
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return undefined
  const segments = normalized.split('/')
  for (const seg of segments) {
    if (seg === '..' || seg === '') return undefined
    if (seg.endsWith(':') || /^[A-Za-z]:/.test(seg)) return undefined
  }
  return normalized
}

/** tar / tgz / tar.gz 走系统 tar（strip 顶层包装目录）。返回是否成功。 */
export async function extractTar(buffer: Buffer, destDir: string, strip: number): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const tmp = path.join(process.env.TMPDIR || '/tmp', `dsh-skill-tar-${randomUUID().slice(0, 8)}.tar`)
  try {
    await writeFile(tmp, buffer)
    await mkdir(destDir, { recursive: true })
    const args = ['xf', tmp, '-C', destDir]
    if (strip > 0) args.push(`--strip-components=${strip}`)
    await execFileAsync('tar', args, { timeout: 60_000 })
    return { ok: true, count: 0 }
  } catch (err: any) {
    return { ok: false, error: `tar 解压失败: ${err?.message || err}` }
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

/** 列出技能根下所有技能（目录版 SKILL.md + 扁平 .md）。 */
export async function discoverSkills(root: string): Promise<Array<{ name: string; description: string; whenToUse?: string; source: string; path: string; root: string; size: number; modelInvocable: boolean; userInvocable: boolean }>> {
  const out: Array<{ name: string; description: string; whenToUse?: string; source: string; path: string; root: string; size: number; modelInvocable: boolean; userInvocable: boolean }> = []
  if (!existsSync(root)) return out
  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch {
    return out
  }
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    const full = path.join(root, entry)
    let st
    try {
      st = await stat(full)
    } catch {
      continue
    }
    let skillPath: string | undefined
    let skillRoot: string
    if (st.isDirectory()) {
      skillPath = path.join(full, 'SKILL.md')
      if (!existsSync(skillPath)) continue
      skillRoot = full
    } else if (st.isFile() && entry.endsWith('.md')) {
      skillPath = full
      skillRoot = root
    } else {
      continue
    }
    let raw = ''
    try {
      raw = await readFile(skillPath, 'utf-8')
    } catch {
      continue
    }
    const parsed = parseSkillFile(raw)
    if (!parsed) continue
    out.push({
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      source: path.basename(root),
      path: skillPath,
      root,
      size: Buffer.byteLength(raw, 'utf-8'),
      modelInvocable: parsed.frontmatter.modelInvocable,
      userInvocable: parsed.frontmatter.userInvocable,
    })
  }
  return out
}
