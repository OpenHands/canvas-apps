/* vibe — work manager SPA */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* The theme is a workspace setting; localStorage only mirrors it so the head
   script can paint before the board loads. A leftover `vibe.theme` predates
   the move and is handed to the first workspace that opens, then dropped. */
const THEME_HINT_KEY = "vibe.theme.hint";
const LEGACY_THEME_KEY = "vibe.theme";
let legacyTheme = localStorage.getItem(LEGACY_THEME_KEY);

function themeHint() {
  return localStorage.getItem(THEME_HINT_KEY) ?? localStorage.getItem(LEGACY_THEME_KEY);
}

const state = {
  workspaces: { available: [], selected: [] },
  ws: null,              // selected workspace object
  tickets: [],
  drawerTicketId: null,
  pollTimer: null,
  workspaceTimer: null,
  automation: null,      // manager automation status for the selected workspace
  automationTimer: null,
  dragging: null,        // { id, status }
  returnFocus: null,     // element focused before the drawer opened
  // Preferences live on the workspace record, server-side. Until one is open
  // the theme falls back to the paint-time hint the head script reads.
  showVerified: false,
  newTicketFiles: [],    // File objects staged for the next ticket
  theme: themeHint() === "light" ? "light" : "dark",
  chat: null,            // manager chat: {wsId, conversationId, url, messages, cursor, status, action}
  chatTimer: null,
  chatOpen: false,
};

const STATUS_LABEL = {
  pending: "pending",
  in_progress: "in progress",
  needs_input: "needs you",
  finished: "finished",
  verified: "verified",
};
const UNFINISHED_STATUSES = new Set(["pending", "in_progress", "needs_input"]);

// Execution statuses in which a worker conversation has stopped acting: its
// last action line is history, so the card shows a checkmark, not a pulse.
const DONE_CONV_STATUSES = new Set([
  "finished", "idle", "error", "stuck", "paused", "deleted",
]);

// The ten primary colours a workspace can pick. Mirrors ACCENTS in app.py
// (which validates the PATCH) and the --accent-<id> tokens in style.css.
const ACCENTS = [
  { id: "ember", label: "Ember" },
  { id: "amber", label: "Amber" },
  { id: "citron", label: "Citron" },
  { id: "jade", label: "Jade" },
  { id: "teal", label: "Teal" },
  { id: "azure", label: "Azure" },
  { id: "iris", label: "Iris" },
  { id: "orchid", label: "Orchid" },
  { id: "rose", label: "Rose" },
  { id: "slate", label: "Slate" },
];
const DEFAULT_ACCENT = "ember";

// Spend cap (USD) a new request gets unless the user changes it. Mirrors
// DEFAULT_TICKET_BUDGET in app.py and the value in index.html's budget input.
const DEFAULT_BUDGET = 10;

// An empty lane is an invitation to act, not a blank box.
const LANE_EMPTY = {
  pending: "Nothing queued. Send a request above.",
  in_progress: "No agent is working right now.",
  needs_input: "Nothing is waiting on you.",
  finished: "Finished work lands here for a look.",
  verified: "Verified work is filed here.",
};

/* ------------------------------------------------------------------ api */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.json();
}

/* ------------------------------------------------------------ attachments */

// Raw-body upload (no multipart): file bytes as the POST body, name in query.
async function uploadAttachment(ticketId, file) {
  const res = await fetch(
    `/api/tickets/${ticketId}/attachments?filename=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    },
  );
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(`${file.name}: ${detail}`);
  }
  return res.json();
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(contentType) {
  return (contentType || "").startsWith("image/");
}

function attachmentEl(a) {
  const link = document.createElement("a");
  link.href = a.url;
  link.target = "_blank";
  link.rel = "noopener";
  link.title = `${a.filename} · ${fmtSize(a.size)}`;
  if (isImage(a.content_type)) {
    link.className = "att att-thumb";
    const img = document.createElement("img");
    img.src = a.url;
    img.alt = a.filename;
    img.loading = "lazy";
    link.appendChild(img);
  } else {
    link.className = "att att-file";
    link.textContent = `📎 ${a.filename}`;
  }
  const size = document.createElement("span");
  size.className = "att-size";
  size.textContent = isImage(a.content_type) ? "" : ` ${fmtSize(a.size)}`;
  link.appendChild(size);
  return link;
}

/* ----------------------------------------------------------- workspaces */

async function loadWorkspaces() {
  const data = await api("/api/workspaces");
  state.workspaces = data;
  const sel = $("#workspace-select");
  const current = sel.value;
  sel.innerHTML = '<option value="">Choose a workspace</option>';

  const selectedPaths = new Set(data.selected.map((w) => w.path));
  if (data.selected.length) {
    const og = document.createElement("optgroup");
    og.label = "active";
    for (const w of data.selected) {
      const o = document.createElement("option");
      o.value = w.path;
      o.textContent = w.name;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  const avail = data.available.filter((a) => !selectedPaths.has(a.path));
  if (avail.length) {
    const og = document.createElement("optgroup");
    og.label = "available";
    for (const a of avail) {
      const o = document.createElement("option");
      o.value = a.path;
      o.textContent = a.name;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  sel.value = current || (localStorage.getItem("vibe.workspace") ?? "");
  renderWorkspaceIndicators();
}

function renderWorkspaceIndicators() {
  const wrap = $("#workspace-indicators");
  wrap.replaceChildren();
  for (const workspace of state.workspaces.selected) {
    const count = Number(workspace.unfinished_count) || 0;
    if (!count) continue;
    if (workspace.id === state.ws?.id) continue;
    const item = document.createElement("span");
    item.className = "workspace-indicator-item";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-indicator";
    button.dataset.path = workspace.path;
    button.dataset.accent = workspace.accent || DEFAULT_ACCENT;
    button.textContent = String(count);
    button.setAttribute(
      "aria-label",
      `${workspace.name}: ${count} unfinished ${count === 1 ? "card" : "cards"}`,
    );
    const tooltip = document.createElement("span");
    tooltip.id = `workspace-indicator-tooltip-${workspace.id}`;
    tooltip.className = "workspace-indicator-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.textContent = workspace.name;
    button.setAttribute("aria-describedby", tooltip.id);
    item.append(button, tooltip);
    wrap.appendChild(item);
  }
}

/* URL scheme: /workspace/<name> deep-links to a workspace (SPA route). */
function workspaceURL(name) {
  return name ? `/workspace/${encodeURIComponent(name)}` : "/";
}

function workspaceNameFromURL() {
  const m = location.pathname.match(/^\/workspace\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function workspacePathFromName(name) {
  const all = [...(state.workspaces.selected || []), ...(state.workspaces.available || [])];
  return all.find((w) => w.name === name)?.path ?? null;
}

function syncURL(mode) {
  if (mode === "none") return;
  const url = workspaceURL(state.ws?.name);
  if (mode === "replace") history.replaceState({}, "", url);
  else if (location.pathname !== url) history.pushState({}, "", url);
}

async function selectWorkspace(path, { historyMode = "push" } = {}) {
  // A manager chat belongs to one workspace's board.
  closeManagerChat();
  state.chat = null;
  if (!path) {
    state.ws = null;
    localStorage.removeItem("vibe.workspace");
    syncURL(historyMode);
    render();
    return;
  }
  try {
    const ws = await api("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    state.ws = ws;
    state.automation = null;
    adoptWorkspacePrefs();
    localStorage.setItem("vibe.workspace", path);
    syncURL(historyMode);
    await refreshBoard();
    startPolling();
    await loadWorkspaces();
    $("#workspace-select").value = path;
  } catch (e) {
    console.error(`workspace error: ${e.message}`);
  }
  render();
}

/* ---------------------------------------------------------------- board */

async function refreshBoard() {
  if (!state.ws) return;
  try {
    const data = await api(`/api/workspaces/${state.ws.id}/board`);
    state.ws = data.workspace;
    state.tickets = data.tickets;
    const listed = state.workspaces.selected.find((workspace) => workspace.id === state.ws.id);
    if (listed) {
      listed.unfinished_count = state.tickets.filter(
        (ticket) => UNFINISHED_STATUSES.has(ticket.status),
      ).length;
    }
    renderWorkspaceIndicators();
    adoptWorkspacePrefs();
    renderBoard();
    renderSettings();
    if (state.drawerTicketId) renderDrawer();
  } catch (e) {
    console.error(e);
  }
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refreshBoard, 5000);
  clearInterval(state.automationTimer);
  state.automationTimer = setInterval(refreshAutomation, 15000);
  refreshAutomation();
}

/* ------------------------------------------------- manager automation badge */

async function refreshAutomation() {
  if (!state.ws) return;
  try {
    state.automation = await api(`/api/workspaces/${state.ws.id}/automation`);
  } catch (e) {
    console.error(e);
  }
  renderMgrBadge();
}

function fmtAgo(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const TRIGGER_HINT = "Click to run the manager now";

async function triggerManager() {
  if (!state.ws || !state.ws.automation_id) return;
  const badge = $("#mgr-badge");
  if (badge.classList.contains("triggering")) return;
  badge.classList.add("triggering");
  $("#mgr-text").textContent = "manager: triggering…";
  try {
    await api(`/api/workspaces/${state.ws.id}/automation/trigger`, { method: "POST" });
  } catch (e) {
    console.error(`manager trigger failed: ${e.message}`);
  }
  badge.classList.remove("triggering");
  refreshAutomation();
}

function renderMgrBadge() {
  const badge = $("#mgr-badge");
  const group = $("#mgr-group");
  if (!state.ws || !state.ws.automation_id) {
    badge.hidden = true;
    group.hidden = true;
    return;
  }
  badge.hidden = false;
  group.hidden = false;
  badge.classList.remove("ok", "err", "paused");
  const a = state.automation;
  const text = $("#mgr-text");
  if (badge.classList.contains("triggering")) return;
  if (!a || a.automation_id !== state.ws.automation_id) {
    text.textContent = "manager";
    badge.title = `Manager automation is watching this workspace\n${TRIGGER_HINT}`;
    return;
  }
  // Judge health by the last *finished* run so an in-flight retry (with a
  // once-a-minute cron, one is almost always in flight while runs keep
  // failing) can't mask a failure streak behind a neutral "polling" state.
  const fin = a.last_finished_run;
  const lr = fin || a.last_run;
  const lastWhen = lr ? fmtAgo(lr.completed_at || lr.started_at || lr.created_at) : "";
  const runsFailing = !!(fin && fin.status !== "COMPLETED");
  const convStatus = a.manager_conversation?.status;
  const convRunning = convStatus === "running";
  const convFailing = convStatus === "error" || convStatus === "stuck";
  const tip = [];
  let label, cls = "";
  if (a.error) {
    label = "manager: unknown"; cls = "err"; tip.push(a.error);
  } else if (a.enabled === false) {
    label = "manager: paused"; cls = "paused"; tip.push("Automation is disabled");
  } else if (runsFailing) {
    label = `manager ✗ ${lastWhen}`; cls = "err";
    if (a.consecutive_failures > 1) tip.push(`${a.consecutive_failures} runs failed in a row`);
    if (a.run_active) tip.push("retry run in progress");
    if (convRunning) tip.push("manager agent conversation still running");
  } else if (convFailing) {
    label = `manager: agent ${convStatus}`; cls = "err";
    tip.push(`Manager agent conversation is ${convStatus}`);
  } else if (convRunning) {
    label = "manager: working";
    tip.push("Manager agent conversation is running right now");
  } else if (a.run_active) {
    label = "manager: polling";
    tip.push("Automation run in progress");
  } else if (lr) {
    label = `manager ✓ ${lastWhen}`;
    cls = "ok";
  } else {
    label = "manager";
  }
  if (lr) {
    tip.push(`last run: ${(lr.status || "?").toLowerCase()} ${lastWhen}`.trim());
    if (lr.error_detail) tip.push(`error: ${lr.error_detail}`);
  }
  if (a.last_triggered_at) tip.push(`last triggered ${fmtAgo(a.last_triggered_at)}`);
  if (a.manager_conversation) tip.push(`manager agent: ${a.manager_conversation.status}`);
  tip.push(TRIGGER_HINT);
  text.textContent = label;
  if (cls) badge.classList.add(cls);
  badge.title = tip.join("\n");
}

function render() {
  const has = !!state.ws;
  $("#empty-state").hidden = has;
  $("#board-wrap").hidden = !has;
  $("#ctl-concurrency").hidden = !has;
  $("#ctl-settings").hidden = !has;
  $("#ctl-accent").hidden = !has;
  $("#manager-chat-open").hidden = !has;
  if (!has) { closeAccentMenu(); closeSettingsMenu(); }
  applyAccent();
  applyTheme();
  renderMgrBadge();
  if (has) { renderBoard(); renderSettings(); }
}

/* Mirror the workspace's stored settings into the controls. Called on every
   board poll, so an input the user is editing is left alone. */
function renderSettings() {
  if (!state.ws) return;
  const mc = $("#max-concurrent");
  if (document.activeElement !== mc) mc.value = state.ws.max_concurrent;
  const budget = $("#settings-budget");
  if (document.activeElement !== budget) budget.value = state.ws.max_budget ?? DEFAULT_BUDGET;
  const profile = $("#settings-profile");
  if (document.activeElement !== profile) profile.value = state.ws.llm_profile ?? "";
  $$("#push-mode .seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === state.ws.push_mode));
  applyAccent();
  applyTheme();
  renderVerifiedToggle();
  renderMgrBadge();
}

/* The board payload is the source of truth for the UI preferences: adopt them
   whenever a workspace's record arrives. */
function adoptWorkspacePrefs() {
  if (!state.ws) return;
  state.showVerified = !!state.ws.show_verified;
  const legacy = legacyTheme;
  legacyTheme = null;
  if (legacy && legacy !== state.ws.theme) {
    // A preference from when the theme was browser state: keep what the user
    // was looking at and hand it to the workspace, once.
    state.theme = legacy === "light" ? "light" : "dark";
    localStorage.removeItem(LEGACY_THEME_KEY);
    patchWorkspace({ theme: state.theme });
    return;
  }
  state.theme = state.ws.theme === "light" ? "light" : "dark";
}

function shortModel(model) {
  // "anthropic/claude-fable-5" -> "claude-fable-5"; keep the full name in the tooltip.
  return model.split("/").pop();
}

function modelChip(model) {
  const chip = document.createElement("span");
  chip.className = "chip model";
  chip.title = model;
  chip.textContent = `◆ ${shortModel(model)}`;
  return chip;
}

function fmtUsd(n) {
  return `$${Number(n).toFixed(2)}`;
}

/* Spend against the ticket's budget. Nothing has run yet -> $0.00 of the
   budget; a ticket predating budgets has no cap, so only the spend shows. */
function budgetChip(t) {
  const budget = Number(t.max_budget);
  const hasBudget = Number.isFinite(budget) && budget > 0;
  const spend = t.spend_usd == null ? null : Number(t.spend_usd);
  const hasSpend = spend !== null && Number.isFinite(spend);
  if (!hasBudget && !hasSpend) return null;
  const spent = hasSpend ? spend : 0;
  const chip = document.createElement("span");
  chip.className = "chip budget";
  if (hasBudget) {
    chip.textContent = `${fmtUsd(spent)} / ${fmtUsd(budget)}`;
    chip.title = `spent ${fmtUsd(spent)} of the ${fmtUsd(budget)} budget`;
    if (spent >= budget) chip.classList.add("over");
  } else {
    chip.textContent = fmtUsd(spent);
    chip.title = `spent ${fmtUsd(spent)} — no budget set`;
  }
  return chip;
}

function workerDone(t) {
  return DONE_CONV_STATUSES.has(t.conversation_status);
}

function activityNodes(act, done) {
  const mark = document.createElement("span");
  mark.className = done ? "activity-check" : "activity-dot";
  if (done) mark.textContent = "✓";
  const text = document.createElement("span");
  text.className = "activity-text";
  text.textContent = act.summary;
  return [mark, text];
}

function cardEl(t) {
  const firstEntry = t.entries[0]?.body ?? "";
  const el = document.createElement("div");
  el.className = "card";
  el.dataset.id = t.id;
  // finished + verified columns are time-ordered (most recent first), not
  // priority-ordered, so their cards aren't draggable.
  el.draggable = t.status !== "verified" && t.status !== "finished";
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", `Open request ${t.title || t.entries[0]?.body?.slice(0, 60) || t.id.slice(0, 6)}`);

  if (t.title) {
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = t.title;
    el.appendChild(title);
  }

  const body = document.createElement("div");
  body.className = "card-body";
  body.textContent = firstEntry;
  el.appendChild(body);

  if (t.manager_note) {
    const note = document.createElement("div");
    note.className = "card-note";
    note.textContent = `⚑ ${t.manager_note}`;
    el.appendChild(note);
  }

  if (t.status === "in_progress" && t.latest_action?.summary) {
    const done = workerDone(t);
    if (!done) el.classList.add("live");
    const act = document.createElement("div");
    act.className = done ? "card-activity done" : "card-activity";
    act.title = t.latest_action.tool ? `tool: ${t.latest_action.tool}` : "";
    act.append(...activityNodes(t.latest_action, done));
    el.appendChild(act);
  }

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.innerHTML = `<span>#${t.id.slice(0, 6)}</span>`;
  if (t.llm_model) meta.appendChild(modelChip(t.llm_model));
  const budget = budgetChip(t);
  if (budget) meta.appendChild(budget);
  if (t.status === "verified" && t.verified_at) {
    const when = document.createElement("span");
    when.className = "chip verified";
    when.textContent = `✓ ${fmtTime(t.verified_at)}`;
    meta.appendChild(when);
  }
  if (t.entries.length > 1) {
    const chip = document.createElement("span");
    chip.className = "chip entries";
    chip.textContent = `${t.entries.length} entries`;
    meta.appendChild(chip);
  }
  if ((t.attachments || []).length) {
    const chip = document.createElement("span");
    chip.className = "chip attachments";
    chip.textContent = `📎 ${t.attachments.length}`;
    meta.appendChild(chip);
  }
  if (t.conversation_url) {
    const a = document.createElement("a");
    a.className = "chip convo";
    a.href = t.conversation_url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "↗ conversation";
    a.addEventListener("click", (e) => e.stopPropagation());
    meta.appendChild(a);
  }
  if (t.pr_url) {
    const a = document.createElement("a");
    a.className = "chip pr";
    a.href = t.pr_url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "↗ pull request";
    a.addEventListener("click", (e) => e.stopPropagation());
    meta.appendChild(a);
  }
  el.appendChild(meta);

  if (t.status === "finished") {
    const btn = document.createElement("button");
    btn.className = "verify-btn";
    btn.textContent = "Mark verified";
    btn.addEventListener("click", (e) => { e.stopPropagation(); verifyTicket(t.id); });
    el.appendChild(btn);
  }

  if (el.draggable) {
    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.textContent = "⋮⋮";
    el.appendChild(handle);
  }

  el.addEventListener("click", () => openDrawer(t.id));
  el.addEventListener("keydown", (e) => {
    if (e.target !== el) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDrawer(t.id); }
  });
  el.addEventListener("dragstart", (e) => {
    state.dragging = { id: t.id, status: t.status };
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", t.id);
  });
  el.addEventListener("dragend", () => {
    el.classList.remove("dragging");
    $$(".card").forEach((c) => c.classList.remove("drop-above", "drop-below"));
    state.dragging = null;
  });
  el.addEventListener("dragover", (e) => {
    if (!state.dragging || state.dragging.id === t.id || state.dragging.status !== t.status) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const above = e.clientY < rect.top + rect.height / 2;
    el.classList.toggle("drop-above", above);
    el.classList.toggle("drop-below", !above);
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop-above", "drop-below"));
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    if (!state.dragging || state.dragging.status !== t.status) return;
    const rect = el.getBoundingClientRect();
    const above = e.clientY < rect.top + rect.height / 2;
    el.classList.remove("drop-above", "drop-below");
    await reorderWithin(t.status, state.dragging.id, t.id, above);
  });
  return el;
}

function renderBoard() {
  $(`.col[data-status="verified"]`).hidden = !state.showVerified;
  $("#board").classList.toggle("show-verified", state.showVerified);
  for (const status of Object.keys(STATUS_LABEL)) {
    const container = $(`.col-cards[data-status="${status}"]`);
    container.innerHTML = "";
    const tickets = state.tickets
      .filter((t) => t.status === status)
      .sort((a, b) =>
        status === "verified"
          ? (b.verified_at ?? b.updated_at) - (a.verified_at ?? a.updated_at)
          : status === "finished"
            ? (b.finished_at ?? b.updated_at) - (a.finished_at ?? a.updated_at)
            : a.sort_order - b.sort_order || a.created_at - b.created_at);
    if (tickets.length) {
      for (const t of tickets) container.appendChild(cardEl(t));
    } else {
      const empty = document.createElement("p");
      empty.className = "lane-empty";
      empty.textContent = LANE_EMPTY[status];
      container.appendChild(empty);
    }
    $(`.col[data-status="${status}"] .col-count`).textContent = tickets.length || "";
  }
}

async function reorderWithin(status, draggedId, targetId, above) {
  const ordered = state.tickets
    .filter((t) => t.status === status)
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at)
    .map((t) => t.id)
    .filter((id) => id !== draggedId);
  const idx = ordered.indexOf(targetId);
  ordered.splice(above ? idx : idx + 1, 0, draggedId);
  // optimistic update
  ordered.forEach((id, i) => {
    const t = state.tickets.find((x) => x.id === id);
    if (t) t.sort_order = i;
  });
  renderBoard();
  try {
    await api(`/api/workspaces/${state.ws.id}/reorder`, {
      method: "POST",
      body: JSON.stringify({ status, ordered_ids: ordered }),
    });
  } catch (e) {
    console.error(`reorder failed: ${e.message}`);
    refreshBoard();
  }
}

/* --------------------------------------------------------------- tickets */

/* The ⚙ popover in the topbar: which agent runs a request, how much it may
   spend, and where its changes land. All three are workspace settings stored
   server-side. Defaults are "manager's choice" (empty profile — the manager
   keeps picking per task) and DEFAULT_BUDGET. */

function toggleSettingsMenu() {
  const menu = $("#settings-menu");
  menu.hidden = !menu.hidden;
  $("#settings-toggle").setAttribute("aria-expanded", String(!menu.hidden));
  $("#settings-toggle").classList.toggle("active", !menu.hidden);
}

function closeSettingsMenu() {
  $("#settings-menu").hidden = true;
  $("#settings-toggle").setAttribute("aria-expanded", "false");
  $("#settings-toggle").classList.remove("active");
}

async function loadLLMProfiles() {
  const sel = $("#settings-profile");
  let data;
  try {
    data = await api("/api/manager/llm-profiles");
  } catch (e) {
    console.error(`model list unavailable: ${e.message}`);
    return;
  }
  const chosen = state.ws?.llm_profile ?? sel.value;
  sel.innerHTML = "";
  const managers = document.createElement("option");
  managers.value = "";
  managers.textContent = "Manager's choice";
  sel.appendChild(managers);
  for (const p of data.profiles || []) {
    const o = document.createElement("option");
    o.value = p.name;
    o.textContent = p.name === data.active_profile ? `${p.name} (default)` : p.name;
    o.title = p.model || "";
    sel.appendChild(o);
  }
  sel.value = chosen;
}

function ticketSettings() {
  const budget = Number(state.ws?.max_budget);
  return {
    llm_profile: state.ws?.llm_profile || null,
    max_budget: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET,
  };
}

async function submitTicket() {
  const ta = $("#new-ticket-body");
  const body = ta.value.trim();
  if (!body || !state.ws) return;
  const btn = $("#new-ticket-submit");
  btn.disabled = true;
  try {
    const ticket = await api(`/api/workspaces/${state.ws.id}/tickets`, {
      method: "POST",
      body: JSON.stringify({ body, ...ticketSettings() }),
    });
    ta.value = "";
    const files = state.newTicketFiles.splice(0);
    renderNewTicketFiles();
    const failed = [];
    for (const f of files) {
      try { await uploadAttachment(ticket.id, f); }
      catch (e) { failed.push(e.message); }
    }
    if (failed.length) console.error(`ticket submitted, but upload failed: ${failed.join("; ")}`);
    await refreshBoard();
  } catch (e) {
    console.error(`submit failed: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

function renderNewTicketFiles() {
  const wrap = $("#new-ticket-files");
  wrap.innerHTML = "";
  wrap.hidden = !state.newTicketFiles.length;
  state.newTicketFiles.forEach((f, i) => {
    const chip = document.createElement("span");
    chip.className = "file-chip";
    chip.textContent = `${isImage(f.type) ? "🖼" : "📎"} ${f.name} · ${fmtSize(f.size)}`;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "file-chip-rm";
    rm.textContent = "✕";
    rm.title = "remove";
    rm.addEventListener("click", () => {
      state.newTicketFiles.splice(i, 1);
      renderNewTicketFiles();
    });
    chip.appendChild(rm);
    wrap.appendChild(chip);
  });
}

async function uploadDrawerFiles(files) {
  if (!state.drawerTicketId || !files.length) return;
  const failed = [];
  for (const f of files) {
    try { await uploadAttachment(state.drawerTicketId, f); }
    catch (e) { failed.push(e.message); }
  }
  if (failed.length) console.error(`upload failed: ${failed.join("; ")}`);
  await refreshBoard();
}

async function verifyTicket(id) {
  try {
    await api(`/api/tickets/${id}/verify`, { method: "POST" });
    await refreshBoard();
  } catch (e) {
    console.error(`verify failed: ${e.message}`);
  }
}

function toggleVerified() {
  state.showVerified = !state.showVerified;
  renderVerifiedToggle();
  renderBoard();
  patchWorkspace({ show_verified: state.showVerified });
}

/* Icon-only, so the label it would have carried lives in the tooltip and the
   accessible name instead. */
function renderVerifiedToggle() {
  const btn = $("#show-verified");
  const label = state.showVerified ? "Hide verified" : "Show verified";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.setAttribute("aria-pressed", String(state.showVerified));
  btn.classList.toggle("active", state.showVerified);
}

/* ---------------------------------------------------------------- drawer */

function openDrawer(ticketId) {
  state.returnFocus = document.activeElement;
  state.drawerTicketId = ticketId;
  $("#drawer").hidden = false;
  renderDrawer();
  $("#append-body").focus();
}

function closeDrawer() {
  if (!state.drawerTicketId) return;
  state.drawerTicketId = null;
  $("#drawer").hidden = true;
  const back = state.returnFocus;
  state.returnFocus = null;
  if (back?.isConnected) back.focus();
}

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleString([], {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function renderDrawer() {
  const t = state.tickets.find((x) => x.id === state.drawerTicketId);
  if (!t) { closeDrawer(); return; }
  const st = $("#drawer-status");
  st.textContent = STATUS_LABEL[t.status];
  st.dataset.s = t.status;
  $("#drawer-id").textContent = `#${t.id}`;
  const title = $("#drawer-title");
  title.hidden = !t.title;
  title.textContent = t.title || "";

  const links = $("#drawer-links");
  links.innerHTML = "";
  if (t.conversation_url) {
    const a = document.createElement("a");
    a.className = "chip convo";
    a.href = t.conversation_url; a.target = "_blank"; a.rel = "noopener";
    a.textContent = "↗ open conversation";
    links.appendChild(a);
  }
  if (t.pr_url) {
    const a = document.createElement("a");
    a.className = "chip pr";
    a.href = t.pr_url; a.target = "_blank"; a.rel = "noopener";
    a.textContent = "↗ open pull request";
    links.appendChild(a);
  }
  if (t.llm_model) links.appendChild(modelChip(t.llm_model));
  const budget = budgetChip(t);
  if (budget) links.appendChild(budget);

  const note = $("#drawer-note");
  note.hidden = !t.manager_note;
  note.textContent = t.manager_note ? `⚑ manager: ${t.manager_note}` : "";

  const activity = $("#drawer-activity");
  const act = t.status === "in_progress" ? t.latest_action : null;
  const done = workerDone(t);
  activity.hidden = !act?.summary;
  activity.innerHTML = "";
  activity.classList.toggle("done", !!act?.summary && done);
  if (act?.summary) {
    activity.title = act.tool ? `tool: ${act.tool}` : "";
    activity.append(...activityNodes(act, done));
  }

  const atts = $("#drawer-attachments");
  atts.innerHTML = "";
  atts.hidden = !(t.attachments || []).length;
  for (const a of t.attachments || []) atts.appendChild(attachmentEl(a));

  const thread = $("#drawer-thread");
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
  thread.innerHTML = "";
  for (const e of t.entries) {
    const div = document.createElement("div");
    div.className = "entry";
    const head = document.createElement("div");
    head.className = "entry-head";
    head.innerHTML = `<span class="entry-author-${e.author}">${e.author}</span><span>${fmtTime(e.created_at)}</span>`;
    const body = document.createElement("div");
    body.className = "entry-body";
    body.textContent = e.body;
    div.append(head, body);
    thread.appendChild(div);
  }
  if (atBottom) thread.scrollTop = thread.scrollHeight;
}

async function appendEntry() {
  const ta = $("#append-body");
  const body = ta.value.trim();
  if (!body || !state.drawerTicketId) return;
  try {
    await api(`/api/tickets/${state.drawerTicketId}/entries`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    ta.value = "";
    await refreshBoard();
  } catch (e) {
    console.error(`append failed: ${e.message}`);
  }
}

/* ---------------------------------------------------------- manager chat */

/* "Talk to the manager" opens a conversation of its own, pre-loaded by the
   backend with the manager skill (app.py's manager_chat_skill): it records
   what the user asks for in AGENTS.md and reads the board and its worker
   conversations back to them. It is NOT the cron manager that dispatches
   work, so nothing here touches the topbar badge. */

const CHAT_POLL_MS = 2000;
const CHAT_AUTHOR = { user: "you", assistant: "manager" };

async function openManagerChat() {
  if (!state.ws) return;
  state.chatReturnFocus = document.activeElement;
  state.chatOpen = true;
  $("#manager-chat").hidden = false;
  if (state.chat && state.chat.wsId !== state.ws.id) state.chat = null;
  renderManagerChat();
  $("#manager-chat-body").focus();
  if (!state.chat) await startManagerChat();
  startChatPolling();
}

function closeManagerChat() {
  if (!state.chatOpen) return;
  state.chatOpen = false;
  $("#manager-chat").hidden = true;
  clearInterval(state.chatTimer);
  const back = state.chatReturnFocus;
  state.chatReturnFocus = null;
  if (back?.isConnected) back.focus();
}

async function startManagerChat() {
  const wsId = state.ws.id;
  const chat = {
    wsId, conversationId: null, url: null,
    messages: [], cursor: null, status: null, action: null, error: null,
  };
  state.chat = chat;
  renderManagerChat();
  try {
    const d = await api(`/api/workspaces/${wsId}/manager-chat`, { method: "POST" });
    if (state.chat !== chat) return;  // workspace changed while we were starting
    chat.conversationId = d.conversation_id;
    chat.url = d.conversation_url;
  } catch (e) {
    console.error(`manager chat failed to start: ${e.message}`);
    chat.error = e.message;
  }
  renderManagerChat();
}

function startChatPolling() {
  clearInterval(state.chatTimer);
  state.chatTimer = setInterval(pollManagerChat, CHAT_POLL_MS);
  pollManagerChat();
}

async function pollManagerChat() {
  const chat = state.chat;
  if (!chat?.conversationId) return;
  // The cursor is the newest event seen, not the newest message, so a manager
  // busy running tools doesn't get its whole event log re-read every poll.
  const q = chat.cursor ? `?after=${encodeURIComponent(chat.cursor)}` : "";
  try {
    const d = await api(
      `/api/workspaces/${chat.wsId}/manager-chat/${chat.conversationId}/messages${q}`);
    if (state.chat !== chat) return;
    chat.cursor = d.cursor ?? chat.cursor;
    chat.status = d.status;
    if (d.latest_action) chat.action = d.latest_action;
    if (d.messages.length) chat.messages.push(...d.messages);
  } catch (e) {
    console.error(`manager chat poll failed: ${e.message}`);
  }
  renderManagerChat();
}

async function sendChatMessage() {
  const ta = $("#manager-chat-body");
  const body = ta.value.trim();
  const chat = state.chat;
  if (!body || !chat?.conversationId) return;
  const btn = $("#manager-chat-send");
  btn.disabled = true;
  try {
    await api(
      `/api/workspaces/${chat.wsId}/manager-chat/${chat.conversationId}/messages`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
    ta.value = "";
    // The message is an event on the conversation now, so the poll renders it
    // — no optimistic copy to reconcile.
    await pollManagerChat();
  } catch (e) {
    console.error(`manager chat send failed: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

function chatMessageEl(m) {
  const el = document.createElement("div");
  el.className = `chat-msg ${m.role}`;
  const head = document.createElement("div");
  head.className = "chat-msg-head";
  head.textContent = CHAT_AUTHOR[m.role] ?? m.role;
  const body = document.createElement("div");
  body.className = "chat-msg-body";
  body.textContent = m.text;
  el.append(head, body);
  return el;
}

function renderChatActivity() {
  const el = $("#manager-chat-activity");
  el.innerHTML = "";
  const chat = state.chat;
  if (!chat) return;
  const working = !!chat.conversationId && !DONE_CONV_STATUSES.has(chat.status);
  const text = chat.error ? "not connected"
    : !chat.conversationId ? "starting the manager…"
    : working ? (chat.action?.summary || "thinking…")
    : "waiting for you";
  el.classList.toggle("done", !working);
  el.append(...activityNodes({ summary: text }, !working));
}

function renderManagerChat() {
  const chat = state.chat;
  const link = $("#manager-chat-link");
  link.hidden = !chat?.url;
  if (chat?.url) link.href = chat.url;

  const log = $("#manager-chat-log");
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.innerHTML = "";
  if (chat?.messages.length) {
    for (const m of chat.messages) log.appendChild(chatMessageEl(m));
  } else {
    const empty = document.createElement("p");
    empty.className = "lane-empty";
    empty.textContent = chat?.error
      ? `Could not reach the manager: ${chat.error}`
      : "Waking the manager up — it reads AGENTS.md and the board first.";
    log.appendChild(empty);
  }
  renderChatActivity();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

/* -------------------------------------------------------------- settings */

async function patchWorkspace(patch) {
  if (!state.ws) return;
  try {
    state.ws = await api(`/api/workspaces/${state.ws.id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    renderSettings();
  } catch (e) {
    console.error(`settings failed: ${e.message}`);
  }
}

/* --------------------------------------------------------- primary colour */

/* The workspace's primary colour drives the whole palette: style.css derives
   every surface, line and control token from --accent, so switching the
   data-accent attribute repaints the board in both light and dark mode. */

function currentAccent() {
  const accent = state.ws?.accent;
  return ACCENTS.some((a) => a.id === accent) ? accent : DEFAULT_ACCENT;
}

function buildAccentMenu() {
  const menu = $("#accent-menu");
  for (const a of ACCENTS) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "accent-swatch";
    swatch.dataset.accent = a.id;
    swatch.setAttribute("role", "menuitemradio");
    swatch.setAttribute("aria-checked", "false");
    swatch.setAttribute("aria-label", a.label);
    swatch.title = a.label;
    swatch.addEventListener("click", () => setAccent(a.id));
    menu.appendChild(swatch);
  }
}

function applyAccent() {
  const accent = currentAccent();
  document.documentElement.dataset.accent = accent;
  // Paint-time hint for the next load; see the inline script in index.html.
  localStorage.setItem("vibe.accent", accent);
  const label = ACCENTS.find((a) => a.id === accent)?.label ?? accent;
  $("#accent-toggle").title = `Primary colour: ${label}`;
  $$("#accent-menu .accent-swatch").forEach((s) =>
    s.setAttribute("aria-checked", String(s.dataset.accent === accent)));
}

function toggleAccentMenu() {
  const menu = $("#accent-menu");
  menu.hidden = !menu.hidden;
  $("#accent-toggle").setAttribute("aria-expanded", String(!menu.hidden));
}

function closeAccentMenu() {
  $("#accent-menu").hidden = true;
  $("#accent-toggle").setAttribute("aria-expanded", "false");
}

async function setAccent(accent) {
  closeAccentMenu();
  if (accent === currentAccent()) return;
  await patchWorkspace({ accent });
}

/* ------------------------------------------------------------------ init */

function ticketKeydown(submit) {
  return (e) => {
    if (e.key !== "Enter") return;
    // Shift+Enter inserts a newline; Enter and Cmd/Ctrl+Enter submit.
    if (e.shiftKey) return;
    e.preventDefault();
    submit();
  };
}

function wire() {
  $("#workspace-select").addEventListener("change", (e) => selectWorkspace(e.target.value));
  $("#workspace-indicators").addEventListener("click", (e) => {
    const button = e.target.closest(".workspace-indicator");
    if (button) selectWorkspace(button.dataset.path);
  });

  $("#new-ticket-form").addEventListener("submit", (e) => { e.preventDefault(); submitTicket(); });
  $("#new-ticket-body").addEventListener("keydown", ticketKeydown(submitTicket));

  $("#new-ticket-attach").addEventListener("click", () => $("#new-ticket-file-input").click());
  $("#new-ticket-file-input").addEventListener("change", (e) => {
    state.newTicketFiles.push(...e.target.files);
    e.target.value = "";
    renderNewTicketFiles();
  });

  $("#append-form").addEventListener("submit", (e) => { e.preventDefault(); appendEntry(); });
  $("#append-body").addEventListener("keydown", ticketKeydown(appendEntry));

  $("#drawer-attach").addEventListener("click", () => $("#drawer-file-input").click());
  $("#drawer-file-input").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    await uploadDrawerFiles(files);
  });

  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#drawer-backdrop").addEventListener("click", closeDrawer);

  $("#manager-chat-open").addEventListener("click", openManagerChat);
  $("#manager-chat-close").addEventListener("click", closeManagerChat);
  $("#manager-chat-backdrop").addEventListener("click", closeManagerChat);
  $("#manager-chat-form").addEventListener("submit", (e) => { e.preventDefault(); sendChatMessage(); });
  $("#manager-chat-body").addEventListener("keydown", ticketKeydown(sendChatMessage));

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeAccentMenu();
    closeSettingsMenu();
    closeManagerChat();
    closeDrawer();
  });

  $("#max-concurrent").addEventListener("change", (e) => {
    const v = parseInt(e.target.value, 10);
    if (v >= 1 && v <= 20) patchWorkspace({ max_concurrent: v });
  });
  $$("#push-mode .seg-btn").forEach((b) =>
    b.addEventListener("click", () => patchWorkspace({ push_mode: b.dataset.mode })));

  $("#settings-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSettingsMenu();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".control-settings")) closeSettingsMenu();
  });
  // "" = manager's choice; the PATCH clears the stored profile.
  $("#settings-profile").addEventListener("change", (e) =>
    patchWorkspace({ llm_profile: e.target.value }));
  $("#settings-budget").addEventListener("change", (e) => {
    const v = parseFloat(e.target.value);
    if (v > 0) patchWorkspace({ max_budget: v });
  });

  $("#show-verified").addEventListener("click", toggleVerified);
  renderVerifiedToggle();

  buildAccentMenu();
  $("#accent-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAccentMenu();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".control-accent")) closeAccentMenu();
  });

  $("#theme-toggle").addEventListener("click", toggleTheme);
  $("#mgr-badge").addEventListener("click", triggerManager);
  $("#mgr-badge").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); triggerManager(); }
  });
  applyTheme();
}

/* ------------------------------------------------------------------ theme */

function applyTheme() {
  const light = state.theme === "light";
  if (light) document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  // Paint-time hint for the next load; see the inline script in index.html.
  localStorage.setItem(THEME_HINT_KEY, state.theme);
  const btn = $("#theme-toggle");
  btn.textContent = light ? "Dark" : "Light";
  btn.title = light ? "Switch to dark mode" : "Switch to light mode";
}

function toggleTheme() {
  state.theme = state.theme === "light" ? "dark" : "light";
  applyTheme();
  patchWorkspace({ theme: state.theme });
}

async function init() {
  wire();
  // The agent server's profiles are workspace-independent; one fetch fills the
  // request-settings picker for the session.
  loadLLMProfiles();
  window.addEventListener("popstate", async () => {
    const name = workspaceNameFromURL();
    const path = name ? workspacePathFromName(name) : null;
    $("#workspace-select").value = path || "";
    await selectWorkspace(path || "", { historyMode: "none" });
  });
  await loadWorkspaces();
  state.workspaceTimer = setInterval(
    () => loadWorkspaces().catch((error) => console.error(error)),
    30000,
  );

  const urlName = workspaceNameFromURL();
  const urlPath = urlName ? workspacePathFromName(urlName) : null;
  const saved = localStorage.getItem("vibe.workspace");
  const savedOk = saved && [...$("#workspace-select").options].some((o) => o.value === saved);
  const target = urlPath || (savedOk ? saved : null);

  if (target) {
    $("#workspace-select").value = target;
    await selectWorkspace(target, { historyMode: "replace" });
  } else {
    if (urlName) console.error(`unknown workspace: ${urlName}`);
    history.replaceState({}, "", "/");
    render();
  }
}

init();
