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
  let draft = null, pendingOverwrite = false;   // pendingOverwrite：同一天已有檢查，等使用者選「另外新增」或「取代」
  let sub = "entry", month = null;
  const q = {from: null, to: null, room: "", person: "", view: "room", sort: {k: "s", dir: 1}, rsort: {k: "t", dir: -1}};
  let idxCache = {id: null, idx: null}, bound = false, roomsEditing = false, roomsView = null, roomsEditFrom = null;   // roomsEditing：寢室名單已存過時，要按「重新輸入」才能改

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
    // 建制隊號（6 碼）也會對照其他期別的名冊：一則公告裡可能有別期的同學
    const others = (B.otherCohorts ? B.otherCohorts() : []).map(o => ({label: o.label, students: o.students || []}));
    const sig = c.id + "|" + c.students.length + "|" + others.map(o => o.label + ":" + o.students.length).join(",");
    if (idxCache.sig !== sig) idxCache = {id: c.id, sig, idx: D.studentIndex(c.students, others)};
    return idxCache.idx;
  }
  const reportsList = () => { const cd = cdata(); return cd ? Object.entries(cd.reports).map(([id, r]) => Object.assign(r, {id})).sort((a, b) => a.date.localeCompare(b.date) || String(a.savedAt).localeCompare(String(b.savedAt))) : []; };
  // 同一天可以有好幾次檢查：第一次的編號就是日期，之後是 日期_2、日期_3…
  const sameDay = date => reportsList().filter(r => r.date === date);
  const newId = date => { const cd = cdata(); if (!cd.reports[date]) return date; let n = 2; while (cd.reports[date + "_" + n]) n++; return date + "_" + n; };
  const srcOf = id => "dorm:" + cohort().id + ":" + id;
  const hhmm = t => { const d = new Date(t); return isNaN(d) ? "" : String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
  const nthLabel = r => { const list = sameDay(r.date); return list.length > 1 ? `第 ${list.indexOf(list.find(x => x.id === r.id)) + 1} 次` : ""; };
  const stu = k => index().get(k);
  const otherOf = k => index().otherCohort ? index().otherCohort(k) : null;   // 別期同學：回傳期別名稱
  // 別期同學一律顯示建制隊號（女生隊號各期會重複）
  const who = k => { if (k[0] === "?") return k.slice(1); const s = stu(k); return s ? (otherOf(k) ? s.team : (s.female || s.team)) : k; };
  const nameOf = k => { const s = stu(k); return s ? s.name + (otherOf(k) ? "（" + otherOf(k) + "）" : "") : ""; };
  /* ═════ 棟別、寢室名單版本（換寢、外派） ═════
     每一期：building＝這一期住的棟（"育"＝育才樓、"樂"＝樂群樓），寢室號沒寫棟名時就算這一棟；
     roomsHistory＝[{from, text, rooms}]，from 是開始適用的日期（空字串＝一開始就適用）。
     某一天用 from ≤ 那天的最後一份；比第一份還早的日子用第一份。
     外派：同學寫在別期（別棟）的名單裡，那段期間就不算在原本期別的寢室。 */
  const BNAME = D.BUILDING_NAMES;
  function buildingOfCohort(cd) {
    if (!cd) return "育";
    if (cd.building) return cd.building;
    const v = versionsOf(cd), k = v.length ? v[v.length - 1].rooms.map(r => D.buildingOf(r.room)).find(Boolean) : "";
    return k || "育";
  }
  const curBuilding = () => buildingOfCohort(cdata());
  function versionsOf(cd) {
    if (!cd) return [];
    if (Array.isArray(cd.roomsHistory) && cd.roomsHistory.length) return cd.roomsHistory;
    return cd.rooms && cd.rooms.length ? [{from: "", text: cd.roomsText || "", rooms: cd.rooms}] : [];
  }
  function versionAt(cd, date) {
    const vs = versionsOf(cd);
    if (!vs.length) return null;
    let v = vs[0];
    for (const x of vs) if (!x.from || x.from <= date) v = x;
    return v;
  }
  // 存一份名單版本（同一天開始的就取代），cd.rooms／roomsText 保持「今天適用」的那一份
  function setRoomsVersion(cd, from, text, rooms) {
    const vs = versionsOf(cd).filter(v => v.from !== from).concat({from, text, rooms});
    vs.sort((a, b) => a.from.localeCompare(b.from));
    cd.roomsHistory = vs;
    const cur = versionAt(cd, D.todayStr());
    cd.roomsText = cur ? cur.text : ""; cd.rooms = cur ? cur.rooms : [];
  }
  function deleteRoomsVersion(cd, from) {
    cd.roomsHistory = versionsOf(cd).filter(v => v.from !== from);
    const cur = versionAt(cd, D.todayStr());
    cd.roomsText = cur ? cur.text : ""; cd.rooms = cur ? cur.rooms : [];
  }
  // 某位同學在某一天，是不是寫在其他期別（別棟）的寢室名單裡 → 外派
  function placedElsewhere(k, date) {
    for (const o of (B.otherCohorts ? B.otherCohorts() : [])) {
      const v = versionAt(data.byCohort[o.id], date);
      if (!v) continue;
      const r = v.rooms.find(x => x.members.includes(k));
      if (r) return {cohort: o, room: r.room, from: v.from};
    }
    return null;
  }
  // 依日期查寢室：roomsAt(日期)、roomOf(學籍號碼, 日期)、mapAt(日期)
  function makeResolver() {
    const cd = cdata(), own = new Set((cohort().students || []).map(s => s.school));
    const memo = new Map(), maps = new Map(), away = new Map();
    const isAway = (k, date) => { const key = k + "|" + date; if (!away.has(key)) away.set(key, own.has(k) && !!placedElsewhere(k, date)); return away.get(key); };
    const roomsAt = date => {
      if (!memo.has(date)) {
        const v = versionAt(cd, date);
        memo.set(date, v ? v.rooms.map(r => ({room: r.room, members: r.members.filter(k => !isAway(k, date))})) : []);
      }
      return memo.get(date);
    };
    const mapAt = date => {
      if (!maps.has(date)) { const m = new Map(); roomsAt(date).forEach(r => r.members.forEach(k => m.set(k, r.room))); maps.set(date, m); }
      return maps.get(date);
    };
    return {roomsAt, mapAt, roomOf: (k, date) => mapAt(date).get(k) || null};
  }
  const memberMap = date => makeResolver().mapAt(date || D.todayStr());
  // 3 碼女生隊號各期會重複：先看「那天住在這棟樓」的人（含外派進來的別期同學，扣掉外派出去的本期同學）
  function normAt(date) {
    const base = index().norm, here = new Map();
    const add = (n, k) => { if (!here.has(n)) here.set(n, []); if (!here.get(n).includes(k)) here.get(n).push(k); };
    for (const s of cohort().students || []) if (s.female && !placedElsewhere(s.school, date)) add(String(parseInt(s.female, 10)), s.school);
    const v = versionAt(cdata(), date);
    if (v) v.rooms.forEach(r => r.members.forEach(k => { const s = stu(k); if (s && s.female && otherOf(k)) add(String(parseInt(s.female, 10)), k); }));
    return t => {
      if (/^\d{1,3}$/.test(t)) {
        const list = here.get(String(parseInt(t, 10))) || [];
        if (list.length === 1) return list[0];
        if (list.length > 1) return "?" + t + "（兩期同號）";
      }
      return base(t);
    };
  }
  let saveTimer = null;
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => B.Store.setJSON("dorm", data).catch(e => console.warn("內務資料儲存失敗", e)), 200); }
  const flush = () => { clearTimeout(saveTimer); return B.Store.setJSON("dorm", data); };

  function msg(id, text, kind) { const el = $(id); if (!el) return; el.hidden = !text; el.textContent = text || ""; el.className = "status" + (kind ? " " + kind : ""); }

  /* ───── 版面 ───── */
  function skeleton() {
    $("tab-dorm").innerHTML = `
    <nav class="d-subtabs" role="tablist" aria-label="內務功能">
      <button type="button" data-sub="entry">登錄公告</button><button type="button" data-sub="history">檢查紀錄</button><button type="button" data-sub="query">明細查詢</button><button type="button" data-sub="stats">月統計</button><button type="button" data-sub="rooms">寢室名單與設定</button>
    </nav>
    <div id="dNoCohort" class="status warning" hidden>請先到「名冊」匯入名冊並選擇目前期別。</div>

    <div data-pane="entry">
      <section>
        <div class="label-row"><h2 style="margin:0">貼上內務公告</h2><span class="copy-group"><label class="button secondary copy-btn d-ocrbtn" id="dOcrBtn" title="從圖片辨識公告文字" aria-label="從圖片辨識公告文字">圖片<input type="file" id="dOcrFile" accept="image/*" hidden></label><button type="button" id="dRawCopy" class="copy-btn secondary" aria-label="複製公告內容">複製</button><button type="button" id="dRawPaste" class="copy-btn secondary" aria-label="貼上剪貼簿內容">貼上</button><button type="button" id="dRawClear" class="copy-btn secondary clear-btn" aria-label="清空公告內容">清空</button></span></div>
        <p id="dOcrMsg" class="note d-ocrmsg" role="status" aria-live="polite"></p>
        <details id="dOcrPreview" class="d-ocrprev" open hidden><summary>對照圖片（核對用，不會存起來）</summary><img id="dOcrImg" alt="公告圖片"></details>
        <div class="input-cohort">對象：<span class="cohort-tag active-cohort-tag"></span>（用這一期的名冊辨識女生隊號、建制隊號；建制隊號也會對照其他期別）</div>
        <textarea id="dRaw" style="min-height:180px" placeholder="把 LINE 上的內務檢查公告整則貼上，例如：&#10;1151019內務檢查&#10;被優：002 003&#10;棉被不潔 088 444194&#10;公物&#10;窗溝不潔 育五7、6-2"></textarea>
        <div id="dQuickSlot"></div>
        <p class="note">「公物」那一行以下算公區（寫寢室號），以上算個人（寫女生隊號或建制隊號）。項目後面有標「(+0.2)」「(-0.2)」就照標示；標「(寢室記大X)」算那間寢室的公區缺點。沒有標示時，項目名稱有「優、整潔、整齊、乾淨」算加分，其他算扣分。點分數標籤可以改。</p>
        <details class="d-imghelp"><summary>公告是圖片？</summary>
          <p class="note">按標題右邊的「圖片」選公告圖片，App 會自己辨識（第一次使用要下載約 6 MB 的辨識資料，之後不用網路）。如果辨識不理想，也可以用手機或電腦內建的文字辨識：</p>
          <ul>
            <li><b>iPhone</b>：LINE 的圖片先「儲存」到照片，在「照片」打開，長按圖上的文字 →「全選」→「拷貝」，回到這裡按「貼上」。</li>
            <li><b>Mac</b>：用「預覽程式」或「照片」打開圖片，直接拖曳選取文字（或 ⌘A）→ ⌘C，回到這裡貼上。</li>
            <li><b>Windows 11</b>：按 Win＋Shift＋S 截取圖片範圍 → 點跳出的通知開啟「剪取工具」→ 按「文字動作」→「複製所有文字」，回到這裡貼上（需要較新版的剪取工具）。</li>
          </ul>
          <p class="note">辨識完請對照圖片看一下下方的辨識結果：找不到的號碼會標出來，可能是圖上寫錯或辨識錯。</p>
        </details>
      </section>
      <section id="dPreview" hidden>
        <div class="h2-row"><h2>辨識結果</h2></div>
        <div class="d-row">
          <label class="d-inline">檢查日期 <input type="date" id="dDate"></label>
          <label class="d-inline">內務檢查人 <input type="text" id="dInsp" list="dInspList" placeholder="輸入或選擇" autocomplete="off"></label>
          <datalist id="dInspList"></datalist>
        </div>
        <div class="d-inspchips" id="dInspChips"></div>
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
          <span class="d-row"><button type="button" id="dCopy" class="secondary d-small">複製結果到 LINE</button>${exportBtns("month")}</span>
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
        <div class="d-row d-bld"><label class="d-inline" for="dBuilding">這一期住</label><select id="dBuilding"><option value="育">育才樓（育）</option><option value="樂">樂群樓（樂）</option></select><span class="note">寢室號沒寫棟名時（例如 5-3），就算這一棟。</span></div>
        <p class="note">一行一間寢室：先寫寢室號，再寫住在裡面同學的女生隊號或建制隊號。例：5-7 002 003 007 010。每一期各自一份名單。<br>外派來住的別期同學，請寫 6 碼建制隊號（例如 5-3 002 003 451271），App 會自動算成外派：那段期間他算在這裡的寢室，不算回原本期別。<br>有人換寢或外派時，按「換寢／外派：從某天起用新名單」，以前的檢查仍照當時的名單算。</p>
        <div id="dRoomsVers" class="d-vers"></div>
        <textarea id="dRoomsText" style="min-height:220px" placeholder="5-1 001 002 003 004&#10;5-7 005 006 007 008"></textarea>
        <div class="d-row" id="dRoomsBtns"></div>
        <div id="dRoomsInfo"></div>
      </section>
      <section>
        <h2>轉入加扣分</h2>
        <p class="note">儲存內務檢查時，個人優缺點每一項會新增一筆 0.2 分的加扣分紀錄到「加扣分」分頁（公區只算寢室統計）。請選擇要用的歸類與事蹟說明。</p>
        <label class="check-label"><input type="checkbox" id="dAuto"> 儲存內務檢查時，自動轉入加扣分</label>
        <div id="dMapping"></div>
        <div id="dMapMsg" class="status" hidden></div>
      </section>
    </div>

    <div data-pane="history" hidden>
      <section><div class="h2-row"><h2>已登錄的檢查</h2>${exportBtns("history")}</div><div id="dHistory"></div></section>
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
    const prevDate = draft && draft.dateEdited ? draft.date : null, b = curBuilding();
    const p0 = D.parseReport(raw, index().norm, undefined, b);
    const p = D.parseReport(raw, normAt(prevDate || p0.date || D.todayStr()), undefined, b);
    draft = {raw, date: prevDate || p.date || D.todayStr(), dateFound: !!p.date, dateEdited: !!prevDate, items: p.items, ignored: p.ignored, floor: p.floor};
    pendingOverwrite = false;
    renderDraft();
  }

  function pointsPreview() {
    const c = cohort();
    if (!draft || !c) return null;
    return D.pointsFromReport({date: draft.date, items: draft.items}, c, data.mapping, stu, otherOf);
  }

  function renderDraft() {
    const box = $("dPreview");
    if (!draft) { box.hidden = true; return; }
    box.hidden = false;
    $("dDate").value = draft.date;
    $("dInspList").innerHTML = data.inspectors.map(n => `<option value="${esc(n)}"></option>`).join("");
    // 手機的瀏覽器常常不顯示下拉建議，所以另外列出曾經輸入過的檢查人，點一下就填入
    const cur = $("dInsp").value.trim();
    $("dInspChips").innerHTML = data.inspectors.length ? `<span class="note">點選檢查人：</span>` + data.inspectors.map(n => `<button type="button" class="d-pick${n === cur ? " on" : ""}" data-pickinsp="${esc(n)}">${esc(n)}</button>`).join("") : "";
    const R = makeResolver(), rsNow = R.roomsAt(draft.date), mm = R.mapAt(draft.date), known = new Set(rsNow.map(r => r.room)), hasRooms = rsNow.length > 0;
    const pItems = draft.items.filter(i => i.scope === "p"), gItems = draft.items.filter(i => i.scope === "g");
    const row = (it, idx) => {
      const unit = it.scope === "p" ? 0.2 : 1;
      const chips = it.targets.map(t => {
        const unk = it.scope === "p" ? (t[0] === "?" || (hasRooms && !mm.has(t) && !otherOf(t))) : (hasRooms && !known.has(t));
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

    const warns = [], info = [];
    const notStu = Array.from(new Set(pItems.flatMap(i => i.targets).filter(t => t[0] === "?")));
    const twin = notStu.filter(t => /（兩期同號）$/.test(t)), lost = notStu.filter(t => !/（兩期同號）$/.test(t));
    if (twin.length) warns.push(`這些女生隊號，兩期都有同學住在這棟樓，分不出是誰，請改寫 6 碼建制隊號：${twin.map(t => t.slice(1).replace("（兩期同號）", "")).join("、")}`);
    if (lost.length) warns.push(`名冊裡找不到這些號碼：${lost.map(t => t.slice(1)).join("、")}`);
    const badNums = Array.from(new Set(pItems.concat(gItems).flatMap(i => i.bad).filter(b => /^\d+$/.test(b))));
    if (badNums.length) warns.push(`號碼位數不對（可能打錯或辨識錯）：${badNums.join("、")}`);
    const guests = Array.from(new Set(pItems.flatMap(i => i.targets).filter(t => t[0] !== "?" && otherOf(t))));
    if (guests.length) {
      const byC = {}; guests.forEach(t => { (byC[otherOf(t)] = byC[otherOf(t)] || []).push(t); });
      info.push(Object.entries(byC).map(([c, ts]) => `${c} ${ts.length} 位`).join("、") + `：算在這一期（${cohort().label}）的內務統計，加扣分歸到他們自己的期別。`);
    }
    if (!hasRooms) warns.push("還沒設定寢室名單，個人分數會記下來，但要到「寢室名單與設定」設定後才能算進寢室總分。");
    else {
      const unkS = Array.from(new Set(pItems.flatMap(i => i.targets).filter(t => t[0] !== "?" && !mm.has(t) && !otherOf(t))));
      const unkR = Array.from(new Set(gItems.flatMap(i => i.targets).filter(t => !known.has(t))));
      const awayS = unkS.filter(t => placedElsewhere(t, draft.date)), noRoom = unkS.filter(t => !placedElsewhere(t, draft.date));
      if (awayS.length) warns.push(`這天外派住在別棟：${awayS.map(t => { const a = placedElsewhere(t, draft.date); return who(t) + " " + nameOf(t) + "（" + BNAME[D.buildingOf(a.room)] + " " + RL(a.room) + "）"; }).join("、")}；分數照記，但不算進這一期的寢室。`);
      if (noRoom.length) warns.push(`還沒分配寢室：${noRoom.map(t => who(t) + " " + nameOf(t)).join("、")}（虛線框）`);
      if (unkR.length) warns.push(`寢室名單裡沒有這些寢室：${unkR.map(RL).join("、")}`);
    }
    if (!draft.dateFound && !draft.dateEdited) warns.push("公告裡沒有讀到日期，先填今天，請確認檢查日期。");
    if (draft.floor && draft.floor.length) warns.push(`樓層公共區域（不屬於任何寢室，不計分）：${draft.floor.join("／")}`);
    if (draft.ignored.length) warns.push(`略過的文字：${draft.ignored.join("／")}`);
    $("dWarn").innerHTML = info.map(w => `<div class="status">${esc(w)}</div>`).join("") + warns.map(w => `<div class="status warning">${esc(w)}</div>`).join("");

    const pv = pointsPreview(), plus = pv.records.filter(r => r.kind === "加分").length, minus = pv.records.length - plus;
    const needMap = pItems.length && (!data.mapping || !data.mapping.plus && pItems.some(i => i.sign > 0) || !data.mapping.minus && pItems.some(i => i.sign < 0));
    let line = "";
    if (!data.autoPoints) line = "目前設定為不轉入加扣分，只記錄內務統計。";
    else if (!B.pointsOptions()) line = "⚠ 還沒匯入加扣分範本，這次只會記錄內務統計，不會轉入加扣分。";
    else if (needMap) line = "⚠ 還沒選好轉入加扣分要用的事蹟說明，請到「寢室名單與設定」設定；未設定的部分不會轉入。";
    else if (pv.records.length) line = `儲存後會在「加扣分」分頁新增 ${pv.records.length} 筆紀錄（加分 ${plus}、扣分 ${minus}，每筆 0.2 分）。`;
    $("dPointsLine").textContent = line;

    const same = sameDay(draft.date);
    let s = `<button type="button" id="dSaveBtn" ${draft.items.length ? "" : "disabled"}>儲存這次檢查</button>`;
    if (pendingOverwrite) {
      s = `<div style="width:100%">${esc(draft.date)} 已經有 ${same.length} 次檢查。這是同一天的另一次檢查，還是要更正其中一次？</div>
        <button type="button" id="dSaveNew">另外新增一次檢查</button>` +
        same.map((r, i) => { const n = B.countPoints(srcOf(r.id));
          return `<button type="button" class="danger" data-replace="${esc(r.id)}">取代第 ${i + 1} 次（${esc(r.inspector || "未填檢查人")}${hhmm(r.savedAt) ? "，" + hhmm(r.savedAt) + " 存" : ""}${n ? `，含加扣分 ${n} 筆` : ""}）</button>`; }).join("") +
        `<button type="button" class="secondary" id="dCancelOverwrite">取消</button>`;
    } else if (same.length) s += `<span class="note">這一天已經有 ${same.length} 次檢查，儲存時可以選擇另外新增或取代。</span>`;
    $("dSave").innerHTML = s;
  }

  // mode：undefined＝第一次按儲存；"new"＝同一天另外新增；其他字串＝要取代的那一次的編號
  async function saveDraft(mode) {
    if (!draft) return;
    const cd = cdata(), c = cohort();
    if (!mode && sameDay(draft.date).length) { pendingOverwrite = true; renderDraft(); return; }
    let id = mode && mode !== "new" ? mode : newId(draft.date);
    if (cd.reports[id] && cd.reports[id].date !== draft.date) { delete cd.reports[id]; id = newId(draft.date); }
    const insp = $("dInsp").value.trim();
    if (insp && !data.inspectors.includes(insp)) { data.inspectors.push(insp); data.inspectors.sort((a, b) => a.localeCompare(b, "zh-Hant")); }
    // 取代時保留原本的存檔時間，同一天的第幾次才不會跑掉
    const keepTime = cd.reports[id] && cd.reports[id].savedAt;
    const report = {date: draft.date, inspector: insp, raw: draft.raw, savedAt: keepTime || new Date().toISOString(), updatedAt: new Date().toISOString(),
      items: draft.items.map(({scope, item, sign, targets, notes}) => ({scope, item, sign, targets: targets.filter(t => t[0] !== "?"), notes: notes || {}}))};
    cd.reports[id] = report;
    let note = "";
    if (data.autoPoints && B.pointsOptions()) {
      const pv = D.pointsFromReport(report, c, data.mapping, stu, otherOf);
      pv.records.forEach(r => { r.src = srcOf(id); });
      const removed = B.replacePoints(srcOf(id), pv.records);
      note = pv.records.length ? `，並在「加扣分」新增 ${pv.records.length} 筆紀錄` + (removed ? `（取代原本 ${removed} 筆）` : "") : "";
      if (pv.skipped.length) note += `；${pv.skipped.length} 筆因事蹟說明未設定或查無此人沒有轉入`;
    }
    try { await flush(); } catch (e) { msg("dEntryMsg", "儲存失敗：" + e.message, "error"); return; }
    month = report.date.slice(0, 7);
    $("dRaw").value = ""; $("dInsp").value = ""; draft = null; pendingOverwrite = false; ocrReset();
    renderDraft();
    const nth = sameDay(report.date).length;
    msg("dEntryMsg", `已儲存 ${report.date} ${nth > 1 ? ` 第 ${sameDay(report.date).findIndex(r => r.id === id) + 1} 次` : ""}內務檢查${note}。`, "ok");
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
    const [from, to] = D.monthRange(month), S = D.summarize(reportsList(), makeResolver(), from, to);
    const w = [];
    if (!S.reportCount) w.push(["warning", `${D.rocMonth(month)}還沒有檢查紀錄。到「登錄公告」貼上 LINE 公告就會開始統計。`]);
    else w.push(["ok", `本月共 ${S.reportCount} 次檢查。`]);
    if (!versionsOf(cdata()).length && S.reportCount) w.push(["warning", "尚未設定寢室名單，寢室總分目前只有公區分數。"]);
    $("dStatsWarn").innerHTML = w.map(([k, t]) => `<div class="status ${k}">${esc(t)}</div>`).join("");
    const chips = (rs, pred) => {
      const list = rs.flatMap(r => r.members.map(k => { const p = (r.memberScores ? r.memberScores.get(k) : S.people.get(k)) || {score: 0, plus: 0, minus: 0}; return {k, s: p.score, p}; })).filter(x => pred(x.s, x.p));
      return list.length ? list.map(x => `<span class="d-chip">${esc(who(x.k))} ${esc(nameOf(x.k))} <b class="${tone(x.s)}">${fmt(x.s)}</b></span>`).join("") : `<span class="note">沒有</span>`;
    };
    const card = (cls, lab, rs, listLab, pred) => `<div class="d-vcard ${cls}"><div class="d-vlab">${lab}</div>` +
      (rs.length ? `<div class="d-vroom">${rs.map(r => esc(RL(r.room))).join("、")}<span class="${cls === "bad" ? "d-neg" : "d-pos"}">${fmt(rs[0].total)}</span></div>
        <div class="note">${listLab}</div><div class="d-chips">${chips(rs, pred)}</div>` : `<p class="note">資料不足，還分不出來。</p>`) + `</div>`;
    $("dVerdict").innerHTML = card("bad", "最劣寢", S.worst, "寢內負分同學", s => s < 0) + card("good", "最優寢", S.best, "寢內無負分同學（本月沒有被扣分）", (s, p) => !p.minus);
    const wS = new Set(S.worst.map(r => r.room)), bS = new Set(S.best.map(r => r.room));
    const desc = S.rooms.slice().reverse();
    $("dRoomTbl").innerHTML = `<thead><tr><th>名次</th><th>寢室</th><th class="r">室員合計</th><th class="r">公區</th><th class="r">總分</th></tr></thead><tbody>` +
      (desc.length ? desc.map((r, i) => `<tr class="${wS.has(r.room) ? "row-bad" : bS.has(r.room) ? "row-good" : ""}"><td>${i + 1}</td><td>${esc(RL(r.room))}</td><td class="r">${fmt(r.mScore)}</td><td class="r">${fmt(r.pub)}</td><td class="r ${tone(r.total)}"><b>${fmt(r.total)}</b></td></tr>`).join("")
        : `<tr><td colspan="5" class="note">設定寢室名單後，這裡會列出全部寢室。</td></tr>`) + `</tbody>`;
  }
  function monthText() {
    const [from, to] = D.monthRange(month), S = D.summarize(reportsList(), makeResolver(), from, to);
    const names = (rs, pred) => rs.flatMap(r => r.members.map(k => { const p = (r.memberScores ? r.memberScores.get(k) : S.people.get(k)) || {score: 0, plus: 0, minus: 0}; return {k, s: p.score, p}; })).filter(x => pred(x.s, x.p)).map(x => who(x.k) + nameOf(x.k) + "(" + fmt(x.s) + ")").join("、") || "無";
    const lines = [`${D.rocMonth(month)} 內務統計（共 ${S.reportCount} 次檢查）`];
    if (S.worst.length) lines.push(`最劣寢：${S.worst.map(r => RL(r.room)).join("、")}（${fmt(S.worst[0].total)}）`, `　負分同學：${names(S.worst, s => s < 0)}`);
    if (S.best.length) lines.push(`最優寢：${S.best.map(r => RL(r.room)).join("、")}（${fmt(S.best[0].total)}）`, `　無負分同學：${names(S.best, (s, p) => !p.minus)}`);
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
    if (hit) return hit.school;
    const seen = new Set(reportsList().flatMap(r => (r.items || []).filter(i => i.scope === "p").flatMap(i => i.targets)));
    const g = Array.from(seen).map(stu).find(s => s && s.name && v.includes(s.name));
    return g ? g.school : null;
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

  /* 寢室總覽、個人總覽的資料（畫面和匯出共用，依目前的排序） */
  function roomRows(E) {
    // 每一筆個人優缺點算進「檢查那天」他住的寢室（換寢、外派都照當時）
    const R = makeResolver(), names = new Set(R.roomsAt(q.to).map(r => r.room));
    E.forEach(e => { if (e.scope === "p") { const r = R.roomOf(e.target, e.date); if (r) names.add(r); } else if (R.roomsAt(e.date).some(x => x.room === e.target)) names.add(e.target); });
    const rows = Array.from(names).map(room => ({room})).map(r => {
      const pe = E.filter(e => e.scope === "p" && R.roomOf(e.target, e.date) === r.room), ge = E.filter(e => e.scope === "g" && e.target === r.room);
      const ps = pe.reduce((s, e) => s + D.pts(e), 0), gs = ge.reduce((s, e) => s + D.pts(e), 0);
      return {room: r.room, pp: pe.filter(e => e.sign > 0).length, pm: pe.filter(e => e.sign < 0).length, gp: ge.filter(e => e.sign > 0).length, gm: ge.filter(e => e.sign < 0).length, ps, gs, t: ps + gs};
    });
    const byRoom = (a, b) => a.room.localeCompare(b.room, "zh-Hant", {numeric: true});
    const k = q.rsort.k;
    return rows.sort((a, b) => (k === "room" ? byRoom(a, b) : a[k] - b[k]) * q.rsort.dir || byRoom(a, b));
  }
  const rth = (k, label, r) => `<th class="${r ? "r " : ""}d-sortable" data-rsort="${k}">${label}${q.rsort.k === k ? (q.rsort.dir > 0 ? " ▲" : " ▼") : ""}</th>`;
  function personRows(E) {
    const mm = memberMap(q.to);
        const mine = new Set((cohort().students || []).map(s => s.school));
        const guests = Array.from(new Set(E.filter(e => e.scope === "p" && !mine.has(e.target) && e.target[0] !== "?" && stu(e.target)).map(e => e.target))).map(stu);
        const pr = (cohort().students || []).concat(guests).map(s => { const l = E.filter(e => e.scope === "p" && e.target === s.school);
          const aw = !mm.get(s.school) && !otherOf(s.school) ? placedElsewhere(s.school, q.to) : null;
          return {k: s.school, f: who(s.school), name: nameOf(s.school), room: mm.get(s.school) || "", away: aw ? "外派：" + RL(aw.room) : "", plus: l.filter(e => e.sign > 0).length, minus: l.filter(e => e.sign < 0).length, s: l.reduce((a, e) => a + D.pts(e), 0)}; });
        const X = extremes(pr, ["plus", "minus", "s"]);
        const cmp = {f: (a, b) => a.f.localeCompare(b.f, "zh-Hant", {numeric: true}), name: (a, b) => a.name.localeCompare(b.name, "zh-Hant"), room: (a, b) => a.room.localeCompare(b.room, "zh-Hant", {numeric: true}),
          plus: (a, b) => a.plus - b.plus, minus: (a, b) => a.minus - b.minus, s: (a, b) => a.s - b.s}[q.sort.k];
        pr.sort((a, b) => cmp(a, b) * q.sort.dir || a.f.localeCompare(b.f, "zh-Hant", {numeric: true}));
    return pr;
  }

  function renderQuery() {
    if (!q.from) [q.from, q.to] = relMonth(0);
    $("qFrom").value = q.from; $("qTo").value = q.to;
    const R = makeResolver(), mm = R.mapAt(q.to), students = cohort().students || [];
    $("qRoom").innerHTML = `<option value="">全部（總覽）</option>` + R.roomsAt(q.to).map(r => `<option value="${esc(r.room)}" ${r.room === q.room ? "selected" : ""}>${esc(RL(r.room))}</option>`).join("");
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
      h = `<section><div class="h2-row"><h2>${esc(who(k))} ${esc(nameOf(k))}</h2><span class="note">${mm.has(k) ? esc(RL(mm.get(k))) : otherOf(k) ? esc(otherOf(k)) + "同學（不在這一期的寢室名單）" : placedElsewhere(k, q.to) ? "外派中：" + esc(BNAME[D.buildingOf(placedElsewhere(k, q.to).room)] + " " + RL(placedElsewhere(k, q.to).room)) : "未分配寢室"}・${range}</span></div>
        <div class="d-row">${stat("優點", mine.filter(e => e.sign > 0).length + " 項", "d-pos")}${stat("缺點", mine.filter(e => e.sign < 0).length + " 項", "d-neg")}${stat("分數", fmt(sc), tone(sc))}</div>
        <div class="d-tablewrap"><table class="d-table"><thead>${head}</thead><tbody>${entryRows(mine, false)}</tbody></table></div>
        ${mm.has(k) ? `<button type="button" class="secondary" data-goroom="${esc(mm.get(k))}">看${esc(RL(mm.get(k)))}的明細</button>` : ""}</section>`;
    } else if (q.room) {
      const memE = E.filter(e => e.scope === "p" && R.roomOf(e.target, e.date) === q.room);
      const members = Array.from(new Set((R.roomsAt(q.to).find(r => r.room === q.room) || {members: []}).members.concat(memE.map(e => e.target))));
      const pubE = E.filter(e => e.scope === "g" && e.target === q.room);
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
        const pr = personRows(E);
        const X = extremes(pr, ["plus", "minus", "s"]);
        const th = (k, label, r) => `<th class="${r ? "r " : ""}d-sortable" data-psort="${k}">${label}${q.sort.k === k ? (q.sort.dir > 0 ? " ▲" : " ▼") : ""}</th>`;
        h = `<section><div class="h2-row">${seg}<span class="note">${range}・${nRep} 次檢查</span>${exportBtns(q.view === "person" ? "people" : "rooms")}</div>
          <p class="note">${pr.length} 人：${pr.filter(r => r.plus).length} 人有優點、${pr.filter(r => r.minus).length} 人有缺點。點欄位名稱可以排序，點隊號看個人明細。${legend}</p>
          <div class="d-tablewrap"><table class="d-table"><thead><tr>${th("f", "隊號")}${th("name", "姓名")}${th("room", "寢室")}${th("plus", "優", 1)}${th("minus", "缺", 1)}${th("s", "分數", 1)}</tr></thead><tbody>${
            pr.map(r => `<tr><td><a href="#" data-goperson="${esc(r.k)}">${esc(r.f)}</a></td><td>${esc(r.name)}</td><td>${r.room ? esc(RL(r.room)) : r.away ? `<span class="note">${esc(r.away)}</span>` : "—"}</td><td class="r ${hlOf(X, "plus", r.plus, "good")}">${r.plus}</td><td class="r ${hlOf(X, "minus", r.minus, "bad")}">${r.minus}</td><td class="r ${tone(r.s)} ${hlOf(X, "s", r.s)}">${fmt(r.s)}</td></tr>`).join("") || `<tr><td colspan="6" class="note">這一期名冊沒有學生。</td></tr>`}</tbody></table></div></section>`;
      } else {
        const rows = roomRows(E);
        const X = rows.length ? extremes(rows, ["pp", "pm", "gp", "gm", "ps", "gs", "t"]) : {};
        const c = (k, v, kind) => rows.length ? hlOf(X, k, v, kind) : "";
        h = `<section><div class="h2-row">${seg}<span class="note">${range}・${nRep} 次檢查</span>${exportBtns(q.view === "person" ? "people" : "rooms")}</div>
          <p class="note">點欄位名稱可以排序，點寢室看明細，或在上方輸入隊號、姓名查個人。${legend}</p>
          <div class="d-tablewrap"><table class="d-table"><thead><tr>${rth("room", "寢室")}${rth("pp", "個人優", 1)}${rth("pm", "個人缺", 1)}${rth("gp", "公區優", 1)}${rth("gm", "公區缺", 1)}${rth("ps", "個人分", 1)}${rth("gs", "公區分", 1)}${rth("t", "總分", 1)}</tr></thead><tbody>${
            rows.map(r => `<tr><td><a href="#" data-goroom="${esc(r.room)}">${esc(RL(r.room))}</a></td><td class="r ${c("pp", r.pp, "good")}">${r.pp}</td><td class="r ${c("pm", r.pm, "bad")}">${r.pm}</td><td class="r ${c("gp", r.gp, "good")}">${r.gp}</td><td class="r ${c("gm", r.gm, "bad")}">${r.gm}</td><td class="r ${tone(r.ps)} ${c("ps", r.ps)}">${fmt(r.ps)}</td><td class="r ${tone(r.gs)} ${c("gs", r.gs)}">${fmt(r.gs)}</td><td class="r ${tone(r.t)} ${c("t", r.t)}"><b>${fmt(r.t)}</b></td></tr>`).join("") || `<tr><td colspan="8" class="note">先到「寢室名單與設定」設定寢室名單。</td></tr>`}</tbody></table></div></section>`;
      }
    }
    $("qOut").innerHTML = h;
  }

  /* ═════ 寢室名單與設定 ═════ */
  const fromLabel = f => f ? (+f.slice(5, 7)) + "/" + (+f.slice(8, 10)) + " 起" : "一開始起";
  const fromLong = f => f ? f.replace(/-/g, "/") + " 起" : "一開始起（之前所有檢查都用這份）";
  // 目前畫面上顯示的那一份名單（沒有指定就是今天適用的）
  function shownVersion() {
    const cd = cdata(), vs = versionsOf(cd);
    return (roomsView !== null && vs.find(v => v.from === roomsView)) || versionAt(cd, D.todayStr());
  }
  function renderRooms() {
    const cd = cdata();
    $("dBuilding").value = curBuilding();
    if (!roomsEditing && document.activeElement !== $("dRoomsText")) { const v = shownVersion(); $("dRoomsText").value = v ? v.text : (cd.roomsText || ""); }
    renderRoomVersions();
    renderRoomsLock();
    roomsInfo();
    $("dAuto").checked = !!data.autoPoints;
    const opts = B.pointsOptions();
    if (!opts) { $("dMapping").innerHTML = `<div class="status warning">還沒匯入加扣分範本。請先到「名冊」匯入，才能選擇事蹟說明。</div>`; return; }
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
  // 換這一期住的棟：已存的名單和檢查紀錄裡的寢室一起改（5-3 ↔ 樂5-3），兩邊才對得上
  async function changeBuilding(sel) {
    const cd = cdata(), nb = sel.value, ob = curBuilding();
    if (nb === ob) return;
    const rk = key => /^[^\d]?\d{1,2}-\d{1,2}$/.test(key) ? (nb === "育" ? "" : nb) + key.replace(/^[^\d]/, "") : key;
    const vs = versionsOf(cd), hasG = reportsList().some(r => (r.items || []).some(i => i.scope === "g" && i.targets.length));
    if ((vs.length || hasG) && !confirm(`要把「${cohort().label}」改成住${BNAME[nb]}嗎？\n已存的寢室名單和檢查紀錄裡的寢室會一起改（例如 ${RL(ob === "育" ? "5-3" : ob + "5-3")} → ${RL(rk("5-3"))}）。`)) { sel.value = ob; return; }
    cd.building = nb;
    if (vs.length) cd.roomsHistory = vs.map(v => ({from: v.from, text: v.text, rooms: v.rooms.map(r => ({room: rk(r.room), members: r.members}))}));
    Object.values(cd.reports).forEach(r => (r.items || []).forEach(i => {
      if (i.scope !== "g") return;
      i.targets = i.targets.map(rk);
      if (i.notes) i.notes = Object.fromEntries(Object.entries(i.notes).map(([k, v]) => [rk(k), v]));
    }));
    const cur = versionAt(cd, D.todayStr());
    if (cur) { cd.roomsText = cur.text; cd.rooms = cur.rooms; }
    try { await flush(); } catch (err) { alert("儲存失敗：" + err.message); }
    renderRooms();
  }
  function renderRoomVersions() {
    const vs = versionsOf(cdata()), cur = versionAt(cdata(), D.todayStr()), shown = shownVersion();
    $("dRoomsVers").innerHTML = vs.length ? `<span class="note">名單版本：</span>` + vs.map(v =>
      `<button type="button" class="d-pick${shown && v.from === shown.from ? " on" : ""}" data-roomsver="${esc(v.from)}">${esc(fromLabel(v.from))}${cur && v.from === cur.from ? "（目前）" : ""}</button>`).join("") : "";
  }
  // 寢室名單存過之後鎖住，避免不小心改到；要改時選「修改這份名單」或「從某天起用新名單」
  function renderRoomsLock() {
    const cd = cdata(), vs = versionsOf(cd), saved = vs.length > 0, locked = saved && !roomsEditing, ta = $("dRoomsText");
    ta.readOnly = locked;
    ta.classList.toggle("d-locked", locked);
    const shown = shownVersion(), cur = versionAt(cd, D.todayStr());
    if (locked) {
      $("dRoomsBtns").innerHTML = `<span class="note">正在看：${esc(fromLong(shown.from))}的名單${cur && shown.from === cur.from ? "（今天適用）" : ""}，已鎖定。</span>
        <button type="button" class="secondary" id="dRoomsEdit">修改這份名單</button>
        <button type="button" class="secondary" id="dRoomsNew">換寢／外派：從某天起用新名單</button>` +
        (vs.length > 1 ? `<button type="button" class="danger d-small" id="dRoomsDelVer">刪除這份</button>` : "");
      return;
    }
    const first = !saved, fromVal = roomsEditing === "new" ? D.todayStr() : (roomsEditFrom || "");
    $("dRoomsBtns").innerHTML = `<label class="d-inline">這份名單從 <input type="date" id="dRoomsFrom" value="${esc(fromVal)}"> 起使用</label>
      <span class="note">${first || !fromVal ? "日期留白＝之前所有檢查都用這份。" : "這一天以前的檢查仍照舊名單算。"}</span>
      <button type="button" id="dRoomsSave">儲存寢室名單</button>` + (saved ? `<button type="button" class="secondary" id="dRoomsCancel">取消</button>` : "");
  }
  function roomsInfo() {
    const {rooms, issues} = D.parseRooms($("dRoomsText").value, index().norm, curBuilding());
    const shown = shownVersion(), date = roomsEditing ? ($("dRoomsFrom") && $("dRoomsFrom").value) || D.todayStr() : (shown && shown.from) || D.todayStr();
    const students = cohort().students || [], assigned = new Set(rooms.flatMap(r => r.members));
    // 外派：寫在別期（別棟）名單裡的本期同學；原本寢室的名單不用刪，那段期間自動不算在這裡
    const away = students.map(s => ({s, a: placedElsewhere(s.school, date)})).filter(x => x.a);
    const awaySet = new Set(away.map(x => x.s.school));
    const left = students.filter(s => !assigned.has(s.school) && !awaySet.has(s.school));
    const guests = rooms.flatMap(r => r.members.filter(k => otherOf(k)).map(k => ({k, room: r.room})));
    $("dRoomCount").textContent = rooms.length + " 間寢室・" + BNAME[curBuilding()];
    let h = issues.length ? `<div class="status warning">${issues.map(esc).join("<br>")}</div>` : "";
    if (students.length) h += `<div class="status ${left.length ? "warning" : "ok"}">名冊 ${students.length} 人，已分配寢室 ${students.length - left.length - away.length} 人${away.length ? `，外派 ${away.length} 人` : ""}${left.length ? `，還有 ${left.length} 人沒分配：${left.slice(0, 30).map(s => esc((s.female || s.team) + s.name)).join("、")}${left.length > 30 ? "…" : ""}` : ""}。</div>`;
    if (away.length) h += `<div class="status">外派中（住在別棟，這段期間不算在本期寢室）：${away.map(x => esc(x.s.team + " " + x.s.name) + " → " + esc(BNAME[D.buildingOf(x.a.room)] + " " + RL(x.a.room)) + `<span class="note">（${esc(x.a.cohort.label)}名單，${esc(fromLabel(x.a.from))}）</span>`).join("、")}</div>`;
    if (guests.length) h += `<div class="status">外派來住的別期同學：${guests.map(x => esc(who(x.k) + " " + nameOf(x.k)) + " 在 " + esc(RL(x.room))).join("、")}</div>`;
    $("dRoomsInfo").innerHTML = h;
  }

  /* ═════ 檢查紀錄 ═════ */
  function renderHistory() {
    const list = reportsList().reverse(), c = cohort();
    $("dHistory").innerHTML = list.length ? list.map(r => {
      const n = (r.items || []).reduce((s, i) => s + i.targets.length, 0), inPts = B.countPoints(srcOf(r.id));
      return `<div class="d-rep"><div class="d-row" style="justify-content:space-between"><div><b>${esc(r.date)}</b> ${nthLabel(r) ? `<b>${nthLabel(r)}</b>` : ""} <span class="note">${n} 筆優缺點${inPts ? `・加扣分預覽表 ${inPts} 筆` : ""}</span></div>
        <div class="d-row"><label class="d-inline note">檢查人 <input type="text" list="dInspList" data-insp="${esc(r.id)}" value="${esc(r.inspector || "")}" placeholder="未填"></label>
        <button type="button" class="danger d-small" data-del="${esc(r.id)}">刪除</button></div></div>
        <details><summary class="note">原始公告</summary><pre class="d-raw">${esc(r.raw || "")}</pre></details></div>`;
    }).join("") : `<p class="note">還沒有紀錄。</p>`;
    $("dInspList").innerHTML = data.inspectors.map(n => `<option value="${esc(n)}"></option>`).join("");
  }

  /** 匯入舊的內務備份檔／線上版內務統計匯出檔（放進目前選的期別）。由「備份」分頁呼叫。 */
  async function importDormFile(d) {
    if (!cohort()) throw new Error("請先到「名冊」匯入名冊並選擇目前期別。");
    if (!d || !Array.isArray(d.reports)) throw new Error("這不是內務資料檔。");
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
      const key = r.id || r.date;
      if (cd.reports[key]) replaced++; else added++;
      cd.reports[key] = {date: r.date, inspector: r.inspector || "", raw: r.raw || "", savedAt: r.savedAt || new Date().toISOString(), items};
    }
    if (Array.isArray(d.rooms) && d.rooms.length) {
      const text = d.rooms.map(r => r.room + " " + r.members.join(" ")).join("\n");
      setRoomsVersion(cd, "", text, D.parseRooms(text, norm, buildingOfCohort(cd)).rooms);
      roomsEditing = false; roomsView = null;
    }
    (d.inspectors || []).forEach(n => { if (n && !data.inspectors.includes(n)) data.inspectors.push(n); });
    await flush(); render();
    return {warn: miss.size > 0, message: `已把內務資料匯入「${cohort().label}」：${added + replaced} 次檢查（新增 ${added}、取代 ${replaced}）` + (d.rooms && d.rooms.length ? `和 ${d.rooms.length} 間寢室名單` : "") + "。這些舊紀錄不會轉入加扣分。" + (miss.size ? `名冊找不到的號碼已略過：${Array.from(miss).slice(0, 20).join("、")}` : "")};
  }

  /* ═════ 從圖片辨識（js/ocr.js） ═════ */
  let ocrBusy = false, ocrUrl = null;
  function ocrReset() {
    if (ocrUrl) { URL.revokeObjectURL(ocrUrl); ocrUrl = null; }
    if ($("dOcrPreview")) { $("dOcrPreview").hidden = true; $("dOcrImg").removeAttribute("src"); $("dOcrMsg").textContent = ""; }
  }
  async function runOcr(file) {
    if (!file || ocrBusy) return;
    const m = $("dOcrMsg"), btn = $("dOcrBtn");
    if (!window.DormOCR) { m.textContent = "辨識元件沒有載入，請重新整理後再試。"; return; }
    if (!/^image\//.test(file.type || "image/")) { m.textContent = "請選擇圖片檔。"; return; }
    if ($("dRaw").value.trim() && !confirm("公告框裡已經有文字，要換成圖片辨識的結果嗎？")) return;
    ocrBusy = true; btn.classList.add("busy"); m.textContent = "準備辨識…";
    if (ocrUrl) URL.revokeObjectURL(ocrUrl);
    ocrUrl = URL.createObjectURL(file); $("dOcrImg").src = ocrUrl; $("dOcrPreview").hidden = false; $("dOcrPreview").open = true;
    const t0 = Date.now(), norm = index().norm;
    // 用名冊檢查辨識出來的號碼：對得上的越多、看不懂的越少，就是越好的辨識結果
    const score = text => {
      const p = D.parseReport(text, norm, undefined, curBuilding()), t = p.items.flatMap(i => i.targets), known = t.filter(k => k[0] !== "?").length;
      // 「未註明項目」通常代表某一行沒接上，整行的分數可能算錯，扣分加重
      const orphan = p.items.filter(i => i.item === "未註明項目").reduce((n, i) => n + i.targets.length, 0);
      return {known, problems: t.length - known + p.items.reduce((n, i) => n + i.bad.length, 0) + orphan * 3};
    };
    try {
      const text = await window.DormOCR.recognize(file, score, (s, p) => { m.textContent = s + (p > 0 && p < 1 ? " " + Math.round(p * 100) + "%" : ""); });
      if (!text.trim()) throw new Error("圖片裡沒有讀到文字");
      $("dRaw").value = text;
      $("dRaw").dispatchEvent(new Event("input", {bubbles: true}));
      m.textContent = `辨識完成（${Math.max(1, Math.round((Date.now() - t0) / 1000))} 秒）。請對照圖片核對下方的辨識結果，再儲存。`;
    } catch (e) {
      m.textContent = "辨識失敗：" + (e && e.message ? e.message : e) + "。可以改用手機或電腦內建的文字辨識（見下方「公告是圖片？」）。";
    } finally { ocrBusy = false; btn.classList.remove("busy"); }
  }

  // 複製公告框內容（和加扣分「輸入學生」旁的複製鍵一樣，方便貼到 LINE）
  let copyTimer = null;
  async function copyRaw(btn) {
    const text = $("dRaw").value.split("\n").map(l => l.replace(/[ \t\u3000]+$/, "")).join("\n").trim();
    let ok = false;
    if (text) {
      try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; } } catch (e) { ok = false; }
      if (!ok) {
        const tmp = document.createElement("textarea");
        tmp.value = text; tmp.setAttribute("readonly", ""); tmp.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
        document.body.appendChild(tmp); tmp.select(); tmp.setSelectionRange(0, text.length);
        try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
        tmp.remove();
      }
    }
    clearTimeout(copyTimer);
    btn.textContent = !text ? "沒有內容" : ok ? "已複製 ✓" : "無法複製";
    btn.classList.toggle("done", ok);
    copyTimer = setTimeout(() => { btn.textContent = "複製"; btn.classList.remove("done"); }, 1800);
  }

  /* ═════ 匯出報表（Excel／PDF） ═════ */
  const exportBtns = kind => `<span class="d-export"><button type="button" class="secondary d-small" data-export="${kind}" data-fmt="xlsx">匯出 Excel</button><button type="button" class="secondary d-small" data-export="${kind}" data-fmt="pdf">PDF／列印</button></span>`;
  const num = t => Math.round(t) / 10;   // 0.1 分為單位 → 分數
  function buildReport(kind) {
    const c = cohort(), stamp = D.todayStr();
    if (kind === "month") {
      const [from, to] = D.monthRange(month), S = D.summarize(reportsList(), makeResolver(), from, to);
      const names = (rs, pred) => rs.flatMap(r => r.members.map(k => { const p = (r.memberScores ? r.memberScores.get(k) : S.people.get(k)) || {score: 0, plus: 0, minus: 0}; return {k, s: p.score, p}; })).filter(x => pred(x.s, x.p)).map(x => who(x.k) + " " + nameOf(x.k) + "（" + fmt(x.s) + "）").join("、") || "無";
      const summary = [];
      if (S.worst.length) summary.push("最劣寢：" + S.worst.map(r => RL(r.room)).join("、") + "（" + fmt(S.worst[0].total) + "）", "　負分同學：" + names(S.worst, v => v < 0));
      if (S.best.length) summary.push("最優寢：" + S.best.map(r => RL(r.room)).join("、") + "（" + fmt(S.best[0].total) + "）", "　無負分同學：" + names(S.best, (v, p) => !p.minus));
      return {title: D.rocMonth(month) + " 內務統計", subtitle: c.label + "・共 " + S.reportCount + " 次檢查・" + from + " 至 " + to, summary, sheet: "月統計",
        columns: ["名次", "寢室", "室員合計", "公區", "總分"], numFrom: 2,
        rows: S.rooms.slice().reverse().map((r, i) => [i + 1, RL(r.room), num(r.mScore), num(r.pub), num(r.total)]),
        file: "內務月統計_" + D.rocMonth(month)};
    }
    if (kind === "rooms" || kind === "people") {
      if (!q.from) [q.from, q.to] = relMonth(0);
      const E = D.entries(reportsList(), q.from, q.to), nRep = new Set(E.map(e => e.date)).size;
      const sub = c.label + "・" + q.from + " 至 " + q.to + "・" + nRep + " 次檢查";
      if (kind === "rooms") return {title: "寢室總覽", subtitle: sub, summary: [], sheet: "寢室總覽", numFrom: 1,
        columns: ["寢室", "個人優", "個人缺", "公區優", "公區缺", "個人分", "公區分", "總分"],
        rows: roomRows(E).map(r => [RL(r.room), r.pp, r.pm, r.gp, r.gm, num(r.ps), num(r.gs), num(r.t)]), file: "寢室總覽_" + q.from + "_" + q.to};
      return {title: "個人總覽", subtitle: sub, summary: [], sheet: "個人總覽", numFrom: 4,
        columns: ["女生隊號", "建制隊號", "姓名", "寢室", "優", "缺", "分數"],
        rows: personRows(E).map(r => { const s = stu(r.k) || {}, o = otherOf(r.k); return [o ? "" : s.female || "", s.team || "", r.name, r.room ? RL(r.room) : r.away, r.plus, r.minus, num(r.s)]; }),
        file: "個人總覽_" + q.from + "_" + q.to};
    }
    // 檢查紀錄：跟畫面一樣，一次檢查一列（新的在上），附原始公告
    const list = reportsList().reverse();
    const cards = list.map(r => ({date: r.date, nth: nthLabel(r) || "", inspector: r.inspector || "",
      n: (r.items || []).reduce((s, i) => s + i.targets.length, 0), pts: B.countPoints(srcOf(r.id)), raw: r.raw || ""}));
    const dates = list.map(r => r.date).sort();
    return {title: "已登錄的檢查", subtitle: c.label + "・共 " + list.length + " 次檢查" + (dates.length ? "・" + dates[0] + " 至 " + dates[dates.length - 1] : ""), summary: [], sheet: "檢查紀錄", numFrom: 99,
      columns: ["日期", "第幾次", "檢查人", "優缺點筆數", "加扣分預覽表筆數", "原始公告"],
      rows: cards.flatMap(x => (x.raw.trim() ? x.raw.trim().split(/\r?\n/) : [""]).map((l, i) => i ? ["", "", "", "", "", l] : [x.date, x.nth, x.inspector || "未填", x.n, x.pts, l])),
      groups: cards.map(x => x.raw.trim() ? x.raw.trim().split(/\r?\n/).length : 1), cards, wrapCol: 5, file: "內務檢查紀錄_" + stamp};
  }
  function exportReport(kind, fmtType) {
    if (!cohort()) return;
    const rep = buildReport(kind);
    lastRep = rep;
    if (fmtType === "xlsx") {
      const XL = window.XLSX;
      if (!XL) { alert("Excel 元件沒有載入，請重新整理後再試。"); return; }
      const aoa = [[rep.title], [rep.subtitle]].concat(rep.summary.map(x => [x]), [[]], [rep.columns], rep.rows);
      const ws = XL.utils.aoa_to_sheet(aoa);
      ws["!cols"] = rep.columns.map((col, i) => ({wch: Math.max(6, col.length * 2 + 2, ...rep.rows.slice(0, 300).map(r => String(r[i] == null ? "" : r[i]).length * (typeof r[i] === "number" ? 1 : 2)))}));
      // 分數欄顯示一位小數、正數加「+」
      rep.rows.forEach((row, ri) => row.forEach((v, ci) => {
        if (typeof v !== "number" || ci < rep.numFrom || !/分$|^分數$|^室員合計$|^公區$/.test(rep.columns[ci])) return;
        const cell = ws[XL.utils.encode_cell({r: ri + aoa.length - rep.rows.length, c: ci})]; if (cell) cell.z = "+0.0;-0.0;0.0";
      }));
      if (rep.groups) {   // 一次檢查佔數列：原始公告一行一列，前面欄位合併
        ws["!cols"][rep.wrapCol] = {wch: Math.min(80, Math.max(30, ...rep.rows.map(r => String(r[rep.wrapCol]).length * 2)))};
        ws["!merges"] = [];
        let r0 = aoa.length - rep.rows.length;
        rep.groups.forEach(g => {
          if (g > 1) for (let ci = 0; ci < rep.wrapCol; ci++) ws["!merges"].push({s: {r: r0, c: ci}, e: {r: r0 + g - 1, c: ci}});
          r0 += g;
        });
      }
      const wb = XL.utils.book_new(); XL.utils.book_append_sheet(wb, ws, rep.sheet);
      B.download(new Uint8Array(XL.write(wb, {type: "array", bookType: "xlsx"})), rep.file + ".xlsx");
      return;
    }
    // PDF：開啟列印，選「另存為 PDF」
    let el = $("dPrint");
    if (!el) { el = document.createElement("div"); el.id = "dPrint"; document.body.append(el); }
    const isScore = i => i >= rep.numFrom && /分$|^分數$|^室員合計$|^公區$/.test(rep.columns[i]);
    const cell = (v, i) => typeof v === "number" ? (isScore(i) ? (v > 0 ? "+" : "") + v.toFixed(1) : String(v)) : esc(v);
    el.innerHTML = `<h1>${esc(rep.title)}</h1><p class="sub">${esc(rep.subtitle)}・列印日期 ${D.todayStr()}</p>` +
      rep.summary.map(x => `<p>${esc(x)}</p>`).join("") + (rep.cards ? (rep.cards.map(x =>
        `<div class="pr-rep"><div class="pr-head"><div><b class="pr-date">${esc(x.date)}</b>${x.nth ? ` <b>${esc(x.nth)}</b>` : ""} <span class="pr-note">${x.n} 筆優缺點${x.pts ? `・加扣分預覽表 ${x.pts} 筆` : ""}</span></div>` +
        `<div class="pr-insp">檢查人　<span class="${x.inspector ? "" : "pr-empty"}">${esc(x.inspector || "未填")}</span></div></div>` +
        `<div class="pr-note">原始公告</div><pre class="pr-raw">${esc(x.raw)}</pre></div>`).join("") || "<p>還沒有紀錄。</p>") :
      `<table><thead><tr>${rep.columns.map((col, i) => `<th class="${i >= rep.numFrom ? "r" : ""}">${esc(col)}</th>`).join("")}</tr></thead><tbody>` +
      (rep.rows.map(r => `<tr>${r.map((v, i) => `<td class="${i >= rep.numFrom ? "r" : ""}">${cell(v, i)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${rep.columns.length}">沒有資料</td></tr>`) +
      `</tbody></table>`);
    // 手機／平板：先全螢幕預覽，再由預覽上的按鈕直接開列印（iPhone Safari 只允許「點按當下」開列印）
    const touch = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (touch) { showPrintPreview(); return; }
    printNow();
  }
  function printNow() {
    if ($("dPrint")) $("dPrint").scrollTop = 0;
    document.body.classList.add("d-printing");
    const done = () => { document.body.classList.remove("d-printing"); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    try { window.print(); } catch (e) { done(); alert("這個瀏覽器無法列印，請改用 Safari 或 Chrome 開啟。"); return; }
    setTimeout(done, 1500);
  }
  function showPrintPreview() {
    let bar = $("dPrintBar");
    if (!bar) {
      bar = document.createElement("div"); bar.id = "dPrintBar";
      bar.innerHTML = `<div class="d-pbar-row"><button type="button" id="dPdfSave" disabled>PDF 準備中…</button><button type="button" id="dPrintGo" class="secondary">列印</button><button type="button" id="dPrintClose" class="secondary">關閉</button></div>` +
        `<p class="d-pbar-note">按「儲存 PDF 檔」→ 選「儲存到檔案」，或直接傳到 LINE。</p>`;
      document.body.append(bar);
      $("dPdfSave").addEventListener("click", savePdf);
      $("dPrintGo").addEventListener("click", printNow);
      $("dPrintClose").addEventListener("click", () => { document.body.classList.remove("d-previewing"); window.scrollTo(0, previewScroll); });
    }
    // 從主畫面開的 App（iPhone）不能列印，只留「儲存 PDF 檔」
    $("dPrintGo").hidden = navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);
    previewScroll = window.scrollY;
    document.body.classList.add("d-previewing");
    $("dPrint").scrollTop = 0;
    const btn = $("dPdfSave"), rep = lastRep, job = ++pdfJob;
    pdfBytes = null; btn.disabled = true; btn.textContent = "PDF 準備中…";
    setTimeout(() => {
      if (job !== pdfJob) return;
      try { pdfBytes = reportToPdf(rep); btn.textContent = "儲存 PDF 檔"; btn.disabled = false; }
      catch (e) { console.warn(e); btn.textContent = "PDF 產生失敗"; }
    }, 60);
  }
  let previewScroll = 0, lastRep = null, pdfBytes = null, pdfJob = 0;
  /** 儲存 PDF：手機用分享選單（可存到「檔案」或傳 LINE），不支援時改成下載 */
  function savePdf() {
    if (!pdfBytes || !lastRep) return;
    const name = lastRep.file + ".pdf";
    try {
      const file = new File([pdfBytes], name, {type: "application/pdf"});
      if (navigator.canShare && navigator.canShare({files: [file]})) { navigator.share({files: [file], title: lastRep.title}).catch(() => {}); return; }
    } catch (e) { /* 改用下載 */ }
    B.download(pdfBytes, name);
  }

  /* ═════ 直接產生 PDF 檔（畫成 A4 圖片再包成 PDF；從主畫面開的 App 也能用） ═════ */
  const PDF_FONT = '-apple-system,"PingFang TC","Heiti TC","Microsoft JhengHei","Noto Sans TC","Noto Sans CJK TC",sans-serif';
  function reportToPdf(rep) {
    const S = 2, PW = 794, PH = 1123, M = 45, AW = PW - 2 * M, jpgs = [];
    const cv = document.createElement("canvas"); cv.width = PW * S; cv.height = PH * S;
    const ctx = cv.getContext("2d"); ctx.scale(S, S); ctx.textBaseline = "top";
    let y = M, pageNo = 0, open = false;
    const font = (px, bold) => (bold ? "bold " : "") + px + "px " + PDF_FONT;
    const finishPage = () => {
      ctx.fillStyle = "#888"; ctx.font = font(11); const f = "第 " + pageNo + " 頁";
      ctx.fillText(f, PW / 2 - ctx.measureText(f).width / 2, PH - M + 14);
      const b64 = cv.toDataURL("image/jpeg", 0.88).split(",")[1], bin = atob(b64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      jpgs.push(u); open = false;
    };
    const newPage = () => { if (open) finishPage(); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, PW, PH); y = M; pageNo++; open = true; };
    const wrap = (text, width, f) => {
      ctx.font = f; const out = [];
      String(text == null ? "" : text).split("\n").forEach(par => {
        let line = "";
        for (const ch of Array.from(par)) {
          if (line && ctx.measureText(line + ch).width > width) { out.push(line); line = ch; } else line += ch;
        }
        out.push(line);
      });
      return out;
    };
    const rr = (x, y0, w, h, r) => { ctx.beginPath(); ctx.moveTo(x + r, y0); ctx.arcTo(x + w, y0, x + w, y0 + h, r); ctx.arcTo(x + w, y0 + h, x, y0 + h, r); ctx.arcTo(x, y0 + h, x, y0, r); ctx.arcTo(x, y0, x + w, y0, r); ctx.closePath(); };
    const text = (t, x, yy, f, color) => { ctx.font = f; ctx.fillStyle = color || "#000"; ctx.fillText(t, x, yy); };

    newPage();
    text(rep.title, M, y, font(21, true)); y += 32;
    wrap(rep.subtitle + "・列印日期 " + D.todayStr(), AW, font(12)).forEach(l => { text(l, M, y, font(12), "#444"); y += 17; });
    y += 6;
    rep.summary.forEach(s => wrap(s, AW, font(13)).forEach(l => { if (y + 19 > PH - M) newPage(); text(l, M, y, font(13)); y += 19; }));
    if (rep.summary.length) y += 8;

    if (rep.cards) {
      if (!rep.cards.length) text("還沒有紀錄。", M, y, font(13));
      const lh = 19;
      rep.cards.forEach(c => {
        const raw = wrap(c.raw || "", AW - 20, font(13));
        if (y + 30 + 20 + Math.min(raw.length, 3) * lh + 16 > PH - M) newPage();
        ctx.strokeStyle = "#d5dbe5"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(M, y + 0.5); ctx.lineTo(M + AW, y + 0.5); ctx.stroke();
        y += 10;
        text(c.date, M, y, font(16, true));
        let x = M + ctx.measureText(c.date).width + 8;
        if (c.nth) { text(c.nth, x, y + 2, font(14, true)); x += ctx.measureText(c.nth).width + 8; }
        text(c.n + " 筆優缺點" + (c.pts ? "・加扣分預覽表 " + c.pts + " 筆" : ""), x, y + 4, font(12), "#5b6475");
        const insp = c.inspector || "未填"; ctx.font = font(13, !!c.inspector);
        const iw = Math.max(ctx.measureText(insp).width + 22, 76), bx = M + AW - iw;
        ctx.strokeStyle = "#c8cfdb"; rr(bx, y - 3, iw, 24, 5); ctx.stroke();
        text(insp, bx + 11, y + 2, font(13, !!c.inspector), c.inspector ? "#000" : "#999");
        ctx.font = font(12); text("檢查人", bx - ctx.measureText("檢查人").width - 8, y + 3, font(12), "#5b6475");
        y += 30;
        text("原始公告", M, y, font(12), "#5b6475"); y += 20;
        let i = 0;
        while (i < raw.length) {
          const room = Math.floor((PH - M - y - 16) / lh);
          if (room < 1) { newPage(); continue; }
          const part = raw.slice(i, i + room), h = part.length * lh + 16;
          ctx.fillStyle = "#eef2f9"; rr(M, y, AW, h, 6); ctx.fill();
          part.forEach((l, k) => text(l, M + 10, y + 8 + k * lh, font(13)));
          y += h; i += part.length;
          if (i < raw.length) newPage();
        }
        y += 14;
      });
    } else {
      const cols = rep.columns, hf = font(12, true), bf = font(12), padX = 6, padY = 5, lh = 17;
      const isScore = i => i >= rep.numFrom && /分$|^分數$|^室員合計$|^公區$/.test(cols[i]);
      const txt = (v, i) => typeof v === "number" ? (isScore(i) ? (v > 0 ? "+" : "") + v.toFixed(1) : String(v)) : String(v == null ? "" : v);
      const rows = rep.rows.map(r => r.map(txt));
      ctx.font = hf; const nat = cols.map(c => ctx.measureText(c).width);
      ctx.font = bf; rows.forEach(r => r.forEach((t, i) => { nat[i] = Math.max(nat[i], ctx.measureText(t).width); }));
      let w = nat.map(n => Math.ceil(n) + padX * 2), total = w.reduce((a, b) => a + b, 0);
      if (total <= AW) { const extra = (AW - total) / w.length; w = w.map(v => v + extra); }
      else {
        while (total > AW + 0.5) { const i = w.indexOf(Math.max(...w)), cut = Math.min(total - AW, w[i] - 60); if (cut <= 0) break; w[i] -= cut; total -= cut; }
        if (total > AW) w = w.map(v => v * AW / total);
      }
      const lines = (cells, f) => cells.map((t, i) => wrap(t, w[i] - padX * 2, f));
      const head = lines(cols, hf);
      const drawRow = (ls, isHead) => {
        const h = Math.max(...ls.map(l => l.length)) * lh + padY * 2;
        if (!isHead && y + h > PH - M) { newPage(); drawRow(head, true); }
        if (isHead) { ctx.fillStyle = "#e8edf4"; ctx.fillRect(M, y, AW, h); }
        let x = M;
        ls.forEach((cell, i) => {
          const f = isHead ? hf : bf; ctx.font = f;
          cell.forEach((l, k) => { const tx = i >= rep.numFrom ? x + w[i] - padX - ctx.measureText(l).width : x + padX; text(l, tx, y + padY + k * lh, f); });
          ctx.strokeStyle = "#999"; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w[i], h);
          x += w[i];
        });
        y += h;
      };
      drawRow(head, true);
      if (!rows.length) { ctx.strokeStyle = "#999"; ctx.strokeRect(M + 0.5, y + 0.5, AW, 27); text("沒有資料", M + padX, y + padY, bf); y += 27; }
      rows.forEach(r => drawRow(lines(r, bf), false));
    }
    finishPage();
    cv.width = cv.height = 0;
    return buildPdf(jpgs, PW * S, PH * S);
  }
  function buildPdf(jpgs, iw, ih) {
    const enc = new TextEncoder(), parts = [], offs = [];
    let len = 0;
    const push = b => { const u = typeof b === "string" ? enc.encode(b) : b; parts.push(u); len += u.length; };
    const obj = (id, body) => { offs[id] = len; push(id + " 0 obj\n"); body(); push("\nendobj\n"); };
    push("%PDF-1.4\n");
    const n = jpgs.length, kids = jpgs.map((_, i) => (3 + i * 3) + " 0 R").join(" ");
    obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
    obj(2, () => push("<< /Type /Pages /Kids [" + kids + "] /Count " + n + " >>"));
    jpgs.forEach((jpg, i) => {
      const p = 3 + i * 3, cs = "q 595.28 0 0 841.89 0 0 cm /Im0 Do Q";
      obj(p, () => push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 " + (p + 2) + " 0 R >> >> /Contents " + (p + 1) + " 0 R >>"));
      obj(p + 1, () => push("<< /Length " + cs.length + " >>\nstream\n" + cs + "\nendstream"));
      obj(p + 2, () => { push("<< /Type /XObject /Subtype /Image /Width " + iw + " /Height " + ih + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + jpg.length + " >>\nstream\n"); push(jpg); push("\nendstream"); });
    });
    const total = 3 + n * 3, xref = len;
    push("xref\n0 " + total + "\n0000000000 65535 f \n" + offs.slice(1, total).map(o => String(o).padStart(10, "0") + " 00000 n \n").join(""));
    push("trailer\n<< /Size " + total + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");
    const out = new Uint8Array(len); let o = 0;
    parts.forEach(u => { out.set(u, o); o += u.length; });
    return out;
  }

  /* ═════ 事件 ═════ */
  function bind() {
    const root = $("tab-dorm");
    root.addEventListener("click", async e => {
      const t = e.target;
      const sb = t.closest("[data-sub]"); if (sb) { showSub(sb.dataset.sub); return; }
      const pi = t.closest("[data-pickinsp]"); if (pi) { $("dInsp").value = pi.dataset.pickinsp; renderDraft(); return; }
      const f = t.closest("[data-flip]"); if (f && draft) { const it = draft.items[+f.dataset.flip]; it.sign *= -1; renderDraft(); return; }
      if (t.id === "dRawCopy") { copyRaw(t); return; }
      if (t.id === "dRawClear") { if (window.clearInput) window.clearInput($("dRaw"), t); return; }
      if (t.id === "dRawPaste") { if (window.pasteInto) window.pasteInto($("dRaw"), t); return; }
      if (t.id === "dSaveBtn") return saveDraft(false);
      if (t.id === "dSaveNew") return saveDraft("new");
      const rp = t.closest("[data-replace]"); if (rp) return saveDraft(rp.dataset.replace);
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
      const rs = t.closest("[data-rsort]"); if (rs) { const k = rs.dataset.rsort; q.rsort = q.rsort.k === k ? {k, dir: -q.rsort.dir} : {k, dir: k === "room" ? 1 : -1}; renderQuery(); return; }
      const ex = t.closest("[data-export]"); if (ex) { exportReport(ex.dataset.export, ex.dataset.fmt); return; }
      const so = t.closest("[data-psort]"); if (so) { const k = so.dataset.psort; q.sort = q.sort.k === k ? {k, dir: -q.sort.dir} : {k, dir: ["s", "plus", "minus"].includes(k) ? -1 : 1}; renderQuery(); return; }
      const gr = t.closest("[data-goroom]"); if (gr) { e.preventDefault(); q.room = gr.dataset.goroom; q.person = ""; $("qPerson").value = ""; renderQuery(); window.scrollTo({top: 0}); return; }
      const gp = t.closest("[data-goperson]"); if (gp) { e.preventDefault(); const k = gp.dataset.goperson; q.person = who(k); $("qPerson").value = who(k) + " " + nameOf(k); renderQuery(); window.scrollTo({top: 0}); return; }
      const rv = t.closest("[data-roomsver]");
      if (rv) { if (roomsEditing) return; roomsView = rv.dataset.roomsver; renderRooms(); return; }
      if (t.id === "dRoomsSave") {
        const text = $("dRoomsText").value, cd = cdata(), from = ($("dRoomsFrom") && $("dRoomsFrom").value) || "";
        const exists = versionsOf(cd).some(v => v.from === from);
        if (exists && from !== roomsEditFrom && !confirm(`已經有一份「${fromLabel(from)}」的名單，要用這份取代嗎？`)) return;
        if (roomsEditing === "edit" && roomsEditFrom !== null && roomsEditFrom !== from) deleteRoomsVersion(cd, roomsEditFrom);
        setRoomsVersion(cd, from, text, D.parseRooms(text, index().norm, curBuilding()).rooms);
        try { await flush(); roomsEditing = false; roomsEditFrom = null; roomsView = from; renderRooms(); }
        catch (err) { alert("儲存失敗：" + err.message); }
        return;
      }
      if (t.id === "dRoomsEdit") { const v = shownVersion(); roomsEditing = "edit"; roomsEditFrom = v ? v.from : ""; renderRoomsLock(); roomsInfo(); $("dRoomsText").focus(); return; }
      if (t.id === "dRoomsNew") { roomsEditing = "new"; roomsEditFrom = null; renderRoomsLock(); roomsInfo(); $("dRoomsText").focus(); return; }
      if (t.id === "dRoomsCancel") { roomsEditing = false; roomsEditFrom = null; const v = shownVersion(); $("dRoomsText").value = v ? v.text : (cdata().roomsText || ""); renderRooms(); return; }
      if (t.id === "dRoomsDelVer") {
        const v = shownVersion(); if (!v) return;
        if (!confirm(`確定刪除「${fromLabel(v.from)}」的寢室名單？那段期間的檢查會改用前一份名單計算。`)) return;
        deleteRoomsVersion(cdata(), v.from); roomsView = null;
        try { await flush(); } catch (err) { alert("儲存失敗：" + err.message); }
        renderRooms(); return;
      }
      const del = t.closest("[data-del]");
      if (del) {
        const id = del.dataset.del, r = cdata().reports[id], src = srcOf(id), n = B.countPoints(src);
        if (!r) return;
        const label = r.date + (nthLabel(Object.assign(r, {id})) ? " " + nthLabel(r) : "");
        if (!confirm(`確定刪除 ${label} 的內務檢查？` + (n ? `\n加扣分預覽表裡這次轉入的 ${n} 筆也會一起移除。` : ""))) return;
        delete cdata().reports[id];
        if (n) B.replacePoints(src, []);
        await flush(); renderHistory();
      }
    });
    root.addEventListener("change", e => {
      if (e.target.id === "dOcrFile") { const f = e.target.files[0]; e.target.value = ""; runOcr(f); return; }
      if (e.target.id === "dRoomsFrom") { roomsInfo(); return; }
      if (e.target.id === "dBuilding") { changeBuilding(e.target); return; }
      const t = e.target;
      if (t.id === "dDate" && draft && t.value) { draft.date = t.value; draft.dateEdited = true; pendingOverwrite = false; buildDraft(); }
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
    });
    let rawTimer, personTimer;
    root.addEventListener("input", e => {
      const t = e.target;
      if (t.id === "dRaw") { if (!t.value.trim() && !ocrBusy) ocrReset(); clearTimeout(rawTimer); rawTimer = setTimeout(buildDraft, 250); msg("dEntryMsg", "", ""); }
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
    cohortChanged() { if (!data) return; idxCache = {id: null}; roomsEditing = false; roomsView = null; roomsEditFrom = null; draft = null; month = null; q.room = ""; q.person = ""; if ($("dRaw")) $("dRaw").value = ""; render(); },
    templateChanged() { if (data && sub === "rooms") render(); },
    lock() { data = null; draft = null; if ($("tab-dorm")) $("tab-dorm").innerHTML = ""; },
    flush() { return data ? flush() : Promise.resolve(); },
    importDormFile(d) { if (!data) throw new Error("內務模組尚未載入。"); return importDormFile(d); }
  };
})();
