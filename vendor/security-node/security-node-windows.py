"""Windows read-only file broker. Pinned ancestors deny delete/rename sharing.

Reparse points, alternate streams, device/UNC paths and hardlinked files are
rejected. No host command execution, file mutation or snapshot fallback exists.
"""
import base64
import ctypes
from ctypes import wintypes as W
import hashlib
import json
import msvcrt
import ntpath
import os
import sys
import time

K = ctypes.WinDLL('kernel32', use_last_error=True)
K.CreateFileW.argtypes = [W.LPCWSTR, W.DWORD, W.DWORD, W.LPVOID, W.DWORD, W.DWORD, W.HANDLE]
K.CreateFileW.restype = W.HANDLE
K.CloseHandle.argtypes = [W.HANDLE]
K.GetFileInformationByHandle.argtypes = [W.HANDLE, W.LPVOID]
K.GetFinalPathNameByHandleW.argtypes = [W.HANDLE, W.LPWSTR, W.DWORD, W.DWORD]
def final_path(handle):
    buffer = ctypes.create_unicode_buffer(32768)
    count = K.GetFinalPathNameByHandleW(handle, buffer, len(buffer), 0)
    require(count and count < len(buffer), 'PATH_OPEN_DENIED')
    return buffer.value.removeprefix('\\\\?\\').casefold()
INVALID = ctypes.c_void_p(-1).value
DIRECTORY = 0x10
REPARSE = 0x400
MAX_FILE = 1048576
MAX_ENTRIES = 4096

class Info(ctypes.Structure):
    _fields_ = [('attrs', W.DWORD), ('creation', W.FILETIME), ('access', W.FILETIME),
                ('write', W.FILETIME), ('volume', W.DWORD), ('size_hi', W.DWORD),
                ('size_lo', W.DWORD), ('links', W.DWORD), ('index_hi', W.DWORD), ('index_lo', W.DWORD)]

class Denied(Exception):
    pass

def require(ok, code):
    if not ok:
        raise Denied(code)

def info(handle):
    result = Info()
    require(K.GetFileInformationByHandle(handle, ctypes.byref(result)), 'FILE_INFO_FAILED')
    require(not result.attrs & REPARSE, 'UNSAFE_FILE')
    return result

def canonical(value):
    require(isinstance(value, str) and len(value) < 240 and not value.startswith(('\\\\', '//'))
            and len(value) > 3 and value[1:3] == ':\\' and value[0].isalpha(), 'INVALID_ROOT')
    require(ntpath.normpath(value) == value and not any(ord(c) < 32 for c in value), 'INVALID_ROOT')
    return value

def relative(value):
    require(isinstance(value, str) and len(value) <= 2048, 'INVALID_PATH')
    if value == '.':
        return []
    parts = value.split('/')
    require(parts and all(p and p not in ('.', '..') and len(p) <= 255 and
        not any(c in p for c in '\\:*?"<>|') and not p.endswith((' ', '.')) and
        not any(ord(c) < 32 for c in p) and
        p.split('.')[0].upper() not in {'CON','PRN','AUX','NUL',*(f'COM{i}' for i in range(10)),*(f'LPT{i}' for i in range(10))}
        for p in parts), 'INVALID_PATH')
    return parts

def opened(value, directory=True):
    # FILE_SHARE_READ|WRITE, without DELETE: pinned ancestors cannot be renamed.
    handle = K.CreateFileW(value, 0x80000000 if not directory else 0x80, 3, None, 3,
                           0x02000000 | 0x00200000, None)
    require(handle != INVALID, 'PATH_OPEN_DENIED')
    try:
        st = info(handle)
        require(final_path(handle) == value.casefold(), 'WORKSPACE_CHANGED')
        require(bool(st.attrs & DIRECTORY) == directory, 'DIRECTORY_REQUIRED' if directory else 'REGULAR_FILE_REQUIRED')
        if not directory:
            require(st.links == 1, 'UNSAFE_FILE')
        return handle
    except BaseException:
        K.CloseHandle(handle)
        raise

class Root:
    def __init__(self, value):
        self.path = canonical(value)
        self.handles = []
        current = value[:3]
        try:
            self.handles.append(opened(current))
            for part in value[3:].split('\\'):
                relative(part)
                current = ntpath.join(current, part)
                self.handles.append(opened(current))
        except BaseException:
            self.close()
            raise
    def close(self):
        for handle in reversed(self.handles):
            K.CloseHandle(handle)
        self.handles = []
    def resolve(self, value, directory=True):
        parts = relative(value)
        current = self.path
        handles = []
        # POSIX rename semantics can bypass share-delete restrictions. Reopen the
        # registered path and compare its file ID before every operation.
        check = opened(self.path)
        try:
            expected, actual = info(self.handles[-1]), info(check)
            require((expected.volume, expected.index_hi, expected.index_lo) ==
                    (actual.volume, actual.index_hi, actual.index_lo), 'WORKSPACE_CHANGED')
        finally:
            K.CloseHandle(check)
        try:
            for index, part in enumerate(parts):
                current = ntpath.join(current, part)
                handles.append(opened(current, directory or index < len(parts)-1))
                require(info(handles[-1]).volume == info(self.handles[-1]).volume, 'CROSS_DEVICE_DENIED')
            return current, handles
        except BaseException:
            for handle in reversed(handles):
                K.CloseHandle(handle)
            raise

def listing(root, value):
    current, handles = root.resolve(value)
    try:
        entries = []
        with os.scandir(current) as scan:
            for entry in scan:
                require(len(entries) < MAX_ENTRIES, 'DIRECTORY_TOO_LARGE')
                # Never follow a junction, symlink or other reparse entry.
                st = entry.stat(follow_symlinks=False)
                require(not getattr(st, 'st_file_attributes', 0) & REPARSE, 'UNSAFE_FILE')
                require(entry.is_dir(follow_symlinks=False) or entry.is_file(follow_symlinks=False) and st.st_nlink == 1, 'UNSAFE_FILE')
                entries.append({'name': entry.name, 'type': 'directory' if entry.is_dir(follow_symlinks=False) else 'file',
                                'size': 0 if entry.is_dir(follow_symlinks=False) else st.st_size})
        return sorted(entries, key=lambda item: item['name'])
    finally:
        for handle in reversed(handles):
            K.CloseHandle(handle)

def guard(req, ws, action):
    claims = req['claims']
    value = req['payload']['path']
    relative(value)
    require(claims['workspaceId'] == ws['workspaceId'] and claims['nodeId'] == ws['nodeId']
            and claims['policyVersion'] == ws['policyVersion'], 'SCOPE_MISMATCH')
    require(action in claims['actions'], 'ACTION_DENIED')
    require(any(p == '.' or value == p or value.startswith(p + '/') for p in claims['paths']), 'PATH_DENIED')
    require(time.time()*1000 < min(claims['expiresAt'], req['leaseExpiresAt']), 'AUTH_EXPIRED')

def read(root, value):
    require(value != '.', 'FILE_REQUIRED')
    current, handles = root.resolve(value, False)
    try:
        handle = handles.pop()
        before = info(handle)
        require(before.size_hi == 0 and before.size_lo <= MAX_FILE, 'FILE_TOO_LARGE')
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        with os.fdopen(fd, 'rb') as stream:
            data = stream.read(MAX_FILE + 1)
            after = info(handle)
            require(len(data) <= MAX_FILE and (before.size_lo, before.write.dwLowDateTime, before.write.dwHighDateTime)
                    == (after.size_lo, after.write.dwLowDateTime, after.write.dwHighDateTime), 'FILE_CHANGED')
        return {'path': value, 'contentBase64': base64.b64encode(data).decode(), 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
    finally:
        for handle in reversed(handles):
            K.CloseHandle(handle)

def broker():
    roots = {}
    try:
        for line in sys.stdin:
            req = None
            try:
                require(len(line) <= 2000000, 'REQUEST_TOO_LARGE')
                req = json.loads(line)
                op = req['op']
                if op == 'init':
                    require(not roots, 'IMMUTABLE_REGISTRATION')
                    for ws in req['workspaces']:
                        require(ws['workspaceId'] not in roots, 'DUPLICATE_WORKSPACE')
                        roots[ws['workspaceId']] = (Root(ws['root']), ws)
                    result = {'ready': True, 'resolver': 'windows-pinned-readonly'}
                elif op == 'register-child':
                    parent, ws = roots[req['parentWorkspaceId']]
                    parts = relative(req['relative'])
                    target = ntpath.join(parent.path, *parts)
                    candidate = req['workspace']
                    require(candidate['root'] == target and candidate['nodeId'] == ws['nodeId']
                            and candidate['policyVersion'] == ws['policyVersion'], 'SCOPE_MISMATCH')
                    if candidate['workspaceId'] not in roots:
                        require(len(roots) < 4096, 'WORKSPACE_LIMIT')
                        roots[candidate['workspaceId']] = (Root(target), candidate)
                    result = {'path': target, 'entries': [{'name': entry['name'], 'path': ntpath.join(target, entry['name']), 'isDirectory': entry['type'] == 'directory'} for entry in listing(roots[candidate['workspaceId']][0], '.') if entry['type'] == 'directory']}
                else:
                    root, ws = roots[req['claims']['workspaceId']]
                    require(op in ('list','read'), 'WINDOWS_READ_ONLY')
                    guard(req, ws, 'file.' + op)
                    result = {'entries': listing(root, req['payload']['path'])} if op == 'list' else read(root, req['payload']['path'])
                    guard(req, ws, 'file.' + op)
                output = {'id': req['id'], 'ok': True, 'result': result}
            except Exception as error:
                output = {'id': req.get('id') if isinstance(req, dict) else None, 'ok': False,
                          'error': str(error) if isinstance(error, Denied) else 'PATH_OPEN_DENIED'}
            print(json.dumps(output), flush=True)
    finally:
        for root, ws in roots.values():
            root.close()

if __name__ == '__main__':
    broker()
