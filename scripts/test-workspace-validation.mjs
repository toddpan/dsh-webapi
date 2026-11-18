import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { NodeOnboarding } from '../lib/node-onboarding.js'

// No WorkBuddy backend required: exercise real save serialization and root validation.
test('workspace saves reject unsafe ancestors before changing persisted configuration', {
  skip: !['darwin', 'linux'].includes(process.platform) || process.getuid?.() === 0,
}, async t => {
  const base = await mkdtemp(path.join(homedir(), '.dsh-workspace-validation-'))
  await chmod(base, 0o700)
  t.after(async () => {
    assert.equal(path.dirname(base), homedir())
    assert.ok(path.basename(base).startsWith('.dsh-workspace-validation-'))
    await rm(base, { recursive: true, force: true })
  })
  const safe = path.join(base, 'safe')
  const parent = path.join(base, 'shared')
  const unsafe = path.join(parent, 'workspace')
  await mkdir(safe, { mode: 0o700 })
  await mkdir(unsafe, { recursive: true, mode: 0o700 })
  await chmod(parent, 0o777)
  const keys = { dir: path.join(base, 'keys') }
  const node = new NodeOnboarding({ get: () => ({ list: () => [{ cwd: safe }] }) }, {}, keys, {}, {
    account: { status: async () => ({ configured: false }) },
    tunnel: { status: async () => ({ configured: false }), close: async () => {} },
  })
  t.after(() => node.close())
  await node.saveWorkspace({ mode: 'custom', roots: [safe] })
  const config = path.join(keys.dir, 'node-connection/workspace.json')
  const original = await readFile(config, 'utf8')
  await assert.rejects(node.saveWorkspace({ mode: 'custom', roots: [unsafe] }), error => {
    assert.equal(error.code, 'UNTRUSTED_CONFIG_PATH')
    assert.ok(error.message.includes(parent))
    assert.match(error.message, /0777/)
    return true
  })
  assert.equal(await readFile(config, 'utf8'), original)
  assert.deepEqual((await node.status()).workspace.effective, [safe])
  const linked = path.join(base, 'link')
  await symlink(safe, linked)
  await assert.rejects(node.saveWorkspace({ mode: 'custom', roots: [linked] }), { code: 'UNTRUSTED_CONFIG_PATH' })
  await assert.rejects(node.saveWorkspace({ mode: 'custom', roots: [keys.dir] }), { code: 'SENSITIVE_ROOT_OVERLAP' })
  await assert.rejects(node.saveWorkspace({ mode: 'custom', roots: [path.join(base, 'missing')] }), { code: 'INVALID_WORKSPACE_ROOT' })
  assert.equal(await readFile(config, 'utf8'), original)
  await chmod(parent, 0o755)
  const saved = await node.saveWorkspace({ mode: 'custom', roots: [unsafe] })
  assert.deepEqual(saved.effective, [unsafe])
  assert.equal(saved.applying, false)
  await node.saveWorkspace({ mode: 'default' })
  assert.deepEqual((await node.status()).workspace.effective, [safe])
})
