const u = ".terminal-shell{box-sizing:border-box;display:grid;grid-template-rows:minmax(0,1fr) auto;width:100%;height:100%;min-height:20rem;overflow:hidden;background:#06090d}.terminal-shell__frame{display:block;width:100%;height:100%;min-height:20rem;border:0;background:#06090d}.terminal-shell__error{padding:.55rem .75rem;color:#fecdd3;background:#4c0519;font:13px/1.4 ui-sans-serif,system-ui,sans-serif}.terminal-shell__error[hidden]{display:none}";
function g() {
  return location.protocol === "http:" && location.hostname === "localhost" ? "http://localhost:18080" : location.protocol === "http:" && location.hostname === "127.0.0.1" ? "http://127.0.0.1:18080" : `${location.origin}/terminal-sidecar`;
}
function h() {
  try {
    const r = JSON.parse(localStorage.getItem("openhands-active-backend") ?? "null"), a = JSON.parse(localStorage.getItem("openhands-backends") ?? "[]");
    if (typeof r != "object" || r === null || !("backendId" in r) || typeof r.backendId != "string" || !Array.isArray(a)) return null;
    const n = a.find((t) => typeof t == "object" && t !== null && "id" in t && t.id === r.backendId && "kind" in t && t.kind === "local" && "apiKey" in t && typeof t.apiKey == "string");
    return n?.apiKey && n.apiKey.length >= 8 ? n.apiKey : null;
  } catch {
    return null;
  }
}
function i(r, a, n) {
  const t = document.createElement(r);
  return a && (t.className = a), t;
}
function f(r) {
  const a = i("section", "terminal-shell"), n = i("iframe", "terminal-shell__frame"), t = i("div", "terminal-shell__error");
  t.hidden = !0, t.setAttribute("role", "alert"), t.setAttribute("aria-live", "assertive"), n.title = "Interactive backend terminal", n.setAttribute("sandbox", "allow-scripts allow-same-origin"), n.referrerPolicy = "no-referrer", a.append(n, t), r.append(a);
  const l = g(), o = new URL(l).origin, s = new URL(`${l}/`);
  s.searchParams.set("canvas_origin", location.origin), s.searchParams.set("canvas_session", String(Date.now())), n.src = s.href;
  function d(e = "") {
    t.textContent = e, t.hidden = e.length === 0;
  }
  const c = (e) => {
    if (!(e.source !== n.contentWindow || e.origin !== o || typeof e.data != "object" || e.data === null || !("type" in e.data)))
      if (e.data.type === "backend-terminal:credentials-request" && "requestId" in e.data && typeof e.data.requestId == "string" && e.data.requestId.length <= 128) {
        const m = h();
        if (!m) {
          const p = "Canvas has no active local backend API key.";
          d(p), n.contentWindow?.postMessage({
            type: "backend-terminal:credentials-error",
            requestId: e.data.requestId,
            message: p
          }, o);
          return;
        }
        n.contentWindow?.postMessage({
          type: "backend-terminal:credentials",
          requestId: e.data.requestId,
          apiKey: m
        }, o);
      } else e.data.type === "backend-terminal:ready" ? d() : e.data.type === "backend-terminal:error" && "message" in e.data && typeof e.data.message == "string" && d(e.data.message);
  };
  return window.addEventListener("message", c), () => {
    window.removeEventListener("message", c), n.src = "about:blank", a.remove();
  };
}
function y(r) {
  const a = i("style");
  a.dataset.backendTerminal = "styles", a.textContent = u, r.container.append(a);
  const n = f(r.container);
  return () => {
    n(), a.remove();
  };
}
function b(r) {
  if (r.apiVersion !== "1") throw new Error("Backend Terminal requires Canvas host API 1.");
  return r.registerPage("terminal", y);
}
export {
  b as activate
};
