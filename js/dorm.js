/* 內務分頁：貼上 LINE 內務公告 → 辨識 → 存檔並轉入加扣分 → 寢室與個人統計。
   資料和名冊、加扣分紀錄一樣，加密存在這台裝置的瀏覽器。 */
(function () {
  "use strict";
  const D = window.DormCore;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
  const RL = D.roomLabel, fmt = D.fmt;
  const tone = v => v < 0 ? "d-neg" : v > 0 ? "d-pos" : "";

  let B = null;                     // app.js 提供的介面
  let data = null;                  // {mapping, autoPoints, inspectors, byCohort:{[cohortId]:{roomsText, rooms, reports:{date:report}}}}
  let draft = null, pendingOverwrite = false;
  let sub = "entry", month = null;
  const q = {from: null, to: null, room: "", person: "", view: "room", sort: {k: "s", dir: 1}};
  let idxCache = {id: null, idx: null}, bound = false;

  /* ───── 資料 ───── */
  const cohort = () => B && B.activeCohort();
  function cdata() {
    const c = cohort(); if (!c) return null;
    if (!data.byCohort[c.id]) data.byCohort[c.id] = {roomsText: "", rooms: [], reports: {}};
    return data.byCohort[c.id];
  }
  function index() {
    const c = cohort();
    if (!c) return D.studentIndex([]);
    if (idxCache.id !== c.id || idxCache.n !== c.students.length) idxCache = {id: c.id, n: c.students.length, idx: D.studentIndex(c.students)};
    return idxCache.idx;
  }
  const reportsList = () => { const cd = cdata(); return cd ? Object.values(cd.reports).sort((a, b) => a.date.localeCompare(b.date)) : []; };
  const stu = k => index().get(k);
  const who = k => { if (k[0] === "?") return k.slice(1); const s = stu(k); return s ? (s.female || s.team) : k; };
  const nameOf = k => { const s = stu(k); return s ? s.name : ""; };
  const memberMap = () => { const m = new Map(); (cdata() || {rooms: []}).rooms.forEach(r => r.members.forEach(k => m.set(k, r.room))); return m; };
  let saveTimer = null;
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => B.Store.setJSON("dorm", data).catch(e => console.warn("內務資料儲存失敗", e)), 200); }
  const flush = () => { clearTimeout(saveTimer); return B.Store.setJSON("dorm", data); };

  function msg(id, text, kind) { const el = $(id); if (!el) return; el.hidden = !text; el.textContent = text || ""; el.className = "status" + (kind ? " " + kind : ""); }

  /* ───── 版面 ───── */
  function skeleton() {
    $("tab-dorm").innerHTML = `
    <nav class="d-subtabs" role="tablist" aria-label="內務功能">
      <button type="button" data-sub="entry">登錄公告</button><button type="button" data-sub="stats">月統計</button><button type="button" data-sub="query">明細查詢</button><button type="button" data-sub="rooms">寢室名單與設定</button><button type="button" data-sub="history">檢查紀錄</button>
    </nav>
    <div id="dNoCohort" class="status warning" hidden>請先到「名冊與設定」匯入名冊並選擇目前期別。</div>

    <div data-pane="entry">
      <section>
        <h2>貼上內務公告</h2>
        <div class="input-cohort">對象：<span class="cohort-tag active-cohort-tag"></span>（用這一期的名冊辨識女生隊號、建制隊號）</div>
        <textarea id="dRaw" style="min-height:180px" placeholder="把 LINE 上的內務檢查公告整則貼上，例如：&#10;1151019內務檢查&#10;被優：002 003&#10;棉被不潔 088 444194&#10;公物&#10;窗溝不潔 育五7、6-2"></textarea>
        <p class="note">「公物」那一行以下算公區（寫寢室號），以上算個人（寫女生隊號或建制隊號）。項目名稱有「優、整潔、整齊、乾淨」算加分，其他算扣分，點分數標籤可以改。</p>
      </section>
      <section id="dPreview" hidden>
        <div class="h2-row"><h2>辨識結果</h2></div>
        <div class="d-row">
          <label class="d-inline">檢查日期 <input type="date" id="dDate"></label>
          <label class="d-inline">內務檢查人 <input type="text" id="dInsp" list="dInspList" placeholder="輸入或選擇" autocomplete="off"></label>
          <datalist id="dInspList"></datalist>
        </div>
        <div id="dWarn"></div>
        <div id="dItems"></div>
        <p id="dPointsLine" class="note"></p>
        <div id="dSave" class="d-row"></div>
      </section>
      <div id="dEntryMsg" class="status" hidden></div>
    </div>

    <div data-pane="stats" hidden>
      <section>
        <div class="d-row" style="justify-content:space-between">
          <label class="d-inline">月份 <select id="dMonth"></select></label>
          <button type="button" id="dCopy" class="secondary">複製結果到 LINE</button>
        </div>
        <div id="dStatsWarn"></div>
        <div class="d-verdict" id="dVerdict"></div>
      </section>
      <section><h2>寢室排名</h2><div class="d-tablewrap"><table class="d-table" id="dRoomTbl"></table></div></section>
    </div>

    <div data-pane="query" hidden>
      <section>
        <div class="d-row">
          <label class="d-inline">從 <input type="date" id="qFrom"></label>
          <label class="d-inline">到 <input type="date" id="qTo"></label>
          <button type="button" class="secondary d-small" data-q="month">本月</button>
          <button type="button" class="secondary d-small" data-q="last">上月</button>
          <button type="button" class="secondary d-small" data-q="all">全部</button>
        </div>
        <div class="d-row">
          <label class="d-inline">寢室 <select id="qRoom"></select></label>
          <label class="d-inline d-grow">個人 <input type="search" id="qPerson" list="qPeople" placeholder="輸入隊號或姓名" autocomplete="off"></label>
          <datalist id="qPeople"></datalist>
        </div>
      </section>
      <div id="qOut"></div>
    </div>

    <div data-pane="rooms" hidden>
      <section>
        <div class="h2-row"><h2>寢室名單</h2><span class="note" id="dRoomCount"></span></div>
        <p class="note">一行一間寢室：先寫寢室號，再寫住在裡面同學的女生隊號或建制隊號。例：5-7 002 003 007 010。寢室號寫「育五7」或「5-7」都可以。每一期各自一份名單。</p>
        <textarea id="dRoomsText" style="min-height:220px" placeholder="5-1 001 002 003 004&#10;5-7 005 006 007 008"></textarea>
        <div class="d-row"><button type="button" id="dRoomsSave">儲存寢室名單</button></div>
        <div id="dRoomsInfo"></div>
      </section>
      <section>
        <h2>轉入加扣分</h2>
        <p class="note">儲存內務檢查時，個人優缺點每一項會新增一筆 0.2 分的加扣分紀錄到「加扣分」分頁（公區只算寢室統計）。請選擇要用的歸類與事蹟說明。</p>
        <label class="check-label"><input type="checkbox" id="dAuto"> 儲存內務檢查時，自動轉入加扣分</label>
        <div id="dMapping"></div>
        <div id="dMapMsg" class="status" hidden></div>
      </section>
      <section>
        <h2>備份與匯入</h2>
        <p class="note">可以把這一期的寢室名單和檢查紀錄存成備份檔，或匯入線上版內務統計匯出的資料。</p>
        <div class="d-row">
          <button type="button" id="dExport" class="secondary">下載內務備份</button>
          <label class="button secondary d-filebtn">匯入內務資料<input type="file" id="dImport" accept=".json,application/json" hidden></label>
        </div>
        <div id="dImportMsg" class="status" hidden></div>
      </section>
    </div>

    <div data-pane="history" hidden>
      <section><h2>已登錄的檢查</h2><div id="dHistory"></div></section>
    </div>`;
  }

  function showSub(name) {
    sub = name;
    document.querySelectorAll("#tab-dorm .d-subtabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.sub === name)));
    document.querySelectorAll("#tab-dorm [data-pane]").forEach(p => { p.hidden = p.dataset.pane !== name; });
    render();
  }

  function render() {
    if (!data) return;
    const c = cohort();
    $("dNoCohort").hidden = !!c;
    document.querySelectorAll("#tab-dorm [data-pane]").forEach(p => { if (!c) p.hidden = true; });
    if (!c) return;
    document.querySelectorAll("#tab-dorm [data-pane]").forEach(p => { p.hidden = p.dataset.pane !== sub; });
    if (sub === "entry") renderDraft();
    if (sub === "stats") renderStats();
    if (sub === "query") renderQuery();
    if (sub === "rooms") renderRooms();
    if (sub === "history") renderHistory();
  }

  /* ═════ 登錄公告 ═════ */
  function buildDraft() {
    const raw = $("dRaw").value;
    if (!raw.trim()) { draft = null; renderDraft(); return; }
    const p = D.parseReport(raw, index().norm);
    const prevDate = draft && draft.dateEdited ? draft.date : null;
    draft = {raw, date: prevDate || p.date || D.todayStr(), dateFound: !!p.date, dateEdited: !!prevDate, items: p.items, ignored: p.ignored, floor: p.floor};
    pendingOverwrite = false;
    renderDraft();
  }

  function pointsPreview() {
    const c = cohort();
    if (!draft || !c) return null;
    return D.pointsFromReport({date: draft.date, items: draft.items}, c, data.mapping, stu);
  }

  function renderDraft() {
    const box = $("dPreview");
    if (!draft) { box.hidden = true; return; }
    box.hidden = false;
    $("dDate").value = draft.date;
    $("dInspList").innerHTML = data.inspectors.map(n => `<option value="${esc(n)}"></option>`).join("");
    const mm = memberMap(), cd = cdata(), known = new Set(cd.rooms.map(r => r.room));
    const pItems = draft.items.filter(i => i.scope === "p"), gItems = draft.items.filter(i => i.scope === "g");
    const row = (it, idx) => {
      const unit = it.scope === "p" ? 0.2 : 1;
      const chips = it.targets.map(t => {
        const unk = it.scope === "p" ? (t[0] === "?" || (cd.rooms.length && !mm.has(t))) : (cd.rooms.length && !known.has(t));
        const lab = it.scope === "p" ? esc(who(t)) + (nameOf(t) ? " " + esc(nameOf(t)) : "") + (mm.has(t) ? ` <small>${esc(RL(mm.get(t)))}</small>` : "") : esc(RL(t));
        const nt = it.notes && it.notes[t] ? `<small>（${esc(it.notes[t])}）</small>` : "";
        return `<span class="d-chip${unk ? " unk" : ""}">${lab}${nt}</span>`;
      }).join("") + it.bad.map(b => `<span class="d-chip unk" title="無法辨識">？${esc(b)}</span>`).join("");
      return `<div class="d-item"><button type="button" class="d-sign ${it.sign > 0 ? "pos" : "neg"}" data-flip="${idx}" title="點一下切換加分／扣分">${it.sign > 0 ? "+" : "−"}${unit}</button>
        <div class="d-iname">${esc(it.item)}<small>${it.targets.length} ${it.scope === "p" ? "人" : "間"}</small></div><div class="d-chips">${chips}</div></div>`;
    };
    let html = "";
    if (pItems.length) html += `<h3>個人</h3>` + pItems.map(it => row(it, draft.items.indexOf(it))).join("");
    if (gItems.length) html += `<h3 style="margin-top:10px">公區</h3>` + gItems.map(it => row(it, draft.items.indexOf(it))).join("");
    if (!draft.items.length) html = `<p class="note">沒有辨識到任何項目。請確認每一行是「項目名稱 號碼 號碼…」的格式。</p>`;
    $("dItems").innerHTML = html;

    const warns = [];
    const notStu = Array.from(new Set(pItems.flatMap(i => i.targets).filter(t => t[0] === "?")));
    if (notStu.length) warns.push(`這一期名冊裡沒有這些號碼：${notStu.map(t => t.slice(1)).join("、")}`);
    if (!cd.rooms.length) warns.push("還沒設定寢室名單，個人分數會記下來，但要到「寢室名單與設定」設定後才能算進寢室總分。");
    else {
      const unkS = Array.from(new Set(pItems.flatMap(i => i.targets).filter(t => t[0] !== "?" && !mm.has(t))));
      const unkR = Array.from(new Set(gItems.flatMap(i => i.targets).filter(t => !known.has(t))));
      if (unkS.length) warns.push(`還沒分配寢室：${unkS.map(t => who(t) + " " + nameOf(t)).join("、")}（虛線框）`);
      if (unkR.length) warns.push(`寢室名單裡沒有這些寢室：${unkR.map(RL).join("、")}`);
    }
    if (!draft.dateFound && !draft.dateEdited) warns.push("公告裡沒有讀到日期，先填今天，請確認檢查日期。");
    if (draft.floor && draft.floor.length) warns.push(`樓層公共區域（不屬於任何寢室，不計分）：${draft.floor.join("／")}`);
    if (draft.ignored.length) warns.push(`略過的文字：${draft.ignored.join("／")}`);
    $("dWarn").innerHTML = warns.map(w => `<div class="status warning">${esc(w)}</div>`).join("");

    const pv = pointsPreview(), plus = pv.records.filter(r => r.kind === "加分").length, minus = pv.records.length - plus;
    const needMap = pItems.length && (!data.mapping || !data.mapping.plus && pItems.some(i => i.sign > 0) || !data.mapping.minus && pItems.some(i => i.sign < 0));
    let line = "";
    if (!data.autoPoints) line = "目前設定為不轉入加扣分，只記錄內務統計。";
    else if (!B.pointsOptions()) line = "⚠ 還沒匯入加扣分範本，這次只會記錄內務統計，不會轉入加扣分。";
    else if (needMap) line = "⚠ 還沒選好轉入加扣分要用的事蹟說明，請到「寢室名單與設定」設定；未設定的部分不會轉入。";
    else if (pv.records.length) line = `儲存後會在「加扣分」分頁新增 ${pv.records.length} 筆紀錄（加分 ${plus}、扣分 ${minus}，每筆 0.2 分）。`;
    const old = B.countPoints("dorm:" + cohort().id + ":" + draft.date);
    if (line && old && data.autoPoints) line += `這一天之前轉入、還在加扣分預覽表的 ${old} 筆會先移除再重新新增。`;
    $("dPointsLine").textContent = line;

    const exists = !!cdata().reports[draft.date];
    let s = `<button type="button" id="dSaveBtn" ${draft.items.length ? "" : "disabled"}>儲存這次檢查</button>`;
    if (pendingOverwrite) s = `<span>${esc(draft.date)} 已經有一筆紀錄，要用這則取代嗎？</span><button type="button" class="solid-danger" id="dOverwrite">取代</button><button type="button" class="secondary" id="dCancelOverwrite">取消</button>`;
    else if (exists) s += `<span class="note">這一天已經有紀錄，儲存會取代舊的。</span>`;
    $("dSave").innerHTML = s;
  }

  async function saveDraft(force) {
    if (!draft) return;
    const cd = cdata(), c = cohort();
    if (!force && cd.reports[draft.date]) { pendingOverwrite = true; renderDraft(); return; }
    const insp = $("dInsp").value.trim();
    if (insp && !data.inspectors.includes(insp)) { data.inspectors.push(insp); data.inspectors.sort((a, b) => a.localeCompare(b, "zh-Hant")); }
    const report = {date: draft.date, inspector: insp, raw: draft.raw, savedAt: new Date().toISOString(),
      items: draft.items.map(({scope, item, sign, targets, notes}) => ({scope, item, sign, targets: targets.filter(t => t[0] !== "?"), notes: notes || {}}))};
    cd.reports[draft.date] = report;
    let note = "";
    if (data.autoPoints && B.pointsOptions()) {
      const pv = D.pointsFromReport(report, c, data.mapping, stu);
      const removed = B.replacePoints("dorm:" + c.id + ":" + report.date, pv.records);
      note = pv.records.length ? `，並在「加扣分」新增 ${pv.records.length} 筆紀錄` + (removed ? `（取代原本 ${removed} 筆）` : "") : "";
      if (pv.skipped.length) note += `；${pv.skipped.length} 筆因事蹟說明未設定或查無此人沒有轉入`;
    }
    try { await flush(); } catch (e) { msg("dEntryMsg", "儲存失敗：" + e.message, "error"); return; }
    month = report.date.slice(0, 7);
    $("dRaw").value = ""; $("dInsp").value = ""; draft = null; pendingOverwrite = false;
    renderDraft();
    msg("dEntryMsg", `已儲存 ${report.date} 的內務檢查${note}。`, "ok");
  }

  /* ═════ 月統計 ═════ */
  function months() {
    const s = new Set(reportsList().map(r => r.date.slice(0, 7)));
    s.add(D.todayStr().slice(0, 7));
    return Array.from(s).sort().reverse();
  }
  function renderStats() {
    const ms = months();
    if (!month || !ms.includes(month)) month = ms.find(m => reportsList().some(r => r.date.startsWith(m))) || ms[0];
    $("dMonth").innerHTML = ms.map(m => `<option value="${m}" ${m === month ? "selected" : ""}>${D.rocMonth(m)}</option>`).join("");
    const [from, to] = D.monthRange(month), S = D.summarize(reportsList(), cdata().rooms, from, to);
    const w = [];
    if (!S.reportCount) w.push(["warning", `${D.rocMonth(month)}還沒有檢查紀錄。到「登錄公告」貼上 LINE 公告就會開始統計。`]);
    else w.push(["ok", `本月共 ${S.reportCount} 次檢查。`]);
    if (!cdata().rooms.length && S.reportCount) w.push(["warning", "尚未設定寢室名單，寢室總分目前只有公區分數。"]);
    $("dStatsWarn").innerHTML = w.map(([k, t]) => `<div class="status ${k}">${esc(t)}</div>`).join("");
    const chips = (rs, pred) => {
      const list = rs.flatMap(r => r.members.map(k => ({k, s: (S.people.get(k) || {score: 0}).score}))).filter(x => pred(x.s));
      return list.length ? list.map(x => `<span class="d-chip">${esc(who(x.k))} ${esc(nameOf(x.k))} <b class="${tone(x.s)}">${fmt(x.s)}</b></span>`).join("") : `<span class="note">沒有</span>`;
    };
    const card = (cls, lab, rs, listLab, pred) => `<div class="d-vcard ${cls}"><div class="d-vlab">${lab}</div>` +
      (rs.length ? `<div class="d-vroom">${rs.map(r => esc(RL(r.room))).join("、")}<span class="${cls === "bad" ? "d-neg" : "d-pos"}">${fmt(rs[0].total)}</span></div>
        <div class="note">${listLab}</div><div class="d-chips">${chips(rs, pred)}</div>` : `<p class="note">資料不足，還分不出來。</p>`) + `</div>`;
    $("dVerdict").innerHTML = card("bad", "最劣寢", S.worst, "寢內負分同學", s => s < 0) + card("good", "最優寢", S.best, "寢內正分同學", s => s > 0);
    const wS = new Set(S.worst.map(r => r.room)), bS = new Set(S.best.map(r => r.room));
    const desc = S.rooms.slice().reverse();
    $("dRoomTbl").innerHTML = `<thead><tr><th>名次</th><th>寢室</th><th class="r">室員合計</th><th class="r">公區</th><th class="r">總分</th></tr></thead><tbody>` +
      (desc.length ? desc.map((r, i) => `<tr class="${wS.has(r.room) ? "row-bad" : bS.has(r.room) ? "row-good" : ""}"><td>${i + 1}</td><td>${esc(RL(r.room))}</td><td class="r">${fmt(r.mScore)}</td><td class="r">${fmt(r.pub)}</td><td class="r ${tone(r.total)}"><b>${fmt(r.total)}</b></td></tr>`).join("")
        : `<tr><td colspan="5" class="note">設定寢室名單後，這裡會列出全部寢室。</td></tr>`) + `</tbody>`;
  }
  function monthText() {
    const [from, to] = D.monthRange(month), S = D.summarize(reportsList(), cdata().rooms, from, to);
    const names = (rs, pred) => rs.flatMap(r => r.members.map(k => ({k, s: (S.people.get(k) || {score: 0}).score}))).filter(x => pred(x.s)).map(x => who(x.k) + nameOf(x.k) + "(" + fmt(x.s) + ")").join("、") || "無";
    const lines = [`${D.rocMonth(month)} 內務統計（共 ${S.reportCount} 次檢查）`];
    if (S.worst.length) lines.push(`最劣寢：${S.worst.map(r => RL(r.room)).join("、")}（${fmt(S.worst[0].total)}）`, `　負分同學：${names(S.worst, s => s < 0)}`);
    if (S.best.length) lines.push(`最優寢：${S.best.map(r => RL(r.room)).join("、")}（${fmt(S.best[0].total)}）`, `　正分同學：${names(S.best, s => s > 0)}`);
    return lines.join("\n");
  }

  /* ═════ 明細查詢 ═════ */
  function relMonth(off) {
    const t = new Date(), a = new Date(t.getFullYear(), t.getMonth() + off, 1);
    return D.monthRange(a.getFullYear() + "-" + String(a.getMonth() + 1).padStart(2, "0"));
  }
  function resolvePerson(v) {
    v = v.trim(); if (!v) return "";
    const m = v.match(/\d+/);
    if (m) { const k = index().norm(m[0]); if (k && k[0] !== "?") return k; }
    const hit = (cohort().students || []).find(s => s.name && v.includes(s.name));
    return hit ? hit.school : null;
  }
  const extremes = (rows, keys) => { const X = {}; keys.forEach(k => { const v = rows.map(r => r[k]); X[k] = {max: Math.max(...v), min: Math.min(...v)}; }); return X; };
  const hlOf = (X, k, v, kind) => {
    const {max, min} = X[k];
    if (kind === "good") return max > 0 && v === max ? "hl-g" : "";
    if (kind === "bad") return max > 0 && v === max ? "hl-b" : "";
    if (max === min) return "";
    return v === max ? "hl-g" : v === min ? "hl-b" : "";
  };
  const legend = `<span class="hl-g d-legend">綠底</span> 該欄最好　<span class="hl-b d-legend">紅底</span> 該欄最差`;
  function entryRows(list, showWho) {
    if (!list.length) return `<tr><td colspan="${showWho ? 6 : 5}" class="note">這段期間沒有紀錄。</td></tr>`;
    return list.map(e => `<tr><td>${e.date.slice(5).replace("-", "/")}</td>${showWho ? `<td>${e.scope === "p" ? esc(who(e.target) + " " + nameOf(e.target)) : "公區"}</td>` : ""}<td>${esc(e.item)}${e.note ? `<small class="note">（${esc(e.note)}）</small>` : ""}</td><td>${e.scope === "p" ? "個人" : "公區"}</td><td class="r ${e.sign < 0 ? "d-neg" : "d-pos"}">${fmt(D.pts(e))}</td><td>${esc(e.insp || "—")}</td></tr>`).join("");
  }
  const stat = (l, s, cls) => `<div class="d-stat"><span class="note">${l}</span><b class="${cls || ""}">${s}</b></div>`;

  function renderQuery() {
    if (!q.from) [q.from, q.to] = relMonth(0);
    $("qFrom").value = q.from; $("qTo").value = q.to;
    const cd = cdata(), mm = memberMap(), students = cohort().students || [];
    $("qRoom").innerHTML = `<option value="">全部（總覽）</option>` + cd.rooms.map(r => `<option value="${esc(r.room)}" ${r.room === q.room ? "selected" : ""}>${esc(RL(r.room))}</option>`).join("");
    $("qPeople").innerHTML = students.map(s => `<option value="${esc((s.female || s.team) + " " + s.name)}"></option>`).join("");
    const E = D.entries(reportsList(), q.from, q.to);
    const range = q.from.replace(/-/g, "/") + " – " + q.to.replace(/-/g, "/");
    const nRep = new Set(E.map(e => e.date)).size;
    const head = `<tr><th>日期</th><th>項目</th><th>類別</th><th class="r">分數</th><th>檢查人</th></tr>`;
    let h = "";
    if (q.person) {
      const k = resolvePerson(q.person);
      if (!k) { $("qOut").innerHTML = `<div class="status warning">這一期名冊裡找不到「${esc(q.person)}」。</div>`; return; }
      const mine = E.filter(e => e.scope === "p" && e.target === k), sc = mine.reduce((s, e) => s + D.pts(e), 0);
      h = `<section><div class="h2-row"><h2>${esc(who(k))} ${esc(nameOf(k))}</h2><span class="note">${mm.has(k) ? esc(RL(mm.get(k))) : "未分配寢室"}・${range}</span></div>
        <div class="d-row">${stat("優點", mine.filter(e => e.sign > 0).length + " 項", "d-pos")}${stat("缺點", mine.filter(e => e.sign < 0).length + " 項", "d-neg")}${stat("分數", fmt(sc), tone(sc))}</div>
        <div class="d-tablewrap"><table class="d-table"><thead>${head}</thead><tbody>${entryRows(mine, false)}</tbody></table></div>
        ${mm.has(k) ? `<button type="button" class="secondary" data-goroom="${esc(mm.get(k))}">看${esc(RL(mm.get(k)))}的明細</button>` : ""}</section>`;
    } else if (q.room) {
      const members = (cd.rooms.find(r => r.room === q.room) || {members: []}).members;
      const pubE = E.filter(e => e.scope === "g" && e.target === q.room), memE = E.filter(e => e.scope === "p" && members.includes(e.target));
      const pubS = pubE.reduce((s, e) => s + D.pts(e), 0), memS = memE.reduce((s, e) => s + D.pts(e), 0);
      const mrows = members.map(k => { const l = memE.filter(e => e.target === k); return {k, plus: l.filter(e => e.sign > 0).length, minus: l.filter(e => e.sign < 0).length, s: l.reduce((a, e) => a + D.pts(e), 0)}; }).sort((a, b) => a.s - b.s);
      h = `<section><div class="h2-row"><h2>${esc(RL(q.room))}</h2><span class="note">${members.length} 人・${range}</span></div>
          <div class="d-row">${stat("室員合計", fmt(memS), tone(memS))}${stat("公區", fmt(pubS), tone(pubS))}${stat("總分", fmt(memS + pubS), tone(memS + pubS))}</div></section>
        <section><h2>公區優缺點</h2><div class="d-tablewrap"><table class="d-table"><thead>${head}</thead><tbody>${entryRows(pubE, false)}</tbody></table></div></section>
        <section><h2>室員</h2><div class="d-tablewrap"><table class="d-table"><thead><tr><th>隊號</th><th>姓名</th><th class="r">優</th><th class="r">缺</th><th class="r">分數</th></tr></thead><tbody>${
          mrows.map(r => `<tr><td><a href="#" data-goperson="${esc(r.k)}">${esc(who(r.k))}</a></td><td>${esc(nameOf(r.k))}</td><td class="r">${r.plus}</td><td class="r">${r.minus}</td><td class="r ${tone(r.s)}">${fmt(r.s)}</td></tr>`).join("") || `<tr><td colspan="5" class="note">名單裡沒有室員。</td></tr>`}</tbody></table></div></section>
        <section><h2>室員個人優缺點</h2><div class="d-tablewrap"><table class="d-table"><thead><tr><th>日期</th><th>同學</th><th>項目</th><th>類別</th><th class="r">分數</th><th>檢查人</th></tr></thead><tbody>${entryRows(memE, true)}</tbody></table></div></section>`;
    } else {
      const seg = `<div class="d-seg" role="group"><button type="button" data-view="room" aria-pressed="${q.view === "room"}">寢室總覽</button><button type="button" data-view="person" aria-pressed="${q.view === "person"}">個人總覽</button></div>`;
      if (q.view === "person") {
        const pr = students.map(s => { const l = E.filter(e => e.scope === "p" && e.target === s.school);
          return {k: s.school, f: s.female || s.team, name: s.name, room: mm.get(s.school) || "", plus: l.filter(e => e.sign > 0).length, minus: l.filter(e => e.sign < 0).length, s: l.reduce((a, e) => a + D.pts(e), 0)}; });
        const X = extremes(pr, ["plus", "minus", "s"]);
        const cmp = {f: (a, b) => a.f.localeCompare(b.f, "zh-Hant", {numeric: true}), name: (a, b) => a.name.localeCompare(b.name, "zh-Hant"), room: (a, b) => a.room.localeCompare(b.room, "zh-Hant", {numeric: true}),
          plus: (a, b) => a.plus - b.plus, minus: (a, b) => a.minus - b.minus, s: (a, b) => a.s - b.s}[q.sort.k];
        pr.sort((a, b) => cmp(a, b) * q.sort.dir || a.f.localeCompare(b.f, "zh-Hant", {numeric: true}));
        const th = (k, label, r) => `<th class="${r ? "r " : ""}d-sortable" data-psort="${k}">${label}${q.sort.k === k ? (q.sort.dir > 0 ? " ▲" : " ▼") : ""}</th>`;
        h = `<section><div class="h2-row">${seg}<span class="note">${range}・${nRep} 次檢查</span></div>
          <p class="note">${pr.length} 人：${pr.filter(r => r.plus).length} 人有優點、${pr.filter(r => r.minus).length} 人有缺點。點欄位名稱可以排序，點隊號看個人明細。${legend}</p>
          <div class="d-tablewrap"><table class="d-table"><thead><tr>${th("f", "隊號")}${th("name", "姓名")}${th("room", "寢室")}${th("plus", "優", 1)}${th("minus", "缺", 1)}${th("s", "分數", 1)}</tr></thead><tbody>${
            pr.map(r => `<tr><td><a href="#" data-goperson="${esc(r.k)}">${esc(r.f)}</a></td><td>${esc(r.name)}</td><td>${r.room ? esc(RL(r.room)) : "—"}</td><td class="r ${hlOf(X, "plus", r.plus, "good")}">${r.plus}</td><td class="r ${hlOf(X, "minus", r.minus, "bad")}">${r.minus}</td><td class="r ${tone(r.s)} ${hlOf(X, "s", r.s)}">${fmt(r.s)}</td></tr>`).join("") || `<tr><td colspan="6" class="note">這一期名冊沒有學生。</td></tr>`}</tbody></table></div></section>`;
      } else {
        const rows = cd.rooms.map(r => {
          const pe = E.filter(e => e.scope === "p" && r.members.includes(e.target)), ge = E.filter(e => e.scope === "g" && e.target === r.room);
          const ps = pe.reduce((s, e) => s + D.pts(e), 0), gs = ge.reduce((s, e) => s + D.pts(e), 0);
          return {room: r.room, pp: pe.filter(e => e.sign > 0).length, pm: pe.filter(e => e.sign < 0).length, gp: ge.filter(e => e.sign > 0).length, gm: ge.filter(e => e.sign < 0).length, ps, gs, t: ps + gs};
        }).sort((a, b) => b.t - a.t || a.room.localeCompare(b.room, "zh-Hant", {numeric: true}));
        const X = rows.length ? extremes(rows, ["pp", "pm", "gp", "gm", "ps", "gs", "t"]) : {};
        const c = (k, v, kind) => rows.length ? hlOf(X, k, v, kind) : "";
        h = `<section><div class="h2-row">${seg}<span class="note">${range}・${nRep} 次檢查</span></div>
          <p class="note">點寢室可以看明細，或在上方輸入隊號、姓名查個人。${legend}</p>
          <div class="d-tablewrap"><table class="d-table"><thead><tr><th>寢室</th><th class="r">個人優</th><th class="r">個人缺</th><th class="r">公區優</th><th class="r">公區缺</th><th class="r">個人分</th><th class="r">公區分</th><th class="r">總分</th></tr></thead><tbody>${
            rows.map(r => `<tr><td><a href="#" data-goroom="${esc(r.room)}">${esc(RL(r.room))}</a></td><td class="r ${c("pp", r.pp, "good")}">${r.pp}</td><td class="r ${c("pm", r.pm, "bad")}">${r.pm}</td><td class="r ${c("gp", r.gp, "good")}">${r.gp}</td><td class="r ${c("gm", r.gm, "bad")}">${r.gm}</td><td class="r ${tone(r.ps)} ${c("ps", r.ps)}">${fmt(r.ps)}</td><td class="r ${tone(r.gs)} ${c("gs", r.gs)}">${fmt(r.gs)}</td><td class="r ${tone(r.t)} ${c("t", r.t)}"><b>${fmt(r.t)}</b></td></tr>`).join("") || `<tr><td colspan="8" class="note">先到「寢室名單與設定」設定寢室名單。</td></tr>`}</tbody></table></div></section>`;
      }
    }
    $("qOut").innerHTML = h;
  }

  /* ═════ 寢室名單與設定 ═════ */
  function renderRooms() {
    const cd = cdata();
    if (document.activeElement !== $("dRoomsText")) $("dRoomsText").value = cd.roomsText;
    roomsInfo();
    $("dAuto").checked = !!data.autoPoints;
    const opts = B.pointsOptions();
    if (!opts) { $("dMapping").innerHTML = `<div class="status warning">還沒匯入加扣分範本。請先到「名冊與設定」匯入，才能選擇事蹟說明。</div>`; return; }
    if (!data.mapping) { data.mapping = D.guessMapping(opts); save(); }
    const block = (key, kind, prefix) => {
      const cur = data.mapping[key] || {}, cats = Object.keys(opts).filter(c => c.startsWith(prefix));
      const reasons = cur.cat && opts[cur.cat] ? opts[cur.cat] : [];
      return `<div class="d-map"><h3>${kind}（個人${key === "plus" ? "優點" : "缺點"}）</h3>` +
        `<label for="dMapCat-${key}">加減分依據（歸類）</label><select id="dMapCat-${key}" data-mapcat="${key}"><option value="">請選擇</option>${cats.map(c => `<option ${c === cur.cat ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
        <label for="dMapReason-${key}">事蹟說明</label><select id="dMapReason-${key}" data-mapreason="${key}"><option value="">請選擇</option>${reasons.map(r => `<option ${r === cur.reason ? "selected" : ""}>${esc(r)}</option>`).join("")}</select></div>`;
    };
    $("dMapping").innerHTML = `<div class="grid">${block("plus", "加分", "優良")}${block("minus", "扣分", "不良")}</div>`;
  }
  function roomsInfo() {
    const {rooms, issues} = D.parseRooms($("dRoomsText").value, index().norm);
    const students = cohort().students || [], assigned = new Set(rooms.flatMap(r => r.members));
    const left = students.filter(s => !assigned.has(s.school));
    $("dRoomCount").textContent = rooms.length + " 間寢室";
    let h = issues.length ? `<div class="status warning">${issues.map(esc).join("<br>")}</div>` : "";
    if (students.length) h += `<div class="status ${left.length ? "warning" : "ok"}">名冊 ${students.length} 人，已分配寢室 ${students.length - left.length} 人${left.length ? `，還有 ${left.length} 人沒分配：${left.slice(0, 30).map(s => esc((s.female || s.team) + s.name)).join("、")}${left.length > 30 ? "…" : ""}` : ""}。</div>`;
    $("dRoomsInfo").innerHTML = h;
  }

  /* ═════ 檢查紀錄 ═════ */
  function renderHistory() {
    const list = reportsList().reverse(), c = cohort();
    $("dHistory").innerHTML = list.length ? list.map(r => {
      const n = (r.items || []).reduce((s, i) => s + i.targets.length, 0), inPts = B.countPoints("dorm:" + c.id + ":" + r.date);
      return `<div class="d-rep"><div class="d-row" style="justify-content:space-between"><div><b>${esc(r.date)}</b> <span class="note">${n} 筆優缺點${inPts ? `・加扣分預覽表 ${inPts} 筆` : ""}</span></div>
        <div class="d-row"><label class="d-inline note">檢查人 <input type="text" list="dInspList" data-insp="${esc(r.date)}" value="${esc(r.inspector || "")}" placeholder="未填"></label>
        <button type="button" class="danger d-small" data-del="${esc(r.date)}">刪除</button></div></div>
        <details><summary class="note">原始公告</summary><pre class="d-raw">${esc(r.raw || "")}</pre></details></div>`;
    }).join("") : `<p class="note">還沒有紀錄。</p>`;
    $("dInspList").innerHTML = data.inspectors.map(n => `<option value="${esc(n)}"></option>`).join("");
  }

  /* ═════ 備份與匯入 ═════ */
  function exportBackup() {
    const c = cohort(), cd = cdata();
    const toNum = k => { const s = stu(k); return s ? (s.female || s.team) : k; };
    const out = {app: "內務統計", version: 1, cohort: c.label, exportedAt: new Date().toISOString(),
      rooms: cd.rooms.map(r => ({room: r.room, members: r.members.map(toNum)})),
      reports: Object.values(cd.reports).map(r => Object.assign({}, r, {items: r.items.map(it => Object.assign({}, it, {
        targets: it.scope === "p" ? it.targets.map(toNum) : it.targets,
        notes: Object.fromEntries(Object.entries(it.notes || {}).map(([k, v]) => [it.scope === "p" ? toNum(k) : k, v]))}))})),
      inspectors: data.inspectors};
    const bytes = new TextEncoder().encode(JSON.stringify(out, null, 1));
    B.download(bytes, "內務備份_" + c.label + "_" + D.todayStr() + ".json");
  }
  /** 匯入的資料用女生隊號／建制隊號記人，依目前這一期的名冊換成學籍號碼。 */
  async function importBackup(file) {
    try {
      const d = JSON.parse(await file.text());
      if (!Array.isArray(d.reports)) throw new Error("這不是內務資料檔。");
      const norm = index().norm, cd = cdata(), miss = new Set();
      const conv = t => { const k = norm(String(t)); if (!k || k[0] === "?") { miss.add(String(t)); return null; } return k; };
      let added = 0, replaced = 0;
      for (const r of d.reports) {
        if (!r.date) continue;
        const items = (r.items || []).map(it => {
          const notes = {};
          const targets = it.scope === "p" ? it.targets.map(t => { const k = conv(t); if (k && it.notes && it.notes[t]) notes[k] = it.notes[t]; return k; }).filter(Boolean) : it.targets.slice();
          if (it.scope !== "p") Object.assign(notes, it.notes || {});
          return {scope: it.scope, item: it.item, sign: it.sign, targets, notes};
        });
        if (cd.reports[r.date]) replaced++; else added++;
        cd.reports[r.date] = {date: r.date, inspector: r.inspector || "", raw: r.raw || "", savedAt: r.savedAt || new Date().toISOString(), items};
      }
      if (Array.isArray(d.rooms) && d.rooms.length) {
        cd.roomsText = d.rooms.map(r => r.room + " " + r.members.join(" ")).join("\n");
        cd.rooms = D.parseRooms(cd.roomsText, norm).rooms;
      }
      (d.inspectors || []).forEach(n => { if (n && !data.inspectors.includes(n)) data.inspectors.push(n); });
      await flush();
      msg("dImportMsg", `已匯入 ${added + replaced} 次檢查（新增 ${added}、取代 ${replaced}）` + (d.rooms && d.rooms.length ? `和 ${d.rooms.length} 間寢室名單` : "") + "。匯入的舊資料不會轉入加扣分。" + (miss.size ? `這一期名冊找不到的號碼已略過：${Array.from(miss).slice(0, 20).join("、")}` : ""), miss.size ? "warning" : "ok");
      renderRooms();
    } catch (e) { msg("dImportMsg", "匯入失敗：" + e.message, "error"); }
  }

  /* ═════ 事件 ═════ */
  function bind() {
    const root = $("tab-dorm");
    root.addEventListener("click", async e => {
      const t = e.target;
      const sb = t.closest("[data-sub]"); if (sb) { showSub(sb.dataset.sub); return; }
      const f = t.closest("[data-flip]"); if (f && draft) { const it = draft.items[+f.dataset.flip]; it.sign *= -1; renderDraft(); return; }
      if (t.id === "dSaveBtn") return saveDraft(false);
      if (t.id === "dOverwrite") return saveDraft(true);
      if (t.id === "dCancelOverwrite") { pendingOverwrite = false; renderDraft(); return; }
      if (t.id === "dCopy") {
        const txt = monthText();
        try { await navigator.clipboard.writeText(txt); msg("dEntryMsg", "", ""); t.textContent = "已複製"; setTimeout(() => { t.textContent = "複製結果到 LINE"; }, 1500); }
        catch (_) { prompt("請複製以下文字：", txt); }
        return;
      }
      const qb = t.closest("[data-q]");
      if (qb) {
        if (qb.dataset.q === "month") [q.from, q.to] = relMonth(0);
        else if (qb.dataset.q === "last") [q.from, q.to] = relMonth(-1);
        else { const ds = reportsList().map(r => r.date); q.from = ds[0] || D.todayStr(); q.to = ds.length && ds[ds.length - 1] > D.todayStr() ? ds[ds.length - 1] : D.todayStr(); }
        renderQuery(); return;
      }
      const v = t.closest("[data-view]"); if (v) { q.view = v.dataset.view; renderQuery(); return; }
      const so = t.closest("[data-psort]"); if (so) { const k = so.dataset.psort; q.sort = q.sort.k === k ? {k, dir: -q.sort.dir} : {k, dir: ["s", "plus", "minus"].includes(k) ? -1 : 1}; renderQuery(); return; }
      const gr = t.closest("[data-goroom]"); if (gr) { e.preventDefault(); q.room = gr.dataset.goroom; q.person = ""; $("qPerson").value = ""; renderQuery(); window.scrollTo({top: 0}); return; }
      const gp = t.closest("[data-goperson]"); if (gp) { e.preventDefault(); const k = gp.dataset.goperson; q.person = who(k); $("qPerson").value = who(k) + " " + nameOf(k); renderQuery(); window.scrollTo({top: 0}); return; }
      if (t.id === "dRoomsSave") {
        const text = $("dRoomsText").value, cd = cdata();
        cd.roomsText = text; cd.rooms = D.parseRooms(text, index().norm).rooms;
        try { await flush(); msg("dMapMsg", "", ""); roomsInfo(); t.textContent = "已儲存"; setTimeout(() => { t.textContent = "儲存寢室名單"; }, 1500); }
        catch (err) { alert("儲存失敗：" + err.message); }
        return;
      }
      if (t.id === "dExport") return exportBackup();
      const del = t.closest("[data-del]");
      if (del) {
        const date = del.dataset.del, src = "dorm:" + cohort().id + ":" + date, n = B.countPoints(src);
        if (!confirm(`確定刪除 ${date} 的內務檢查？` + (n ? `\n加扣分預覽表裡這次轉入的 ${n} 筆也會一起移除。` : ""))) return;
        delete cdata().reports[date];
        if (n) B.replacePoints(src, []);
        await flush(); renderHistory();
      }
    });
    root.addEventListener("change", e => {
      const t = e.target;
      if (t.id === "dDate" && draft && t.value) { draft.date = t.value; draft.dateEdited = true; pendingOverwrite = false; renderDraft(); }
      if (t.id === "dMonth") { month = t.value; renderStats(); }
      if (t.id === "qFrom" && t.value) { q.from = t.value; if (q.to < q.from) q.to = q.from; renderQuery(); }
      if (t.id === "qTo" && t.value) { q.to = t.value; if (q.from > q.to) q.from = q.to; renderQuery(); }
      if (t.id === "qRoom") { q.room = t.value; q.person = ""; $("qPerson").value = ""; renderQuery(); }
      if (t.id === "dAuto") { data.autoPoints = t.checked; save(); }
      if (t.dataset.mapcat) { data.mapping = data.mapping || {}; data.mapping[t.dataset.mapcat] = t.value ? {cat: t.value, reason: ""} : null; save(); renderRooms(); }
      if (t.dataset.mapreason) { const m = data.mapping[t.dataset.mapreason]; if (m) { m.reason = t.value; save(); msg("dMapMsg", "已儲存事蹟說明設定。", "ok"); } }
      if (t.dataset.insp) {
        const r = cdata().reports[t.dataset.insp]; if (!r) return;
        r.inspector = t.value.trim();
        if (r.inspector && !data.inspectors.includes(r.inspector)) data.inspectors.push(r.inspector);
        save();
      }
      if (t.id === "dImport" && t.files[0]) { importBackup(t.files[0]); t.value = ""; }
    });
    let rawTimer, personTimer;
    root.addEventListener("input", e => {
      const t = e.target;
      if (t.id === "dRaw") { clearTimeout(rawTimer); rawTimer = setTimeout(buildDraft, 250); msg("dEntryMsg", "", ""); }
      if (t.id === "dRoomsText") roomsInfo();
      if (t.id === "qPerson") { clearTimeout(personTimer); personTimer = setTimeout(() => { q.person = t.value.trim(); renderQuery(); }, 250); }
    });
  }

  /* ═════ 對外 ═════ */
  window.DormModule = {
    async enter(bridge) {
      B = bridge;
      if (!$("tab-dorm").firstElementChild) skeleton();
      if (!bound) { bind(); bound = true; }
      data = Object.assign({mapping: null, autoPoints: true, inspectors: [], byCohort: {}}, await B.Store.getJSON("dorm", {}));
      draft = null; month = null; q.from = null; q.room = ""; q.person = "";
      showSub(sub);
    },
    cohortChanged() { if (!data) return; idxCache = {id: null}; draft = null; month = null; q.room = ""; q.person = ""; if ($("dRaw")) $("dRaw").value = ""; render(); },
    templateChanged() { if (data && sub === "rooms") render(); },
    lock() { data = null; draft = null; if ($("tab-dorm")) $("tab-dorm").innerHTML = ""; },
    flush() { return data ? flush() : Promise.resolve(); }
  };
})();
