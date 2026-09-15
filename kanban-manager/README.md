# Kanban Manager

An App for Agent Canvas: queue requests, let a manager dispatch workers, watch
live progress, and review finished work. The React App has an installable
**FastAPI sidecar** and a shared **SQLite** database on the selected Agent Server.

The existing board interactions, workspace settings, manager chat, attachments,
agent budgets, light/dark themes and ten primary palettes are preserved.

## Install and onboard

In Agent Canvas, use **Add app** with:

- App source: `github:OpenHands/canvas-apps`
- Repository path: `kanban-manager`
- Ref: the release/branch containing this version

Enable the trusted App, then open **Kanban Manager**. Its route is still
`/extensions/kanban-manager/board`; `/<workspace-name>` opens a project directly.
Installation and enablement are separate. Fresh installation does not start the
backend or run an installer.

The first view performs an authenticated, read-only HTTP readiness request.
A provisioned gateway and backend 0.3.2+ are required for board access. If the
gateway/backend is missing, choose **Backend setup** for the explicit lifecycle
probe and installation controls; no HTTP failure silently falls back to shell
data RPCs. Python 3.10+ with `venv`, pip and
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

### Instance-local manager skill

The generic manager discovers configured profiles using `vibectl.py profiles`,
then weighs capability, cost and task effort. Explicit user choices win. Without
an informed alternative, new workers use the Agent Server's active default;
follow-ups keep their current model. The App imposes no provider or model list.

An operator can put local model preferences and deployment conventions in
`~/.openhands/apps/kanban-manager/skills/manager/SKILL.md` (under the configured
`VIBE_SIDECAR_ROOT` when overridden). The backend loads this optional UTF-8 skill
into initial manager and manager-chat prompts, **not worker prompts**, when
creating those conversations. It does not change the manager chat's read-only board role. New
conversations read current content; existing conversations retain prior context
and follow-up messages stay unchanged.
Keep the file private and outside source checkouts; it is never included in App
packages or automation uploads. Do not put credentials in skill text.

`VIBE_MANAGER_SKILL_FILE` is a backend/operator environment override for another
file; an empty value disables the skill. An explicitly configured missing or
unreadable file fails rather than silently dropping policy. Skills are limited
to 64 Ki characters. Project files and browser requests cannot set this path.
No skill is required on other installations. The skill supplements live profile
discovery and cannot override user selections, budgets or security boundaries.

For the legacy standalone service, explicitly set `VIBE_AGENT_SERVER` (or
`AGENT_SERVER_URL`), `VIBE_AUTOMATION_API`, `VIBE_SELF_URL` and, when absolute
conversation links are needed, `VIBE_CANVAS_BASE`. There are no guessed service
ports or Canvas domains. `VIBE_CORS_ORIGINS` defaults only to the configured
Canvas URL, not arbitrary development origins. `VIBE_SESSION_KEY_FILE` and
`VIBE_AUTOMATION_KEY_FILE` specify server-side credential paths; inherited keys
are also supported. The service never searches a checkout for credentials.
Existing standalone database/data paths remain unchanged; moving those requires
an explicit migration. Operator-rendered systemd/nginx examples in the source
repository are not installed or shipped in the Canvas App.

### HTTP gateway contract (deployment prerequisite)

Board, settings, manager/chat, migration, readiness and attachment requests use
`host.agentServer.request({path: "/kanban-manager/api/...", method, body})`.
Canvas chooses the owning backend URL and supplies its session authentication;
the App does not read localStorage credentials, derive an origin, or receive the
sidecar bearer. **Normal mounting, polling and board operations execute no
shell commands.** Host API 1 still has no native sidecar proxy: this prefix is an
explicit deployment adapter, not an invented portable Canvas capability.

Select the **gateway-facing backend URL** configured by your operator in Canvas's
backend settings. Direct Agent Server ports and a frontend development server do
not inherently implement this route. A 401, missing route, HTML response, or
unavailable sidecar is a visible recoverable error. The App never bypasses
authentication or silently changes its data transport.

The operator-owned gateway must:

- authenticate `X-Session-API-Key` against the owning Agent Server before proxying
  (for example, nginx `auth_request` to protected `/api/file/home`;
  `/server_info` is public and is not an authentication check);
- strip the browser's session key and cookies, inject the private sidecar bearer
  server-side, and route only to its registered loopback listener;
- strip `/kanban-manager`, preserve methods/query strings/JSON bodies, support
  the API allowlist in `sidecar/runtime.py`, and reject credential-export and
  internal shutdown endpoints;
- maintain its upstream as the sidecar's port and bearer rotate. The operator
  must refresh the gateway after each sidecar start/repair, using their own
  deployment adapter. Gateway provisioning and service supervision are not part
  of the App installer.

See the [host request API](https://github.com/OpenHands/OpenHands/blob/main/src/types/canvas-extension.ts)
and [sidecar deployment contract](https://github.com/DevinVinson/skills/blob/main/skills/canvas-extension-api/references/sidecar-pattern.md).

Only explicit **Backend setup**, install/repair, start/stop and installation
progress use `/api/file/home` plus fixed base64/JSON commands through
`/api/bash/execute_bash_command`. User text never becomes shell source. Approved
package uploads use bounded 32 KiB base64 chunks (4 MiB encoded-package limit),
private staging, and SHA-256 verification before installation. Backend-owned
manager CLIs retain their local HTTP bridge for compatibility.

There are **no agent-server file-API board reads/writes**. The host request API
is JSON-oriented, so binary attachments use 32 KiB base64 chunks over HTTP;
`GET /api/attachments/<id>?offset=<byte-offset>` returns a chunk. Ordinary
requests without `offset` still return native files and support HTTP ranges for
the standalone website. Attachment size remains capped at 25 MiB.

Mount/reload waits for one validated HTTP readiness snapshot containing safe
installation metadata and migration status, showing neutral loading rather than
onboarding. Older installed backends can still be inspected and repaired through
the explicit lifecycle probe; update the backend and refresh the gateway before
opening the HTTP board. Installation, repair and migration never erase data.

Conversation clicks use Canvas's `/conversations/<id>` route, independent of the
configured absolute Canvas URL used for native modified/middle-click links.

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

Checks exercise activation/routes/disposal, real authenticated HTTP → FastAPI
→ SQLite data paths, and the separate fixed lifecycle helper. Chromium imports the actual artifact from a Blob URL and tests
submission, keyboard drawer access, appending entries and byte-for-byte HTTP
attachment round trips. Normal board tests assert zero command requests. The unavailable Canvas/gateway boundary is substituted only for routing and
server-side auth injection; service responses come from real HTTP. Corruption
regressions deliberately damage responses after the real service answers. The source repository additionally tests migrations,
concurrent writes, authentication, restart persistence and legacy CLI routing.

Local acceptance: install this package from its absolute backend-local path,
enable, onboard, open the board, exercise a nested workspace route, reload,
disable/re-enable, and verify that the same data remains. Reinstall the UI and
use **Repair / update backend** after backend changes, then refresh the gateway
and recheck HTTP readiness. Refresh existing manager
automation tarballs while preserving enabled states. Never restart Agent Server
just to deploy Kanban Manager; doing so interrupts worker conversations.
