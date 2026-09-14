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
      window.__AGENT_CANVAS_SESSION_API_KEY__ = "blob-smoke-backend-key";
      const module = await import(blobUrl);
      const host = {
        apiVersion: "1",
        extension: { name: "backend-terminal", version: "0.2.0", resolvedRef: "smoke" },
        backend: { id: "smoke-backend", kind: "local", orgId: null },
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
      const iframe = container.querySelector("iframe");
      const iframeUrl = new URL(iframe?.src ?? "about:blank");
      if (`${iframeUrl.origin}${iframeUrl.pathname}` !== "http://canvas.test/terminal-sidecar/") {
        throw new Error(`Unexpected sidecar iframe URL: ${iframe?.src}`);
      }
      if (iframeUrl.searchParams.get("canvas_origin") !== location.origin) throw new Error("Canvas origin binding is missing.");
      if (!iframe.sandbox.contains("allow-scripts")) throw new Error("Sidecar iframe scripts are not allowed.");
      if (!container.textContent.includes("root PTY")) throw new Error("Root authority warning is missing.");
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

      const disposeHelp = mountPage({ container, path: "help" });
      if (!container.textContent.includes("validates it live with Agent Server")) throw new Error("Help route did not render.");
      disposeHelp();
      const disposeMissing = mountPage({ container, path: "missing" });
      if (!container.textContent.includes("Route not found")) throw new Error("Unknown route did not render.");
      disposeMissing();
      return { iframeOrigin };
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }, source);

  console.log(`Blob smoke passed with isolated sidecar origin ${result.iframeOrigin}.`);
} finally {
  await browser.close();
}
