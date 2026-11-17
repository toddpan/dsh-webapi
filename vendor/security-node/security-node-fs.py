#!/usr/bin/env python3
"""Private stdio file broker / Linux execution supervisor, not a network API.

Only security-node-service.mjs supplies this process's trusted input. Run the node
under a dedicated unprivileged Unix account. Workspace/config/runtime ancestors
must not be writable by other accounts. No hostile host process may share that
account. User execution receives copied read-only scoped inputs, never host root
or live workspace mounts. Kernel/host administrator compromise is out of scope.

Linux file resolution requires openat2(BENEATH|NO_SYMLINKS|NO_XDEV). All traversed
private directories are pinned, roots held for the broker lifetime. No realpath-
then-open fallback. macOS file-only mode uses pinned no-follow descriptor walks
under private ancestors; it never enables execution or claims Linux isolation.
"""
import base64
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import platform
import resource
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

MAX_FILE = 1024 * 1024
MAX_ENTRIES = 4096
MAX_SNAPSHOT = 16 * 1024 * 1024
O_PATH = getattr(os, 'O_PATH', os.O_RDONLY)
NOFOLLOW = os.O_NOFOLLOW
DIRECTORY = os.O_DIRECTORY
CLOEXEC = os.O_CLOEXEC
PORTABLE = '--test-portable-fs' in sys.argv
DARWIN_FILES = '--darwin-files' in sys.argv and sys.platform == 'darwin'


class Denied(Exception):
    pass


def require(ok, code):
    if not ok:
        raise Denied(code)


def relpath(path):
    require(isinstance(path, str) and len(path) <= 2048, 'INVALID_PATH')
    if path == '.':
        return path
    require(path and not path.startswith('/') and '\\' not in path
            and all(ord(c) >= 32 and ord(c) != 127 for c in path)
            and all(p not in ('', '.', '..') and len(p.encode()) <= 255 for p in path.split('/')), 'INVALID_PATH')
    return path


def private_dir(st):
    require(stat.S_ISDIR(st.st_mode) and st.st_uid in (0, os.getuid()) and not st.st_mode & 0o022, 'UNTRUSTED_DIRECTORY')


def open_beneath(fd, path, flags):
    if PORTABLE or DARWIN_FILES:
        # Every ancestor is private; untrusted executions never share the service uid.
        cur = os.dup(fd)
        try:
            device = os.fstat(fd).st_dev
            parts = relpath(path).split('/')
            for part in parts[:-1]:
                nxt = os.open(part, os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC, dir_fd=cur)
                try:
                    private_dir(os.fstat(nxt))
                    require(os.fstat(nxt).st_dev == device, 'CROSS_DEVICE_DENIED')
                except BaseException:
                    os.close(nxt)
                    raise
                os.close(cur)
                cur = nxt
            result = os.open(parts[-1], flags | NOFOLLOW | CLOEXEC, dir_fd=cur)
            if os.fstat(result).st_dev != device:
                os.close(result)
                raise Denied('CROSS_DEVICE_DENIED')
            return result
        finally:
            os.close(cur)
    require(sys.platform == 'linux' and platform.machine() in ('x86_64', 'aarch64'), 'OPENAT2_UNAVAILABLE')
    class How(ctypes.Structure):
        _fields_ = [('flags', ctypes.c_uint64), ('mode', ctypes.c_uint64), ('resolve', ctypes.c_uint64)]
    how = How(flags | NOFOLLOW | CLOEXEC, 0, 0x01 | 0x04 | 0x08)  # NO_XDEV | NO_SYMLINKS | BENEATH
    libc = ctypes.CDLL(None, use_errno=True)
    result = libc.syscall(ctypes.c_long(437), ctypes.c_int(fd), ctypes.c_char_p(path.encode()), ctypes.byref(how), ctypes.sizeof(how))
    if result < 0:
        err = ctypes.get_errno()
        if err in (errno.ENOSYS, errno.EINVAL):
            raise Denied('OPENAT2_UNAVAILABLE')
        raise OSError(err, os.strerror(err))
    return result


def register_root(path):
    require(isinstance(path, str) and path.startswith('/') and os.path.normpath(path) == path and path != '/', 'INVALID_ROOT')
    fd = os.open('/', os.O_RDONLY | DIRECTORY | CLOEXEC)
    try:
        for part in path.strip('/').split('/'):
            nxt = os.open(part, os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = nxt
            private_dir(os.fstat(fd))
        require(os.fstat(fd).st_uid == os.getuid(), 'ROOT_OWNER_REQUIRED')
        probe = open_beneath(fd, '.', os.O_RDONLY | DIRECTORY)
        os.close(probe)
        return fd
    except BaseException:
        os.close(fd)
        raise


def check_file(st, device, enforce_size=True):
    require(stat.S_ISREG(st.st_mode) and st.st_dev == device and st.st_nlink == 1, 'UNSAFE_FILE')
    require(st.st_uid == os.getuid() and not st.st_mode & 0o022, 'UNTRUSTED_FILE')
    require(not enforce_size or st.st_size <= MAX_FILE, 'FILE_TOO_LARGE')


def read_file(root, path):
    fd = open_beneath(root, path, os.O_RDONLY | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        check_file(before, os.fstat(root).st_dev)
        chunks = []
        total = 0
        while True:
            chunk = os.read(fd, min(65536, MAX_FILE + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            require(total <= MAX_FILE, 'FILE_TOO_LARGE')
        after = os.fstat(fd)
        check_file(after, os.fstat(root).st_dev)
        require((before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'FILE_CHANGED')
        return b''.join(chunks), after
    finally:
        os.close(fd)


def scope_check(req, workspace, action, path):
    c = req['claims']
    require(c['workspaceId'] == workspace['workspaceId'] and c['nodeId'] == workspace['nodeId']
            and c['policyVersion'] == workspace['policyVersion'], 'SCOPE_MISMATCH')
    require(action in c['actions'], 'ACTION_DENIED')
    relpath(path)
    require(any(p == '.' or path == p or path.startswith(p + '/') for p in c['paths']), 'PATH_DENIED')
    guard(req)


def guard(req):
    require(time.time() * 1000 < min(req['claims']['expiresAt'], req['leaseExpiresAt']), 'AUTH_EXPIRED')
    require(time.monotonic() < req['_deadline'], 'AUTH_EXPIRED')


def parent_fd(root, path):
    relpath(path)
    require(path != '.', 'FILE_REQUIRED')
    parent, _, name = path.rpartition('/')
    fd = open_beneath(root, parent or '.', os.O_RDONLY | DIRECTORY)
    private_dir(os.fstat(fd))
    return fd, name


def write_file(root, req, workspace):
    path = req['payload']['path']
    scope_check(req, workspace, 'file.write', path)
    expected = req['payload'].get('expectedSha256', 'MISSING')
    require(expected is None or isinstance(expected, str) and len(expected) == 64
            and all(c in '0123456789abcdef' for c in expected), 'CAS_REQUIRED')
    content = req['payload']['contentBase64']
    require(isinstance(content, str) and len(content) <= (MAX_FILE + 2) // 3 * 4, 'FILE_TOO_LARGE')
    try:
        data = base64.b64decode(content, validate=True)
    except Exception:
        raise Denied('INVALID_CONTENT')
    require(len(data) <= MAX_FILE, 'FILE_TOO_LARGE')
    parent, name = parent_fd(root, path)
    tmp = '.node-write-' + secrets.token_hex(24)
    created = False
    try:
        # Broker serializes all operations; directory flock also serializes cooperating
        # broker instances. The dedicated account is the only live workspace writer.
        fcntl.flock(parent, fcntl.LOCK_EX)
        try:
            current, before = read_file(root, path)
        except FileNotFoundError:
            current, before = None, None
        require((expected is None and current is None) or
                (expected is not None and current is not None and hashlib.sha256(current).hexdigest() == expected), 'CAS_MISMATCH')
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW | CLOEXEC, 0o600, dir_fd=parent)
        created = True
        try:
            view = memoryview(data)
            while view:
                guard(req)
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
        scope_check(req, workspace, 'file.write', path)
        # Ensure the pinned parent still resolves inside this registered root.
        again, _ = parent_fd(root, path)
        try:
            require((os.fstat(again).st_dev, os.fstat(again).st_ino)
                    == (os.fstat(parent).st_dev, os.fstat(parent).st_ino), 'PARENT_CHANGED')
        finally:
            os.close(again)
        try:
            latest = os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            latest = None
        require((before is None and latest is None) or (before is not None and latest is not None
                and (before.st_dev, before.st_ino, before.st_ctime_ns, before.st_nlink)
                == (latest.st_dev, latest.st_ino, latest.st_ctime_ns, latest.st_nlink)), 'CAS_MISMATCH')
        if expected is None:
            # link+unlink implements atomic create-if-absent; rename would overwrite.
            os.link(tmp, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            os.unlink(tmp, dir_fd=parent)
        else:
            os.replace(tmp, name, src_dir_fd=parent, dst_dir_fd=parent)
        created = False
        os.fsync(parent)
        return {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
    finally:
        if created:
            os.unlink(tmp, dir_fd=parent)
        os.close(parent)


def directory_entries(root, path):
    fd = open_beneath(root, path, os.O_RDONLY | DIRECTORY)
    try:
        private_dir(os.fstat(fd))
        result = []
        with os.scandir(fd) as entries:
            for entry in entries:
                require(len(result) < MAX_ENTRIES, 'DIRECTORY_TOO_LARGE')
                st = entry.stat(follow_symlinks=False)
                require(not stat.S_ISLNK(st.st_mode) and st.st_dev == os.fstat(root).st_dev, 'UNSAFE_FILE')
                if stat.S_ISDIR(st.st_mode):
                    private_dir(st)
                    kind = 'directory'
                else:
                    # Metadata listing does not read content; a large APK must not
                    # prevent catalog validation or hide other project files.
                    check_file(st, os.fstat(root).st_dev, enforce_size=False)
                    kind = 'file'
                result.append({'name': entry.name, 'type': kind, 'size': st.st_size if kind == 'file' else 0})
        return sorted(result, key=lambda e: e['name'])
    finally:
        os.close(fd)


def snapshot(root, req, workspace, destination):
    total = [0, 0]
    def copy(path):
        scope_check(req, workspace, 'file.read', path)
        fd = open_beneath(root, path, os.O_RDONLY | os.O_NONBLOCK)
        try:
            st = os.fstat(fd)
        finally:
            os.close(fd)
        dest = destination if path == '.' else os.path.join(destination, path)
        if stat.S_ISDIR(st.st_mode):
            private_dir(st)
            os.makedirs(dest, mode=0o700, exist_ok=True)
            for entry in directory_entries(root, path):
                copy(entry['name'] if path == '.' else path + '/' + entry['name'])
        else:
            data, _ = read_file(root, path)
            total[0] += len(data)
            total[1] += 1
            require(total[0] <= MAX_SNAPSHOT and total[1] <= MAX_ENTRIES, 'SNAPSHOT_TOO_LARGE')
            os.makedirs(os.path.dirname(dest), mode=0o700, exist_ok=True)
            with open(dest, 'xb') as target:
                target.write(data)
            os.chmod(dest, 0o500 if st.st_mode & 0o111 else 0o400)
    # Remove overlapping prefixes; no direct live-workspace mount is ever used.
    paths = sorted(req['claims']['paths'], key=lambda x: (len(x), x))
    selected = []
    for path in paths:
        if not any(p == '.' or path == p or path.startswith(p + '/') for p in selected):
            selected.append(path)
            copy(path)
    guard(req)
    return {'files': total[1], 'bytes': total[0]}


def broker():
    roots = {}
    for line in sys.stdin:
        req = None
        try:
            require(len(line) <= 2_000_000, 'REQUEST_TOO_LARGE')
            req = json.loads(line)
            if req['op'] == 'init':
                require(not roots, 'IMMUTABLE_REGISTRATION')
                for workspace in req['workspaces']:
                    require(workspace['workspaceId'] not in roots, 'DUPLICATE_WORKSPACE')
                    roots[workspace['workspaceId']] = (register_root(workspace['root']), workspace)
                result = {'ready': True, 'resolver': 'portable-test-only' if PORTABLE else 'darwin-private-descriptors' if DARWIN_FILES else 'linux-openat2'}
            elif req['op'] == 'register-child':
                parent, parent_ws = roots[req['parentWorkspaceId']]
                relative = relpath(req['relative'])
                candidate = req['workspace']
                require(candidate['nodeId'] == parent_ws['nodeId']
                        and candidate['policyVersion'] == parent_ws['policyVersion'], 'SCOPE_MISMATCH')
                canonical = os.path.normpath(os.path.join(parent_ws['root'], relative))
                require(candidate['root'] == canonical, 'ROOT_MISMATCH')
                pinned = open_beneath(parent, relative, os.O_RDONLY | DIRECTORY)
                try:
                    private_dir(os.fstat(pinned))
                    require(os.fstat(pinned).st_uid == os.getuid(), 'ROOT_OWNER_REQUIRED')
                    old = roots.get(candidate['workspaceId'])
                    if old:
                        require(old[1] == candidate and os.fstat(old[0]).st_ino == os.fstat(pinned).st_ino
                                and os.fstat(old[0]).st_dev == os.fstat(pinned).st_dev, 'WORKSPACE_CHANGED')
                    else:
                        require(len(roots) < 4096, 'WORKSPACE_LIMIT')
                        roots[candidate['workspaceId']] = (os.dup(pinned), candidate)
                    result = {'path': canonical, 'entries': directory_entries(pinned, '.')}
                finally:
                    os.close(pinned)
            else:
                root, workspace = roots[req['claims']['workspaceId']]
                req['_deadline'] = time.monotonic() + max(0, min(req['claims']['expiresAt'], req['leaseExpiresAt']) / 1000 - time.time())
                op = req['op']
                payload = req.get('payload', {})
                if op == 'read':
                    scope_check(req, workspace, 'file.read', payload['path'])
                    data, _ = read_file(root, payload['path'])
                    scope_check(req, workspace, 'file.read', payload['path'])
                    result = {'path': payload['path'], 'contentBase64': base64.b64encode(data).decode(),
                              'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
                elif op == 'list':
                    scope_check(req, workspace, 'file.list', payload['path'])
                    result = {'entries': directory_entries(root, payload['path'])}
                    scope_check(req, workspace, 'file.list', payload['path'])
                elif op == 'write':
                    result = write_file(root, req, workspace)
                elif op == 'snapshot':
                    require('execution.start' in req['claims']['actions'], 'ACTION_DENIED')
                    result = snapshot(root, req, workspace, req['destination'])
                else:
                    raise Denied('UNKNOWN_OPERATION')
            print(json.dumps({'id': req['id'], 'ok': True, 'result': result}), flush=True)
        except Exception as exc:
            code = str(exc) if isinstance(exc, Denied) else 'FS_REJECTED'
            print(json.dumps({'id': req.get('id') if isinstance(req, dict) else None, 'ok': False, 'error': code}), flush=True)
    for fd, _ in roots.values():
        os.close(fd)


def bwrap_args(runtime, workspace):
    # runtime is an administrator-built, secret-free rootfs (e.g. static busybox).
    # A tmpfs root with an explicit allowlist avoids binding / or host /usr,/etc.
    return ['bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
            '--clearenv', '--setenv', 'PATH', '/bin', '--setenv', 'HOME', '/tmp', '--setenv', 'LANG', 'C',
            '--ro-bind', runtime, '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
            '--ro-bind', workspace, '/workspace', '--chdir', '/workspace', '--uid', '65534', '--gid', '65534']


def limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    resource.setrlimit(resource.RLIMIT_AS, (8 * 1024 * 1024 * 1024, 8 * 1024 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024, 16 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (60, 60))


def project_command(argv):
    # All variable values are positional arguments, including executable paths.
    scratch = 'set -eu; /bin/cp -R "$1" "$2"; /bin/chmod -R u+rwX "$2"; cd "$2"; shift 2; exec "$@"'
    return ['/bin/sh', '-c', scratch, 'project-build', '/workspace', '/tmp/project'] + argv


def supervise(spec):
    require(sys.platform == 'linux', 'LINUX_ISOLATION_REQUIRED')
    # Adopt and reap namespace monitor descendants instead of relying on a host PID 1 reaper.
    libc = ctypes.CDLL(None)
    require(libc.prctl(36, 1, 0, 0, 0) == 0, 'SUBREAPER_UNAVAILABLE')  # PR_SET_CHILD_SUBREAPER
    parent_dead = [False]
    signal.signal(signal.SIGTERM, lambda *_: parent_dead.__setitem__(0, True))
    parent = os.getppid()
    require(libc.prctl(1, signal.SIGTERM, 0, 0, 0) == 0 and os.getppid() == parent and parent != 1
            and not parent_dead[0], 'PARENT_DEATH_UNAVAILABLE')
    # Interpreter startup and scheduling occur after the service's admission check.
    # Revalidate here too: an already expired lease must never start a command.
    expiry = spec.get('expiresAt')
    require(isinstance(expiry, int) and not isinstance(expiry, bool), 'BAD_LEASE')
    wall_now = time.time() * 1000
    require(expiry > wall_now, 'LEASE_EXPIRED')
    require(expiry - wall_now <= 15000 and not parent_dead[0], 'BAD_LEASE')
    deadline = time.monotonic() + (expiry - wall_now) / 1000
    # Build outputs/cache belong to a disposable tmpfs copy inside the namespace.
    # The mounted input snapshot and actual repository remain read-only. argv is
    # passed positionally: no user value is interpolated into the shell program.
    child = subprocess.Popen(bwrap_args(spec['runtime'], spec['snapshot'])
                             + ['--'] + project_command(spec['argv']),
                             env={'PATH': '/usr/bin:/bin'}, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, preexec_fn=limits)
    import selectors
    selector = selectors.DefaultSelector()
    selector.register(sys.stdin, selectors.EVENT_READ, 'control')
    selector.register(child.stdout, selectors.EVENT_READ, 'stdout')
    selector.register(child.stderr, selectors.EVENT_READ, 'stderr')
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    reason = None
    while True:
        now = time.monotonic()
        if parent_dead[0]:
            reason = reason or 'CONTROL_CLOSED'
        if now >= deadline:
            reason = reason or 'LEASE_EXPIRED'
        if reason:
            # Kill bwrap, its namespace init, and process group. Kernel PID namespace
            # teardown kills descendants even after setsid()/double fork.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=3)
            break
        if child.poll() is not None and not any(k.data != 'control' for k in selector.get_map().values()):
            break
        for key, _ in selector.select(min(0.05, max(0, deadline - now))):
            if key.data == 'control':
                line = sys.stdin.readline()
                if not line:
                    reason = 'CONTROL_CLOSED'
                else:
                    try:
                        command = json.loads(line)
                        if command.get('stop'):
                            reason = 'REVOKED'
                        elif 'expiresAt' in command:
                            expiry = command['expiresAt']
                            require(isinstance(expiry, int) and time.time() * 1000 < expiry <= time.time() * 1000 + 15000, 'BAD_RENEWAL')
                            # Never resurrect an already expired lease.
                            if time.monotonic() >= deadline:
                                reason = 'LEASE_EXPIRED'
                            else:
                                deadline = time.monotonic() + (expiry / 1000 - time.time())
                    except Exception:
                        reason = 'CONTROL_REJECTED'
            else:
                data = os.read(key.fileobj.fileno(), 8192)
                if not data:
                    selector.unregister(key.fileobj)
                else:
                    output[key.data].extend(data)
                    if sum(len(v) for v in output.values()) > 65536:
                        reason = 'OUTPUT_LIMIT'
    reap_deadline = time.monotonic() + 3
    while True:
        try:
            reaped, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if not reaped:
            require(time.monotonic() < reap_deadline, 'PROCESS_REAP_TIMEOUT')
            time.sleep(0.01)
    print(json.dumps({'exitCode': child.returncode, 'reason': reason,
                      'stdout': bytes(output['stdout'][:65536]).decode('utf8', 'replace'),
                      'stderr': bytes(output['stderr'][:65536]).decode('utf8', 'replace')}), flush=True)


def probe(runtime):
    require(sys.platform == 'linux' and os.geteuid() != 0 and shutil.which('bwrap'), 'LINUX_UNPRIVILEGED_BWRAP_REQUIRED')
    # The same rootfs and bwrap options as executions; missing utilities fail closed.
    with tempfile.TemporaryDirectory(prefix='node-probe-') as work:
        os.chmod(work, 0o755)
        marker = 'node-probe-' + secrets.token_hex(16)
        with tempfile.TemporaryDirectory(prefix=marker) as outside:
            command = '''set -eu
[ "$(id -u)" = 65534 ]
[ ! -e /host ] && [ ! -e /Users ] && [ ! -e /root ]
[ ! -e /etc/shadow ]
[ ! -e /proc/1/root%s ]
! touch /workspace/forbidden 2>/dev/null
/bin/cp -R /workspace /tmp/project
/bin/chmod -R u+rwX /tmp/project
touch /tmp/project/build-output
[ -z "$(ls -A /sys/class/net 2>/dev/null)" ]
[ -z "$(awk 'NR>2 && $1 != "lo:" {print}' /proc/net/dev)" ]
[ "$(readlink /proc/self/ns/mnt)" != "%s" ]
[ "$(readlink /proc/self/ns/pid)" != "%s" ]
[ "$(readlink /proc/self/ns/net)" != "%s" ]
[ "$(awk '/CapEff/ {print $2}' /proc/self/status)" = 0000000000000000 ]
printf isolation-ok
''' % (outside, os.readlink('/proc/self/ns/mnt'), os.readlink('/proc/self/ns/pid'), os.readlink('/proc/self/ns/net'))
            result = subprocess.run(bwrap_args(runtime, work) + ['--', '/bin/sh', '-c', command],
                                    env={'PATH': '/usr/bin:/bin'}, stdin=subprocess.DEVNULL, capture_output=True, timeout=8, preexec_fn=limits)
            require(result.returncode == 0 and result.stdout == b'isolation-ok', 'ISOLATION_PROBE_FAILED')
    return {'checkedAt': int(time.time() * 1000), 'digest': hashlib.sha256(result.stdout + command.encode()).hexdigest(),
            'checks': ['separate-mount-namespace', 'separate-pid-namespace', 'separate-network-namespace',
                       'no-network-interfaces', 'uid-65534', 'no-capabilities', 'no-host-root', 'read-only-workspace']}


if __name__ == '__main__':
    try:
        if '--probe' in sys.argv:
            print(json.dumps(probe(sys.argv[sys.argv.index('--probe') + 1])), flush=True)
        elif '--supervise' in sys.argv:
            supervise(json.loads(sys.stdin.readline()))
        else:
            broker()
    except Exception as exc:
        print(json.dumps({'error': str(exc) if isinstance(exc, Denied) else 'ISOLATION_FAILED'}), flush=True)
        sys.exit(1)
