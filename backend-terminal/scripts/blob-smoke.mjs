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
  await page.route("http://canvas.test/terminal-sidecar/**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><title>Sidecar smoke</title><script>
      addEventListener("message", (event) => {
        if (event.origin === "http://canvas.test" && event.data?.type === "backend-terminal:credentials") {
          window.receivedKey = event.data.apiKey;
        }
      });
      parent.postMessage({ type: "backend-terminal:credentials-request", requestId: "blob-smoke" }, "http://canvas.test");
    </script>`,
  }));
  await page.goto("http://canvas.test/");
  const result = await page.evaluate(async (extensionSource) => {
    const blobUrl = URL.createObjectURL(new Blob([extensionSource], { type: "text/javascript" }));
    let mountPage;
    let unregistered = false;

    try {
      localStorage.setItem("openhands-active-backend", JSON.stringify({ backendId: "smoke-backend", orgId: null }));
      localStorage.setItem("openhands-backends", JSON.stringify([
        { id: "smoke-backend", name: "Smoke", host: "http://127.0.0.1:18000", apiKey: "blob-smoke-backend-key", kind: "local" },
      ]));
      const module = await import(blobUrl);
      const host = {
        apiVersion: "1",
        extension: { name: "backend-terminal", version: "0.3.2", resolvedRef: "smoke" },
        backend: { id: "smoke-backend", kind: "local", orgId: null },
        agentServer: {
          async request(request) {
            if (request.path === "/api/file/home") return { home: "/root" };
            const probe = { state: "ready", version: "0.3.2", nodeVersion: "v22.0.0", npmVersion: "10.0.0", supported: true, message: null };
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
      const iframeDeadline = Date.now() + 2_000;
      while (!container.querySelector("iframe") && Date.now() < iframeDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const iframe = container.querySelector("iframe");
      const iframeUrl = new URL(iframe?.src ?? "about:blank");
      if (`${iframeUrl.origin}${iframeUrl.pathname}` !== "http://canvas.test/terminal-sidecar/") {
        throw new Error(`Unexpected sidecar iframe URL: ${iframe?.src}`);
      }
      if (iframeUrl.searchParams.get("canvas_origin") !== location.origin) throw new Error("Canvas origin binding is missing.");
      if (!iframe.sandbox.contains("allow-scripts")) throw new Error("Sidecar iframe scripts are not allowed.");
      if (container.querySelector("header, form, input, button, footer")) throw new Error("Terminal chrome was rendered.");
      const errorRegion = container.querySelector('[role="alert"]');
      if (!errorRegion?.hidden || errorRegion.textContent) throw new Error("Initial error region is not empty and hidden.");
      const iframeOrigin = iframeUrl.origin;
      const deadline = Date.now() + 2_000;
      while (iframe.contentWindow.receivedKey !== "blob-smoke-backend-key" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (iframe.contentWindow.receivedKey !== "blob-smoke-backend-key") throw new Error("Backend key was not delivered to the iframe.");

      disposeMount();
      if (container.childElementCount !== 0) throw new Error("Mount cleanup left DOM behind.");
      disposeActivation();
      if (!unregistered) throw new Error("Activation cleanup did not unregister the page.");

      const disposeNested = mountPage({ container, path: "anything" });
      const nestedDeadline = Date.now() + 2_000;
      while (!container.querySelector("iframe") && Date.now() < nestedDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!container.querySelector("iframe") || container.querySelector("header, form, input, button, footer")) {
        throw new Error("Nested page path did not render only the terminal.");
      }
      disposeNested();
      return { iframeOrigin };
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }, source);

  console.log(`Blob smoke passed with isolated sidecar origin ${result.iframeOrigin}.`);
} finally {
  await browser.close();
}
