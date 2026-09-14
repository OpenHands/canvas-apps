import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

type ServerMessage =
  | { type: "ready"; cwd: string }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number; signal?: number }
  | { type: "error"; message: string }
  | { type: "pong" };

type AccessTokenResponse = {
  token: string;
  expires_at: string;
};

type CredentialsMessage =
  | { type: "backend-terminal:credentials"; requestId: string; apiKey: string }
  | { type: "backend-terminal:credentials-error"; requestId: string; message: string };

function expectedCanvasOrigin(): string {
  const raw = new URLSearchParams(location.search).get("canvas_origin");
  if (!raw) throw new Error("Missing Canvas parent origin.");
  const url = new URL(raw);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== raw) {
    throw new Error("Invalid Canvas parent origin.");
  }
  return url.origin;
}

function requestBackendApiKey(canvasOrigin: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const requestId = crypto.randomUUID();
    let timeout = 0;
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== parent || event.origin !== canvasOrigin || typeof event.data !== "object" || event.data === null) return;
      const message = event.data as Partial<CredentialsMessage>;
      if (message.requestId !== requestId) return;
      if (message.type === "backend-terminal:credentials" && typeof message.apiKey === "string" && message.apiKey.length >= 8) {
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolvePromise(message.apiKey);
      } else if (message.type === "backend-terminal:credentials-error") {
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        reject(new Error(typeof message.message === "string" ? message.message : "Canvas credential request failed."));
      }
    };
    timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Canvas credential request timed out."));
    }, 5_000);
    window.addEventListener("message", onMessage);
    parent.postMessage({ type: "backend-terminal:credentials-request", requestId }, canvasOrigin);
  });
}

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing SPA root element.");

app.innerHTML = `
  <main class="terminal-app">
    <div class="terminal-app__surface" aria-label="Terminal session"></div>
    <div class="terminal-app__error" role="alert" aria-live="assertive" hidden></div>
  </main>
`;

function required<T extends Element>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`Missing SPA element: ${selector}`);
  return node;
}

const surface = required<HTMLElement>(app, ".terminal-app__surface");
const errorRegion = required<HTMLElement>(app, ".terminal-app__error");
const canvasOrigin = expectedCanvasOrigin();
const terminal = new Terminal({
  allowProposedApi: false,
  cursorBlink: true,
  cursorStyle: "block",
  convertEol: false,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: 14,
  lineHeight: 1.2,
  scrollback: 10_000,
  theme: {
    background: "#06090d",
    foreground: "#e6edf5",
    cursor: "#5eead4",
    selectionBackground: "#31435a",
    black: "#111827",
    red: "#fb7185",
    green: "#86efac",
    yellow: "#fde047",
    blue: "#93c5fd",
    magenta: "#d8b4fe",
    cyan: "#67e8f9",
    white: "#f8fafc",
  },
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(surface);
fitAddon.fit();
terminal.focus();

let socket: WebSocket | undefined;
let authenticated = false;
let disposed = false;

function showError(message = ""): void {
  errorRegion.textContent = message;
  errorRegion.hidden = message.length === 0;
}

function parseMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== "string") return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("type" in value)) return null;
    return value as ServerMessage;
  } catch {
    return null;
  }
}

function isAccessTokenResponse(value: unknown): value is AccessTokenResponse {
  return (
    typeof value === "object" && value !== null &&
    "token" in value && typeof value.token === "string" && value.token.length >= 32 &&
    "expires_at" in value && typeof value.expires_at === "string"
  );
}

function send(payload: object): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

async function connect(): Promise<void> {
  try {
    let apiKey = await requestBackendApiKey(canvasOrigin);
    const tokenResponse = await fetch("./api/access-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extension: "backend-terminal", backend_id: "sidecar-spa" }),
    });
    if (!tokenResponse.ok) throw new Error(`Capability request failed (HTTP ${tokenResponse.status}).`);
    const tokenBody: unknown = await tokenResponse.json();
    if (!isAccessTokenResponse(tokenBody)) throw new Error("Sidecar returned an invalid capability.");

    const terminalUrl = new URL("./api/terminal", location.href);
    terminalUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(terminalUrl);
    socket.addEventListener("open", () => {
      send({ type: "auth", token: tokenBody.token, api_key: apiKey, cols: terminal.cols, rows: terminal.rows });
      apiKey = "";
    });
    socket.addEventListener("message", (event) => {
      const message = parseMessage(event.data);
      if (!message) {
        terminal.writeln("\r\n\x1b[31m[sidecar sent an invalid message]\x1b[0m");
        return;
      }
      if (message.type === "ready") {
        authenticated = true;
        showError();
        parent.postMessage({ type: "backend-terminal:ready" }, canvasOrigin);
        terminal.focus();
      } else if (message.type === "output") {
        terminal.write(message.data);
      } else if (message.type === "exit") {
        terminal.writeln(`\r\n\x1b[90m[process exited with code ${message.exitCode}]\x1b[0m`);
      } else if (message.type === "error") {
        terminal.writeln(`\r\n\x1b[31m[${message.message}]\x1b[0m`);
        showError(message.message);
      }
    });
    socket.addEventListener("close", (event) => {
      apiKey = "";
      authenticated = false;
      if (disposed || event.code === 1000) return;
      showError(`Disconnected: ${event.reason || `code ${event.code}`}`);
    });
    socket.addEventListener("error", () => {
      apiKey = "";
      showError("WebSocket connection failed.");
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sidecar connection failed.";
    terminal.writeln(`\x1b[31m${message}\x1b[0m`);
    showError(message);
    parent.postMessage({ type: "backend-terminal:error", message }, canvasOrigin);
  }
}

terminal.onData((data) => {
  if (authenticated) send({ type: "input", data });
});
terminal.onResize(({ cols, rows }) => {
  if (authenticated) send({ type: "resize", cols, rows });
});

const resizeObserver = new ResizeObserver(() => {
  try { fitAddon.fit(); } catch { /* hidden iframe */ }
});
resizeObserver.observe(surface);

window.addEventListener("beforeunload", () => {
  disposed = true;
  resizeObserver.disconnect();
  socket?.close(1000, "view closed");
  terminal.dispose();
});

void connect();
