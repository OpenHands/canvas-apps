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

  probe() { return this.command({ action: 'probe' }); }
  install(integration) { return this.command({ action: 'install', confirmed: true, integration, ...PACKAGE }); }
  start() { return this.command({ action: 'start' }); }
  stop() { return this.command({ action: 'stop' }); }
  async request(path, method = 'GET', body, options = {}) {
    const response = await this.command({ action: 'rpc', path, method, body, ...options });
    if (!Number.isInteger(response.status)) throw new Error('Backend is not installed; open Backend setup');
    if (response.status >= 400) {
      const error = new Error(typeof response.body?.detail === 'string' ? response.body.detail : `Backend request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return response.body;
  }
}

export function backendFor(host) {
  if (!clients.has(host)) clients.set(host, new Backend(host));
  return clients.get(host);
}
