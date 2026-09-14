import { backendFor } from './api.js';

export class Manager {
  constructor(host) { this.api = backendFor(host); }
  async ensure(ws) {
    const result = await this.api.request(`/api/workspaces/${ws.id}/automation/start`, 'POST');
    return result.automation_id;
  }
  stop(ws) { return this.api.request(`/api/workspaces/${ws.id}/automation/stop`, 'POST'); }
}
