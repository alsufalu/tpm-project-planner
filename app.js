/* TPM Project Planner — plain JavaScript, no build step. */
(() => {
  const cfg = window.PLANNER_CONFIG;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);

  const STATUSES = ["Not started", "In progress", "Pending", "Complete"];
  const S_CLASS = { "Not started": "s-ns", "In progress": "s-ip", "Pending": "s-pd", "Complete": "s-cp" };
  const S_HINT = {
    "Not started": "Still needs to be started",
    "In progress": "Being worked on now",
    "Pending": "Waiting on someone or something",
    "Complete": "Done",
  };

  const state = {
    session: null, milestones: [], tasks: [], members: [], activity: [], attachments: [],
    view: "board", q: "", owner: "", phase: "", hideComplete: false, tileFilter: null,
    openId: null, authMode: "join", recovering: false, joining: false,
    sortField: "plan", sortDir: "asc",          // main views
    taskSortField: "plan", taskSortDir: "asc",  // task list inside a milestone
  };
  const SORT_FIELDS = ["plan", "start_date", "end_date", "priority"];
  try {
    const saved = JSON.parse(localStorage.getItem("tpm-sort") || "null");
    if (saved && SORT_FIELDS.includes(saved.f)) { state.sortField = saved.f; state.sortDir = saved.d === "desc" ? "desc" : "asc"; }
    const savedT = JSON.parse(localStorage.getItem("tpm-task-sort") || "null");
    if (savedT && SORT_FIELDS.includes(savedT.f)) { state.taskSortField = savedT.f; state.taskSortDir = savedT.d === "desc" ? "desc" : "asc"; }
  } catch (_) { /* storage unavailable */ }

  const PRIORITIES = ["Critical", "High", "Normal", "Low"];
  const P_RANK = { Critical: 0, High: 1, Normal: 2, Low: 3 };
  const P_CLASS = { Critical: "p-crit", High: "p-high", Normal: "p-norm", Low: "p-low" };
  const prio = (x) => (x && PRIORITIES.includes(x.priority) ? x.priority : "Normal");
  // Tag shown on cards; "Normal" stays quiet unless asked for.
  const prioTag = (x, showNormal = false) => { const p = prio(x); return p === "Normal" && !showNormal ? "" : `<span class="prio ${P_CLASS[p]}" title="Priority: ${p}">${p === "Critical" ? "⚑ " : ""}${p}</span>`; };

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const parseD = (s) => { if (!s) return null; const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const fmtD = (s) => { const d = parseD(s); return d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—"; };
  const fmtRange = (a, b) => (a || b) ? `${fmtD(a)} → ${fmtD(b)}` : "No dates yet";
  const isLate = (x) => x.status !== "Complete" && !x.ongoing && x.end_date && parseD(x.end_date) < today();
  // Ongoing items have no end date; a review date reminds the team to check on them.
  const reviewDue = (x) => x.ongoing && x.status !== "Complete" && x.review_date && parseD(x.review_date) <= today();
  const daysBetween = (a, b) => Math.round((parseD(b) - parseD(a)) / 86400000);
  // One-line date summary used on cards and task rows.
  function dateLine(x, withRange = false) {
    if (x.status === "Complete" && x.completed_on) {
      const late = x.end_date && !x.ongoing ? daysBetween(x.end_date, x.completed_on) : 0;
      return `<span class="done-date">✓ Completed ${fmtD(x.completed_on)}${late > 0 ? ` <span class="late-soft">(${late} day${late > 1 ? "s" : ""} after due)</span>` : ""}</span>`;
    }
    if (x.ongoing) {
      const rv = x.review_date ? ` · <span class="${reviewDue(x) ? "late" : ""}">${reviewDue(x) ? "review was due " : "review by "}${fmtD(x.review_date)}</span>` : "";
      return `<span class="ongoing">🔁 Ongoing${x.start_date ? " since " + fmtD(x.start_date) : ""}</span>${rv}`;
    }
    if (withRange) return `<span class="${isLate(x) ? "late" : ""}">📅 ${fmtRange(x.start_date, x.end_date)}${isLate(x) ? " · overdue" : ""}</span>`;
    return `<span class="${isLate(x) ? "late" : ""}">📅 ${x.end_date ? (isLate(x) ? "Was due " : "Due ") + fmtD(x.end_date) : "No due date"}</span>`;
  }
  const needsAttention = (x) => isLate(x) || reviewDue(x);
  const ago = (iso) => {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`; if (s < 604800) return `${Math.floor(s / 86400)} d ago`;
    return new Date(iso).toLocaleDateString();
  };
  const people = (owner) => (owner || "").split(/\s*(?:\/|,|&|\band\b)\s*/i).map((p) => p.trim()).filter(Boolean);
  // Who the signed-in person is in pm_members: their email, or "code:<id>" for people who joined with the team code.
  const myKey = () => { const u = state.session?.user; return u ? (u.email ? u.email.toLowerCase() : "code:" + u.id) : ""; };
  const isCodeKey = (k) => (k || "").startsWith("code:");
  const nameFor = (email) => { const m = state.members.find((x) => x.email === email); return (m && m.display_name) || (isCodeKey(email) ? "Partner" : email && !email.includes("@") ? email : email ? email.split("@")[0] : "someone"); };
  const pill = (status) => `<span class="pill ${S_CLASS[status]}">${esc(status)}</span>`;
  const statusSelect = (status, attrs) =>
    `<select class="status-select ${S_CLASS[status]}" ${attrs}>${STATUSES.map((s) => `<option ${s === status ? "selected" : ""}>${s}</option>`).join("")}</select>`;

  function toast(msg, err = false) {
    const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = "toast"), 2600);
  }
  function show(id) {
    ["auth-view", "nomember-view", "reset-view", "app-view"].forEach((v) => $("#" + v).classList.toggle("hidden", v !== id));
  }
  const tasksOf = (mid) => state.tasks.filter((t) => t.milestone_id === mid).sort((a, b) => a.position - b.position);
  const pctOfTask = (t) => (t.status === "Complete" ? 100 : t.percent_done || 0);
  function progress(m) {
    const ts = tasksOf(m.id);
    if (!ts.length) return { pct: m.status === "Complete" ? 100 : 0, done: 0, total: 0 };
    return { pct: Math.round(ts.reduce((a, t) => a + pctOfTask(t), 0) / ts.length), done: ts.filter((t) => t.status === "Complete").length, total: ts.length };
  }
  const milestoneById = (id) => state.milestones.find((m) => m.id === id);

  // ---------- attachments ----------
  // Files live in the private Supabase Storage bucket "pm-attachments"; only team members can reach them.
  const BUCKET = "pm-attachments";
  const MAX_BYTES = 50 * 1024 * 1024;
  const filesOf = (taskId) => state.attachments.filter((a) => a.task_id === taskId);
  const filesOfMilestone = (mid) => { const ids = new Set(tasksOf(mid).map((t) => t.id)); return state.attachments.filter((a) => ids.has(a.task_id)); };
  const fmtSize = (b) => b == null ? "" : b < 1024 ? b + " B" : b < 1048576 ? Math.round(b / 1024) + " KB" : (b / 1048576).toFixed(1) + " MB";
  const fileIcon = (name) => { const ext = (name.split(".").pop() || "").toLowerCase();
    return ({ pdf: "📕", doc: "📘", docx: "📘", xls: "📗", xlsx: "📗", csv: "📗", ppt: "📙", pptx: "📙", png: "🖼", jpg: "🖼", jpeg: "🖼", gif: "🖼", webp: "🖼", heic: "🖼", dwg: "📐", zip: "🗜" })[ext] || "📄"; };
  const safeName = (n) => n.normalize("NFKD").replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "_").slice(-120) || "file";

  async function uploadFiles(taskId, fileList) {
    const files = [...fileList];
    for (const f of files) {
      if (f.size > MAX_BYTES) { toast(`“${f.name}” is over 50 MB and can't be attached.`, true); continue; }
      toast(`Uploading ${f.name}…`);
      const path = `${taskId}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safeName(f.name)}`;
      const up = await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type || "application/octet-stream", upsert: false });
      if (up.error) { toast(`Upload failed for ${f.name}: ${up.error.message}`, true); continue; }
      const ins = await sb.from("pm_attachments").insert({ task_id: taskId, file_name: f.name, storage_path: path, size_bytes: f.size, content_type: f.type || null });
      if (ins.error) { await sb.storage.from(BUCKET).remove([path]); toast(`Couldn't save ${f.name}: ${ins.error.message}`, true); continue; }
    }
    await loadAll();
    if (files.length) toast(files.length > 1 ? `${files.length} files attached` : "File attached");
  }
  // How a file opens: browsers show PDFs, images, text, audio and video themselves; Word/Excel/PowerPoint
  // open in Microsoft's free online viewer; anything else is downloaded (a browser can't show it).
  const extOf = (name) => (name.split(".").pop() || "").toLowerCase();
  const BROWSER_VIEW = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "txt", "csv", "mp4", "webm", "mov", "mp3", "wav", "m4a"]);
  const OFFICE_VIEW = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx"]);
  const openMode = (name) => BROWSER_VIEW.has(extOf(name)) ? "browser" : OFFICE_VIEW.has(extOf(name)) ? "office" : "download";
  async function openFile(id) {
    const a = state.attachments.find((x) => x.id === id); if (!a) return;
    const mode = openMode(a.file_name);
    if (mode === "download") { toast(`A browser can't display .${extOf(a.file_name)} files, so it's downloading instead.`); return downloadFile(id); }
    const w = window.open("about:blank", "_blank"); // open now, so pop-up blockers allow it
    if (w) w.document.write(`<title>${esc(a.file_name)}</title><p style="font:16px system-ui;padding:24px;color:#555">Opening ${esc(a.file_name)}…</p>`);
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(a.storage_path, 3600);
    if (error) { if (w) w.close(); return toast("Couldn't open file: " + error.message, true); }
    const url = mode === "office" ? "https://view.officeapps.live.com/op/view.aspx?src=" + encodeURIComponent(data.signedUrl) : data.signedUrl;
    if (w) w.location.href = url; else window.location.href = url;
  }
  async function downloadFile(id) {
    const a = state.attachments.find((x) => x.id === id); if (!a) return;
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(a.storage_path, 3600, { download: a.file_name });
    if (error) return toast("Couldn't download file: " + error.message, true);
    const link = document.createElement("a"); link.href = data.signedUrl; link.download = a.file_name; document.body.appendChild(link); link.click(); link.remove();
  }
  async function removeFiles(list) {
    if (!list.length) return true;
    const st = await sb.storage.from(BUCKET).remove(list.map((a) => a.storage_path));
    if (st.error) { toast("Couldn't remove file: " + st.error.message, true); return false; }
    const db = await sb.from("pm_attachments").delete().in("id", list.map((a) => a.id));
    if (db.error) { toast("Couldn't remove file: " + db.error.message, true); return false; }
    return true;
  }
  function filesHTML(t) {
    const fs = filesOf(t.id);
    return `<div class="files" data-filedrop="${t.id}">
      ${fs.map((a) => `<div class="file">
        <span class="ficon">${fileIcon(a.file_name)}</span>
        <button class="fname link" data-file-open="${a.id}" title="Open in a new tab">${esc(a.file_name)}</button>
        <span class="muted fmeta">${fmtSize(a.size_bytes)} · ${esc(nameFor(a.uploaded_by))} · ${ago(a.created_at)}</span>
        <span class="factions">
          <button class="btn ghost small" data-file-open="${a.id}" title="${openMode(a.file_name) === "office" ? "Open in a new tab (Microsoft online viewer)" : openMode(a.file_name) === "download" ? "This type can't be shown in a browser — downloads it" : "Open in a new tab"}">${openMode(a.file_name) === "download" ? "⬇ Get" : "↗ Open"}</button>
          <button class="btn ghost small" data-file-dl="${a.id}" title="Download">⬇</button>
          <button class="btn danger-ghost small" data-file-del="${a.id}" title="Remove file">✕</button>
        </span>
      </div>`).join("")}
      <label class="attach-btn" title="Attach files (or drag them onto this task)">📎 Attach file<input type="file" multiple hidden data-attach="${t.id}"></label>
    </div>`;
  }

  // ---------- sorting ----------
  // Plan order = the order in the original plan. Date sorts put items with no date at the bottom either way.
  function planKey(x) {
    if (x.milestone_id) { const m = milestoneById(x.milestone_id); return [(m ? m.position : 0), x.position]; }
    return [x.position, 0];
  }
  // Priority "asc" = most important first. Ties fall back to end date, then plan order.
  function sortItems(list, f = state.sortField, dirName = state.sortDir) {
    const dir = dirName === "desc" ? -1 : 1;
    const byPlan = (a, b) => { const ka = planKey(a), kb = planKey(b); return ka[0] - kb[0] || ka[1] - kb[1]; };
    const byDate = (a, b, k) => { const va = a[k], vb = b[k]; if (!va && !vb) return 0; if (!va) return 1; if (!vb) return -1; return va < vb ? -1 : va > vb ? 1 : 0; };
    return [...list].sort((a, b) => {
      if (f === "plan") return byPlan(a, b) * dir;
      if (f === "priority") return (P_RANK[prio(a)] - P_RANK[prio(b)]) * dir || byDate(a, b, "end_date") || byPlan(a, b);
      const va = a[f], vb = b[f];
      if (!va && !vb) return byPlan(a, b);
      if (!va) return 1;
      if (!vb) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir || byPlan(a, b);
    });
  }
  function dirLabel(field, dir) {
    if (field === "plan") return dir === "asc" ? "↑ First to last" : "↓ Last to first";
    if (field === "priority") return dir === "asc" ? "↑ Most important first" : "↓ Least important first";
    return dir === "asc" ? "↑ Earliest first" : "↓ Latest first";
  }
  function renderSortControls() {
    $("#sort-field").value = state.sortField;
    $("#sort-dir").textContent = dirLabel(state.sortField, state.sortDir);
  }
  function setSort(field, dir) {
    state.sortField = field; state.sortDir = dir;
    try { localStorage.setItem("tpm-sort", JSON.stringify({ f: field, d: dir })); } catch (_) { /* ignore */ }
    renderSortControls(); renderAll();
  }
  function setTaskSort(field, dir) {
    state.taskSortField = field; state.taskSortDir = dir;
    try { localStorage.setItem("tpm-task-sort", JSON.stringify({ f: field, d: dir })); } catch (_) { /* ignore */ }
    renderDrawer();
  }

  // ---------- filtering ----------
  const textMatch = (x) => !state.q || [x.title, x.owner, x.comments, x.dependencies].join(" ").toLowerCase().includes(state.q);
  const ownerMatch = (owner) => !state.owner || people(owner).some((p) => p.toLowerCase() === state.owner.toLowerCase());
  // Phases group milestones (e.g. "Interior Construction"); "__none" = milestones without a phase.
  const NO_PHASE = "__none";
  const phaseOf = (m) => (m && m.phase && m.phase.trim()) || "";
  const phaseMatch = (m) => !state.phase || (state.phase === NO_PHASE ? !phaseOf(m) : phaseOf(m) === state.phase);
  const allPhases = () => [...new Set(state.milestones.map(phaseOf).filter(Boolean))].sort((a, b) => {
    // order phases by their earliest milestone in plan order
    const first = (ph) => Math.min(...state.milestones.filter((m) => phaseOf(m) === ph).map((m) => m.position));
    return first(a) - first(b);
  });
  const tileMatch = (x) => !state.tileFilter || (state.tileFilter === "late" ? needsAttention(x) : x.status === state.tileFilter);
  function milestoneVisible(m) {
    const ts = tasksOf(m.id);
    if (!phaseMatch(m)) return false;
    if (state.hideComplete && m.status === "Complete") return false;
    if (!tileMatch(m)) return false;
    const t1 = textMatch(m) || ts.some(textMatch);
    const o1 = ownerMatch(m.owner) || ts.some((t) => ownerMatch(t.owner));
    return t1 && o1;
  }
  function taskVisible(t) {
    const m = milestoneById(t.milestone_id);
    if (!phaseMatch(m)) return false;
    if (state.hideComplete && t.status === "Complete") return false;
    if (!tileMatch(t)) return false;
    return (textMatch(t) || (m && textMatch(m))) && ownerMatch(t.owner || (m && m.owner));
  }

  // ---------- data ----------
  async function loadAll() {
    const [ms, ts, mem, at] = await Promise.all([
      sb.from("pm_milestones").select("*").order("position"),
      sb.from("pm_tasks").select("*").order("position"),
      sb.from("pm_members").select("*").order("created_at"),
      sb.from("pm_attachments").select("*").order("created_at"),
    ]);
    const err = ms.error || ts.error || mem.error;
    if (err) { toast("Couldn't load data: " + err.message, true); return; }
    state.milestones = ms.data; state.tasks = ts.data; state.members = mem.data; state.attachments = at.error ? [] : at.data;
    renderAll();
  }
  async function loadActivity() {
    const { data, error } = await sb.from("pm_activity").select("*").not("actor", "is", null).order("at", { ascending: false }).limit(150);
    if (!error) state.activity = data;
  }

  async function save(table, id, patch) {
    const { error } = id ? await sb.from(table).update(patch).eq("id", id) : await sb.from(table).insert(patch);
    if (error) { toast("Save failed: " + error.message, true); return false; }
    await loadAll(); return true;
  }
  async function remove(table, id) {
    const { error } = await sb.from(table).delete().eq("id", id);
    if (error) { toast("Delete failed: " + error.message, true); return false; }
    await loadAll(); return true;
  }
  async function setTaskStatus(id, status) {
    const patch = { status }; if (status === "Complete") patch.percent_done = 100;
    if (await save("pm_tasks", id, patch)) toast(`Task set to ${status}`);
  }
  async function setMilestoneStatus(id, status) {
    if (await save("pm_milestones", id, { status })) toast(`Milestone set to ${status}`);
  }

  let realtime;
  function subscribe() {
    if (realtime) return;
    let t;
    const refresh = () => { clearTimeout(t); t = setTimeout(async () => { await loadAll(); if (state.view === "activity") { await loadActivity(); renderActivity(); } }, 400); };
    realtime = sb.channel("pm-planner")
      .on("postgres_changes", { event: "*", schema: "public", table: "pm_milestones" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "pm_tasks" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "pm_attachments" }, refresh)
      .subscribe();
  }

  // ---------- rendering ----------
  function renderAll() {
    renderHeader(); renderSummary(); renderKeyDates(); renderPhases(); renderOwnerFilter(); renderPhaseFilter();
    if (state.view === "board") renderBoard();
    if (state.view === "tasks") renderTaskBoard();
    if (state.view === "list") renderList();
    if (state.view === "reports") renderReports();
    if (state.openId) renderDrawer();
  }

  // ----- phases strip: one card per phase with its overall progress -----
  function phaseStats(list) {
    const ts = list.flatMap((m) => tasksOf(m.id));
    const pct = ts.length ? Math.round(ts.reduce((a, t) => a + pctOfTask(t), 0) / ts.length) : Math.round(list.filter((m) => m.status === "Complete").length / Math.max(1, list.length) * 100);
    const starts = list.map((m) => m.start_date).filter(Boolean).sort(), ends = list.map((m) => m.end_date).filter(Boolean).sort();
    return { pct, done: ts.filter((t) => t.status === "Complete").length, total: ts.length, start: starts[0], end: ends[ends.length - 1],
      late: list.some(needsAttention) || ts.some(needsAttention), active: list.filter((m) => m.status === "In progress").length };
  }
  function renderPhases() {
    const phases = allPhases(); const el = $("#phases");
    if (!phases.length) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    const groups = phases.map((ph) => ({ key: ph, name: ph, list: state.milestones.filter((m) => phaseOf(m) === ph) }));
    const rest = state.milestones.filter((m) => !phaseOf(m));
    if (rest.length) groups.push({ key: NO_PHASE, name: "Other (no phase)", list: rest });
    el.innerHTML = groups.map((g) => { const st = phaseStats(g.list); return `
      <button class="phase-card ${state.phase === g.key ? "on" : ""} ${g.key === NO_PHASE ? "other" : ""}" data-phase="${esc(g.key)}" title="Click to show only this phase">
        <div class="ph-top"><span class="ph-name">${esc(g.name)}</span><span class="ph-pct">${st.pct}%</span></div>
        <div class="bar"><span style="width:${st.pct}%"></span></div>
        <div class="ph-meta">${g.list.length} milestone${g.list.length === 1 ? "" : "s"} · ${st.done}/${st.total} tasks done${st.start || st.end ? ` · ${fmtShort(st.start)} – ${fmtShort(st.end)}` : ""}${st.late ? ` · <span class="late">needs attention</span>` : ""}</div>
      </button>`; }).join("");
  }
  function renderPhaseFilter() {
    const sel = $("#phase-filter"); const phases = allPhases();
    sel.classList.toggle("hidden", !phases.length);
    sel.innerHTML = `<option value="">All phases</option>` + phases.map((p) => `<option ${p === state.phase ? "selected" : ""}>${esc(p)}</option>`).join("") +
      (state.milestones.some((m) => !phaseOf(m)) ? `<option value="${NO_PHASE}" ${state.phase === NO_PHASE ? "selected" : ""}>Other (no phase)</option>` : "");
  }
  const fmtShort = (s) => { const d = parseD(s); return d ? d.toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "—"; };
  // ----- key dates strip: checkpoints flagged with "Key date" -----
  function keyRange(x) {
    if (x.ongoing) return x.start_date ? "from " + fmtD(x.start_date) : "ongoing";
    if (x.start_date && x.end_date && x.start_date !== x.end_date) {
      const a = parseD(x.start_date), b = parseD(x.end_date);
      return a.getFullYear() === b.getFullYear()
        ? `${a.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${b.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
        : `${fmtD(x.start_date)} – ${fmtD(x.end_date)}`;
    }
    return fmtD(x.end_date || x.start_date);
  }
  function renderKeyDates() {
    const items = [...state.milestones.filter((m) => m.key_date).map((m) => ({ x: m, mid: m.id })),
                   ...state.tasks.filter((t) => t.key_date).map((t) => ({ x: t, mid: t.milestone_id, tid: t.id }))]
      .filter((k) => phaseMatch(milestoneById(k.mid)))
      .sort((a, b) => (a.x.start_date || a.x.end_date || "9999").localeCompare(b.x.start_date || b.x.end_date || "9999"));
    const el = $("#keydates");
    if (!items.length) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    el.innerHTML = `<span class="kd-label">★ Key dates</span>` + items.map(({ x, mid, tid }) => {
      const target = x.end_date || x.start_date; const done = x.status === "Complete";
      const days = target ? daysBetween(today().toISOString().slice(0, 10), target) : null;
      const when = done ? "✓ done" : days == null ? "" : days > 0 ? `in ${days} day${days === 1 ? "" : "s"}` : days === 0 ? "today" : `${-days} days ago`;
      return `<button class="kd ${done ? "done" : isLate(x) ? "late-kd" : ""}" data-open="${mid}" ${tid ? `data-focus="${tid}"` : ""} title="${esc(x.title)}">
        <span class="kd-title">${esc(x.title.split("\n")[0])}</span><span class="kd-date">${keyRange(x)}</span>${when ? `<span class="kd-when">· ${when}</span>` : ""}</button>`;
    }).join("");
  }

  function renderHeader() {
    const all = state.tasks; const done = all.filter((t) => t.status === "Complete").length;
    const pct = all.length ? Math.round(all.reduce((a, t) => a + pctOfTask(t), 0) / all.length) : 0;
    $("#overall-label").textContent = `${pct}% overall · ${done} of ${all.length} tasks complete`;
    $("#overall-bar").style.width = pct + "%";
    $("#who").textContent = state.session?.user?.email || nameFor(myKey());
  }

  function renderSummary() {
    // When a phase is selected, the tiles count only that phase.
    const ms = state.milestones.filter(phaseMatch), ts = state.tasks.filter((t) => phaseMatch(milestoneById(t.milestone_id)));
    const tiles = STATUSES.map((s) => ({ key: s, cls: S_CLASS[s], n: ms.filter((m) => m.status === s).length, sub: `${ts.filter((t) => t.status === s).length} tasks`, label: s === "Not started" ? "Not started yet" : s }));
    const rv = [...ms, ...ts].filter(reviewDue).length;
    tiles.push({ key: "late", cls: "s-late", n: ms.filter(needsAttention).length, sub: `${ts.filter(isLate).length} tasks past due${rv ? ` · ${rv} review${rv > 1 ? "s" : ""} due` : ""}`, label: "Overdue" });
    $("#summary").innerHTML = tiles.map((t) => `
      <button class="tile ${t.cls} ${state.tileFilter === t.key ? "on" : ""}" data-tile="${t.key}" title="${t.key === "late" ? "End date has passed and not complete" : esc(S_HINT[t.key])} — click to filter">
        <div class="l">${esc(t.label)}</div><div class="n">${t.n}</div><div class="s">milestones · ${esc(t.sub)}</div>
      </button>`).join("");
  }

  function renderOwnerFilter() {
    const sel = $("#owner-filter"); const cur = state.owner;
    const set = new Map();
    [...state.milestones, ...state.tasks].forEach((x) => people(x.owner).forEach((p) => { const k = p.toLowerCase(); if (!set.has(k)) set.set(k, p); }));
    const names = [...set.values()].sort((a, b) => a.localeCompare(b));
    sel.innerHTML = `<option value="">Everyone</option>` + names.map((n) => `<option ${n.toLowerCase() === cur.toLowerCase() ? "selected" : ""}>${esc(n)}</option>`).join("");
  }

  function columnsHTML(items, cardFn, kind) {
    const cols = STATUSES.filter((s) => !(state.hideComplete && s === "Complete")).filter((s) => !state.tileFilter || state.tileFilter === "late" || state.tileFilter === s);
    return `<div class="board" style="${cols.length < 4 ? `grid-template-columns:repeat(${cols.length},minmax(240px,1fr))` : ""}">` + cols.map((s) => {
      const list = items.filter((x) => x.status === s);
      return `<div class="col ${S_CLASS[s]}" data-drop="${s}" data-kind="${kind}">
        <div class="col-head"><h3>${esc(s)}</h3><span class="count">${list.length}</span></div>
        <div class="col-hint">${esc(S_HINT[s])}</div>
        <div class="cards">${list.map(cardFn).join("") || `<div class="empty">Nothing here</div>`}</div>
      </div>`;
    }).join("") + `</div>`;
  }

  function milestoneCard(m) {
    const p = progress(m); const ts = tasksOf(m.id);
    const chips = STATUSES.map((s) => { const n = ts.filter((t) => t.status === s).length; return n ? `<span class="chip ${S_CLASS[s]}" title="${s}">${n} ${s.toLowerCase()}</span>` : ""; }).join("");
    return `<div class="card ${S_CLASS[m.status]}" draggable="true" data-open="${m.id}" data-drag="${m.id}">
      ${prioTag(m) || (phaseOf(m) && !state.phase) || m.key_date ? `<div class="tags">${m.key_date ? `<span class="star" title="Key date">★</span>` : ""}${prioTag(m)}${phaseOf(m) && !state.phase ? `<span class="phase-tag">${esc(phaseOf(m))}</span>` : ""}</div>` : ""}<h4>${esc(m.title)}</h4>
      <div class="meta"><span>👤 ${esc(m.owner || "Unassigned")}</span>${dateLine(m)}</div>
      <div class="prog"><div class="bar"><span style="width:${p.pct}%"></span></div><span>${p.total ? `${p.done}/${p.total} tasks` : "No tasks"}</span></div>
      ${chips || filesOfMilestone(m.id).length ? `<div class="chips">${chips}${filesOfMilestone(m.id).length ? `<span class="chip clip" title="Attached files">📎 ${filesOfMilestone(m.id).length}</span>` : ""}</div>` : ""}
    </div>`;
  }
  function taskCard(t) {
    const m = milestoneById(t.milestone_id);
    return `<div class="card ${S_CLASS[t.status]}" draggable="true" data-open="${t.milestone_id}" data-focus="${t.id}" data-drag="${t.id}">
      <div class="parent">${esc(m ? m.title : "")}</div>
      ${prioTag(t) || t.key_date ? `<div class="tags">${t.key_date ? `<span class="star" title="Key date">★ Key date</span>` : ""}${prioTag(t)}</div>` : ""}<h4>${esc(t.title)}</h4>
      <div class="meta"><span>👤 ${esc(t.owner || (m && m.owner) || "Unassigned")}</span>${dateLine(t)}${t.percent_done && t.status !== "Complete" ? `<span>${t.percent_done}%</span>` : ""}${filesOf(t.id).length ? `<span title="Attached files">📎 ${filesOf(t.id).length}</span>` : ""}</div>
    </div>`;
  }

  function renderBoard() {
    const items = sortItems(state.milestones.filter(milestoneVisible));
    $("#view-board").innerHTML = columnsHTML(items, milestoneCard, "milestone");
  }
  function renderTaskBoard() {
    const items = sortItems(state.tasks.filter(taskVisible));
    $("#view-tasks").innerHTML = columnsHTML(items, taskCard, "task");
  }

  function renderList() {
    const rows = [];
    sortItems(state.milestones).forEach((m) => {
      const ts = sortItems(tasksOf(m.id).filter(taskVisible));
      if (!milestoneVisible(m) && !ts.length) return;
      const p = progress(m);
      rows.push(`<tr class="ms-row" data-open="${m.id}"><td>${esc(m.title)}${phaseOf(m) && !state.phase ? ` <span class="phase-tag">${esc(phaseOf(m))}</span>` : ""}</td><td>${prioTag(m, true)}</td><td>${esc(m.owner || "")}</td><td>${pill(m.status)}</td><td class="num">${fmtD(m.start_date)}</td><td class="num ${isLate(m) ? "late" : ""}">${m.ongoing ? "Ongoing" : fmtD(m.end_date)}</td><td class="num">${m.status === "Complete" && m.completed_on ? "✓ " + fmtD(m.completed_on) : p.pct + "%"}</td></tr>`);
      ts.forEach((t) => rows.push(`<tr class="task-row"><td>${esc(t.title)}</td><td>${prioTag(t, true)}</td><td>${esc(t.owner || "")}</td><td>${statusSelect(t.status, `data-task-status="${t.id}"`)}</td><td class="num">${fmtD(t.start_date)}</td><td class="num ${isLate(t) ? "late" : ""}">${t.ongoing ? "Ongoing" : fmtD(t.end_date)}</td><td class="num">${t.status === "Complete" && t.completed_on ? "✓ " + fmtD(t.completed_on) : pctOfTask(t) + "%"}</td></tr>`));
    });
    $("#view-list").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Milestone / task</th><th>Priority</th><th>Owner</th><th>Status</th><th>Start</th><th>End</th><th>Done</th></tr></thead><tbody>${rows.join("") || `<tr><td colspan="7" class="empty">Nothing matches your filters</td></tr>`}</tbody></table></div>`;
  }

  // =====================================================================
  // REPORTS: 1) Project status report  2) Timeline (Gantt)  3) Workload & look-ahead
  // Reports respect the phase / person filters and "Hide complete".
  // =====================================================================
  state.report = "status"; state.horizon = 14;
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return iso(d); };
  const todayIso = () => { const d = today(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const P_ORDER = (x) => P_RANK[prio(x)];
  // Health: red = a key date or a Critical/High item is overdue; amber = anything overdue / review due; green = on track.
  function health(ms) {
    const ts = ms.flatMap((m) => tasksOf(m.id));
    const all = [...ms, ...ts];
    if (all.length && all.every((x) => x.status === "Complete")) return { key: "done", label: "Complete", icon: "✓" };
    if (all.some((x) => isLate(x) && (x.key_date || P_ORDER(x) <= 1))) return { key: "red", label: "At risk", icon: "▲" };
    if (all.some(needsAttention)) return { key: "amber", label: "Watch", icon: "●" };
    return { key: "green", label: "On track", icon: "✓" };
  }
  const healthBadge = (h) => `<span class="health h-${h.key}"><span aria-hidden="true">${h.icon}</span> ${h.label}</span>`;
  const repMilestones = () => state.milestones.filter((m) => phaseMatch(m) && ownerMatchM(m));
  const ownerMatchM = (m) => !state.owner || ownerMatch(m.owner) || tasksOf(m.id).some((t) => ownerMatch(t.owner));
  const repTasks = () => state.tasks.filter((t) => { const m = milestoneById(t.milestone_id); return phaseMatch(m) && ownerMatch(t.owner || (m && m.owner)); });
  const taskLine = (t, extra = "") => { const m = milestoneById(t.milestone_id);
    return `<li data-open="${t.milestone_id}" data-focus="${t.id}"><span class="rl-main">${t.key_date ? "★ " : ""}${esc(t.title.split("\n")[0])}</span>
      <span class="rl-sub">${esc(m ? m.title : "")} · 👤 ${esc(t.owner || (m && m.owner) || "Unassigned")}${extra}</span></li>`; };
  const scopeLine = () => [state.phase ? (state.phase === NO_PHASE ? "Other (no phase)" : state.phase) : "All phases", state.owner || "Everyone"].join(" · ");

  function renderReports() {
    const tabs = [["status", "Project status report"], ["timeline", "Timeline (Gantt)"], ["workload", "Workload & look-ahead"]];
    const body = state.report === "timeline" ? reportTimeline() : state.report === "workload" ? reportWorkload() : reportStatus();
    $("#view-reports").innerHTML = `
      <div class="rep-bar no-print">
        <div class="tabs">${tabs.map(([k, l]) => `<button data-report="${k}" class="${state.report === k ? "active" : ""}">${l}</button>`).join("")}</div>
        <div class="rep-actions">
          ${state.report === "status" || state.report === "workload" ? `<label class="check">Look ahead
            <select id="rep-horizon">${[7, 14, 30, 60].map((n) => `<option value="${n}" ${state.horizon === n ? "selected" : ""}>${n} days</option>`).join("")}</select></label>` : ""}
          <button class="btn" id="rep-print">🖨 Print / Save as PDF</button>
        </div>
      </div>
      <article class="report">${body}</article>`;
  }

  // ---------- 1. Project status report ----------
  function reportStatus() {
    const ms = repMilestones(), ts = repTasks(), t0 = todayIso(), until = addDays(t0, state.horizon), since = addDays(t0, -state.horizon);
    const pct = ts.length ? Math.round(ts.reduce((a, t) => a + pctOfTask(t), 0) / ts.length) : 0;
    const h = health(ms);
    const done = ts.filter((t) => t.status === "Complete").length;
    const overdue = ts.filter(needsAttention).sort((a, b) => P_ORDER(a) - P_ORDER(b) || (a.end_date || "").localeCompare(b.end_date || ""));
    const recent = ts.filter((t) => t.status === "Complete" && t.completed_on && t.completed_on >= since).sort((a, b) => b.completed_on.localeCompare(a.completed_on));
    const upcoming = ts.filter((t) => t.status !== "Complete" && !isLate(t) && ((t.end_date && t.end_date >= t0 && t.end_date <= until) || (t.start_date && t.start_date >= t0 && t.start_date <= until)))
      .sort((a, b) => (a.start_date || a.end_date || "").localeCompare(b.start_date || b.end_date || ""));
    const keys = [...ms.filter((m) => m.key_date), ...ts.filter((t) => t.key_date)].sort((a, b) => (a.start_date || a.end_date || "9").localeCompare(b.start_date || b.end_date || "9"));
    const phases = [...new Set(ms.map(phaseOf))].sort((a, b) => Math.min(...ms.filter((m) => phaseOf(m) === a).map((m) => m.position)) - Math.min(...ms.filter((m) => phaseOf(m) === b).map((m) => m.position)));
    const opening = state.tasks.find((t) => /grand opening/i.test(t.title)) || state.milestones.find((m) => /official opening/i.test(m.title));
    const daysToOpen = opening && opening.start_date ? daysBetween(t0, opening.start_date) : null;
    return `
      <header class="rep-head">
        <div><h2>Project status report</h2><div class="muted">${esc(cfg.projectName)} · ${esc(scopeLine())} · ${today().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })} · prepared by ${esc(nameFor(myKey()))}</div></div>
        ${healthBadge(h)}
      </header>
      <section class="rep-kpis">
        <div class="kpi"><div class="k">Overall progress</div><div class="v">${pct}%</div><div class="bar"><span style="width:${pct}%"></span></div></div>
        <div class="kpi"><div class="k">Tasks complete</div><div class="v">${done}<span class="of">/${ts.length}</span></div></div>
        <div class="kpi"><div class="k">Overdue / review due</div><div class="v ${overdue.length ? "late" : ""}">${overdue.length}</div></div>
        <div class="kpi"><div class="k">${opening ? "Days to grand opening" : "Due next " + state.horizon + " days"}</div><div class="v">${opening && daysToOpen != null ? daysToOpen : upcoming.length}</div>${opening && opening.start_date ? `<div class="muted small">${fmtD(opening.start_date)}</div>` : ""}</div>
      </section>

      <h3>Status by phase</h3>
      <div class="table-wrap"><table class="rep-table">
        <thead><tr><th>Phase</th><th>Health</th><th>Progress</th><th>Tasks done</th><th>Dates</th><th>Overdue</th></tr></thead>
        <tbody>${phases.map((ph) => { const list = ms.filter((m) => phaseOf(m) === ph); const st = phaseStats(list); const pts = list.flatMap((m) => tasksOf(m.id));
          return `<tr data-phase="${esc(ph || NO_PHASE)}" class="clickable"><td><strong>${esc(ph || "Other (no phase)")}</strong></td><td>${healthBadge(health(list))}</td>
            <td><div class="mini-bar"><div class="bar"><span style="width:${st.pct}%"></span></div>${st.pct}%</div></td><td class="num">${st.done}/${st.total}</td>
            <td class="num">${st.start ? fmtShort(st.start) : "—"} – ${st.end ? fmtShort(st.end) : "—"}</td><td class="num ${pts.filter(needsAttention).length ? "late" : ""}">${pts.filter(needsAttention).length || "—"}</td></tr>`; }).join("")}</tbody>
      </table></div>

      ${keys.length ? `<h3>Key dates</h3><ul class="rep-list keys">${keys.map((k) => { const target = k.end_date || k.start_date; const d = target ? daysBetween(t0, target) : null;
        return `<li data-open="${k.milestone_id || k.id}" ${k.milestone_id ? `data-focus="${k.id}"` : ""}><span class="rl-main">★ ${esc(k.title.split("\n")[0])}</span>
          <span class="rl-sub">${keyRange(k)} · ${k.status === "Complete" ? `<span class="ok">✓ done</span>` : isLate(k) ? `<span class="late">missed by ${-d} days</span>` : d == null ? "no date" : `in ${d} days`}</span></li>`; }).join("")}</ul>` : ""}

      <div class="rep-cols">
        <section><h3>✓ Completed in the last ${state.horizon} days <span class="count">${recent.length}</span></h3>
          ${recent.length ? `<ul class="rep-list">${recent.map((t) => taskLine(t, ` · ✓ ${fmtD(t.completed_on)}`)).join("")}</ul>` : `<p class="muted">Nothing marked complete in this period.</p>`}</section>
        <section><h3>→ Coming up in the next ${state.horizon} days <span class="count">${upcoming.length}</span></h3>
          ${upcoming.length ? `<ul class="rep-list">${upcoming.map((t) => taskLine(t, ` · ${t.start_date && t.start_date >= t0 ? "starts " + fmtD(t.start_date) : "due " + fmtD(t.end_date)}`)).join("")}</ul>` : `<p class="muted">Nothing starting or due in this period.</p>`}</section>
      </div>

      <h3>⚠ Overdue &amp; needs attention <span class="count">${overdue.length}</span></h3>
      ${overdue.length ? `<ul class="rep-list">${overdue.map((t) => taskLine(t, ` · ${prioTag(t)} <span class="late">${reviewDue(t) ? "review was due " + fmtD(t.review_date) : "was due " + fmtD(t.end_date) + " (" + daysBetween(t.end_date, t0) + " days)"}</span>`)).join("")}</ul>` : `<p class="muted">Nothing overdue. 🎉</p>`}
      <p class="muted small rep-foot">Health: <b>On track</b> = nothing overdue · <b>Watch</b> = something overdue or a review is due · <b>At risk</b> = a key date or a Critical/High item is overdue.</p>`;
  }

  // ---------- 2. Timeline (Gantt) ----------
  function reportTimeline() {
    const ms = repMilestones().filter((m) => !state.hideComplete || m.status !== "Complete");
    const dated = ms.filter((m) => m.start_date || m.end_date);
    if (!dated.length) return `<header class="rep-head"><h2>Timeline</h2></header><p class="muted">No dated milestones for this selection.</p>`;
    const t0 = todayIso();
    let lo = dated.map((m) => m.start_date || m.end_date).sort()[0], hi = dated.map((m) => m.end_date || m.start_date).sort().slice(-1)[0];
    if (t0 < lo) lo = t0; if (t0 > hi) hi = t0;
    const a = parseD(lo), b = parseD(hi); a.setDate(1); b.setMonth(b.getMonth() + 1, 1);
    const span = (b - a) / 86400000;
    const x = (s) => ((parseD(s) - a) / 86400000) / span * 100;
    const months = []; for (const d = new Date(a); d < b; d.setMonth(d.getMonth() + 1)) months.push(new Date(d));
    const monthCells = months.map((d) => { const s = iso(new Date(d.getFullYear(), d.getMonth(), 1)); const e = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      return `<div class="g-month" style="left:${x(s)}%;width:${((e - d) / 86400000) / span * 100}%"><span>${d.toLocaleDateString(undefined, { month: "short" })}${d.getMonth() === 0 || d.getTime() === months[0].getTime() ? " " + d.getFullYear() : ""}</span></div>`; }).join("");
    const grid = months.map((d) => `<div class="g-line" style="left:${x(iso(new Date(d.getFullYear(), d.getMonth(), 1)))}%"></div>`).join("");
    const todayLine = `<div class="g-today" style="left:${x(t0)}%"><span>Today</span></div>`;
    const phases = [...new Set(ms.map(phaseOf))].sort((p, q) => Math.min(...ms.filter((m) => phaseOf(m) === p).map((m) => m.position)) - Math.min(...ms.filter((m) => phaseOf(m) === q).map((m) => m.position)));
    const rows = phases.map((ph) => {
      const list = sortItems(ms.filter((m) => phaseOf(m) === ph), "start_date", "asc");
      const st = phaseStats(list);
      const phRow = st.start && st.end ? `<div class="g-row g-phase"><div class="g-label"><strong>${esc(ph || "Other (no phase)")}</strong><span class="muted">${st.pct}%</span></div>
        <div class="g-track">${grid}<div class="g-phasebar" style="left:${x(st.start)}%;width:${Math.max(0.4, x(st.end) - x(st.start))}%"></div></div></div>` : "";
      return phRow + list.map((m) => {
        const s = m.start_date || m.end_date, e = m.ongoing ? (hi > t0 ? hi : t0) : (m.end_date || m.start_date);
        const p = progress(m), late = isLate(m);
        const keyMarks = tasksOf(m.id).filter((t) => t.key_date && (t.end_date || t.start_date)).map((t) => { const kd = t.title.match(/grand opening/i) ? (t.start_date || t.end_date) : (t.end_date || t.start_date);
          return `<span class="g-key" style="left:${x(kd)}%" title="★ ${esc(t.title.split("\n")[0])} · ${fmtD(kd)}">◆</span>`; }).join("");
        const tip = `${m.title}\n${m.ongoing ? "Ongoing since " + fmtD(m.start_date) : fmtD(s) + " → " + fmtD(e)}\n${m.status} · ${p.pct}% · ${p.done}/${p.total} tasks${late ? "\nOVERDUE" : ""}`;
        return `<div class="g-row" data-open="${m.id}"><div class="g-label" title="${esc(m.title)}">${m.key_date ? "★ " : ""}${esc(m.title)}</div>
          <div class="g-track">${grid}${s ? `<div class="g-bar ${S_CLASS[m.status]} ${late ? "is-late" : ""} ${m.ongoing ? "is-ongoing" : ""}" style="left:${x(s)}%;width:${Math.max(0.6, x(e) - x(s))}%" title="${esc(tip)}">
            <span class="g-fill" style="width:${p.pct}%"></span></div>` : `<span class="muted small g-nodate">no dates</span>`}${keyMarks}</div></div>`;
      }).join("");
    }).join("");
    return `<header class="rep-head"><div><h2>Timeline</h2><div class="muted">${esc(scopeLine())} · ${fmtD(iso(a))} – ${fmtD(addDays(iso(b), -1))}</div></div></header>
      <div class="g-legend">${STATUSES.map((st) => `<span><i class="sw ${S_CLASS[st]}"></i>${st}</span>`).join("")}<span><i class="sw sw-late"></i>Overdue (red outline)</span><span><i class="sw sw-fill"></i>Darker part = % done</span><span>◆ Key date</span></div>
      <div class="gantt"><div class="g-row g-head"><div class="g-label"></div><div class="g-track">${monthCells}</div></div>
        <div class="g-body">${rows}<div class="g-overlay"><div class="g-label"></div><div class="g-track">${todayLine}</div></div></div></div>
      <p class="muted small rep-foot">Hover a bar for details; click a row to open the milestone.</p>`;
  }

  // ---------- 3. Workload & look-ahead ----------
  function reportWorkload() {
    const t0 = todayIso(), until = addDays(t0, state.horizon);
    const open = repTasks().filter((t) => t.status !== "Complete");
    const byPerson = new Map();
    open.forEach((t) => { const m = milestoneById(t.milestone_id); const ppl = people(t.owner || (m && m.owner)); (ppl.length ? ppl : ["Unassigned"]).forEach((p) => {
      const k = p.toLowerCase(); if (!byPerson.has(k)) byPerson.set(k, { name: p, tasks: [] }); byPerson.get(k).tasks.push(t); }); });
    const rows = [...byPerson.values()].map((p) => {
      const overdue = p.tasks.filter(needsAttention), inprog = p.tasks.filter((t) => t.status === "In progress" || t.status === "Pending"),
        soon = p.tasks.filter((t) => !needsAttention(t) && ((t.end_date && t.end_date <= until) || (t.start_date && t.start_date >= t0 && t.start_date <= until)));
      return { ...p, overdue, inprog, soon };
    }).sort((a, b) => b.overdue.length - a.overdue.length || b.soon.length - a.soon.length || a.name.localeCompare(b.name));
    const maxOpen = Math.max(1, ...rows.map((r) => r.tasks.length));
    return `<header class="rep-head"><div><h2>Workload &amp; look-ahead</h2><div class="muted">${esc(scopeLine())} · open tasks per person, what's overdue, and what's due in the next ${state.horizon} days</div></div></header>
      <div class="table-wrap"><table class="rep-table">
        <thead><tr><th>Person</th><th>Open tasks</th><th>In progress</th><th>Overdue</th><th>Next ${state.horizon} days</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td><strong>${esc(r.name)}</strong></td>
          <td><div class="mini-bar"><div class="bar load"><span style="width:${r.tasks.length / maxOpen * 100}%"></span></div>${r.tasks.length}</div></td>
          <td class="num">${r.inprog.length || "—"}</td><td class="num ${r.overdue.length ? "late" : ""}">${r.overdue.length || "—"}</td><td class="num">${r.soon.length || "—"}</td></tr>`).join("")}</tbody>
      </table></div>
      <p class="muted small">Tasks shared by several people (e.g. "Srini/Vivek") count for each of them; tasks without an owner use their milestone's owner.</p>
      ${rows.map((r) => (r.overdue.length || r.soon.length) ? `<section class="person"><h3>${esc(r.name)} <span class="count">${r.overdue.length + r.soon.length}</span></h3>
        ${r.overdue.length ? `<div class="sub late">⚠ Overdue / needs attention</div><ul class="rep-list">${r.overdue.sort((a, b) => P_ORDER(a) - P_ORDER(b)).map((t) => taskLine(t, ` · ${prioTag(t)} <span class="late">${reviewDue(t) ? "review was due " + fmtD(t.review_date) : "was due " + fmtD(t.end_date)}</span>`)).join("")}</ul>` : ""}
        ${r.soon.length ? `<div class="sub">→ Next ${state.horizon} days</div><ul class="rep-list">${r.soon.sort((a, b) => (a.end_date || a.start_date || "").localeCompare(b.end_date || b.start_date || "")).map((t) => taskLine(t, ` · ${prioTag(t)} ${t.start_date && t.start_date >= t0 ? "starts " + fmtD(t.start_date) + (t.end_date ? ", due " + fmtD(t.end_date) : "") : "due " + fmtD(t.end_date)} · ${t.status}`)).join("")}</ul>` : ""}
      </section>` : "").join("") || `<p class="muted">Nothing overdue or coming up for this selection.</p>`}`;
  }

  function renderActivity() {
    const list = state.activity;
    $("#view-activity").innerHTML = `<div class="activity">${list.map((a) => {
      const m = a.milestone_id && milestoneById(a.milestone_id);
      if (a.entity === "plan") return `<div class="act"><time title="${new Date(a.at).toLocaleString()}">${ago(a.at)}</time><div><strong>Planner update:</strong> ${esc(a.action)}</div></div>`;
      const what = `${a.entity} <strong>${esc(a.title)}</strong>`;
      return `<div class="act"><time title="${new Date(a.at).toLocaleString()}">${ago(a.at)}</time><div><strong>${esc(nameFor(a.actor))}</strong> ${esc(a.action)} ${what}${m && (a.entity === "task" || a.entity === "file") ? ` in <a data-open="${m.id}">${esc(m.title)}</a>` : m ? ` · <a data-open="${m.id}">open</a>` : ""}</div></div>`;
    }).join("") || `<div class="empty">No changes recorded yet. Edits made in the planner will show up here.</div>`}</div>`;
  }

  // ---------- drawer ----------
  function openDrawer(id, focusTask) {
    state.openId = id; renderDrawer();
    $("#drawer").classList.add("open"); $("#drawer").setAttribute("aria-hidden", "false");
    $("#drawer-scrim").classList.remove("hidden");
    if (focusTask) setTimeout(() => { const el = $(`[data-task="${focusTask}"]`); if (el) { el.scrollIntoView({ block: "center" }); el.animate([{ background: "#fff7cc" }, { background: "#fff" }], 1600); } }, 260);
  }
  function closeDrawer() {
    state.openId = null; $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true");
    $("#drawer-scrim").classList.add("hidden");
  }
  function renderDrawer() {
    const m = milestoneById(state.openId);
    if (!m) { closeDrawer(); return; }
    const ts = sortItems(tasksOf(m.id), state.taskSortField, state.taskSortDir); const p = progress(m);
    const canMove = state.taskSortField === "plan" && state.taskSortDir === "asc";
    $("#drawer-body").innerHTML = `
      <div class="drawer-tags">${ts.length ? `${pill(m.status)} <span class="muted auto-note" title="A milestone's status follows its tasks">set by its tasks</span>` : statusSelect(m.status, `data-ms-status="${m.id}"`)} ${prioTag(m, true)}${m.ongoing ? ` <span class="ongoing">🔁 Ongoing</span>` : ""}${phaseOf(m) ? ` <span class="phase-tag">${esc(phaseOf(m))}</span>` : ""}${m.key_date ? ` <span class="star">★ Key date</span>` : ""}</div>
      <h2>${esc(m.title)}</h2>
      <div class="facts">
        <div class="fact"><div class="k">Owner</div><div class="v">${esc(m.owner || "Unassigned")}</div></div>
        <div class="fact"><div class="k">Start</div><div class="v">${fmtD(m.start_date)}</div></div>
        ${m.status === "Complete" && m.completed_on
          ? `<div class="fact"><div class="k">Completed</div><div class="v">${fmtD(m.completed_on)}</div></div>`
          : m.ongoing
            ? `<div class="fact"><div class="k">${m.review_date ? "Review by" : "End"}</div><div class="v ${reviewDue(m) ? "late" : ""}">${m.review_date ? fmtD(m.review_date) : "Ongoing"}</div></div>`
            : `<div class="fact"><div class="k">End</div><div class="v ${isLate(m) ? "late" : ""}">${fmtD(m.end_date)}</div></div>`}
        <div class="fact"><div class="k">Progress</div><div class="v">${p.pct}% <span class="muted" style="font-size:12px;font-weight:500">(${p.done}/${p.total} tasks)</span></div></div>
      </div>
      <div class="bar"><span style="width:${p.pct}%"></span></div>
      ${m.dependencies ? `<div class="note"><b>Depends on</b>${esc(m.dependencies)}</div>` : ""}
      ${m.comments ? `<div class="note"><b>Comments</b>${esc(m.comments)}</div>` : ""}
      <p class="muted" style="font-size:12px">Last updated ${ago(m.updated_at)}${m.updated_by ? " by " + esc(nameFor(m.updated_by)) : ""}</p>

      <div class="section-head"><h3>Tasks (${ts.length})</h3><button class="btn small" data-add-task="${m.id}">＋ Add task with details</button></div>
      ${ts.length > 1 ? `<div class="task-sort">
        <span class="muted">Sort tasks by</span>
        <div class="sort-group">
          <select id="task-sort-field" aria-label="Sort tasks by">
            ${[["plan", "Plan order"], ["start_date", "Start date"], ["end_date", "End date"], ["priority", "Priority"]].map(([v, l]) => `<option value="${v}" ${v === state.taskSortField ? "selected" : ""}>${l}</option>`).join("")}
          </select>
          <button class="btn" type="button" id="task-sort-dir">${dirLabel(state.taskSortField, state.taskSortDir)}</button>
        </div>
        ${canMove ? "" : `<span class="muted hint">↑↓ reordering works in plan order</span>`}
      </div>` : ""}
      ${ts.map((t, i) => `
        <div class="task ${S_CLASS[t.status]} ${t.status === "Complete" ? "done" : ""}" data-task="${t.id}">
          <div>
            <h4>${t.key_date ? `<span class="star" title="Key date">★</span> ` : ""}${esc(t.title)}</h4>
            <div class="meta">${prioTag(t)}<span>👤 ${esc(t.owner || "Unassigned")}</span>${dateLine(t, true)}</div>
          </div>
          <div class="right">
            ${statusSelect(t.status, `data-task-status="${t.id}"`)}
            <div class="pct"><div class="bar"><span style="width:${pctOfTask(t)}%"></span></div>${pctOfTask(t)}%</div>
            <div class="row-actions">
              <button class="btn ghost small" title="Move up" data-move="${t.id}" data-dir="-1" ${!canMove || i === 0 ? "disabled" : ""}>↑</button>
              <button class="btn ghost small" title="Move down" data-move="${t.id}" data-dir="1" ${!canMove || i === ts.length - 1 ? "disabled" : ""}>↓</button>
              <button class="btn ghost small" title="Edit" data-edit-task="${t.id}">✎</button>
              <button class="btn danger-ghost small" title="Delete" data-del-task="${t.id}">🗑</button>
            </div>
          </div>
          ${t.dependencies || t.comments ? `<div class="extra">${t.dependencies ? `<b>Depends on:</b> ${esc(t.dependencies)}` : ""}${t.dependencies && t.comments ? "<br>" : ""}${t.comments ? `<b>Comments:</b> ${esc(t.comments)}` : ""}</div>` : ""}
          ${filesHTML(t)}
        </div>`).join("") || `<div class="empty">No tasks yet — add the first one below.</div>`}
      <form class="quick-add" id="quick-add"><input type="text" placeholder="Quick add a task… (press Enter)" required><button class="btn primary" type="submit">Add</button></form>`;
  }

  // ---------- modals ----------
  // Forms only close via Cancel/Save (or Esc / clicking outside when nothing was typed),
  // so a text selection that ends outside the box can't throw away someone's edits.
  let modalDirty = false;
  function modal(title, bodyHTML) {
    $("#modal-title").textContent = title; $("#modal-body").innerHTML = bodyHTML;
    modalDirty = false;
    $$("#modal-body form").forEach((f) => { f.addEventListener("input", () => { modalDirty = true; }); f.addEventListener("change", () => { modalDirty = true; }); });
    $("#modal-wrap").classList.remove("hidden");
    setTimeout(() => { const f = $("#modal-body input, #modal-body textarea"); if (f) f.focus(); }, 30);
  }
  const closeModal = () => $("#modal-wrap").classList.add("hidden");
  function confirmBox(title, text, okLabel = "Delete") {
    return new Promise((resolve) => {
      modal(title, `<p>${text}</p><div class="modal-actions"><button class="btn" data-c="0">Cancel</button><button class="btn danger" data-c="1">${esc(okLabel)}</button></div>`);
      $$("#modal-body [data-c]").forEach((b) => b.onclick = () => { closeModal(); resolve(b.dataset.c === "1"); });
    });
  }
  // Read a milestone/task form: blanks become null, "ongoing" clears the end date.
  function formData(form) {
    const d = Object.fromEntries(new FormData(form));
    Object.keys(d).forEach((k) => { d[k] = String(d[k]).trim() || null; });
    d.ongoing = !!form.ongoing?.checked;
    if (form.key_date) d.key_date = !!form.key_date.checked;
    if (d.ongoing && "end_date" in d) d.end_date = null; else d.review_date = d.review_date || null;
    if (d.status && d.status !== "Complete") d.completed_on = null;
    return d;
  }
  // Ticking "Ongoing" greys out the end date.
  document.addEventListener("change", (e) => {
    if (e.target.name !== "ongoing") return;
    const end = e.target.form && e.target.form.end_date;
    if (end && !end.closest("label").querySelector(".hint-inline")) { end.disabled = e.target.checked; if (e.target.checked) end.value = ""; }
  });
  const opt = (list, cur) => list.map((s) => `<option ${s === cur ? "selected" : ""}>${esc(s)}</option>`).join("");

  function milestoneForm(m) {
    const isNew = !m; m = m || { status: "Not started" };
    modal(isNew ? "New milestone" : "Edit milestone", `
      <form id="mform" class="form-grid">
        <label class="full">Milestone name<input type="text" name="title" required value="${esc(m.title)}"></label>
        <label>Owner<input type="text" name="owner" value="${esc(m.owner)}" placeholder="e.g. Vivek/Alberto"></label>
        <label><span>Status${!isNew && tasksOf(m.id).length ? ` <span class="muted hint-inline">· set by its tasks</span>` : ""}</span><select name="status" ${!isNew && tasksOf(m.id).length ? "disabled" : ""}>${opt(STATUSES, m.status)}</select></label>
        <label>Priority<select name="priority">${opt(PRIORITIES, prio(m))}</select></label>
        <label><span>Phase <span class="muted hint-inline">· groups milestones</span></span><input type="text" name="phase" list="phase-list" value="${esc(m.phase)}" placeholder="None"><datalist id="phase-list">${allPhases().map((p) => `<option value="${esc(p)}">`).join("")}</datalist></label>
        <label class="check full key-box"><input type="checkbox" name="key_date" ${m.key_date ? "checked" : ""}> ★ Key date — show this milestone in the Key dates strip</label>
        ${!isNew && tasksOf(m.id).some((t) => t.start_date || t.end_date)
          ? `<label><span>Start date <span class="muted hint-inline">· from its tasks</span></span><input type="date" name="start_date" value="${esc(m.start_date)}" disabled></label>
        <label><span>End date <span class="muted hint-inline">· from its tasks</span></span><input type="date" name="end_date" value="${esc(m.end_date)}" disabled></label>`
          : `<label>Start date<input type="date" name="start_date" value="${esc(m.start_date)}"></label>
        <label>End date<input type="date" name="end_date" value="${esc(m.end_date)}" ${m.ongoing ? "disabled" : ""}></label>`}
        <label class="check full ongoing-box"><input type="checkbox" name="ongoing" ${m.ongoing ? "checked" : ""}> Ongoing — no end date (it ends when marked Complete)</label>
        <label><span>Review date <span class="muted hint-inline">· optional, for ongoing items</span></span><input type="date" name="review_date" value="${esc(m.review_date)}"></label>
        <label><span>Completed on <span class="muted hint-inline">· filled in automatically</span></span><input type="date" name="completed_on" value="${esc(m.completed_on)}"></label>
        <label class="full">Dependencies / prerequisites<textarea name="dependencies">${esc(m.dependencies)}</textarea></label>
        <label class="full">Comments<textarea name="comments">${esc(m.comments)}</textarea></label>
        <div class="modal-actions full"><button type="button" class="btn" id="mcancel">Cancel</button><button class="btn primary" type="submit">${isNew ? "Create milestone" : "Save changes"}</button></div>
      </form>`);
    $("#mcancel").onclick = closeModal;
    $("#mform").onsubmit = async (e) => {
      e.preventDefault();
      const d = formData(e.target);
      if (!d.status) delete d.status; // status set by tasks
      if (isNew) {
        d.position = Math.max(0, ...state.milestones.map((x) => x.position)) + 1;
        const { data, error } = await sb.from("pm_milestones").insert(d).select().single();
        if (error) return toast("Save failed: " + error.message, true);
        closeModal(); await loadAll(); toast("Milestone created"); openDrawer(data.id);
      } else if (await save("pm_milestones", m.id, d)) { closeModal(); toast("Milestone saved"); }
    };
  }

  function taskForm(t, milestoneId) {
    const isNew = !t; t = t || { status: "Not started", percent_done: 0, milestone_id: milestoneId, priority: prio(milestoneById(milestoneId)) };
    modal(isNew ? "New task" : "Edit task", `
      <form id="tform" class="form-grid">
        <label class="full">Task<textarea name="title" required style="min-height:52px">${esc(t.title)}</textarea></label>
        <label class="full">Milestone<select name="milestone_id">${state.milestones.map((m) => `<option value="${m.id}" ${m.id === t.milestone_id ? "selected" : ""}>${esc(m.title)}</option>`).join("")}</select></label>
        <label>Owner<input type="text" name="owner" value="${esc(t.owner)}"></label>
        <label>Status<select name="status">${opt(STATUSES, t.status)}</select></label>
        <label>Start date<input type="date" name="start_date" value="${esc(t.start_date)}"></label>
        <label>End date<input type="date" name="end_date" value="${esc(t.end_date)}" ${t.ongoing ? "disabled" : ""}></label>
        <label class="check full key-box"><input type="checkbox" name="key_date" ${t.key_date ? "checked" : ""}> ★ Key date — a checkpoint to show in the Key dates strip (e.g. handover, inspection, opening)</label>
        <label class="check full ongoing-box"><input type="checkbox" name="ongoing" ${t.ongoing ? "checked" : ""}> Ongoing — no end date (it ends when marked Complete)</label>
        <label><span>Review date <span class="muted hint-inline">· optional, for ongoing items</span></span><input type="date" name="review_date" value="${esc(t.review_date)}"></label>
        <label><span>Completed on <span class="muted hint-inline">· filled in automatically</span></span><input type="date" name="completed_on" value="${esc(t.completed_on)}"></label>
        <label><span>% done <span class="muted hint-inline">· above 0 = In progress, 100 = Complete</span></span><input type="number" name="percent_done" min="0" max="100" step="1" value="${t.percent_done ?? 0}" onfocus="this.select()"></label>
        <label>Priority<select name="priority">${opt(PRIORITIES, prio(t))}</select></label>
        <label class="full">Dependencies / prerequisites<textarea name="dependencies">${esc(t.dependencies)}</textarea></label>
        <label class="full">Comments<textarea name="comments">${esc(t.comments)}</textarea></label>
        <div class="modal-actions full"><button type="button" class="btn" id="tcancel">Cancel</button><button class="btn primary" type="submit">${isNew ? "Add task" : "Save changes"}</button></div>
      </form>`);
    $("#tcancel").onclick = closeModal;
    $("#tform").onsubmit = async (e) => {
      e.preventDefault();
      const d = formData(e.target);
      d.percent_done = Math.max(0, Math.min(100, parseInt(d.percent_done || "0", 10) || 0));
      // Same rule as the database: a changed status wins; otherwise % done drives the status.
      const statusChanged = !isNew && d.status !== t.status;
      if (statusChanged) {
        if (d.status === "Complete") d.percent_done = 100;
        else if (d.status === "Not started") d.percent_done = 0;
        else if (d.percent_done >= 100) d.percent_done = 99;
      } else if (d.percent_done >= 100) d.status = "Complete";
      else if (d.percent_done > 0 && d.status === "Not started") d.status = "In progress";
      else if (d.status === "Complete") d.percent_done = 100;
      if (isNew || d.milestone_id !== t.milestone_id) d.position = Math.max(0, ...tasksOf(d.milestone_id).map((x) => x.position)) + 1;
      if (await save("pm_tasks", isNew ? null : t.id, d)) { closeModal(); toast(isNew ? "Task added" : "Task saved"); }
    };
  }

  async function teamModal() {
    const me = myKey(); const canChangeCode = !!state.session.user.email;
    const { data: code } = await sb.rpc("pm_get_join_code");
    modal("Team members", `
      <div class="code-box">
        <div><div class="k">Team code</div><div class="code">${esc(code || "—")}</div>
          <div class="muted small">Send partners the link and this code. They enter their name + the code once per device — no account needed.</div></div>
        ${canChangeCode ? `<form id="code-form" class="code-change"><input type="text" name="code" placeholder="New code" minlength="4" required autocomplete="off"><button class="btn small">Change code</button></form>` : ""}
      </div>
      <p class="muted" style="margin:14px 0 4px">Everyone below can view and change the plan. Removing someone signs them out of the planner.</p>
      <div>${state.members.map((m) => `<div class="member"><div><strong>${esc(m.display_name || (isCodeKey(m.email) ? "Partner" : m.email.split("@")[0]))}</strong><br><span class="muted">${isCodeKey(m.email) ? "joined with the team code" : esc(m.email)}</span></div>${m.email === me ? `<span class="muted">you</span>` : `<button class="btn danger-ghost small" data-rm="${esc(m.email)}">Remove</button>`}</div>`).join("")}</div>
      <p class="muted small" style="margin-top:14px">Prefer an email login for someone? Add their email below and have them use <em>Create account</em> with it.</p>
      <form id="addmember" class="form-grid" style="margin-top:16px">
        <label>Email<input type="email" name="email" required></label>
        <label>Name<input type="text" name="display_name" placeholder="optional"></label>
        <div class="modal-actions full"><button type="button" class="btn" id="team-close">Close</button><button class="btn primary">Add member</button></div>
      </form>`);
    $("#team-close").onclick = closeModal;
    if ($("#code-form")) $("#code-form").onsubmit = async (e) => {
      e.preventDefault(); const v = e.target.code.value.trim();
      const { data: ok, error } = await sb.rpc("pm_set_join_code", { p_code: v });
      if (error || !ok) return toast("Couldn't change the code" + (error ? ": " + error.message : " (at least 4 characters)"), true);
      toast("Team code changed — share the new one with partners"); teamModal();
    };
    $$("[data-rm]").forEach((b) => b.onclick = async () => {
      const { error } = await sb.from("pm_members").delete().eq("email", b.dataset.rm);
      if (error) return toast(error.message, true);
      await loadAll(); teamModal(); toast("Removed");
    });
    $("#addmember").onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      const row = { email: d.email.trim().toLowerCase(), display_name: d.display_name.trim() || null, added_by: me };
      const { error } = await sb.from("pm_members").insert(row);
      if (error) return toast(error.code === "23505" ? "That email is already on the team" : error.message, true);
      await loadAll(); teamModal(); toast("Added " + row.email);
    };
  }

  // ---------- events ----------
  document.addEventListener("click", async (e) => {
    if (e.target.closest("#task-sort-dir")) return setTaskSort(state.taskSortField, state.taskSortDir === "asc" ? "desc" : "asc");
    const f = e.target.closest("[data-file-open],[data-file-dl],[data-file-del]");
    if (f) {
      if (f.dataset.fileOpen) return openFile(f.dataset.fileOpen);
      if (f.dataset.fileDl) return downloadFile(f.dataset.fileDl);
      const a = state.attachments.find((x) => x.id === f.dataset.fileDel);
      if (a && await confirmBox("Remove file?", `“${esc(a.file_name)}” will be deleted for everyone.`, "Remove")) { if (await removeFiles([a])) { await loadAll(); toast("File removed"); } }
      return;
    }
    const rt = e.target.closest("[data-report]");
    if (rt) { state.report = rt.dataset.report; return renderReports(); }
    if (e.target.closest("#rep-print")) return window.print();
    const ph = e.target.closest("[data-phase]");
    if (ph) { state.phase = state.phase === ph.dataset.phase ? "" : ph.dataset.phase; renderAll(); if (state.view === "activity") switchView("board"); return; }
    const el = e.target.closest("[data-tile],[data-open],[data-add-task],[data-edit-task],[data-del-task],[data-move],[data-ms-complete]");
    if (!el || e.target.closest("select")) return;
    if (el.dataset.tile) { state.tileFilter = state.tileFilter === el.dataset.tile ? null : el.dataset.tile; renderAll(); if (state.view === "activity") switchView("board"); return; }
    if (el.dataset.addTask) return taskForm(null, el.dataset.addTask);
    if (el.dataset.editTask) return taskForm(state.tasks.find((t) => t.id === el.dataset.editTask));
    if (el.dataset.msComplete) return setMilestoneStatus(el.dataset.msComplete, "Complete");
    if (el.dataset.delTask) {
      const t = state.tasks.find((x) => x.id === el.dataset.delTask);
      const nf = filesOf(t.id).length;
      if (await confirmBox("Delete task?", `“${esc(t.title)}”${nf ? ` and its ${nf} attached file${nf > 1 ? "s" : ""}` : ""} will be removed for everyone.`)) {
        if (await removeFiles(filesOf(t.id)) && await remove("pm_tasks", t.id)) toast("Task deleted");
      }
      return;
    }
    if (el.dataset.move) {
      const t = state.tasks.find((x) => x.id === el.dataset.move); const ts = tasksOf(t.milestone_id);
      const i = ts.indexOf(t), j = i + Number(el.dataset.dir); if (j < 0 || j >= ts.length) return;
      const other = ts[j];
      // normalise positions then swap
      const order = ts.map((x) => x.id); [order[i], order[j]] = [order[j], order[i]];
      await Promise.all(order.map((id, k) => sb.from("pm_tasks").update({ position: k + 1 }).eq("id", id)));
      void other; await loadAll(); return;
    }
    if (el.dataset.open) return openDrawer(el.dataset.open, el.dataset.focus);
  });

  document.addEventListener("change", (e) => {
    const s = e.target;
    if (s.dataset && s.dataset.attach) { const files = s.files; if (files && files.length) uploadFiles(s.dataset.attach, files); s.value = ""; return; }
    if (s.id === "rep-horizon") { state.horizon = Number(s.value); return renderReports(); }
    if (s.id === "task-sort-field") return setTaskSort(s.value, state.taskSortDir);
    if (s.dataset.taskStatus) setTaskStatus(s.dataset.taskStatus, s.value);
    if (s.dataset.msStatus) setMilestoneStatus(s.dataset.msStatus, s.value);
  });

  document.addEventListener("submit", async (e) => {
    if (e.target.id !== "quick-add") return;
    e.preventDefault();
    const input = e.target.querySelector("input"); const title = input.value.trim(); if (!title) return;
    const mid = state.openId;
    if (await save("pm_tasks", null, { milestone_id: mid, title, priority: prio(milestoneById(mid)), position: Math.max(0, ...tasksOf(mid).map((x) => x.position)) + 1 })) {
      toast("Task added"); setTimeout(() => { const i = $("#quick-add input"); if (i) i.focus(); }, 50);
    }
  });

  // drag files from the computer onto a task in the drawer to attach them
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
  document.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); const t = e.target.closest("[data-task]"); if (!t) { e.dataTransfer.dropEffect = "none"; return; } $$(".task.filedrop").forEach((x) => x !== t && x.classList.remove("filedrop")); t.classList.add("filedrop"); });
  document.addEventListener("dragleave", (e) => { const t = e.target.closest("[data-task]"); if (t && !t.contains(e.relatedTarget)) t.classList.remove("filedrop"); });
  document.addEventListener("drop", (e) => { if (!hasFiles(e)) return; const t = e.target.closest("[data-task]"); e.preventDefault(); $$(".task.filedrop").forEach((x) => x.classList.remove("filedrop")); if (t) uploadFiles(t.dataset.task, e.dataTransfer.files); });

  // drag & drop between status columns
  let dragId = null;
  document.addEventListener("dragstart", (e) => { const c = e.target.closest("[data-drag]"); if (!c) return; dragId = c.dataset.drag; c.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId); });
  document.addEventListener("dragend", (e) => { const c = e.target.closest("[data-drag]"); if (c) c.classList.remove("dragging"); $$(".col.drop").forEach((x) => x.classList.remove("drop")); });
  document.addEventListener("dragover", (e) => { const col = e.target.closest("[data-drop]"); if (!col || !dragId) return; e.preventDefault(); $$(".col.drop").forEach((x) => x !== col && x.classList.remove("drop")); col.classList.add("drop"); });
  document.addEventListener("drop", (e) => {
    const col = e.target.closest("[data-drop]"); if (!col || !dragId) return; e.preventDefault();
    const status = col.dataset.drop, id = dragId; dragId = null; col.classList.remove("drop");
    if (col.dataset.kind === "task") { const t = state.tasks.find((x) => x.id === id); if (t && t.status !== status) setTaskStatus(id, status); }
    else {
      const m = milestoneById(id); if (!m || m.status === status) return;
      if (tasksOf(id).length) return toast("This milestone's status follows its tasks — open it and update the tasks instead.", true);
      setMilestoneStatus(id, status);
    }
  });

  function switchView(v) {
    state.view = v;
    $$("#view-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
    document.body.classList.toggle("on-reports", v === "reports");
    ["board", "tasks", "list", "activity", "reports"].forEach((x) => $("#view-" + x).classList.toggle("hidden", x !== v));
    if (v === "activity") { $("#view-activity").innerHTML = `<div class="empty">Loading…</div>`; loadActivity().then(renderActivity); }
    else renderAll();
  }
  $$("#view-tabs button").forEach((b) => b.onclick = () => switchView(b.dataset.view));
  $("#search").oninput = (e) => { state.q = e.target.value.trim().toLowerCase(); renderAll(); };
  $("#owner-filter").onchange = (e) => { state.owner = e.target.value; renderAll(); };
  $("#phase-filter").onchange = (e) => { state.phase = e.target.value; renderAll(); };
  $("#hide-complete").onchange = (e) => { state.hideComplete = e.target.checked; renderAll(); };
  $$("[data-version]").forEach((el) => {
    el.textContent = "v" + (cfg.version || "?");
    el.title = `Version ${cfg.version}${cfg.released ? " · released " + cfg.released : ""}`;
  });
  $("#sort-field").onchange =(e) => setSort(e.target.value, state.sortDir);
  $("#sort-dir").onclick = () => setSort(state.sortField, state.sortDir === "asc" ? "desc" : "asc");
  renderSortControls();
  $("#add-milestone").onclick = () => milestoneForm(null);
  $("#edit-milestone").onclick = () => milestoneForm(milestoneById(state.openId));
  $("#delete-milestone").onclick = async () => {
    const m = milestoneById(state.openId); const n = tasksOf(m.id).length; const nf = filesOfMilestone(m.id).length;
    if (await confirmBox("Delete milestone?", `“${esc(m.title)}”${n ? ` and its ${n} task${n > 1 ? "s" : ""}` : ""}${nf ? ` (with ${nf} attached file${nf > 1 ? "s" : ""})` : ""} will be removed for everyone. This can't be undone.`)) {
      if (await removeFiles(filesOfMilestone(m.id)) && await remove("pm_milestones", m.id)) { closeDrawer(); toast("Milestone deleted"); }
    }
  };
  $("#drawer-close").onclick = closeDrawer;
  $("#drawer-scrim").onclick = closeDrawer;
  let downOnBackdrop = false;
  $("#modal-wrap").addEventListener("mousedown", (e) => { downOnBackdrop = e.target.id === "modal-wrap"; });
  $("#modal-wrap").onclick = (e) => {
    if (e.target.id !== "modal-wrap" || !downOnBackdrop) return; // drag that ended outside the box
    if (modalDirty) return toast("You have unsaved changes — use Save or Cancel.", true);
    closeModal();
  };
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#modal-wrap").classList.contains("hidden")) {
      if (modalDirty) return toast("You have unsaved changes — use Save or Cancel.", true);
      closeModal();
    } else if (state.openId) closeDrawer();
  });
  $("#team-btn").onclick = teamModal;

  // ---------- auth ----------
  const redirectUrl = () => location.origin + location.pathname;
  $$("[data-auth]").forEach((b) => b.onclick = () => {
    state.authMode = b.dataset.auth;
    $$("[data-auth]").forEach((x) => x.classList.toggle("active", x === b));
    $("#join-form").classList.toggle("hidden", state.authMode !== "join");
    $("#auth-form").classList.toggle("hidden", state.authMode === "join");
    $("#auth-submit").textContent = state.authMode === "signin" ? "Sign in" : "Create account";
    $("#auth-form [name=password]").autocomplete = state.authMode === "signin" ? "current-password" : "new-password";
    $("#forgot").classList.toggle("hidden", state.authMode !== "signin");
    setMsg("");
  });
  const setMsg = (t, cls = "") => { const m = $("#auth-msg"); m.textContent = t; m.className = "msg " + cls; };
  $("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const email = e.target.email.value.trim().toLowerCase(), password = e.target.password.value;
    setMsg("Working…");
    if (state.authMode === "signin") {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) setMsg(error.message === "Email not confirmed" ? "Please confirm your email first — check your inbox for the link." : error.message, "err");
    } else {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: redirectUrl() } });
      if (error) setMsg(error.message, "err");
      else if (!data.session) setMsg("Account created. Check your email for a confirmation link, then come back here and sign in.", "ok");
    }
  };
  $("#forgot").onclick = async () => {
    const email = $("#auth-form [name=email]").value.trim();
    if (!email) return setMsg("Type your email above first, then click “Forgot password?”.", "err");
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() });
    setMsg(error ? error.message : "If that email has an account, a reset link is on its way.", error ? "err" : "ok");
  };
  $("#reset-form").onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.updateUser({ password: e.target.password.value });
    if (error) { $("#reset-msg").textContent = error.message; $("#reset-msg").className = "msg err"; return; }
    state.recovering = false; toast("Password updated"); route();
  };
  const signOut = async () => {
    if (state.session?.user?.is_anonymous && !(await confirmBox("Sign out?", "You joined with the team code, so you'll need the code again to get back in on this device.", "Sign out"))) return;
    await sb.auth.signOut();
  };
  $("#signout").onclick = signOut; $("#nomember-signout").onclick = signOut;
  $("#recheck").onclick = () => route();

  // ----- join with the team code (no account) -----
  const joinMsg = (t, cls = "") => { const m = $("#join-msg"); m.textContent = t; m.className = "msg " + cls; };
  $("#join-form").onsubmit = async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim(), code = e.target.code.value.trim();
    if (!name || !code) return;
    joinMsg("Checking…"); $("#join-submit").disabled = true; state.joining = true;
    try {
      if (!state.session) {
        const { error } = await sb.auth.signInAnonymously();
        if (error) { joinMsg(/anonymous/i.test(error.message) ? "Team-code access isn't switched on yet — please ask Alberto." : error.message, "err"); return; }
      }
      const { data: ok, error } = await sb.rpc("pm_join", { p_code: code, p_name: name });
      if (error || !ok) {
        if (state.session?.user?.is_anonymous) await sb.auth.signOut();
        joinMsg(error ? error.message : "That code isn't right — check the message you were sent.", "err"); return;
      }
      joinMsg("");
    } finally { state.joining = false; $("#join-submit").disabled = false; }
    route();
  };
  $("#nomember-code").onsubmit = async (e) => {
    e.preventDefault();
    const { data: ok, error } = await sb.rpc("pm_join", { p_code: e.target.code.value.trim(), p_name: null });
    const m = $("#nomember-msg");
    if (error || !ok) { m.textContent = "That code isn't right."; m.className = "msg err"; return; }
    route();
  };

  async function route() {
    const session = state.session;
    if (state.recovering) return show("reset-view");
    if (state.joining) return;
    if (!session) { show("auth-view"); return; }
    const { data: isMember, error } = await sb.rpc("pm_is_member");
    if (error || !isMember) {
      if (session.user.is_anonymous) {
        // a code session that isn't (or is no longer) on the team: back to the code screen, keeping any message already shown
        await sb.auth.signOut(); show("auth-view");
        if (!$("#join-msg").textContent.trim()) joinMsg("Please enter the team code to continue.", "err");
        return;
      }
      $("#nomember-email").textContent = session.user.email; show("nomember-view"); return;
    }
    show("app-view");
    await loadAll(); subscribe();
  }

  sb.auth.onAuthStateChange((event, session) => {
    const prev = state.session?.user?.id;
    state.session = session;
    if (event === "PASSWORD_RECOVERY") state.recovering = true;
    if (event === "SIGNED_OUT") { if (realtime) { sb.removeChannel(realtime); realtime = null; } closeDrawer(); }
    // avoid re-routing on silent token refreshes
    if (event === "TOKEN_REFRESHED" || (event === "SIGNED_IN" && prev === session?.user?.id && !$("#app-view").classList.contains("hidden"))) return;
    setTimeout(route, 0);
  });
})();
