# Backend Terminal

Backend Terminal is an **App for Agent Canvas** with a sidecar-served SPA and a real PTY shell on the sidecar host. The checked-in Canvas `extension.js` embeds a checksummed sidecar artifact and onboarding UI; the installed sidecar serves the terminal frontend and carries input, output, resize, and lifecycle events over WebSocket.

## Architecture

1. Canvas Blob-imports the self-contained `extension.js` and mounts the Terminal page.
2. The extension embeds the configured sidecar SPA in a sandboxed iframe bound to the exact Canvas parent origin.
3. The extension resolves `openhands-active-backend` against `openhands-backends` in Canvas-owned localStorage, then the SPA requests that active local backend key from its exact parent window and a short-lived, one-use capability from its own origin.
4. The SPA opens `/api/terminal` and sends both values only in its first WebSocket message.
5. The sidecar validates the key live against its loopback Agent Server, then spawns a PTY. Closing the socket kills the shell.

The Canvas extension still targets manifest schema 1 and host API 1. The PTY transport is deliberately outside host API 1 because that contract has no interactive terminal channel.

## Build and verify

Use a supported even-numbered Node release (Node 22 or 24 recommended).

```sh
npm ci
npx playwright install chromium
npm run check
```

To exercise a clean install, pinned npm dependency installation, daemon startup, versioned health, and cleanup in a temporary backend home:

```sh
npm run smoke:install
```


The build emits:

- `extension.js`: self-contained Canvas entrypoint, copied from `dist/extension.js`.
- `sidecar-dist/public/`: Vite SPA with xterm.js.
- `sidecar-dist/server/`: Node HTTP, WebSocket, and PTY backend.

`npm run check` performs strict type checking, 27 unit/integration tests including first-run UI provisioning, localStorage selection, non-root startup, live key validation, and a real PTY session, all builds, Canvas static validation, and two Chromium smoke tests. The additional networked clean-install integration test is opt-in through `npm run smoke:install`.


## First-run local provisioning

Opening the App first performs a read-only probe through the active local backend's authenticated Agent Server. A healthy matching sidecar opens directly into the terminal. A missing or incompatible runtime shows a setup view instead of loading a failing iframe.

After explicit confirmation, **Install and start** safely stops a prior PID-file-owned App sidecar, writes the bundled, per-file SHA-256-verified runtime to `<backend-home>/.openhands/apps/backend-terminal`, runs `npm ci --omit=dev` against the pinned production lockfile, and launches a process as the same operating-system user that runs the Agent Server command. A compatible stopped runtime presents a separate **Start sidecar** action and does not reinstall. The App waits for versioned health before loading the terminal iframe.

Provisioning requires a local backend with Python 3 for the read-only probe, Node.js 18+, npm, and the native build prerequisites needed by `node-pty` on Linux. It does not require root. The runtime directory, daemon, and PTYs use the current backend user's home and permissions; if the Agent Server itself runs as root, those inherited permissions are still root. Installing or enabling the Canvas App never mutates the backend by itself; only the explicit setup button does. App removal, sidecar stopping, runtime deletion, and log deletion remain separate operator actions. Logs and PID state live under the runtime directory.

## Run the sidecar

```sh
npm run build
npm start
```

The server runs with the current process user's identity, listens on `http://127.0.0.1:18080`, and starts shells in `TERMINAL_CWD` (the current user's home by default). Local HTTP Canvas sessions use a hostname-matched direct loopback URL. Hosted Canvas sessions use `<canvas-origin>/terminal-sidecar`, which should be an authenticated reverse-proxy path to port 18080. The frontend is an edge-to-edge terminal with a connection-error strip and no runtime configuration controls.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TERMINAL_HOST` | `127.0.0.1` | Sidecar bind host. |
| `TERMINAL_PORT` | `18080` | Sidecar port. |
| `TERMINAL_ALLOWED_ORIGINS` | local Canvas origins on port 8000 | Comma-separated exact Canvas origins allowed to embed the SPA and send validated status messages. |
| `TERMINAL_AGENT_SERVER_URL` | `http://127.0.0.1:18000` | Loopback Agent Server origin used to validate `X-Session-API-Key`. Non-loopback hosts are rejected. |
| `TERMINAL_AGENT_SERVER_TIMEOUT_MS` | `3000` | Live API-key validation timeout. |
| `TERMINAL_CWD` | sidecar user home | Initial shell directory. |
| `TERMINAL_SHELL` | `$SHELL` or `/bin/bash` | PTY executable. |
| `TERMINAL_SHELL_ARGS` | `["-l"]` | JSON array of shell arguments. |
| `TERMINAL_MAX_SESSIONS` | `4` | Concurrent PTY limit. |
| `TERMINAL_IDLE_TIMEOUT_MS` | `1800000` | Idle session timeout. |
| `TERMINAL_TOKEN_TTL_MS` | `30000` | One-use capability lifetime. |
| `TERMINAL_ALLOW_REMOTE` | unset | Must be exactly `true` before binding beyond loopback. |

For a remote browser, prefer an authenticated TLS reverse proxy on the backend host while keeping the sidecar bound to loopback; `/terminal-sidecar/` is the intended hosted path. Set the exact Canvas origin in `TERMINAL_ALLOWED_ORIGINS`. Only when the proxy itself is on another machine should you deliberately use `TERMINAL_HOST=0.0.0.0 TERMINAL_ALLOW_REMOTE=true`, and the raw port must still remain inaccessible to untrusted networks.

### User identity

Run the sidecar as the ordinary account whose files and processes the terminal should access. The sidecar does not elevate privileges or switch users: every PTY inherits the sidecar process identity, environment allow-list, and `TERMINAL_CWD`. Prefer a dedicated least-privileged account for managed deployments. If the sidecar or Agent Server command runner is root, terminal sessions will still have unrestricted root authority over the host.


## Install in Agent Canvas

In **Customize → Apps**, add this backend-visible source:

```text
/root/git/canvas-app-terminal
```

Installation leaves trusted code disabled. Review the source and enable it, then open **Backend Terminal**. Reinstall with force after rebuilding because Canvas installs a copy rather than running the source tree directly.

## Security model

This app intentionally grants an interactive shell with the operating-system permissions of the sidecar process.

- The server binds to loopback by default and refuses remote binds without explicit opt-in.
- Capability issuance requires a same-origin browser fetch from the sidecar SPA; WebSocket upgrades require the exact sidecar host origin.
- The extension reads the selected local backend key only from Canvas-owned `openhands-active-backend` and `openhands-backends` localStorage records, then sends it only to the exact iframe window/origin. The SPA keeps it in memory until the WebSocket authentication frame; the sidecar never persists or logs it and never passes it to the PTY environment.
- The sidecar accepts a key only after a successful authenticated request to the configured loopback Agent Server, and it starts no PTY before that validation succeeds.
- Capabilities are random, short-lived, one-use, bounded in number, and never placed in URLs.
- WebSocket payloads, terminal dimensions, concurrent sessions, and idle lifetime are bounded.
- PTYs are killed when sockets close and during graceful sidecar shutdown.
- Only a small allow-list of non-secret process environment variables reaches the shell.
- The SPA uses a restrictive CSP and iframe embedding allow-list.

Origin checks and one-use capabilities are not a substitute for network authentication. Remote deployments require TLS and authentication at the reverse proxy.
