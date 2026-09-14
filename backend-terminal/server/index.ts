import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import express from "express";
import * as pty from "node-pty";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig, type SidecarConfig } from "./config.js";
import { validateAgentServerKey } from "./agent-server-auth.js";
import { CapabilityStore } from "./tokens.js";

export const SIDECAR_VERSION = "0.3.0";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const SHELL_ENV_KEYS = ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "LC_ALL", "TMPDIR"] as const;

type ClientMessage =
  | { type: "auth"; token: string; api_key: string; cols?: number; rows?: number }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" };

export type RunningSidecar = {
  server: Server;
  port: number;
  close(): Promise<void>;
};

function isSidecarOrigin(rawOrigin: string | undefined, rawHost: string | undefined): boolean {
  if (!rawOrigin || !rawHost) return false;
  try {
    const origin = new URL(rawOrigin);
    return (origin.protocol === "http:" || origin.protocol === "https:") && origin.host === rawHost;
  } catch {
    return false;
  }
}

function validSize(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= 2 && Number(value) <= maximum;
}

function parseMessage(raw: Buffer): ClientMessage | null {
  try {
    const value: unknown = JSON.parse(raw.toString("utf8"));
    if (typeof value !== "object" || value === null || !("type" in value)) return null;
    return value as ClientMessage;
  } catch {
    return null;
  }
}

function shellEnvironment(config: SidecarConfig): Record<string, string> {
  const env: Record<string, string> = { TERM: "xterm-256color", COLORTERM: "truecolor" };
  for (const key of SHELL_ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.SHELL = config.shell;
  return env;
}

export async function startSidecar(config = loadConfig()): Promise<RunningSidecar> {
  if (config.requireRoot && (typeof process.getuid !== "function" || process.getuid() !== 0)) {
    throw new Error("Backend Terminal must run as root. Set TERMINAL_REQUIRE_ROOT=false only for development and tests.");
  }
  if (!LOOPBACK_HOSTS.has(config.host) && process.env.TERMINAL_ALLOW_REMOTE !== "true") {
    throw new Error("Refusing a non-loopback bind. Set TERMINAL_ALLOW_REMOTE=true only behind an authenticated TLS proxy.");
  }

  const app = express();
  const capabilities = new CapabilityStore(config.tokenTtlMs);
  const sessions = new Set<WebSocket>();
  const processes = new Map<WebSocket, pty.IPty>();
  const contentSecurityPolicy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    `frame-ancestors ${[...config.allowedOrigins].join(" ")}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  app.disable("x-powered-by");
  app.use((_, response, next) => {
    response.setHeader("Content-Security-Policy", contentSecurityPolicy);
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(express.json({ limit: "16kb", strict: true }));

  app.get("/api/health", (_, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ status: "ok", version: SIDECAR_VERSION, sessions: sessions.size, max_sessions: config.maxSessions });
  });

  app.post("/api/access-token", (request, response) => {
    const origin = request.get("origin");
    const sameSiteRequest = request.get("sec-fetch-site") === "same-origin" && isSidecarOrigin(origin, request.get("host"));
    if (!sameSiteRequest) {
      response.status(403).json({ error: "same_origin_required" });
      return;
    }
    const body: unknown = request.body;
    if (
      typeof body !== "object" || body === null ||
      !("extension" in body) || body.extension !== "backend-terminal" ||
      !("backend_id" in body) || typeof body.backend_id !== "string" || body.backend_id.length > 256
    ) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }
    const issued = capabilities.issue({ extension: body.extension, backendId: body.backend_id });
    if (!issued) {
      response.status(429).json({ error: "too_many_pending_tokens" });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.json({ token: issued.token, expires_at: new Date(issued.expiresAt).toISOString() });
  });

  if (existsSync(config.publicDir)) {
    app.use(express.static(config.publicDir, { etag: true, index: "index.html", maxAge: 0 }));
    app.use((request, response, next) => {
      if (request.method !== "GET" || request.path.startsWith("/api/")) {
        next();
        return;
      }
      response.sendFile(resolve(config.publicDir, "index.html"));
    });
  }

  const server = createServer(app);
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://sidecar.invalid").pathname;
    if (pathname !== "/api/terminal" || !isSidecarOrigin(request.headers.origin, request.headers.host)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (sessions.size >= config.maxSessions) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 5\r\n\r\n");
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => webSocketServer.emit("connection", webSocket, request));
  });

  webSocketServer.on("connection", (webSocket) => {
    sessions.add(webSocket);
    let terminal: pty.IPty | undefined;
    let authenticated = false;
    let authenticating = false;
    let closed = false;
    let idleTimer: ReturnType<typeof setTimeout>;
    const closeSession = (): void => {
      if (closed) return;
      closed = true;
      clearTimeout(idleTimer);
      sessions.delete(webSocket);
      processes.delete(webSocket);
      try { terminal?.kill(); } catch { /* already exited */ }
    };
    const refreshIdleTimer = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => webSocket.close(1000, "idle timeout"), config.idleTimeoutMs);
      idleTimer.unref();
    };
    const authTimer = setTimeout(
      () => webSocket.close(1008, "authentication timeout"),
      config.agentServerTimeoutMs + 2_000,
    );
    authTimer.unref();
    refreshIdleTimer();

    webSocket.on("message", async (data, isBinary) => {
      refreshIdleTimer();
      if (isBinary || !Buffer.isBuffer(data)) {
        webSocket.close(1003, "text JSON messages required");
        return;
      }
      const message = parseMessage(data);
      if (!message) {
        webSocket.close(1003, "invalid message");
        return;
      }
      if (!authenticated) {
        if (authenticating) {
          webSocket.close(1008, "authentication already in progress");
          return;
        }
        if (
          message.type !== "auth" ||
          typeof message.token !== "string" ||
          typeof message.api_key !== "string" ||
          !capabilities.consume(message.token)
        ) {
          webSocket.close(1008, "invalid authentication");
          return;
        }
        if ((message.cols !== undefined && !validSize(message.cols, 500)) || (message.rows !== undefined && !validSize(message.rows, 300))) {
          webSocket.close(1008, "invalid terminal size");
          return;
        }
        authenticating = true;
        const validKey = await validateAgentServerKey(config.agentServerUrl, message.api_key, config.agentServerTimeoutMs);
        if (closed || webSocket.readyState !== WebSocket.OPEN) return;
        if (!validKey) {
          webSocket.close(1008, "invalid Agent Server API key");
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);
        try {
          terminal = pty.spawn(config.shell, config.shellArgs, {
            name: "xterm-256color",
            cols: message.cols ?? 100,
            rows: message.rows ?? 30,
            cwd: config.cwd,
            env: shellEnvironment(config),
          });
          processes.set(webSocket, terminal);
          terminal.onData((output) => {
            if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify({ type: "output", data: output }));
          });
          terminal.onExit(({ exitCode, signal }) => {
            if (webSocket.readyState === WebSocket.OPEN) {
              webSocket.send(JSON.stringify({ type: "exit", exitCode, signal }));
              webSocket.close(1000, "shell exited");
            }
          });
          webSocket.send(JSON.stringify({ type: "ready", cwd: config.cwd }));
        } catch (error) {
          const messageText = error instanceof Error ? error.message : "PTY spawn failed";
          webSocket.send(JSON.stringify({ type: "error", message: messageText }));
          webSocket.close(1011, "PTY spawn failed");
        }
        return;
      }

      if (!terminal) return;
      if (message.type === "input" && typeof message.data === "string") {
        terminal.write(message.data);
      } else if (message.type === "resize" && validSize(message.cols, 500) && validSize(message.rows, 300)) {
        terminal.resize(message.cols, message.rows);
      } else if (message.type === "ping") {
        webSocket.send(JSON.stringify({ type: "pong" }));
      } else {
        webSocket.close(1003, "unsupported message");
      }
    });
    webSocket.on("close", closeSession);
    webSocket.on("error", closeSession);
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Sidecar did not bind a TCP port.");

  return {
    server,
    port: address.port,
    async close() {
      for (const webSocket of sessions) webSocket.close(1001, "sidecar shutting down");
      for (const terminal of processes.values()) {
        try { terminal.kill(); } catch { /* already exited */ }
      }
      webSocketServer.close();
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    },
  };
}

async function main(): Promise<void> {
  const running = await startSidecar();
  console.log(`Backend Terminal sidecar listening on http://${loadConfig().host}:${running.port}`);
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void running.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
