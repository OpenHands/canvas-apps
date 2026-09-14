"""Real SQLite migration and authenticated sidecar HTTP tests; no service doubles."""
import base64
import concurrent.futures
import hashlib
import importlib
import json
import os
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class SidecarTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.data = self.home / 'app'
        self.legacy = self.home / 'legacy'
        self.legacy.mkdir()
        ws = {'id': 'abc123', 'path': str(self.home), 'name': 'project',
              'created_at': 1, 'theme': 'light', 'accent': 'iris', 'push_mode': 'main'}
        (self.legacy / 'index.json').write_text(json.dumps({'workspaces': [ws]}))
        directory = self.legacy / 'workspaces/abc123/tickets/def456'
        directory.mkdir(parents=True)
        self.ticket = directory / 'ticket.json'
        self.ticket.write_text(json.dumps({'id': 'def456', 'status': 'finished',
            'created_at': 2, 'updated_at': 3, 'finished_at': 3, 'title': '🦊 Test',
            'entries': [{'id': 'entry123', 'author': 'user', 'body': 'Original', 'created_at': 2}],
            'attachments': []}))
        os.environ['VIBE_DB_PATH'] = str(self.data / 'vibe.db')
        os.environ['VIBE_DATA_DIR'] = str(self.data)
        os.environ['VIBE_SESSION_KEY'] = ''
        os.environ['VIBE_AUTOMATION_KEY'] = ''
        self.data.mkdir()
        import app
        self.app = importlib.reload(app)

    def tearDown(self):
        self.tmp.cleanup()

    def test_onboarding_rejects_invalid_ports_without_mutation(self):
        payload = dict(action='install', confirmed=True, archive='',
            sha256=hashlib.sha256(b'').hexdigest(),
            integration={'agent_server': 'http://127.0.0.1:1800http://127.0.0.1:18000'})
        result = subprocess.run([sys.executable, str(ROOT / 'sidecar/bootstrap.py'),
            base64.b64encode(json.dumps(payload).encode()).decode()], cwd=self.home,
            env={**os.environ, 'HOME': str(self.home)}, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.home / '.openhands').exists())
        self.assertIn('port', json.loads(result.stdout)['error'].lower())

    def test_migration_idempotence_and_transaction(self):
        from sidecar.migrate import import_legacy
        report = import_legacy(self.app, self.legacy)
        self.assertEqual(report['tickets'], 1)
        self.assertEqual(self.app.get_board('abc123')['workspace']['theme'], 'light')
        self.app.append_entry('def456', self.app.NewEntry(body='New'))
        import_legacy(self.app, self.legacy)
        self.assertEqual(len(self.app.get_board('abc123')['tickets'][0]['entries']), 2)
        self.assertEqual(json.loads(self.ticket.read_text())['entries'][0]['body'], 'Original')

    def test_bad_import_leaves_no_partial_rows(self):
        from sidecar.migrate import import_legacy
        doc = json.loads(self.ticket.read_text())
        doc['attachments'] = [{'id': 'missing', 'filename': 'absent', 'size': 2, 'created_at': 1}]
        self.ticket.write_text(json.dumps(doc))
        with self.assertRaises(ValueError):
            import_legacy(self.app, self.legacy)
        with self.app.db() as conn:
            self.assertEqual(conn.execute('select count(*) from workspaces').fetchone()[0], 0)

    def test_legacy_board_layout_and_changed_writer_detection(self):
        from sidecar.migrate import import_legacy, migration_status
        ticket = json.loads(self.ticket.read_text())
        self.ticket.unlink()
        self.ticket.parent.rmdir()
        self.ticket.parent.parent.rmdir()
        board = self.legacy / 'workspaces/abc123/board.json'
        board.write_text(json.dumps({'tickets': [ticket]}))
        import_legacy(self.app, self.legacy)
        self.assertFalse(migration_status(self.app)['legacy_changed'])
        ticket['entries'].append({'id': 'late', 'author': 'user', 'body': 'Old tab', 'created_at': 4})
        board.write_text(json.dumps({'tickets': [ticket]}))
        self.assertTrue(migration_status(self.app)['legacy_changed'])
        with self.assertRaisesRegex(ValueError, 'Legacy store changed'):
            import_legacy(self.app, self.legacy)
        self.assertEqual(len(self.app.get_board('abc123')['tickets'][0]['entries']), 1)

    def test_binary_upload_download_and_legacy_cli_use_same_sqlite(self):
        from sidecar.migrate import import_legacy
        from sidecar.runtime import start, stop, rpc, write_json
        import_legacy(self.app, self.legacy)
        write_json(self.data / 'integration.json', {})
        write_json(self.data / 'current.json', {'source': str(ROOT)})
        write_json(self.legacy / 'sidecar.json', {'root': str(self.data)})
        start(self.data, source=ROOT, python=sys.executable)
        try:
            def api(path, method='GET', body=None, **options):
                result = rpc(self.data, dict(path=path, method=method, body=body, **options))
                self.assertLess(result['status'], 400, result)
                return result['body']
            # Same path with a legacy random workspace id must not violate path UNIQUE.
            selected = api('/api/workspaces', 'POST', {'path': str(self.home)})
            self.assertEqual(selected['id'], 'abc123')
            content = bytes(range(256)) * 300
            upload = api('/api/uploads', 'POST', {'ticket_id': 'def456', 'filename': '../data.bin', 'size': len(content)})
            for offset in range(0, len(content), 32768):
                chunk = {'offset': offset, 'base64': base64.b64encode(content[offset:offset + 32768]).decode()}
                api('/api/uploads/' + upload['id'], 'PATCH', chunk)
                api('/api/uploads/' + upload['id'], 'PATCH', chunk)
            attachment = api('/api/uploads/' + upload['id'] + '/finish', 'POST')
            self.assertEqual(attachment['filename'], 'data.bin')
            downloaded = b''.join(base64.b64decode(api('/api/attachments/' + upload['id'], offset=offset)['base64'])
                                  for offset in range(0, len(content), 32768))
            self.assertEqual(downloaded, content)
            env = {**os.environ, 'VIBE_STORE_DIR': str(self.legacy)}
            env.pop('VIBE_SIDECAR_ROOT', None)
            result = subprocess.run([sys.executable, str(ROOT / 'automation/vibectl.py'),
                '--workspace-id', 'abc123', 'patch', 'def456', '--manager-note', 'CLI reached SQLite'],
                env=env, capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout)['manager_note'], 'CLI reached SQLite')
            self.assertNotIn('manager_note', json.loads(self.ticket.read_text()))
        finally:
            stop(self.data)

    def test_authenticated_http_concurrency_and_persistence(self):
        from sidecar.migrate import import_legacy
        from sidecar.runtime import start, stop, rpc, probe
        import_legacy(self.app, self.legacy)
        (self.data / 'integration.json').write_text('{}')
        state = start(self.data, source=ROOT, python=sys.executable)
        try:
            self.assertEqual(httpx.get(f"http://127.0.0.1:{state['port']}/api/health").status_code, 401)
            def append(i):
                return rpc(self.data, {'path': '/api/tickets/def456/entries',
                    'method': 'POST', 'body': {'body': f'Entry {i}'}})
            with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                results = list(pool.map(append, range(12)))
            self.assertTrue(all(r['status'] == 200 for r in results))
            board = rpc(self.data, {'path': '/api/workspaces/abc123/board'})['body']
            self.assertEqual(len(board['tickets'][0]['entries']), 13)
            self.assertEqual(board['tickets'][0]['status'], 'pending')
            with self.assertRaises(ValueError):
                rpc(self.data, {'path': '/api/manager/agent-credentials'})
            with self.assertRaises(ValueError):
                rpc(self.data, {'path': 'http://example.com/'})
        finally:
            stop(self.data)
        self.assertFalse(probe(self.data)['running'])
        start(self.data, source=ROOT, python=sys.executable)
        try:
            self.assertEqual(len(rpc(self.data, {'path': '/api/workspaces/abc123/board'})['body']['tickets'][0]['entries']), 13)
        finally:
            stop(self.data)


if __name__ == '__main__':
    unittest.main()
