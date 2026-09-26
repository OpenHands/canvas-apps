import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { fixture } from './fixture.mjs';

const backend = fixture();
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><div id="app"></div>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('kanbanRequest', request => backend.request(request));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async text => {
    window.observed = { onboarding: false, loading: false, paths: [] };
    window.observer = new MutationObserver(() => {
      window.observed.onboarding ||= !!document.querySelector('.backend-setup');
      window.observed.loading ||= !!document.querySelector('.backend-loading');
    });
    window.observer.observe(document.querySelector('#app'), { childList: true, subtree: true });
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const app = await import(url);
    URL.revokeObjectURL(url);
    window.deactivate = app.activate({ apiVersion: '1', backend: { id: 'browser-fixture', kind: 'local' },
      extension: { name: 'kanban-manager', version: '0.3.3' }, agentServer: { request: window.kanbanRequest },
      registerPage(id, mount) {
        window.mount = mount;
        window.dispose = mount({ container: document.querySelector('#app'), path: 'project', navigate(path) { window.observed.paths.push(path); } });
        return () => { window.mount = null; };
      }, navigate() {},
    });
  }, readFileSync(new URL('../extension.js', import.meta.url), 'utf8'));
  await page.waitForFunction(() => document.body.textContent.includes('Preserved request'));
  await page.waitForSelector('#board-wrap', { visible: true });
  assert.equal(await page.evaluate(() => window.observed.onboarding), false);
  assert.equal(await page.evaluate(() => window.observed.loading), true);
  await page.evaluate(() => { window.observed.paths.length = 0; });
  await page.click('.card .convo');
  assert.deepEqual(await page.evaluate(() => window.observed.paths), ['/conversations/test-conversation']);
  await page.type('#new-ticket-body', 'Chromium Blob request');
  await page.click('#new-ticket-submit');
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 2);
  await page.focus('.card');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#drawer').hidden);
  await page.click('#drawer .convo');
  assert.equal(await page.evaluate(() => window.observed.paths.at(-1)), '/conversations/test-conversation');
  await page.type('#append-body', 'Append-only browser entry');
  await page.$eval('#append-form', form => form.requestSubmit());
  await page.waitForFunction(() => document.querySelector('#drawer-thread').textContent.includes('Append-only browser entry'));
  const bytes = Buffer.from(Array.from({ length: 75000 }, (_, i) => i % 256));
  const path = join(backend.home, 'attachment.bin');
  writeFileSync(path, bytes);
  await (await page.$('#drawer-file-input')).uploadFile(path);
  await page.waitForFunction(() => document.querySelector('#drawer-attachments').textContent.includes('attachment.bin'), { timeout: 30000 });
  await page.evaluate(() => {
    const create = URL.createObjectURL;
    URL.createObjectURL = blob => {
      if (blob.size === 75000) blob.arrayBuffer().then(buffer => { window.downloaded = Array.from(new Uint8Array(buffer)); });
      return create.call(URL, blob);
    };
  });
  await page.click('#drawer-attachments a');
  await page.waitForFunction(() => window.downloaded?.length === 75000);
  assert.deepEqual(Buffer.from(await page.evaluate(() => window.downloaded)), bytes);
  assert.ok(backend.requests.every(request => request.path.startsWith('/kanban-manager/api/')));
  await page.click('#drawer-close');
  await page.evaluate(() => {
    window.dispose();
    window.observed = { onboarding: false, loading: false, paths: [] };
    window.dispose = window.mount({ container: document.querySelector('#app'), path: 'project', navigate(path) { window.observed.paths.push(path); } });
  });
  await page.waitForSelector('#board-wrap', { visible: true });
  assert.equal(await page.evaluate(() => window.observed.onboarding), false);
  assert.equal(await page.evaluate(() => window.observed.loading), true);
  assert.equal(await page.$$eval('.card', cards => cards.length), 2);
  await page.evaluate(() => { window.dispose(); window.deactivate(); window.observer.disconnect(); });
  assert.equal(await page.$('#board'), null);
  assert.equal(await page.$('#vibe-ext-style'), null);
  assert.deepEqual(errors, []);
  const empty = fixture({ installed: false });
  const staged = [];
  try {
    await page.exposeFunction('kanbanEmptyRequest', async request => {
      if (request.body?.command) {
        const payload = JSON.parse(Buffer.from(request.body.command.split(' ').at(-1), 'base64').toString());
        if (payload.action === 'stage') staged.push(payload.chunk.length);
        if (payload.action === 'install') {
          // Corrupt actual staged bytes to test verification without downloading dependencies.
          const path = join(empty.home, '.openhands/apps/kanban-manager/staging', payload.sha256 + '.b64');
          const content = readFileSync(path, 'utf8');
          writeFileSync(path, 'AAAA' + content.slice(4));
        }
      }
      return empty.request(request);
    });
    await page.evaluate(async text => {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
      const app = await import(url); URL.revokeObjectURL(url);
      window.deactivate = app.activate({ apiVersion: '1', backend: { id: 'empty-fixture', kind: 'local' },
        agentServer: { request: window.kanbanEmptyRequest },
        registerPage(id, mount) {
          window.dispose = mount({ container: document.querySelector('#app'), path: '', navigate() {} });
          return () => {};
        }, navigate() {},
      });
    }, readFileSync(new URL('../extension.js', import.meta.url), 'utf8'));
    await page.waitForSelector('.backend-loading [role=alert]');
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Backend setup').click());
    await page.waitForSelector('.backend-setup fieldset:not([disabled])');
    assert.deepEqual(readdirSync(empty.home), []);
    assert.equal(await page.$eval('.backend-actions button', button => button.disabled), true);
    await page.click('.backend-setup > label input[type=checkbox]');
    await page.click('.backend-actions button:first-child');
    await page.waitForFunction(() => document.querySelector('.backend-error')?.textContent.includes('checksum mismatch'), { timeout: 30000 });
    assert.ok(staged.length > 1 && staged.every(size => size <= 32768));
    assert.ok(!readdirSync(join(empty.home, '.openhands/apps/kanban-manager')).includes('current.json'));
    await page.evaluate(() => { window.dispose(); window.deactivate(); });
  } finally { empty.stop(); }
  console.log('Chromium Blob smoke: no onboarding flash on mount/remount, conversation routes, submit, drawer, append, 75KB HTTP attachment round-trip, zero command data requests, bounded installer upload/checksum, disposal passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  backend.stop();
}
