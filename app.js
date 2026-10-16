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
    session: null, milestones: [], tasks: [], members: [], activity: [],
    view: "board", q: "", owner: "", hideComplete: false, tileFilter: null,
    openId: null, authMode: "signin", recovering: false,
  };

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const parseD = (s) => { if (!s) return null; const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const fmtD = (s) => { const d = parseD(s); return d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—"; };
  const fmtRange = (a, b) => (a || b) ? `${fmtD(a)} → ${fmtD(b)}` : "No dates yet";
  const isLate = (x) => x.status !== "Complete" && x.end_date && parseD(x.end_date) < today();
  const ago = (iso) => {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`; if (s < 604800) return `${Math.floor(s / 86400)} d ago`;
    return new Date(iso).toLocaleDateString();
  };
  const people = (owner) => (owner || "").split(/\s*(?:\/|,|&|\band\b)\s*/i).map((p) => p.trim()).filter(Boolean);
  const nameFor = (email) => { const m = state.members.find((x) => x.email === email); return (m && m.display_name) || (email ? email.split("@")[0] : "someone"); };
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

  // ---------- filtering ----------
  const textMatch = (x) => !state.q || [x.title, x.owner, x.comments, x.dependencies].join(" ").toLowerCase().includes(state.q);
  const ownerMatch = (owner) => !state.owner || people(owner).some((p) => p.toLowerCase() === state.owner.toLowerCase());
  const tileMatch = (x) => !state.tileFilter || (state.tileFilter === "late" ? isLate(x) : x.status === state.tileFilter);
  function milestoneVisible(m) {
    const ts = tasksOf(m.id);
    if (state.hideComplete && m.status === "Complete") return false;
    if (!tileMatch(m)) return false;
    const t1 = textMatch(m) || ts.some(textMatch);
    const o1 = ownerMatch(m.owner) || ts.some((t) => ownerMatch(t.owner));
    return t1 && o1;
  }
  function taskVisible(t) {
    const m = milestoneById(t.milestone_id);
    if (state.hideComplete && t.status === "Complete") return false;
    if (!tileMatch(t)) return false;
    return (textMatch(t) || (m && textMatch(m))) && ownerMatch(t.owner || (m && m.owner));
  }

  // ---------- data ----------
  async function loadAll() {
    const [ms, ts, mem] = await Promise.all([
      sb.from("pm_milestones").select("*").order("position"),
      sb.from("pm_tasks").select("*").order("position"),
      sb.from("pm_members").select("*").order("created_at"),
    ]);
    const err = ms.error || ts.error || mem.error;
    if (err) { toast("Couldn't load data: " + err.message, true); return; }
    state.milestones = ms.data; state.tasks = ts.data; state.members = mem.data;
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
      .subscribe();
  }

  // ---------- rendering ----------
  function renderAll() {
    renderHeader(); renderSummary(); renderOwnerFilter();
    if (state.view === "board") renderBoard();
    if (state.view === "tasks") renderTaskBoard();
    if (state.view === "list") renderList();
    if (state.openId) renderDrawer();
  }

  function renderHeader() {
    const all = state.tasks; const done = all.filter((t) => t.status === "Complete").length;
    const pct = all.length ? Math.round(all.reduce((a, t) => a + pctOfTask(t), 0) / all.length) : 0;
    $("#overall-label").textContent = `${pct}% overall · ${done} of ${all.length} tasks complete`;
    $("#overall-bar").style.width = pct + "%";
    $("#who").textContent = state.session?.user?.email || "";
  }

  function renderSummary() {
    const ms = state.milestones, ts = state.tasks;
    const tiles = STATUSES.map((s) => ({ key: s, cls: S_CLASS[s], n: ms.filter((m) => m.status === s).length, sub: `${ts.filter((t) => t.status === s).length} tasks`, label: s === "Not started" ? "Not started yet" : s }));
    tiles.push({ key: "late", cls: "s-late", n: ms.filter(isLate).length, sub: `${ts.filter(isLate).length} tasks past due`, label: "Overdue" });
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
      <h4>${esc(m.title)}</h4>
      <div class="meta"><span>👤 ${esc(m.owner || "Unassigned")}</span><span class="${isLate(m) ? "late" : ""}">📅 ${m.end_date ? (isLate(m) ? "Was due " : "Due ") + fmtD(m.end_date) : "No due date"}</span></div>
      <div class="prog"><div class="bar"><span style="width:${p.pct}%"></span></div><span>${p.total ? `${p.done}/${p.total} tasks` : "No tasks"}</span></div>
      ${chips ? `<div class="chips">${chips}</div>` : ""}
    </div>`;
  }
  function taskCard(t) {
    const m = milestoneById(t.milestone_id);
    return `<div class="card ${S_CLASS[t.status]}" draggable="true" data-open="${t.milestone_id}" data-focus="${t.id}" data-drag="${t.id}">
      <div class="parent">${esc(m ? m.title : "")}</div>
      <h4>${esc(t.title)}</h4>
      <div class="meta"><span>👤 ${esc(t.owner || (m && m.owner) || "Unassigned")}</span><span class="${isLate(t) ? "late" : ""}">📅 ${t.end_date ? (isLate(t) ? "Was due " : "Due ") + fmtD(t.end_date) : "No due date"}</span>${t.percent_done && t.status !== "Complete" ? `<span>${t.percent_done}%</span>` : ""}</div>
    </div>`;
  }

  function renderBoard() {
    const items = state.milestones.filter(milestoneVisible);
    $("#view-board").innerHTML = columnsHTML(items, milestoneCard, "milestone");
  }
  function renderTaskBoard() {
    const items = state.tasks.filter(taskVisible).sort((a, b) => (a.end_date || "9999").localeCompare(b.end_date || "9999"));
    $("#view-tasks").innerHTML = columnsHTML(items, taskCard, "task");
  }

  function renderList() {
    const rows = [];
    state.milestones.forEach((m) => {
      const ts = tasksOf(m.id).filter(taskVisible);
      if (!milestoneVisible(m) && !ts.length) return;
      const p = progress(m);
      rows.push(`<tr class="ms-row" data-open="${m.id}"><td>${esc(m.title)}</td><td>${esc(m.owner || "")}</td><td>${pill(m.status)}</td><td class="num">${fmtD(m.start_date)}</td><td class="num ${isLate(m) ? "late" : ""}">${fmtD(m.end_date)}</td><td class="num">${p.pct}%</td></tr>`);
      ts.forEach((t) => rows.push(`<tr class="task-row"><td>${esc(t.title)}</td><td>${esc(t.owner || "")}</td><td>${statusSelect(t.status, `data-task-status="${t.id}"`)}</td><td class="num">${fmtD(t.start_date)}</td><td class="num ${isLate(t) ? "late" : ""}">${fmtD(t.end_date)}</td><td class="num">${pctOfTask(t)}%</td></tr>`));
    });
    $("#view-list").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Milestone / task</th><th>Owner</th><th>Status</th><th>Start</th><th>End</th><th>Done</th></tr></thead><tbody>${rows.join("") || `<tr><td colspan="6" class="empty">Nothing matches your filters</td></tr>`}</tbody></table></div>`;
  }

  function renderActivity() {
    const list = state.activity;
    $("#view-activity").innerHTML = `<div class="activity">${list.map((a) => {
      const m = a.milestone_id && milestoneById(a.milestone_id);
      const what = `${a.entity} <strong>${esc(a.title)}</strong>`;
      return `<div class="act"><time title="${new Date(a.at).toLocaleString()}">${ago(a.at)}</time><div><strong>${esc(nameFor(a.actor))}</strong> ${esc(a.action)} ${what}${m && a.entity === "task" ? ` in <a data-open="${m.id}">${esc(m.title)}</a>` : m ? ` · <a data-open="${m.id}">open</a>` : ""}</div></div>`;
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
    const ts = tasksOf(m.id); const p = progress(m);
    const allDone = ts.length && ts.every((t) => t.status === "Complete") && m.status !== "Complete";
    $("#drawer-body").innerHTML = `
      ${statusSelect(m.status, `data-ms-status="${m.id}"`)}
      <h2>${esc(m.title)}</h2>
      <div class="facts">
        <div class="fact"><div class="k">Owner</div><div class="v">${esc(m.owner || "Unassigned")}</div></div>
        <div class="fact"><div class="k">Start</div><div class="v">${fmtD(m.start_date)}</div></div>
        <div class="fact"><div class="k">End</div><div class="v ${isLate(m) ? "late" : ""}">${fmtD(m.end_date)}</div></div>
        <div class="fact"><div class="k">Progress</div><div class="v">${p.pct}% <span class="muted" style="font-size:12px;font-weight:500">(${p.done}/${p.total} tasks)</span></div></div>
      </div>
      <div class="bar"><span style="width:${p.pct}%"></span></div>
      ${allDone ? `<div class="note" style="background:#e8f6ec;border-color:#b7e4c4;margin-top:14px">All tasks are complete. <button class="btn small primary" data-ms-complete="${m.id}">Mark milestone complete</button></div>` : ""}
      ${m.dependencies ? `<div class="note"><b>Depends on</b>${esc(m.dependencies)}</div>` : ""}
      ${m.comments ? `<div class="note"><b>Comments</b>${esc(m.comments)}</div>` : ""}
      <p class="muted" style="font-size:12px">Last updated ${ago(m.updated_at)}${m.updated_by ? " by " + esc(nameFor(m.updated_by)) : ""}</p>

      <div class="section-head"><h3>Tasks (${ts.length})</h3><button class="btn small" data-add-task="${m.id}">＋ Add task with details</button></div>
      ${ts.map((t, i) => `
        <div class="task ${S_CLASS[t.status]} ${t.status === "Complete" ? "done" : ""}" data-task="${t.id}">
          <div>
            <h4>${esc(t.title)}</h4>
            <div class="meta"><span>👤 ${esc(t.owner || "Unassigned")}</span><span class="${isLate(t) ? "late" : ""}">📅 ${fmtRange(t.start_date, t.end_date)}${isLate(t) ? " · overdue" : ""}</span></div>
          </div>
          <div class="right">
            ${statusSelect(t.status, `data-task-status="${t.id}"`)}
            <div class="pct"><div class="bar"><span style="width:${pctOfTask(t)}%"></span></div>${pctOfTask(t)}%</div>
            <div class="row-actions">
              <button class="btn ghost small" title="Move up" data-move="${t.id}" data-dir="-1" ${i === 0 ? "disabled" : ""}>↑</button>
              <button class="btn ghost small" title="Move down" data-move="${t.id}" data-dir="1" ${i === ts.length - 1 ? "disabled" : ""}>↓</button>
              <button class="btn ghost small" title="Edit" data-edit-task="${t.id}">✎</button>
              <button class="btn danger-ghost small" title="Delete" data-del-task="${t.id}">🗑</button>
            </div>
          </div>
          ${t.dependencies || t.comments ? `<div class="extra">${t.dependencies ? `<b>Depends on:</b> ${esc(t.dependencies)}` : ""}${t.dependencies && t.comments ? "<br>" : ""}${t.comments ? `<b>Comments:</b> ${esc(t.comments)}` : ""}</div>` : ""}
        </div>`).join("") || `<div class="empty">No tasks yet — add the first one below.</div>`}
      <form class="quick-add" id="quick-add"><input type="text" placeholder="Quick add a task… (press Enter)" required><button class="btn primary" type="submit">Add</button></form>`;
  }

  // ---------- modals ----------
  function modal(title, bodyHTML) {
    $("#modal-title").textContent = title; $("#modal-body").innerHTML = bodyHTML;
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
  const opt = (list, cur) => list.map((s) => `<option ${s === cur ? "selected" : ""}>${esc(s)}</option>`).join("");

  function milestoneForm(m) {
    const isNew = !m; m = m || { status: "Not started" };
    modal(isNew ? "New milestone" : "Edit milestone", `
      <form id="mform" class="form-grid">
        <label class="full">Milestone name<input type="text" name="title" required value="${esc(m.title)}"></label>
        <label>Owner<input type="text" name="owner" value="${esc(m.owner)}" placeholder="e.g. Vivek/Alberto"></label>
        <label>Status<select name="status">${opt(STATUSES, m.status)}</select></label>
        <label>Start date<input type="date" name="start_date" value="${esc(m.start_date)}"></label>
        <label>End date<input type="date" name="end_date" value="${esc(m.end_date)}"></label>
        <label class="full">Dependencies / prerequisites<textarea name="dependencies">${esc(m.dependencies)}</textarea></label>
        <label class="full">Comments<textarea name="comments">${esc(m.comments)}</textarea></label>
        <div class="modal-actions full"><button type="button" class="btn" id="mcancel">Cancel</button><button class="btn primary" type="submit">${isNew ? "Create milestone" : "Save changes"}</button></div>
      </form>`);
    $("#mcancel").onclick = closeModal;
    $("#mform").onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target)); Object.keys(d).forEach((k) => { d[k] = d[k].trim() || null; });
      if (isNew) {
        d.position = Math.max(0, ...state.milestones.map((x) => x.position)) + 1;
        const { data, error } = await sb.from("pm_milestones").insert(d).select().single();
        if (error) return toast("Save failed: " + error.message, true);
        closeModal(); await loadAll(); toast("Milestone created"); openDrawer(data.id);
      } else if (await save("pm_milestones", m.id, d)) { closeModal(); toast("Milestone saved"); }
    };
  }

  function taskForm(t, milestoneId) {
    const isNew = !t; t = t || { status: "Not started", percent_done: 0, milestone_id: milestoneId };
    modal(isNew ? "New task" : "Edit task", `
      <form id="tform" class="form-grid">
        <label class="full">Task<textarea name="title" required style="min-height:52px">${esc(t.title)}</textarea></label>
        <label class="full">Milestone<select name="milestone_id">${state.milestones.map((m) => `<option value="${m.id}" ${m.id === t.milestone_id ? "selected" : ""}>${esc(m.title)}</option>`).join("")}</select></label>
        <label>Owner<input type="text" name="owner" value="${esc(t.owner)}"></label>
        <label>Status<select name="status">${opt(STATUSES, t.status)}</select></label>
        <label>Start date<input type="date" name="start_date" value="${esc(t.start_date)}"></label>
        <label>End date<input type="date" name="end_date" value="${esc(t.end_date)}"></label>
        <label>% done<input type="number" name="percent_done" min="0" max="100" step="5" value="${t.percent_done ?? 0}"></label>
        <div></div>
        <label class="full">Dependencies / prerequisites<textarea name="dependencies">${esc(t.dependencies)}</textarea></label>
        <label class="full">Comments<textarea name="comments">${esc(t.comments)}</textarea></label>
        <div class="modal-actions full"><button type="button" class="btn" id="tcancel">Cancel</button><button class="btn primary" type="submit">${isNew ? "Add task" : "Save changes"}</button></div>
      </form>`);
    $("#tcancel").onclick = closeModal;
    $("#tform").onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target)); Object.keys(d).forEach((k) => { d[k] = String(d[k]).trim() || null; });
      d.percent_done = Math.max(0, Math.min(100, parseInt(d.percent_done || "0", 10) || 0));
      if (d.status === "Complete") d.percent_done = 100;
      else if (d.percent_done === 100) d.status = "Complete";
      if (isNew || d.milestone_id !== t.milestone_id) d.position = Math.max(0, ...tasksOf(d.milestone_id).map((x) => x.position)) + 1;
      if (await save("pm_tasks", isNew ? null : t.id, d)) { closeModal(); toast(isNew ? "Task added" : "Task saved"); }
    };
  }

  function teamModal() {
    const me = state.session.user.email.toLowerCase();
    modal("Team members", `
      <p class="muted" style="margin-top:0">Anyone listed here can sign in and view or change the plan. To invite someone, add their email and ask them to open the planner and choose <em>Create account</em> with that same email.</p>
      <div>${state.members.map((m) => `<div class="member"><div><strong>${esc(m.display_name || m.email.split("@")[0])}</strong><br><span class="muted">${esc(m.email)}</span></div>${m.email === me ? `<span class="muted">you</span>` : `<button class="btn danger-ghost small" data-rm="${esc(m.email)}">Remove</button>`}</div>`).join("")}</div>
      <form id="addmember" class="form-grid" style="margin-top:16px">
        <label>Email<input type="email" name="email" required></label>
        <label>Name<input type="text" name="display_name" placeholder="optional"></label>
        <div class="modal-actions full"><button type="button" class="btn" id="team-close">Close</button><button class="btn primary">Add member</button></div>
      </form>`);
    $("#team-close").onclick = closeModal;
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
    const el = e.target.closest("[data-tile],[data-open],[data-add-task],[data-edit-task],[data-del-task],[data-move],[data-ms-complete]");
    if (!el || e.target.closest("select")) return;
    if (el.dataset.tile) { state.tileFilter = state.tileFilter === el.dataset.tile ? null : el.dataset.tile; renderAll(); if (state.view === "activity") switchView("board"); return; }
    if (el.dataset.addTask) return taskForm(null, el.dataset.addTask);
    if (el.dataset.editTask) return taskForm(state.tasks.find((t) => t.id === el.dataset.editTask));
    if (el.dataset.msComplete) return setMilestoneStatus(el.dataset.msComplete, "Complete");
    if (el.dataset.delTask) {
      const t = state.tasks.find((x) => x.id === el.dataset.delTask);
      if (await confirmBox("Delete task?", `“${esc(t.title)}” will be removed for everyone.`)) { if (await remove("pm_tasks", t.id)) toast("Task deleted"); }
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
    if (s.dataset.taskStatus) setTaskStatus(s.dataset.taskStatus, s.value);
    if (s.dataset.msStatus) setMilestoneStatus(s.dataset.msStatus, s.value);
  });

  document.addEventListener("submit", async (e) => {
    if (e.target.id !== "quick-add") return;
    e.preventDefault();
    const input = e.target.querySelector("input"); const title = input.value.trim(); if (!title) return;
    const mid = state.openId;
    if (await save("pm_tasks", null, { milestone_id: mid, title, position: Math.max(0, ...tasksOf(mid).map((x) => x.position)) + 1 })) {
      toast("Task added"); setTimeout(() => { const i = $("#quick-add input"); if (i) i.focus(); }, 50);
    }
  });

  // drag & drop between status columns
  let dragId = null;
  document.addEventListener("dragstart", (e) => { const c = e.target.closest("[data-drag]"); if (!c) return; dragId = c.dataset.drag; c.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId); });
  document.addEventListener("dragend", (e) => { const c = e.target.closest("[data-drag]"); if (c) c.classList.remove("dragging"); $$(".col.drop").forEach((x) => x.classList.remove("drop")); });
  document.addEventListener("dragover", (e) => { const col = e.target.closest("[data-drop]"); if (!col || !dragId) return; e.preventDefault(); $$(".col.drop").forEach((x) => x !== col && x.classList.remove("drop")); col.classList.add("drop"); });
  document.addEventListener("drop", (e) => {
    const col = e.target.closest("[data-drop]"); if (!col || !dragId) return; e.preventDefault();
    const status = col.dataset.drop, id = dragId; dragId = null; col.classList.remove("drop");
    if (col.dataset.kind === "task") { const t = state.tasks.find((x) => x.id === id); if (t && t.status !== status) setTaskStatus(id, status); }
    else { const m = milestoneById(id); if (m && m.status !== status) setMilestoneStatus(id, status); }
  });

  function switchView(v) {
    state.view = v;
    $$("#view-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
    ["board", "tasks", "list", "activity"].forEach((x) => $("#view-" + x).classList.toggle("hidden", x !== v));
    if (v === "activity") { $("#view-activity").innerHTML = `<div class="empty">Loading…</div>`; loadActivity().then(renderActivity); }
    else renderAll();
  }
  $$("#view-tabs button").forEach((b) => b.onclick = () => switchView(b.dataset.view));
  $("#search").oninput = (e) => { state.q = e.target.value.trim().toLowerCase(); renderAll(); };
  $("#owner-filter").onchange = (e) => { state.owner = e.target.value; renderAll(); };
  $("#hide-complete").onchange = (e) => { state.hideComplete = e.target.checked; renderAll(); };
  $("#add-milestone").onclick = () => milestoneForm(null);
  $("#edit-milestone").onclick = () => milestoneForm(milestoneById(state.openId));
  $("#delete-milestone").onclick = async () => {
    const m = milestoneById(state.openId); const n = tasksOf(m.id).length;
    if (await confirmBox("Delete milestone?", `“${esc(m.title)}”${n ? ` and its ${n} task${n > 1 ? "s" : ""}` : ""} will be removed for everyone. This can't be undone.`)) {
      if (await remove("pm_milestones", m.id)) { closeDrawer(); toast("Milestone deleted"); }
    }
  };
  $("#drawer-close").onclick = closeDrawer;
  $("#drawer-scrim").onclick = closeDrawer;
  $("#modal-wrap").onclick = (e) => { if (e.target.id === "modal-wrap") closeModal(); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (!$("#modal-wrap").classList.contains("hidden")) closeModal(); else if (state.openId) closeDrawer(); } });
  $("#team-btn").onclick = teamModal;

  // ---------- auth ----------
  const redirectUrl = () => location.origin + location.pathname;
  $$("[data-auth]").forEach((b) => b.onclick = () => {
    state.authMode = b.dataset.auth;
    $$("[data-auth]").forEach((x) => x.classList.toggle("active", x === b));
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
  const signOut = async () => { await sb.auth.signOut(); };
  $("#signout").onclick = signOut; $("#nomember-signout").onclick = signOut;
  $("#recheck").onclick = () => route();

  async function route() {
    const session = state.session;
    if (state.recovering) return show("reset-view");
    if (!session) { show("auth-view"); return; }
    const email = session.user.email.toLowerCase();
    const { data, error } = await sb.from("pm_members").select("email").eq("email", email).maybeSingle();
    if (error || !data) { $("#nomember-email").textContent = email; show("nomember-view"); return; }
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
