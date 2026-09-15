import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

export function fixture({ installed = true, canvasBase = 'https://canvas.example.test', authorized = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'kanban-app-test-'));
  const env = { ...process.env, HOME: home, VIBE_SESSION_KEY: '', VIBE_AUTOMATION_KEY: '', TEST_CANVAS_BASE: canvasBase };
  delete env.OH_SESSION_API_KEYS_0;
  delete env.SESSION_API_KEY;
  delete env.OPENHANDS_AUTOMATION_API_KEY;
  const python = execFileSync(process.env.PYTHON || 'python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  env.PATH = `${dirname(python)}:${env.PATH}`;
  env.AGENT_SERVER_URL = '';
  if (installed) execFileSync(python, [join(here, 'fixture.py'), 'start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const requests = [];
  return {
    home, requests,
    // Substitute only Canvas/gateway routing and server-side auth injection.
    // Data uses real HTTP; only lifecycle operations execute the real helper.
    async request(request) {
      requests.push(request);
      if (request.path.startsWith('/kanban-manager/api/')) {
        const state = JSON.parse(readFileSync(join(home, '.openhands/apps/kanban-manager/run.json'), 'utf8'));
        const response = await fetch(`http://127.0.0.1:${state.port}${request.path.slice('/kanban-manager'.length)}`, {
          method: request.method || 'GET', headers: { ...request.headers, 'Content-Type': 'application/json',
            Authorization: `Bearer ${authorized ? state.token : 'invalid'}` },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
        });
        const result = await response.json();
        if (!response.ok) throw Object.assign(new Error(result.detail || `HTTP ${response.status}`), { status: response.status });
        return result;
      }
      if (request.path === '/api/file/home') return { home };
      if (request.path !== '/api/bash/execute_bash_command') throw new Error(`Unexpected transport ${request.path}`);
      if (Buffer.byteLength(request.body.command) >= 128 * 1024) throw new Error('Command exceeds Linux single-argument limit');
      if (request.body.cwd !== home) throw new Error('Backend isolation violated');
      try {
        const { stdout, stderr } = await execute('/bin/sh', ['-c', request.body.command], {
          cwd: home, env, maxBuffer: 4 * 1024 * 1024, timeout: 180000,
        });
        return { exit_code: 0, stdout, stderr };
      } catch (error) {
        return { exit_code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
    },
    stopServer() { execFileSync(python, [join(here, 'fixture.py'), 'stop'], { env }); },
    stop() {
      if (installed) execFileSync(python, [join(here, 'fixture.py'), 'stop'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      rmSync(home, { recursive: true, force: true });
    },
  };
}
