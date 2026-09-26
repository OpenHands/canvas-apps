import { backendFor } from './api.js';

export class Live {
  constructor(host) { this.api = backendFor(host); }
  decorate(tickets) { return tickets; }
  automationStatus(ws) { return this.api.request(`/api/workspaces/${ws.id}/automation`); }
  triggerAutomation(ws) { return this.api.request(`/api/workspaces/${ws.id}/automation/trigger`, 'POST'); }
  llmProfiles() { return this.api.request('/api/manager/llm-profiles'); }
}
