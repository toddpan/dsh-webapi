/**
 * dsh-web-service — 本机已装 DSH 插件清单（GET /plugins）
 *
 * 数据源（实证于 ~/.dsh/profiles/ 布局）：
 *  - 主依据：profile `package.json`，dsh plugin add 会把每个插件记录为 profile 依赖
 *    （`dsh.profile.bundles` 内置捆绑与直接安装共用该清单）；
 *  - 兜底：扫描自身所在 node_modules 的兄弟包目录，逐个读 package.json；
 *  - 自身：从包内 package.json 读出 name/version/description 兜底（无 profile 也能返回）。
 *
 * 每条记录带 `family:'dsh'` —— 控制台「从节点导入插件」用该属性与目标 AGENT 引擎家族
 * （DSH / ZCODE / 未来扩展）做适用匹配；`sourcePath` 供导入端在节点上打包导出。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpRouter, sendJson } from './router.js'

export interface PluginEntry {
  name: string
  family: 'dsh'
  version?: string
  description?: string
  /** node 上的绝对目录（导入端在节点上 npm pack 此目录得到归档） */
  sourcePath?: string
  /** profile dsh.profile.bundles 内置捆绑的插件标记 */
  bundled?: boolean
}

/** 从 lib/plugins.js 的模块 URL 一路向上找自身 package.json（与 version.ts 同策略） */
function findSelfPackage(): { root: string; pkg: any } | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      try {
        return { root: dir, pkg: JSON.parse(readFileSync(candidate, 'utf8')) }
      } catch {
        /* 解析失败按不存在处理 */
      }
    }
    dir = dirname(dir)
  }
  return null
}

function readPkg(dir: string): any | null {
  const p = join(dir, 'package.json')
  if (!existsSync(p)) return null
  try {
    const pkg = JSON.parse(readFileSync(p, 'utf8'))
    if (!pkg || typeof pkg.name !== 'string') return null
    return pkg
  } catch {
    return null
  }
}

export interface PluginListResult {
  count: number
  family: 'dsh'
  /** dsh-profile-*（找到时） */
  profile?: string
  plugins: PluginEntry[]
}

/** 从插件包根向上找 DSH profile 目录（含 dsh-profile-* 包名或 dsh.profile.bundles） */
function findProfileDir(pkgRoot: string): { dir: string; pkg: any } | null {
  let dir = dirname(pkgRoot)
  for (let i = 0; i < 6; i++) {
    const pkg = readPkg(dir)
    const name = typeof (pkg as any)?.name === 'string' ? (pkg as any).name : ''
    if (pkg && (name.startsWith('dsh-profile-') || (pkg as any).dsh?.profile)) return { dir, pkg }
    dir = dirname(dir)
  }
  return null
}

export async function listDshPlugins(): Promise<PluginListResult> {
  const plugins: PluginEntry[] = []
  const seen = new Set<string>()
  let profileName: string | undefined
  const self = findSelfPackage()
  if (self) {
    const name: string = self.pkg.name || 'dsh-web-service'
    plugins.push({
      name,
      family: 'dsh',
      version: typeof self.pkg.version === 'string' ? self.pkg.version : undefined,
      description: typeof self.pkg.description === 'string' ? self.pkg.description : undefined,
      sourcePath: self.root,
    })
    seen.add(name)

    const profile = findProfileDir(self.root)
    if (profile) {
      profileName = typeof profile.pkg.name === 'string' ? profile.pkg.name : undefined
      const nmDir = join(profile.dir, 'node_modules')
      const bundledNames = new Set<string>()
      try {
        const bundles = profile.pkg?.dsh?.profile?.bundles
        if (Array.isArray(bundles)) for (const b of bundles) bundledNames.add(String(b))
      } catch {
        /* 结构缺失按普通依赖处理 */
      }

      // 主依据：profile 包依赖（每个都是一条已安装插件）
      const deps = profile.pkg?.dependencies
      if (deps && typeof deps === 'object') {
        for (const [name2] of Object.entries(deps as Record<string, string>)) {
          if (!name2 || seen.has(name2)) continue
          const pkgRoot = name2.startsWith('@') ? join(nmDir, ...name2.split('/')) : join(nmDir, name2)
          const pkg = readPkg(pkgRoot)
          if (!pkg) continue
          plugins.push({
            name: name2,
            family: 'dsh',
            version: typeof pkg.version === 'string' ? pkg.version : undefined,
            description: typeof pkg.description === 'string' ? pkg.description : undefined,
            sourcePath: pkgRoot,
            bundled: bundledNames.has(name2),
          })
          seen.add(name2)
        }
      }
    }
  }

  return { count: plugins.length, family: 'dsh', profile: profileName, plugins }
}

export function registerPluginRoutes(router: HttpRouter): void {
  router.get('/plugins', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const result = await listDshPlugins()
      return sendJson(res, 200, { ok: true, data: result })
    } catch (err: any) {
      return sendJson(res, 500, { ok: false, error: `读取插件清单失败: ${err?.message || err}`, code: 'INTERNAL_ERROR' })
    }
  })
}
