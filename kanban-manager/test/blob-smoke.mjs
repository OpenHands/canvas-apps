import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
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
      extension: { name: 'kanban-manager', version: '0.3.1' }, agentServer: { request: window.kanbanRequest },
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
  console.log('Chromium Blob smoke: no onboarding flash on mount/remount, conversation routes, submit, drawer, append, 75KB attachment, disposal passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  backend.stop();
}
