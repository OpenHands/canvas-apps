import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { startSidecar } from "../sidecar-dist/server/index.js";

const canvasOrigin = "http://localhost:8000";
const apiKey = "browser-smoke-agent-server-key";
const extensionSource = await readFile(resolve(import.meta.dirname, "../extension.js"), "utf8");
const agentServer = createServer((request, response) => {
  if (request.url?.startsWith("/api/conversations/search") && request.headers["x-session-api-key"] === apiKey) {
    response.writeHead(200, { "Content-Type": "application/json" }).end('{"items":[]}');
    return;
  }
  response.writeHead(401).end();
});
await new Promise((resolvePromise) => agentServer.listen(0, "127.0.0.1", resolvePromise));
const agentAddress = agentServer.address();
if (!agentAddress || typeof agentAddress === "string") throw new Error("Smoke Agent Server did not bind.");

const running = await startSidecar({
  host: "127.0.0.1",
  port: 18_080,
  allowedOrigins: new Set([canvasOrigin]),
  agentServerUrl: `http://127.0.0.1:${agentAddress.port}`,
  agentServerTimeoutMs: 1_000,
  cwd: process.cwd(),
  shell: "/bin/bash",
  shellArgs: ["--noprofile", "--norc"],
  tokenTtlMs: 30_000,
  maxSessions: 2,
  maxMessageBytes: 65_536,
  idleTimeoutMs: 60_000,
});
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
  args: ["--disable-features=LocalNetworkAccessChecks"],
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => pageErrors.push(`${request.url()}: ${request.failure()?.errorText ?? "request failed"}`));
  await page.route(`${canvasOrigin}/`, (route) => route.fulfill({
    contentType: "text/html",
    body: '<main id="app"></main>',
  }));
  await page.goto(`${canvasOrigin}/`);
  await page.evaluate(async ({ source, key }) => {
    localStorage.setItem("openhands-active-backend", JSON.stringify({ backendId: "smoke-backend", orgId: null }));
    localStorage.setItem("openhands-backends", JSON.stringify([
      { id: "smoke-backend", name: "Smoke", host: "http://127.0.0.1:18000", apiKey: key, kind: "local" },
    ]));
    const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const module = await import(blobUrl);
    let mountPage;
    module.activate({
      apiVersion: "1",
      extension: { name: "backend-terminal", version: "0.4.0", resolvedRef: "smoke" },
      backend: { id: "smoke-backend", kind: "local", orgId: null },
      agentServer: {
        async request(request) {
          if (request.path === "/api/file/home") return { home: "/root" };
          const probe = { state: "ready", version: "0.4.0", nodeVersion: "v22.0.0", npmVersion: "10.0.0", supported: true, message: null };
          return { exit_code: 0, stdout: `BACKEND_TERMINAL_PROBE\t${btoa(JSON.stringify(probe))}\n`, stderr: "" };
        },
      },
      registerPage(id, mount) {
        if (id !== "terminal") throw new Error(`Unexpected page ID: ${id}`);
        mountPage = mount;
        return () => {};
      },
    });
    if (typeof mountPage !== "function") throw new Error("Terminal page was not registered.");
    window.disposeTerminal = mountPage({ container: document.querySelector("#app"), path: "" });
  }, { source: extensionSource, key: apiKey });

  const textarea = page.locator(".terminal-shell__mount .xterm-helper-textarea");
  try {
    await textarea.waitFor({ timeout: 5_000 });
    await textarea.focus();
    await page.keyboard.type("printf '__SIDECAR_BROWSER_OK__\\n'; exit 0");
    await page.keyboard.press("Enter");
    await page.locator(".terminal-shell__mount .xterm-rows").filter({ hasText: "__SIDECAR_BROWSER_OK__" }).waitFor({ timeout: 10_000 });
  } catch (error) {
    const terminalError = await page.locator(".terminal-shell__mount [role=alert]").textContent().catch(() => "unavailable");
    throw new Error(`Bundled terminal did not complete PTY smoke (error: ${terminalError}; page errors: ${pageErrors.join("; ") || "none"})`, { cause: error });
  }
  if (await page.locator("iframe").count()) throw new Error("Bundled terminal unexpectedly rendered an iframe.");
  if (pageErrors.length > 0) throw new Error(`Browser errors: ${pageErrors.join("; ")}`);
  await page.evaluate(() => window.disposeTerminal?.());
  console.log("Bundled extension browser smoke passed through CORS, Agent Server auth, and a real PTY session.");
} finally {
  await browser.close();
  await running.close();
  await new Promise((resolvePromise, reject) => agentServer.close((error) => error ? reject(error) : resolvePromise()));
}
