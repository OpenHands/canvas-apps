const P = ".terminal-shell{--terminal-bg: #080b10;--terminal-panel: #111720;--terminal-line: #283446;--terminal-text: #e6edf5;--terminal-muted: #93a4b8;--terminal-accent: #5eead4;box-sizing:border-box;display:grid;grid-template-rows:auto auto auto minmax(20rem,1fr) auto;gap:.85rem;min-height:100%;padding:1rem;color:var(--terminal-text);background:radial-gradient(circle at 10% 0,#172331 0,var(--terminal-bg) 32rem);font:14px/1.45 ui-sans-serif,system-ui,sans-serif}.terminal-shell *,.terminal-shell *:before,.terminal-shell *:after{box-sizing:border-box}.terminal-shell__header{display:flex;align-items:center;justify-content:space-between;gap:1rem}.terminal-shell__eyebrow{margin:0 0 .15rem;color:var(--terminal-accent);font-size:.72rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.terminal-shell__title{margin:0;font-size:clamp(1.25rem,2vw,1.75rem)}.terminal-shell__badge{max-width:50%;overflow:hidden;padding:.4rem .7rem;border:1px solid var(--terminal-line);border-radius:999px;color:var(--terminal-muted);text-overflow:ellipsis;white-space:nowrap}.terminal-shell__config{display:flex;align-items:end;gap:.6rem}.terminal-shell__field{display:grid;flex:1;gap:.25rem}.terminal-shell__label{color:var(--terminal-muted);font-size:.75rem;font-weight:700}.terminal-shell__input,.terminal-shell__button{min-height:2.6rem;border:1px solid var(--terminal-line);border-radius:.55rem;color:var(--terminal-text);background:var(--terminal-panel);font:inherit}.terminal-shell__input{width:100%;padding:.55rem .7rem;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.terminal-shell__input:focus,.terminal-shell__button:focus-visible{outline:2px solid var(--terminal-accent);outline-offset:2px}.terminal-shell__button{padding:.55rem 1rem;cursor:pointer;font-weight:800}.terminal-shell__button:hover:not(:disabled){border-color:var(--terminal-accent)}.terminal-shell__button:disabled{cursor:wait;opacity:.55}.terminal-shell__status{min-height:1.4rem;color:var(--terminal-muted)}.terminal-shell__status[data-tone=working]{color:#facc15}.terminal-shell__status[data-tone=error]{color:#fb7185}.terminal-shell__frame-wrap{min-height:0;overflow:hidden;border:1px solid var(--terminal-line);border-radius:.75rem;background:#06090d;box-shadow:0 1rem 3rem #0000003d}.terminal-shell__frame{display:block;width:100%;height:100%;min-height:20rem;border:0;background:#06090d}.terminal-shell__footer,.terminal-shell__copy{margin:0;color:var(--terminal-muted);font-size:.78rem}.terminal-shell--info{align-content:center;max-width:48rem;margin:auto}.terminal-shell--info .terminal-shell__title{font-size:1.75rem}.terminal-shell--info .terminal-shell__copy{font-size:1rem}@media(max-width:680px){.terminal-shell{padding:.75rem}.terminal-shell__header,.terminal-shell__config{align-items:stretch;flex-direction:column}.terminal-shell__badge{max-width:100%;align-self:flex-start}}", u = "backend-terminal.sidecar-url";
function k() {
  return location.protocol === "http:" && location.hostname === "localhost" ? "http://localhost:18080" : location.protocol === "http:" && location.hostname === "127.0.0.1" ? "http://127.0.0.1:18080" : `${location.origin}/terminal-sidecar`;
}
function U() {
  try {
    const e = JSON.parse(localStorage.getItem("openhands-active-backend") ?? "null"), t = JSON.parse(localStorage.getItem("openhands-backends") ?? "[]");
    if (typeof e != "object" || e === null || !("backendId" in e) || typeof e.backendId != "string" || !Array.isArray(t)) return null;
    const n = t.find((a) => typeof a == "object" && a !== null && "id" in a && a.id === e.backendId && "kind" in a && a.kind === "local" && "apiKey" in a && typeof a.apiKey == "string");
    return n?.apiKey && n.apiKey.length >= 8 ? n.apiKey : null;
  } catch {
    return null;
  }
}
function l(e, t, n) {
  const a = document.createElement(e);
  return t && (a.className = t), n !== void 0 && (a.textContent = n), a;
}
function v(e) {
  const t = new URL(e.trim());
  if (t.protocol !== "http:" && t.protocol !== "https:")
    throw new Error("The sidecar URL must use HTTP or HTTPS.");
  if (t.username || t.password || t.search || t.hash)
    throw new Error("The sidecar URL cannot contain credentials, a query, or a fragment.");
  return t.href.replace(/\/$/, "");
}
function L() {
  const e = localStorage.getItem(u);
  if (!e) return k();
  try {
    return v(e);
  } catch {
    return localStorage.removeItem(u), k();
  }
}
function q(e) {
  return e instanceof Error && e.message ? e.message : "Unknown sidecar error";
}
function R(e, t) {
  let n = null;
  const a = l("section", "terminal-shell");
  a.setAttribute("aria-labelledby", "terminal-shell-title");
  const c = l("header", "terminal-shell__header"), f = l("div"), x = l("p", "terminal-shell__eyebrow", "Interactive sidecar"), g = l("h1", "terminal-shell__title", "Backend Terminal");
  g.id = "terminal-shell-title", f.append(x, g);
  const I = l("span", "terminal-shell__badge", `${e.backend.kind} · ${e.backend.id}`);
  c.append(f, I);
  const h = l("form", "terminal-shell__config"), b = l("label", "terminal-shell__field"), S = l("span", "terminal-shell__label", "Sidecar URL"), o = l("input", "terminal-shell__input");
  o.name = "sidecar-url", o.type = "url", o.required = !0, o.setAttribute("autocomplete", "url"), o.spellcheck = !1, o.value = L(), b.append(S, o);
  const _ = l("button", "terminal-shell__button", "Connect");
  _.type = "submit", h.append(b, _);
  const d = l("div", "terminal-shell__status", "Waiting to connect…");
  d.setAttribute("role", "status"), d.setAttribute("aria-live", "polite");
  const y = l("div", "terminal-shell__frame-wrap"), i = l("iframe", "terminal-shell__frame");
  i.title = "Interactive backend terminal", i.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms"), i.referrerPolicy = "no-referrer", y.append(i);
  const A = l(
    "p",
    "terminal-shell__footer",
    "After Agent Server key validation, the sidecar opens a root PTY on the backend machine. Treat access as full machine authority."
  );
  a.append(c, h, d, y, A), t.append(a);
  function m(r, s = "normal") {
    d.textContent = r, d.dataset.tone = s;
  }
  function p() {
    let r;
    try {
      r = v(o.value), localStorage.setItem(u, r);
    } catch (T) {
      m(q(T), "error");
      return;
    }
    n = new URL(r).origin;
    const s = new URL(`${r}/`);
    s.searchParams.set("canvas_origin", location.origin), s.searchParams.set("canvas_session", String(Date.now())), m("Loading the sidecar SPA…", "working"), i.src = s.href;
  }
  h.addEventListener("submit", (r) => {
    r.preventDefault(), p();
  });
  const w = (r) => {
    if (!(r.source !== i.contentWindow || r.origin !== n || typeof r.data != "object" || r.data === null || !("type" in r.data)))
      if (r.data.type === "backend-terminal:credentials-request" && "requestId" in r.data && typeof r.data.requestId == "string" && r.data.requestId.length <= 128) {
        const s = U();
        if (!s) {
          m("No active local backend API key is available.", "error"), i.contentWindow?.postMessage({
            type: "backend-terminal:credentials-error",
            requestId: r.data.requestId,
            message: "Canvas has no active local backend API key."
          }, n);
          return;
        }
        i.contentWindow?.postMessage({
          type: "backend-terminal:credentials",
          requestId: r.data.requestId,
          apiKey: s
        }, n);
      } else r.data.type === "backend-terminal:reconnect" ? p() : r.data.type === "backend-terminal:ready" ? m("Interactive terminal ready.") : r.data.type === "backend-terminal:error" && "message" in r.data && typeof r.data.message == "string" && m(r.data.message, "error");
  };
  return window.addEventListener("message", w), p(), () => {
    window.removeEventListener("message", w), i.src = "about:blank", a.remove();
  };
}
function E(e, t) {
  const n = l("section", "terminal-shell terminal-shell--info"), a = l("h1", "terminal-shell__title", t === "help" ? "Sidecar terminal" : "Route not found"), c = l(
    "p",
    "terminal-shell__copy",
    t === "help" ? "Start the backend-local sidecar, then connect to its browser-reachable URL. Canvas sends its active local backend key only through the authenticated iframe/WebSocket handshake; the sidecar validates it live with Agent Server before opening a root PTY." : `Backend Terminal does not provide “${t}”.`
  );
  return n.append(a, c), e.append(n), () => n.remove();
}
function z(e, t) {
  const n = l("style");
  n.dataset.backendTerminal = "styles", n.textContent = P, t.container.append(n);
  const a = t.path.replace(/^\/+|\/+$/g, ""), c = a === "" ? R(e, t.container) : E(t.container, a);
  return () => {
    c(), n.remove();
  };
}
function C(e) {
  if (e.apiVersion !== "1") throw new Error("Backend Terminal requires Canvas host API 1.");
  return e.registerPage("terminal", (t) => z(e, t));
}
export {
  C as activate
};
