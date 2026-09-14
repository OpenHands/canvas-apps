import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readdirSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { fixture } from './fixture.mjs';

function installDom() {
  const { window, document } = parseHTML(
    "<!doctype html><html><head></head><body></body></html>",
  );
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  /* linkedom exposes HTMLSelectElement.value as a getter only; real browsers
     have a setter that selects the matching <option>. The extension assigns
     select.value (as any DOM code would), so add the missing setter rather
     than contort the extension to suit the test double. */
  const selectValue = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  );
  if (selectValue && !selectValue.set) {
    Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
      get: selectValue.get,
      set(next) {
        for (const option of this.querySelectorAll("option")) {
          if (option.getAttribute("value") === next) option.setAttribute("selected", "");
          else option.removeAttribute("selected");
        }
      },
      configurable: true,
    });
  }

  globalThis.window = window;
  globalThis.document = document;
  globalThis.localStorage = localStorage;
  globalThis.HTMLElement = window.HTMLElement;
  if (!window.location) window.location = { pathname: "/" };
  return { window, document, store };
}


installDom();
const { activate } = await import('../extension.js');
const backend = fixture();
after(() => backend.stop());
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 150; i++) { if (check()) return; await delay(100); }
  assert.fail('Timed out waiting for real App path');
}
function mount(path = 'project', target = backend) {
  const registered = new Map();
  const host = { apiVersion: '1', backend: { id: 'fixture', kind: 'local', orgId: null },
    extension: { name: 'kanban-manager', version: '0.3.0' },
    agentServer: { request: request => target.request(request) },
    registerPage(id, fn) { registered.set(id, fn); return () => registered.delete(id); },
    navigate() {},
  };
  const deactivate = activate(host);
  const container = document.createElement('div');
  document.body.append(container);
  const dispose = registered.get('board')({ container, path, navigate() {} });
  return { container, registered, dispose() { dispose(); deactivate(); container.remove(); } };
}

test('built React App registers, restores SQLite board, submits, persists preferences and disposes', async () => {
  const app = mount();
  try {
    assert.equal(app.registered.size, 1);
    await until(() => app.container.textContent.includes('Preserved request'));
    assert.equal(app.container.querySelector('.vibe-ext[data-theme="light"]').dataset.accent, 'iris');
    await until(() => app.container.querySelector('.workspace-indicator'));
    const indicator = app.container.querySelector('.workspace-indicator');
    assert.equal(indicator.dataset.path, `${backend.home}/other-project`);
    assert.equal(indicator.dataset.accent, 'teal');
    assert.equal(indicator.hasAttribute('title'), false);
    assert.equal(app.container.querySelector('[role="tooltip"]').textContent, 'other-project');
    assert.equal(app.container.querySelectorAll('.workspace-indicator').length, 1);
    assert.equal(app.container.querySelector('.control-workspace').firstElementChild.id, 'workspace-indicators');
    const textarea = app.container.querySelector('#new-ticket-body');
    textarea.value = 'New request from real UI';
    app.container.querySelector('#new-ticket-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => app.container.querySelectorAll('.card').length === 2);
    assert.ok(app.container.textContent.includes('New request from real UI'));
    const concurrency = app.container.querySelector('#max-concurrent');
    concurrency.value = '5';
    concurrency.dispatchEvent(new window.Event('change', { bubbles: true }));
    await delay(1000);
  } finally { app.dispose(); }
  await delay(300);
  assert.equal(document.querySelector('#vibe-ext-style'), null);
  const count = backend.requests.length;
  await delay(2200);
  assert.equal(backend.requests.length, count, 'unmount must stop polling');
  const reopened = mount();
  try {
    await until(() => reopened.container.textContent.includes('New request from real UI'));
    assert.equal(reopened.container.querySelector('#max-concurrent').value, '5');
  } finally { reopened.dispose(); }
  assert.ok(backend.requests.every(r => ['/api/file/home', '/api/bash/execute_bash_command'].includes(r.path)));
});

test('unsupported API and unknown nested routes fail clearly', async () => {
  assert.throws(() => activate({ apiVersion: '2' }), /host API 1/);
  const app = mount('not/a/route');
  try { await until(() => app.container.textContent.includes('Page not found')); }
  finally { app.dispose(); }
});


test('first-run onboarding probes without mutation and requires installation approval', async () => {
  const empty = fixture({ installed: false });
  const app = mount('', empty);
  try {
    await until(() => app.container.textContent.includes(empty.home));
    const install = [...app.container.querySelectorAll('button')].find(b => b.textContent === 'Install backend');
    assert.ok(install.disabled);
    assert.deepEqual(readdirSync(empty.home), [], 'probe must not create backend state');
    assert.ok(app.container.textContent.includes('SHA-256'));
    assert.ok(app.container.textContent.includes('Agent-assisted setup'));
  } finally { app.dispose(); empty.stop(); }
});

test('unreachable backend produces a visible recoverable error', async () => {
  const broken = { request: async () => { throw new Error('Connection refused'); } };
  const app = mount('', broken);
  try {
    await until(() => app.container.querySelector('[role="alert"]')?.textContent.includes('Connection refused'));
    assert.ok([...app.container.querySelectorAll('button')].some(b => b.textContent === 'Recheck'));
  } finally { app.dispose(); }
});
