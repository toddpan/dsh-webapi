import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const deny = code => { throw Object.assign(new Error(code), { code }) }
export async function windowsPath(target, directory = true) {
  if (!/^[a-z]:\\/i.test(target) || path.normalize(target) !== target || target.length > 239) deny('INVALID_CONFIG_PATH')
  let current = path.parse(target).root
  const parts = target.slice(current.length).split(path.sep).filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    if (/[\x00-\x1f:*?"<>|]/.test(parts[i]) || /[. ]$/.test(parts[i])) deny('INVALID_CONFIG_PATH')
    current = path.join(current, parts[i])
    const st = await fs.lstat(current)
    const actual = await fs.realpath(current)
    if (st.isSymbolicLink() || actual.toLowerCase() !== current.toLowerCase()) deny('UNTRUSTED_CONFIG_PATH')
    if (i < parts.length - 1 || directory) { if (!st.isDirectory()) deny('DIRECTORY_REQUIRED') }
    else if (!st.isFile() || st.nlink !== 1) deny('PRIVATE_CONFIG_REQUIRED')
  }
}
export async function protectWindowsDirectory(target) {
  await windowsPath(target)
  const { stdout } = await exec('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true })
  const sid = stdout.match(/S-1-5-21-[0-9-]+/)?.[0]
  if (!sid) deny('WINDOWS_IDENTITY_UNAVAILABLE')
  await exec('icacls.exe', [target, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { windowsHide: true })
}
export function windowsPythonCandidates(execPath = process.execPath, env = process.env, home = homedir()) {
  const executableDir = path.dirname(execPath)
  const dshHome = env.DSH_HOME || path.join(home, '.dsh')
  return [...new Set([
    env.DSH_PYTHON,
    path.resolve(executableDir, '../../python/python.exe'),
    path.join(dshHome, 'dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe'),
    path.join(executableDir, 'resources/runtime/primary-runtime/dependencies/python/python.exe'),
    path.join(executableDir, 'resources/runtime/dependencies/python/python.exe'),
  ].filter(Boolean))]
}
export async function windowsPython() {
  const candidates = windowsPythonCandidates()
  for (const candidate of candidates) {
    try {
      await exec(candidate, ['-I', '-c', 'import sys,ctypes,msvcrt;assert sys.version_info >= (3,8)'], { windowsHide: true, timeout: 5000 })
      return candidate
    } catch {}
  }
  deny('PYTHON_UNAVAILABLE')
}
