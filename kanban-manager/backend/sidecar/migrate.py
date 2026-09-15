"""Transactional, additive import of the two legacy JSON layouts.

Original documents remain untouched; a manifest detects old tabs/writers after
cutover. Unknown fields are retained in legacy_records for lossless recovery.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import time


ID = re.compile(r'^[A-Za-z0-9_-]{1,128}$')


def identity(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ValueError('invalid legacy record identifier')
    return value


def documents(root: Path) -> list[Path]:
    if not (root / 'index.json').is_file():
        return []
    paths = [root / 'index.json']
    index = json.loads(paths[0].read_text())
    for ws in index['workspaces']:
        directory = root / 'workspaces' / identity(ws['id'])
        if (directory / 'tickets').is_dir():
            paths.extend(sorted((directory / 'tickets').glob('*/ticket.json')))
        elif (directory / 'board.json').is_file():
            paths.append(directory / 'board.json')
    return paths


def digest(root: Path) -> str:
    value = hashlib.sha256()
    for p in documents(root):
        if p.is_symlink() or not p.resolve().is_relative_to(root.resolve()):
            raise ValueError('legacy document escapes store')
        value.update(str(p.relative_to(root)).encode())
        value.update(p.read_bytes())
    return value.hexdigest()


def migration_status(app) -> dict:
    with app.db() as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS imports(source TEXT PRIMARY KEY, digest TEXT, report TEXT)')
        rows = conn.execute('SELECT * FROM imports').fetchall()
    reports = []
    for row in rows:
        report = json.loads(row['report'])
        try:
            report['legacy_changed'] = digest(Path(row['source'])) != row['digest']
        except (OSError, ValueError):
            report['legacy_changed'] = True
        reports.append(report)
    return {'imports': reports, 'legacy_changed': any(r['legacy_changed'] for r in reports)}


def import_legacy(app, source: Path) -> dict:
    source = source.resolve()
    before = digest(source)
    with app.db() as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS imports(source TEXT PRIMARY KEY, digest TEXT, report TEXT)')
        conn.execute('CREATE TABLE IF NOT EXISTS legacy_records(source TEXT, path TEXT, body TEXT, PRIMARY KEY(source,path))')
        previous = conn.execute('SELECT * FROM imports WHERE source=?', (str(source),)).fetchone()
        if previous:
            if previous['digest'] != before:
                raise ValueError('Legacy store changed after migration. Reconcile its preserved records before continuing; refusing to overwrite SQLite.')
            return json.loads(previous['report'])
    paths = documents(source)
    parsed = {p: json.loads(p.read_text()) for p in paths}
    workspaces = parsed.get(source / 'index.json', {}).get('workspaces', [])
    tickets = []
    copies = []
    for ws in workspaces:
        ws_id = identity(ws['id'])
        if not Path(ws['path']).is_absolute():
            raise ValueError('legacy workspace must have an absolute path')
        directory = source / 'workspaces' / ws_id
        if (directory / 'tickets').is_dir():
            records = [parsed[p] for p in paths if p.parent.parent == directory / 'tickets']
        else:
            records = parsed.get(directory / 'board.json', {}).get('tickets', [])
        for t in records:
            identity(t['id'])
            if t.get('status') not in (*app.STATUSES, app.VERIFIED):
                raise ValueError('invalid legacy ticket status')
            tickets.append({**t, 'workspace_id': ws_id})
            for e in t.get('entries', []):
                identity(e['id'])
            for a in t.get('attachments', []):
                identity(a['id'])
                name = a['filename']
                if name != Path(name).name or name in ('.', '..') or '\\' in name:
                    raise ValueError('unsafe attachment filename')
                src = source / 'attachments' / a['id'] / name
                if not src.is_file() or src.is_symlink() or not src.resolve().is_relative_to(source):
                    raise ValueError(f'Missing or unsafe attachment: {a["id"]}/{name}')
                if src.stat().st_size != a['size']:
                    raise ValueError(f'Attachment size mismatch: {a["id"]}')
                copies.append((src, app.attachment_disk_path(a['id'], name)))
    backup = app.DATA_DIR / 'backups' / f'legacy-{int(time.time())}-{before[:12]}'
    backup.mkdir(parents=True, exist_ok=True, mode=0o700)
    for p in paths:
        target = backup / p.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(p.read_bytes())
    with sqlite3.connect(app.DB_PATH) as src, sqlite3.connect(backup / 'before.sqlite3') as dst:
        src.backup(dst)
    # Bytes are immutable and copied before the transaction; unreferenced bytes
    # after a failed import are harmless, whereas committed missing files aren't.
    for src, target in copies:
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and target.read_bytes() != src.read_bytes():
            raise ValueError(f'Conflicting attachment: {src.name}')
        shutil.copy2(src, target)
    report = {'source': str(source), 'backup': str(backup), 'workspaces': len(workspaces),
              'tickets': len(tickets), 'attachments': len(copies)}
    with app.db() as conn:
        if conn.execute('SELECT 1 FROM imports WHERE source=?', (str(source),)).fetchone():
            raise ValueError('Concurrent migration; recheck before retrying')
        def insert(table, record):
            columns = {r['name'] for r in conn.execute(f'PRAGMA table_info({table})')}
            fields = {k: v for k, v in record.items() if k in columns}
            names = list(fields)
            conn.execute(f'INSERT INTO {table} ({",".join(names)}) VALUES ({",".join("?" for _ in names)})', list(fields.values()))
        for ws in workspaces:
            insert('workspaces', ws)
        for t in tickets:
            insert('tickets', t)
            for e in t.get('entries', []):
                insert('entries', {**e, 'ticket_id': t['id']})
            for a in t.get('attachments', []):
                insert('attachments', {**a, 'ticket_id': t['id']})
        for p in paths:
            conn.execute('INSERT INTO legacy_records VALUES(?,?,?)',
                         (str(source), str(p.relative_to(source)), json.dumps(parsed[p], ensure_ascii=False)))
        if digest(source) != before:
            raise ValueError('Legacy writers are still active; migration rolled back. Close old tabs and pause managers before retrying.')
        conn.execute('INSERT INTO imports VALUES(?,?,?)', (str(source), before, json.dumps(report)))
    return report
