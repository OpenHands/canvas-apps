"""Bundled onboarding bootstrap. Reads only on probe; installs only on approval."""
import base64
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
from urllib.parse import urlsplit


def main():
    home = Path.cwd().resolve()
    if home != Path.home().resolve():
        raise ValueError('Setup must target the owning Agent Server home')
    root = home / '.openhands/apps/kanban-manager'
    payload = json.loads(base64.b64decode(sys.argv[1], validate=True))
    action = payload.get('action')
    current_path = root / 'current.json'
    if action in ('install', 'stage'):
        if payload.get('confirmed') is not True:
            raise ValueError('Installation requires explicit approval')
        digest = payload.get('sha256', '')
        if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise ValueError('Invalid backend package checksum')
        config = payload.get('integration', {})
        if set(config) - {'agent_server', 'automation_api', 'session_key_file', 'automation_key_file', 'canvas_base'}:
            raise ValueError('Unexpected integration setting')
        for key in ('agent_server', 'automation_api', 'canvas_base'):
            if config.get(key):
                url = urlsplit(config[key])
                # urlsplit defers validating malformed/out-of-range ports until access.
                if url.port == 0:
                    raise ValueError('Integration URL port must be positive')
                if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment:
                    raise ValueError('Integration URLs must be explicit HTTP(S) endpoints without credentials')
        for key in ('session_key_file', 'automation_key_file'):
            if config.get(key) and not Path(config[key]).is_absolute():
                raise ValueError('Credential file must be an absolute server-side path')
        staged = root / 'staging' / (digest + '.b64')
        if action == 'stage':
            chunk = payload.get('chunk')
            offset = payload.get('offset')
            if not isinstance(chunk, str) or not 0 < len(chunk) <= 32768:
                raise ValueError('Invalid backend package chunk size')
            base64.b64decode(chunk, validate=True)
            if type(offset) is not int or offset < 0 or offset + len(chunk) > 4 * 1024 * 1024:
                raise ValueError('Invalid backend package offset')
        else:
            encoded = payload['archive'] if 'archive' in payload else staged.read_text()
            if len(encoded) > 4 * 1024 * 1024:
                raise ValueError('Backend package is too large')
            archive = base64.b64decode(encoded, validate=True)
            if hashlib.sha256(archive).hexdigest() != digest:
                raise ValueError('Backend package checksum mismatch')
        os.umask(0o077)
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        root.chmod(0o700)
        install_lock = (root / 'installer.lock').open('a')
        try:
            fcntl.flock(install_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ValueError('Another installation is in progress; recheck its status') from exc
        if action == 'stage':
            staged.parent.mkdir(exist_ok=True, mode=0o700)
            with staged.open('a+b') as output:
                if offset == 0:
                    output.truncate(0)
                elif output.seek(0, 2) != offset:
                    raise ValueError('Backend package offset mismatch; retry installation')
                output.write(chunk.encode('ascii'))
            print(json.dumps({'received': offset + len(chunk)}))
            return
        source = root / 'releases' / digest
        source.mkdir(parents=True, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
            for item in tar:
                target = source / item.name
                if not item.isfile() or not target.resolve().is_relative_to(source.resolve()) or item.size > 2 * 1024 * 1024:
                    raise ValueError('Unsafe backend archive member')
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(tar.extractfile(item).read())
        integration = root / 'integration.json'
        integration.write_text(json.dumps(config))
        integration.chmod(0o600)
        env = {**os.environ, 'VIBE_SIDECAR_ROOT': str(root)}
        (root / 'install.json').write_text(json.dumps({'status': 'installing'}))
        with (root / 'install.log').open('ab') as log:
            subprocess.Popen([sys.executable, '-m', 'sidecar.runtime', 'install'], cwd=source,
                env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, pass_fds=(install_lock.fileno(),))
        staged.unlink(missing_ok=True)
        print(json.dumps({'status': 'installing', 'data_dir': str(root)}))
        return
    if not current_path.exists():
        status = json.loads((root / 'install.json').read_text()) if (root / 'install.json').exists() else None
        print(json.dumps({'installed': False, 'running': False, 'data_dir': str(root),
            'legacy_present': (home / '.openhands/vibe-manager/index.json').is_file(),
            'agent_server': os.environ.get('AGENT_SERVER_URL', ''),
            'automation_api': os.environ.get('VIBE_AUTOMATION_API', ''), 'install': status}))
        return
    current = json.loads(current_path.read_text())
    sys.path.insert(0, current['source'])
    from sidecar import runtime
    os.environ['VIBE_SIDECAR_ROOT'] = str(root)
    runtime.main()


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(1)
