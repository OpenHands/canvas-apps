import { backendFor } from './api.js';

export const STATUSES = ['pending', 'in_progress', 'needs_input', 'finished'];
export const VERIFIED = 'verified';
export const UNFINISHED_STATUSES = new Set(['pending', 'in_progress', 'needs_input']);
export const DEFAULT_ACCENT = 'ember';
export const DEFAULT_THEME = 'dark';
export const DEFAULT_BUDGET = 10;

export class Store {
  constructor(host) {
    this.api = backendFor(host);
    this.writes = 0;
  }
  async mutate(path, method, body) {
    const result = await this.api.request(path, method, body);
    this.writes++;
    return result;
  }
  storeRoot() { return this.api.request('/api/health'); }
  listWorkspaces() { return this.api.request('/api/workspaces'); }
  async unfinishedCounts() {
    const { selected } = await this.listWorkspaces();
    return Object.fromEntries(selected.map(w => [w.id, w.unfinished_count]));
  }
  selectWorkspace(path) { return this.mutate('/api/workspaces', 'POST', { path }); }
  updateWorkspace(id, patch) { return this.mutate(`/api/workspaces/${id}`, 'PATCH', patch); }
  getBoard(id) { return this.api.request(`/api/workspaces/${id}/board`); }
  createTicket(id, body, settings) { return this.mutate(`/api/workspaces/${id}/tickets`, 'POST', { body, ...settings }); }
  appendEntry(ws, id, body, author = 'user') { return this.mutate(`/api/tickets/${id}/entries`, 'POST', { body, author }); }
  verifyTicket(ws, id) { return this.mutate(`/api/tickets/${id}/verify`, 'POST'); }
  reorder(id, status, ordered_ids) { return this.mutate(`/api/workspaces/${id}/reorder`, 'POST', { status, ordered_ids }); }
  async addAttachment(ws, id, file) {
    const upload = await this.api.request('/api/uploads', 'POST', {
      ticket_id: id, filename: file.name, content_type: file.type, size: file.size,
    });
    try {
      for (let offset = 0; offset < file.size; offset += 32768) {
        const bytes = new Uint8Array(await file.slice(offset, offset + 32768).arrayBuffer());
        let text = '';
        for (const b of bytes) text += String.fromCharCode(b);
        await this.api.request(`/api/uploads/${upload.id}`, 'PATCH', { offset, base64: btoa(text) });
      }
      return await this.mutate(`/api/uploads/${upload.id}/finish`, 'POST');
    } catch (error) {
      await this.api.request(`/api/uploads/${upload.id}`, 'DELETE').catch(() => {});
      throw error;
    }
  }
  async attachmentUrl(attachment) {
    const chunks = [];
    for (let offset = 0; offset < attachment.size; offset += 32768) {
      const data = await this.api.request(`/api/attachments/${attachment.id}`, 'GET', undefined, { offset });
      chunks.push(Uint8Array.from(atob(data.base64), c => c.charCodeAt(0)));
    }
    return URL.createObjectURL(new Blob(chunks, { type: attachment.content_type }));
  }
}
