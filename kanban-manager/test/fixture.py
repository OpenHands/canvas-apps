"""Isolated real FastAPI fixture shared by Node and Chromium tests."""
import json
import os
from pathlib import Path
import sys

source = Path(__file__).resolve().parents[1] / 'backend'
if not source.is_dir():
    source = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(source))
from sidecar import runtime

root = Path.home() / '.openhands/apps/kanban-manager'
if sys.argv[1] == 'stop':
    runtime.stop(root)
else:
    root.mkdir(parents=True, exist_ok=True)
    os.environ['VIBE_DB_PATH'] = str(root / 'vibe.db')
    os.environ['VIBE_DATA_DIR'] = str(root)
    os.environ['VIBE_SESSION_KEY'] = ''
    os.environ['VIBE_AUTOMATION_KEY'] = ''
    import app
    project = Path.home() / 'project'
    project.mkdir(exist_ok=True)
    with app.db() as conn:
        conn.execute('INSERT INTO workspaces(id,path,name,created_at,theme,accent) VALUES(?,?,?,?,?,?)',
                     ('fixture', str(project), 'project', 1, 'light', 'iris'))
    ticket = app.create_ticket('fixture', app.NewTicket(body='Preserved request'))
    with app.db() as conn:
        conn.execute('UPDATE tickets SET conversation_id=? WHERE id=?', ('test-conversation', ticket['id']))
    other = Path.home() / 'other-project'
    other.mkdir(exist_ok=True)
    with app.db() as conn:
        conn.execute('INSERT INTO workspaces(id,path,name,created_at,accent) VALUES(?,?,?,?,?)',
                     ('other', str(other), 'other-project', 2, 'teal'))
    for i in range(2):
        app.create_ticket('other', app.NewTicket(body=f'Inactive request {i}'))
    runtime.write_json(root / 'integration.json', {'canvas_base': os.environ.get('TEST_CANVAS_BASE', 'https://canvas.example.test')})
    runtime.write_json(root / 'current.json', {'source': str(source), 'version': runtime.VERSION})
    runtime.start(root, source=source, python=sys.executable)
    print(json.dumps({'root': str(root), 'source': str(source)}))
