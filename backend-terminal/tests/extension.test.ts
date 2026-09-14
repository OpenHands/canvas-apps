import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate } from "../src/extension";
import type { AgentServerRequest } from "../src/types";

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(surface: HTMLElement): void {
      const terminal = document.createElement("div");
      terminal.className = "xterm";
      const textarea = document.createElement("textarea");
      textarea.className = "xterm-helper-textarea";
      terminal.append(textarea);
      surface.append(terminal);
    }
    focus(): void {}
    onData(): { dispose(): void } { return { dispose() {} }; }
    onResize(): { dispose(): void } { return { dispose() {} }; }
    write(): void {}
    writeln(): void {}
    dispose(): void {}
  },
}));

const HOME = "/root";
const TOKEN = "a".repeat(32);
type Host = Parameters<typeof activate>[0];
type Mount = Parameters<Host["registerPage"]>[1];
type Request = (request: AgentServerRequest) => Promise<unknown>;

type Harness = {
  host: Host;
  mount(): Mount;
  unregisterCount(): number;
};

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    sockets.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    const event = new Event("close");
    Object.defineProperties(event, { code: { value: code }, reason: { value: reason } });
    this.dispatchEvent(event);
  }
}

const sockets: FakeWebSocket[] = [];

function encodedProbe(state: "missing" | "stopped" | "ready" | "incompatible", overrides: Record<string, unknown> = {}): string {
  return `BACKEND_TERMINAL_PROBE\t${btoa(JSON.stringify({
    state,
    version: state === "ready" ? "0.4.0" : null,
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
    extension: { name: "backend-terminal", version: "0.4.0", resolvedRef: "test" },
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

async function mounted(harness: Harness, path = ""): Promise<{ container: HTMLElement; terminalMount: HTMLElement; dispose: () => void }> {
  activate(harness.host);
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = harness.mount()({ container, path }) as () => void;
  await vi.waitFor(() => expect(container.querySelector(".terminal-shell__mount")).not.toBeNull());
  return { container, terminalMount: container.querySelector(".terminal-shell__mount") as HTMLElement, dispose };
}

beforeEach(() => {
  sockets.length = 0;
  localStorage.clear();
  localStorage.setItem("openhands-active-backend", JSON.stringify({ backendId: "local-test", orgId: null }));
  localStorage.setItem("openhands-backends", JSON.stringify([
    { id: "local-test", apiKey: "active-local-backend-key", kind: "local" },
  ]));
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ token: TOKEN, expires_at: new Date(Date.now() + 30_000).toISOString() }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )));
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Backend Terminal bundled extension", () => {
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

  it("probes before rendering xterm directly and cleans up fully", async () => {
    const harness = createHarness();
    const { container, terminalMount, dispose } = await mounted(harness);
    expect(container.querySelector("iframe")).toBeNull();
    expect(terminalMount.shadowRoot?.querySelector(".xterm")).not.toBeNull();
    expect(harness.host.agentServer.request).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, options] = vi.mocked(fetch).mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe("http://localhost:18080/api/access-token");
    expect(options.credentials).toBe("omit");
    expect(options.body).toBe(JSON.stringify({ extension: "backend-terminal", backend_id: "local-test" }));
    expect(String(options.body)).not.toContain("active-local-backend-key");
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]?.url).toBe("ws://localhost:18080/api/terminal");
    sockets[0]?.open();
    expect(JSON.parse(sockets[0]?.sent[0] ?? "{}")).toEqual({
      type: "auth",
      token: TOKEN,
      api_key: "active-local-backend-key",
      cols: 80,
      rows: 24,
    });
    dispose();
    expect(container.childElementCount).toBe(0);
    expect(terminalMount.shadowRoot?.childElementCount).toBe(0);
    expect(sockets[0]?.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("ignores stale sidecar URL settings", async () => {
    localStorage.setItem("backend-terminal.sidecar-url", "https://terminal.example.test/sidecar");
    const { container, dispose } = await mounted(createHarness());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe("http://localhost:18080/api/access-token");
    expect(container.querySelector("form")).toBeNull();
    dispose();
  });

  it("reports direct WebSocket errors inside the terminal shadow root", async () => {
    const { terminalMount, dispose } = await mounted(createHarness());
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.dispatchEvent(new Event("error"));
    const error = terminalMount.shadowRoot?.querySelector('[role="alert"]') as HTMLElement;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("WebSocket connection failed.");
    dispose();
  });

  it("uses only the selected localStorage backend key for WebSocket auth", async () => {
    localStorage.setItem("openhands-backends", JSON.stringify([
      { id: "other-local", apiKey: "wrong-backend-key", kind: "local" },
      { id: "local-test", apiKey: "active-local-backend-key", kind: "local" },
    ]));
    const { dispose } = await mounted(createHarness());
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.open();
    expect(sockets[0]?.sent[0]).toContain("active-local-backend-key");
    expect(sockets[0]?.sent[0]).not.toContain("wrong-backend-key");
    dispose();
  });

  it("rejects credentials not bound to the host's active local backend", async () => {
    localStorage.setItem("openhands-active-backend", JSON.stringify({ backendId: "other-local", orgId: null }));
    localStorage.setItem("openhands-backends", JSON.stringify([
      { id: "other-local", apiKey: "other-local-key", kind: "local" },
    ]));
    const harness = createHarness();
    activate(harness.host);
    const container = document.createElement("div");
    const dispose = harness.mount()({ container, path: "" }) as () => void;
    await vi.waitFor(() => expect(container.textContent).toContain("no valid API key for the active local backend"));
    expect(container.querySelector(".terminal-shell__mount")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    dispose();
  });

  it("renders only the direct terminal for nested page paths", async () => {
    const { container, dispose } = await mounted(createHarness(), "anything");
    expect(container.querySelector(".terminal-shell__mount")).not.toBeNull();
    expect(container.querySelector("iframe, button")).toBeNull();
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
    expect(container.querySelector(".terminal-shell__mount")).toBeNull();
    const consent = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    consent.checked = true;
    consent.dispatchEvent(new Event("change"));
    expect(install.disabled).toBe(false);
    install.click();
    await vi.waitFor(() => expect(container.querySelector(".terminal-shell__mount")).not.toBeNull());
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
    await vi.waitFor(() => expect(container.querySelector(".terminal-shell__mount")).not.toBeNull());
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
    expect(container.querySelector(".terminal-shell__mount")).toBeNull();
    dispose();
  });
});
