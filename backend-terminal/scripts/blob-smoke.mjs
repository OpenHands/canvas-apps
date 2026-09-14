import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const source = await readFile(resolve(import.meta.dirname, "../extension.js"), "utf8");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
});

try {
  const page = await browser.newPage();
  await page.route("http://canvas.test/", (route) => route.fulfill({
    contentType: "text/html",
    body: '<main id="app"></main>',
  }));
  await page.goto("http://canvas.test/");
  const result = await page.evaluate(async ({ extensionSource, token }) => {
    const blobUrl = URL.createObjectURL(new Blob([extensionSource], { type: "text/javascript" }));
    let mountPage;
    let unregistered = false;
    let capabilityRequest;
    const sockets = [];

    class SmokeWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;
      readyState = SmokeWebSocket.CONNECTING;
      sent = [];
      constructor(url) {
        super();
        this.url = String(url);
        sockets.push(this);
      }
      open() {
        this.readyState = SmokeWebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      }
      send(data) { this.sent.push(data); }
      close(code = 1000, reason = "") {
        this.readyState = SmokeWebSocket.CLOSED;
        const event = new Event("close");
        Object.defineProperties(event, { code: { value: code }, reason: { value: reason } });
        this.dispatchEvent(event);
      }
    }

    const realFetch = window.fetch;
    const RealWebSocket = window.WebSocket;
    window.fetch = async (input, init) => {
      capabilityRequest = { url: String(input), body: String(init?.body ?? ""), credentials: init?.credentials };
      return new Response(JSON.stringify({ token, expires_at: new Date(Date.now() + 30_000).toISOString() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    window.WebSocket = SmokeWebSocket;

    try {
      localStorage.setItem("openhands-active-backend", JSON.stringify({ backendId: "smoke-backend", orgId: null }));
      localStorage.setItem("openhands-backends", JSON.stringify([
        { id: "smoke-backend", name: "Smoke", host: "http://127.0.0.1:18000", apiKey: "blob-smoke-backend-key", kind: "local" },
      ]));
      const module = await import(blobUrl);
      const host = {
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
          return () => { unregistered = true; };
        },
      };

      const disposeActivation = module.activate(host);
      if (typeof mountPage !== "function") throw new Error("Page was not registered.");
      const container = document.querySelector("#app");
      const disposeMount = mountPage({ container, path: "" });
      const deadline = Date.now() + 2_000;
      while ((!container.querySelector(".terminal-shell__mount") || sockets.length === 0) && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      const terminalMount = container.querySelector(".terminal-shell__mount");
      if (!terminalMount?.shadowRoot?.querySelector(".xterm")) throw new Error("Bundled xterm did not render in the shadow root.");
      if (container.querySelector("iframe")) throw new Error("Terminal rendered an iframe.");
      if (sockets.length !== 1) throw new Error("Terminal WebSocket was not created.");
      sockets[0].open();
      const auth = JSON.parse(sockets[0].sent[0] ?? "{}");
      if (auth.api_key !== "blob-smoke-backend-key" || auth.token !== token) throw new Error("WebSocket auth did not contain the selected backend key and capability.");
      if (capabilityRequest?.url !== "http://canvas.test/terminal-sidecar/api/access-token") throw new Error(`Unexpected capability URL: ${capabilityRequest?.url}`);
      if (capabilityRequest?.credentials !== "omit") throw new Error("Capability request did not omit ambient credentials.");
      if (capabilityRequest?.body.includes("blob-smoke-backend-key")) throw new Error("Backend key leaked into the capability request.");

      disposeMount();
      if (container.childElementCount !== 0 || terminalMount.shadowRoot.childElementCount !== 0) throw new Error("Mount cleanup left DOM behind.");
      disposeActivation();
      if (!unregistered) throw new Error("Activation cleanup did not unregister the page.");

      const disposeNested = mountPage({ container, path: "anything" });
      const nestedDeadline = Date.now() + 2_000;
      while (!container.querySelector(".terminal-shell__mount") && Date.now() < nestedDeadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      if (!container.querySelector(".terminal-shell__mount") || container.querySelector("iframe, header, form, input, button, footer")) {
        throw new Error("Nested page path did not render only the bundled terminal.");
      }
      disposeNested();
      return { socketUrl: sockets[0].url, shadowRoot: true };
    } finally {
      window.fetch = realFetch;
      window.WebSocket = RealWebSocket;
      URL.revokeObjectURL(blobUrl);
    }
  }, { extensionSource: source, token: "b".repeat(32) });

  console.log(`Blob smoke passed with bundled shadow DOM and ${result.socketUrl}.`);
} finally {
  await browser.close();
}
