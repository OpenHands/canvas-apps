import { createServer } from "node:http";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { startSidecar } from "../sidecar-dist/server/index.js";

const canvasOrigin = "http://localhost:8000";
const apiKey = "browser-smoke-agent-server-key";
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
  port: 0,
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
  publicDir: resolve(import.meta.dirname, "../sidecar-dist/public"),
});
const origin = `http://localhost:${running.port}`;
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
    body: `<!doctype html><body><script>
      const frame = document.createElement("iframe");
      frame.id = "terminal";
      addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow || event.origin !== "${origin}") return;
        if (event.data?.type === "backend-terminal:credentials-request") {
          frame.contentWindow.postMessage({ type: "backend-terminal:credentials", requestId: event.data.requestId, apiKey: "${apiKey}" }, "${origin}");
        } else if (event.data?.type === "backend-terminal:ready") {
          window.terminalReady = true;
        } else if (event.data?.type === "backend-terminal:error") {
          window.terminalError = event.data.message;
        }
      });
      frame.src = "${origin}/?canvas_origin=${encodeURIComponent(canvasOrigin)}&canvas_session=smoke";
      document.body.append(frame);
    </script>`,
  }));
  await page.goto(`${canvasOrigin}/`);
  const terminalFrame = page.frameLocator("#terminal");
  try {
    await page.waitForFunction(() => window.terminalReady === true, undefined, { timeout: 5_000 });
  } catch (error) {
    const connectionError = await page.evaluate(() => window.terminalError || "unavailable");
    const frameCount = await page.locator("#terminal").count();
    const frameUrls = page.frames().map((frame) => frame.url()).join(", ");
    throw new Error(`Terminal did not connect (error: ${connectionError}; iframe count: ${frameCount}; frames: ${frameUrls}; page errors: ${pageErrors.join("; ") || "none"})`, { cause: error });
  }
  await terminalFrame.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("printf '__SIDECAR_BROWSER_OK__\\n'; exit 0");
  await page.keyboard.press("Enter");
  await terminalFrame.locator(".xterm-rows").filter({ hasText: "__SIDECAR_BROWSER_OK__" }).waitFor({ timeout: 10_000 });
  if (pageErrors.length > 0) throw new Error(`Browser errors: ${pageErrors.join("; ")}`);
  console.log("Sidecar browser smoke passed through Agent Server auth and a real PTY session.");
} finally {
  await browser.close();
  await running.close();
  await new Promise((resolvePromise, reject) => agentServer.close((error) => error ? reject(error) : resolvePromise()));
}
