import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { WorkBuddyAccount } from '../lib/workbuddy-account.js'
import { NodeOnboarding } from '../lib/node-onboarding.js'
import { NODE_CONNECTION_SCRIPT } from '../lib/node-connection-page.js'

async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-connection-regression-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('saved password survives restart and temporary relogin failures, then heals expired session', async t => {
  const dir = await temp(t)
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let stage = 'login', loginCount = 0
  globalThis.fetch = async url => {
    if (String(url).endsWith('/api/auth/login')) {
      loginCount++
      if (stage === 'outage') return Response.json({ ok: false, error: 'server unavailable' }, { status: 503 })
      return Response.json({ ok: true, data: { username: 'fixture-user' } }, {
        headers: { 'set-cookie': 'wb_session=' + String(loginCount).repeat(64) + '; HttpOnly' },
      })
    }
    if (stage !== 'healthy') {
      if (stage === 'recover') {
        stage = 'healthy'
        return Response.json({ ok: false }, { status: 401 })
      }
      return Response.json({ ok: false }, { status: 401 })
    }
    return Response.json({ ok: true, data: { online: true } })
  }
  const crypto = { seal: value => 'sealed:' + Buffer.from(value).toString('base64'), open: value => Buffer.from(value.slice(7), 'base64').toString() }
  const account = new WorkBuddyAccount(dir, crypto)
  await account.login({ serverUrl: 'https://fixture.example', username: 'fixture-user', password: 'fixture-secret', rememberPassword: true })
  const restored = new WorkBuddyAccount(dir, crypto)
  assert.equal((await restored.status()).passwordSaved, true)
  assert.equal((await readFile(path.join(dir, 'workbuddy-account.json'), 'utf8')).includes('fixture-secret'), false)
  stage = 'outage'
  await assert.rejects(restored.call('status'), /server unavailable/)
  assert.equal((await restored.status()).passwordSaved, true, '503 must not erase saved credentials')
  stage = 'recover'
  assert.equal((await restored.call('status')).online, true)
  assert.equal(loginCount, 3)
})

test('Windows starts and restores transport while retaining the isolated-node platform gate', async t => {
  const dir = await temp(t)
  const calls = []
  const state = { configured: false, settings: { autoStart: true }, clientId: 'fixture-client' }
  const tunnel = {
    status: async () => state,
    startManaged: async () => { calls.push('start'); Object.assign(state, { configured: true, running: true, phase: 'online', origin: 'https://fixture.example' }) },
    updateRemoteState: async () => {},
    close: async () => {},
  }
  const account = {
    status: async () => ({ configured: true, passwordSaved: true, username: 'fixture-user', serverUrl: 'https://fixture.example' }),
    call: async endpoint => { calls.push(endpoint.split('?')[0]); return endpoint === 'provision' ? { config: 'fixture', client_id: 'fixture-client' } : { online: true } },
  }
  const runtime = {
    status: () => ({ platform: 'win32', errorCode: 'NODE_PLATFORM_UNSUPPORTED' }),
    prepare: async () => { throw new Error('runtime gate must not be bypassed') },
    createPairing: async () => { throw new Error('Windows must not mint node pairing') },
    close: async () => {},
  }
  const onboarding = new NodeOnboarding({ get: () => null }, {}, { dir }, {
    getLocalPort: () => 19388, getMainPort: () => 19387, startService: async () => ({ ok: true }),
  }, { tunnel, account, runtime })
  onboarding.managedKey = async () => 'fixture-key'
  t.after(() => onboarding.close())
  const result = await onboarding.loginAndBind()
  assert.equal(result.transportOnly, true)
  assert.deepEqual(calls, ['provision', 'start', 'status'])
  assert.equal((await onboarding.status()).node.errorCode, 'NODE_PLATFORM_UNSUPPORTED')
  calls.length = 0
  await onboarding.restore()
  assert.deepEqual(calls, ['provision', 'start', 'status'])
})

test('saved unbound account displays reuse controls and sends bind without a browser password', async () => {
  const nodes = new Map()
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', hidden: false, checked: false, required: true, textContent: '', style: {}, classList: { toggle() {} } })
    return nodes.get(id)
  }
  const account = { configured: true, passwordSaved: true, username: 'fixture-user', serverUrl: 'https://fixture.example' }
  const requests = []
  const context = {
    document: { getElementById: element },
    window: { addEventListener() {} },
    Date, Number, console,
    toast() {}, AUTHED: false,
  }
  vm.createContext(context)
  vm.runInContext(NODE_CONNECTION_SCRIPT.replace('    initNodeConnection();', ''), context)
  context.nodeApi = async (endpoint, body) => {
    requests.push({ endpoint, body })
    if (endpoint) return { transportOnly: true, message: 'transport ready' }
    return { account, node: { platform: 'win32' }, tunnel: { phase: 'stopped' } }
  }
  for (const name of ['renderNodeWorkspace', 'renderNodeOnenat', 'renderNodeInstallProgress', 'clearNodeTicket', 'nodeSetBusy']) context[name] = () => {}
  await context.loadNodeConnection()
  assert.equal(element('nodeAccountForm').hidden, true)
  assert.equal(element('nodeBoundActions').hidden, false)
  assert.equal(element('nodePasswordSaved').hidden, false)
  assert.equal(element('nodeRememberPassword').checked, true)
  assert.equal(element('nodeWorkBuddyPassword').required, false)
  await context.loginWorkBuddy({ preventDefault() {} })
  assert.equal(requests[1].endpoint, '/bind')
  assert.equal(requests[1].body.password, undefined)
  assert.equal(element('nodeConnectionStatus').textContent, 'transport ready')
  context.NODE_LAST_STATE.tunnel = { installed: true, running: true, phase: 'online' }
  context.updateNodeActions()
  assert.equal(element('nodeReconnectButton').hidden, true)
  assert.equal(element('nodeStopButton').hidden, false)
  assert.equal(element('nodeOnenatReinstall').disabled, true)
  assert.equal(element('nodeGenerateButton').disabled, true)
  context.NODE_LAST_STATE.tunnel = { installed: false, running: false, phase: 'error' }
  context.NODE_INSTALL_ACTIVE = true
  context.updateNodeActions()
  assert.equal(element('nodeOnenatDownload').disabled, true)
  assert.equal(element('nodeReconnectButton').textContent, '重试连接')
})
