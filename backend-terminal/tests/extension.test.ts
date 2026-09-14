import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate } from "../src/extension";
import type { AgentServerRequest } from "../src/types";

const HOME = "/root";
type Host = Parameters<typeof activate>[0];
type Mount = Parameters<Host["registerPage"]>[1];
type Request = (request: AgentServerRequest) => Promise<unknown>;

type Harness = {
  host: Host;
  mount(): Mount;
  unregisterCount(): number;
};

function encodedProbe(state: "missing" | "stopped" | "ready" | "incompatible", overrides: Record<string, unknown> = {}): string {
  return `BACKEND_TERMINAL_PROBE\t${btoa(JSON.stringify({
    state,
    version: state === "ready" ? "0.3.2" : null,
    nodeVersion: "v23.8.0",
    npmVersion: "10.9.2",
    supported: true,
    message: null,
    ...overrides,
  }))}\n`;
}

function createHarness(requestImpl?: Request, kind: "local" | "cloud" = "local"): Harness {
  let registeredMount: Mount | undefined;
  let unregisters = 0;
  const request = vi.fn(requestImpl ?? (async (call: AgentServerRequest) => {
    if (call.path === "/api/file/home") return { home: HOME };
    return { exit_code: 0, stdout: encodedProbe("ready"), stderr: "" };
  }));
  const host: Host = {
    apiVersion: "1",
    extension: { name: "backend-terminal", version: "0.3.2", resolvedRef: "test" },
    backend: { id: `${kind}-test`, kind, orgId: kind === "cloud" ? "org-1" : null },
    agentServer: { request: request as Host["agentServer"]["request"] },
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

async function mounted(harness: Harness, path = ""): Promise<{ container: HTMLElement; iframe: HTMLIFrameElement; dispose: () => void }> {
  activate(harness.host);
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = harness.mount()({ container, path }) as () => void;
  await vi.waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
  return { container, iframe: container.querySelector("iframe") as HTMLIFrameElement, dispose };
}

beforeEach(() => localStorage.clear());
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

  it("probes the backend before mounting the sidecar SPA and cleans up fully", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const harness = createHarness();
    const { container, iframe, dispose } = await mounted(harness);
    const iframeUrl = new URL(iframe.src);
    expect(iframeUrl.origin).toBe("http://localhost:18080");
    expect(iframeUrl.searchParams.get("canvas_origin")).toBe(location.origin);
    expect(iframeUrl.searchParams.get("canvas_session")).toBe("1234");
    expect(iframe.getAttribute("sandbox")).toContain("allow-scripts");
    expect(container.querySelector("button")).toBeNull();
    expect((container.querySelector('[role="alert"]') as HTMLElement).hidden).toBe(true);
    expect(harness.host.agentServer.request).toHaveBeenCalledTimes(2);
    dispose();
    expect(container.childElementCount).toBe(0);
  });

  it("ignores stale sidecar URL settings", async () => {
    localStorage.setItem("backend-terminal.sidecar-url", "https://terminal.example.test/sidecar");
    const { container, iframe, dispose } = await mounted(createHarness());
    expect(new URL(iframe.src).origin).toBe("http://localhost:18080");
    expect(container.querySelector("form")).toBeNull();
    dispose();
  });

  it("shows errors only from the configured iframe origin", async () => {
    const { container, iframe, dispose } = await mounted(createHarness());
    const error = container.querySelector('[role="alert"]') as HTMLElement;
    window.dispatchEvent(new MessageEvent("message", { source: iframe.contentWindow, origin: "http://evil.example", data: { type: "backend-terminal:error", message: "untrusted" } }));
    expect(error.hidden).toBe(true);
    window.dispatchEvent(new MessageEvent("message", { source: iframe.contentWindow, origin: "http://localhost:18080", data: { type: "backend-terminal:error", message: "connection failed" } }));
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("connection failed");
    window.dispatchEvent(new MessageEvent("message", { source: iframe.contentWindow, origin: "http://localhost:18080", data: { type: "backend-terminal:ready" } }));
    expect(error.hidden).toBe(true);
    dispose();
  });

  it("delivers only the selected localStorage backend key to the iframe", async () => {
    localStorage.setItem("openhands-active-backend", JSON.stringify({ backendId: "local-test", orgId: null }));
    localStorage.setItem("openhands-backends", JSON.stringify([
      { id: "other-local", apiKey: "wrong-backend-key", kind: "local" },
      { id: "local-test", apiKey: "active-local-backend-key", kind: "local" },
    ]));
    const { iframe, dispose } = await mounted(createHarness());
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    window.dispatchEvent(new MessageEvent("message", { source: iframe.contentWindow, origin: "http://evil.example", data: { type: "backend-terminal:credentials-request", requestId: "wrong-origin" } }));
    expect(postMessage).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent("message", { source: iframe.contentWindow, origin: "http://localhost:18080", data: { type: "backend-terminal:credentials-request", requestId: "request-1" } }));
    expect(postMessage).toHaveBeenCalledWith({ type: "backend-terminal:credentials", requestId: "request-1", apiKey: "active-local-backend-key" }, "http://localhost:18080");
    dispose();
  });

  it("rejects iframe credentials without an active localStorage local backend", async () => {
    localStorage.setItem("openhands-active-backend", JSON.stringify({ backendId: "cloud-test", orgId: "org-1" }));
    localStorage.setItem("openhands-backends", JSON.stringify([{ id: "cloud-test", apiKey: "cloud-backend-key", kind: "cloud" }]));
    const { container, iframe, dispose } = await mounted(createHarness());
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    window.dispatchEvent(new MessageEvent("message", { source: iframe.contentWindow, origin: "http://localhost:18080", data: { type: "backend-terminal:credentials-request", requestId: "request-cloud" } }));
    expect(postMessage).toHaveBeenCalledWith({ type: "backend-terminal:credentials-error", requestId: "request-cloud", message: "Canvas has no active local backend API key." }, "http://localhost:18080");
    expect(container.textContent).toBe("Canvas has no active local backend API key.");
    dispose();
  });

  it("renders only the ready terminal for nested page paths", async () => {
    const { container, dispose } = await mounted(createHarness(), "anything");
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(container.querySelector("button")).toBeNull();
    dispose();
  });

  it("requires explicit consent before installing and starts only after verification", async () => {
    let probes = 0;
    const commands: string[] = [];
    const request: Request = async (call) => {
      if (call.path === "/api/file/home") return { home: HOME };
      const command = (call.body as { command: string }).command;
      commands.push(command);
      if (command.includes("BACKEND_TERMINAL_PROBE")) return { exit_code: 0, stdout: encodedProbe(probes++ === 0 ? "missing" : "ready"), stderr: "" };
      return { exit_code: 0, stdout: "ok", stderr: "" };
    };
    const harness = createHarness(request);
    activate(harness.host);
    const container = document.createElement("div");
    const dispose = harness.mount()({ container, path: "" }) as () => void;
    await vi.waitFor(() => expect(container.textContent).toContain("Install terminal sidecar"));
    expect(container.textContent).toContain("current backend user's permissions");
    const install = [...container.querySelectorAll("button")].find((button) => button.textContent === "Install and start") as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    expect(container.querySelector("iframe")).toBeNull();
    const consent = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    consent.checked = true;
    consent.dispatchEvent(new Event("change"));
    expect(install.disabled).toBe(false);
    install.click();
    await vi.waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(commands.some((command) => command.includes("npm ci --omit=dev"))).toBe(true);
    expect(commands.some((command) => command.includes("nohup env HOME="))).toBe(true);
    dispose();
  });

  it("starts an installed stopped sidecar without reinstalling", async () => {
    let probes = 0;
    const commands: string[] = [];
    const request: Request = async (call) => {
      if (call.path === "/api/file/home") return { home: HOME };
      const command = (call.body as { command: string }).command;
      commands.push(command);
      if (command.includes("BACKEND_TERMINAL_PROBE")) return { exit_code: 0, stdout: encodedProbe(probes++ === 0 ? "stopped" : "ready"), stderr: "" };
      return { exit_code: 0, stdout: "ok", stderr: "" };
    };
    const harness = createHarness(request);
    activate(harness.host);
    const container = document.createElement("div");
    const dispose = harness.mount()({ container, path: "" }) as () => void;
    await vi.waitFor(() => expect(container.textContent).toContain("Start terminal sidecar"));
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    ([...container.querySelectorAll("button")].find((button) => button.textContent === "Start sidecar") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(commands.some((command) => command.includes("npm ci --omit=dev"))).toBe(false);
    expect(commands.some((command) => command.includes("nohup env HOME="))).toBe(true);
    dispose();
  });

  it("does not probe or install against a cloud backend", async () => {
    const harness = createHarness(undefined, "cloud");
    activate(harness.host);
    const container = document.createElement("div");
    const dispose = harness.mount()({ container, path: "" }) as () => void;
    await vi.waitFor(() => expect(container.textContent).toContain("requires an active local backend"));
    expect(harness.host.agentServer.request).not.toHaveBeenCalled();
    expect(container.querySelector("iframe")).toBeNull();
    dispose();
  });
});
