import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { backendFor, backendChecksum } from './api.js';
import { acquireStyle, mountBoard } from './extension.js';

const PAGE_ROOT = '/extensions/kanban-manager/board';

function Board({ host, context }) {
  const container = useRef(null);
  useEffect(() => mountBoard({ ...context, container: container.current, host }), [host, context]);
  return <div ref={container} />;
}

export function App({ host, context }) {
  const api = backendFor(host);
  const [snapshot, setSnapshot] = useState(null);
  const status = snapshot?.status;
  const runtime = snapshot?.runtime;
  const [setup, setSetup] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [approved, setApproved] = useState(false);
  const [migrationApproved, setMigrationApproved] = useState(false);
  const [integration, setIntegration] = useState({});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const release = acquireStyle();
    return () => { alive.current = false; release(); };
  }, []);

  async function refresh() {
    const next = await api.probe();
    if (!alive.current) return;
    // Older installed backends do not include runtime readiness in their probe.
    const detail = next.running ? next.runtime ?? await api.request('/api/runtime') : null;
    if (!alive.current) return;
    setSnapshot({ status: next, runtime: detail });
    setIntegration(old => Object.keys(old).length ? old : {
      agent_server: next.integration?.agent_server || next.agent_server || '',
      automation_api: next.integration?.automation_api || next.automation_api || '',
      session_key_file: next.integration?.session_key_file || '',
      automation_key_file: next.integration?.automation_key_file || '',
      canvas_base: next.integration?.canvas_base || '',
    });
    if (next.install?.status === 'error') setError(next.install.error);
  }

  async function perform(fn) {
    setBusy(true); setError('');
    try {
      if (fn) await fn();
      if (alive.current) await refresh();
    }
    catch (e) { if (alive.current) setError(e.message); }
    finally { if (alive.current) setBusy(false); }
  }

  useEffect(() => { perform(); }, []);
  useEffect(() => {
    if (status?.install?.status !== 'installing') return undefined;
    let stopped = false;
    const poll = async () => {
      try { await refresh(); } catch (e) { if (!stopped && alive.current) setError(e.message); }
    };
    const timer = setInterval(poll, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [status?.install?.status]);

  useEffect(() => {
    if (!status?.running) return undefined;
    let pending = false;
    const timer = setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const detail = await api.request('/api/runtime');
        if (alive.current) setSnapshot(old => old && { ...old, runtime: detail });
      } catch (e) { if (alive.current) setError(e.message); }
      finally { pending = false; }
    }, 30000);
    return () => clearInterval(timer);
  }, [status?.running]);

  const migrationNeeded = status?.legacy_present && !runtime?.imports?.length;
  const showSetup = setup || !status?.running || migrationNeeded;
  const installing = status?.install?.status === 'installing';
  const pathValid = !context.path || context.path.split('/').filter(Boolean).length === 1;

  if (!pathValid) return <section className="vibe-ext"><h1>Page not found</h1><button onClick={() => context.navigate(PAGE_ROOT)}>Open board</button></section>;

  if (!status) return <section className="vibe-ext backend-loading" aria-label="Kanban Manager" aria-busy={busy}>
    <h1>Kanban Manager</h1>
    {error ? <>
      <p role="alert">Unable to check the backend: {error}</p>
      <p>Your board has not been changed. Check the Agent Server connection and recheck.</p>
      <button disabled={busy} onClick={() => perform()}>Recheck</button>
    </> : <p role="status">Loading Kanban Manager…</p>}
  </section>;

  return <div className="kanban-app">
    <style>{`
      .kanban-app .backend-bar { display:flex; align-items:center; gap:1rem; padding:.5rem 1rem; }
      .kanban-app .backend-setup { padding:2rem; max-width:60rem; margin:auto; }
      .kanban-app .backend-setup label { display:block; margin:1rem 0; }
      .kanban-app .backend-setup input:not([type=checkbox]) { display:block; width:100%; }
      .kanban-app .backend-actions { display:flex; gap:.6rem; flex-wrap:wrap; margin:1rem 0; }
      .kanban-app .backend-setup pre { white-space:pre-wrap; overflow-wrap:anywhere; }
      .kanban-app .backend-error { color:var(--danger); padding:1rem; }
    `}</style>
    <div className="vibe-ext backend-bar">
      <span role="status">{status?.running ? 'Backend connected · SQLite' : 'Kanban backend setup'}</span>
      <button onClick={() => setSetup(!setup)}>{setup ? 'Return to board' : 'Backend setup'}</button>
      {error && !showSetup && <span role="alert">{error} — open Backend setup to recheck.</span>}
      {runtime?.legacy_changed && <strong role="alert">Legacy files changed after migration. Close old App tabs and reconcile the preserved files; SQLite was not overwritten.</strong>}
    </div>
    {showSetup ? <section className="vibe-ext backend-setup" aria-label="Kanban backend onboarding">
      <h1>Kanban Manager backend</h1>
      <p>This App runs a private FastAPI sidecar on the selected Agent Server. Your board lives in SQLite, not in your browser or the installed App directory.</p>
      {error && <p role="alert" className="backend-error">{error}</p>}
      <pre>{status?.data_dir || 'Discovering Agent Server home…'}</pre>
      <p>Install downloads the pinned Python dependencies from PyPI into a private virtual environment. It starts a loopback-only, authenticated background process that stays running when this view closes so managers can keep working. No system service or global Python packages are changed.</p>
      <p>Backend package SHA-256: <code>{backendChecksum}</code></p>
      <p>Repair replaces backend code and dependencies, not your database, attachments, backups, or automation history. Stop does not delete data; managers cannot use the board while it is stopped.</p>
      <fieldset disabled={busy || installing}>
        <legend>Backend integration (server-side configuration)</legend>
        {Object.entries({ agent_server: 'Agent Server URL', automation_api: 'Automation API URL (including /api/automation)', session_key_file: 'Agent Server session key file (absolute path, optional if inherited)', automation_key_file: 'Automation key file (optional if inherited)', canvas_base: 'Canvas URL (optional; blank uses relative conversation links)' }).map(([key, label]) =>
          <label key={key}>{label}<input value={integration[key] || ''} onChange={event => setIntegration({ ...integration, [key]: event.target.value })} /></label>)}
      </fieldset>
      <p>Data transport: authenticated Agent Server command bridge → local FastAPI HTTP server. Host API 1 does not expose a sidecar HTTP proxy; board traffic still uses the command endpoint.</p>
      <p>Credentials stay on the backend. Enter file paths, never secret values. Missing integrations do not prevent manual board use.</p>
      <label><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} /> I approve the described downloads, private files and background process.</label>
      <div className="backend-actions">
        <button disabled={!approved || busy || installing} onClick={() => perform(() => api.install(integration))}>{status?.installed ? 'Repair / update backend' : 'Install backend'}</button>
        <button disabled={busy || installing || !status?.installed || status?.running} onClick={() => perform(() => api.start())}>Start backend</button>
        <button disabled={busy || installing || !status?.running} onClick={() => perform(() => api.stop())}>Stop backend</button>
        <button disabled={busy} onClick={() => perform()}>Recheck</button>
      </div>
      {installing && <p role="status">Installing backend… You may leave this view; installation continues on the Agent Server.</p>}
      {status?.legacy_present && <section aria-label="Legacy board migration">
        <h2>{migrationNeeded ? 'Migrate your existing board' : 'Legacy migration'}</h2>
        <p>Close every older Kanban App tab first. Migration pauses existing manager automations, waits for active runs/managers to finish, backs up JSON and SQLite, then imports both supported JSON layouts with IDs, entries, settings and attachments intact. It redirects manager CLIs and refreshes automation packages before restoring their enabled states. Original board files remain for recovery.</p>
        <label><input type="checkbox" checked={migrationApproved} onChange={event => setMigrationApproved(event.target.checked)} /> Old tabs are closed; I approve pausing managers and migrating this board.</label>
        <button disabled={!migrationApproved || busy || !status?.running} onClick={() => perform(() => api.request('/api/runtime', 'POST', { action: 'migrate', confirmed: true }))}>Migrate / finish cutover</button>
        {runtime?.imports?.map(item => <p key={item.source}>Imported {item.workspaces} workspaces, {item.tickets} tickets, {item.attachments} attachments. Backup: {item.backup}</p>)}
      </section>}
      <details><summary>Agent-assisted setup</summary><pre>{`Set up Kanban Manager on the selected Agent Server. Read its App README. Verify Python 3.10+, venv, SQLite, and the Agent Server / Automation URLs. Configure private server-side credential file paths under ${status?.data_dir || '<agent-server-home>/.openhands/apps/kanban-manager'}/integration.json. Do not expose credentials to the browser. Explain and obtain approval before system-level changes. Preserve existing data and coordinate legacy writers before migration.`}</pre></details>
      {status?.running && !migrationNeeded && <button onClick={() => setSetup(false)}>Open board</button>}
    </section> : <Board host={host} context={context} />}
  </div>;
}

export function activate(host) {
  if (host.apiVersion !== '1') throw new Error('Kanban Manager requires Canvas host API 1');
  return host.registerPage('board', context => {
    const root = createRoot(context.container);
    root.render(<App host={host} context={context} />);
    return () => root.unmount();
  });
}
