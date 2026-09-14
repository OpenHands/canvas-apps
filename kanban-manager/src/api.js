const BOOTSTRAP = __VIBE_BOOTSTRAP__;
const PACKAGE = __VIBE_BACKEND__;
export const backendChecksum = PACKAGE.sha256;
const clients = new WeakMap();

export function encode(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class Backend {
  constructor(host) {
    this.host = host;
    this.home = null;
  }

  async command(payload) {
    if (!this.home) {
      const data = await this.host.agentServer.request({ path: '/api/file/home' });
      const home = (typeof data === 'string' ? JSON.parse(data) : data)?.home;
      if (typeof home !== 'string' || !home.startsWith('/') || /[\0\r\n]/.test(home) || home.split('/').includes('..')) {
        throw new Error('Agent Server did not return a safe absolute home directory');
      }
      this.home = home;
    }
    const command = `python3 -c 'import base64;exec(base64.b64decode("${BOOTSTRAP}"))' ${encode(payload)}`;
    const output = await this.host.agentServer.request({
      method: 'POST', path: '/api/bash/execute_bash_command',
      body: { command, cwd: this.home, timeout: 180000 },
    });
    let result;
    try { result = JSON.parse(output.stdout || '{}'); }
    catch { throw new Error('Backend bridge returned malformed output; inspect backend logs'); }
    if (output.exit_code !== 0 || result.error) {
      throw new Error(result.error || output.stderr || 'Backend bridge failed');
    }
    return result;
  }

  async probe(lifecycle = false) {
    if (lifecycle) {
      const status = await this.command({ action: 'probe' });
      validateStatus(status);
      if (status.runtime != null) validateRuntime(status.runtime);
      return status;
    }
    const runtime = await this.request('/api/runtime');
    const status = { ...runtime.installation, running: true, runtime };
    validateStatus(status);
    return status;
  }
  async install(integration) {
    const options = { confirmed: true, integration, sha256: PACKAGE.sha256 };
    for (let offset = 0; offset < PACKAGE.archive.length; offset += 32768) {
      const chunk = PACKAGE.archive.slice(offset, offset + 32768);
      const result = await this.command({ action: 'stage', ...options, offset, chunk });
      if (result.received !== offset + chunk.length) throw new Error('Incomplete backend upload; retry installation');
    }
    return this.command({ action: 'install', ...options });
  }
  start() { return this.command({ action: 'start' }); }
  stop() { return this.command({ action: 'stop' }); }
  async request(path, method = 'GET', body, options = {}) {
    if (!path.startsWith('/api/') || /[\\#\r\n]/.test(path) || path.split('?')[0].split('/').includes('..')) {
      throw new Error('Unsupported Kanban API route');
    }
    if (options.offset !== undefined) {
      if (!Number.isSafeInteger(options.offset) || options.offset < 0) throw new Error('Invalid attachment offset');
      path += `${path.includes('?') ? '&' : '?'}offset=${options.offset}`;
    }
    let result;
    try {
      result = await this.host.agentServer.request({ path: `/kanban-manager${path}`, method, body });
    } catch (cause) {
      const status = cause.status ?? cause.response?.status;
      const error = new Error(`Kanban HTTP request failed${status ? ` (${status})` : ''}: ${cause.message}. Check the selected backend URL, session authentication and nginx gateway; data requests never fall back to shell commands.`);
      error.status = status;
      throw error;
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('Kanban HTTP gateway returned invalid JSON. Select the nginx-facing backend URL and recheck.');
    }
    if (path === '/api/runtime' && method === 'GET') validateRuntime(result);
    return result;
  }
}

function validateStatus(status) {
  if (typeof status?.installed !== 'boolean' || typeof status.running !== 'boolean' || typeof status.legacy_present !== 'boolean') {
    throw new Error('Backend returned an invalid installation status; open Backend setup to repair/update it');
  }
}

function validateRuntime(detail) {
  if (!Array.isArray(detail?.imports) || typeof detail.legacy_changed !== 'boolean') {
    throw new Error('Backend returned invalid readiness data; recheck the connection');
  }
}

export function backendFor(host) {
  if (!clients.has(host)) clients.set(host, new Backend(host));
  return clients.get(host);
}
