"""Authenticated loopback entrypoint for the Kanban FastAPI application."""
from __future__ import annotations

import base64
import hmac
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import time
import uuid

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
import uvicorn

from sidecar import runtime
from sidecar.migrate import import_legacy, migration_status


def configure(root):
    config = runtime.read_json(root / 'integration.json', {})
    os.environ['VIBE_SIDECAR_ROOT'] = str(root)
    os.environ['VIBE_DB_PATH'] = str(root / 'vibe.db')
    os.environ['VIBE_DATA_DIR'] = str(root)
    os.environ['VIBE_AGENT_SERVER'] = config.get('agent_server') or os.environ.get('AGENT_SERVER_URL', '')
    os.environ['VIBE_AUTOMATION_API'] = config.get('automation_api', '')
    os.environ['VIBE_CANVAS_BASE'] = config.get('canvas_base', '')
    for target, filekey, envkeys in [
        ('VIBE_SESSION_KEY', 'session_key_file', ('SESSION_API_KEY', 'OH_SESSION_API_KEYS_0')),
        ('VIBE_AUTOMATION_KEY', 'automation_key_file', ('OPENHANDS_AUTOMATION_API_KEY',)),
    ]:
        value = next((os.environ[k] for k in envkeys if os.environ.get(k)), '')
        if config.get(filekey):
            value = Path(config[filekey]).read_text().strip()
        os.environ[target] = value


def add_routes(vibe, root, token, shutdown):
    app = vibe.app

    @app.middleware('http')
    async def authorize(request: Request, call_next):
        if not hmac.compare_digest(request.headers.get('authorization', ''), f'Bearer {token}'):
            return JSONResponse({'detail': 'Unauthorized'}, status_code=401)
        return await call_next(request)

    @app.post('/internal/shutdown')
    def stop_server():
        shutdown()
        return {'ok': True}

    @app.get('/api/runtime')
    def status():
        return {**migration_status(vibe), 'version': runtime.VERSION,
                'installation': runtime.installation_status(root),
                'agent_configured': bool(vibe.AGENT_SERVER and vibe.SESSION_KEY),
                'automation_configured': bool(vibe.AUTOMATION_API and vibe.AUTOMATION_KEY)}

    @app.post('/api/runtime')
    def migrate(payload: dict):
        if payload.get('action') != 'migrate' or payload.get('confirmed') is not True:
            raise HTTPException(400, 'Explicit migration confirmation required')
        # The browser cannot supply an arbitrary filesystem import path.
        source = Path.home() / '.openhands/vibe-manager'
        try:
            prepare_cutover(vibe, source, root)
            report = import_legacy(vibe, source)
            install_legacy_cli(vibe, source, root)
            finish_cutover(vibe, root)
            return report
        except (ValueError, OSError, httpx.HTTPError, httpx.InvalidURL) as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.get('/api/manager/conversations/{conv_id}')
    def conversation(conv_id: str, final_response: bool = False):
        data = vibe.agent_get(f'/api/conversations/{conv_id}?include_skills=false', timeout=30)
        result = {k: data.get(k) for k in ('id', 'execution_status', 'title')}
        result['model'] = ((data.get('agent') or {}).get('llm') or {}).get('model')
        if final_response:
            result['final_response'] = vibe.agent_get(f'/api/conversations/{conv_id}/agent_final_response', timeout=30)
        return result

    @app.post('/api/workspaces/{ws_id}/automation/start')
    def start_manager(ws_id: str):
        if not vibe.AUTOMATION_API or not vibe.AUTOMATION_KEY:
            raise HTTPException(409, 'Configure Automation URL and server-side credentials in Backend setup')
        result = vibe.ensure_manager_automation(ws_id)
        if not result:
            raise HTTPException(502, 'Automation setup failed; inspect backend service.log')
        return {'automation_id': result}

    @app.post('/api/workspaces/{ws_id}/automation/stop')
    def stop_manager(ws_id: str):
        ws = vibe._workspace(ws_id)
        if not ws.get('automation_id'):
            raise HTTPException(409, 'No manager configured')
        with httpx.Client(base_url=vibe.AUTOMATION_API, headers=vibe._automation_headers(), timeout=30) as client:
            res = client.patch(f'/v1/{ws["automation_id"]}', json={'enabled': False})
            res.raise_for_status()
        return {'ok': True}

    with vibe.db() as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY, ticket_id TEXT, filename TEXT, content_type TEXT, size INTEGER, data BLOB, created_at REAL)')
        conn.execute('DELETE FROM uploads WHERE created_at < ?', (time.time() - 86400,))

    @app.post('/api/uploads')
    def upload_begin(payload: dict):
        size = payload.get('size')
        if not isinstance(size, int) or not 0 < size <= vibe.MAX_ATTACHMENT_BYTES:
            raise HTTPException(413, 'Attachment must be between 1 byte and 25 MiB')
        with vibe.db() as conn:
            if not conn.execute('SELECT 1 FROM tickets WHERE id=?', (payload.get('ticket_id'),)).fetchone():
                raise HTTPException(404, 'Ticket not found')
            uid = uuid.uuid4().hex[:12]
            conn.execute('INSERT INTO uploads VALUES(?,?,?,?,?,?,?)', (uid, payload['ticket_id'],
                vibe.safe_filename(payload.get('filename', 'file')), payload.get('content_type') or 'application/octet-stream', size, b'', time.time()))
        return {'id': uid}

    @app.patch('/api/uploads/{uid}')
    def upload_chunk(uid: str, payload: dict):
        try:
            chunk = base64.b64decode(payload['base64'], validate=True)
        except (ValueError, KeyError) as exc:
            raise HTTPException(400, 'Invalid base64 chunk') from exc
        if len(chunk) > 32768:
            raise HTTPException(413, 'Chunk too large')
        with vibe.db() as conn:
            row = conn.execute('SELECT * FROM uploads WHERE id=?', (uid,)).fetchone()
            if not row:
                raise HTTPException(404, 'Upload not found')
            data = bytes(row['data'])
            offset = payload.get('offset')
            if not isinstance(offset, int) or offset < 0:
                raise HTTPException(400, 'Invalid offset')
            if offset < len(data) and data[offset:offset + len(chunk)] == chunk:
                return {'offset': len(data)}
            if offset != len(data) or len(data) + len(chunk) > row['size']:
                raise HTTPException(409, 'Unexpected chunk offset or size')
            conn.execute('UPDATE uploads SET data=? WHERE id=?', (data + chunk, uid))
        return {'offset': len(data) + len(chunk)}

    @app.post('/api/uploads/{uid}/finish')
    def upload_finish(uid: str):
        with vibe.db() as conn:
            done = conn.execute('SELECT * FROM attachments WHERE id=?', (uid,)).fetchone()
            if done:
                return vibe.attachment_dict(done)
            row = conn.execute('SELECT * FROM uploads WHERE id=?', (uid,)).fetchone()
            if not row or len(row['data']) != row['size']:
                raise HTTPException(409, 'Upload is incomplete')
            target = vibe.attachment_disk_path(uid, row['filename'])
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(row['data'])
            conn.execute('INSERT INTO attachments VALUES(?,?,?,?,?,?)', (uid, row['ticket_id'],
                row['filename'], row['content_type'], row['size'], time.time()))
            conn.execute('UPDATE tickets SET updated_at=? WHERE id=?', (time.time(), row['ticket_id']))
            conn.execute('DELETE FROM uploads WHERE id=?', (uid,))
            return vibe.attachment_dict(conn.execute('SELECT * FROM attachments WHERE id=?', (uid,)).fetchone())

    @app.delete('/api/uploads/{uid}')
    def upload_cancel(uid: str):
        with vibe.db() as conn:
            conn.execute('DELETE FROM uploads WHERE id=?', (uid,))
        return {'ok': True}


def prepare_cutover(vibe, source: Path, root: Path):
    cutover = runtime.read_json(root / 'cutover.json')
    if cutover and cutover.get('done'):
        return
    if not cutover:
        workspaces = runtime.read_json(source / 'index.json', {}).get('workspaces', [])
        states = []
        with httpx.Client(base_url=vibe.AUTOMATION_API or 'http://127.0.0.1',
                          headers=vibe._automation_headers(), timeout=30) as client:
            for ws in workspaces:
                if not ws.get('automation_id'):
                    continue
                if not vibe.AUTOMATION_API or not vibe.AUTOMATION_KEY:
                    raise ValueError('Configure Automation integration before migrating active managers')
                response = client.get(f'/v1/{ws["automation_id"]}')
                if response.status_code == 404:
                    continue
                response.raise_for_status()
                states.append({'workspace_id': ws['id'], 'automation_id': ws['automation_id'],
                               'manager_conversation_id': ws.get('manager_conversation_id'),
                               'enabled': response.json().get('enabled', False)})
        cutover = {'states': states, 'done': False}
        runtime.write_json(root / 'cutover.json', cutover)
    with httpx.Client(base_url=vibe.AUTOMATION_API or 'http://127.0.0.1',
                      headers=vibe._automation_headers(), timeout=30) as client:
        for state in cutover['states']:
            client.patch(f'/v1/{state["automation_id"]}', json={'enabled': False}).raise_for_status()
        for state in cutover['states']:
            response = client.get(f'/v1/{state["automation_id"]}/runs?limit=10')
            response.raise_for_status()
            if any(not r.get('completed_at') for r in response.json().get('runs', [])):
                raise ValueError('Managers are paused; an automation run is still active. Wait for it to finish, then retry migration.')
            if state.get('manager_conversation_id'):
                try:
                    conv = vibe.agent_get(f'/api/conversations/{state["manager_conversation_id"]}?include_skills=false')
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code != 404:
                        raise
                    conv = {}
                if conv.get('execution_status') == 'running':
                    raise ValueError('Managers are paused; a manager conversation is still running. Wait for it to finish, then retry migration.')


def finish_cutover(vibe, root: Path):
    cutover = runtime.read_json(root / 'cutover.json', {'states': [], 'done': False})
    if cutover['done']:
        return
    with httpx.Client(base_url=vibe.AUTOMATION_API or 'http://127.0.0.1',
                      headers=vibe._automation_headers(), timeout=30) as client:
        for state in cutover['states']:
            ws = vibe._workspace(state['workspace_id'])
            uploaded = client.post('/v1/uploads', params={'name': f'kanban-{ws["id"]}'},
                content=vibe.build_manager_tarball(ws), headers={'Content-Type': 'application/gzip'})
            uploaded.raise_for_status()
            client.patch(f'/v1/{state["automation_id"]}', json={
                'tarball_path': uploaded.json()['tarball_path'], 'enabled': state['enabled'],
            }).raise_for_status()
    cutover['done'] = True
    runtime.write_json(root / 'cutover.json', cutover)


def install_legacy_cli(vibe, legacy: Path, root: Path):
    source = Path(vibe.__file__).parent / 'automation'
    with vibe.db() as conn:
        workspaces = conn.execute('SELECT * FROM workspaces').fetchall()
    for ws in workspaces:
        directory = legacy / 'bin' / ws['id']
        directory.mkdir(parents=True, exist_ok=True)
        for name in ('vibectl.py', 'vibestore.py'):
            shutil.copy2(source / name, directory / name)
        runtime.write_json(directory / 'config.json', {'workspace_id': ws['id'],
            'workspace_path': ws['path'], 'store_dir': str(legacy), 'sidecar_root': str(root)})
    runtime.write_json(legacy / 'sidecar.json', {'root': str(root)})


def main():
    root = runtime.root_path()
    os.umask(0o077)
    configure(root)
    import app as vibe
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    token = secrets.token_urlsafe(32)
    server = uvicorn.Server(uvicorn.Config(vibe.app, log_level='warning'))
    add_routes(vibe, root, token, lambda: setattr(server, 'should_exit', True))
    state = {'pid': os.getpid(), 'port': port, 'token': token, 'version': runtime.VERSION}
    runtime.write_json(root / 'run.json', state)
    try:
        server.run(sockets=[sock])
    finally:
        if runtime.read_json(root / 'run.json', {}).get('token') == token:
            (root / 'run.json').unlink(missing_ok=True)
        sock.close()


if __name__ == '__main__':
    main()
