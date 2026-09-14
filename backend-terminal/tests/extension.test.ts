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
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect((container.querySelector('[role="alert"]') as HTMLElement).hidden).toBe(true);

    dispose?.();
    expect(container.childElementCount).toBe(0);
  });

  it("ignores stale sidecar URL settings and exposes no configuration UI", () => {
    localStorage.setItem("backend-terminal.sidecar-url", "https://terminal.example.test/sidecar");
    const harness = createHarness();
    activate(harness.host);
    const container = document.createElement("div");
    const dispose = harness.mount()({ container, path: "" });

    const iframeUrl = new URL((container.querySelector("iframe") as HTMLIFrameElement).src);
    expect(iframeUrl.origin).toBe("http://localhost:18080");
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toBe("");
    dispose?.();
  });

  it("shows errors only from the configured iframe origin", () => {
    const harness = createHarness();
    activate(harness.host);
    const container = document.createElement("div");
    const dispose = harness.mount()({ container, path: "" });
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    const error = container.querySelector('[role="alert"]') as HTMLElement;

    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      origin: "http://evil.example",
      data: { type: "backend-terminal:error", message: "untrusted" },
    }));
    expect(error.hidden).toBe(true);
    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      origin: "http://localhost:18080",
      data: { type: "backend-terminal:error", message: "connection failed" },
    }));
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("connection failed");
    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      origin: "http://localhost:18080",
      data: { type: "backend-terminal:ready" },
    }));
    expect(error.hidden).toBe(true);

    dispose?.();
    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      origin: "http://localhost:18080",
      data: { type: "backend-terminal:error", message: "late" },
    }));
    expect(container.childElementCount).toBe(0);
  });

  it("delivers the active localStorage backend key only to its configured iframe", () => {
    localStorage.setItem("openhands-active-backend", JSON.stringify({ backendId: "local-test", orgId: null }));
    localStorage.setItem("openhands-backends", JSON.stringify([
      { id: "other-local", name: "Other", host: "http://127.0.0.1:9000", apiKey: "wrong-backend-key", kind: "local" },
      { id: "local-test", name: "Local", host: "http://127.0.0.1:8000", apiKey: "active-local-backend-key", kind: "local" },
    ]));
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
      apiKey: "active-local-backend-key",
    }, "http://localhost:18080");

    dispose?.();
  });

  it("rejects credential requests without an active localStorage local backend", () => {
    localStorage.setItem("openhands-active-backend", JSON.stringify({ backendId: "cloud-test", orgId: "org-1" }));
    localStorage.setItem("openhands-backends", JSON.stringify([
      { id: "cloud-test", name: "Cloud", host: "https://app.all-hands.dev", apiKey: "cloud-backend-key", kind: "cloud" },
    ]));
    const harness = createHarness();
    activate(harness.host);
    const container = document.createElement("div");
    document.body.append(container);
    const dispose = harness.mount()({ container, path: "" });
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      origin: "http://localhost:18080",
      data: { type: "backend-terminal:credentials-request", requestId: "request-cloud" },
    }));

    expect(postMessage).toHaveBeenCalledWith({
      type: "backend-terminal:credentials-error",
      requestId: "request-cloud",
      message: "Canvas has no active local backend API key.",
    }, "http://localhost:18080");
    expect(container.textContent).toBe("Canvas has no active local backend API key.");
    dispose?.();
  });

  it("renders only the terminal for nested page paths", () => {
    const harness = createHarness();
    activate(harness.host);
    const container = document.createElement("div");
    const dispose = harness.mount()({ container, path: "anything" });

    expect(container.querySelector("iframe")).not.toBeNull();
    expect(container.textContent).toBe("");
    dispose?.();
  });
});
