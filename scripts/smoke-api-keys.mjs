#!/usr/bin/env node
/**
 * API Key 设置页 / 管理接口 冒烟测试
 *
 * 用法：node scripts/smoke-api-keys.mjs
 * 依赖：先执行 bash scripts/build.sh 生成 lib/
 *
 * 覆盖：
 *   管理面鉴权（无令牌/错令牌/跨源/远程）、一次性明文与脱敏、落盘不含明文、
 *   数据面校验（含 HTTP 闸门）、吊销/轮换/幂等、鉴权开关护栏、
 *   删除已吊销记录（有效 Key / config 记录拒删）、
 *   config.apiKey 向后兼容（含短 key 不泄露）、存储损坏 fail-closed 且不丢记录、
 *   落盘失败回滚、恶意记录丢弃、管理面限流短路。
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const { HttpRouter } = await import(path.join(ROOT, 'lib/router.js'))
const { ApiKeyStore } = await import(path.join(ROOT, 'lib/api-keys-store.js'))
const { registerApiKeyRoutes } = await import(path.join(ROOT, 'lib/api-keys.js'))
const { registerOpenApiRoutes } = await import(path.join(ROOT, 'lib/openapi.js'))
const { compareVersions, checkForUpdate } = await import(path.join(ROOT, 'lib/updates.js'))
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const PREFIX = '/api/v1'
const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

async function call(server, method, urlPath, { token, body, origin, host, admin } = {}) {
  const addr = server.address()
  const headers = { 'Content-Type': 'application/json' }
  if (admin) headers['X-Admin-Token'] = admin
  if (token) headers['Authorization'] = 'Bearer ' + token
  if (origin) headers['Origin'] = origin
  if (host) headers['Host'] = host
  const res = await fetch(`http://127.0.0.1:${addr.port}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, body: json, raw: res }
}

/** 起一个带 data 路由的 server，用于验证 HTTP 数据面闸门 */
async function startServer(store, config) {
  const router = new HttpRouter(config)
  router.setAuthService(store)
  registerApiKeyRoutes(router, config, store)
  registerOpenApiRoutes(router, config)
  router.get('/ping', (_req, res) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, data: 'pong' }))
  })
  const server = createServer(async (req, res) => {
    const handled = await router.dispatch(req, res, PREFIX)
    if (!handled && !res.headersSent) {
      res.statusCode = 404
      res.end('not found')
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return server
}

const config = { pathPrefix: PREFIX, cors: true, adminRemoteAccess: false }
const home = await mkdtemp(path.join(tmpdir(), 'dsh-apikeys-'))
const store = new ApiKeyStore('', home)
await store.ensureReady()
const adminToken = await store.ensureAdminToken()
const server = await startServer(store, config)

try {
  // ==================== 管理面鉴权 ====================
  console.log('\n== 管理面鉴权 ==')
  let r = await call(server, 'GET', `${PREFIX}/api-keys`)
  check('无管理令牌 → 401', r.status === 401 && r.body?.code === 'ADMIN_UNAUTHORIZED', `code=${r.body?.code}`)
  check('401 响应带 no-store', String(r.raw.headers.get('cache-control')).includes('no-store'))

  r = await call(server, 'GET', `${PREFIX}/api-keys`, { token: 'wrong-token' })
  check('错误管理令牌 → 401', r.status === 401, `status=${r.status}`)

  r = await call(server, 'GET', `${PREFIX}/api-keys`, { token: adminToken, origin: 'http://evil.example' })
  check('跨源 Origin → 403', r.status === 403 && r.body?.code === 'FORBIDDEN_ORIGIN', `code=${r.body?.code}`)

  r = await call(server, 'GET', `${PREFIX}/api-keys`, { admin: adminToken })
  check('X-Admin-Token 头同样可用', r.status === 200)

  r = await call(server, 'GET', `${PREFIX}/api-keys`, { token: adminToken })
  check('正确管理令牌 → 200', r.status === 200 && r.body?.ok === true)

  const page = await fetch(`http://127.0.0.1:${server.address().port}${PREFIX}/settings/api-keys`)
  const html = await page.text()
  check('设置页 HTML 公开可访问', page.status === 200)
  check('设置页含密钥管理入口', html.includes('API Key 管理') && html.includes('新建 API Key'))
  check('设置页含「设置 API Key」表单（随机/自定义二选一）',
    html.includes('使用自定义 Key（粘贴已有 Key）') &&
    html.includes('随机生成（推荐 · 256 位熵）') &&
    html.includes('id="fCustomKey"'),
  )
  check('设置页不含密钥形态字符串', !/dsk_[A-Za-z0-9_-]{20,}/.test(html))
  check('设置页 JS 用 JSON 字面量注入 BASE', html.includes('const BASE = "/api/v1"'))
  check('令牌门给出可复制的 cat 命令（绝对路径）',
    html.includes('cat ') && html.includes(path.join(home, 'dsh-web-service', 'admin-token')) && html.includes('requireAuth'),
  )
  check('未鉴权时页头「新建」按钮被收起', html.includes('id="btnCreate" style="display:none;"'))
  check('设置页含已吊销删除入口与确认弹层', html.includes('data-act="del"') && html.includes('dlgDelete') && html.includes('submitDelete'))
  check('设置页含 GitHub 项目主页跳转', html.includes('href="https://github.com/toddpan/dsh-webapi"'))
  check('设置页含 SWAGGER 调试入口（新窗口打开 /docs/reference）',
    html.includes('href="' + PREFIX + '/docs/reference"') && html.includes('>SWAGGER</span>'))
  check('设置页页头只保留 SWAGGER/GitHub/问题反馈/检查更新',
    !html.includes('返回 API 文档') && !html.includes('接口文档</span>'))

  // ==================== 版本号 / 页头工具条 / 在线接口文档 ====================
  console.log('\n== 页头工具条与在线接口文档 ==')
  check('设置页标题旁显示版本号', html.includes('v' + pkg.version + '</span>'))
  check('设置页含问题反馈（GitHub Issues）入口', html.includes('github.com/toddpan/dsh-webapi/issues'))
  check('设置页含检查更新入口与结果弹层', html.includes('checkUpdate') && html.includes('dlgUpdate') && html.includes('/system/updates'))

  const docsPage = await fetch(`http://127.0.0.1:${server.address().port}${PREFIX}/docs`)
  const docsHtml = await docsPage.text()
  check('/docs 页公开可访问且含版本号', docsPage.status === 200 && docsHtml.includes('v' + pkg.version + '</span>'), `status=${docsPage.status}`)
  check('/docs 页含 GitHub / 问题反馈 / 检查更新入口',
    docsHtml.includes('github.com/toddpan/dsh-webapi"') && docsHtml.includes('github.com/toddpan/dsh-webapi/issues') && docsHtml.includes('checkUpdate'))
  check('/docs 页含「在线调试 (Swagger)」入口', docsHtml.includes('href="' + PREFIX + '/docs/reference"'))

  const refPage = await fetch(`http://127.0.0.1:${server.address().port}${PREFIX}/docs/reference`)
  const refHtml = await refPage.text()
  check('/docs/reference 公开可访问且指向 openapi.json',
    refPage.status === 200 && refHtml.includes("url: '" + PREFIX + "/openapi.json'"), `status=${refPage.status}`)
  check('/docs/reference 为 Swagger UI 且默认开启在线调试',
    refHtml.includes('SwaggerUIBundle') && refHtml.includes('tryItOutEnabled') && refHtml.includes('persistAuthorization'))
  check('/docs/reference 含 CDN 失败降级指引', refHtml.includes('cdn-fail') && refHtml.includes(PREFIX + '/docs'))
  const spec = await (await fetch(`http://127.0.0.1:${server.address().port}${PREFIX}/openapi.json`)).json()
  check('openapi.json 版本与包版本一致', spec.info.version === pkg.version)
  check('spec 根级 security 覆盖 Bearer / API Key（Swagger Authorize 可用）',
    Array.isArray(spec.security) && spec.security.some((s) => s.BearerAuth) && spec.security.some((s) => s.ApiKeyAuth))
  check('spec 声明三种鉴权方案（Bearer / X-API-Key / X-Admin-Token）',
    spec.components?.securitySchemes?.BearerAuth && spec.components?.securitySchemes?.ApiKeyAuth && spec.components?.securitySchemes?.AdminTokenAuth)

  // compareVersions 单元检查
  check('版本比较：0.3.0 < 0.10.1', compareVersions('0.3.0', '0.10.1') < 0)
  check('版本比较：v1.0.0 > 0.9.9', compareVersions('v1.0.0', '0.9.9') > 0)
  check('版本比较：1.2.3 = v1.2.3', compareVersions('1.2.3', 'v1.2.3') === 0)
  check('版本比较：1.0.0-rc.1 < 1.0.0', compareVersions('1.0.0-rc.1', '1.0.0') < 0)
  check('版本比较：0.3.0 = 0.3', compareVersions('0.3.0', '0.3') === 0)

  // checkForUpdate：无论网络可达与否都返回规整结构（不抛错；离线时 latest=null + error）
  const upd = await checkForUpdate(pkg.version)
  check('checkForUpdate 返回规整结构',
    upd && upd.current === pkg.version && typeof upd.releaseUrl === 'string' && upd.checkedAt > 0 &&
    [true, false, null].includes(upd.updateAvailable),
    `latest=${upd.latest} error=${upd.error || '—'}`)

  const embedPage = await fetch(`http://127.0.0.1:${server.address().port}${PREFIX}/settings/api-keys?embed=1`)
  const embedHtml = await embedPage.text()
  check('embed=1 → 200 且带内嵌标记', embedPage.status === 200 && embedHtml.includes('data-embed="1"'))
  check('非 embed 页不带内嵌标记', !html.includes('data-embed="1"'))

  // ==================== 一次性明文与脱敏 ====================
  console.log('\n== 一次性明文与脱敏 ==')
  r = await call(server, 'POST', `${PREFIX}/api-keys`, {
    token: adminToken,
    body: { name: 'smoke-client', note: "Bob's R&D \"prod\" key" },
  })
  const created = r.body?.data
  check('新建 → 201 且返回明文', r.status === 201 && typeof created?.plaintext === 'string', `plaintext 长度=${created?.plaintext?.length}`)
  check('明文前缀正确', created?.plaintext?.startsWith('dsk_'))
  check('名称/备注不吞用户合法字符', created?.key?.note === 'Bob\'s R&D "prod" key', `note=${created?.key?.note}`)
  check('创建响应带 no-store', String(r.raw.headers.get('cache-control')).includes('no-store'))
  const keyId = created?.key?.id

  const listing = await call(server, 'GET', `${PREFIX}/api-keys`, { token: adminToken })
  const listed = listing.body?.data?.keys?.find((k) => k.id === keyId)
  check('列表返回脱敏视图', listed && listed.masked.includes('•') && !('hash' in listed) && !('plaintext' in listed))
  check('列表不含明文', JSON.stringify(listing.body).indexOf(created.plaintext) === -1)

  const storeFile = path.join(home, 'dsh-web-service', 'api-keys.json')
  const persisted = JSON.parse(await readFile(storeFile, 'utf8'))
  check('落盘不含明文', JSON.stringify(persisted).indexOf(created.plaintext) === -1)
  check('落盘仅存哈希', persisted.keys.every((k) => k.hash === '' || /^[0-9a-f]{64}$/.test(k.hash)))
  const tokenFileMode = (await stat(path.join(home, 'dsh-web-service', 'admin-token'))).mode & 0o777
  check('admin-token 权限 0600', tokenFileMode === 0o600, `mode=0o${tokenFileMode.toString(8)}`)

  // ==================== 输入校验 ====================
  console.log('\n== 输入校验 ==')
  check('name 超长 → 400', (await call(server, 'POST', `${PREFIX}/api-keys`, { token: adminToken, body: { name: 'x'.repeat(65) } })).status === 400)
  check('expiresInDays 溢出 → 400', (await call(server, 'POST', `${PREFIX}/api-keys`, { token: adminToken, body: { name: 'a', expiresInDays: 1e308 } })).status === 400)
  check('expiresInDays 超范围 → 400', (await call(server, 'POST', `${PREFIX}/api-keys`, { token: adminToken, body: { name: 'a', expiresInDays: 99999 } })).status === 400)
  check('note 含控制字符 → 400', (await call(server, 'POST', `${PREFIX}/api-keys`, { token: adminToken, body: { name: 'a', note: 'x\u0000y' } })).status === 400)

  // ==================== 自定义 Key（粘贴已有 Key） ====================
  console.log('\n== 自定义 Key ==')
  const customPlain = 'my-existing-api-key-0123456789'
  r = await call(server, 'POST', `${PREFIX}/api-keys`, {
    token: adminToken,
    body: { name: 'imported', plaintext: customPlain },
  })
  check('自定义 Key 创建成功', r.status === 201 && r.body?.data?.plaintext === customPlain, `status=${r.status} ${r.body?.error || ''}`)
  check('自定义 Key 标记 custom', r.body?.data?.key?.custom === true, `masked=${r.body?.data?.key?.masked}`)
  check('自定义 Key 不展示任何明文片段', r.body?.data?.key?.prefix === '' && !String(r.body?.data?.key?.masked).includes(customPlain), `masked=${r.body?.data?.key?.masked}`)
  check('自定义 Key 可作数据面凭证', store.verifyDataToken(customPlain).ok === true)
  const customListed = JSON.stringify((await call(server, 'GET', `${PREFIX}/api-keys`, { token: adminToken })).body)
  check('自定义 Key 明文不出现在列表', customListed.indexOf(customPlain) === -1)
  check('自定义 Key 明文不落盘', (await readFile(storeFile, 'utf8')).indexOf(customPlain) === -1)

  r = await call(server, 'POST', `${PREFIX}/api-keys`, { token: adminToken, body: { name: 'dup', plaintext: customPlain } })
  check('重复自定义 Key → 400', r.status === 400 && /不能重复登记/.test(r.body?.error || ''), `status=${r.status} ${r.body?.error || ''}`)
  check('自定义 Key 过短 → 400', (await call(server, 'POST', `${PREFIX}/api-keys`, { token: adminToken, body: { name: 'a', plaintext: 'short' } })).status === 400)
  check('自定义 Key 含换行 → 400', (await call(server, 'POST', `${PREFIX}/api-keys`, { token: adminToken, body: { name: 'a', plaintext: 'has-newline-0123456789\nabc' } })).status === 400)
  check('自定义 Key 含空格 → 400', (await call(server, 'POST', `${PREFIX}/api-keys`, { token: adminToken, body: { name: 'a', plaintext: 'has space 0123456789' } })).status === 400)

  // 吊销后应允许重新登记同一个值（只有仍有效的记录才阻止重复）
  const importedId = (await call(server, 'GET', `${PREFIX}/api-keys`, { token: adminToken })).body?.data?.keys?.find((k) => k.name === 'imported')?.id
  await call(server, 'POST', `${PREFIX}/api-keys/${importedId}/revoke`, { token: adminToken })
  r = await call(server, 'POST', `${PREFIX}/api-keys`, { token: adminToken, body: { name: 'imported-again', plaintext: customPlain } })
  check('吊销后可重新登记同一 Key 值 → 201', r.status === 201, `status=${r.status} ${r.body?.error || ''}`)
  check('重新登记后该 Key 值恢复可用', store.verifyDataToken(customPlain).ok === true)

  // ==================== 数据面校验 ====================
  console.log('\n== 数据面校验 ==')
  check('明文可作为数据面凭证', store.verifyDataToken(created.plaintext).ok === true)
  check('错误 token 校验失败', store.verifyDataToken('dsk_wrong').ok === false)

  // HTTP 闸门：开启鉴权后无 key 401 / 带 key 200
  await store.setAuthEnabled(true)
  r = await call(server, 'GET', `${PREFIX}/ping`)
  check('HTTP：鉴权开启 + 无 key → 401', r.status === 401, `status=${r.status}`)
  r = await call(server, 'GET', `${PREFIX}/ping`, { token: created.plaintext })
  check('HTTP：鉴权开启 + 有效 key → 200', r.status === 200, `status=${r.status}`)
  r = await call(server, 'GET', `${PREFIX}/ping`, { token: 'dsk_bogus' })
  check('HTTP：鉴权开启 + 错误 key → 401', r.status === 401, `status=${r.status}`)
  r = await call(server, 'GET', `${PREFIX}/settings/api-keys`)
  check('HTTP：设置页在鉴权开启后仍公开', r.status === 200, `status=${r.status}`)
  r = await call(server, 'GET', `${PREFIX}/api-keys`, { token: adminToken })
  check('HTTP：鉴权开启后管理面仍可用 admin token', r.status === 200, `status=${r.status}`)

  // ==================== 吊销 / 轮换 ====================
  console.log('\n== 吊销 / 轮换 ==')
  r = await call(server, 'POST', `${PREFIX}/api-keys/${keyId}/rotate`, { token: adminToken })
  check('轮换 → 新明文', r.status === 200 && typeof r.body?.data?.plaintext === 'string')
  const rotatedPlain = r.body?.data?.plaintext
  check('轮换后旧明文失效', store.verifyDataToken(created.plaintext).ok === false)
  check('轮换后新明文有效', store.verifyDataToken(rotatedPlain).ok === true)

  const newId = r.body?.data?.key?.id
  r = await call(server, 'POST', `${PREFIX}/api-keys/${newId}/revoke`, { token: adminToken })
  check('吊销 → 200', r.status === 200 && r.body?.data?.status === 'revoked')
  check('吊销后不可用', store.verifyDataToken(rotatedPlain).ok === false)
  r = await call(server, 'POST', `${PREFIX}/api-keys/${newId}/revoke`, { token: adminToken })
  check('吊销幂等', r.status === 200)
  check('PATCH 不存在的 id → 404', (await call(server, 'PATCH', `${PREFIX}/api-keys/ks_no_such_key1`, { token: adminToken, body: { name: 'x' } })).status === 404)
  check('保留命名空间 PATCH /settings/api-keys → 404', (await call(server, 'PATCH', `${PREFIX}/settings/api-keys`, { token: created.plaintext, body: { a: 1 } })).status === 404)

  // ==================== 鉴权开关护栏 ====================
  console.log('\n== 鉴权开关护栏 ==')
  const keeper = (await call(server, 'POST', `${PREFIX}/api-keys`, { token: adminToken, body: { name: 'keeper' } })).body?.data
  check('无 confirm 关闭鉴权 → 400', (await call(server, 'PUT', `${PREFIX}/api-keys/auth`, { token: adminToken, body: { enabled: false } })).status === 400)
  r = await call(server, 'PUT', `${PREFIX}/api-keys/auth`, { token: adminToken, body: { enabled: false, confirm: 'disable-auth' } })
  check('带 confirm 关闭鉴权 → 200', r.status === 200 && r.body?.data?.authEnabled === false)
  r = await call(server, 'PUT', `${PREFIX}/api-keys/auth`, { token: adminToken, body: { enabled: true } })
  check('开启鉴权 → 200', r.status === 200 && r.body?.data?.authEnabled === true)
  check('生成的 Key 仍有效', store.verifyDataToken(keeper.plaintext).ok === true)

  // ==================== 删除已吊销记录 ====================
  console.log('\n== 删除已吊销记录 ==')
  r = await call(server, 'DELETE', `${PREFIX}/api-keys/${keeper.key.id}`, { token: adminToken })
  check('删除仍有效的 Key → 404', r.status === 404 && r.body?.code === 'KEY_NOT_FOUND', `status=${r.status} ${r.body?.error || ''}`)
  check('有效 Key 未受删除影响', store.verifyDataToken(keeper.plaintext).ok === true)

  r = await call(server, 'DELETE', `${PREFIX}/api-keys/${newId}`, { token: adminToken })
  check('删除已吊销记录 → 200', r.status === 200, `status=${r.status} ${r.body?.error || ''}`)
  check('已删除记录从列表消失', !(await call(server, 'GET', `${PREFIX}/api-keys`, { token: adminToken })).body?.data?.keys?.some((k) => k.id === newId))
  check('已删除记录落盘同步移除', !JSON.parse(await readFile(storeFile, 'utf8')).keys.some((k) => k.id === newId))
  check('重复删除同一记录 → 404', (await call(server, 'DELETE', `${PREFIX}/api-keys/${newId}`, { token: adminToken })).status === 404)
  check('删除不存在的 id → 404', (await call(server, 'DELETE', `${PREFIX}/api-keys/ks_no_such_key2`, { token: adminToken })).status === 404)

  // ==================== config.apiKey 向后兼容 ====================
  console.log('\n== config.apiKey 向后兼容（含短 key） ==')
  const legacyHome = await mkdtemp(path.join(tmpdir(), 'dsh-apikeys-legacy-'))
  const legacyStore = new ApiKeyStore('shortkey12', legacyHome)
  await legacyStore.ensureReady()
  check('遗留 Key 可校验', legacyStore.verifyDataToken('shortkey12').ok === true)
  check('config.apiKey 强制开启鉴权', legacyStore.isEnforced() === true)
  const legacyView = legacyStore.list().find((k) => k.source === 'config')
  check('遗留记录只读', legacyView?.readOnly === true)
  check('遗留记录不展示任何明文片段', legacyView?.prefix === '' && !String(legacyView?.masked).includes('shortkey12'), `masked=${legacyView?.masked}`)
  const legacyFileRaw = await readFile(path.join(legacyHome, 'dsh-web-service', 'api-keys.json'), 'utf8')
  check('遗留明文不落盘', legacyFileRaw.indexOf('shortkey12') === -1)
  const legacyPersisted = JSON.parse(legacyFileRaw)
  check('遗留记录不落 hash', legacyPersisted.keys.find((k) => k.source === 'config')?.hash === '')
  let dupLegacy = false
  try {
    await legacyStore.create({ name: 'dup-legacy', plaintext: 'shortkey12' })
  } catch {
    dupLegacy = true
  }
  check('自定义 Key 与 config.apiKey 相同 → 拒绝', dupLegacy)
  check('config 记录不可删除', (await legacyStore.remove('cfg-legacy')) === null)
  check('config 记录删除尝试后仍在', legacyStore.list().some((k) => k.id === 'cfg-legacy'))
  await rm(legacyHome, { recursive: true, force: true })

  // ==================== 存储损坏：fail-closed 且不丢记录 ====================
  console.log('\n== 存储损坏 ==')
  const corruptHome = await mkdtemp(path.join(tmpdir(), 'dsh-apikeys-corrupt-'))
  const c1 = new ApiKeyStore('', corruptHome)
  await c1.ensureReady()
  await c1.create({ name: 'keep-me' })
  await c1.create({ name: 'keep-me-too' })
  await writeFile(path.join(corruptHome, 'dsh-web-service', 'api-keys.json'), 'CORRUPT-EVIDENCE')
  const c2 = new ApiKeyStore('', corruptHome)
  await c2.ensureReady()
  check('损坏 → degraded', c2.degraded === true)
  check('损坏 → fail-closed（isEnforced=true）', c2.isEnforced() === true, `authEnabledFlag 应被忽略`)
  check('损坏 → managed key 一律拒绝', c2.verifyDataToken('dsk_anything').ok === false)
  const corruptDir = await readdir(path.join(corruptHome, 'dsh-web-service'))
  check('损坏文件取证保留（.corrupt-*）', corruptDir.some((f) => f.startsWith('api-keys.json.corrupt-')))
  check('损坏 → 从 .bak 恢复出原有记录，不丢', c2.list().length === 2, `keys=${c2.list().map((k) => k.name).join(',')}`)
  // 恢复后再写入不应再次丢记录
  await c2.create({ name: 'after-corrupt' })
  check('损坏恢复后新增不吞旧记录', c2.list().length === 3)

  // ==================== 落盘失败回滚 ====================
  console.log('\n== 落盘失败回滚 ==')
  const rbHome = await mkdtemp(path.join(tmpdir(), 'dsh-apikeys-rb-'))
  const rb = new ApiKeyStore('', rbHome)
  await rb.ensureReady()
  await rb.create({ name: 'survivor' })
  const rbDir = path.join(rbHome, 'dsh-web-service')
  await chmod(rbDir, 0o500)
  let threw = false
  try {
    await rb.create({ name: 'should-not-exist' })
  } catch {
    threw = true
  }
  await chmod(rbDir, 0o700)
  check('落盘失败 → create 抛错', threw)
  check('落盘失败 → 内存回滚，未凭空多出 Key', rb.list().length === 1 && rb.list()[0].name === 'survivor', `keys=${rb.list().map((k) => k.name).join(',')}`)
  const rbFile = JSON.parse(await readFile(path.join(rbDir, 'api-keys.json'), 'utf8'))
  check('落盘失败 → 磁盘未写入失败记录', rbFile.keys.length === 1)

  // ==================== 恶意记录丢弃（防存储型 XSS） ====================
  console.log('\n== 恶意记录丢弃 ==')
  const evilHome = await mkdtemp(path.join(tmpdir(), 'dsh-apikeys-evil-'))
  const evilDir = path.join(evilHome, 'dsh-web-service')
  await chmod(evilDir, 0o700).catch(() => undefined)
  const evil = new ApiKeyStore('', evilHome)
  await evil.ensureReady()
  await evil.create({ name: 'good' })
  const evilFile = path.join(evilDir, 'api-keys.json')
  const evilJson = JSON.parse(await readFile(evilFile, 'utf8'))
  evilJson.keys.push({
    id: "ks_x');globalThis.__PWNED=1;//",
    name: 'evil',
    prefix: 'dsk_evil',
    hash: 'a'.repeat(64),
    algo: 'sha256',
    createdAt: Date.now(),
    status: 'active',
    source: 'managed',
  })
  await writeFile(evilFile, JSON.stringify(evilJson, null, 2))
  const evil2 = new ApiKeyStore('', evilHome)
  await evil2.ensureReady()
  check('非法 id 记录被丢弃', evil2.list().length === 1, `keys=${evil2.list().map((k) => k.id).join(',')}`)

  await rm(legacyHome, { recursive: true, force: true })
  await rm(corruptHome, { recursive: true, force: true })
  await rm(rbHome, { recursive: true, force: true })
  await rm(evilHome, { recursive: true, force: true })

  // ==================== 管理面限流短路（必须最后跑） ====================
  console.log('\n== 管理面限流短路 ==')
  for (let i = 0; i < 12; i++) {
    await call(server, 'GET', `${PREFIX}/api-keys`, { token: 'brute-force-attempt' })
  }
  r = await call(server, 'GET', `${PREFIX}/api-keys`, { token: adminToken })
  check('超限后正确令牌也被短路 → 429', r.status === 429 && r.body?.code === 'RATE_LIMITED', `status=${r.status}`)
} finally {
  server.close()
  await rm(home, { recursive: true, force: true })
}

const failed = results.filter((x) => !x.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(`  - ${f.name} ${f.detail || ''}`)
  process.exit(1)
}
