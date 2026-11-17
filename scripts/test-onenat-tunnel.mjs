#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { OnenatTunnel, onenatReleaseAsset, installOnenatClient, compareVersionTags } from '../lib/onenat-tunnel.js'

const bytes = Buffer.from('verified ONENAT fixture binary')
const asset = 'onenat-client_linux_amd64'
const digest = createHash('sha256').update(bytes).digest('hex')
const managed = { config: 'server_addr: "nat.example:4443"\nauthtoken: "ngk-installation-secret"\ninspect_addr: disabled\ntunnels: {}\n', clientId: 'installation-123456789', tunnelId: 'tunnel-a', mappingId: 'mapping-a', name: 'test node', protocol: 'https', subdomain: 'dsh-fixture' }
async function temp(t) { const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-onenat-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir }
function downloads({ corrupt = false, probeError = false, blocked = false, tag = 'r2026.11.06' } = {}) {
  const requests = []
  return {
    requests,
    fetch: async input => {
      const url = String(input); requests.push(url)
      if (blocked) throw new Error('network unavailable')
      if (url.endsWith('/releases/latest')) return Response.json({ tag_name: tag })
      if (url.endsWith('/checksums.txt')) return new Response(digest + '  ' + asset + '\n')
      if (url.endsWith('/' + asset)) return new Response(corrupt ? 'tampered' : bytes)
      if (url === 'https://dsh-fixture.nat.example/') {
        if (probeError) throw new Error('certificate verify failed')
        return new Response('authenticated endpoint', { status: 401 })
      }
      throw new Error('unexpected request ' + url)
    },
  }
}
function child() {
  const process = new EventEmitter()
  process.stdout = new PassThrough(); process.stderr = new PassThrough()
  process.exitCode = null; process.killed = false
  process.kill = signal => { process.killed = true; process.exitCode = 0; queueMicrotask(() => process.emit('exit', 0, signal)); return true }
  return process
}
function manager(dir, transport, launches = []) {
  return new OnenatTunnel({ dir, onLocalPort: () => 45678, platform: 'linux', arch: 'x64', fetch: transport.fetch,
    spawnClient: (binary, args) => { const process = child(); launches.push({ binary, args, process }); return process },
  })
}

test('official release names cover supported platforms and reject unsupported architectures', () => {
  assert.equal(onenatReleaseAsset('darwin', 'arm64'), 'onenat-client_darwin_arm64')
  assert.equal(onenatReleaseAsset('darwin', 'x64'), 'onenat-client_darwin_amd64')
  assert.equal(onenatReleaseAsset('linux', 'arm'), 'onenat-client_linux_arm')
  assert.equal(onenatReleaseAsset('win32', 'arm64'), 'onenat-client_windows_arm64.exe')
  assert.equal(onenatReleaseAsset('win32', 'x64'), 'onenat-client_windows_amd64.exe')
  assert.throws(() => onenatReleaseAsset('darwin', 'arm'), /不支持/)
  assert.throws(() => onenatReleaseAsset('linux', 'ia32'), /不支持/)
})

test('installer verifies release checksum, caches binary, and repairs a corrupted cache', async t => {
  const dir = await temp(t); const transport = downloads()
  const installed = await installOnenatClient({ dir, platform: 'linux', arch: 'x64', fetch: transport.fetch })
  assert.equal(installed.releaseTag, 'r2026.11.06')
  assert.deepEqual(await readFile(installed.binary), bytes)
  const count = transport.requests.length
  await installOnenatClient({ dir, platform: 'linux', arch: 'x64', fetch: transport.fetch })
  assert.equal(transport.requests.length, count)
  await writeFile(installed.binary, 'corrupt cache')
  await installOnenatClient({ dir, platform: 'linux', arch: 'x64', fetch: transport.fetch })
  assert.deepEqual(await readFile(installed.binary), bytes)
  if (process.platform !== 'win32') assert.equal((await stat(installed.binary)).mode & 0o777, 0o700)
})

test('checksum mismatch never installs or starts an unverified client', async t => {
  const dir = await temp(t); const transport = downloads({ corrupt: true }); const launches = []
  const tunnel = manager(dir, transport, launches); t.after(() => tunnel.close())
  const state = await tunnel.startManaged(managed)
  assert.equal(state.phase, 'error'); assert.match(state.error, /SHA256/)
  assert.equal(state.installed, false); assert.equal(launches.length, 0)
})

test('managed flow returns connecting immediately, verifies HTTPS, masks secrets and restores identity', async t => {
  const dir = await temp(t); const launches = []; const tunnel = manager(dir, downloads(), launches)
  t.after(() => tunnel.close())
  const firstId = (await tunnel.status()).clientId
  assert.ok(firstId.length >= 16)
  const started = await tunnel.startManaged(managed)
  assert.equal(started.phase, 'connecting'); assert.equal(started.running, true)
  assert.deepEqual(launches[0].args.slice(-1), ['managed'])
  assert.match(launches[0].args.join(' '), /-config=.*managed.yml/)
  assert.equal(started.origin, undefined)
  const online = await tunnel.updateRemoteState({ online: true, public_url: 'https://dsh-fixture.nat.example' })
  assert.equal(online.phase, 'online'); assert.equal(online.origin, 'https://dsh-fixture.nat.example')
  assert.equal(JSON.stringify(online).includes('ngk-installation-secret'), false)
  assert.equal(JSON.stringify(online).includes('authtoken'), false)
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(dir, 'private.json'))).mode & 0o777, 0o600)
    assert.equal((await stat(path.join(dir, 'managed.yml'))).mode & 0o777, 0o600)
  }
  const offline = await tunnel.updateRemoteState({ online: false, public_url: online.publicUrl })
  assert.equal(offline.origin, undefined); assert.equal(offline.phase, 'connecting')
  await tunnel.close()
  const restored = manager(dir, downloads({ blocked: true }), launches); t.after(() => restored.close())
  assert.equal((await restored.status()).clientId, managed.clientId)
  const restarted = await restored.start()
  assert.equal(restarted.phase, 'connecting'); assert.equal(restarted.running, true)
  assert.equal(restarted.mappingId, managed.mappingId); assert.equal(restarted.origin, undefined)
  assert.equal(launches.length, 2)
  assert.equal((await restored.stop()).running, false)
})

test('HTTPS failures and plaintext mappings cannot become pairing origins', async t => {
  const dir = await temp(t); const tunnel = manager(dir, downloads({ probeError: true })); t.after(() => tunnel.close())
  await tunnel.startManaged(managed)
  const invalid = await tunnel.updateRemoteState({ online: true, public_url: 'https://dsh-fixture.nat.example' })
  assert.equal(invalid.phase, 'error'); assert.equal(invalid.origin, undefined)
  const plaintext = await tunnel.updateRemoteState({ online: true, public_url: 'http://dsh-fixture.nat.example' })
  assert.equal(plaintext.origin, undefined); assert.equal(plaintext.phase, 'error')
  await tunnel.startManaged({ ...managed, protocol: 'tcp', remotePort: 34567 })
  const tcp = await tunnel.updateRemoteState({ online: true, public_url: 'tcp://nat.example:34567' })
  assert.equal(tcp.phase, 'online'); assert.equal(tcp.origin, undefined)
  assert.equal(tcp.publicUrl, 'tcp://nat.example:34567')
})

test('stopped process ignores stale server URLs and logs redact tunnel keys', async t => {
  const dir = await temp(t); const transport = downloads(); const launches = []; const logs = []
  const tunnel = new OnenatTunnel({ dir, onLocalPort: () => 45678, platform: 'linux', arch: 'x64', fetch: transport.fetch,
    log: message => logs.push(message), spawnClient: () => { const p = child(); launches.push(p); return p },
  }); t.after(() => tunnel.close())
  await tunnel.startManaged(managed)
  launches[0].stdout.write('auth failed ngk-installation-secret')
  assert.equal(logs.join('').includes('ngk-installation-secret'), false)
  await tunnel.stop()
  const stale = await tunnel.updateRemoteState({ online: true, public_url: 'https://dsh-fixture.nat.example' })
  assert.equal(stale.phase, 'stopped'); assert.equal(stale.origin, undefined)
})

test('version tags compare numerically and unparseable tags never look newer', () => {
  assert.equal(compareVersionTags('v1.2.3', 'v1.2.3'), 0)
  assert.equal(compareVersionTags('v1.2.4', 'v1.2.3'), 1)
  assert.equal(compareVersionTags('v1.10.0', 'v1.9.9'), 1)
  assert.equal(compareVersionTags('v1.2', 'v1.2.0'), 0)
  assert.equal(compareVersionTags('v1.2.3-rc.1', 'v1.2.3'), -1)
  assert.equal(compareVersionTags('r2026.11.17', 'r2026.11.16'), 1)
  assert.equal(compareVersionTags('r2026.11.16', 'r2026.11.16'), 0)
  assert.equal(compareVersionTags('r2026.11.15', 'r2026.11.16'), -1)
  assert.equal(compareVersionTags('r2026.10.01', 'r2026.11.16'), -1)
  assert.equal(compareVersionTags('release-notes', 'r2026.11.16'), -1)
  assert.equal(compareVersionTags('garbage', 'also-bad'), 0)
})

test('checkUpdate reports the installed release and detects a newer one', async t => {
  const dir = await temp(t); const transport = downloads({ tag: 'v1.2.0' })
  const tunnel = manager(dir, transport); t.after(() => tunnel.close())
  assert.deepEqual(await tunnel.checkUpdate(), { installed: false, current: '', latest: 'v1.2.0', updateAvailable: false })
  const started = await tunnel.startManaged(managed)
  assert.equal(started.releaseTag, 'v1.2.0')
  assert.deepEqual(await tunnel.checkUpdate(), { installed: true, current: 'v1.2.0', latest: 'v1.2.0', updateAvailable: false })
})

test('upgrade swaps in the newer release and keeps the old binary when verification fails', async t => {
  const dir = await temp(t)
  const newBytes = Buffer.concat([bytes, Buffer.from('-v2')])
  let tag = 'v1.0.0'; let corrupt = false
  const fetcher = async input => {
    const url = String(input)
    if (url.endsWith('/releases/latest')) return Response.json({ tag_name: tag })
    const match = /\/download\/([^/]+)\/(.+)$/.exec(url)
    if (match) {
      const payload = match[1] === 'v2.0.0' ? newBytes : bytes
      const good = createHash('sha256').update(payload).digest('hex')
      const line = corrupt && match[1] === tag ? createHash('sha256').update('other').digest('hex') : good
      if (match[2] === 'checksums.txt') return new Response(line + '  ' + asset + '\n')
      if (match[2] === asset) return new Response(payload)
    }
    if (url === 'https://dsh-fixture.nat.example/') return new Response('', { status: 401 })
    throw new Error('unexpected request ' + url)
  }
  const launches = []
  const tunnel = new OnenatTunnel({ dir, onLocalPort: () => 45678, platform: 'linux', arch: 'x64', fetch: fetcher,
    spawnClient: () => { const p = child(); launches.push(p); return p } })
  t.after(() => tunnel.close())
  await tunnel.startManaged(managed)
  assert.equal(launches.length, 1)
  const noop = await tunnel.upgrade({})
  assert.equal(noop.noop, true); assert.equal(noop.message.includes('已是最新'), true)
  assert.equal(launches.length, 1, 'noop upgrade must not restart the client')
  tag = 'v2.0.0'
  assert.deepEqual(await tunnel.checkUpdate(), { installed: true, current: 'v1.0.0', latest: 'v2.0.0', updateAvailable: true })
  const upgraded = await tunnel.upgrade({})
  assert.equal(upgraded.releaseTag, 'v2.0.0'); assert.equal(upgraded.running, true); assert.equal(upgraded.phase, 'connecting')
  assert.equal(launches.length, 2)
  assert.deepEqual(await readFile(path.join(dir, asset)), newBytes)
  tag = 'v3.0.0'; corrupt = true
  await assert.rejects(() => tunnel.upgrade({}), /SHA256/)
  assert.equal((await tunnel.status()).releaseTag, 'v2.0.0', 'failed upgrade must keep the verified binary')
  assert.deepEqual(await readFile(path.join(dir, asset)), newBytes)
  assert.equal(launches.length, 3, 'failed upgrade must restore the previous process')
})

test('installation reports streamed bytes and clears download metrics before verification', async t => {
  const dir = await temp(t); const progress = []; const transport = downloads()
  await installOnenatClient({ dir, platform: 'linux', arch: 'x64', fetch: async input => {
    if (String(input).endsWith('/' + asset)) return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
    return transport.fetch(input)
  }, onProgress: state => progress.push(state) })
  assert.deepEqual([...new Set(progress.map(p => p.phase))], ['resolving', 'checksums', 'downloading', 'verifying', 'installing', 'done'])
  assert.ok(progress.some(p => p.phase === 'downloading' && p.bytesDone === bytes.length && p.percent === 100))
  const verified = progress.find(p => p.phase === 'verifying')
  assert.equal(verified.percent, undefined)
  assert.equal(verified.bytesDone, undefined)
  assert.ok(progress.every(p => p.startedAt === progress[0].startedAt))
})

test('status remains readable during a blocked download and unknown totals stay unknown', async t => {
  const dir = await temp(t); const transport = downloads(); let release; let reached
  const requested = new Promise(resolve => { reached = resolve })
  const pending = new Promise(resolve => { release = resolve })
  const tunnel = manager(dir, { fetch: async input => {
    if (String(input).endsWith('/' + asset)) {
      reached()
      await pending
      return new Response(bytes)
    }
    return transport.fetch(input)
  } })
  t.after(() => tunnel.close())
  const start = tunnel.startManaged(managed)
  await requested
  const state = await tunnel.status()
  assert.equal(state.phase, 'installing')
  assert.equal(state.installProgress.phase, 'downloading')
  assert.equal(state.installProgress.percent, undefined)
  assert.equal(state.installProgress.bytesTotal, undefined)
  release()
  assert.equal((await start).installProgress.phase, 'done')
})

test('interrupted release download resumes on a mirror and verifies the complete payload', async t => {
  const dir = await temp(t); const transport = downloads(); let interrupted = false; let resumed = false
  const installed = await installOnenatClient({ dir, platform: 'linux', arch: 'x64', fetch: async (input, init) => {
    const url = String(input)
    if (!url.endsWith('/' + asset)) return transport.fetch(input)
    if (url.startsWith('https://github.com/') && !interrupted) {
      interrupted = true
      let sent = false
      return new Response(new ReadableStream({ pull(controller) {
        if (!sent) { sent = true; controller.enqueue(bytes.subarray(0, 8)) }
        else controller.error(new Error('connection reset'))
      } }), { headers: { 'content-length': String(bytes.length) } })
    }
    assert.ok(url.startsWith('https://ghfast.top/'))
    assert.equal(init.headers.Range, 'bytes=8-')
    resumed = true
    return new Response(bytes.subarray(8), { status: 206, headers: {
      'content-range': `bytes 8-${bytes.length - 1}/${bytes.length}`, 'content-length': String(bytes.length - 8),
    } })
  } })
  assert.equal(resumed, true)
  assert.deepEqual(await readFile(installed.binary), bytes)
})

test('log tail keeps recent sanitized lines for the settings UI', async t => {
  const dir = await temp(t); const launches = []
  const tunnel = manager(dir, downloads(), launches); t.after(() => tunnel.close())
  await tunnel.startManaged(managed)
  launches[0].process.stdout.write('first line\nauthtoken = ngk-installation-secret\nlast line')
  assert.deepEqual(tunnel.tailLogs(), ['first line', 'authtoken=[redacted]', 'last line'])
})
