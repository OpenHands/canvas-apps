// @vitest-environment node

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { startSidecar, type RunningSidecar } from "../../server/index.js";
import type { SidecarConfig } from "../../server/config.js";

const allowedOrigin = "http://localhost:8000";
const validApiKey = "integration-agent-server-key";
let agentServer: Server;
let running: RunningSidecar;
let baseUrl: string;

const config: SidecarConfig = {
  host: "127.0.0.1",
  port: 0,
  allowedOrigins: new Set([allowedOrigin]),
  agentServerUrl: "http://127.0.0.1:1",
  agentServerTimeoutMs: 1_000,
  requireRoot: false,
  cwd: process.cwd(),
  shell: "/bin/bash",
  shellArgs: ["--noprofile", "--norc"],
  tokenTtlMs: 30_000,
  maxSessions: 2,
  maxMessageBytes: 65_536,
  idleTimeoutMs: 60_000,
  publicDir: "/definitely-not-a-real-public-directory",
};

async function issueCapability(origin = baseUrl, fetchSite = "same-origin"): Promise<Response> {
  return fetch(`${baseUrl}/api/access-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "Sec-Fetch-Site": fetchSite },
    body: JSON.stringify({ extension: "backend-terminal", extension_version: "0.2.0", backend_id: "test" }),
  });
}

beforeAll(async () => {
  agentServer = createServer((request, response) => {
    if (request.url?.startsWith("/api/conversations/search") && request.headers["x-session-api-key"] === validApiKey) {
      response.writeHead(200, { "Content-Type": "application/json" }).end('{"items":[]}');
      return;
    }
    response.writeHead(401).end();
  });
  await new Promise<void>((resolvePromise) => agentServer.listen(0, "127.0.0.1", resolvePromise));
  const address = agentServer.address();
  if (!address || typeof address === "string") throw new Error("Fake Agent Server did not bind.");
  config.agentServerUrl = `http://127.0.0.1:${address.port}`;

  running = await startSidecar(config);
  baseUrl = `http://127.0.0.1:${running.port}`;
});

afterAll(async () => {
  await running.close();
  await new Promise<void>((resolvePromise, reject) => agentServer.close((error) => error ? reject(error) : resolvePromise()));
});

describe("PTY sidecar", () => {
  it("refuses to start outside a root runtime by default", async () => {
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(1_000);
    try {
      await expect(startSidecar({ ...config, requireRoot: true })).rejects.toThrow("must run as root");
    } finally {
      getuid.mockRestore();
    }
  });


  it("reports health and rejects cross-origin token issuance", async () => {
    const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
    expect(health).toEqual({ status: "ok", sessions: 0, max_sessions: 2 });

    const denied = await issueCapability("http://evil.example", "cross-site");
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({ error: "same_origin_required" });
  });

  it("rejects an invalid Agent Server key before starting a PTY", async () => {
    const response = await issueCapability();
    const body = await response.json() as { token: string };

    const result = await new Promise<{ code: number; ready: boolean }>((resolvePromise, reject) => {
      const webSocket = new WebSocket(`ws://127.0.0.1:${running.port}/api/terminal`, {
        headers: { Origin: baseUrl },
      });
      let ready = false;
      webSocket.on("open", () => webSocket.send(JSON.stringify({
        type: "auth",
        token: body.token,
        api_key: "invalid-agent-server-key",
      })));
      webSocket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string };
        if (message.type === "ready") ready = true;
      });
      webSocket.on("close", (code) => resolvePromise({ code, ready }));
      webSocket.on("error", reject);
    });

    expect(result).toEqual({ code: 1008, ready: false });
  });


  it("authenticates once and streams a real interactive PTY", async () => {
    const response = await issueCapability();
    expect(response.status).toBe(200);
    const body = await response.json() as { token: string };

    const output = await new Promise<string>((resolvePromise, reject) => {
      const webSocket = new WebSocket(`ws://127.0.0.1:${running.port}/api/terminal`, {
        headers: { Origin: baseUrl },
      });
      let transcript = "";
      const timeout = setTimeout(() => {
        webSocket.terminate();
        reject(new Error(`PTY integration timed out. Transcript: ${transcript}`));
      }, 10_000);

      webSocket.on("open", () => {
        webSocket.send(JSON.stringify({ type: "auth", token: body.token, api_key: validApiKey, cols: 90, rows: 24 }));
      });
      webSocket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; data?: string };
        if (message.type === "ready") {
          webSocket.send(JSON.stringify({ type: "input", data: "printf '__PTY_INTEGRATION_OK__\\n'; exit 7\n" }));
        } else if (message.type === "output") {
          transcript += message.data ?? "";
        }
      });
      webSocket.on("close", () => {
        clearTimeout(timeout);
        resolvePromise(transcript);
      });
      webSocket.on("error", reject);
    });

    expect(output).toContain("__PTY_INTEGRATION_OK__");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    const health = await fetch(`${baseUrl}/api/health`).then((healthResponse) => healthResponse.json()) as { sessions: number };
    expect(health.sessions).toBe(0);
  });

  it("rejects reuse of a consumed capability", async () => {
    const response = await issueCapability();
    const body = await response.json() as { token: string };

    const connect = (): Promise<number> => new Promise((resolvePromise, reject) => {
      const webSocket = new WebSocket(`ws://127.0.0.1:${running.port}/api/terminal`, {
        headers: { Origin: baseUrl },
      });
      webSocket.on("open", () => webSocket.send(JSON.stringify({ type: "auth", token: body.token, api_key: validApiKey })));
      webSocket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string };
        if (message.type === "ready") webSocket.close(1000, "test complete");
      });
      webSocket.on("close", (code) => resolvePromise(code));
      webSocket.on("error", reject);
    });

    expect(await connect()).toBe(1000);
    expect(await connect()).toBe(1008);
  });
});
