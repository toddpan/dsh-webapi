#!/usr/bin/env node
/**
 * dsh-web-service - ask_user_question 答复桥回归测试
 *
 * 复现并回归以下问题：
 *   桥接监听器以 { global: true, prepend: true } 注册在 user-questions/request
 *   waterfall 最前；对「无法用 ALS 归属」的请求还会用 request.agent 反查
 *   sessionController.list() —— 这会把 **GUI/浏览器会话** 的提问也据为己有，
 *   且不调用 next()，导致宿主转发给浏览器的监听器永远轮不到：
 *   ask_user_question UI 不显示，工具永久挂起，直到用户点停止。
 *
 * 场景：
 *   A. GUI 会话提问（无 ALS，agent 属于已列出会话）→ 必须透传给浏览器转发器
 *   B. REST 会话提问（ALS 归属）→ 桥接接管，REST 答复端点 resolve
 *   C. 无 agent 且无 ALS 的请求 → 透传
 *
 * 用法：node scripts/test-user-questions-bridge.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import { registerUserQuestionBridge, askSessionStorage } from '../lib/user-questions.js'

const GUI_SESSION = 'gui-session-1'
const REST_SESSION = 'rest-session-2'

function makeRouterStub() {
  const routes = { get: new Map(), post: new Map() }
  return {
    routes,
    get(path, handler) { routes.get.set(path, handler) },
    post(path, handler) { routes.post.set(path, handler) },
  }
}

function makeRes() {
  return {
    headersSent: false,
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(data) { this.ended = true; if (data !== undefined) this.body += String(data) },
  }
}

async function setup() {
  const ctx = new Context()
  const fakeAgent = { id: GUI_SESSION }
  ctx.provide('userQuestions', { ctx }) // 桥接把监听器注册到该服务的 ctx（= 根 ctx）
  ctx.provide('agents', {
    get: (id) => (id === GUI_SESSION ? fakeAgent : undefined),
    roots: () => [fakeAgent],
  })
  ctx.provide('sessionController', {
    list: async () => ({ items: [{ sessionId: GUI_SESSION }] }),
  })
  const router = makeRouterStub()
  // 模拟宿主 connection 层的浏览器转发器：先注册（顺序在后），命中即返回 BROWSER 答复
  const relayCalls = []
  ctx.on('user-questions/request', async function (request, next) {
    relayCalls.push(request)
    return { answers: request.questions.map((q) => ({ id: q.id, selected: ['BROWSER'] })) }
  })
  registerUserQuestionBridge(ctx, router)
  return { ctx, router, relayCalls, fakeAgent }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(name, cond, detail = '') {
  console.log(` ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

// ---- 场景 A：GUI 会话提问（无 ALS，agent 可反查到已列出会话）----
{
  const { ctx, router, relayCalls, fakeAgent } = await setup()
  const request = {
    questions: [{ id: 'q1', question: '继续吗?', options: [{ label: '是' }, { label: '否' }] }],
    agent: fakeAgent,
  }
  const outcome = await Promise.race([
    ctx.waterfall('user-questions/request', request, async () => {
      throw new Error('NO_PROVIDER')
    }).then((v) => 'resolved:' + JSON.stringify(v), (e) => 'rejected:' + e.message),
    delay(400).then(() => 'PENDING'),
  ])
  check('A1 GUI 提问被转发给浏览器转发器', relayCalls.length === 1, `relayCalls=${relayCalls.length}`)
  check('A2 waterfall 及时返回（不挂起）', outcome !== 'PENDING', `outcome=${outcome}`)
  check('A3 答复来自浏览器而非桥接', typeof outcome === 'string' && outcome.includes('BROWSER'), outcome)
  const res = makeRes()
  await router.routes.get.get('/sessions/:id/questions')({}, res, { id: GUI_SESSION })
  check('A4 桥接未为 GUI 会话登记挂起批次', res.body.includes('"count":0'), res.body)
}

// ---- 场景 B：REST 会话提问（ALS 归属 → 桥接接管 + REST 答复）----
{
  const { ctx, router } = await setup()
  const request = {
    questions: [{ id: 'q2', question: '选一个?', options: [{ label: 'X' }, { label: 'Y' }] }],
  }
  const dispatchPromise = askSessionStorage.run({ sessionId: REST_SESSION }, () =>
    ctx.waterfall('user-questions/request', request, async () => { throw new Error('NO_PROVIDER') }))
  await delay(50)
  const listRes = makeRes()
  await router.routes.get.get('/sessions/:id/questions')({}, listRes, { id: REST_SESSION })
  check('B1 桥接为 REST 会话登记挂起批次', listRes.body.includes('"count":1'), listRes.body)
  const answerRes = makeRes()
  await router.routes.post.get('/sessions/:id/answers')({}, answerRes, { id: REST_SESSION }, {}, {
    answers: [{ id: 'q2', selected: ['Y'] }],
  })
  check('B2 REST 答复端点受理', answerRes.statusCode === 200, `status=${answerRes.statusCode} body=${answerRes.body}`)
  const outcome = await Promise.race([
    dispatchPromise.then((v) => 'resolved:' + JSON.stringify(v), (e) => 'rejected:' + e.message),
    delay(400).then(() => 'PENDING'),
  ])
  check('B3 waterfall 以 REST 答复 resolve', typeof outcome === 'string' && outcome.includes('"Y"'), outcome)
  const afterRes = makeRes()
  await router.routes.get.get('/sessions/:id/questions')({}, afterRes, { id: REST_SESSION })
  check('B4 答复后批次清理', afterRes.body.includes('"count":0'), afterRes.body)
}

// ---- 场景 C：无 agent 且无 ALS → 透传 ----
{
  const { ctx, relayCalls } = await setup()
  const outcome = await Promise.race([
    ctx.waterfall('user-questions/request', { questions: [{ id: 'q3', question: 'x?' }] }, async () => {
      throw new Error('NO_PROVIDER')
    }).then((v) => 'resolved:' + JSON.stringify(v), (e) => 'rejected:' + e.message),
    delay(400).then(() => 'PENDING'),
  ])
  check('C1 无归属请求透传给转发器', relayCalls.length === 1, `relayCalls=${relayCalls.length}`)
  check('C2 waterfall 及时返回', outcome !== 'PENDING', outcome)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
