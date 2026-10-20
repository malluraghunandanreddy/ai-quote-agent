// AI Quote Agent dashboard — vanilla JS over the FastAPI JSON API.
// Every server value is escaped before insertion: email and spreadsheet content is untrusted.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  status: null, metrics: null, rows: [], view: "enquiries", filter: "", range: "7d", from: "", to: "", q: "",
  lastEventId: 0, openId: null, detail: null, detailSig: "", dtab: "overview", sourceCache: {},
  active: null, trackSeen: {}, flowSeen: { id: null, n: 0 }, flash: new Set(), busy: false, pollMs: 3000, timer: null,
};

// --- icons (simple stroke glyphs) ------------------------------------------------------
const ICONS = {
  inbox: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  sparkles: '<path d="M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 13h6M10 17h6"/>',
  bell: '<path d="M6 16v-5a6 6 0 0112 0v5l2 2H4z"/><path d="M10 20a2 2 0 004 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 3.5l9 16.5H3z"/><path d="M12 10v4.5M12 17.3v.2"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
  bolt: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};
const icon = (name, cls = "w-5 h-5") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">${ICONS[name] || ""}</svg>`;

// --- vocab ----------------------------------------------------------------------------
const STATUS = {
  DRAFT_CREATED: ["Draft created", "bg-emerald-100 text-emerald-800"],
  NEEDS_REVIEW: ["Needs review", "bg-amber-100 text-amber-800"],
  EXCEPTION: ["Exception", "bg-rose-100 text-rose-800"],
  DUPLICATE: ["Duplicate", "bg-slate-200 text-slate-700"],
  IGNORED: ["Not a quote", "bg-zinc-100 text-zinc-600"],
  DISMISSED: ["Dismissed", "bg-zinc-100 text-zinc-600"],
  PROCESSING: ["Processing…", "bg-brand-100 text-brand-800"],
  RETRY_PENDING: ["Retry scheduled", "bg-sky-100 text-sky-800"],
  APPROVED: ["Approved", "bg-emerald-600 text-white"],
  REJECTED: ["Rejected", "bg-zinc-200 text-zinc-700"],
  RECEIVED: ["Received", "bg-brand-100 text-brand-800"],
};
const MATCH = {
  sku: ["code match", "bg-emerald-100 text-emerald-800"],
  name: ["name match", "bg-emerald-100 text-emerald-800"],
  fuzzy: ["fuzzy — verify", "bg-amber-100 text-amber-800"],
  ai: ["AI match — verify", "bg-violet-100 text-violet-800"],
  null: ["not in catalogue", "bg-rose-100 text-rose-800"],
};
const FLAGS = {
  not_found: ["not in product master", "bg-rose-100 text-rose-800"],
  price_missing: ["no price — not assumed", "bg-rose-100 text-rose-800"],
  ambiguous: ["verify match", "bg-amber-100 text-amber-800"],
  unit_mismatch: ["unit mismatch", "bg-amber-100 text-amber-800"],
};
const NOTE_KIND = {
  draft_created: ["draft created → Sales", "bg-brand-100 text-brand-800"],
  info_request: ["info request → Sales", "bg-amber-100 text-amber-800"],
  unmatched_products: ["unmatched products → stakeholders", "bg-rose-100 text-rose-800"],
  customer_review: ["customer review → Sales", "bg-amber-100 text-amber-800"],
  failure: ["processing failure → team", "bg-rose-100 text-rose-800"],
  internal: ["sales notification", "bg-brand-100 text-brand-800"],
  alert: ["stakeholder alert", "bg-rose-100 text-rose-800"],
};
const LEVEL_DOT = { info: "bg-slate-400", success: "bg-emerald-500", warn: "bg-amber-500", error: "bg-rose-500" };
const FLOW = [
  { key: "received", stage: "RECEIVED", label: "Emails received", short: "received", icon: "inbox" },
  { key: "read", stage: "EXTRACT", label: "Read & extracted", short: "extract", icon: "sparkles" },
  { key: "validated", stage: "VALIDATE", label: "Validated", short: "validate", icon: "check" },
  { key: "customer", stage: "MAP_CUSTOMER", label: "Customer matched", short: "customer", icon: "user" },
  { key: "drafted", stage: "ESTIMATE", label: "Draft quotations", short: "draft quote", icon: "doc" },
  { key: "notified", stage: "NOTIFY", label: "Sales notified", short: "notify sales", icon: "bell" },
];
const ERR_STAGE = { PARSE_ERROR: "EXTRACT", VALIDATION_ERROR: "VALIDATE", CUSTOMER_NOT_FOUND: "MAP_CUSTOMER", ITEM_NOT_FOUND: "ESTIMATE" };
const RANGES = [["today", "Today"], ["7d", "7 days"], ["30d", "30 days"], ["all", "All time"], ["custom", "Custom"]];

// --- helpers --------------------------------------------------------------------------
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pill = ([label, cls], extra = "") => `<span class="inline-flex items-center gap-1 whitespace-nowrap px-2 py-0.5 rounded-full text-xs font-medium ${cls}">${extra}${esc(label)}</span>`;
const statusPill = (s) => pill(STATUS[s] || [s, "bg-slate-100"], s === "PROCESSING" ? '<span class="w-1.5 h-1.5 rounded-full bg-brand-600 animate-pulse"></span>' : "");
const money = (v, cur, digits = 2) => (v == null ? "—" : `${cur ? esc(cur) + " " : ""}${Number(v).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);
const time = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
const safeUrl = (u) => (/^https:\/\//.test(u || "") ? esc(u) : null);
const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const secs = (s) => (s == null ? "—" : s < 1 ? `${Math.max(1, Math.round(s * 1000))} ms` : `${s.toFixed(1)} s`);
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (res.status === 401) { location.href = "/login"; throw new Error("Login required"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `${res.status} ${res.statusText}`);
  return data;
}

function rangeParams() {
  const midnight = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const today = midnight(new Date());
  const plus = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  let start = null, end = null;
  if (state.range === "today") [start, end] = [today, plus(today, 1)];
  else if (state.range === "7d") [start, end] = [plus(today, -6), plus(today, 1)];
  else if (state.range === "30d") [start, end] = [plus(today, -29), plus(today, 1)];
  else if (state.range === "custom") {
    if (state.from) start = midnight(`${state.from}T00:00`);
    if (state.to) end = plus(midnight(`${state.to}T00:00`), 1);
  }
  const p = new URLSearchParams();
  if (start) p.set("start", start.toISOString());
  if (end) p.set("end", end.toISOString());
  if (state.q) p.set("q", state.q);
  return p;
}

// --- progress model shared by the hero and the drawer ----------------------------------
function progress(d) {
  const idx = (st) => FLOW.findIndex((f) => f.stage === st);
  const done = new Set();
  for (const e of d.events) if (e.level !== "error" && ["RECEIVED", "EXTRACT", "VALIDATE", "MAP_CUSTOMER", "ESTIMATE"].includes(e.stage)) done.add(e.stage);
  if (d.notifications.some((n) => ["internal", "draft_created"].includes(n.kind))) done.add("NOTIFY");
  let failed = null;
  if (d.status === "EXCEPTION" || d.status === "DISMISSED") {
    let st = ERR_STAGE[d.error_code];
    if (["ERP_API_ERROR", "ZOHO_API_ERROR"].includes(d.error_code)) st = d.erp_customer_id ? "ESTIMATE" : "MAP_CUSTOMER";
    if (!st) st = (FLOW.find((f) => !done.has(f.stage)) || FLOW[5]).stage;
    failed = st;
    FLOW.slice(0, idx(st)).forEach((f) => done.add(f.stage));
    FLOW.slice(idx(st)).forEach((f) => done.delete(f.stage));
  }
  const running = ["PROCESSING", "RECEIVED"].includes(d.status) ? (FLOW.find((f) => !done.has(f.stage)) || {}).stage || null : null;
  return { done, failed, running, finished: !running };
}

// --- header, readiness, presenter -------------------------------------------------------
function renderBadges(s) {
  const b = (ok, label) => `<span class="px-2 py-1 rounded-md border ${ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-slate-50 text-slate-500"}">${esc(label)}</span>`;
  $("#badges").innerHTML = [
    b(!s.erp.is_mock, `ERP: ${s.erp.name}`),
    b(s.ai_enabled, s.ai_enabled ? `AI: ${s.ai_provider}` : "AI: off (rules only)"),
    b(s.smtp_enabled, s.smtp_enabled ? "Email: sending" : "Email: log only"),
    b(s.imap_enabled, s.imap_enabled ? (s.imap_poll_seconds ? `Inbox: every ${s.imap_poll_seconds}s` : "Inbox: manual") : "Inbox: off"),
  ].join("");
  $("#btn-poll").disabled = !s.imap_enabled;
  $("#btn-poll").classList.toggle("opacity-40", !s.imap_enabled);
}

function renderReadiness(checks) {
  const ok = checks.filter((c) => c.ok).length;
  $("#ready-summary").innerHTML = pill([`${ok}/${checks.length} ready`, ok === checks.length ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"]);
  $("#ready-list").innerHTML = checks.map((c) => `
    <li class="flex gap-2"><span class="mt-0.5">${c.ok ? "✅" : "⬜"}</span>
      <div><div class="font-medium">${esc(c.label)}</div><div class="text-xs text-slate-500">${esc(c.detail)}</div>
      ${c.ok ? "" : `<div class="text-xs text-brand-700">→ ${esc(c.fix)}</div>`}</div></li>`).join("");
}

function setPresenter(on) {
  document.body.classList.toggle("presenter", on);
  $("#presenter").checked = on;
  storage.set("presenter", on ? "1" : "0");
  if (!on) $("#demo-pop").classList.add("hidden");
}

function renderDemoControls(s) {
  $("#demo-pop").innerHTML = `<div class="text-xs font-medium text-slate-500 px-1 pb-1">Demo controls (only you see this)</div>` +
    s.samples.map((x) => `<button data-sample="${esc(x.key)}" class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-brand-50">${esc(x.label)}</button>`).join("") +
    `<div class="border-t border-slate-100 pt-1.5 flex gap-1.5">
       <button id="pop-poll" class="flex-1 px-2 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs" ${s.imap_enabled ? "" : "disabled"}>Poll inbox</button>
       <button id="pop-reset" class="flex-1 px-2 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs">Reset demo</button>
       <button id="pop-exit" class="flex-1 px-2 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs">Exit presenter</button></div>`;
}

// --- hero pipeline ----------------------------------------------------------------------
function renderFlow(m, activeDetail) {
  const p = activeDetail ? progress(activeDetail) : null;
  const order = p ? FLOW.filter((f) => p.done.has(f.stage) || p.failed === f.stage).map((f) => f.stage) : [];
  if (state.flowSeen.id !== (activeDetail && activeDetail.id)) state.flowSeen = { id: activeDetail && activeDetail.id, n: 0 };
  const seen = state.flowSeen.n;
  const received = m.funnel.received;
  $("#flow").innerHTML = FLOW.map((f, i) => {
    let node = "bg-white/15 text-white", conn = "bg-white/25", anim = "";
    if (p) {
      const k = order.indexOf(f.stage);
      if (p.failed === f.stage) node = "bg-rose-500 text-white ring-4 ring-rose-300/40";
      else if (p.done.has(f.stage)) { node = "bg-white text-brand-700"; conn = p.done.has(FLOW[i + 1]?.stage) || p.failed === FLOW[i + 1]?.stage ? "bg-white" : "bg-white/25"; }
      else if (p.running === f.stage) node = "bg-white/30 text-white node-running";
      else node = "bg-white/10 text-white/50";
      if (k >= seen) anim = `pop" style="animation-delay:${(k - seen) * 0.28}s`;
    }
    const n = m.funnel[f.key];
    return `<li class="relative flex flex-col items-center text-center px-1">
      ${i < FLOW.length - 1 ? `<div class="hidden md:block absolute top-6 left-1/2 w-full h-0.5 ${conn}"></div>` : ""}
      <div class="relative z-10 w-12 h-12 rounded-full grid place-items-center transition ${node} ${anim}">${icon(f.icon, "w-6 h-6")}</div>
      <div class="mt-2 text-2xl font-semibold leading-none">${n}</div>
      <div class="text-xs text-white/85 mt-1">${esc(f.label)}</div>
      <div class="text-[11px] text-white/60">${i && received ? `${Math.round((n / received) * 100)}% of received` : "&nbsp;"}</div>
    </li>`;
  }).join("");
  state.flowSeen.n = order.length;

  const s = state.status;
  let pillHtml;
  if (activeDetail) {
    const d = activeDetail;
    if (p.running) pillHtml = `<span class="inline-block w-2 h-2 rounded-full bg-white animate-pulse mr-1.5"></span>Processing #${d.id} · ${esc(d.sender_email)} — ${esc((FLOW.find((f) => f.stage === p.running) || {}).label || "")}`;
    else if (d.erp_quote_number) pillHtml = `✓ #${d.id} → draft ${esc(d.erp_quote_number)} in ${secs(d.processing_ms / 1000)}${d.status === "NEEDS_REVIEW" ? " · some lines to review" : ""}`;
    else if (d.status === "DUPLICATE") pillHtml = `#${d.id} is a duplicate of #${esc(d.duplicate_of)} — no second quotation`;
    else if (d.status === "IGNORED") pillHtml = `#${d.id} isn't a quote request — ignored`;
    else pillHtml = `✕ #${d.id} → ${esc(d.error_code || "exception")} — stakeholders alerted`;
  } else if (s.imap_enabled) pillHtml = `Watching ${esc(s.monitored_inbox)} · checks every ${s.imap_poll_seconds}s`;
  else pillHtml = document.body.classList.contains("presenter") ? "Waiting for new quote requests…" : "Inbox polling is off — run a sample or simulate an email";
  $("#live-pill").innerHTML = pillHtml;
}

// --- KPIs -----------------------------------------------------------------------------
function renderKpis(m) {
  const s = state.status;
  const tile = (ic, label, value, sub, action = "", tone = "text-slate-900") => `
    <button ${action} class="text-left bg-white rounded-xl border border-slate-200 px-4 py-3 hover:border-brand-300 transition ${action ? "" : "cursor-default"}">
      <div class="flex items-center gap-2 text-xs text-slate-500"><span class="w-7 h-7 rounded-lg bg-brand-50 text-brand-700 grid place-items-center shrink-0">${icon(ic, "w-4 h-4")}</span>${esc(label)}</div>
      <div class="text-2xl font-semibold mt-2 ${tone}">${value}</div>
      <div class="text-xs text-slate-500 mt-0.5 truncate" title="${esc(sub)}">${esc(sub)}</div>
    </button>`;
  const matched = m.total_lines - m.lines.none;
  $("#kpis").innerHTML = [
    tile("doc", "Draft quotations", m.drafts, m.drafts ? `${money(m.quoted_value, m.currency, 0)} quoted` : "none in this range"),
    tile("target", "Lines matched automatically", pct(m.auto_match_rate), m.total_lines ? `${matched} of ${m.total_lines} draft lines` : "no draft lines yet"),
    tile("eye", "Needs review", m.review_enquiries, "drafts with lines to check", 'data-goto="review"', m.review_enquiries ? "text-amber-700" : "text-slate-900"),
    tile("alert", "Open exceptions", m.open_exceptions, m.open_exceptions ? "open the queue →" : "all clear", 'data-goto="exceptions"', m.open_exceptions ? "text-rose-700" : "text-slate-900"),
    tile("clock", "Avg processing time", secs(m.avg_processing_s), "email received → draft created"),
    tile("bolt", "Effort saved (est.)", `${m.effort_saved_hours} h`, `assumes ${s.manual_minutes_per_enquiry} min + ${s.manual_minutes_per_line} min/line per manual quote`),
  ].join("");
}

// --- charts ---------------------------------------------------------------------------
function renderMatchChart(m) {
  const segs = [
    ["exact", "Exact match (item code or name)", "--series-1"],
    ["ai", "AI match — verify", "--series-2"],
    ["fuzzy", "Fuzzy match — verify", "--series-3"],
    ["none", "Not in catalogue — price needed", "--series-4"],
  ];
  const total = m.total_lines;
  $("#match-sub").textContent = total
    ? `${total} lines across ${m.drafts} draft quotation${m.drafts === 1 ? "" : "s"}${state.status.ai_enabled ? "" : " · AI matching is off until an AI key is set"}`
    : "No draft lines in this range yet.";
  const visible = segs.filter(([k]) => m.lines[k] > 0);
  const bar = total
    ? `<div class="flex h-6 gap-[2px]" role="img" aria-label="Line match breakdown">${visible.map(([k, label, v], i) => {
        const n = m.lines[k];
        const round = `${i === 0 ? "rounded-l" : ""} ${i === visible.length - 1 ? "rounded-r" : ""}`;
        const tip = `<b>${esc(label)}</b><br>${n} line${n === 1 ? "" : "s"} · ${Math.round((n / total) * 100)}%`;
        return `<div data-tip="${esc(tip)}" class="${round} hover:opacity-80" style="flex:${n} 1 0;min-width:4px;background:var(${v})"></div>`;
      }).join("")}</div>`
    : `<div class="h-6 rounded bg-slate-100"></div>`;
  const legend = `<dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 mt-4 text-sm">${segs.map(([k, label, v]) => `
    <div class="flex items-center gap-2"><span class="w-2.5 h-2.5 rounded-sm shrink-0" style="background:var(${v})"></span>
      <dt class="text-slate-600 mr-auto">${esc(label)}</dt>
      <dd class="tnum font-medium text-slate-900">${m.lines[k]}</dd><dd class="tnum text-slate-500 w-10 text-right">${total ? Math.round((m.lines[k] / total) * 100) + "%" : "—"}</dd></div>`).join("")}</dl>`;
  $("#match-chart").innerHTML = bar + legend;
}

function niceMax(v) {
  if (v <= 2) return 2;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((k) => k * p).find((x) => x >= v);
}

function renderDailyChart(daily) {
  const series = [
    ["clean", "Clean draft", "--status-good", "✓"],
    ["review", "Needs review", "--status-warning", "!"],
    ["exception", "Exception", "--status-critical", "✕"],
    ["other", "Duplicate / ignored", "--status-neutral", "–"],
  ];
  $("#daily-legend").innerHTML = series.map(([, label, v, g]) =>
    `<span class="inline-flex items-center gap-1.5"><span class="w-3.5 h-3.5 rounded-sm grid place-items-center text-[9px] font-bold text-white" style="background:var(${v})">${g}</span>${esc(label)}</span>`).join("");
  const totals = daily.map((d) => series.reduce((a, [k]) => a + d[k], 0));
  const max = niceMax(Math.max(1, ...totals));
  const H = 150;
  const ticks = [0, max / 2, max].filter((t) => Number.isInteger(t));
  const every = Math.ceil(daily.length / 7);
  const fmt = (iso) => new Date(`${iso}T00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const cols = daily.map((d, i) => {
    const tip = `<b>${fmt(d.date)}</b><br>` + series.map(([k, label]) => `${esc(label)}: ${d[k]}`).join("<br>") + `<br>Total: ${totals[i]}`;
    const parts = series.filter(([k]) => d[k] > 0);
    const stack = parts.map(([k, , v], j) => `<div style="height:${Math.max(2, (d[k] / max) * H - 2)}px;background:var(${v})" class="${j === parts.length - 1 ? "rounded-t" : ""}"></div>`).join("");
    return `<div data-tip="${esc(tip)}" class="flex-1 h-full flex items-end justify-center hover:bg-slate-50 rounded">
      <div class="w-full max-w-[24px] flex flex-col-reverse gap-[2px]">${stack}</div></div>`;
  }).join("");
  $("#daily-chart").innerHTML = `
    <div class="flex gap-2">
      <div class="relative w-6 shrink-0 text-[11px] text-right tnum" style="height:${H}px;color:var(--muted)">
        ${ticks.map((t) => `<span class="absolute right-0 -translate-y-1/2" style="top:${H - (t / max) * H}px">${t}</span>`).join("")}</div>
      <div class="relative flex-1" style="height:${H}px">
        ${ticks.map((t) => `<div class="absolute left-0 right-0 h-px" style="top:${H - (t / max) * H}px;background:${t === 0 ? "var(--axis)" : "var(--grid)"}"></div>`).join("")}
        <div class="absolute inset-0 flex gap-1 px-1">${cols}</div>
      </div>
    </div>
    <div class="flex gap-1 pl-9 pr-1 mt-1 text-[11px]" style="color:var(--muted)">
      ${daily.map((d, i) => `<span class="flex-1 text-center whitespace-nowrap">${i % every === 0 || i === daily.length - 1 ? fmt(d.date) : ""}</span>`).join("")}</div>`;
  $("#daily-table").innerHTML = `<table class="w-full tnum"><thead class="text-slate-500"><tr><th class="text-left py-1">Date</th>${series.map(([, l]) => `<th class="text-right">${esc(l)}</th>`).join("")}<th class="text-right">Total</th></tr></thead>
    <tbody>${daily.slice().reverse().map((d, i) => `<tr class="border-t border-slate-100"><td class="py-1">${fmt(d.date)}</td>${series.map(([k]) => `<td class="text-right">${d[k]}</td>`).join("")}<td class="text-right font-medium">${totals[daily.length - 1 - i]}</td></tr>`).join("")}</tbody></table>`;
}

// --- enquiries table + exceptions queue -------------------------------------------------
function renderFilters() {
  const opts = [["", "All"], ["DRAFT_CREATED", "Draft"], ["NEEDS_REVIEW", "Review"], ["APPROVED", "Approved"], ["EXCEPTION", "Exception"], ["OTHER", "Other"]];
  $("#filters").innerHTML = state.view !== "enquiries" ? "" : opts.map(([v, l]) =>
    `<button data-filter="${v}" class="px-2 py-1 rounded-md ${state.filter === v ? "bg-brand-600 text-white" : "bg-slate-100 hover:bg-slate-200"}">${l}</button>`).join("");
}

function renderRows(rows) {
  const filtered = state.q || state.range !== "all" || state.filter;
  $("#empty").textContent = filtered ? "No enquiries match these filters." : "No enquiries yet — they appear here as emails arrive.";
  $("#empty").classList.toggle("hidden", rows.length > 0);
  $("#rows").innerHTML = rows.map((r) => {
    const link = safeUrl(r.erp_quote_url);
    const quoteCell = r.erp_quote_number
      ? (link ? `<a href="${link}" target="_blank" rel="noopener" class="text-brand-700 hover:underline" data-stop>${esc(r.erp_quote_number)} ↗</a>` : `<span class="mono text-xs">${esc(r.erp_quote_number)}</span>`)
      : '<span class="text-slate-300">—</span>';
    const sub = r.status === "DUPLICATE" ? `<div class="text-xs text-slate-500">of #${esc(r.duplicate_of)}</div>`
      : r.error_code && ["EXCEPTION", "DISMISSED"].includes(r.status) ? `<div class="text-xs text-rose-700 truncate max-w-[14rem]" title="${esc(r.error_message)}">${esc(r.error_code)}</div>`
      : r.review_count && r.status === "NEEDS_REVIEW" ? `<div class="text-xs text-amber-700">${r.review_count} line(s) to review</div>` : "";
    return `<tr data-id="${r.id}" class="row cursor-pointer hover:bg-brand-50/60 ${state.openId === r.id ? "bg-brand-50" : ""} ${state.flash.has(r.id) ? "row-new" : ""}">
      <td class="px-4 py-2 text-slate-500">${r.id}</td>
      <td class="px-2 py-2 whitespace-nowrap text-slate-500">${esc(time(r.created_at))}<div class="text-[11px] text-slate-400">${esc(r.source)}</div></td>
      <td class="px-2 py-2 max-w-[13rem]"><div class="truncate">${esc(r.sender_email)}</div><div class="truncate text-xs text-slate-500">${esc(r.subject)}${r.attachment_name ? " 📎" : ""}</div></td>
      <td class="px-2 py-2">${esc(r.erp_customer_name || r.customer_name || "—")}</td>
      <td class="px-2 py-2 text-right tnum">${r.line_count || "—"}</td>
      <td class="px-2 py-2 text-right whitespace-nowrap tnum">${r.quote_total != null ? money(r.quote_total, r.currency) : "—"}</td>
      <td class="px-2 py-2">${statusPill(r.status)}${sub}</td>
      <td class="px-4 py-2 whitespace-nowrap">${quoteCell}</td>
    </tr>`;
  }).join("");
  rows.forEach((r) => state.flash.delete(r.id));  // highlight a new row once, not on every refresh
}

function renderExceptions(exq, m) {
  $("#ex-count").textContent = m.open_exceptions || "";
  $("#ex-count").classList.toggle("hidden", !m.open_exceptions);
  if (state.view !== "exceptions") return;
  const chips = Object.entries(m.exceptions_by_code).map(([c, n]) => pill([`${c} · ${n}`, "bg-rose-50 text-rose-800 border border-rose-200"])).join(" ");
  const cards = exq.open.map((r) => `
    <article class="rounded-xl border border-slate-200 border-l-4 ${r.status === "RETRY_PENDING" ? "border-l-sky-500" : "border-l-rose-500"} p-4">
      <div class="flex flex-wrap items-center gap-2">${pill([r.error_code || "EXCEPTION", r.status === "RETRY_PENDING" ? "bg-sky-100 text-sky-800" : "bg-rose-100 text-rose-800"])}
        ${r.status === "RETRY_PENDING" ? pill([`retrying · next ${r.next_retry_at ? new Date(r.next_retry_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "soon"}`, "bg-sky-50 text-sky-800"]) : ""}
        <span class="text-xs text-slate-500">#${r.id} · ${esc(time(r.created_at))}</span>
        <div class="ml-auto flex gap-2">
          <button data-reprocess="${r.id}" class="text-xs px-3 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700">Reprocess</button>
          <button data-dismiss="${r.id}" class="text-xs px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50">Dismiss</button>
          <button data-open="${r.id}" class="text-xs px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50">Details</button></div></div>
      <div class="mt-2 font-medium truncate">${esc(r.sender_email)} — ${esc(r.subject)}</div>
      <p class="text-sm text-slate-700 mt-1">${esc(r.error_message)}</p>
      <p class="text-sm text-brand-800 bg-brand-50 rounded-lg px-3 py-2 mt-2"><b>What to do:</b> ${esc(r.hint)}</p>
    </article>`).join("");
  const review = exq.review.map((r) => {
    const link = safeUrl(r.erp_quote_url);
    return `<tr class="border-t border-slate-100"><td class="py-2 text-slate-500">#${r.id}</td><td>${esc(r.erp_customer_name || "—")}<div class="text-xs text-slate-500 truncate max-w-[16rem]">${esc(r.subject)}</div></td>
      <td class="text-right tnum">${r.review_count} of ${r.line_count}</td>
      <td class="pl-3">${link ? `<a href="${link}" target="_blank" rel="noopener" class="text-brand-700 hover:underline">${esc(r.erp_quote_number)} ↗</a>` : `<span class="mono text-xs">${esc(r.erp_quote_number || "")}</span>`}</td>
      <td class="text-right"><button data-open="${r.id}" class="text-xs px-2 py-1 rounded-md border border-slate-300 hover:bg-slate-50">Review</button></td></tr>`;
  }).join("");
  $("#view-exceptions").innerHTML = `
    <div class="flex flex-wrap items-center gap-2"><h3 class="font-semibold mr-2">Open exceptions</h3>${chips}</div>
    ${cards || `<div class="flex items-center gap-2 text-emerald-700 bg-emerald-50 rounded-xl px-4 py-3">${icon("check")}No open exceptions in this range.</div>`}
    <div><h3 class="font-semibold mb-1">Drafts with lines to review</h3>
      ${review ? `<table class="w-full text-sm"><thead class="text-xs text-slate-500 text-left"><tr><th class="py-1">#</th><th>Customer</th><th class="text-right">Lines to check</th><th class="pl-3">Draft quotation</th><th></th></tr></thead><tbody>${review}</tbody></table>`
        : '<p class="text-sm text-slate-500">Nothing to review.</p>'}</div>`;
}

// --- live feed + arrivals -------------------------------------------------------------
function feedItem(e, fresh) {
  return `<li class="px-4 py-2 flex gap-2 ${fresh ? "row-new" : ""}">
    <span class="mt-1 w-2 h-2 rounded-full shrink-0 ${LEVEL_DOT[e.level] || "bg-slate-400"}"></span>
    <div class="min-w-0"><div class="text-slate-400">${esc(time(e.created_at))} · <span class="font-medium text-slate-600">${esc(e.stage)}</span>${e.enquiry_id ? ` · <button class="text-brand-700 hover:underline" data-open="${e.enquiry_id}">#${e.enquiry_id}</button>` : ""}</div>
      <div class="text-slate-700 break-words">${esc(e.message)}</div></div></li>`;
}

async function pollEvents(initial = false) {
  const events = await api(`/api/events?after_id=${state.lastEventId}&limit=${initial ? 80 : 200}`);
  if (!events.length) return;
  state.lastEventId = events[events.length - 1].id;
  $("#feed").insertAdjacentHTML("afterbegin", events.slice().reverse().map((e) => feedItem(e, !initial)).join(""));
  const items = $("#feed").children;
  while (items.length > 300) items[items.length - 1].remove();
  if (!initial) for (const e of events) if (e.stage === "RECEIVED" && e.enquiry_id) onArrival(e.enquiry_id);
}

async function onArrival(id) {
  state.active = { id, until: null };
  state.flash.add(id);
  try {
    const d = await api(`/api/enquiries/${id}`);
    const card = document.createElement("div");
    card.className = "slidein bg-white border border-slate-200 shadow-xl rounded-xl p-3 flex gap-3 items-center";
    card.innerHTML = `<div class="w-9 h-9 rounded-full bg-brand-100 text-brand-700 grid place-items-center shrink-0">${icon("inbox")}</div>
      <div class="min-w-0 flex-1"><div class="text-xs text-brand-700 font-medium">New quote request · #${d.id}</div>
        <div class="font-medium truncate">${esc(d.sender_name || d.sender_email)}</div>
        <div class="text-xs text-slate-500 truncate">${esc(d.subject)}${d.attachment_name ? " 📎" : ""}</div></div>
      <button data-open="${d.id}" class="text-xs px-2.5 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700">View</button>`;
    $("#arrivals").prepend(card);
    setTimeout(() => card.remove(), 9000);
    while ($("#arrivals").children.length > 3) $("#arrivals").lastElementChild.remove();
    if (document.body.classList.contains("presenter") && state.openId !== id) openDetail(id);
  } catch (e) { console.warn(e); }
  schedule(300);
}

// --- detail drawer ----------------------------------------------------------------------
function trackHtml(d) {
  const p = progress(d);
  const order = FLOW.filter((f) => p.done.has(f.stage) || p.failed === f.stage).map((f) => f.stage);
  const seen = state.trackSeen[d.id] ?? 0;
  const chips = FLOW.map((f) => {
    let cls = "bg-slate-100 text-slate-400", mark = "";
    if (p.failed === f.stage) { cls = "bg-rose-100 text-rose-800"; mark = "✕ "; }
    else if (p.done.has(f.stage)) { cls = "bg-emerald-100 text-emerald-800"; mark = "✓ "; }
    else if (p.running === f.stage) cls = "bg-brand-100 text-brand-800 chip-running";
    const k = order.indexOf(f.stage);
    const anim = k >= seen ? ` pop" style="animation-delay:${(k - seen) * 0.25}s` : "";
    return `<li class="px-2 py-1 rounded-md ${cls}${anim}">${mark}${esc(f.short)}</li>`;
  }).join('<li class="text-slate-300">›</li>');
  state.trackSeen[d.id] = order.length;
  const note = d.status === "DUPLICATE" ? '<span class="text-xs text-slate-500 ml-2">stopped: duplicate</span>'
    : d.status === "IGNORED" ? '<span class="text-xs text-slate-500 ml-2">stopped: not a quote request</span>' : "";
  return `<div class="flex flex-wrap items-center gap-2">${statusPill(d.status)}<ol class="flex flex-wrap items-center gap-1 text-xs">${chips}</ol>${note}
    ${d.processing_ms != null && p.finished ? `<span class="text-xs text-slate-500 ml-auto">${icon("clock", "w-3.5 h-3.5 inline -mt-0.5")} ${secs(d.processing_ms / 1000)}</span>` : ""}</div>`;
}

function field(label, value) {
  return `<div><dt class="text-xs text-slate-500">${esc(label)}</dt><dd class="font-medium break-words">${value || '<span class="text-slate-300">—</span>'}</dd></div>`;
}

function flagPills(l) {
  const flags = (l.flags || "").split(",").filter((f) => f && f !== "not_found");  // not_found is shown by the match pill
  return flags.map((f) => pill(FLAGS[f] || [f, "bg-slate-100"])).join(" ");
}

function matchCell(d, l) {
  return `${l.erp_item_name ? `<div>${esc(l.erp_item_name)}</div><div class="mono text-xs text-slate-500">${esc(l.erp_sku || "")}</div>` : ""}
    <div class="flex flex-wrap gap-1 mt-0.5">${d.erp_customer_id || l.match_method ? pill(MATCH[l.match_method] || MATCH.null) : ""}${l.match_score && !["sku", "name"].includes(l.match_method) ? ` <span class="text-xs text-slate-500 self-center">${Math.round(l.match_score * 100)}%</span>` : ""} ${flagPills(l)}</div>
    ${l.review_note && l.flags !== "not_found" ? `<div class="text-xs text-amber-800 mt-0.5">${esc(l.review_note)}</div>` : ""}`;
}

const erpName = () => (state.status && state.status.erp ? state.status.erp.name : "accounting system");

function docLinks(d) {
  if (!["standalone", "webhook"].includes(d.erp_connector) || !d.erp_quote_number) return "";
  return `<span class="flex gap-3"><a class="text-brand-700 hover:underline" href="/api/enquiries/${d.id}/quote-document?fmt=pdf" target="_blank">Quotation PDF ⬇</a>
    <a class="text-brand-700 hover:underline" href="/api/enquiries/${d.id}/quote-document?fmt=xlsx">Excel ⬇</a></span>`;
}

function overviewHtml(d) {
  const lines = d.line_items.map((l) => `
    <tr class="align-top">
      <td class="py-2 pr-2 text-slate-500">${l.line_no}</td>
      <td class="py-2 pr-2"><div class="mono text-xs">${esc(l.sku || "")}</div><div>${esc(l.name || "")}</div>
        ${l.description && l.description !== l.name ? `<div class="text-xs text-slate-500 line-clamp-2" title="${esc(l.description)}">${esc(l.description.slice(0, 200))}</div>` : ""}</td>
      <td class="py-2 pr-2 text-right tnum">${l.quantity ?? "—"} <span class="text-xs text-slate-500">${esc(l.unit || "")}</span></td>
      <td class="py-2 pr-2">${matchCell(d, l)}</td>
      <td class="py-2 pr-2 text-right tnum">${l.rate != null ? money(l.rate) : (l.customer_rate ? `<span class="text-slate-400" title="customer price">${money(l.customer_rate)}</span>` : "—")}</td>
      <td class="py-2 text-right tnum">${l.amount != null ? money(l.amount) : "—"}</td>
    </tr>`).join("");
  return `<div class="space-y-5">
    ${d.error_message ? `<div class="rounded-lg border ${d.status === "DUPLICATE" ? "border-slate-200 bg-slate-50" : "border-rose-200 bg-rose-50 text-rose-900"} px-3 py-2"><b>${esc(d.error_code || "")}</b> ${esc(d.error_message)}</div>` : ""}
    ${d.erp_quote_number ? `<div class="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 flex flex-wrap gap-x-6 gap-y-1">
        <span>Draft quotation <b>${esc(d.erp_quote_number)}</b> (${esc(d.erp_quote_status)})</span>
        <span>Total <b>${money(d.quote_total, d.currency)}</b></span>
        <span class="text-brand-800">${d.erp_connector === "mock" ? "Demo data — no real quotation" : `In ${esc(erpName())} · not sent to customer`}</span>
        ${docLinks(d)}</div>` : ""}
    <dl class="grid grid-cols-2 md:grid-cols-3 gap-3">
      ${field("From", esc(d.sender_email) + (d.sender_name ? `<div class="text-xs text-slate-500">${esc(d.sender_name)}</div>` : ""))}
      ${field(`${erpName()} customer`, esc(d.erp_customer_name || ""))}
      ${field("Customer (as written)", esc(d.customer_name || ""))}
      ${field("Customer reference", esc(d.reference || ""))}
      ${field("Required by", esc(d.required_by || ""))}
      ${field("Received", esc(time(d.received_at)) + ` <span class="text-xs text-slate-500">via ${esc(d.source)}</span>`)}
      ${field("Contact", esc([d.contact_name, d.contact_phone].filter(Boolean).join(" · ")))}
      ${field("Delivery address", esc(d.delivery_address || ""))}
      ${field("Delivery terms", esc(d.delivery_terms || ""))}
      ${field("Attachments", (d.attachments || []).map((a) => `<a class="text-brand-700 hover:underline" href="/api/enquiries/${d.id}/attachment?file_id=${a.id}">${esc(a.name)}</a>`).join("<br>") || esc(d.attachment_name || ""))}
      ${field("Notes", esc(d.notes || ""))}
    </dl>
    ${d.line_items.length ? `<div><h3 class="font-semibold mb-1">Line items (${d.line_items.length})</h3>
      <table class="w-full table-fixed text-sm [overflow-wrap:anywhere]">
        <colgroup><col class="w-7"><col><col class="w-20"><col class="w-[30%]"><col class="w-20"><col class="w-24"></colgroup>
        <thead class="text-xs text-slate-500 text-left border-b border-slate-200"><tr><th class="py-1">#</th><th>Customer item</th><th class="text-right pr-2">Qty</th><th>Matched product</th><th class="text-right pr-2">Rate</th><th class="text-right">Amount</th></tr></thead>
        <tbody class="divide-y divide-slate-100">${lines}</tbody></table></div>` : ""}
  </div>`;
}

function sourceHtml(d, src) {
  if (!src) return '<p class="text-slate-500">Loading source…</p>';
  if (src.kind === "error") return `<p class="text-rose-700">${esc(src.message)}</p>`;
  const by = src.mapped_by === "ai" ? pill(["read by AI", "bg-violet-100 text-violet-800"]) : src.mapped_by ? pill(["read by rules", "bg-slate-100 text-slate-700"]) : "";
  if (src.kind === "email") {
    const rows = d.line_items.map((l) => `<tr class="align-top border-t border-slate-100"><td class="py-2 pr-2 text-slate-500">${l.line_no}</td>
      <td class="py-2 pr-2">${esc(l.name || "")} <span class="mono text-xs text-slate-500">${esc(l.sku || "")}</span></td><td class="py-2 pr-2 text-right tnum">${l.quantity ?? "—"} ${esc(l.unit || "")}</td>
      <td class="py-2 text-slate-300">${icon("arrow", "w-4 h-4")}</td><td class="py-2">${matchCell(d, l)}</td></tr>`).join("");
    return `<div class="space-y-4"><p class="flex items-center gap-2">${by}<span class="text-slate-600">${d.line_items.length ? "Items were taken from the email text itself." : "No items were found in the email."}</span></p>
      ${rows ? `<table class="w-full text-sm"><thead class="text-xs text-slate-500 text-left"><tr><th>#</th><th>What the customer wrote</th><th class="text-right pr-2">Qty</th><th></th><th>Draft quote line</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
      <pre class="whitespace-pre-wrap text-xs bg-slate-50 border border-slate-200 rounded-lg p-3">${esc(src.body)}</pre></div>`;
  }
  const col = (f) => src.columns.findIndex((c) => c.field === f);
  const pick = (cells, f) => (col(f) >= 0 ? cells[col(f)] || "" : "");
  const rows = d.line_items.map((l) => {
    const cells = src.cells[String(l.source_row)] || [];
    return `<tr class="align-top border-t border-slate-100">
      <td class="py-2 pr-2 text-slate-500 tnum">${l.source_row != null ? l.source_row + 1 : ""}</td>
      <td class="py-2 pr-2"><div class="mono text-xs">${esc(pick(cells, "sku"))}</div><div>${esc(pick(cells, "name") || pick(cells, "description").slice(0, 80))}</div></td>
      <td class="py-2 pr-2 text-right tnum whitespace-nowrap">${esc(pick(cells, "quantity"))} <span class="text-xs text-slate-500">${esc(pick(cells, "unit"))}</span></td>
      <td class="py-2 pr-1 text-slate-300">${icon("arrow", "w-4 h-4")}</td>
      <td class="py-2 pr-2">${matchCell(d, l)}</td>
      <td class="py-2 text-right tnum">${l.rate != null ? money(l.rate) : "—"}</td></tr>`;
  }).join("");
  const mappedIdx = new Map(src.columns.map((c) => [c.index, c]));
  const preview = src.preview.map((r, i) => `<tr class="${i === src.header_row ? "bg-slate-100 font-semibold" : ""}"><td class="px-1 text-slate-400 tnum">${i + 1}</td>${r.map((c, j) =>
    `<td class="px-1 py-0.5 border-l border-slate-100 ${mappedIdx.has(j) ? "bg-brand-50/70" : ""}">${i === src.header_row && mappedIdx.has(j) ? `<div class="text-[10px] text-brand-700 font-medium">→ ${esc(mappedIdx.get(j).field_label)}</div>` : ""}${esc(c)}</td>`).join("")}</tr>`).join("");
  return `<div class="space-y-4">
    <div class="rounded-lg bg-slate-50 border border-slate-200 p-3">
      <div class="flex flex-wrap items-center gap-2"><b>${esc(src.file)}</b><span class="text-slate-500">sheet “${esc(src.sheet)}” · header on row ${src.header_row + 1}</span>${by}</div>
      <div class="flex flex-wrap gap-1.5 mt-2 text-xs">${src.columns.map((c) => `<span class="px-2 py-1 rounded-md bg-white border border-slate-200">“${esc(c.header)}” <span class="text-slate-400">→</span> <b>${esc(c.field_label)}</b></span>`).join("")}</div>
    </div>
    <table class="w-full table-fixed text-sm [overflow-wrap:anywhere]">
      <colgroup><col class="w-10"><col><col class="w-20"><col class="w-6"><col class="w-[34%]"><col class="w-20"></colgroup>
      <thead class="text-xs text-slate-500 text-left"><tr><th>Row</th><th>Customer's sheet</th><th class="text-right pr-2">Qty</th><th></th><th>Draft quote line</th><th class="text-right">Rate</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <details><summary class="cursor-pointer font-medium text-slate-700">Original sheet (first rows) — recognised columns highlighted</summary>
      <div class="mt-2 overflow-auto max-h-96 border border-slate-200 rounded-lg"><table class="text-[11px] whitespace-nowrap"><tbody>${preview}</tbody></table></div></details>
  </div>`;
}

function auditHtml(d) {
  return `<div class="space-y-4">
    <ol class="border border-slate-200 rounded-lg divide-y divide-slate-100 text-xs">${d.events.map((e) => feedItem(e, false)).join("")}</ol>
    ${d.exceptions.length ? `<div><h3 class="font-semibold mb-1">Exceptions recorded</h3><ul class="space-y-1 text-xs">${d.exceptions.map((x) =>
      `<li>${pill([x.code, "bg-rose-100 text-rose-800"])} <span class="text-slate-500">${esc(time(x.created_at))}</span> ${esc(x.message)}</li>`).join("")}</ul></div>` : ""}
    <details><summary class="font-semibold cursor-pointer">Original email</summary>
      <pre class="mt-2 whitespace-pre-wrap text-xs bg-slate-50 border border-slate-200 rounded-lg p-3">${esc(d.body_text)}</pre></details></div>`;
}

function emailsHtml(d) {
  if (!d.notifications.length) return '<p class="text-slate-500">No emails sent for this enquiry yet.</p>';
  return `<div class="space-y-2">${d.notifications.map((n) => `
    <details class="border border-slate-200 rounded-lg">
      <summary class="px-3 py-2 cursor-pointer flex flex-wrap gap-2 items-center">
        ${pill(NOTE_KIND[n.kind] || [n.kind, "bg-slate-100 text-slate-700"])}
        ${pill([n.status, n.status === "sent" ? "bg-emerald-100 text-emerald-800" : n.status === "failed" ? "bg-rose-100 text-rose-800" : "bg-slate-100 text-slate-600"])}
        <span class="truncate">${esc(n.subject)}</span><span class="text-xs text-slate-500 ml-auto">→ ${esc(n.recipients)}</span></summary>
      ${n.error ? `<div class="px-3 text-xs text-slate-500">${esc(n.error)}</div>` : ""}
      <iframe sandbox="" class="w-full h-96 border-t border-slate-200" srcdoc="${esc(n.body_html)}"></iframe>
    </details>`).join("")}</div>`;
}

const sigOf = (d) => `${d.id}|${d.updated_at}|${d.events.length}|${d.notifications.length}|${state.dtab}`;

async function renderDetail(d, force = false) {
  state.detail = d;
  $("#d-track").innerHTML = trackHtml(d);
  if (!force && sigOf(d) === state.detailSig) return;  // keep open <details> and scroll intact
  state.detailSig = sigOf(d);
  $("#d-title").textContent = `Enquiry #${d.id} — ${d.subject || "(no subject)"}`;
  const link = safeUrl(d.erp_quote_url);
  const flaggedLines = d.line_items.filter((l) => l.flags).length;
  $("#d-actions").innerHTML = [
    ["EXCEPTION", "RETRY_PENDING", "IGNORED", "DISMISSED"].includes(d.status) ? `<button data-reprocess="${d.id}" class="text-sm px-3 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700">Reprocess</button>` : "",
    ["DRAFT_CREATED", "NEEDS_REVIEW"].includes(d.status) ? `<button data-approve="${d.id}" data-flagged="${flaggedLines}" class="text-sm px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700" title="Marks the draft approved. Nothing is sent to the customer.">Approve</button>` : "",
    ["DRAFT_CREATED", "NEEDS_REVIEW", "APPROVED"].includes(d.status) ? `<button data-reject="${d.id}" class="text-sm px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50">Reject</button>` : "",
    link ? `<a href="${link}" target="_blank" rel="noopener" class="text-sm px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50">Open in ${esc(erpName())} ↗</a>` : "",
  ].join("");
  $$(".dtab").forEach((b) => {
    const on = b.dataset.dtab === state.dtab;
    b.classList.toggle("border-brand-600", on); b.classList.toggle("font-medium", on);
    b.classList.toggle("border-transparent", !on); b.classList.toggle("text-slate-500", !on);
  });
  if (state.dtab === "source") {
    const key = `${d.id}|${d.updated_at}`;
    $("#d-body").innerHTML = sourceHtml(d, state.sourceCache[key]);
    if (!state.sourceCache[key]) {
      state.sourceCache[key] = await api(`/api/enquiries/${d.id}/source`).catch((e) => ({ kind: "error", message: e.message }));
      if (state.openId === d.id && state.dtab === "source") $("#d-body").innerHTML = sourceHtml(d, state.sourceCache[key]);
    }
  } else {
    $("#d-body").innerHTML = state.dtab === "audit" ? auditHtml(d) : state.dtab === "emails" ? emailsHtml(d) : overviewHtml(d);
  }
}

async function openDetail(id) {
  id = Number(id);
  if (state.openId !== id) { state.dtab = "overview"; state.detailSig = ""; }
  state.openId = id;
  try {
    await renderDetail(await api(`/api/enquiries/${id}`), true);
    $("#drawer").classList.remove("translate-x-full");
    $("#scrim").classList.remove("hidden");
  } catch (e) { toast(e.message); }
  schedule(200);
}

function closeDetail() {
  state.openId = null;
  state.detail = null;
  $("#drawer").classList.add("translate-x-full");
  $("#scrim").classList.add("hidden");
}

// --- refresh loop (fast while something is processing) ----------------------------------
function schedule(ms) {
  clearTimeout(state.timer);
  state.timer = setTimeout(refresh, ms ?? state.pollMs);
}

async function refresh() {
  try {
    const p = rangeParams();
    const lp = new URLSearchParams(p);
    if (state.filter) lp.set("status", state.filter);
    const [m, rows, exq] = await Promise.all([api(`/api/metrics?${p}`), api(`/api/enquiries?${lp}`), api(`/api/exceptions?${p}`)]);
    state.metrics = m;
    state.rows = rows;
    await pollEvents();

    let activeDetail = null;
    if (state.openId) {
      const d = await api(`/api/enquiries/${state.openId}`).catch(() => null);
      if (d) await renderDetail(d);
      if (state.active && state.active.id === state.openId) activeDetail = d;
    }
    if (state.active && !activeDetail) activeDetail = await api(`/api/enquiries/${state.active.id}`).catch(() => null);
    if (state.active && activeDetail) {
      if (progress(activeDetail).finished && !state.active.until) state.active.until = Date.now() + 8000;
      if (state.active.until && Date.now() > state.active.until) { state.active = null; activeDetail = null; }
    } else if (state.active) state.active = null;

    renderFlow(m, activeDetail);
    renderKpis(m);
    renderMatchChart(m);
    renderDailyChart(m.daily);
    renderFilters();
    renderRows(rows);
    renderExceptions(exq, m);
    const busy = rows.some((r) => ["PROCESSING", "RECEIVED"].includes(r.status)) || (state.active && !state.active.until);
    state.pollMs = busy ? 900 : state.active ? 1500 : 3000;
    $("#filter-note").textContent = state.q ? `Filtered by “${state.q}”` : "";
  } catch (e) { console.warn(e); }
  schedule();
}

async function run(label, fn, { open = true } = {}) {
  if (state.busy) return;
  state.busy = true;
  toast(`${label}…`, 60000);
  try {
    const r = await fn();
    if (r && r.id) toast(["PROCESSING", "RECEIVED"].includes(r.status) ? `#${r.id} received — processing` : `#${r.id}: ${(STATUS[r.status] || [r.status])[0]}`);
    else toast("Done");
    if (r && r.id) {
      state.active = { id: r.id, until: null };
      if (open) await openDetail(r.id);
    }
  } catch (e) { toast(e.message, 6000); }
  finally { state.busy = false; schedule(100); }
}

// --- wiring ---------------------------------------------------------------------------
document.addEventListener("click", (ev) => {
  if (ev.target.closest("[data-stop]")) return;
  const t = ev.target.closest("[data-filter],[data-open],[data-reprocess],[data-dismiss],[data-approve],[data-reject],[data-sample],[data-goto],[data-range],.row,.tab,.view,.dtab");
  if (!t) return;
  if (t.matches("[data-filter]")) { state.filter = t.dataset.filter; schedule(0); }
  else if (t.matches("[data-open]")) openDetail(t.dataset.open);
  else if (t.matches("[data-reprocess]")) run("Reprocessing", () => api(`/api/enquiries/${t.dataset.reprocess}/reprocess`, { method: "POST" }), { open: true });
  else if (t.matches("[data-dismiss]")) run("Dismissing", () => api(`/api/enquiries/${t.dataset.dismiss}/dismiss`, { method: "POST" }), { open: false });
  else if (t.matches("[data-approve]")) {
    const n = Number(t.dataset.flagged || 0);
    if (n && !confirm(`${n} line(s) are still flagged for review. Approve anyway? (Nothing is sent to the customer.)`)) return;
    run("Approving", () => api(`/api/enquiries/${t.dataset.approve}/approve`, { method: "POST" }), { open: false });
  }
  else if (t.matches("[data-reject]")) {
    const reason = prompt("Reason for rejecting this draft?");
    if (reason === null) return;
    run("Rejecting", () => api(`/api/enquiries/${t.dataset.reject}/reject`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) }), { open: false });
  }
  else if (t.matches("[data-sample]")) { $("#demo-pop").classList.add("hidden"); run("Sending sample email", () => api(`/api/samples/${t.dataset.sample}`, { method: "POST" })); }
  else if (t.matches("[data-goto]")) {
    if (t.dataset.goto === "exceptions") setView("exceptions");
    else { setView("enquiries"); state.filter = "NEEDS_REVIEW"; schedule(0); }
  }
  else if (t.matches("[data-range]")) setRange(t.dataset.range);
  else if (t.matches(".row")) openDetail(t.dataset.id);
  else if (t.matches(".view")) setView(t.dataset.view);
  else if (t.matches(".dtab")) { state.dtab = t.dataset.dtab; if (state.detail) renderDetail(state.detail, true); }
  else if (t.matches(".tab")) {
    $$(".tab").forEach((b) => {
      const on = b === t;
      b.classList.toggle("border-brand-600", on); b.classList.toggle("font-medium", on);
      b.classList.toggle("border-transparent", !on); b.classList.toggle("text-slate-500", !on);
    });
    $("#tab-samples").classList.toggle("hidden", t.dataset.tab !== "samples");
    $("#tab-upload").classList.toggle("hidden", t.dataset.tab !== "upload");
  }
});

function setView(v) {
  state.view = v;
  $$(".view").forEach((b) => {
    const on = b.dataset.view === v;
    b.classList.toggle("border-brand-600", on); b.classList.toggle("font-medium", on);
    b.classList.toggle("border-transparent", !on); b.classList.toggle("text-slate-500", !on);
  });
  $("#view-enquiries").classList.toggle("hidden", v !== "enquiries");
  $("#view-exceptions").classList.toggle("hidden", v !== "exceptions");
  schedule(0);
}

function renderRanges() {
  $("#ranges").innerHTML = RANGES.map(([k, l]) =>
    `<button data-range="${k}" class="px-2.5 py-1 rounded-md ${state.range === k ? "bg-brand-600 text-white" : "hover:bg-slate-100 text-slate-600"}">${l}</button>`).join("");
  $("#custom-range").classList.toggle("hidden", state.range !== "custom");
}

function setRange(r) {
  state.range = r;
  storage.set("range", r);
  renderRanges();
  schedule(0);
}

// chart tooltips
document.addEventListener("mousemove", (ev) => {
  const el = ev.target.closest("[data-tip]");
  const tip = $("#tip");
  if (!el) { tip.classList.add("hidden"); return; }
  tip.innerHTML = el.dataset.tip;
  tip.classList.remove("hidden");
  const x = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = Math.min(ev.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
});

$("#d-close").onclick = closeDetail;
$("#scrim").onclick = closeDetail;
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });

let qTimer;
$("#q").addEventListener("input", (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value.trim(); schedule(0); }, 300); });
$("#from").addEventListener("change", (e) => { state.from = e.target.value; schedule(0); });
$("#to").addEventListener("change", (e) => { state.to = e.target.value; schedule(0); });
$("#presenter").addEventListener("change", (e) => { setPresenter(e.target.checked); schedule(0); });
$("#demo-btn").onclick = () => $("#demo-pop").classList.toggle("hidden");

$("#tab-upload").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const form = new FormData(ev.target);
  for (const k of ["attachment", "eml"]) if (!form.get(k)?.name) form.delete(k);
  run("Processing email", () => api("/api/enquiries", { method: "POST", body: form }));
});

async function pollNow() {
  await run("Checking inbox", async () => {
    const r = await api("/api/inbox/poll", { method: "POST" });
    toast(`${r.new_enquiry_ids.length} new email(s)`);
    return null;
  });
}

async function resetDemo() {
  if (!confirm("Delete all enquiries, logs and notifications from the local database?")) return;
  await api("/api/admin/reset", { method: "POST" });
  $("#feed").innerHTML = "";
  state.lastEventId = 0;
  state.active = null;
  closeDetail();
  await pollEvents(true);
  schedule(0);
}

$("#btn-poll").onclick = pollNow;
$("#btn-reset").onclick = resetDemo;
document.addEventListener("click", (ev) => {
  if (ev.target.closest("#pop-poll")) pollNow();
  else if (ev.target.closest("#pop-reset")) resetDemo();
  else if (ev.target.closest("#pop-exit")) setPresenter(false);
});

$("#btn-test").onclick = async () => {
  const btn = $("#btn-test");
  btn.disabled = true; btn.textContent = "Testing…";
  try {
    const r = await api("/api/readiness/test", { method: "POST" });
    renderReadiness(r.config);
    $("#live-list").innerHTML = r.live.map((c) => `<li class="flex gap-2"><span>${c.ok === true ? "✅" : c.ok === false ? "❌" : "⏭"}</span><span><b>${esc(c.label)}:</b> ${esc(c.detail)}</span></li>`).join("");
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = "Test live connections (read-only)"; }
};

(async function init() {
  $$("[data-icon]").forEach((el) => { el.innerHTML = icon(el.dataset.icon, "w-4 h-4"); });
  state.range = storage.get("range") || "7d";
  renderRanges();
  const s = await api("/api/status");
  state.status = s;
  renderBadges(s);
  renderReadiness(s.readiness);
  renderDemoControls(s);
  setPresenter(storage.get("presenter") === "1");
  $("#tab-samples").innerHTML = `<p class="text-xs text-slate-500 mb-1">Each sample is a real .eml run through the same path as inbox mail. Running one twice shows de-duplication.</p>` +
    s.samples.map((x) => `<button data-sample="${esc(x.key)}" class="w-full text-left text-sm px-3 py-2 rounded-lg border border-slate-200 hover:border-brand-300 hover:bg-brand-50">${esc(x.label)}</button>`).join("");
  $("#tab-upload [name=sender_email]").value = s.monitored_inbox;
  if (s.login_enabled) {
    $("#user-box").classList.remove("hidden");
    $("#user-name").textContent = s.user;
  }
  await pollEvents(true);
  await refresh();
  const deep = location.hash.match(/^#enquiry=(\d+)/);  // links in notification emails
  if (deep) openDetail(deep[1]);
})();

$("#btn-logout").onclick = async () => { await fetch("/api/logout", { method: "POST" }); location.href = "/login"; };

// --- setup page ------------------------------------------------------------------------
const setupState = { view: null };

function setupField(f) {
  const id = `f-${f.key}`;
  const help = f.help ? `<div class="text-xs text-slate-500 mt-0.5">${esc(f.help)}</div>` : "";
  let input;
  if (f.type === "secret") {
    input = `<input id="${id}" data-key="${f.key}" data-secret="1" type="password" autocomplete="new-password"
      placeholder="${f.is_set ? "•••••• saved — leave blank to keep" : "not set"}" class="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm">`;
  } else if (f.type === "bool") {
    input = `<label class="flex items-center gap-2 text-sm"><input id="${id}" data-key="${f.key}" data-bool="1" type="checkbox" ${["true", "1", "yes"].includes(String(f.value).toLowerCase()) ? "checked" : ""}> Yes</label>`;
  } else if (f.type.startsWith("select:")) {
    input = `<select id="${id}" data-key="${f.key}" class="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm bg-white">${f.type.slice(7).split(",").map((o) =>
      `<option ${o === f.value ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  } else {
    input = `<input id="${id}" data-key="${f.key}" type="${f.type === "number" ? "text" : f.type}" value="${esc(f.value)}"
      class="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm">`;
  }
  return `<div><label for="${id}" class="block text-sm font-medium text-slate-700 mb-1">${esc(f.label)}</label>${input}${help}</div>`;
}

function optionCards(name, options, selected) {
  return `<div class="grid sm:grid-cols-2 gap-2">${options.map((o) => `
    <label class="flex gap-2 p-3 rounded-xl border cursor-pointer ${o.key === selected ? "border-brand-500 bg-brand-50 ring-1 ring-brand-200" : "border-slate-200 hover:border-brand-300"}">
      <input type="radio" name="${name}" value="${esc(o.key)}" ${o.key === selected ? "checked" : ""} class="mt-1">
      <span><span class="font-medium">${esc(o.name)}</span>${o.info ? `<span class="block text-xs text-slate-500">${esc(o.info)}</span>` : ""}</span>
    </label>`).join("")}</div>`;
}

function setupSection(n, title, body) {
  return `<section class="bg-white rounded-xl border border-slate-200 p-4"><h3 class="font-semibold mb-3">${n}. ${esc(title)}</h3>${body}</section>`;
}

function zohoPanel(erp, v) {
  const f = Object.fromEntries(erp.fields.map((x) => [x.key, x]));
  const connected = f.ZOHO_REFRESH_TOKEN?.is_set && f.ZOHO_ORGANIZATION_ID?.value;
  const input = (id, label, type = "text", ph = "") => `<div><label for="${id}" class="block text-sm font-medium text-slate-700 mb-1">${label}</label>
    <input id="${id}" type="${type}" placeholder="${esc(ph)}" autocomplete="off" class="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm"></div>`;
  return `
    <div class="mt-3 rounded-xl border ${connected ? "border-emerald-200 bg-emerald-50/60" : "border-brand-200 bg-brand-50/50"} p-4">
      <div class="flex flex-wrap items-center gap-2"><span class="font-medium">Connect Zoho Books</span>
        ${connected ? pill([`✓ connected · organization ${f.ZOHO_ORGANIZATION_ID.value}`, "bg-emerald-100 text-emerald-800"]) : pill(["not connected", "bg-amber-100 text-amber-800"])}</div>
      <ol class="text-xs text-slate-600 list-decimal ml-5 mt-2 space-y-1">
        <li>Log in to <b>api-console.zoho.${esc(f.ZOHO_DC?.value || "in")}</b> as the Zoho Books admin → <b>Add Client</b> → <b>Self Client</b> → Create.</li>
        <li>Open <b>Generate Code</b>, paste this scope, choose <b>10 minutes</b>, then Create:
          <div class="flex gap-2 mt-1"><code id="zoho-scope" class="flex-1 block bg-white border border-slate-200 rounded px-2 py-1 text-[11px] break-all">${esc(v.zoho_scopes)}</code>
          <button id="zoho-copy" class="text-xs px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50 self-start">Copy</button></div></li>
        <li>Paste the Client ID, Client Secret and the generated code below and press <b>Connect</b> (the code works once, within its time limit).</li>
      </ol>
      <div class="grid sm:grid-cols-2 gap-3 mt-3">
        <div><label for="zc-dc" class="block text-sm font-medium text-slate-700 mb-1">Data centre</label>
          <select id="zc-dc" class="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm bg-white">${["in", "com", "eu", "com.au", "jp", "ca", "sa"].map((d) =>
            `<option ${d === (f.ZOHO_DC?.value || "in") ? "selected" : ""}>${d}</option>`).join("")}</select></div>
        ${input("zc-id", "Client ID", "text", f.ZOHO_CLIENT_ID?.value || "")}
        ${input("zc-secret", "Client Secret", "password")}
        ${input("zc-code", "Generated code", "password")}
      </div>
      <div class="flex flex-wrap items-center gap-2 mt-3"><button id="zoho-connect" class="text-sm px-4 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700">Connect</button>
        <span id="zoho-result" class="text-sm"></span></div>
      <div id="zoho-choose" class="mt-2"></div>
      <details class="mt-3"><summary class="text-xs text-slate-500 cursor-pointer">Enter credentials manually instead</summary>
        <div class="grid sm:grid-cols-2 gap-3 mt-2">${erp.fields.map(setupField).join("")}</div></details>
    </div>
    ${connected ? `
    <div class="mt-3 rounded-xl border border-slate-200 p-4">
      <div class="font-medium">Demo customer &amp; items for the POC</div>
      <p class="text-xs text-slate-500">Adds the demo customer (${esc(v.erp_demo_email || "the demo sender")}) and 13 items modelled on the sample RFQ to Zoho Books — some with the customer's material code as SKU, one without a price. Existing records are skipped.</p>
      <div class="grid sm:grid-cols-3 gap-3 mt-2 text-sm">
        <div><label class="block text-xs text-slate-600 mb-1" for="zd-gst">GST treatment (GST-registered orgs)</label>
          <select id="zd-gst" class="w-full border border-slate-300 rounded-lg px-2 py-1.5 bg-white"><option value="">— not needed —</option>
            ${["business_gst", "business_none", "consumer", "overseas"].map((g) => `<option>${g}</option>`).join("")}</select></div>
        ${input("zd-place", "Place of supply (state code)", "text", "e.g. AP")}
        ${input("zd-hsn", "HSN code for demo items", "text", "e.g. 8536")}
      </div>
      <div class="flex flex-wrap gap-2 mt-3"><button id="zd-preview" class="text-sm px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50">Preview</button>
        <button id="zd-apply" class="text-sm px-3 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700">Create in Zoho Books</button></div>
      <ul id="zd-result" class="mt-2 space-y-1 text-xs"></ul>
    </div>` : ""}`;
}

function renderSetup() {
  const v = setupState.view;
  const erp = v.erp_options.find((o) => o.key === v.erp_connector) || v.erp_options[0];
  const aiOpt = v.ai_options.find((o) => o.key === v.ai_provider) || v.ai_options[0];
  const grid = (fields) => fields.length ? `<div class="grid sm:grid-cols-2 gap-3 mt-3">${fields.map(setupField).join("")}</div>` : "";
  const priceList = ["standalone", "webhook"].includes(erp.key) ? `
    <div class="mt-3 rounded-lg border border-dashed border-slate-300 p-3 text-sm">
      <div class="font-medium">Price list ${v.price_list.present ? '<span class="text-emerald-700">✓ uploaded</span>' : '<span class="text-amber-700">— not uploaded yet</span>'}</div>
      <div class="text-xs text-slate-500 mb-2">Excel or CSV with columns like Item code, Item name, Unit, Price, Description. Upload again any time to update prices.</div>
      <div class="flex flex-wrap gap-2 items-center"><input id="pl-file" type="file" accept=".xlsx,.xls,.csv" class="text-sm">
        <button id="pl-upload" class="text-sm px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50">Upload price list</button>
        <span id="pl-result" class="text-xs"></span></div></div>` : "";
  const erpBody = erp.key === "zoho_books" ? zohoPanel(erp, v) : grid(erp.fields) + priceList;
  const erpHeader = v.erp_locked
    ? `<p class="text-sm text-slate-600">${esc(erp.info)}</p>
       <label class="flex items-center gap-2 text-sm mt-2"><input id="erp-demo" type="checkbox" ${v.erp_demo ? "checked" : ""}>
         Use demo data until ${esc(erp.name)} is connected <span class="text-xs text-slate-500">(switches off automatically when you connect)</span></label>`
    : optionCards("erp", v.erp_options, erp.key);
  $("#setup-body").innerHTML = [
    setupSection(1, v.erp_locked ? `Accounting system: ${erp.name}` : "Accounting system", erpHeader + erpBody),
    setupSection(2, v.ai_locked ? `AI: ${aiOpt.name}` : "AI", (v.ai_locked ? "" : optionCards("ai", v.ai_options, aiOpt.key)) + grid(aiOpt.fields)),
    setupSection(3, "Email", `<p class="text-sm text-slate-500">The inbox the agent watches and who receives drafts and alerts.</p>${grid(v.mail)}`),
    setupSection(4, "Rules", grid(v.rules)),
    setupSection(5, "Security", (v.security.find((f) => f.key === "ADMIN_PASSWORD").is_set ? "" :
      `<p class="text-sm text-amber-800 bg-amber-50 rounded-lg px-3 py-2">No admin password yet — anyone who can open this page can change settings.</p>`) + grid(v.security)),
  ].join("");
  $$('#setup-body input[name="erp"]').forEach((r) => r.onchange = () => { setupState.view.erp_connector = r.value; renderSetup(); });
  $$('#setup-body input[name="ai"]').forEach((r) => r.onchange = () => { setupState.view.ai_provider = r.value; renderSetup(); });
  const demo = $("#erp-demo");
  if (demo) demo.onchange = () => { setupState.view.erp_demo = demo.checked; };
  wireZoho();
  const up = $("#pl-upload");
  if (up) up.onclick = async () => {
    const file = $("#pl-file").files[0];
    if (!file) return toast("Choose a price list file first");
    const form = new FormData();
    form.append("file", file);
    try {
      const r = await api("/api/setup/price-list", { method: "POST", body: form });
      $("#pl-result").innerHTML = `<span class="text-emerald-700">✓ ${r.items} items${r.without_price ? ` (${r.without_price} without a price — they'll be flagged)` : ""}</span>`;
      setupState.view.price_list.present = true;
    } catch (e) { $("#pl-result").innerHTML = `<span class="text-rose-700">${esc(e.message)}</span>`; }
  };
}

async function afterZohoConnected(r) {
  toast(`Connected to ${r.organization.name}`);
  setupState.view = await api("/api/setup");
  renderSetup();
  const s = await api("/api/status");
  state.status = s;
  renderBadges(s);
  renderReadiness(s.readiness);
}

function wireZoho() {
  const copy = $("#zoho-copy");
  if (copy) copy.onclick = () => { navigator.clipboard?.writeText($("#zoho-scope").textContent); toast("Scope copied"); };
  const connect = $("#zoho-connect");
  if (connect) connect.onclick = async () => {
    const body = { dc: $("#zc-dc").value, client_id: $("#zc-id").value.trim() || $("#zc-id").placeholder,
                   client_secret: $("#zc-secret").value, code: $("#zc-code").value };
    $("#zoho-result").innerHTML = '<span class="text-slate-500">Connecting…</span>';
    try {
      const r = await api("/api/setup/zoho/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.connected) return afterZohoConnected(r);
      $("#zoho-result").innerHTML = '<span class="text-slate-600">Pick your organization:</span>';
      $("#zoho-choose").innerHTML = r.choose.map((o) => `<button data-org="${esc(o.id)}" class="mr-2 mb-2 text-sm px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-brand-50">${esc(o.name)} <span class="text-xs text-slate-500">${esc(o.id)}</span></button>`).join("");
      $$("#zoho-choose [data-org]").forEach((b) => b.onclick = async () => {
        try {
          const done = await api("/api/setup/zoho/connect", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pending: r.pending, organization_id: b.dataset.org }) });
          afterZohoConnected(done);
        } catch (e) { $("#zoho-result").innerHTML = `<span class="text-rose-700">${esc(e.message)}</span>`; }
      });
    } catch (e) { $("#zoho-result").innerHTML = `<span class="text-rose-700">${esc(e.message)}</span>`; }
  };
  const demoCall = async (apply) => {
    const body = { apply, gst_treatment: $("#zd-gst").value, place_of_supply: $("#zd-place").value, hsn: $("#zd-hsn").value };
    $("#zd-result").innerHTML = `<li class="text-slate-500">${apply ? "Creating in Zoho Books…" : "Checking Zoho Books…"}</li>`;
    try {
      const r = await api("/api/setup/zoho/demo-data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const lines = apply ? r.results.map((x) => `<li>${x.ok ? "✅" : "❌"} ${esc(x.label)}${x.ok ? "" : ` — <span class="text-rose-700">${esc(x.detail)}</span>`}</li>`)
                          : r.todo.map((t) => `<li>➕ ${esc(t)}</li>`);
      $("#zd-result").innerHTML = [...lines, ...r.notes.map((n) => `<li class="text-slate-500">• ${esc(n)} — skipped</li>`)].join("")
        || '<li class="text-emerald-700">Everything is already in Zoho Books.</li>';
    } catch (e) { $("#zd-result").innerHTML = `<li class="text-rose-700">${esc(e.message)}</li>`; }
  };
  if ($("#zd-preview")) $("#zd-preview").onclick = () => demoCall(false);
  if ($("#zd-apply")) $("#zd-apply").onclick = () => { if (confirm("Create the demo customer and items in your Zoho Books organization?")) demoCall(true); };
}

async function openSetup() {
  setupState.view = await api("/api/setup");
  renderSetup();
  $("#setup-live").innerHTML = "";
  $("#setup").classList.remove("hidden");
}

$("#btn-setup").onclick = openSetup;
$("#setup-close").onclick = () => $("#setup").classList.add("hidden");
$("#setup-save").onclick = async () => {
  const v = setupState.view;
  const values = { ERP_CONNECTOR: v.erp_locked && v.erp_demo ? "mock" : v.erp_connector, AI_PROVIDER: v.ai_provider };
  $$("#setup-body [data-key]").forEach((el) => {
    if (el.dataset.secret && !el.value) return;
    values[el.dataset.key] = el.dataset.bool ? (el.checked ? "true" : "false") : el.value;
  });
  try {
    const r = await api("/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) });
    setupState.view = r.setup;
    renderSetup();
    toast(r.changed.length ? `Saved — ${r.changed.length} setting(s) updated` : "No changes");
    const s = await api("/api/status");
    state.status = s;
    renderBadges(s);
    renderReadiness(s.readiness);
    renderDemoControls(s);
  } catch (e) { toast(e.message, 6000); }
};
$("#setup-test").onclick = async () => {
  $("#setup-live").innerHTML = '<li class="text-slate-500">Testing…</li>';
  try {
    const r = await api("/api/readiness/test", { method: "POST" });
    $("#setup-live").innerHTML = r.live.map((c) => `<li class="flex gap-2"><span>${c.ok === true ? "✅" : c.ok === false ? "❌" : "⏭"}</span><span><b>${esc(c.label)}:</b> ${esc(c.detail)}</span></li>`).join("");
  } catch (e) { $("#setup-live").innerHTML = `<li class="text-rose-700">${esc(e.message)}</li>`; }
};
