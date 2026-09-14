import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import xtermStyles from "@xterm/xterm/css/xterm.css?inline";
import terminalStyles from "./terminal.css?inline";

export type ServerMessage =
  | { type: "ready"; cwd: string }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number; signal?: number }
  | { type: "error"; message: string }
  | { type: "pong" };

type AccessTokenResponse = {
  token: string;
  expires_at: string;
};

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

function endpoint(sidecarUrl: string, path: string): URL {
  return new URL(path, `${sidecarUrl.replace(/\/$/, "")}/`);
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

export function mountBundledTerminal(
  container: HTMLElement,
  sidecarUrl: string,
  apiKey: string,
  backendId: string,
): () => void {
  const shadow = container.attachShadow({ mode: "open" });
  const style = node("style");
  style.textContent = `${xtermStyles}\n${terminalStyles}`;
  const app = node("main", "terminal-app");
  const surface = node("div", "terminal-app__surface");
  surface.setAttribute("aria-label", "Terminal session");
  const errorRegion = node("div", "terminal-app__error");
  errorRegion.setAttribute("role", "alert");
  errorRegion.setAttribute("aria-live", "assertive");
  errorRegion.hidden = true;
  app.append(surface, errorRegion);
  shadow.append(style, app);

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

  const abortController = new AbortController();
  let socket: WebSocket | undefined;
  let key = apiKey;
  apiKey = "";
  let authenticated = false;
  let disposed = false;

  const showError = (message = ""): void => {
    errorRegion.textContent = message;
    errorRegion.hidden = message.length === 0;
  };
  const send = (payload: object): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  };

  const dataSubscription = terminal.onData((data) => {
    if (authenticated) send({ type: "input", data });
  });
  const resizeSubscription = terminal.onResize(({ cols, rows }) => {
    if (authenticated) send({ type: "resize", cols, rows });
  });
  const resizeObserver = new ResizeObserver(() => {
    try { fitAddon.fit(); } catch { /* temporarily hidden mount */ }
  });
  resizeObserver.observe(surface);

  async function connect(): Promise<void> {
    try {
      const tokenResponse = await fetch(endpoint(sidecarUrl, "api/access-token"), {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extension: "backend-terminal", backend_id: backendId }),
        signal: abortController.signal,
      });
      if (!tokenResponse.ok) throw new Error(`Capability request failed (HTTP ${tokenResponse.status}).`);
      const tokenBody: unknown = await tokenResponse.json();
      if (!isAccessTokenResponse(tokenBody)) throw new Error("Sidecar returned an invalid capability.");
      if (disposed) return;

      const terminalUrl = endpoint(sidecarUrl, "api/terminal");
      terminalUrl.protocol = terminalUrl.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(terminalUrl);
      socket.addEventListener("open", () => {
        send({ type: "auth", token: tokenBody.token, api_key: key, cols: terminal.cols, rows: terminal.rows });
        key = "";
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
        key = "";
        authenticated = false;
        if (!disposed && event.code !== 1000) showError(`Disconnected: ${event.reason || `code ${event.code}`}`);
      });
      socket.addEventListener("error", () => {
        key = "";
        if (!disposed) showError("WebSocket connection failed.");
      });
    } catch (error) {
      key = "";
      if (disposed || abortController.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Sidecar connection failed.";
      terminal.writeln(`\x1b[31m${message}\x1b[0m`);
      showError(message);
    }
  }

  void connect();
  return () => {
    disposed = true;
    key = "";
    abortController.abort();
    authenticated = false;
    resizeObserver.disconnect();
    dataSubscription.dispose();
    resizeSubscription.dispose();
    socket?.close(1000, "view closed");
    terminal.dispose();
    shadow.replaceChildren();
    container.replaceChildren();
  };
}
