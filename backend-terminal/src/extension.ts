import styles from "./styles.css?inline";

type PageContext = {
  container: HTMLElement;
  path: string;
};

type CanvasHost = {
  readonly apiVersion: string;
  readonly extension: Readonly<{
    name: string;
    version: string;
    resolvedRef: string | null;
  }>;
  readonly backend: Readonly<{
    id: string;
    kind: "local" | "cloud";
    orgId: string | null;
  }>;
  registerPage(id: string, mount: (context: PageContext) => void | (() => void)): () => void;
};

const URL_STORAGE_KEY = "backend-terminal.sidecar-url";

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

function parseSidecarUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The sidecar URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The sidecar URL cannot contain credentials, a query, or a fragment.");
  }
  return url.href.replace(/\/$/, "");
}

function getStoredUrl(): string {
  const stored = localStorage.getItem(URL_STORAGE_KEY);
  if (!stored) return defaultSidecarUrl();
  try {
    return parseSidecarUrl(stored);
  } catch {
    localStorage.removeItem(URL_STORAGE_KEY);
    return defaultSidecarUrl();
  }
}

function messageFrom(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Unknown sidecar error";
}

function mountTerminal(host: CanvasHost, container: HTMLElement): () => void {
  let frameOrigin: string | null = null;

  const root = element("section", "terminal-shell");
  root.setAttribute("aria-labelledby", "terminal-shell-title");

  const header = element("header", "terminal-shell__header");
  const heading = element("div");
  const eyebrow = element("p", "terminal-shell__eyebrow", "Interactive sidecar");
  const title = element("h1", "terminal-shell__title", "Backend Terminal");
  title.id = "terminal-shell-title";
  heading.append(eyebrow, title);
  const badge = element("span", "terminal-shell__badge", `${host.backend.kind} · ${host.backend.id}`);
  header.append(heading, badge);

  const config = element("form", "terminal-shell__config");
  const field = element("label", "terminal-shell__field");
  const label = element("span", "terminal-shell__label", "Sidecar URL");
  const urlInput = element("input", "terminal-shell__input") as HTMLInputElement;
  urlInput.name = "sidecar-url";
  urlInput.type = "url";
  urlInput.required = true;
  urlInput.setAttribute("autocomplete", "url");
  urlInput.spellcheck = false;
  urlInput.value = getStoredUrl();
  field.append(label, urlInput);
  const connectButton = element("button", "terminal-shell__button", "Connect") as HTMLButtonElement;
  connectButton.type = "submit";
  config.append(field, connectButton);

  const status = element("div", "terminal-shell__status", "Waiting to connect…");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const frameWrap = element("div", "terminal-shell__frame-wrap");
  const iframe = element("iframe", "terminal-shell__frame") as HTMLIFrameElement;
  iframe.title = "Interactive backend terminal";
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  iframe.referrerPolicy = "no-referrer";
  frameWrap.append(iframe);

  const footer = element(
    "p",
    "terminal-shell__footer",
    "After Agent Server key validation, the sidecar opens a root PTY on the backend machine. Treat access as full machine authority.",
  );
  root.append(header, config, status, frameWrap, footer);
  container.append(root);

  function setStatus(text: string, tone: "normal" | "working" | "error" = "normal"): void {
    status.textContent = text;
    status.dataset.tone = tone;
  }

  function connect(): void {
    let sidecarUrl: string;
    try {
      sidecarUrl = parseSidecarUrl(urlInput.value);
      localStorage.setItem(URL_STORAGE_KEY, sidecarUrl);
    } catch (error) {
      setStatus(messageFrom(error), "error");
      return;
    }

    frameOrigin = new URL(sidecarUrl).origin;
    const target = new URL(`${sidecarUrl}/`);
    target.searchParams.set("canvas_origin", location.origin);
    target.searchParams.set("canvas_session", String(Date.now()));
    setStatus("Loading the sidecar SPA…", "working");
    iframe.src = target.href;
  }

  config.addEventListener("submit", (event) => {
    event.preventDefault();
    connect();
  });
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
        setStatus("No active local backend API key is available.", "error");
        iframe.contentWindow?.postMessage({
          type: "backend-terminal:credentials-error",
          requestId: event.data.requestId,
          message: "Canvas has no active local backend API key.",
        }, frameOrigin);
        return;
      }
      iframe.contentWindow?.postMessage({
        type: "backend-terminal:credentials",
        requestId: event.data.requestId,
        apiKey,
      }, frameOrigin);
    } else if (event.data.type === "backend-terminal:reconnect") {
      connect();
    } else if (event.data.type === "backend-terminal:ready") {
      setStatus("Interactive terminal ready.");
    } else if (event.data.type === "backend-terminal:error" && "message" in event.data && typeof event.data.message === "string") {
      setStatus(event.data.message, "error");
    }
  };
  window.addEventListener("message", onMessage);

  connect();

  return () => {
    window.removeEventListener("message", onMessage);
    iframe.src = "about:blank";
    root.remove();
  };
}

function mountInfo(container: HTMLElement, path: string): () => void {
  const root = element("section", "terminal-shell terminal-shell--info");
  const title = element("h1", "terminal-shell__title", path === "help" ? "Sidecar terminal" : "Route not found");
  const copy = element(
    "p",
    "terminal-shell__copy",
    path === "help"
      ? "Start the backend-local sidecar, then connect to its browser-reachable URL. Canvas sends its active local backend key only through the authenticated iframe/WebSocket handshake; the sidecar validates it live with Agent Server before opening a root PTY."
      : `Backend Terminal does not provide “${path}”.`,
  );
  root.append(title, copy);
  container.append(root);
  return () => root.remove();
}

function mountPage(host: CanvasHost, context: PageContext): () => void {
  const style = element("style");
  style.dataset.backendTerminal = "styles";
  style.textContent = styles;
  context.container.append(style);

  const normalizedPath = context.path.replace(/^\/+|\/+$/g, "");
  const disposeContent = normalizedPath === "" ? mountTerminal(host, context.container) : mountInfo(context.container, normalizedPath);
  return () => {
    disposeContent();
    style.remove();
  };
}

export function activate(host: CanvasHost): () => void {
  if (host.apiVersion !== "1") throw new Error("Backend Terminal requires Canvas host API 1.");
  return host.registerPage("terminal", (context) => mountPage(host, context));
}
