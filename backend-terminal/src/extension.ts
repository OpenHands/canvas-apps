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

function mountPage(context: PageContext): () => void {
  const style = element("style");
  style.dataset.backendTerminal = "styles";
  style.textContent = styles;
  context.container.append(style);

  const disposeContent = mountTerminal(context.container);
  return () => {
    disposeContent();
    style.remove();
  };
}

export function activate(host: CanvasHost): () => void {
  if (host.apiVersion !== "1") throw new Error("Backend Terminal requires Canvas host API 1.");
  return host.registerPage("terminal", mountPage);
}
