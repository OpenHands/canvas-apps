"""Private sidecar lifecycle and fixed HTTP bridge (standard library only)."""
from __future__ import annotations

import base64
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sqlite3
import sys
import time
import urllib.error
import urllib.request

VERSION = '0.3.0'
_children: dict[int, subprocess.Popen] = {}
ROUTE = re.compile(r'^/api/(?:health|runtime|workspaces(?:/[A-Za-z0-9_-]+(?:/(?:board|tickets|reorder|automation(?:/(?:start|stop|trigger))?|manager-chat(?:/[A-Za-z0-9_-]+/messages)?))?)?|tickets/[A-Za-z0-9_-]+/(?:entries|verify|attachments)|attachments/[A-Za-z0-9_-]+|uploads(?:/[A-Za-z0-9_-]+(?:/finish)?)?|manager/(?:llm-profiles|conversations(?:/[A-Za-z0-9_-]+)?|workspaces/[A-Za-z0-9_-]+/snapshot|tickets/[A-Za-z0-9_-]+))$')


def root_path() -> Path:
    return Path(os.environ.get('VIBE_SIDECAR_ROOT', Path.home() / '.openhands/apps/kanban-manager')).resolve()


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value))
    temp.chmod(0o600)
    temp.replace(path)


@contextmanager
def locked(root: Path):
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / 'lifecycle.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def request(state: dict, path: str, method='GET', body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f'http://127.0.0.1:{int(state["port"])}{path}',
        data=data, method=method, headers={'Authorization': f'Bearer {state["token"]}',
        'Content-Type': 'application/json', **(headers or {})})
    try:
        response = urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        raw = response.read()
        ctype = response.headers.get('Content-Type', '')
        payload = json.loads(raw) if 'application/json' in ctype else {'base64': base64.b64encode(raw).decode(), 'content_type': ctype}
        return {'status': response.status, 'body': payload}


def healthy(root: Path):
    state = read_json(root / 'run.json')
    if state:
        try:
            if request(state, '/api/health')['status'] == 200:
                return state
        except (OSError, ValueError):
            pass
    return None


def probe(root: Path) -> dict:
    current = read_json(root / 'current.json', {})
    integration = read_json(root / 'integration.json', {})
    return {'version': VERSION, 'data_dir': str(root), 'installed': bool(current),
            'running': bool(healthy(root)), 'python': sys.version.split()[0],
            'sqlite': sqlite3.sqlite_version, 'install': read_json(root / 'install.json'),
            'legacy_present': (Path.home() / '.openhands/vibe-manager/index.json').is_file(),
            'integration': integration, 'agent_server': os.environ.get('AGENT_SERVER_URL', ''),
            'automation_api': os.environ.get('VIBE_AUTOMATION_API', '')}


def start(root: Path, *, source: Path | None = None, python: str | None = None):
    with locked(root):
        state = healthy(root)
        if state:
            return state
        current = read_json(root / 'current.json', {})
        source = source or Path(current['source'])
        python = python or str(root / 'venv/bin/python')
        env = {**os.environ, 'VIBE_SIDECAR_ROOT': str(root)}
        with (root / 'service.log').open('ab') as log:
            child = subprocess.Popen([python, '-m', 'sidecar.server'], cwd=source, env=env,
                stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        _children[child.pid] = child
        for _ in range(100):
            state = healthy(root)
            if state:
                return state
            if child.poll() is not None:
                break
            time.sleep(.1)
        raise RuntimeError(f'Backend did not start; inspect {root / "service.log"}')


def stop(root: Path):
    with locked(root):
        state = healthy(root)
        if state:
            request(state, '/internal/shutdown', 'POST')
            for _ in range(100):
                if not healthy(root):
                    child = _children.pop(state["pid"], None)
                    if child:
                        child.wait(timeout=10)
                    return
                time.sleep(.1)
            raise RuntimeError('Backend is still shutting down; retry shortly')


def rpc(root: Path, payload: dict):
    path = payload.get('path', '')
    plain = path.split('?', 1)[0]
    if not ROUTE.fullmatch(plain) or any(c in path for c in ('#', '\r', '\n', '\\')):
        raise ValueError('Unsupported Kanban API route')
    method = payload.get('method', 'GET')
    if method not in ('GET', 'POST', 'PATCH', 'DELETE'):
        raise ValueError('Unsupported HTTP method')
    state = healthy(root)
    if not state:
        raise RuntimeError('Kanban backend is stopped. Start it from Backend setup.')
    headers = {}
    if plain.startswith('/api/attachments/'):
        offset = int(payload.get('offset', 0))
        if offset < 0:
            raise ValueError('Invalid attachment offset')
        headers['Range'] = f'bytes={offset}-{offset + 32767}'
    return request(state, path, method, payload.get('body'), headers)


def install(root: Path, source: Path):
    try:
        stop(root)
        write_json(root / 'install.json', {'status': 'installing', 'version': VERSION})
        with (root / 'install.log').open('ab') as log:
            subprocess.run([sys.executable, '-m', 'venv', str(root / 'venv')], check=True, stdout=log, stderr=log)
            subprocess.run([str(root / 'venv/bin/python'), '-m', 'pip', '--isolated', 'install',
                '--index-url', 'https://pypi.org/simple', '-r', str(source / 'requirements.txt')],
                check=True, stdout=log, stderr=log)
        write_json(root / 'current.json', {'source': str(source), 'version': VERSION})
        start(root)
        write_json(root / 'install.json', {'status': 'ready', 'version': VERSION})
    except Exception as exc:
        write_json(root / 'install.json', {'status': 'error', 'error': str(exc), 'version': VERSION})
        raise


def main():
    root = root_path()
    if sys.argv[1] == 'install':
        install(root, Path(__file__).resolve().parents[1])
        return
    payload = json.loads(base64.b64decode(sys.argv[1], validate=True))
    action = payload.get('action')
    if action == 'probe':
        result = probe(root)
    elif action == 'start':
        start(root)
        result = probe(root)
    elif action == 'stop':
        stop(root)
        result = probe(root)
    elif action == 'rpc':
        result = rpc(root, payload)
    else:
        raise ValueError('Unsupported sidecar action')
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(1)
