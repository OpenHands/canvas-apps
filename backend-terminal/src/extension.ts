import { artifact, discoverHome, installSidecar, probeSidecar, runtimeDirectory, startSidecar, type SidecarProbe } from "./sidecar-service";
import styles from "./styles.css?inline";
import type { CanvasHost, PageContext } from "./types";

function defaultSidecarUrl(): string {
  if (location.protocol === "http:" && location.hostname === "localhost") return "http://localhost:18080";
  if (location.protocol === "http:" && location.hostname === "127.0.0.1") return "http://127.0.0.1:18080";
  return `${location.origin}/terminal-sidecar`;
}

type StoredBackend = {
  id: string;
  apiKey: string;
  kind: string;
};

function backendApiKey(): string | null {
  try {
    const selected: unknown = JSON.parse(localStorage.getItem("openhands-active-backend") ?? "null");
    const backends: unknown = JSON.parse(localStorage.getItem("openhands-backends") ?? "[]");
    if (
      typeof selected !== "object" || selected === null ||
      !("backendId" in selected) || typeof selected.backendId !== "string" ||
      !Array.isArray(backends)
    ) return null;

    const backend = backends.find((value): value is StoredBackend => (
      typeof value === "object" && value !== null &&
      "id" in value && value.id === selected.backendId &&
      "kind" in value && value.kind === "local" &&
      "apiKey" in value && typeof value.apiKey === "string"
    ));
    return backend?.apiKey && backend.apiKey.length >= 8 ? backend.apiKey : null;
  } catch {
    return null;
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function mountTerminal(container: HTMLElement): () => void {
  const root = element("section", "terminal-shell");
  const iframe = element("iframe", "terminal-shell__frame") as HTMLIFrameElement;
  const error = element("div", "terminal-shell__error");
  error.hidden = true;
  error.setAttribute("role", "alert");
  error.setAttribute("aria-live", "assertive");
  iframe.title = "Interactive backend terminal";
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
  iframe.referrerPolicy = "no-referrer";
  root.append(iframe, error);
  container.append(root);

  const sidecarUrl = defaultSidecarUrl();
  const frameOrigin = new URL(sidecarUrl).origin;
  const target = new URL(`${sidecarUrl}/`);
  target.searchParams.set("canvas_origin", location.origin);
  target.searchParams.set("canvas_session", String(Date.now()));
  iframe.src = target.href;

  function showError(message = ""): void {
    error.textContent = message;
    error.hidden = message.length === 0;
  }

  const onMessage = (event: MessageEvent): void => {
    if (
      event.source !== iframe.contentWindow ||
      event.origin !== frameOrigin ||
      typeof event.data !== "object" ||
      event.data === null ||
      !("type" in event.data)
    ) return;
    if (
      event.data.type === "backend-terminal:credentials-request" &&
      "requestId" in event.data && typeof event.data.requestId === "string" && event.data.requestId.length <= 128
    ) {
      const apiKey = backendApiKey();
      if (!apiKey) {
        const message = "Canvas has no active local backend API key.";
        showError(message);
        iframe.contentWindow?.postMessage({
          type: "backend-terminal:credentials-error",
          requestId: event.data.requestId,
          message,
        }, frameOrigin);
        return;
      }
      iframe.contentWindow?.postMessage({
        type: "backend-terminal:credentials",
        requestId: event.data.requestId,
        apiKey,
      }, frameOrigin);
    } else if (event.data.type === "backend-terminal:ready") {
      showError();
    } else if (event.data.type === "backend-terminal:error" && "message" in event.data && typeof event.data.message === "string") {
      showError(event.data.message);
    }
  };
  window.addEventListener("message", onMessage);

  return () => {
    window.removeEventListener("message", onMessage);
    iframe.src = "about:blank";
    root.remove();
  };
}

function mountMessage(container: HTMLElement, message: string, tone: "status" | "error"): () => void {
  const root = element("section", `terminal-shell__message terminal-shell__message--${tone}`, message);
  root.setAttribute("role", tone === "error" ? "alert" : "status");
  container.append(root);
  return () => root.remove();
}

function mountSetup(
  host: CanvasHost,
  container: HTMLElement,
  home: string,
  probe: SidecarProbe,
  onReady: () => void,
): () => void {
  let disposed = false;
  let busy = false;
  const needsInstall = probe.state !== "stopped";
  const root = element("section", "terminal-setup");
  root.setAttribute("aria-labelledby", "terminal-setup-title");
  const title = element("h1", "terminal-setup__title", needsInstall ? "Install terminal sidecar" : "Start terminal sidecar");
  title.id = "terminal-setup-title";
  const summary = element(
    "p",
    "terminal-setup__summary",
    needsInstall
      ? "The backend-local terminal service is not installed and running."
      : "The verified terminal service is installed but stopped.",
  );
  const details = element("dl", "terminal-setup__details");
  const detailValues = [
    ["Version", artifact.version],
    ["Install path", runtimeDirectory(home)],
    ["Listener", "127.0.0.1:18080"],
    ["Runtime", "Persistent process; PTYs inherit the backend user's permissions"],
  ];
  for (const [label, value] of detailValues) {
    const row = element("div");
    row.append(element("dt", undefined, label), element("dd", undefined, value));
    details.append(row);
  }
  const disclosure = element(
    "p",
    "terminal-setup__disclosure",
    needsInstall
      ? `Installation stops any prior App-managed sidecar, writes bundled SHA-256-verified files, downloads pinned npm packages from the official registry, builds node-pty locally when required, and starts the service as the current backend user. Artifact ${artifact.sha256.slice(0, 12)}…`
      : "Starting launches the already verified service as the current backend user. It validates the active Canvas backend key live before creating each PTY.",
  );
  const error = element("div", "terminal-setup__error");
  error.hidden = !probe.message;
  error.textContent = probe.message ?? "";
  error.setAttribute("role", "alert");
  const actions = element("div", "terminal-setup__actions");
  const primary = element("button", "terminal-setup__button terminal-setup__button--primary", needsInstall ? "Install and start" : "Start sidecar") as HTMLButtonElement;
  primary.type = "button";
  const recheck = element("button", "terminal-setup__button", "Recheck") as HTMLButtonElement;
  recheck.type = "button";
  let consent: HTMLInputElement | null = null;
  if (needsInstall) {
    const consentLabel = element("label", "terminal-setup__consent");
    consent = element("input") as HTMLInputElement;
    consent.type = "checkbox";
    consentLabel.append(consent, document.createTextNode(" I understand this installs and starts a terminal service with the current backend user's permissions."));
    root.append(title, summary, details, disclosure, consentLabel, error, actions);
  } else {
    root.append(title, summary, details, disclosure, error, actions);
  }
  actions.append(primary, recheck);
  container.append(root);

  function setBusy(value: boolean, label?: string): void {
    busy = value;
    primary.disabled = value || !probe.supported || Boolean(consent && !consent.checked);
    recheck.disabled = value;
    if (label) primary.textContent = label;
  }

  function showError(value: string): void {
    error.textContent = value;
    error.hidden = value.length === 0;
  }

  async function check(): Promise<void> {
    if (busy) return;
    setBusy(true);
    showError("");
    try {
      const current = await probeSidecar(host, home);
      if (disposed) return;
      if (current.state === "ready") onReady();
      else showError(current.message ?? (current.state === "stopped" ? "The sidecar is installed but stopped. Use Start sidecar." : "The sidecar still requires installation."));
    } catch (caught) {
      if (!disposed) showError(caught instanceof Error ? caught.message : "Sidecar probe failed.");
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  async function installOrStart(): Promise<void> {
    if (busy || primary.disabled) return;
    setBusy(true, needsInstall ? "Installing…" : "Starting…");
    showError("");
    try {
      if (needsInstall) await installSidecar(host, home);
      if (disposed) return;
      setBusy(true, "Starting…");
      await startSidecar(host, home, location.origin);
      if (disposed) return;
      const current = await probeSidecar(host, home);
      if (current.state !== "ready") throw new Error(current.message ?? "The sidecar did not become ready.");
      onReady();
    } catch (caught) {
      if (!disposed) {
        showError(caught instanceof Error ? caught.message : "Sidecar setup failed.");
        setBusy(false, needsInstall ? "Install and start" : "Start sidecar");
      }
    }
  }

  consent?.addEventListener("change", () => setBusy(false));
  primary.addEventListener("click", () => void installOrStart());
  recheck.addEventListener("click", () => void check());
  setBusy(false);
  if (!probe.supported) showError(`Node.js 18+ and npm are required on a supported Linux or macOS backend. Detected: ${probe.nodeVersion ?? "no Node.js"}.`);

  return () => {
    disposed = true;
    root.remove();
  };
}


function mountPage(host: CanvasHost, context: PageContext): () => void {
  let disposed = false;
  let disposeContent = mountMessage(context.container, "Checking terminal sidecar…", "status");
  const style = element("style");
  style.dataset.backendTerminal = "styles";
  style.textContent = styles;
  context.container.prepend(style);

  function replaceContent(mount: () => () => void): void {
    if (disposed) return;
    disposeContent();
    disposeContent = mount();
  }

  async function initialize(): Promise<void> {
    if (host.backend.kind !== "local") {
      replaceContent(() => mountMessage(context.container, "Backend Terminal requires an active local backend.", "error"));
      return;
    }
    try {
      const home = await discoverHome(host);
      const probe = await probeSidecar(host, home);
      if (disposed) return;
      if (probe.state === "ready") {
        replaceContent(() => mountTerminal(context.container));
      } else {
        replaceContent(() => mountSetup(host, context.container, home, probe, () => {
          replaceContent(() => mountTerminal(context.container));
        }));
      }
    } catch (caught) {
      if (!disposed) {
        const message = caught instanceof Error ? caught.message : "Unable to inspect the terminal sidecar.";
        replaceContent(() => mountMessage(context.container, message, "error"));
      }
    }
  }

  void initialize();
  return () => {
    disposed = true;
    disposeContent();
    style.remove();
  };
}

export function activate(host: CanvasHost): () => void {
  if (host.apiVersion !== "1") throw new Error("Backend Terminal requires Canvas host API 1.");
  return host.registerPage("terminal", (context) => mountPage(host, context));
}
