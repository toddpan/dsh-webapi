#!/usr/bin/env node
/**
 * 对「运行中的 DSH 实例」做端到端验收（默认 http://127.0.0.1:3080）
 *
 * 用法：
 *   node scripts/verify-live.mjs
 *   环境变量：
 *     DSH_WEB_URL      默认 http://127.0.0.1:3080
 *     DSH_WEB_PREFIX   默认 /api/v1
 *     DSH_HOME         默认 ~/.dsh（用于定位 admin-token 与 api-keys.json）
 *     VERIFY_SKIP_AUTH=1   跳过「开启数据面鉴权」那一段（不动线上鉴权状态）
 *
 * 与 scripts/smoke-api-keys.mjs 的分工：
 *   smoke       —— 自包含（自建 router + http server），验证代码逻辑，不进真实进程
 *   verify-live —— 打真实进程，验证「插件确实被 DSH 装载并接线」，这是 smoke 覆盖不到的
 *
 * 安全约定：本脚本会短暂开启数据面鉴权以验证闸门，finally 中一定会关闭并吊销测试 Key。
 *
 * 注意：管理面按「回环 IP」限流（10 次失败/分钟）。本脚本每次运行含 2 次故意的错误令牌
 * 测试，1 分钟内反复运行会打满配额，届时连正确令牌也被短路成 429；脚本会前置探测并提示等待。
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const P = process.env.DSH_WEB_PREFIX || '/api/v1'
const DSH_HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const TOKEN_FILE = path.join(DSH_HOME, 'dsh-web-service', 'admin-token')
const STORE_FILE = path.join(DSH_HOME, 'dsh-web-service', 'api-keys.json')
const SKIP_AUTH = process.env.VERIFY_SKIP_AUTH === '1'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
function section(t) {
  console.log(`\n== ${t} ==`)
}

const adminToken = (await readFile(TOKEN_FILE, 'utf8')).trim()

async function req(method, urlPath, { token, admin, body, origin } = {}) {
  const headers = {}
  if (admin) headers['X-Admin-Token'] = admin
  if (token) headers['Authorization'] = 'Bearer ' + token
  if (origin) headers['Origin'] = origin
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(BASE + urlPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const ct = res.headers.get('content-type') || ''
  let parsed = null
  let text = ''
  if (ct.includes('json')) {
    parsed = await res.json()
  } else {
    text = await res.text()
  }
  return { status: res.status, body: parsed, text, headers: res.headers }
}

/** 自建 Key 登记，便于 finally 里清理 */
const createdIds = []
let authEnabledByUs = false

async function disableAuth() {
  await req('PUT', `${P}/api-keys/auth`, {
    admin: adminToken,
    body: { enabled: false, confirm: 'disable-auth' },
  })
  authEnabledByUs = false
}

try {
  // ==================== 0. 装载确认 ====================
  section('0. 插件装载确认')
  let r = await req('GET', `${P}/system/status`)
  check('运行中的插件已是 0.3.0（新代码被 DSH 装载）', r.body?.data?.version === '0.3.0', `version=${r.body?.data?.version}`)
  check('/system/status 上报 apiKeyCount', typeof r.body?.data?.apiKeyCount === 'number', `apiKeyCount=${r.body?.data?.apiKeyCount}`)
  check('/system/status 上报 keysStoreDegraded', r.body?.data?.keysStoreDegraded === false, `degraded=${r.body?.data?.keysStoreDegraded}`)
  check('初始鉴权未开启', r.body?.data?.authEnabled === false)

  // 前置探测：管理面按「回环 IP」限流（10 次失败/分钟）。本脚本每次运行含 2 次故意的
  // 错误令牌测试，短时间内反复运行会把这个配额打满，届时连正确令牌也会被短路成 429。
  // 这不是缺陷（短路是刻意设计），但会让后续断言全部假失败，所以先探测并明确告知。
  r = await req('GET', `${P}/api-keys`, { admin: adminToken })
  if (r.status === 429) {
    console.error('\n[前置探测] 管理面正在限流：回环 IP 的失败鉴权尝试超过 10 次/分钟。')
    console.error('  常见原因：短时间内反复运行本脚本（每次运行含 2 次故意的错误令牌测试）。')
    console.error('  限流窗口为 60 秒滑动窗口，请稍等约 60 秒后重跑。\n')
    process.exit(2)
  }
  check('前置探测：管理面未处于限流状态', r.status === 200, `status=${r.status}`)

  // ==================== 1. 管理面鉴权 ====================
  section('1. 管理面鉴权')
  r = await req('GET', `${P}/api-keys`)
  check('无令牌 → 401 ADMIN_UNAUTHORIZED', r.status === 401 && r.body?.code === 'ADMIN_UNAUTHORIZED', `status=${r.status} code=${r.body?.code}`)
  check('401 带 Cache-Control: no-store', String(r.headers.get('cache-control')).includes('no-store'))

  r = await req('GET', `${P}/api-keys`, { token: 'definitely-not-the-token' })
  check('错令牌 → 401', r.status === 401, `status=${r.status}`)

  r = await req('GET', `${P}/api-keys`, { admin: adminToken })
  check('X-Admin-Token → 200', r.status === 200 && r.body?.ok === true, `status=${r.status}`)

  r = await req('GET', `${P}/api-keys`, { token: adminToken, origin: 'https://evil.example.com' })
  check('跨源 Origin → 403 FORBIDDEN_ORIGIN', r.status === 403 && r.body?.code === 'FORBIDDEN_ORIGIN', `code=${r.body?.code}`)

  r = await req('GET', `${P}/api-keys`, { token: adminToken })
  check('正确令牌 → 200', r.status === 200)
  check('200 带 Cache-Control: no-store', String(r.headers.get('cache-control')).includes('no-store'))
  check('列表接口不回传 hash/plaintext', !JSON.stringify(r.body).includes('"hash"') && !JSON.stringify(r.body).includes('plaintext'))

  // ==================== 2. 设置页（线上 HTML）====================
  section('2. 设置页')
  r = await req('GET', `${P}/settings/api-keys`)
  const html = r.text
  check('GET /settings/api-keys → 200', r.status === 200, `status=${r.status}`)
  check('Content-Type 为 text/html; charset=utf-8', String(r.headers.get('content-type')).includes('text/html'))
  check('页面带 no-store', String(r.headers.get('cache-control')).includes('no-store'))
  check('含「API Key 管理」区块标题', html.includes('API Key 管理'))
  check('含「新建 API Key」按钮', html.includes('新建 API Key'))
  check('含「Key 值」选择器（随机 / 自定义）', html.includes('id="fKeyMode"'))
  check('含「使用自定义 Key（粘贴已有 Key）」选项', html.includes('使用自定义 Key（粘贴已有 Key）'))
  check('含自定义 Key 输入框', html.includes('id="fCustomKey"'))
  check('页面自身不含任何密钥形态字符串', !/dsk_[A-Za-z0-9_-]{20,}/.test(html))

  // --- 静态集成检查：JS 引用的 id 是否都存在于 HTML ---
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/)
  check('页面含可抽取的 <script>', Boolean(scriptMatch))
  const js = scriptMatch ? scriptMatch[1] : ''
  let syntaxOk = true
  let syntaxErr = ''
  try {
    new vm.Script(js)
  } catch (e) {
    syntaxOk = false
    syntaxErr = e.message
  }
  check('页面 JS 语法可编译（vm.Script）', syntaxOk, syntaxErr)

  const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
  const jsIds = new Set([...js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]))
  const missingIds = [...jsIds].filter((id) => !htmlIds.has(id))
  check(`JS 引用的 ${jsIds.size} 个 element id 全部存在于 HTML`, missingIds.length === 0, missingIds.length ? `缺失: ${missingIds.join(', ')}` : '')

  const definedFns = new Set([...js.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))
  const calledHandlers = new Set([...html.matchAll(/on(?:click|change|input)="([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))
  const missingFns = [...calledHandlers].filter((f) => !definedFns.has(f))
  check(`内联事件调用的 ${calledHandlers.size} 个函数全部已定义`, missingFns.length === 0, missingFns.length ? `缺失: ${missingFns.join(', ')}` : '')

  // ==================== 3. 新建（随机）+ 脱敏 ====================
  section('3. 新建随机 Key 与脱敏')
  r = await req('POST', `${P}/api-keys`, { admin: adminToken, body: { name: 'verify-random', note: 'live verify' } })
  const k1 = r.body?.data
  check('新建 → 201', r.status === 201, `status=${r.status} ${r.body?.error || ''}`)
  check('返回一次性明文（dsk_ 前缀，47 字符）', typeof k1?.plaintext === 'string' && k1.plaintext.startsWith('dsk_') && k1.plaintext.length === 47, `len=${k1?.plaintext?.length}`)
  check('返回一次性的提示语', typeof r.body?.data?.warning === 'string')
  createdIds.push(k1?.key?.id)

  r = await req('GET', `${P}/api-keys`, { admin: adminToken })
  const listed1 = r.body?.data?.keys?.find((k) => k.id === k1.key.id)
  check('列表中该 Key 已脱敏（含 •）', Boolean(listed1?.masked?.includes('•')), `masked=${listed1?.masked}`)
  check('列表响应全文不含该明文', !JSON.stringify(r.body).includes(k1.plaintext))
  check('列表中该 Key 无 hash 字段', listed1 && !('hash' in listed1))

  // 磁盘
  const storeRaw = await readFile(STORE_FILE, 'utf8')
  const storeJson = JSON.parse(storeRaw)
  const stored = storeJson.keys.find((k) => k.id === k1.key.id)
  check('磁盘不含明文', !storeRaw.includes(k1.plaintext))
  check('磁盘只存 sha256 摘要', /^[0-9a-f]{64}$/.test(stored?.hash || ''))
  check('磁盘摘要 == sha256(明文)', stored?.hash === createHash('sha256').update(k1.plaintext, 'utf8').digest('hex'))
  const mode = (await stat(STORE_FILE)).mode & 0o777
  check('api-keys.json 权限 0600', mode === 0o600, `mode=0o${mode.toString(8)}`)

  // ==================== 4. 自定义 Key ====================
  section('4. 自定义 Key（粘贴已有 Key）')
  // 每次运行用唯一值：测试不应依赖上一次运行的残留记录
  const customPlain = 'verify-custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  r = await req('POST', `${P}/api-keys`, { admin: adminToken, body: { name: 'verify-custom', plaintext: customPlain } })
  const k2 = r.body?.data
  check('自定义 Key → 201', r.status === 201, `status=${r.status} ${r.body?.error || ''}`)
  check('标记 custom=true', k2?.key?.custom === true)
  check('不展示任何明文片段', k2?.key?.prefix === '' && !String(k2?.key?.masked).includes(customPlain), `masked=${k2?.key?.masked}`)
  check('提示语说明「自行指定」', /自行指定/.test(r.body?.data?.warning || ''), r.body?.data?.warning)
  createdIds.push(k2?.key?.id)

  r = await req('POST', `${P}/api-keys`, { admin: adminToken, body: { name: 'dup', plaintext: customPlain } })
  check('重复自定义 Key → 400', r.status === 400 && /不能重复登记/.test(r.body?.error || ''), `status=${r.status} ${r.body?.error || ''}`)
  check('自定义 Key 过短 → 400', (await req('POST', `${P}/api-keys`, { admin: adminToken, body: { name: 'a', plaintext: 'tooshort' } })).status === 400)
  check('自定义 Key 含空格 → 400', (await req('POST', `${P}/api-keys`, { admin: adminToken, body: { name: 'a', plaintext: 'has space 0123456789' } })).status === 400)
  const storeRaw2 = await readFile(STORE_FILE, 'utf8')
  check('自定义 Key 明文不落盘', !storeRaw2.includes(customPlain))

  // ==================== 5~7. 鉴权闸门 / 轮换吊销 / 恢复 ====================
  if (SKIP_AUTH) {
    section('5~7. 数据面鉴权（VERIFY_SKIP_AUTH=1，已跳过）')
    console.log('  跳过了「开启鉴权 → 验证数据面闸门 → 轮换/吊销 → 恢复」这一段（不触碰线上鉴权状态）')
  } else {
  section('5. 数据面闸门（短暂开启，稍后恢复）')
  r = await req('PUT', `${P}/api-keys/auth`, { admin: adminToken, body: { enabled: false } })
  check('关闭鉴权缺少 confirm → 400', r.status === 400, `status=${r.status}`)

  r = await req('PUT', `${P}/api-keys/auth`, { admin: adminToken, body: { enabled: true } })
  check('开启鉴权 → 200', r.status === 200 && r.body?.data?.authEnabled === true, `status=${r.status} ${r.body?.error || ''}`)
  authEnabledByUs = r.body?.data?.authEnabled === true

  r = await req('GET', `${P}/system/status`)
  check('[鉴权开] 数据面无 Key → 401', r.status === 401, `status=${r.status}`)
  r = await req('GET', `${P}/system/status`, { token: k1.plaintext })
  check('[鉴权开] 数据面带随机 Key → 200', r.status === 200, `status=${r.status}`)
  r = await req('GET', `${P}/system/status`, { token: customPlain })
  check('[鉴权开] 数据面带自定义 Key → 200', r.status === 200, `status=${r.status}`)
  r = await req('GET', `${P}/system/status`, { token: 'dsk_bogus_key_000000000000' })
  check('[鉴权开] 数据面带错误 Key → 401', r.status === 401, `status=${r.status}`)
  r = await req('GET', `${P}/docs`)
  check('[鉴权开] /docs 仍公开 → 200', r.status === 200, `status=${r.status}`)
  r = await req('GET', `${P}/settings/api-keys`)
  check('[鉴权开] 设置页仍公开 → 200', r.status === 200, `status=${r.status}`)
  r = await req('GET', `${P}/api-keys`, { admin: adminToken })
  check('[鉴权开] 管理面仍可用 admin token → 200', r.status === 200, `status=${r.status}`)
  r = await req('GET', `${P}/api-keys`, { token: k1.plaintext })
  check('[鉴权开] 普通 API Key 不能访问管理面 → 401', r.status === 401, `status=${r.status}`)

  // ==================== 6. 轮换 / 吊销（鉴权开启下验证真实生效）====================
  section('6. 轮换与吊销')
  r = await req('POST', `${P}/api-keys/${k1.key.id}/rotate`, { admin: adminToken })
  const rotated = r.body?.data
  check('轮换 → 200 且返回新明文', r.status === 200 && typeof rotated?.plaintext === 'string', `status=${r.status}`)
  check('轮换后新明文可用', (await req('GET', `${P}/system/status`, { token: rotated.plaintext })).status === 200)
  check('轮换后旧明文立即失效 → 401', (await req('GET', `${P}/system/status`, { token: k1.plaintext })).status === 401)
  createdIds.push(rotated?.key?.id)

  r = await req('POST', `${P}/api-keys/${rotated.key.id}/revoke`, { admin: adminToken })
  check('吊销 → 200 status=revoked', r.status === 200 && r.body?.data?.status === 'revoked', `status=${r.status}`)
  check('吊销后该 Key 立即失效 → 401', (await req('GET', `${P}/system/status`, { token: rotated.plaintext })).status === 401)
  check('吊销幂等 → 200', (await req('POST', `${P}/api-keys/${rotated.key.id}/revoke`, { admin: adminToken })).status === 200)
  check('吊销不存在的 id → 404', (await req('POST', `${P}/api-keys/ks_doesnotexist00/revoke`, { admin: adminToken })).status === 404)

  // ==================== 7. 恢复原状 ====================
  section('7. 恢复原状')
  r = await req('PUT', `${P}/api-keys/auth`, { admin: adminToken, body: { enabled: false, confirm: 'disable-auth' } })
  check('关闭鉴权 → 200', r.status === 200 && r.body?.data?.authEnabled === false, `status=${r.status}`)
  authEnabledByUs = false

  r = await req('GET', `${P}/system/status`)
  check('恢复后数据面无 Key 可访问 → 200', r.status === 200, `status=${r.status}`)
  }
} finally {
  // ---- 无论如何都要恢复：吊销全部测试 Key + 关闭鉴权 ----
  try {
    if (authEnabledByUs) await disableAuth()
  } catch {}
  try {
    const all = await req('GET', `${P}/api-keys`, { admin: adminToken })
    for (const k of all.body?.data?.keys || []) {
      if (k.source !== 'config' && k.status === 'active') {
        await req('POST', `${P}/api-keys/${k.id}/revoke`, { admin: adminToken })
      }
    }
  } catch {}
}

// ==================== 8. 最终状态核对 ====================
section('8. 最终状态')
try {
  const s = await req('GET', `${P}/system/status`)
  check('鉴权已恢复为未开启', s.body?.data?.authEnabled === false, `authEnabled=${s.body?.data?.authEnabled}`)
  check('数据面无 Key 可正常访问', s.status === 200, `status=${s.status}`)
  check('无残留有效 Key', s.body?.data?.apiKeyCount === 0, `apiKeyCount=${s.body?.data?.apiKeyCount}`)
  const finalStore = JSON.parse(await readFile(STORE_FILE, 'utf8'))
  check('store 中无 active Key', finalStore.keys.filter((k) => k.status === 'active').length === 0)
  check('store 中 authEnabled 为 false', finalStore.authEnabled === false, `authEnabled=${finalStore.authEnabled}`)
} catch (e) {
  check('最终状态核对', false, e.message)
}

// ==================== 9. GUI 侧边栏集成（浏览器半边） ====================
section('9. GUI 侧边栏集成（浏览器半边）')
try {
  // 插件侧契约：dsh.client 声明 + ./client 导出 + lib/client.js 存在且合法。
  // 注意：/plugins/<id>/client.js 单资源 URL 返回 404 是 DSH 的设计——浏览器走
  // __DSH_BOOT__ 注入的 /plugins/??<ids>&rev=<hash> 组合端点（rev 校验防篡改），
  // 所以这里不做单 URL 探测；面板是否工作以 GUI 实测为准（embed 页可被 iframe 加载）。
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  check('package.json 声明 dsh.client（platform=web）', pkg.dsh?.client?.platform === 'web')
  check('package.json 导出 ./client', typeof pkg.exports?.['./client']?.default === 'string')
  const js = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  check('lib/client.js 为 ModuleLoader 工厂且注册面板', js.includes('__ModuleLoader__') && js.includes('web-service-api-keys'))

  const livePage = await (await fetch(`${BASE}${P}/settings/api-keys`)).text()
  check('设置页注入令牌 cat 命令（绝对路径）', livePage.includes('cat ') && livePage.includes(TOKEN_FILE))
  check('设置页带未鉴权门守卫（requireAuth）', livePage.includes('requireAuth'))
  check('未鉴权时页头「新建」按钮被收起', livePage.includes('id="btnCreate" style="display:none;"'))

  const liveEmbed = await (await fetch(`${BASE}${P}/settings/api-keys?embed=1`)).text()
  check('embed=1 内嵌标记存在（GUI iframe 用）', liveEmbed.includes('data-embed="1"'))
  check('非 embed 页不带内嵌标记', !livePage.includes('data-embed="1"'))
} catch (e) {
  check('GUI 集成核对', false, e.message)
}

const failed = results.filter((x) => !x.ok)
console.log(`\n==== 线上验收 ${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`)
  process.exit(1)
}
