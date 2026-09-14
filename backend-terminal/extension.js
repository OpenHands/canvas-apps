const P = ".terminal-shell{--terminal-bg: #080b10;--terminal-panel: #111720;--terminal-line: #283446;--terminal-text: #e6edf5;--terminal-muted: #93a4b8;--terminal-accent: #5eead4;box-sizing:border-box;display:grid;grid-template-rows:auto auto auto minmax(20rem,1fr) auto;gap:.85rem;min-height:100%;padding:1rem;color:var(--terminal-text);background:radial-gradient(circle at 10% 0,#172331 0,var(--terminal-bg) 32rem);font:14px/1.45 ui-sans-serif,system-ui,sans-serif}.terminal-shell *,.terminal-shell *:before,.terminal-shell *:after{box-sizing:border-box}.terminal-shell__header{display:flex;align-items:center;justify-content:space-between;gap:1rem}.terminal-shell__eyebrow{margin:0 0 .15rem;color:var(--terminal-accent);font-size:.72rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.terminal-shell__title{margin:0;font-size:clamp(1.25rem,2vw,1.75rem)}.terminal-shell__badge{max-width:50%;overflow:hidden;padding:.4rem .7rem;border:1px solid var(--terminal-line);border-radius:999px;color:var(--terminal-muted);text-overflow:ellipsis;white-space:nowrap}.terminal-shell__config{display:flex;align-items:end;gap:.6rem}.terminal-shell__field{display:grid;flex:1;gap:.25rem}.terminal-shell__label{color:var(--terminal-muted);font-size:.75rem;font-weight:700}.terminal-shell__input,.terminal-shell__button{min-height:2.6rem;border:1px solid var(--terminal-line);border-radius:.55rem;color:var(--terminal-text);background:var(--terminal-panel);font:inherit}.terminal-shell__input{width:100%;padding:.55rem .7rem;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.terminal-shell__input:focus,.terminal-shell__button:focus-visible{outline:2px solid var(--terminal-accent);outline-offset:2px}.terminal-shell__button{padding:.55rem 1rem;cursor:pointer;font-weight:800}.terminal-shell__button:hover:not(:disabled){border-color:var(--terminal-accent)}.terminal-shell__button:disabled{cursor:wait;opacity:.55}.terminal-shell__status{min-height:1.4rem;color:var(--terminal-muted)}.terminal-shell__status[data-tone=working]{color:#facc15}.terminal-shell__status[data-tone=error]{color:#fb7185}.terminal-shell__frame-wrap{min-height:0;overflow:hidden;border:1px solid var(--terminal-line);border-radius:.75rem;background:#06090d;box-shadow:0 1rem 3rem #0000003d}.terminal-shell__frame{display:block;width:100%;height:100%;min-height:20rem;border:0;background:#06090d}.terminal-shell__footer,.terminal-shell__copy{margin:0;color:var(--terminal-muted);font-size:.78rem}.terminal-shell--info{align-content:center;max-width:48rem;margin:auto}.terminal-shell--info .terminal-shell__title{font-size:1.75rem}.terminal-shell--info .terminal-shell__copy{font-size:1rem}@media(max-width:680px){.terminal-shell{padding:.75rem}.terminal-shell__header,.terminal-shell__config{align-items:stretch;flex-direction:column}.terminal-shell__badge{max-width:100%;align-self:flex-start}}", g = "backend-terminal.sidecar-url";
function v() {
  return location.protocol === "http:" && location.hostname === "localhost" ? "http://localhost:18080" : location.protocol === "http:" && location.hostname === "127.0.0.1" ? "http://127.0.0.1:18080" : `${location.origin}/terminal-sidecar`;
}
function K() {
  const r = window.__AGENT_CANVAS_SESSION_API_KEY__;
  if (typeof r == "string" && r.length >= 8) return r;
  try {
    const e = sessionStorage.getItem("openhands-active-backend") ?? localStorage.getItem("openhands-active-backend"), n = e ? JSON.parse(e) : null, i = JSON.parse(localStorage.getItem("openhands-backends") ?? "[]");
    if (typeof n == "object" && n !== null && "backendId" in n && typeof n.backendId == "string" && Array.isArray(i)) {
      const m = i.find((o) => typeof o == "object" && o !== null && "id" in o && o.id === n.backendId && "kind" in o && o.kind === "local" && "apiKey" in o && typeof o.apiKey == "string");
      if (m?.apiKey && m.apiKey.length >= 8) return m.apiKey;
    }
    const l = JSON.parse(localStorage.getItem("openhands-agent-server-config") ?? "null");
    if (typeof l == "object" && l !== null && "sessionApiKey" in l && typeof l.sessionApiKey == "string" && l.sessionApiKey.length >= 8) return l.sessionApiKey;
  } catch {
    return null;
  }
  return null;
}
function a(r, e, n) {
  const i = document.createElement(r);
  return e && (i.className = e), n !== void 0 && (i.textContent = n), i;
}
function x(r) {
  const e = new URL(r.trim());
  if (e.protocol !== "http:" && e.protocol !== "https:")
    throw new Error("The sidecar URL must use HTTP or HTTPS.");
  if (e.username || e.password || e.search || e.hash)
    throw new Error("The sidecar URL cannot contain credentials, a query, or a fragment.");
  return e.href.replace(/\/$/, "");
}
function E() {
  const r = localStorage.getItem(g);
  if (!r) return v();
  try {
    return x(r);
  } catch {
    return localStorage.removeItem(g), v();
  }
}
function U(r) {
  return r instanceof Error && r.message ? r.message : "Unknown sidecar error";
}
function L(r, e) {
  let n = null;
  const i = a("section", "terminal-shell");
  i.setAttribute("aria-labelledby", "terminal-shell-title");
  const l = a("header", "terminal-shell__header"), m = a("div"), o = a("p", "terminal-shell__eyebrow", "Interactive sidecar"), _ = a("h1", "terminal-shell__title", "Backend Terminal");
  _.id = "terminal-shell-title", m.append(o, _);
  const S = a("span", "terminal-shell__badge", `${r.backend.kind} · ${r.backend.id}`);
  l.append(m, S);
  const u = a("form", "terminal-shell__config"), b = a("label", "terminal-shell__field"), I = a("span", "terminal-shell__label", "Sidecar URL"), c = a("input", "terminal-shell__input");
  c.name = "sidecar-url", c.type = "url", c.required = !0, c.setAttribute("autocomplete", "url"), c.spellcheck = !1, c.value = E(), b.append(I, c);
  const y = a("button", "terminal-shell__button", "Connect");
  y.type = "submit", u.append(b, y);
  const h = a("div", "terminal-shell__status", "Waiting to connect…");
  h.setAttribute("role", "status"), h.setAttribute("aria-live", "polite");
  const w = a("div", "terminal-shell__frame-wrap"), s = a("iframe", "terminal-shell__frame");
  s.title = "Interactive backend terminal", s.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms"), s.referrerPolicy = "no-referrer", w.append(s);
  const A = a(
    "p",
    "terminal-shell__footer",
    "After Agent Server key validation, the sidecar opens a root PTY on the backend machine. Treat access as full machine authority."
  );
  i.append(l, u, h, w, A), e.append(i);
  function p(t, d = "normal") {
    h.textContent = t, h.dataset.tone = d;
  }
  function f() {
    let t;
    try {
      t = x(c.value), localStorage.setItem(g, t);
    } catch (T) {
      p(U(T), "error");
      return;
    }
    n = new URL(t).origin;
    const d = new URL(`${t}/`);
    d.searchParams.set("canvas_origin", location.origin), d.searchParams.set("canvas_session", String(Date.now())), p("Loading the sidecar SPA…", "working"), s.src = d.href;
  }
  u.addEventListener("submit", (t) => {
    t.preventDefault(), f();
  });
  const k = (t) => {
    if (!(t.source !== s.contentWindow || t.origin !== n || typeof t.data != "object" || t.data === null || !("type" in t.data)))
      if (t.data.type === "backend-terminal:credentials-request" && "requestId" in t.data && typeof t.data.requestId == "string" && t.data.requestId.length <= 128) {
        const d = K();
        if (!d) {
          p("No active local backend API key is available.", "error"), s.contentWindow?.postMessage({
            type: "backend-terminal:credentials-error",
            requestId: t.data.requestId,
            message: "Canvas has no active local backend API key."
          }, n);
          return;
        }
        s.contentWindow?.postMessage({
          type: "backend-terminal:credentials",
          requestId: t.data.requestId,
          apiKey: d
        }, n);
      } else t.data.type === "backend-terminal:reconnect" ? f() : t.data.type === "backend-terminal:ready" ? p("Interactive terminal ready.") : t.data.type === "backend-terminal:error" && "message" in t.data && typeof t.data.message == "string" && p(t.data.message, "error");
  };
  return window.addEventListener("message", k), f(), () => {
    window.removeEventListener("message", k), s.src = "about:blank", i.remove();
  };
}
function R(r, e) {
  const n = a("section", "terminal-shell terminal-shell--info"), i = a("h1", "terminal-shell__title", e === "help" ? "Sidecar terminal" : "Route not found"), l = a(
    "p",
    "terminal-shell__copy",
    e === "help" ? "Start the backend-local sidecar, then connect to its browser-reachable URL. Canvas sends its active local backend key only through the authenticated iframe/WebSocket handshake; the sidecar validates it live with Agent Server before opening a root PTY." : `Backend Terminal does not provide “${e}”.`
  );
  return n.append(i, l), r.append(n), () => n.remove();
}
function q(r, e) {
  const n = a("style");
  n.dataset.backendTerminal = "styles", n.textContent = P, e.container.append(n);
  const i = e.path.replace(/^\/+|\/+$/g, ""), l = i === "" ? L(r, e.container) : R(e.container, i);
  return () => {
    l(), n.remove();
  };
}
function C(r) {
  if (r.apiVersion !== "1") throw new Error("Backend Terminal requires Canvas host API 1.");
  return r.registerPage("terminal", (e) => q(r, e));
}
export {
  C as activate
};
