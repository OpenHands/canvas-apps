# Backend Terminal

Backend Terminal is an **App for Agent Canvas** with a sidecar-served SPA and a real PTY shell on the sidecar host. The checked-in Canvas `extension.js` embeds the SPA; the sidecar serves the frontend and carries terminal input, output, resize, and lifecycle events over WebSocket.

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

The build emits:

- `extension.js`: self-contained Canvas entrypoint, copied from `dist/extension.js`.
- `sidecar-dist/public/`: Vite SPA with xterm.js.
- `sidecar-dist/server/`: Node HTTP, WebSocket, and PTY backend.

`npm run check` performs strict type checking, 18 unit/integration tests including localStorage selection, root enforcement, live key validation, and a real PTY session, all builds, Canvas static validation, and two Chromium smoke tests.

## Run the sidecar

```sh
npm run build
npm start
```

The server refuses to start outside a root process by default, listens on `http://127.0.0.1:18080`, and starts shells in root's home directory. Local HTTP Canvas sessions use a hostname-matched direct loopback URL. Hosted Canvas sessions use `<canvas-origin>/terminal-sidecar`, which should be an authenticated reverse-proxy path to port 18080. The frontend is an edge-to-edge terminal with a connection-error strip and no runtime configuration controls.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TERMINAL_HOST` | `127.0.0.1` | Sidecar bind host. |
| `TERMINAL_PORT` | `18080` | Sidecar port. |
| `TERMINAL_ALLOWED_ORIGINS` | local Canvas origins on port 8000 | Comma-separated exact Canvas origins allowed to embed the SPA and send validated status messages. |
| `TERMINAL_AGENT_SERVER_URL` | `http://127.0.0.1:18000` | Loopback Agent Server origin used to validate `X-Session-API-Key`. Non-loopback hosts are rejected. |
| `TERMINAL_AGENT_SERVER_TIMEOUT_MS` | `3000` | Live API-key validation timeout. |
| `TERMINAL_REQUIRE_ROOT` | `true` | Refuse startup unless the sidecar can create root PTYs. Set `false` only in isolated development/tests. |
| `TERMINAL_CWD` | sidecar user home | Initial shell directory. |
| `TERMINAL_SHELL` | `$SHELL` or `/bin/bash` | PTY executable. |
| `TERMINAL_SHELL_ARGS` | `["-l"]` | JSON array of shell arguments. |
| `TERMINAL_MAX_SESSIONS` | `4` | Concurrent PTY limit. |
| `TERMINAL_IDLE_TIMEOUT_MS` | `1800000` | Idle session timeout. |
| `TERMINAL_TOKEN_TTL_MS` | `30000` | One-use capability lifetime. |
| `TERMINAL_ALLOW_REMOTE` | unset | Must be exactly `true` before binding beyond loopback. |

For a remote browser, prefer an authenticated TLS reverse proxy on the backend host while keeping the sidecar bound to loopback; `/terminal-sidecar/` is the intended hosted path. Set the exact Canvas origin in `TERMINAL_ALLOWED_ORIGINS`. Only when the proxy itself is on another machine should you deliberately use `TERMINAL_HOST=0.0.0.0 TERMINAL_ALLOW_REMOTE=true`, and the raw port must still remain inaccessible to untrusted networks.

### Root deployment

Run the sidecar service as `root` and set `HOME=/root`, `USER=root`, `LOGNAME=root`, and `TERMINAL_CWD=/root` only when full machine administration is the intended product behavior. Do not apply systemd filesystem or capability restrictions that contradict that requirement. Keep the listener on loopback and require authenticated TLS proxying: a terminal session has unrestricted root authority over the host, including the ability to inspect other processes.


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
