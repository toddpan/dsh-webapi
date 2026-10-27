/**
 * verify-stream-fix.mjs — dsh-web-service 流式断流修复的离线验证
 * 直接驱动编译产物 lib/（HttpRouter + registerStreamingRoutes），配伪 session 事件源。
 * 场景：
 *  1. prompt-stream 正常流：connected → delta/turn_end/done，且流内存活 >15s 收到 ': ping' 心跳
 *  2. prompt-stream 停滞看门狗：stallTimeoutMs 内零事件 → 'error'(turn stalled) + done + 关流
 *  3. 同步 /prompt 停滞语义：事件间隔 < 停滞阈值的长轮次必须完整跑完（旧 180s 总时长语义会半途截断）
 *  4. OpenAI 流式提交失败：头已发后必须收到 OpenAI 格式错误块 + [DONE]，不再挂死空流
 */
import http from 'node:http'
import assert from 'node:assert'

const log = (...a) => console.log('[verify]', ...a)

// —— 最小伪服务环境 ——
const listeners = []
const fakeCtx = {
  on(type, fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) } },
  get(key) {
    if (key === 'sessionController') return { resolveAgent: async (id) => ({ agent: id === 's-nofollow' ? {} : { followup() {}, steer() {} } }) }
    return undefined
  },
}
const emit = (session, event) => { for (const fn of listeners.slice()) fn(session, event) }

const { HttpRouter, initSseStream } = await import('../lib/router.js')
const { registerStreamingRoutes } = await import('../lib/streaming.js')

const router = new HttpRouter({ cors: false, apiKey: '' })
registerStreamingRoutes(fakeCtx, router)

const server = http.createServer((req, res) => { router.dispatch(req, res, '').catch(() => {}) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

function post(path, body) {
  const data = JSON.stringify(body)
  return fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: data })
}

async function readSse(res) {
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  const events = []
  const raw = []
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    // 按双换行切块；记录所有原始帧（含注释行心跳）
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      raw.push(frame)
      let ev = null
      let data = null
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) ev = line.slice(7)
        if (line.startsWith('data: ')) data = line.slice(6)
      }
      // 心跳注释帧（': ping'）也作为一类事件收集
      if (ev === null && data === null && frame.startsWith(':')) events.push({ comment: frame })
      else if (ev) events.push({ event: ev, data })
      else if (ev === null && data !== null) events.push({ event: 'data-only', data })
    }
  }
  res.body.cancel().catch(() => {})
  return { events, raw }
}

const session = { id: 's1' }

// —— 场景 1：正常流 + 心跳 ——
{
  const pending = post('/sessions/s1/prompt-stream', { prompt: 'hi' })
  // 等订阅建立后再发事件
  await new Promise((r) => setTimeout(r, 300))
  emit(session, { seq: 1, type: 'turn/start', data: { turn: 1 } })
  emit(session, { seq: 2, type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '你好，' } } })
  // 16.5s 沉默期：心跳必须在流内存活（旧版此处没有心跳，中间层会掐流）
  await new Promise((r) => setTimeout(r, 16500))
  emit(session, { seq: 3, type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '世界' } } })
  emit(session, { seq: 4, type: 'turn/end', data: { turn: 1, reason: 'completed' } })
  const res = await pending
  assert.equal(res.status, 200)
  const { events } = await readSse(res)
  const names = events.map((e) => e.event)
  log('场景1事件序:', names.join(','))
  assert.equal(names[0], 'connected')
  const deltas = events.filter((e) => e.event === 'delta').map((e) => JSON.parse(e.data).delta)
  assert.equal(deltas.join(''), '你好，世界')
  assert.ok(names.includes('turn_end'), '应有 turn_end')
  assert.ok(names.includes('done'), '应有 done')
  const pings = events.filter((e) => e.comment && e.comment.includes('ping')).length
  assert.ok(pings >= 1, '沉默期必须收到心跳注释帧')
  assert.ok(names.lastIndexOf('done') === names.length - 1 || events[events.length - 1].comment, '流应在 done 后正常收尾')
  log('场景1 PASS — 正常流完整送达 + 心跳帧数:', pings)
}

// —— 场景 2：停滞看门狗收流 ——
{
  const res = await post('/sessions/s1/prompt-stream', { prompt: 'hi', stallTimeoutMs: 600 })
  const { events } = await readSse(res)
  const names = events.map((e) => e.event)
  log('场景2事件序:', names.join(','))
  assert.ok(names.includes('connected'))
  assert.ok(names.includes('error'), '停滞必须显式报 error')
  const errEv = events.find((e) => e.event === 'error')
  assert.ok(JSON.parse(errEv.data).message.includes('turn stalled'), '错误信息应包含 turn stalled')
  assert.ok(names.includes('done'), 'error 后应补 done')
  assert.ok(!names.includes('delta') && !names.includes('turn_end'))
  log('场景2 PASS — 停滞看门狗显式收流')
}

// —— 场景 3：同步 /prompt 停滞语义（长轮次必须完整） ——
{
  const t0 = Date.now()
  const pending = post('/sessions/s1/prompt', { prompt: 'long turn', timeoutMs: 700 })
  // 首事件必须在停滞阈值内到达（+300 < 700）；此后事件间隔 500ms < 500ms? 不 —— 500ms < 700ms ✓
  await new Promise((r) => setTimeout(r, 300))
  emit(session, { seq: 101, type: 'assistant/delta', data: { delta: '第1段;' } })
  // 事件间隔 500ms < 700ms 停滞阈值；整轮持续 1.6s —— 旧「总时长超时」语义会在 700ms 半途截断
  // （此时只收到第 1 段），新语义必须完整等到 turn/end 并包含全部 3 个 chunk
  for (let i = 2; i <= 3; i++) {
    await new Promise((r) => setTimeout(r, 500))
    emit(session, { seq: 100 + i, type: 'assistant/delta', data: { delta: '第' + i + '段;' } })
  }
  await new Promise((r) => setTimeout(r, 300))
  emit(session, { seq: 200, type: 'turn/end', data: { turn: 2, reason: 'completed' } })
  const res = await pending
  const j = await res.json()
  const ms = Date.now() - t0
  log('场景3耗时:', ms, 'ms; content=', JSON.stringify(j.data?.content))
  assert.equal(j.ok, true)
  assert.equal(j.data.content, '第1段;第2段;第3段;', '必须包含全部 3 段 —— 不再被总时长截断')
  assert.ok(j.data.usage === undefined)
  log('场景3 PASS — 持续产出的长轮次完整送达（耗时', ms, 'ms > 700ms 也能活）')
}

// —— 场景 4：OpenAI 流式提交失败兜底 ——
{
  const res = await post('/chat/completions', { stream: true, model: 'x/y', sessionId: 's-nofollow', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 200)
  const text = await res.text()
  log('场景4响应:', text.replace(/\n/g, ' | ').slice(0, 200))
  assert.ok(text.includes('"error"'), '必须下发 OpenAI 格式错误块 —— 旧版会 500 失败后 no-op，空流挂死')
  assert.ok(text.includes('[DONE]'), '必须以 [DONE] 收流')
  log('场景4 PASS — 提交失败时不再挂死空流')
}

await server.close()
console.log('VERIFY-ALL-PASS')
