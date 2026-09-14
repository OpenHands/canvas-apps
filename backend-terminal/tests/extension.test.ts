import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate } from "../src/extension";

type Host = Parameters<typeof activate>[0];
type Mount = Parameters<Host["registerPage"]>[1];

type Harness = {
  host: Host;
  mount(): Mount;
  unregisterCount(): number;
};

function createHarness(): Harness {
  let registeredMount: Mount | undefined;
  let unregisters = 0;
  const host: Host = {
    apiVersion: "1",
    extension: { name: "backend-terminal", version: "0.2.0", resolvedRef: "test" },
    backend: { id: "local-test", kind: "local", orgId: null },
    registerPage(id, mount) {
      expect(id).toBe("terminal");
      registeredMount = mount;
      return () => { unregisters += 1; };
    },
  };
  return {
    host,
    mount() {
      if (!registeredMount) throw new Error("Page was not registered.");
      return registeredMount;
    },
    unregisterCount: () => unregisters,
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  delete (window as Window & { __AGENT_CANVAS_SESSION_API_KEY__?: string }).__AGENT_CANVAS_SESSION_API_KEY__;
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Backend Terminal sidecar extension", () => {
  it("registers once and unregisters on activation cleanup", () => {
    const harness = createHarness();
    const dispose = activate(harness.host);
    expect(typeof harness.mount()).toBe("function");
    dispose();
    expect(harness.unregisterCount()).toBe(1);
  });

  it("rejects unsupported host versions", () => {
    const harness = createHarness();
    expect(() => activate({ ...harness.host, apiVersion: "2" })).toThrow("requires Canvas host API 1");
  });

  it("mounts the default sidecar SPA and cleans up fully", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const harness = createHarness();
    activate(harness.host);
    const container = document.createElement("div");
    const dispose = harness.mount()({ container, path: "" });

    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    const iframeUrl = new URL(iframe.src);
    expect(iframeUrl.origin).toBe("http://localhost:18080");
    expect(iframeUrl.searchParams.get("canvas_origin")).toBe(location.origin);
    expect(iframeUrl.searchParams.get("canvas_session")).toBe("1234");
    expect(iframe.getAttribute("sandbox")).toContain("allow-scripts");
    expect(container.textContent).toContain("root PTY");

    dispose?.();
    expect(container.childElementCount).toBe(0);
  });

  it("persists valid custom URLs and rejects unsafe values", () => {
    vi.spyOn(Date, "now").mockReturnValue(5678);
    const harness = createHarness();
    activate(harness.host);
    const container = document.createElement("div");
    harness.mount()({ container, path: "" });

    const input = container.querySelector('input[name="sidecar-url"]') as HTMLInputElement;
    input.value = "https://terminal.example.test/sidecar/";
    container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const iframeUrl = new URL((container.querySelector("iframe") as HTMLIFrameElement).src);
    expect(`${iframeUrl.origin}${iframeUrl.pathname}`).toBe("https://terminal.example.test/sidecar/");
    expect(iframeUrl.searchParams.get("canvas_origin")).toBe(location.origin);
    expect(iframeUrl.searchParams.get("canvas_session")).toBe("5678");
    expect(localStorage.getItem("backend-terminal.sidecar-url")).toBe("https://terminal.example.test/sidecar");

    input.value = "file:///tmp/terminal";
    container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(container.textContent).toContain("must use HTTP or HTTPS");
  });

  it("accepts status messages only from the configured iframe origin", () => {
    vi.spyOn(Date, "now").mockReturnValue(9012);
    const harness = createHarness();
    activate(harness.host);
    const container = document.createElement("div");
    const dispose = harness.mount()({ container, path: "" });
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    const status = container.querySelector('[role="status"]') as HTMLElement;

    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      origin: "http://evil.example",
      data: { type: "backend-terminal:ready" },
    }));
    expect(status.textContent).toContain("Loading");
    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      origin: "http://localhost:18080",
      data: { type: "backend-terminal:ready" },
    }));
    expect(status.textContent).toBe("Interactive terminal ready.");

    dispose?.();
    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      origin: "http://localhost:18080",
      data: { type: "backend-terminal:error", message: "late" },
    }));
    expect(container.childElementCount).toBe(0);
  });

  it("delivers the active backend key only to its configured iframe", () => {
    (window as Window & { __AGENT_CANVAS_SESSION_API_KEY__?: string }).__AGENT_CANVAS_SESSION_API_KEY__ = "runtime-local-backend-key";
    const harness = createHarness();
    activate(harness.host);
    const container = document.createElement("div");
    document.body.append(container);
    const dispose = harness.mount()({ container, path: "" });
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      origin: "http://evil.example",
      data: { type: "backend-terminal:credentials-request", requestId: "wrong-origin" },
    }));
    expect(postMessage).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      origin: "http://localhost:18080",
      data: { type: "backend-terminal:credentials-request", requestId: "request-1" },
    }));
    expect(postMessage).toHaveBeenCalledWith({
      type: "backend-terminal:credentials",
      requestId: "request-1",
      apiKey: "runtime-local-backend-key",
    }, "http://localhost:18080");

    dispose?.();
  });


  it("renders help and unknown nested routes", () => {
    const harness = createHarness();
    activate(harness.host);
    const container = document.createElement("div");

    const disposeHelp = harness.mount()({ container, path: "help" });
    expect(container.textContent).toContain("validates it live with Agent Server");
    disposeHelp?.();
    const disposeMissing = harness.mount()({ container, path: "missing" });
    expect(container.textContent).toContain("Route not found");
    expect(container.textContent).toContain("missing");
    disposeMissing?.();
  });
});
