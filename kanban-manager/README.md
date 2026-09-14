# Kanban Manager

An App for Agent Canvas: queue requests, let a manager dispatch workers, watch
live progress, and review finished work. The React App has an installable
**FastAPI sidecar** and a shared **SQLite** database on the selected Agent Server.

The existing board interactions, workspace settings, manager chat, attachments,
agent budgets, light/dark themes and ten primary palettes are preserved.

## Install and onboard

In Agent Canvas, use **Add app** with:

- App source: `github:DevinVinson/canvas-apps`
- Repository path: `kanban-manager`
- Ref: the release/branch containing this version

Enable the trusted App, then open **Kanban Manager**. Its route is still
`/extensions/kanban-manager/board`; `/<workspace-name>` opens a project directly.
Installation and enablement are separate. Fresh installation does not start the
backend or run an installer.

The first view performs a read-only probe. Python 3.10+ with `venv`, pip and
standard-library SQLite must be available on the **Agent Server machine**.
The sidecar supports POSIX hosts (Linux/macOS); it is not a Windows service.
If prerequisites are missing, use the displayed agent-assisted setup prompt
rather than allowing the App to guess a system package manager.

### Backend setup

The App explains the package checksum, private data directory, dependency
downloads and background process. After acknowledgment, **Install backend**:

1. Verifies the bundled backend archive's SHA-256 and extracts an immutable
   release under `~/.openhands/apps/kanban-manager/releases/<sha256>/`.
2. Runs `python3 -m venv <app-data>/venv`.
3. Runs `<app-data>/venv/bin/python -m pip --isolated install --index-url
   https://pypi.org/simple -r <release>/requirements.txt` with pinned FastAPI,
   Uvicorn, HTTPX and websockets versions. Nothing is installed globally.
4. Starts FastAPI on a random loopback-only port with a random bearer token.

Setup is asynchronous and reports progress on **Recheck**. **Repair / update
backend** installs new packaged code/dependencies without deleting the database,
attachments or backups. **Start backend**, **Stop backend**, and **Recheck** are
separate controls. Installation is serialized across tabs.

The backend stays running after browser closure or App disablement so scheduled
managers still have a board. No systemd/launchd service is installed. After a
host restart, use **Start backend**; managers cannot access the board while the
sidecar is stopped. Logs live at `install.log` and `service.log` in App data.

### Integration configuration

Supply deployment-specific **Agent Server URL** and **Automation API URL**
(including its `/api/automation` prefix). These are different services; the App
does not infer them from the Canvas browser origin or assume an ingress proxy.
The Agent Server URL may be suggested from the backend's `AGENT_SERVER_URL`.

Credentials are read only on the backend. Enter absolute credential **file
paths**, never keys, in the setup form. Alternatively the backend can inherit
`SESSION_API_KEY` / `OH_SESSION_API_KEYS_0` and
`OPENHANDS_AUTOMATION_API_KEY`. Configuration persists as private
`integration.json`; the browser never receives credential values or the
sidecar's bearer token. Empty integrations still permit manual board use.

The portable host API has no custom-backend proxy. The App instead discovers
`/api/file/home` and sends fixed, structured base64/JSON commands through the
existing authenticated `/api/bash/execute_bash_command` endpoint. A local
allowlisted HTTP bridge talks to FastAPI. User text never becomes shell source.
There are **no agent-server file-API board reads/writes**. Attachment uploads and
downloads use 32 KiB chunks to stay within command/response limits and preserve
binary bytes; files remain capped at 25 MiB.

## Existing boards and migration

Old Canvas boards are detected at `~/.openhands/vibe-manager/`. The App will not
silently open an empty replacement board when that store exists.

Close every older Kanban App tab, approve migration, and choose **Migrate /
finish cutover**. This pauses the existing automations, waits for active runs
and manager conversations to finish, backs up source documents and destination
SQLite, then imports either `board.json` or per-ticket files transactionally.
Workspace/ticket/entry/attachment IDs, timestamps, settings, ordering,
conversation links and automation IDs are preserved. Unknown fields are retained
in SQLite's `legacy_records` table. Missing attachments or conflicting IDs stop
the migration rather than silently discarding data.

Manager CLIs are redirected to the sidecar, automation tarballs are refreshed,
and their original enabled/disabled states are restored. A busy run returns an
instruction to wait and retry; it is not forcibly terminated. Failures retain a
`cutover.json` checkpoint and leave managers paused until cutover is finished.

Original JSON and attachment files are not deleted. An unchanged migration is
idempotent and never overwrites newer SQLite edits. Late legacy writes trigger a
visible warning (checked every 30 seconds); reconcile those preserved records
before continuing. Do not reset the migration ledger or resume old JSON writers
after cutover. Backups are private and must never be committed or published.

The older standalone website has a **separate SQLite database**. This migration
does not overwrite or merge that database or alter its service. It remains
available for a separately planned import/cutover; conflicting independent
histories must not be silently combined.

## State and ownership

```text
<agent-server-home>/.openhands/apps/kanban-manager/
├── vibe.db                 # SQLite WAL: workspaces, tickets, entries, metadata
├── attachments/            # stable paths readable by workers on this host
├── backups/                # original documents and pre-import database
├── bin/<workspace-id>/     # manager CLI, isolated workspace configuration
├── releases/<sha256>/      # packaged Python backend and automation source
├── venv/                   # private Python dependencies
├── integration.json        # URLs and credential paths, not browser state
├── current.json            # selected backend release
├── run.json                # private PID/port/bearer token; never sent to browser
├── cutover.json            # migration checkpoint and automation enabled states
└── install.json, install.log, service.log
```

The App data root is mode 0700. Backend files inherit private permissions;
runtime/config state is mode 0600. App disable/uninstall does not remove this
persistent state. There is intentionally no one-click data deletion control.

## Development and verification

This is an independent package, not a shared Canvas runtime. React owns the App
and onboarding lifecycle; the mature board controller is mounted through a
React effect and fully disposed on unmount. `src/store.js`, `live.js`,
`manager.js` and `managerchat.js` are small backend API adapters.

```sh
npm ci
CHROME_PATH=/path/to/chrome npm run check
python backend/tests/test_sidecar.py
```

Build emits exactly one self-contained `dist/extension.js`, validates it, then
copies the verified artifact to checked-in `extension.js`. Dependencies, scoped
CSS, onboarding bootstrap and backend archive are embedded; no bare imports or
external runtime chunks are required. Python dependencies from
`backend/requirements.txt` must be available for the real-path tests. In the
source repository they live at the repository root instead of `backend/`.

Checks exercise activation/routes/disposal and the real fixed bridge → FastAPI
→ SQLite path. Chromium imports the actual artifact from a Blob URL and tests
submission, keyboard drawer access, appending entries and a multi-chunk binary
attachment. The only substituted boundary is Canvas's host interface; service
responses are not mocked. The source repository additionally tests migrations,
concurrent writes, authentication, restart persistence and legacy CLI routing.

Local acceptance: install this package from its absolute backend-local path,
enable, onboard, open the board, exercise a nested workspace route, reload,
disable/re-enable, and verify that the same data remains. Reinstall the UI and
use **Repair / update backend** after backend changes. Refresh existing manager
automation tarballs while preserving enabled states. Never restart Agent Server
just to deploy Kanban Manager; doing so interrupts worker conversations.
