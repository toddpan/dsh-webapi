#!/usr/bin/env node
/**
 * 独立 API 服务（端口 / 监听范围 / 启停）冒烟测试
 *
 * 用法：bash scripts/build.sh && node scripts/smoke-service-port.mjs
 *
 * 通过 stub cordis ctx 直接调用插件 apply()，用真实 HTTP 服务器与真实设置文件端到端覆盖：
 *   首次安装自动分配端口并启动、重载后按期望状态恢复（autoStart）、停止后不自动拉起、
 *   启停即时生效、监听范围 0.0.0.0 暴露面与可访问地址、端口被占用 409 且现状回滚、
 *   同端口换绑监听范围、经独立服务自身停止（响应不被 close 阻塞）、
 *   旧版 fixedPort 持久化迁移、旧版 /api-keys/port 兼容、插件配置 standalonePort 首次回退。
 */

import net from 'node:net'
import os from 'node:os'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = new URL('..', import.meta.url).pathname
const { apply } = await import(path.join(ROOT, 'lib/index.js'))

const PREFIX = '/api/v1'
const DEFAULT_PORT_FLOOR = 31800
const DEFAULT_PORT_CEIL = 31899
const results = []

function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

/** 取一个当前空闲的回环端口（关闭探针后立刻使用，理论上有微小竞态） */
function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, host, () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
    srv.on('error', reject)
  })
}

/** stub cordis ctx：webServer 是真实 HTTP 服务器（prefix handler 委派给插件注册的 handler） */
function stubCtx() {
  return new Promise((resolve) => {
    const disposers = []
    let mainHandler = null
    const register = (opts) => { mainHandler = opts.handler }
    const server = http.createServer((req, res) => {
      if (!mainHandler) { res.statusCode = 404; res.end(); return }
      Promise.resolve(mainHandler(req, res)).catch((err) => {
        if (!res.headersSent) { res.statusCode = 500; res.end(String(err?.message || err)) }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        port,
        get(key) {
          if (key === 'webServer') return { port, register }
          if (key === 'llm') return { listProviders: () => [] }
          if (key === 'workspaceRegistry') return { list: () => [] }
          return undefined // tools 不注入，跳过 Tool 注册
        },
        effect(fn) {
          // cordis 语义：立即执行 effect 体，返回值（若为函数）即 disposer
          const result = fn()
          if (typeof result === 'function') disposers.push(result)
        },
        on() {
          return () => undefined
        },
        webServer: { register },
        async dispose() {
          for (const d of disposers) {
            try { await d() } catch { /* 幂等 */ }
          }
          await new Promise((r) => server.close(() => r()))
          await sleep(50)
        },
      })
    })
  })
}

async function bootPlugin(config) {
  const ctx = await stubCtx()
  await apply(ctx, config)
  return { ctx, mainPort: ctx.port, dispose: ctx.dispose }
}

async function call(host, port, method, urlPath, { token, body, timeout = 5000 } = {}) {
  const res = await fetch(`http://${host}:${port}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Admin-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  let json = null
  try { json = await res.json() } catch { /* 非 JSON */ }
  return { status: res.status, body: json }
}

/** 新建 TCP 连接探测端口是否在监听（不受客户端 keep-alive 连接池影响） */
function listening(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
    socket.setTimeout(1500, () => { socket.destroy(); resolve(false) })
  })
}

async function reachable(host, port) {
  try {
    const res = await fetch(`http://${host}:${port}${PREFIX}/system/status`, {
      signal: AbortSignal.timeout(1500),
    })
    await res.arrayBuffer()
    return res.status === 200
  } catch {
    return false
  }
}

async function readAdminToken(home, tries = 40) {
  const file = path.join(home, 'dsh-web-service', 'admin-token')
  for (let i = 0; i < tries; i++) {
    try { return (await readFile(file, 'utf8')).trim() } catch { await sleep(100) }
  }
  throw new Error('admin-token 文件未生成')
}

function lanIpsOf() {
  const out = new Set()
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (!a.internal && !a.address.includes(':')) out.add(a.address)
    }
  }
  return [...out]
}
const lanIps = lanIpsOf()

async function readSettings(home) {
  const raw = await readFile(path.join(home, 'dsh-web-service', 'service-settings.json'), 'utf8')
  return JSON.parse(raw)
}

const homeA = await mkdtemp(path.join(tmpdir(), 'dsh-svc-a-'))
const baseConfig = {
  pathPrefix: PREFIX,
  apiKey: '',
  standalonePort: 0,
  cors: false,
  defaultCwd: ROOT,
  maxUploadBytes: 1024 * 1024,
  adminRemoteAccess: false,
  dshHome: homeA,
}

/** 常见断言：状态形状与运行中的 URL */
function assertRunning(d, expectedPort, expectedBindIp, label) {
  check(
    `${label} 状态 running/port/bindIp/listeningPort 一致`,
    d.running === true && d.port === expectedPort && d.listeningPort === expectedPort && d.bindIp === expectedBindIp,
    JSON.stringify({ running: d.running, port: d.port, listeningPort: d.listeningPort, bindIp: d.bindIp }),
  )
  const expectedUrls = [`http://127.0.0.1:${expectedPort}${PREFIX}`]
  if (expectedBindIp === '0.0.0.0') {
    for (const ip of lanIps) expectedUrls.push(`http://${ip}:${expectedPort}${PREFIX}`)
  }
  check(`${label} urls = 回环${expectedBindIp === '0.0.0.0' ? ' + 局域网 IPv4' : ''}`,
    JSON.stringify(d.urls) === JSON.stringify(expectedUrls), JSON.stringify(d.urls))
}

// ============ Phase A：首次安装自动分配端口 ============
console.log('\n== Phase A：首次安装自动生成端口并启动 ==')
const bootA = await bootPlugin({ ...baseConfig })
const adminToken = await readAdminToken(homeA)

let r = await call('127.0.0.1', bootA.mainPort, 'GET', `${PREFIX}/api-keys/service`)
check('A1 无令牌 → 401', r.status === 401, `status=${r.status}`)

r = await call('127.0.0.1', bootA.mainPort, 'GET', `${PREFIX}/api-keys/service`, { token: adminToken })
const dA = r.body?.data || {}
check('A2 首次安装自动分配端口（31800-31899）',
  r.status === 200 && dA.running === true && dA.port >= DEFAULT_PORT_FLOOR && dA.port <= DEFAULT_PORT_CEIL,
  JSON.stringify({ status: r.status, port: dA.port }))
check('A2 默认监听 127.0.0.1', dA.bindIp === '127.0.0.1', String(dA.bindIp))
assertRunning(dA, dA.port, '127.0.0.1', 'A2')
check('A2 独立端口上 /system/status 可用', await reachable('127.0.0.1', dA.port),
  `http://127.0.0.1:${dA.port}${PREFIX}/system/status`)

r = await call('127.0.0.1', dA.port, 'GET', `${PREFIX}/system/status`)
check('A3 system/status 回带 standalonePort/standaloneRunning/standaloneBindIp',
  r.status === 200 && r.body?.data?.standalonePort === dA.port &&
  r.body?.data?.standaloneRunning === true && r.body?.data?.standaloneBindIp === '127.0.0.1',
  JSON.stringify({ port: r.body?.data?.standalonePort, running: r.body?.data?.standaloneRunning }))

const persistedA = await readSettings(homeA)
check('A4 设置已落盘 { port, bindIp, autoStart:true }（写入新字段）',
  persistedA.port === dA.port && persistedA.bindIp === '127.0.0.1' && persistedA.autoStart === true && !('fixedPort' in persistedA),
  JSON.stringify(persistedA))

r = await call('127.0.0.1', bootA.mainPort, 'POST', `${PREFIX}/api-keys/service/start`,
  { token: adminToken, body: { port: dA.port, bindIp: '127.0.0.1' } })
check('A5 重复启动同地址 → 200 且保持运行', r.status === 200 && r.body?.data?.running === true, JSON.stringify(r.body?.data?.message))

r = await call('127.0.0.1', bootA.mainPort, 'POST', `${PREFIX}/api-keys/service/start`,
  { token: adminToken, body: { port: 80 } })
check('A6 特权端口 80 → 400', r.status === 400 && r.body?.code === 'BAD_REQUEST', JSON.stringify(r.body))

r = await call('127.0.0.1', bootA.mainPort, 'POST', `${PREFIX}/api-keys/service/start`,
  { token: adminToken, body: { bindIp: '192.168.1.66' } })
check('A6 非法 bindIp → 400', r.status === 400 && String(r.body?.error).includes('0.0.0.0'), JSON.stringify(r.body))

r = await call('127.0.0.1', bootA.mainPort, 'GET', `${PREFIX}/api-keys/service/free-port`, { token: adminToken })
const suggested = r.body?.data?.port
check('A7 空闲端口建议在默认区间且不同于当前监听',
  r.status === 200 && Number.isInteger(suggested) && suggested >= DEFAULT_PORT_FLOOR &&
  suggested <= DEFAULT_PORT_CEIL && suggested !== dA.port, String(suggested))

// ============ Phase B：停止 / 启动 / 端口占用 / 换绑 ============
console.log('\n== Phase B：启停、端口占用回滚、同端口换绑 ==')
r = await call('127.0.0.1', bootA.mainPort, 'POST', `${PREFIX}/api-keys/service/stop`, { token: adminToken, body: {} })
const dStop = r.body?.data || {}
check('B1 停止 → running:false / urls 为空', r.status === 200 && dStop.running === false && dStop.listeningPort === 0 &&
  Array.isArray(dStop.urls) && dStop.urls.length === 0, JSON.stringify({ status: r.status, running: dStop.running }))
check('B1 停止后保留端口', dStop.port === dA.port, String(dStop.port))
check('B1 停止后原地址不再监听', !(await listening('127.0.0.1', dA.port)), `port ${dA.port}`)
const persistedStop = await readSettings(homeA)
check('B1 autoStart 落盘为 false', persistedStop.autoStart === false && persistedStop.port === dA.port, JSON.stringify(persistedStop))

const portB = await freePort()
r = await call('127.0.0.1', bootA.mainPort, 'POST', `${PREFIX}/api-keys/service/start`,
  { token: adminToken, body: { port: portB, bindIp: '0.0.0.0' } })
const dB = r.body?.data || {}
assertRunning(dB, portB, '0.0.0.0', 'B2')
check('B2 exposedToLan=true', dB.exposedToLan === true, String(dB.exposedToLan))
let lanReachable = lanIps.length === 0
for (const ip of lanIps) {
  if (await reachable(ip, portB)) { lanReachable = true; break }
}
check('B2 局域网地址可达（若有局域网网卡）', lanReachable, lanIps.join(',') || '(无局域网网卡)')

// B3 端口被占用：现状不变（仍监听 portB），返回 409
const blocker = net.createServer()
await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
const occupiedPort = blocker.address().port
r = await call('127.0.0.1', bootA.mainPort, 'POST', `${PREFIX}/api-keys/service/start`,
  { token: adminToken, body: { port: occupiedPort, bindIp: '127.0.0.1' } })
check('B3 端口被占用 → 409 且错误可读', r.status === 409 && String(r.body?.error).includes(String(occupiedPort)), JSON.stringify(r.body))
const afterFail = await call('127.0.0.1', bootA.mainPort, 'GET', `${PREFIX}/api-keys/service`, { token: adminToken })
check('B3 失败不改变现状（仍在 portB 监听）',
  afterFail.body?.data?.running === true && afterFail.body?.data?.listeningPort === portB &&
  afterFail.body?.data?.bindIp === '0.0.0.0', JSON.stringify(afterFail.body?.data))
await new Promise((resolve) => blocker.close(resolve))

// B4 同端口换绑监听范围：0.0.0.0 → 127.0.0.1
r = await call('127.0.0.1', bootA.mainPort, 'POST', `${PREFIX}/api-keys/service/start`,
  { token: adminToken, body: { port: portB, bindIp: '127.0.0.1' } })
const dB2 = r.body?.data || {}
assertRunning(dB2, portB, '127.0.0.1', 'B4')
check('B4 同端口换绑后仅回环地址', JSON.stringify(dB2.urls) === JSON.stringify([`http://127.0.0.1:${portB}${PREFIX}`]), JSON.stringify(dB2.urls))

// B5 经独立服务自身停止：响应必须及时返回（不能被 close 阻塞）
r = await call('127.0.0.1', portB, 'POST', `${PREFIX}/api-keys/service/stop`, { token: adminToken, body: {}, timeout: 3000 })
check('B5 经独立端口停止 → 200 且立即返回', r.status === 200 && r.body?.data?.running === false, JSON.stringify({ status: r.status, running: r.body?.data?.running }))
check('B5 停止后原地址不再监听', !(await listening('127.0.0.1', portB)), `port ${portB}`)

// B6 同一端口再次启动（套接字已释放）
r = await call('127.0.0.1', bootA.mainPort, 'POST', `${PREFIX}/api-keys/service/start`,
  { token: adminToken, body: { port: portB, bindIp: '127.0.0.1' } })
check('B6 停止后同端口重启成功', r.status === 200 && r.body?.data?.running === true && r.body?.data?.listeningPort === portB, JSON.stringify(r.body?.error))
check('B6 重启后可达', await reachable('127.0.0.1', portB), `port ${portB}`)

// ============ Phase C：持久化、迁移、兼容、页面 ============
console.log('\n== Phase C：重载恢复、旧格式迁移、兼容接口、页面 ==')
await bootA.dispose()

const bootA2 = await bootPlugin({ ...baseConfig })
let rA2 = await call('127.0.0.1', bootA2.mainPort, 'GET', `${PREFIX}/api-keys/service`, { token: adminToken })
check('C1 重载后按 autoStart 自动恢复同一端口',
  rA2.body?.data?.running === true && rA2.body?.data?.listeningPort === portB && rA2.body?.data?.bindIp === '127.0.0.1',
  JSON.stringify({ running: rA2.body?.data?.running, port: rA2.body?.data?.listeningPort }))
check('C1 恢复后可达', await reachable('127.0.0.1', portB), `port ${portB}`)

await call('127.0.0.1', bootA2.mainPort, 'POST', `${PREFIX}/api-keys/service/stop`, { token: adminToken, body: {} })
await bootA2.dispose()
const bootA3 = await bootPlugin({ ...baseConfig })
const rA3 = await call('127.0.0.1', bootA3.mainPort, 'GET', `${PREFIX}/api-keys/service`, { token: adminToken })
check('C2 停止过 → 重载后保持停止，端口保留',
  rA3.body?.data?.running === false && rA3.body?.data?.port === portB, JSON.stringify({ running: rA3.body?.data?.running, port: rA3.body?.data?.port }))
check('C2 保持停止时原地址不再监听', !(await listening('127.0.0.1', portB)), `port ${portB}`)

// C3 旧版持久化格式 { fixedPort }：迁移为 port + autoStart，并自动启动
const homeLegacy = await mkdtemp(path.join(tmpdir(), 'dsh-svc-legacy-'))
const { mkdir, writeFile } = await import('node:fs/promises')
const legacyDir = path.join(homeLegacy, 'dsh-web-service')
await mkdir(legacyDir, { recursive: true })
const legacyPort = await freePort()
await writeFile(path.join(legacyDir, 'service-settings.json'),
  JSON.stringify({ fixedPort: legacyPort, bindIp: '127.0.0.1', updatedAt: Date.now() }) + '\n')
const legacyToken = 'legacy-admin-token-cli-test'
await writeFile(path.join(legacyDir, 'admin-token'), legacyToken + '\n')
const bootLegacy = await bootPlugin({ ...baseConfig, dshHome: homeLegacy })
const rLegacy = await call('127.0.0.1', bootLegacy.mainPort, 'GET', `${PREFIX}/api-keys/service`, { token: legacyToken })
check('C3 旧版 fixedPort 迁移为 port 且自动监听',
  rLegacy.body?.data?.running === true && rLegacy.body?.data?.port === legacyPort &&
  rLegacy.body?.data?.listeningPort === legacyPort, JSON.stringify(rLegacy.body?.data))

// C4 旧版 /api-keys/port 兼容：PUT fixedPort → 启动；PUT 0 → 停止
const compatPort = await freePort()
r = await call('127.0.0.1', bootLegacy.mainPort, 'PUT', `${PREFIX}/api-keys/port`,
  { token: legacyToken, body: { fixedPort: compatPort } })
check('C4 旧版 PUT /api-keys/port { fixedPort } → 启动',
  r.status === 200 && r.body?.data?.running === true && r.body?.data?.listeningPort === compatPort, JSON.stringify(r.body?.error))
r = await call('127.0.0.1', bootLegacy.mainPort, 'PUT', `${PREFIX}/api-keys/port`,
  { token: legacyToken, body: { bindIp: '0.0.0.0' } })
check('C4 旧版 PUT { bindIp } 同端口换绑', r.status === 200 && r.body?.data?.bindIp === '0.0.0.0' &&
  r.body?.data?.listeningPort === compatPort, JSON.stringify(r.body?.error))
r = await call('127.0.0.1', bootLegacy.mainPort, 'PUT', `${PREFIX}/api-keys/port`,
  { token: legacyToken, body: { fixedPort: 0 } })
check('C4 旧版 PUT { fixedPort: 0 } → 停止', r.status === 200 && r.body?.data?.running === false, JSON.stringify(r.body?.error))
r = await call('127.0.0.1', bootLegacy.mainPort, 'GET', `${PREFIX}/api-keys/port`, { token: legacyToken })
check('C4 旧版 GET /api-keys/port 返回同一状态', r.status === 200 && r.body?.data?.running === false && r.body?.data?.port === compatPort, JSON.stringify(r.body?.data?.port))
await bootLegacy.dispose()

// C5 首次安装 + 插件配置 standalonePort → 优先使用配置端口
const homeCfg = await mkdtemp(path.join(tmpdir(), 'dsh-svc-cfg-'))
const cfgPort = await freePort()
const bootCfg = await bootPlugin({ ...baseConfig, dshHome: homeCfg, standalonePort: cfgPort })
const cfgToken = await readAdminToken(homeCfg)
const rCfg = await call('127.0.0.1', bootCfg.mainPort, 'GET', `${PREFIX}/api-keys/service`, { token: cfgToken })
check('C5 首次安装时配置 standalonePort 作为初始端口',
  rCfg.body?.data?.running === true && rCfg.body?.data?.port === cfgPort, JSON.stringify(rCfg.body?.data?.port))
await bootCfg.dispose()

// C6 页面：文案与结构（不再关联 ONENAT / WorkBuddy，含新服务卡片）
// 页面是 HTML，call() 只解 JSON，这里直接用 fetch
const pageRes = await fetch(`http://127.0.0.1:${bootA3.mainPort}${PREFIX}/settings/api-keys?embed=1`)
const pageHtml = await pageRes.text()
check('C6 页面可访问（公开）', pageRes.status === 200, `status=${pageRes.status}`)
check('C6 页面含「2. API 服务」卡片与动态地址节点',
  pageHtml.includes('2. API 服务') && pageHtml.includes('id="svcUrl"') && pageHtml.includes('id="btnSvcPrimary"'), '')
check('C6 页面不再出现 ONENAT / WorkBuddy 关联文案',
  !/onenat|workbuddy/i.test(pageHtml), '')
check('C6 页面不再有已删除的长段落',
  !pageHtml.includes('桌面端主端口随 DSH 每次启动而变化') && !pageHtml.includes('清除固定端口'), '')
await bootA3.dispose()

// 清理临时目录
for (const home of [homeA, homeLegacy, homeCfg]) {
  await rm(home, { recursive: true, force: true }).catch(() => undefined)
}

const failed = results.filter((x) => !x.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log('  - ' + f.name)
  process.exit(1)
}
