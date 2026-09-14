import { backendFor } from './api.js';

export class ManagerChat {
  constructor(host) { this.api = backendFor(host); }
  async start(ws) {
    this.wsId = ws.id;
    const result = await this.api.request(`/api/workspaces/${ws.id}/manager-chat`, 'POST');
    return result.conversation_id;
  }
  send(id, body) {
    return this.api.request(`/api/workspaces/${this.wsId}/manager-chat/${id}/messages`, 'POST', { body });
  }
  async messages(id, after = null) {
    const query = after ? `?after=${encodeURIComponent(after)}` : '';
    const data = await this.api.request(`/api/workspaces/${this.wsId}/manager-chat/${id}/messages${query}`);
    return { ...data, latestAction: data.latest_action };
  }
}
