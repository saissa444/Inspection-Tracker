(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const core = window.AppCore, Store = window.LocalStore, X = window.XLSX;
  if (!core || !Store || !X || !X.read || !X.CFB) { window.reportStartupError("程式元件未完整載入，請重新整理網頁。"); return; }

  const COLORS = ["#1f5fae", "#c2410c", "#15803d", "#7c3aed", "#be185d", "#0f766e"];
  // 畫面顯示用的莫蘭迪色；儲存的期別顏色維持原值，舊資料不必轉換
  const MORANDI = {"#1f5fae": "#5a7391", "#c2410c": "#a0684f", "#15803d": "#647a61", "#7c3aed": "#776a89", "#be185d": "#9a6472", "#0f766e": "#5a7a76"};
  const tone = color => MORANDI[color] || color;
  const SCORES = ["0.1", "0.2", "0.3", "0.4", "0.5", "0.6", "0.7", "0.8"];

  /* ───────── 狀態 ───────── */
  let cohorts = [];                 // [{id,label,color,fileName,importedAt,sheetName,students}]
  let settings = {activeCohort: "", autoLockMinutes: 15, tab: ""};
  let pTpl = null;                  // {fileName, importedAt, bytes, options}
  let rTpl = null;                  // {fileName, importedAt, bytes, parsed}
  let pRecords = [], rRecords = [];
  let prevSet = {p: new WeakSet(), r: new WeakSet()}; // 開啟時還原的「上次未清空」紀錄

  const status = (id, message, kind) => { const el = $(id); el.hidden = false; el.textContent = message; el.className = "status" + (kind ? " " + kind : ""); };
  const fmtDate = t => { const d = new Date(t); return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate(); };
  const stampDash = () => new Date().toLocaleDateString("sv-SE");
  const activeCohort = () => cohorts.find(c => c.id === settings.activeCohort) || null;
  const otherCohorts = () => cohorts.filter(c => c.id !== settings.activeCohort);
  const colorOf = label => { const c = cohorts.find(c => c.label === label); return c ? tone(c.color) : "#7d7a75"; };
  function cohortTag(label) {
    const span = document.createElement("span");
    span.className = "cohort-tag"; span.textContent = label || "—"; span.style.setProperty("--c", colorOf(label));
    return span;
  }
  function fillOptions(select, values, placeholder) {
    select.replaceChildren();
    if (placeholder !== undefined) select.add(new Option(placeholder, ""));
    values.forEach(value => select.add(new Option(value, value)));
  }

  // 下拉選單：值維持原本的條款目代碼，顯示文字加上事由，方便直接看內容挑選
  function fillLabeled(select, pairs, placeholder) {
    select.replaceChildren(new Option(placeholder, ""));
    pairs.forEach(([value, label]) => { const option = new Option(label, value); option.title = label; select.add(option); });
  }
  // 「條」顯示獎懲程度（學生獎懲規定第16～24條）；範本若有其他條，改顯示範本設定的額度
  const ARTICLE_LEVELS = {
    "第16條": "予以嘉獎", "第17條": "予以記功", "第18條": "予以記大功",
    "第19條": "予以申誡", "第20條": "予以記過", "第21條": "予以記大過",
    "第22條": "予以留校察看", "第23條": "予以勒令退學或退訓", "第24條": "予以開除學籍或退訓"
  };
  function articleChoices(t) {
    return core.unique(t.rules.map(rule => rule.article)).map(article => {
      const level = ARTICLE_LEVELS[article] || (t.defaultAmounts[article] ? "額度：" + t.defaultAmounts[article] : "");
      return [article, level ? article + "｜" + level : article];
    });
  }
  // 分目的款在範本中沒有款本身的文字，這裡補上款的標題（學生獎懲規定）
  const CLAUSE_HEADINGS = {
    "第20條|第17款": "考試時有下列情形之一：",
    "第21條|第14款": "考試時有下列情形之一：",
    "第23條|第13款": "考試時有下列情形之一："
  };
  function clauseChoices(t, article) {
    const rows = t.rules.filter(rule => rule.article === article);
    return core.unique(rows.map(rule => rule.clause)).map(clause => {
      const own = rows.filter(rule => rule.clause === clause), items = core.unique(own.map(rule => rule.item).filter(Boolean));
      const heading = CLAUSE_HEADINGS[article + "|" + clause] || "";
      return [clause, clause + "｜" + (items.length ? heading + "（分 " + items.length + " 目，請在下一欄選擇）" : own[0].reason)];
    });
  }
  function itemChoices(relevant) {
    const seen = new Set();
    return relevant.filter(rule => rule.item && !seen.has(rule.item) && seen.add(rule.item)).map(rule => [rule.item, rule.item + "｜" + rule.reason]);
  }

  /* ───────── 存檔 ───────── */
  let saveTimer = null;
  function saveDrafts() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushDrafts, 250);
    updateTabCounts();
  }
  async function flushDrafts() {
    clearTimeout(saveTimer); saveTimer = null;
    try { await Store.setJSON("drafts", {points: pRecords, reward: rRecords}); }
    catch (error) { console.warn("草稿儲存失敗", error); }
    if (window.DormModule) await window.DormModule.flush().catch(error => console.warn("內務資料儲存失敗", error));
  }
  const saveSettings = () => Store.setJSON("settings", settings).catch(error => console.warn(error));
  const saveCohorts = () => Store.setJSON("cohorts", cohorts);

  function download(bytes, filename) {
    // 依副檔名給正確的檔案類型（手機 Safari 會依類型決定怎麼存檔）
    const type = /\.json$/i.test(filename) ? "application/json" : /\.pdf$/i.test(filename) ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const url = URL.createObjectURL(new Blob([bytes], {type}));
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 30000);
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      if (!file.size) { reject(new Error("檔案是空的；若來自 iCloud，請先下載至「檔案」後重選。")); return; }
      const reader = new FileReader();
      const timer = setTimeout(() => { reader.onabort = null; reader.abort(); reject(new Error("讀取逾時，請先將 Excel 下載至本機再重新選取。")); }, 30000);
      reader.onload = () => { clearTimeout(timer); resolve(new Uint8Array(reader.result)); };
      reader.onerror = () => { clearTimeout(timer); reject(new Error("無法讀取檔案，請先下載至本機後重選。")); };
      reader.onabort = () => { clearTimeout(timer); reject(new Error("檔案讀取已中止，請重新選取。")); };
      try { reader.readAsArrayBuffer(file); } catch (error) { clearTimeout(timer); reject(new Error("無法開啟檔案：" + error.message)); }
    });
  }
  function parseWorkbook(bytes) {
    try {
      const wb = X.read(bytes, {type: "array"});
      if (!wb.SheetNames.length) throw new Error("沒有可讀取的工作表。");
      return wb;
    } catch (error) { throw new Error("Excel 解析失敗：" + error.message); }
  }

  /* ═══════════ 鎖定與解鎖 ═══════════ */

  async function boot() {
    try {
      const state = await Store.status();
      $("bootStatus").hidden = true;
      if (state === "new") { await Store.create("", true); await enterApp(true); }
      else if (state === "nopass") {
        if (!(await Store.unlock(""))) throw new Error("本機資料無法開啟，請到設定清除本機資料後重新匯入。");
        await enterApp(false);
      } else { $("unlockForm").hidden = false; $("unlockPw").focus(); }
    } catch (error) {
      status("bootStatus", error.message, "error");
    }
    document.documentElement.dataset.appReady = "true";
  }

  $("setupForm").addEventListener("submit", async event => {
    event.preventDefault();
    const pw = $("setupPw").value, pw2 = $("setupPw2").value;
    if (pw.length < 6) { $("setupStatus").textContent = "密碼至少 6 個字元。"; return; }
    if (pw !== pw2) { $("setupStatus").textContent = "兩次輸入的密碼不一致。"; return; }
    $("setupBtn").disabled = true; $("setupStatus").textContent = "";
    try { await Store.create(pw); await enterApp(true); }
    catch (error) { $("setupStatus").textContent = error.message; $("setupBtn").disabled = false; }
  });

  $("unlockForm").addEventListener("submit", async event => {
    event.preventDefault();
    $("unlockBtn").disabled = true; $("unlockStatus").textContent = "";
    try {
      if (await Store.unlock($("unlockPw").value)) { $("unlockPw").value = ""; await enterApp(false); }
      else { $("unlockStatus").textContent = "密碼不正確。"; $("unlockPw").select(); }
    } catch (error) { $("unlockStatus").textContent = error.message; }
    $("unlockBtn").disabled = false;
  });

  /* ═══════════ 全部資料備份：一個檔案帶走名冊、範本、加扣分、獎懲、內務與設定 ═══════════ */
  const b64 = bytes => { let s = ""; const u = new Uint8Array(bytes); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
  const escHtml = t => String(t).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"}[c]));
  const recKey = r => JSON.stringify(r);
  function fullMsg(html, kind) { const box = $("fullRestoreAsk"); box.hidden = false; box.className = "restore-ask" + (kind ? " " + kind : ""); box.innerHTML = html; }
  const dormReportCount = dorm => Object.values((dorm && dorm.byCohort) || {}).reduce((n, c) => n + Object.keys(c.reports || {}).length, 0);
  function backupSummary(d) {
    return [(d.cohorts || []).length + " 期名冊", "加扣分 " + ((d.drafts || {}).points || []).length + " 筆", "獎懲 " + ((d.drafts || {}).reward || []).length + " 筆",
      "內務檢查 " + dormReportCount(d.dorm) + " 次", "範本 " + ["points", "reward"].filter(k => d.templates && d.templates[k]).length + " 份"].join("、");
  }
  async function buildFullBackup() {
    await flushDrafts();
    const tpl = {};
    for (const kind of ["points", "reward"]) {
      const meta = await Store.getJSON("tpl-" + kind, null), bytes = await Store.getBytes("tpl-" + kind);
      if (meta && bytes) tpl[kind] = {meta, bytes: b64(bytes)};
    }
    return {app: "學生加扣分", type: "full-backup", version: 1, exportedAt: new Date().toISOString(),
      cohorts, settings, templates: tpl, drafts: {points: pRecords, reward: rRecords}, dorm: await Store.getJSON("dorm", {})};
  }
  $("fullBackup").addEventListener("click", async () => {
    try {
      const d = await buildFullBackup();
      download(new TextEncoder().encode(JSON.stringify(d)), "全部資料備份_" + stampDash() + ".json");
      fullMsg("已下載備份檔（" + escHtml(backupSummary(d)) + "）。到另一台裝置按「匯入全部資料備份」選這個檔案即可。", "ok");
    } catch (error) { fullMsg("備份失敗：" + escHtml(error.message), "error"); }
  });
  /** 合併：名冊依期別名稱對應；紀錄去除完全相同的；內務同一次檢查保留較新的版本；這台已有的範本與設定不變 */
  function mergeBackup(local, bk) {
    const out = {cohorts: local.cohorts.slice(), settings: local.settings, templates: {}, drafts: {}, dorm: null};
    const idMap = {};
    (bk.cohorts || []).forEach(c => {
      const same = out.cohorts.find(x => x.id === c.id) || out.cohorts.find(x => x.label === c.label);
      if (same) idMap[c.id] = same.id; else { out.cohorts.push(c); idMap[c.id] = c.id; }
    });
    const fixSrc = r => { const m = /^dorm:([^:]+):(.*)$/.exec(r.src || ""); return m && idMap[m[1]] && idMap[m[1]] !== m[1] ? Object.assign({}, r, {src: "dorm:" + idMap[m[1]] + ":" + m[2]}) : r; };
    ["points", "reward"].forEach(k => {
      const mine = local.drafts[k], have = new Set(mine.map(recKey));
      out.drafts[k] = mine.concat(((bk.drafts || {})[k] || []).map(fixSrc).filter(r => !have.has(recKey(r)) && have.add(recKey(r))));
      out.templates[k] = local.templates[k] || (bk.templates || {})[k] || null;
    });
    if (!local.settings.quickPhrases && !local.settings.quickCatOrder && bk.settings) {
      out.settings = Object.assign({}, local.settings);
      ["quickPhrases", "quickCatOrder", "quickHiddenCats", "quickCustomCats", "quickGongwuNext"].forEach(k => { if (k in bk.settings) out.settings[k] = bk.settings[k]; });
    }
    const ld = Object.assign({mapping: null, autoPoints: true, inspectors: [], byCohort: {}}, local.dorm), bd = Object.assign({inspectors: [], byCohort: {}}, bk.dorm);
    const dorm = Object.assign({}, ld, {mapping: ld.mapping || bd.mapping || null, inspectors: ld.inspectors.concat(bd.inspectors.filter(n => !ld.inspectors.includes(n))), byCohort: Object.assign({}, ld.byCohort)});
    Object.entries(bd.byCohort).forEach(([cid, c]) => {
      const id = idMap[cid] || cid, mine = dorm.byCohort[id] || {roomsText: "", rooms: [], reports: {}};
      const reports = Object.assign({}, mine.reports);
      Object.entries(c.reports || {}).forEach(([rid, r]) => {
        const old = reports[rid], t = x => String(x.updatedAt || x.savedAt || "");
        if (!old || t(r) > t(old)) reports[rid] = r;
      });
      const hasRooms = (mine.rooms && mine.rooms.length) || (mine.roomsHistory && mine.roomsHistory.length);
      dorm.byCohort[id] = Object.assign({}, mine, hasRooms ? {} : {roomsText: c.roomsText || "", rooms: c.rooms || [], roomsHistory: c.roomsHistory || undefined, building: mine.building || c.building || undefined}, {reports});
    });
    out.dorm = dorm;
    return out;
  }
  async function applyBackup(next) {
    clearTimeout(saveTimer); saveTimer = null;
    await Store.setJSON("cohorts", next.cohorts);
    await Store.setJSON("settings", next.settings);
    for (const kind of ["points", "reward"]) {
      const t = next.templates[kind];
      if (t && t.meta && t.bytes) { await Store.setJSON("tpl-" + kind, t.meta); await Store.setBytes("tpl-" + kind, typeof t.bytes === "string" ? unb64(t.bytes) : t.bytes); }
      else if (!t) { await Store.remove("tpl-" + kind); }
    }
    await Store.setJSON("drafts", {points: next.drafts.points || [], reward: next.drafts.reward || []});
    await Store.setJSON("dorm", next.dorm || {});
    settings = {activeCohort: "", autoLockMinutes: 15, tab: settings.tab};
    pSelected.clear(); pInline = null;
    await enterApp(false);
    showTab("backup");
  }
  $("fullRestore").addEventListener("change", async e => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    let bk;
    try {
      bk = JSON.parse(new TextDecoder().decode(await readFile(file)));
      if (bk && bk.type !== "full-backup" && Array.isArray(bk.reports)) {
        // 舊的內務備份檔或線上版內務統計匯出檔：只匯入內務資料到目前期別
        const res = await window.DormModule.importDormFile(bk);
        fullMsg(escHtml(res.message), res.warn ? "" : "ok");
        return;
      }
      if (!bk || bk.type !== "full-backup") throw new Error("這不是 App 的備份檔。請選擇「全部資料備份_日期.json」，或舊的內務備份檔。");
    } catch (error) { fullMsg("匯入失敗：" + escHtml(error.message), "error"); return; }
    await flushDrafts();
    const tplLocal = {};
    for (const kind of ["points", "reward"]) {
      const meta = await Store.getJSON("tpl-" + kind, null), bytes = await Store.getBytes("tpl-" + kind);
      tplLocal[kind] = meta && bytes ? {meta, bytes} : null;
    }
    const local = {cohorts, settings, templates: tplLocal, drafts: {points: pRecords, reward: rRecords}, dorm: await Store.getJSON("dorm", {})};
    const empty = !cohorts.length && !pRecords.length && !rRecords.length && !dormReportCount(local.dorm);
    const run = async mode => {
      try {
        const next = mode === "replace" ? {cohorts: bk.cohorts || [], settings: Object.assign({}, bk.settings || {}), templates: bk.templates || {}, drafts: bk.drafts || {}, dorm: bk.dorm || {}} : mergeBackup(local, bk);
        if (mode === "replace" && local.templates.points && !next.templates.points) next.templates.points = local.templates.points;
        if (mode === "replace" && local.templates.reward && !next.templates.reward) next.templates.reward = local.templates.reward;
        await applyBackup(next);
        fullMsg((mode === "replace" ? "已用備份取代這台的資料。" : "已合併備份。") + "目前：" + escHtml(backupSummary({cohorts, drafts: {points: pRecords, reward: rRecords}, dorm: await Store.getJSON("dorm", {}), templates: {points: pTpl, reward: rTpl}})) + "。", "ok");
      } catch (error) { fullMsg("匯入失敗：" + escHtml(error.message), "error"); }
    };
    if (empty) { await run("replace"); return; }
    fullMsg("<p>備份檔（" + (bk.exportedAt ? fmtDate(bk.exportedAt) + " 備份，" : "") + escHtml(backupSummary(bk)) + "）。這台裝置已經有資料，要怎麼處理？</p>" +
      '<div class="actions"><button type="button" data-full="merge">合併到這台（建議）</button>' +
      '<button type="button" class="secondary" data-full="replace">整個取代成備份內容</button>' +
      '<button type="button" class="secondary" data-full="cancel">取消</button></div>' +
      '<p class="note">合併：名冊、紀錄、內務檢查都加進來，相同的不會重複；這台已有的範本和設定不變。取代：這台目前的名冊、紀錄、內務資料和設定都換成備份內容。</p>');
    $("fullRestoreAsk").onclick = async ev => {
      const b = ev.target.closest("[data-full]"); if (!b) return;
      if (b.dataset.full === "cancel") { $("fullRestoreAsk").onclick = null; $("fullRestoreAsk").hidden = true; return; }
      if (b.dataset.full === "replace" && !confirm("確定用備份取代這台裝置目前的資料？目前的名冊、紀錄和內務資料會被換掉。")) return;
      $("fullRestoreAsk").onclick = null;
      await run(b.dataset.full);
    };
  });

  async function wipeEverything() {
    if (!confirm("確定清除這台裝置上本 App 的全部資料？\n（名冊、範本、尚未匯出的紀錄、密碼設定都會刪除，無法復原）")) return;
    if (!confirm("再次確認：真的要清除嗎？")) return;
    await Store.wipe();
    location.reload();
  }
  $("forgotWipe").addEventListener("click", wipeEverything);
  $("wipeAll").addEventListener("click", wipeEverything);

  let noPassword = false;
  function applySecurityUI() {
    $("lockBtn").hidden = noPassword;
    $("pwNoneBox").hidden = !noPassword;
    $("pwSetBox").hidden = noPassword;
    $("topSubtitle").textContent = noPassword ? "名冊與範本保存在這台裝置" : "名冊與範本已用密碼加密保存在這台裝置";
  }

  async function lockNow() {
    if (noPassword) return;
    await flushDrafts();
    Store.lock();
    location.reload(); // 重新載入頁面，清掉記憶體中的學生資料
  }
  $("lockBtn").addEventListener("click", lockNow);

  // 閒置自動鎖定
  let lastActive = Date.now();
  ["pointerdown", "keydown", "input", "wheel", "touchstart"].forEach(type =>
    document.addEventListener(type, () => { lastActive = Date.now(); }, {passive: true, capture: true}));
  setInterval(() => {
    const minutes = Number(settings.autoLockMinutes);
    if ($("app").hidden || !minutes || noPassword) return;
    if (Date.now() - lastActive > minutes * 60000) lockNow();
  }, 15000);
  document.addEventListener("visibilitychange", () => {
    const minutes = Number(settings.autoLockMinutes);
    if (document.visibilityState === "visible" && !$("app").hidden && !noPassword && minutes && Date.now() - lastActive > minutes * 60000) lockNow();
    if (document.visibilityState === "hidden" && !$("app").hidden) flushDrafts();
  });

  async function enterApp(firstTime) {
    noPassword = await Store.isNoPassword();
    applySecurityUI();
    cohorts = await Store.getJSON("cohorts", []);
    settings = Object.assign(settings, await Store.getJSON("settings", {}));
    applyViewMode();
    renderQuickPhrases();
    const drafts = await Store.getJSON("drafts", {points: [], reward: []});
    pRecords = drafts.points || []; rRecords = drafts.reward || [];
    prevSet = {p: new WeakSet(pRecords), r: new WeakSet(rRecords)};
    const loadTpl = async kind => {
      const meta = await Store.getJSON("tpl-" + kind, null), bytes = await Store.getBytes("tpl-" + kind);
      if (!meta || !bytes) return null;
      try {
        const wb = parseWorkbook(bytes);
        return kind === "points" ? Object.assign({}, meta, {bytes, options: core.extractPointsTemplate(wb, X).options})
          : Object.assign({}, meta, {bytes, parsed: core.extractRewardTemplate(wb, X)});
      } catch (error) { console.warn(error); return null; }
    };
    pTpl = await loadTpl("points");
    rTpl = await loadTpl("reward");
    if (!activeCohort()) settings.activeCohort = cohorts[0] ? cohorts[0].id : "";

    $("lockScreen").hidden = true;
    $("app").hidden = false;
    lastActive = Date.now();
    $("autoLock").value = String(settings.autoLockMinutes);

    renderCohorts();
    renderTemplates();
    pRenderCategories();
    pRenderRecords();
    rResetRuleControls();
    rRender();
    if (window.DormModule) await window.DormModule.enter(dormBridge);
    const ready = cohorts.length && pTpl && rTpl;
    showTab(firstTime || !cohorts.length ? "settings" : settings.tab || (ready ? "points" : "settings"));
    if (firstTime) status("rosterStatus", "歡迎使用！請先匯入名冊（每期一份），再匯入兩份學校範本；之後打開 App 就能直接使用，不用再匯入。", "ok");
    if (pRecords.length || rRecords.length) {
      const parts = [];
      if (pRecords.length) parts.push("加扣分 " + pRecords.length + " 筆");
      if (rRecords.length) parts.push("獎懲 " + rRecords.length + " 筆");
      status("rResult", "已還原上次未清空的紀錄：" + parts.join("、") + "。", "ok");
      $("pError").style.color = "var(--ok)";
      $("pError").textContent = "已還原上次未清空的紀錄：" + parts.join("、") + "。";
    }
    const persisted = await Store.requestPersistence();
    $("persistStatus").textContent = persisted === true ? "✓ 瀏覽器已同意長期保存本機資料。" :
      persisted === false ? "瀏覽器未同意長期保存；長時間未使用或空間不足時，資料可能被清除（iPhone 請加入主畫面使用）。" : "";
  }

  /* ═══════════ 內務分頁的介面 ═══════════
     內務檢查存檔時，個人優缺點會轉成加扣分紀錄（src 標記來源，取代同一天的檢查時一併更新）。 */
  const dormBridge = {
    Store, activeCohort, otherCohorts, download,
    pointsOptions: () => (pTpl ? pTpl.options : null),
    countPoints: src => pRecords.filter(r => r.src === src).length,
    replacePoints(src, records) {
      const before = pRecords.length;
      pRecords = pRecords.filter(r => r.src !== src);
      const removed = before - pRecords.length;
      pRecords.push(...records);
      pSelected.clear(); pRenderRecords(); saveDrafts();
      return removed;
    }
  };

  /* ═══════════ 分頁 ═══════════ */

  /* ───────── 連續範圍勾選 ─────────
     電腦：勾一筆後按住 Shift 再勾另一筆，中間全部套用相同狀態。
     手機（或滑鼠拖曳）：按住某筆的勾選框上下滑動，滑過的都套用與起點相反的狀態。 */
  const rangeApi = {
    p: {
      body: () => $("pRecords"),
      get: tr => pSelected.has(pRecords[Number(tr.dataset.index)]),
      set: (tr, on) => { const r = pRecords[Number(tr.dataset.index)]; if (!r) return; if (on) pSelected.add(r); else pSelected.delete(r); },
      done: () => { if (pInline && pInline.targets.length > 1) pCancelInline(); pUpdateSelection(); }
    },
    r: {
      body: () => $("rBody"),
      get: tr => rSelectedRows.has(Number(tr.dataset.index)),
      set: (tr, on) => {
        const i = Number(tr.dataset.index); if (!rRecords[i]) return;
        if (on) rSelectedRows.add(i); else rSelectedRows.delete(i);
        const box = tr.querySelector("td.cell-select input[type=checkbox]"); if (box) box.checked = on;
        tr.classList.toggle("selected-record", on);
      },
      done: () => { if (rInline && rInline.targets.length > 1) rCancelInline(); rUpdateSelection(); }
    }
  };
  const rangeAnchor = {p: null, r: null};
  let rangeDrag = null, suppressBoxClick = false;
  const visibleRows = prefix => Array.from(rangeApi[prefix].body().children).filter(tr => tr.dataset.index !== undefined && !tr.hidden);
  ["p", "r"].forEach(prefix => {
    const api = rangeApi[prefix], body = api.body();
    // Shift＋點選：在捕獲階段處理（此時勾選框已切換成新狀態）
    body.addEventListener("click", event => {
      const box = event.target.closest("td.cell-select input[type=checkbox]");
      if (!box) return;
      if (suppressBoxClick) { event.preventDefault(); event.stopPropagation(); return; } // 拖曳結束後的點擊不再切換
      const tr = box.closest("tr");
      if (event.shiftKey && rangeAnchor[prefix] !== null) {
        const rows = visibleRows(prefix);
        const a = rows.findIndex(row => Number(row.dataset.index) === rangeAnchor[prefix]), b = rows.indexOf(tr);
        if (a >= 0 && b >= 0) {
          rows.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(row => api.set(row, box.checked));
          api.done();
        }
      }
      rangeAnchor[prefix] = Number(tr.dataset.index);
      lastTouched[prefix] = Number(tr.dataset.index); // 懸浮列跟著最後勾選的那一筆
    }, true);
    // 按住勾選欄拖曳
    body.addEventListener("pointerdown", event => {
      const cell = event.target.closest("td.cell-select");
      if (!cell || event.button > 0) return;
      const tr = cell.closest("tr");
      rangeDrag = {prefix, start: tr, target: !api.get(tr), moved: false, pointerId: event.pointerId,
        snapshot: new Map(visibleRows(prefix).map(row => [row, api.get(row)]))};
    });
  });
  function rangeDragUpdate(x, y) {
    const el = document.elementFromPoint(x, y);
    const tr = el && el.closest("tr");
    const rows = visibleRows(rangeDrag.prefix);
    if (!tr || !rows.includes(tr)) return false;
    if (tr === rangeDrag.start && !rangeDrag.moved) return false;
    if (!rangeDrag.moved) { rangeDrag.moved = true; document.body.classList.add("range-selecting"); rangeAutoScroll(); }
    const api = rangeApi[rangeDrag.prefix], a = rows.indexOf(rangeDrag.start), b = rows.indexOf(tr);
    if (a < 0) return true;
    lastTouched[rangeDrag.prefix] = Number(tr.dataset.index);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    rows.forEach((row, i) => api.set(row, i >= lo && i <= hi ? rangeDrag.target : rangeDrag.snapshot.get(row)));
    api.done();
    return true;
  }
  // 手指拖到畫面上緣或下緣時自動捲動，長清單也能一路勾下去
  function rangeAutoScroll() {
    if (!rangeDrag || !rangeDrag.moved) return;
    const y = rangeDrag.lastY, edge = 70, topEdge = 130;
    const dy = y > window.innerHeight - edge ? 14 : y < topEdge ? -14 : 0;
    if (dy) { window.scrollBy(0, dy); rangeDragUpdate(rangeDrag.lastX, rangeDrag.lastY); }
    requestAnimationFrame(rangeAutoScroll);
  }
  document.addEventListener("pointermove", event => {
    if (!rangeDrag || event.pointerId !== rangeDrag.pointerId) return;
    rangeDrag.lastX = event.clientX; rangeDrag.lastY = event.clientY;
    if (rangeDragUpdate(event.clientX, event.clientY) || rangeDrag.moved) event.preventDefault();
  }, {passive: false});
  const endRangeDrag = () => {
    if (!rangeDrag) return;
    if (rangeDrag.moved) {
      rangeAnchor[rangeDrag.prefix] = Number(rangeDrag.start.dataset.index);
      suppressBoxClick = true; setTimeout(() => { suppressBoxClick = false; }, 400);
    }
    document.body.classList.remove("range-selecting");
    rangeDrag = null;
  };
  document.addEventListener("pointerup", endRangeDrag);
  document.addEventListener("pointercancel", endRangeDrag);

  // 剛儲存修改的紀錄維持淺藍底，直到下一個操作才取消，方便核對改了哪些
  const justEdited = {p: new Set(), r: new Set()};
  function clearJustEdited() {
    if (!justEdited.p.size && !justEdited.r.size) return;
    justEdited.p.clear(); justEdited.r.clear();
    document.querySelectorAll("tr.just-edited").forEach(tr => tr.classList.remove("just-edited"));
  }
  document.addEventListener("click", event => {
    if (!justEdited.p.size && !justEdited.r.size) return;
    const control = event.target.closest("button, input, select, textarea, a, .file-button");
    if (!control) return;
    // 只是查看的操作（展開明細、分組／搜尋、切換檢視或分頁、回頂端）不取消
    if (control.closest(".cell-summary, .list-tools, .tabs, .cohort-bar, #toTop")) return;
    clearJustEdited();
  }, true);

  // 勾選提示：全選旁的文字＋畫面底部的懸浮提示列
  function setBulkHint(prefix, n) {
    const hint = document.querySelector("#tab-" + (prefix === "p" ? "points" : "reward") + " .bulk-hint");
    if (!hint) return;
    hint.classList.toggle("active", n > 1);
    hint.textContent = n > 1 ? "按任一勾選列的「編輯」或「刪除」，會一次處理這 " + n + " 筆" : "小技巧：電腦按住 Shift 可連續勾選；手機按住勾選框上下滑動可連續勾選";
  }
  function updateSelBar() {
    const tab = settings.tab, n = tab === "points" ? pSelected.size : tab === "reward" ? rSelectedRows.size : 0;
    // 只在手機／平板的卡片模式顯示（電腦的表格模式直接用列上的編輯、刪除）
    const cardLayout = window.matchMedia("(max-width: 1023px)").matches;
    $("selBar").hidden = n < 1 || $("app").hidden || !cardLayout;
    $("selBarCount").textContent = "已勾選 " + n + " 筆";
    $("selBarEdit").disabled = tab === "points" ? !pTpl : !rTpl;
    positionSelBar();
  }
  /* 懸浮列放在「最後勾選那一筆」的正下方，從勾選框右側開始，不遮住下一筆的勾選框。
     沒有最後一筆（例如全選）或那一筆已捲出畫面時，改回固定在畫面底部。 */
  const lastTouched = {p: null, r: null};
  let selBarFrame = 0;
  function positionSelBar() {
    const bar = $("selBar");
    const fallback = () => { bar.classList.remove("anchored"); bar.style.top = bar.style.left = bar.style.maxWidth = ""; };
    if (bar.hidden) return fallback();
    const tab = settings.tab, prefix = tab === "points" ? "p" : tab === "reward" ? "r" : null;
    if (!prefix || lastTouched[prefix] === null || $("tab-" + tab).hidden) return fallback();
    const row = rangeApi[prefix].body().querySelector('tr[data-index="' + lastTouched[prefix] + '"]');
    if (!row || row.hidden || !rangeApi[prefix].get(row)) return fallback();
    const rect = row.getBoundingClientRect(), wrap = row.closest(".tablewrap").getBoundingClientRect();
    const check = row.querySelector("td.cell-select").getBoundingClientRect();
    const barHeight = bar.offsetHeight || 52, cohortBar = $("cohortBar").getBoundingClientRect().bottom;
    // 那一筆不在畫面內（或下方空間不夠）時，固定在畫面底部
    if (rect.bottom < cohortBar || rect.bottom + barHeight + 8 > window.innerHeight) return fallback();
    const left = Math.max(check.right, wrap.left + 40);
    bar.classList.add("anchored");
    bar.style.top = (rect.bottom + window.scrollY + 4) + "px";
    bar.style.left = (left + window.scrollX) + "px";
    bar.style.maxWidth = Math.min(window.innerWidth - left - 6, Math.max(300, wrap.right - left)) + "px";
  }
  const scheduleSelBar = () => { cancelAnimationFrame(selBarFrame); selBarFrame = requestAnimationFrame(positionSelBar); };
  window.addEventListener("scroll", scheduleSelBar, {passive: true});
  window.addEventListener("resize", () => { updateSelBar(); scheduleSelBar(); });
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(scheduleSelBar);
    ro.observe($("pRecords")); ro.observe($("rBody"));
  }
  // 懸浮列上的「編輯」「刪除」：一次處理全部勾選的紀錄（手機上不用再展開卡片找按鈕）
  $("selBarEdit").addEventListener("click", () => {
    if (settings.tab === "points") {
      let first = pRecords.find(r => pSelected.has(r) && matchesFilter("p", r));
      if (!first) { // 勾選的紀錄都被篩選隱藏時，先清除篩選
        Object.assign(filters.p, {cohort: "", text: "", group: ""}); $("pFilterCohort").value = ""; $("pFilterText").value = "";
        applyFilter("p"); first = pRecords.find(r => pSelected.has(r));
      }
      if (!first) return;
      pStartInline(first);
      const tr = $("pRecords").querySelector('tr[data-index="' + pRecords.indexOf(first) + '"]');
      if (tr) tr.scrollIntoView({block: "center", behavior: "smooth"});
    } else if (settings.tab === "reward") {
      let first = Array.from(rSelectedRows).sort((a, b) => a - b).find(i => rRecords[i] && matchesFilter("r", rRecords[i]));
      if (first === undefined) {
        Object.assign(filters.r, {cohort: "", text: "", group: ""}); $("rFilterCohort").value = ""; $("rFilterText").value = "";
        applyFilter("r"); first = Array.from(rSelectedRows).sort((a, b) => a - b)[0];
      }
      if (first === undefined) return;
      rStartInline(first);
      const tr = $("rBody").querySelector('tr[data-index="' + first + '"]');
      if (tr) tr.scrollIntoView({block: "center", behavior: "smooth"});
    }
  });
  $("selBarDelete").addEventListener("click", () => {
    if (settings.tab === "points") pDeleteSelected();
    else if (settings.tab === "reward") rDeleteSelected();
  });
  $("selBarClear").addEventListener("click", () => {
    if (settings.tab === "points") { if (pInline && pInline.targets.length > 1) pCancelInline(false); pSelected.clear(); pRenderRecords(); }
    else if (settings.tab === "reward") { rSelectedRows.clear(); rRender(); }
  });

  function showTab(tab) {
    ["dorm", "points", "reward", "settings", "backup"].forEach(name => {
      $("tab-" + name).hidden = name !== tab;
      $("tabBtn-" + name).setAttribute("aria-selected", String(name === tab));
    });
    if (settings.tab !== tab) { settings.tab = tab; saveSettings(); }
    placeQuickPanel(tab);
    updateSelBar();
  }
  document.querySelectorAll(".tab").forEach(button => button.addEventListener("click", () => showTab(button.dataset.tab)));
  function updateTabCounts() {
    $("pTabCount").textContent = pRecords.length || "";
    $("rTabCount").textContent = rRecords.length || "";
    updateBatchClear();
  }
  // ① 批次登錄右上角：清空紀錄鍵＋上次未清空筆數
  function updateBatchClear() {
    [["p", pRecords], ["r", rRecords]].forEach(([k, list]) => {
      const note = $(k + "PrevNote"), prev = list.filter(r => prevSet[k].has(r)).length;
      $(k + "BatchClear").disabled = !list.length;
      note.classList.toggle("now", !prev);
      note.textContent = prev ? "還有上次 " + prev + " 筆未清空" + (list.length > prev ? "（本次 " + (list.length - prev) + " 筆）" : "")
        : list.length ? "目前 " + list.length + " 筆未清空" : "";
    });
  }
  $("pBatchClear").addEventListener("click", () => $("pClear").click());
  $("rBatchClear").addEventListener("click", () => $("rClearRecords").click());

  /* ═══════════ 期別 ═══════════ */

  function renderCohorts() {
    const active = activeCohort();
    document.documentElement.style.setProperty("--cohort", active ? tone(active.color) : "#9c5454");
    const box = $("cohortButtons");
    box.replaceChildren();
    cohorts.forEach(cohort => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "cohort-btn"; button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(cohort.id === settings.activeCohort));
      button.style.setProperty("--c", tone(cohort.color));
      button.textContent = cohort.label;
      const small = document.createElement("small"); small.textContent = cohort.students.length + " 人";
      button.append(small);
      button.addEventListener("click", () => setActiveCohort(cohort.id));
      box.append(button);
    });
    $("cohortEmpty").hidden = cohorts.length > 0;
    document.querySelectorAll(".active-cohort-tag").forEach(tag => {
      tag.textContent = active ? active.label : "尚未選擇期別";
      tag.style.setProperty("--c", active ? tone(active.color) : "#9c5454");
    });

    const list = $("cohortList");
    list.replaceChildren();
    if (!cohorts.length) {
      const p = document.createElement("p"); p.className = "err"; p.textContent = "尚未匯入任何名冊。";
      list.append(p);
    }
    cohorts.forEach(cohort => {
      const card = document.createElement("div");
      card.className = "cohort-card"; card.style.setProperty("--c", tone(cohort.color));
      const info = document.createElement("div"); info.className = "info";
      const title = document.createElement("strong"); title.textContent = cohort.label;
      const meta = document.createElement("div"); meta.className = "note";
      meta.textContent = cohort.students.length + " 位學生｜" + cohort.fileName + "｜" + fmtDate(cohort.importedAt) + " 匯入";
      info.append(title, meta);
      const update = document.createElement("button");
      update.type = "button"; update.className = "secondary"; update.textContent = "更新名冊";
      update.addEventListener("click", () => { pendingTarget = cohort.id; $("rosterFile").click(); });
      const remove = document.createElement("button");
      remove.type = "button"; remove.className = "danger"; remove.textContent = "刪除";
      remove.addEventListener("click", async () => {
        if (!confirm("確定刪除「" + cohort.label + "」名冊？已新增的紀錄會保留。")) return;
        cohorts = cohorts.filter(c => c.id !== cohort.id);
        if (settings.activeCohort === cohort.id) settings.activeCohort = cohorts[0] ? cohorts[0].id : "";
        await saveCohorts(); saveSettings();
        renderCohorts(); refreshChecks();
        status("rosterStatus", "已刪除「" + cohort.label + "」名冊。", "ok");
      });
      card.append(info, update, remove);
      list.append(card);
    });
  }

  function setActiveCohort(id) {
    if (settings.activeCohort === id) return;
    settings.activeCohort = id;
    saveSettings();
    renderCohorts();
    refreshChecks();
    if (window.DormModule) window.DormModule.cohortChanged();
  }
  function refreshChecks() { pCheckStudents(); rCheckStudents(); pUpdateAddState(); rRefreshAddState(); }

  // 匯入名冊
  let pendingRoster = null, pendingTarget = "";
  $("rosterFile").addEventListener("change", async event => {
    const input = event.target, file = input.files && input.files[0];
    if (!file) return;
    $("rosterPending").hidden = true;
    status("rosterStatus", "正在讀取：" + file.name + "…");
    try {
      const result = core.extractRoster(parseWorkbook(await readFile(file)), X);
      pendingRoster = {fileName: file.name, sheetName: result.sheetName, students: result.students, guess: core.guessCohortLabel(result.students)};
      showPendingRoster();
      $("rosterStatus").hidden = true;
    } catch (error) {
      status("rosterStatus", "名冊匯入失敗：" + error.message, "error");
      pendingTarget = "";
    } finally { input.value = ""; }
  });

  function showPendingRoster() {
    const p = pendingRoster;
    $("rosterPendingInfo").textContent = p.fileName + "｜「" + p.sheetName + "」：" + p.students.length + " 位學生" + (p.guess ? "（依建制隊號判斷為" + p.guess + "）" : "");
    const target = $("rosterTarget");
    target.replaceChildren(new Option("新增為新的期別", "new"));
    cohorts.forEach(c => target.add(new Option("更新既有名冊：" + c.label, c.id)));
    const sameLabel = cohorts.find(c => c.label === p.guess);
    target.value = pendingTarget || (sameLabel ? sameLabel.id : "new");
    $("rosterLabel").value = p.guess;
    $("rosterPending").hidden = false;
    syncPendingRoster();
    $("rosterPending").scrollIntoView({block: "nearest"});
  }
  function overlap(students, cohort) {
    const ids = new Set(cohort.students.map(s => s.school));
    return students.filter(s => ids.has(s.school)).length;
  }
  function syncPendingRoster() {
    if (!pendingRoster) return;
    const target = $("rosterTarget").value, students = pendingRoster.students;
    $("rosterLabelWrap").hidden = target !== "new";
    const warnings = [];
    if (target === "new") {
      cohorts.forEach(c => {
        const n = overlap(students, c);
        if (n > students.length / 2) warnings.push("這份名冊有 " + n + " 位學生已在「" + c.label + "」，可能是同一期；若是，請改選「更新既有名冊：" + c.label + "」。");
      });
    } else {
      const c = cohorts.find(c => c.id === target);
      const n = overlap(students, c);
      if (c && n < Math.min(students.length, c.students.length) * 0.2) warnings.push("這份名冊和原本的「" + c.label + "」幾乎沒有相同學生（" + n + " 位），請確認沒有選錯期別。");
    }
    $("rosterPendingWarn").textContent = warnings.join("\n");
  }
  $("rosterTarget").addEventListener("change", syncPendingRoster);
  $("rosterCancel").addEventListener("click", () => { pendingRoster = null; pendingTarget = ""; $("rosterPending").hidden = true; });
  $("rosterSave").addEventListener("click", async () => {
    if (!pendingRoster) return;
    const target = $("rosterTarget").value, p = pendingRoster;
    let saved;
    if (target === "new") {
      const label = core.clean($("rosterLabel").value);
      if (!label) { $("rosterPendingWarn").textContent = "請輸入期別名稱，例如：第45期"; return; }
      if (cohorts.some(c => c.label === label)) { $("rosterPendingWarn").textContent = "已有「" + label + "」，若要覆蓋請改選「更新既有名冊」。"; return; }
      const used = new Set(cohorts.map(c => c.color));
      saved = {id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), label,
        color: COLORS.find(c => !used.has(c)) || COLORS[cohorts.length % COLORS.length]};
      cohorts.push(saved);
    } else saved = cohorts.find(c => c.id === target);
    Object.assign(saved, {fileName: p.fileName, sheetName: p.sheetName, importedAt: Date.now(), students: p.students});
    if (!activeCohort()) settings.activeCohort = saved.id;
    try {
      await saveCohorts(); await saveSettings();
    } catch (error) { status("rosterStatus", "儲存失敗：" + error.message, "error"); return; }
    pendingRoster = null; pendingTarget = "";
    $("rosterPending").hidden = true;
    renderCohorts(); refreshChecks();
    status("rosterStatus", "已儲存「" + saved.label + "」名冊：" + saved.students.length + " 位學生。之後開啟 App 不需要再匯入。", "ok");
  });

  /* ═══════════ 範本 ═══════════ */

  function renderTemplates() {
    if (pTpl) status("pTplStatus", "✓ " + pTpl.fileName + "｜" + Object.keys(pTpl.options).length + " 個分類｜" + fmtDate(pTpl.importedAt) + " 匯入", "ok");
    else status("pTplStatus", "尚未匯入（加扣分功能需要此範本）", "warning");
    if (rTpl) status("rTplStatus", "✓ " + rTpl.fileName + "｜獎懲項目 " + rTpl.parsed.rules.length + " 筆｜" + fmtDate(rTpl.importedAt) + " 匯入", "ok");
    else status("rTplStatus", "尚未匯入（獎懲功能需要此範本）", "warning");
  }

  async function importTemplate(kind, input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const statusId = kind === "points" ? "pTplStatus" : "rTplStatus";
    status(statusId, "正在讀取：" + file.name + "…");
    try {
      const bytes = await readFile(file), wb = parseWorkbook(bytes);
      const meta = {fileName: file.name, importedAt: Date.now()};
      let next;
      if (kind === "points") {
        next = Object.assign({}, meta, {bytes, options: core.extractPointsTemplate(wb, X).options});
        core.exportPointsWorkbook(bytes, [{school: "0", name: "x", cat: "優良x", reason: "x", detail: "", score: 0.1}], X, window); // 先試匯出，確認格式可用
      } else next = Object.assign({}, meta, {bytes, parsed: core.extractRewardTemplate(wb, X)});
      await Store.setBytes("tpl-" + kind, bytes);
      await Store.setJSON("tpl-" + kind, meta);
      if (kind === "points") { pTpl = next; pRenderCategories(); if (window.DormModule) window.DormModule.templateChanged(); }
      else { rTpl = next; rResetRuleControls(); rRefreshAddState(); }
      renderTemplates();
    } catch (error) {
      renderTemplates();
      status(statusId, "匯入失敗：" + error.message + (kind === "points" ? (pTpl ? "\n（仍使用原本的範本）" : "") : (rTpl ? "\n（仍使用原本的範本）" : "")), "error");
    } finally { input.value = ""; }
  }
  $("pTplFile").addEventListener("change", event => importTemplate("points", event.target));
  $("rTplFile").addEventListener("change", event => importTemplate("reward", event.target));

  /* ═══════════ 設定 ═══════════ */

  $("autoLock").addEventListener("change", () => { settings.autoLockMinutes = Number($("autoLock").value); saveSettings(); });
  $("pwSetForm").addEventListener("submit", async event => {
    event.preventDefault();
    const out = $("pwSetStatus");
    out.className = "err";
    if ($("pwSet1").value.length < 6) { out.textContent = "密碼至少 6 個字元。"; return; }
    if ($("pwSet1").value !== $("pwSet2").value) { out.textContent = "兩次輸入的密碼不一致。"; return; }
    out.className = ""; out.textContent = "設定中…";
    try {
      await flushDrafts();
      await Store.changePassword("", $("pwSet1").value);
      $("pwSetForm").reset(); out.textContent = "";
      noPassword = false; applySecurityUI();
      $("pwStatus").className = "ok"; $("pwStatus").textContent = "";
      alert("已設定開啟密碼。之後打開 App 或按「鎖定」後，都需要輸入密碼。");
    } catch (error) { out.className = "err"; out.textContent = error.message; }
  });
  $("pwRemoveForm").addEventListener("submit", async event => {
    event.preventDefault();
    const out = $("pwRemoveStatus");
    if (!confirm("確定取消開啟密碼？之後任何人打開這個 App 都能看到學生資料。")) return;
    out.className = ""; out.textContent = "處理中…";
    try {
      await flushDrafts();
      await Store.changePassword($("pwRemoveOld").value, "");
      $("pwRemoveForm").reset(); out.textContent = "";
      noPassword = true; applySecurityUI();
    } catch (error) { out.className = "err"; out.textContent = error.message; }
  });
  $("pwForm").addEventListener("submit", async event => {
    event.preventDefault();
    const out = $("pwStatus");
    out.className = "err";
    if ($("pwNew").value.length < 6) { out.textContent = "新密碼至少 6 個字元。"; return; }
    if ($("pwNew").value !== $("pwNew2").value) { out.textContent = "兩次輸入的新密碼不一致。"; return; }
    out.className = ""; out.textContent = "變更中…";
    try {
      await flushDrafts();
      await Store.changePassword($("pwOld").value, $("pwNew").value);
      $("pwForm").reset(); out.className = "ok"; out.textContent = "✓ 密碼已變更。";
    } catch (error) { out.className = "err"; out.textContent = error.message; }
  });

  /* ═══════════ 學生辨識面板（兩個分頁共用） ═══════════ */

  function renderCheck(panel, value, mode) {
    panel.replaceChildren();
    const cohort = activeCohort();
    if (!core.clean(value)) { panel.textContent = "尚未輸入學生資料"; return null; }
    if (!cohort) { panel.textContent = "請先到「名冊」匯入名冊。"; panel.classList.add("err"); return null; }
    panel.classList.remove("err");
    try {
      const resolved = core.resolveStudents(value, cohort.students, otherCohorts());
      resolved.matches.forEach(({student, count, notes}) => {
        const row = document.createElement("div");
        row.className = "student-row" + (count > 1 ? " error" : "");
        const dupText = mode === "points" ? "｜本批輸入 " + count + " 次，只新增 1 筆" : "｜本批共 " + count + " 筆（重複 " + (count - 1) + " 次，全部新增）";
        row.textContent = student.name + (count > 1 ? dupText : "｜辨識成功") +
          "\n女生隊號：" + (student.female || "—") + "　建制隊號：" + (student.team || "—") + "　學籍號碼：" + student.school +
          (notes.length ? "\n註記：" + notes.join("、") : "");
        panel.appendChild(row);
      });
      resolved.errors.forEach(error => {
        const row = document.createElement("div");
        row.className = "student-row error";
        row.textContent = error.token + "：" + error.message;
        panel.appendChild(row);
      });
      const summary = document.createElement("p");
      summary.className = "summary-line";
      summary.textContent = "【" + cohort.label + "】輸入 " + resolved.tokens.length + " 次；辨識 " + resolved.matches.length + " 位；重複 " +
        resolved.matches.filter(match => match.count > 1).length + " 位；無法辨識 " + resolved.errors.length + " 筆。";
      panel.prepend(summary);
      return resolved;
    } catch (error) {
      panel.textContent = error.message; panel.classList.add("err");
      return null;
    }
  }

  /* ═══════════ 加扣分分頁 ═══════════ */

  const pOptions = () => (pTpl ? pTpl.options : {});
  const favoriteReasons = {
    "加分": [
      "24.對指派或推選擔任之工作，執行得力，成績優良者",
      "25.公差勤務工作努力，績效優良者",
      "30.一週內務經常保持整潔者",
      "31.在校精神飽滿服裝整潔足資表率者"
    ],
    "扣分": [
      "22.對指派或推選擔任之工作執行錯誤，情節尚輕者",
      "26.處理事物怠於注意，致生不良後果，情節尚輕者",
      "59.儀容不整，指甲未修者",
      "63.內務不整者",
      "69.其它違反生活規範規定，情節輕微者"
    ]
  };
  // 比對文字而不只比對編號；匯出時保留範本原文。
  const reasonKey = text => text.normalize("NFKC").replace(/^\s*\d+\s*[.、．:：)）-]?\s*/, "").replace(/[\s\p{P}]/gu, "");

  fillOptions($("pScore"), SCORES); $("pScore").value = "0.2";

  function pCheckStudents() { renderCheck($("pCheck"), $("pIds").value, "points"); }
  function pUpdateAddState() { $("pAdd").disabled = false; }

  function pRenderCategories() {
    const prefix = core.kindPrefix($("pKind").value);
    fillOptions($("pCategory"), Object.keys(pOptions()).filter(k => k.startsWith(prefix)));
    pRenderItems();
  }
  function pRenderItems() {
    fillOptions($("pItem"), pOptions()[$("pCategory").value] || []);
    pRenderReasonBrowser(false);
  }
  $("pKind").addEventListener("change", pRenderCategories);
  $("pCategory").addEventListener("change", pRenderItems);
  $("pItem").addEventListener("change", () => pRenderReasonBrowser(false));
  $("pSearch").addEventListener("input", () => pRenderReasonBrowser(false));
  $("pIds").addEventListener("input", pCheckStudents);

  function pRenderReasonBrowser(edit) {
    const prefix = edit ? "pEdit" : "p", kind = $(prefix + "Kind").value, options = pOptions();
    const category = $(prefix + "Category"), item = $(prefix + "Item");
    const words = $(prefix + "Search").value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const results = $(prefix + "Results"); results.replaceChildren();
    let count = 0, groups = 0;
    const categories = Object.entries(options).filter(([cat]) => cat.startsWith(core.kindPrefix(kind)));
    const makeChoice = (cat, reason, target) => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "reason-choice"; button.textContent = reason;
      button.setAttribute("aria-pressed", String(category.value === cat && item.value === reason));
      button.setAttribute("aria-label", cat + "：" + reason);
      button.addEventListener("click", () => {
        category.value = cat;
        pRenderItems(); item.value = reason; pRenderReasonBrowser(false);
        const pressed = $(prefix + target).querySelector('[aria-pressed="true"]');
        if (pressed) pressed.focus({preventScroll: true});
      });
      return button;
    };
    const favorites = $(prefix + "Favorites"); favorites.replaceChildren();
    let missing = 0;
    favoriteReasons[kind].forEach(label => {
      const matches = categories.flatMap(([cat, items]) => Array.from(new Set(items)).filter(reason => reasonKey(reason) === reasonKey(label)).map(reason => ({cat, reason})));
      if (!matches.length) {
        missing++;
        const button = document.createElement("button");
        button.type = "button"; button.className = "reason-choice"; button.disabled = true; button.textContent = label;
        const note = document.createElement("small"); note.textContent = pTpl ? "範本中未找到此項目" : "請先匯入加扣分範本";
        button.append(note); favorites.append(button);
      } else matches.forEach(({cat, reason}) => {
        const button = makeChoice(cat, reason, "Favorites"), note = document.createElement("small");
        note.textContent = cat; button.append(note); favorites.append(button);
      });
    });
    $(prefix + "FavoriteHint").textContent = !pTpl ? "匯入加扣分範本後，即可點選常用項目。" :
      kind + "常用項目，點選即帶入歸類與事蹟。" + (missing ? " 灰色項目表示範本中未找到相符內容。" : "");
    categories.forEach(([cat, items]) => {
      const matches = items.filter(reason => words.every(word => (cat + " " + reason).toLocaleLowerCase().includes(word)));
      if (!matches.length) return;
      groups++;
      const heading = document.createElement("h3"); heading.textContent = cat; results.append(heading);
      matches.forEach(reason => { count++; results.append(makeChoice(cat, reason, "Results")); });
    });
    $(prefix + "ResultCount").textContent = !pTpl ? "請先匯入加扣分範本，即可瀏覽事蹟說明。" :
      count ? kind + "：共 " + groups + " 個分類、" + count + " 項事蹟。" : words.length ? "找不到符合的事蹟，請更換關鍵字。" : "範本中沒有「" + kind + "」事蹟。";
  }


  /* ───────── 常用狀況：點選即填入「輸入學生」框（手機） ───────── */
  const QUICK_DEFAULTS = [
    ["自訂", []], // 預設放最前面
    ["棉被", ["棉被不整", "棉被不潔", "棉被毛髮"]],
    ["枕頭", ["枕頭不潔", "枕頭毛髮", "枕頭擺放錯誤", "枕下置物"]],
    ["床位", ["床面不潔", "床上違規置物", "床下置物", "床位名牌脫落"]],
    ["內務櫃", ["內務櫃未上鎖", "鎖頭未掛", "底層櫃未關", "底層櫃未靠齊", "櫃體周邊不潔"]],
    ["書桌", ["桌面違規置物", "桌面違規黏貼", "桌燈未關", "書櫃不整", "桌下違規置物"]],
    ["座椅", ["椅子未靠齊", "椅子違規置物"]],
    ["個人區域", ["地板不潔"]],
    ["公共區域", ["窗溝不潔", "桌櫃灰塵", "地板不潔", "鏡面不潔", "設備灰塵", "桌子未對齊", "平台不潔"]],
    ["育五", Array.from({length: 10}, (_, i) => "育五" + (i + 1))],
    ["育六", Array.from({length: 10}, (_, i) => "育六" + (i + 1))]
  ];
  const QUICK_CUSTOM = "自訂"; // 自己新增的其他狀況（不一定是內務），不自動帶入扣分事由
  const QUICK_DIRECT = ["公物"]; // 分類列上直接填入的標籤（不用再展開）
  // 使用者增刪過的分類存在 settings.quickPhrases（本機加密儲存），沒改過的用預設
  const quickItems = cat => {
    const saved = settings.quickPhrases && settings.quickPhrases[cat];
    return Array.isArray(saved) ? saved : (QUICK_DEFAULTS.find(([name]) => name === cat) || [, []])[1];
  };
  // 預設順序：「自訂」→「公物」→ 其他內建分類
  const BUILTIN_CATS = [QUICK_DEFAULTS[0][0]].concat(QUICK_DIRECT, QUICK_DEFAULTS.slice(1).map(([cat]) => cat));
  const customCats = () => Array.isArray(settings.quickCustomCats) ? settings.quickCustomCats : [];
  const hiddenCats = () => Array.isArray(settings.quickHiddenCats) ? settings.quickHiddenCats : [];
  /** 內建內務分類才自動帶入扣分事由；「自訂」與自己新增的分類不帶入 */
  const quickAutoReason = cat => BUILTIN_CATS.includes(cat) && cat !== QUICK_CUSTOM;
  /** 目前顯示的分類（含公物）：照 settings.quickCatOrder 排序，新出現的接在後面，刪掉的不顯示 */
  function quickCatList() {
    const hidden = hiddenCats();
    const names = BUILTIN_CATS.concat(customCats()).filter(cat => !hidden.includes(cat));
    // 一次性調整：已自訂過排序的，也把「公物」移到「自訂」正右邊
    if (Array.isArray(settings.quickCatOrder) && !settings.quickGongwuNext) {
      const o = settings.quickCatOrder.filter(cat => !QUICK_DIRECT.includes(cat)), at = o.indexOf(QUICK_CUSTOM);
      o.splice(at < 0 ? 0 : at + 1, 0, ...QUICK_DIRECT);
      settings.quickCatOrder = o; settings.quickGongwuNext = true; saveSettings();
    }
    const saved = Array.isArray(settings.quickCatOrder) ? settings.quickCatOrder.filter(cat => names.includes(cat)) : [];
    return saved.concat(names.filter(cat => !saved.includes(cat)));
  }
  function deleteQuickCat(cat) {
    if (BUILTIN_CATS.includes(cat)) settings.quickHiddenCats = hiddenCats().concat(cat);
    else {
      settings.quickCustomCats = customCats().filter(name => name !== cat);
      const next = Object.assign({}, settings.quickPhrases); delete next[cat]; settings.quickPhrases = next;
    }
    if (pQuickCat === cat) pQuickCat = null;
    saveSettings(); rebuildAllPhrases();
  }
  function addQuickCat(raw) {
    const name = cleanQuickWord(raw).slice(0, 10);
    if (hiddenCats().includes(name)) settings.quickHiddenCats = hiddenCats().filter(cat => cat !== name); // 刪掉的內建分類：直接恢復
    else if (BUILTIN_CATS.includes(name) || customCats().includes(name)) throw new Error("已經有「" + name + "」這個分類。");
    else settings.quickCustomCats = customCats().concat(name);
    saveSettings(); rebuildAllPhrases();
    return name;
  }
  /** 常用狀況全部還原預設：分類、順序、各分類項目都恢復，自己新增的分類與字詞會刪除 */
  function resetAllQuick() {
    ["quickPhrases", "quickCatOrder", "quickHiddenCats", "quickCustomCats"].forEach(name => { delete settings[name]; });
    pQuickCat = null; saveSettings(); rebuildAllPhrases();
  }
  const quickHasChanges = () => ["quickPhrases", "quickCatOrder", "quickHiddenCats", "quickCustomCats"].some(name => {
    const value = settings[name]; return Array.isArray(value) ? value.length > 0 : value && Object.keys(value).length > 0;
  });
  const quickIsModified = cat => !!(settings.quickPhrases && Array.isArray(settings.quickPhrases[cat]));
  let ALL_PHRASES = new Set();
  const rebuildAllPhrases = () => { ALL_PHRASES = new Set(BUILTIN_CATS.concat(customCats()).flatMap(cat => quickItems(cat)).concat(QUICK_DIRECT)); };
  function setQuickItems(cat, items) {
    settings.quickPhrases = Object.assign({}, settings.quickPhrases, {[cat]: items});
    saveSettings(); rebuildAllPhrases();
  }
  function resetQuickItems(cat) {
    const next = Object.assign({}, settings.quickPhrases); delete next[cat];
    settings.quickPhrases = next; saveSettings(); rebuildAllPhrases();
  }
  /** 檢查新詞：不可空白、不可只有數字（會被當成隊號／學號）、不可含分隔符號 */
  function cleanQuickWord(raw) {
    const word = String(raw || "").normalize("NFKC").replace(/[\s、,，;；:：]+/g, "");
    if (!word) throw new Error("請輸入文字。");
    if (/^[0-9~\-－]+$/.test(word)) throw new Error("不可只有數字，否則會被當成隊號或學號。");
    if (word.length > 20) throw new Error("最多 20 個字。");
    return word;
  }
  const QUICK_REASON = "63.內務不整者";
  let pQuickCat = null, pQuickManage = false, pQuickAdding = false, pQuickMsg = "";
  let pQuickEditCats = false, pQuickResetArmed = false;
  let pReasonTouched = false, pAutoApplied = false;
  // 使用者自己動過類型或事由，就不自動覆蓋
  ["pKind", "pCategory", "pItem"].forEach(id => $(id).addEventListener("change", () => { pReasonTouched = true; }));
  ["pFavorites", "pResults"].forEach(id => $(id).addEventListener("click", event => { if (event.target.closest("button")) pReasonTouched = true; }));

  /*
   * 長按拖拉排序（手機與滑鼠都可用）：按住約 0.4 秒後開始拖曳，放開即儲存。
   * 短按照常是插入文字；按住後馬上滑動則視為捲動頁面，不會拖曳。
   */
  function makeReorderable(container, selector, onDone) {
    let timer = null, start = null, dragEl = null, before = "", suppressUntil = 0, lastDragged = null;
    const keys = () => Array.from(container.querySelectorAll(selector)).map(el => el.dataset.key);
    container.addEventListener("pointerdown", event => {
      const el = event.target.closest(selector);
      if (!el || !container.contains(el) || event.button > 0) return;
      start = {x: event.clientX, y: event.clientY, id: event.pointerId};
      clearTimeout(timer);
      timer = setTimeout(() => {
        dragEl = el; before = keys().join("\n");
        el.classList.add("dragging"); container.classList.add("reordering");
        try { el.releasePointerCapture(start.id); } catch (error) { /* 不支援時略過 */ }
      }, 400);
    });
    let last = null, edgeTimer = null;
    // 分類列可左右捲動：拖到左右邊緣時自動捲動，才能把最後面的拖到最前面
    function edgeScroll() {
      if (!dragEl || !last || container.scrollWidth <= container.clientWidth) { edgeTimer = null; return; }
      const r = container.getBoundingClientRect(), zone = 40;
      const step = last.x < r.left + zone ? -10 : last.x > r.right - zone ? 10 : 0;
      if (step) { container.scrollLeft += step; place(last.x, last.y); }
      edgeTimer = requestAnimationFrame(edgeScroll);
    }
    function place(x, y) {
      const over = document.elementFromPoint(x, y);
      const target = over && over.closest(selector);
      if (!target || target === dragEl || target.parentNode !== dragEl.parentNode) return;
      const r = target.getBoundingClientRect();
      const after = y > r.bottom ? true : y < r.top ? false : x > r.left + r.width / 2;
      target.parentNode.insertBefore(dragEl, after ? target.nextSibling : target);
    }
    container.addEventListener("pointermove", event => {
      if (!dragEl) {
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) { clearTimeout(timer); start = null; }
        return;
      }
      event.preventDefault();
      last = {x: event.clientX, y: event.clientY};
      place(last.x, last.y);
      if (!edgeTimer) edgeTimer = requestAnimationFrame(edgeScroll);
    });
    const end = () => {
      clearTimeout(timer); start = null; last = null;
      if (edgeTimer) { cancelAnimationFrame(edgeTimer); edgeTimer = null; }
      if (!dragEl) return;
      dragEl.classList.remove("dragging"); container.classList.remove("reordering");
      lastDragged = dragEl; dragEl = null; suppressUntil = Date.now() + 400; // 只擋掉放開被拖的那個按鈕時順帶觸發的點擊
      const now = keys();
      if (now.join("\n") !== before) onDone(now);
    };
    container.addEventListener("pointerup", end);
    container.addEventListener("pointercancel", end);
    // 拖曳中不要讓頁面跟著捲動；長按不要跳出系統選單
    container.addEventListener("touchmove", event => { if (dragEl) event.preventDefault(); }, {passive: false});
    container.addEventListener("contextmenu", event => { if (event.target.closest(selector)) event.preventDefault(); });
    container.addEventListener("click", event => {
      if (Date.now() < suppressUntil && lastDragged && lastDragged.contains(event.target)) { event.stopPropagation(); event.preventDefault(); suppressUntil = 0; }
    }, true);
  }
  makeReorderable($("pQuickCats"), "button[data-key]", order => {
    settings.quickCatOrder = order; saveSettings(); renderQuickPhrases();
  });
  makeReorderable($("pQuickItems"), "button[data-key]", order => {
    if (!pQuickCat) return;
    setQuickItems(pQuickCat, order); pQuickMsg = "已調整順序"; renderQuickPhrases();
  });

  const flash = b => { b.classList.add("tapped"); setTimeout(() => b.classList.remove("tapped"), 600); };
  function chip(text, className, onClick) {
    const b = document.createElement("button");
    b.type = "button"; if (className) b.className = className; b.textContent = text;
    b.addEventListener("click", () => onClick(b));
    return b;
  }
  /** 一行輸入框＋按鈕（新增項目／新增分類共用） */
  function addForm(id, placeholder, label, submitText, onAdd, onCancel) {
    const form = document.createElement("form"); form.className = "qp-addform";
    const input = document.createElement("input");
    input.id = id; input.type = "text"; input.maxLength = 20; input.placeholder = placeholder; input.autocomplete = "off";
    input.setAttribute("aria-label", label);
    const ok = document.createElement("button"); ok.type = "submit"; ok.textContent = submitText;
    form.append(input, ok);
    if (onCancel) form.append(chip("取消", "secondary", onCancel));
    form.addEventListener("submit", event => {
      event.preventDefault();
      const typed = input.value;
      try { pQuickMsg = onAdd(typed); renderQuickPhrases(); }
      catch (error) { pQuickMsg = "⚠ " + error.message; renderQuickPhrases(); $(id).value = typed; }
      $(id).focus();
    });
    return form;
  }
  function msgEl() {
    const msg = document.createElement("span");
    msg.className = "qp-msg" + (pQuickMsg.startsWith("⚠") ? " warn" : ""); msg.textContent = pQuickMsg;
    return msg;
  }
  $("pQuickEditCats").addEventListener("click", () => {
    pQuickEditCats = !pQuickEditCats; pQuickCat = null; pQuickManage = false; pQuickAdding = false; pQuickResetArmed = false; pQuickMsg = "";
    renderQuickPhrases();
  });
  function renderQuickPhrases() {
    rebuildAllPhrases();
    const editBtn = $("pQuickEditCats");
    editBtn.textContent = pQuickEditCats ? "完成" : "編輯分類";
    editBtn.classList.toggle("qp-done", pQuickEditCats);
    editBtn.setAttribute("aria-pressed", String(pQuickEditCats));
    const cats = $("pQuickCats"); cats.replaceChildren();
    cats.classList.toggle("editing", pQuickEditCats);
    if (pQuickEditCats) {
      // 編輯分類：點 ✕ 刪除，可長按拖拉排序
      quickCatList().forEach(cat => {
        const b = chip((cat === QUICK_CUSTOM ? "★ 自訂" : cat) + " ✕", "qp-del", () => {
          deleteQuickCat(cat); pQuickResetArmed = false; pQuickMsg = "已刪除分類「" + cat + "」"; renderQuickPhrases();
        });
        b.dataset.key = cat; b.setAttribute("aria-label", "刪除分類 " + cat);
        cats.append(b);
      });
      const box = $("pQuickItems"); box.replaceChildren(); box.hidden = false;
      box.classList.remove("managing");
      const note = document.createElement("span"); note.className = "qp-empty";
      note.textContent = quickCatList().length ? "點分類上的 ✕ 刪除；長按可拖拉排序。" : "目前沒有任何分類，可新增或還原預設。";
      box.append(note);
      box.append(addForm("pQuickNewCat", "新增分類名稱（例如：浴室）", "新增常用狀況分類", "新增分類", typed => {
        const name = addQuickCat(typed); return "已新增分類「" + name + "」";
      }));
      const tools = document.createElement("div"); tools.className = "qp-tools";
      if (quickHasChanges()) tools.append(chip(pQuickResetArmed ? "確定全部還原？" : "還原預設", pQuickResetArmed ? "qp-tool qp-danger" : "qp-tool", () => {
        if (!pQuickResetArmed) { pQuickResetArmed = true; pQuickMsg = "⚠ 會恢復原本的分類、順序與項目，自己新增的分類和字詞會刪除。再按一次確定。"; renderQuickPhrases(); return; }
        resetAllQuick(); pQuickResetArmed = false; pQuickMsg = "常用狀況已全部還原預設"; renderQuickPhrases();
      }));
      if (pQuickMsg) tools.append(msgEl());
      box.append(tools);
      return;
    }
    quickCatList().forEach(cat => {
      if (QUICK_DIRECT.includes(cat)) {
        const direct = chip(cat, "qp-direct", b => { insertQuickPhrase(cat, true); flash(b); });
        direct.dataset.key = cat; cats.append(direct);
        return;
      }
      const b = chip(cat === QUICK_CUSTOM ? "★ 自訂" : cat, "", () => {
        pQuickCat = pQuickCat === cat ? null : cat; pQuickManage = false; pQuickAdding = false; pQuickMsg = "";
        renderQuickPhrases();
      });
      b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(pQuickCat === cat)); b.dataset.cat = cat; b.dataset.key = cat;
      cats.append(b);
    });

    const box = $("pQuickItems"); box.replaceChildren();
    box.hidden = !pQuickCat;
    box.classList.toggle("managing", pQuickManage);
    if (!pQuickCat) return;
    const cat = pQuickCat, items = quickItems(cat);
    items.forEach(text => {
      if (pQuickManage) {
        const b = chip(text + " ✕", "qp-del", () => {
          setQuickItems(cat, quickItems(cat).filter(item => item !== text));
          pQuickMsg = "已刪除「" + text + "」"; renderQuickPhrases();
        });
        b.setAttribute("aria-label", "刪除 " + text); b.dataset.key = text;
        box.append(b);
      } else {
        const b = chip(text, "", b => { insertQuickPhrase(text, quickAutoReason(cat)); flash(b); });
        b.dataset.key = text; box.append(b);
      }
    });
    if (!items.length && !pQuickAdding) {
      const empty = document.createElement("span"); empty.className = "qp-empty";
      empty.textContent = !BUILTIN_CATS.includes(cat) || cat === QUICK_CUSTOM ? "還沒有項目，按「＋ 新增」加入自己常用的字詞。" : "這個分類沒有項目。";
      box.append(empty);
    }
    if (pQuickAdding) box.append(addForm("pQuickNew", "新增到「" + cat + "」", "新增常用狀況到 " + cat, "加入", typed => {
      const word = cleanQuickWord(typed);
      if (quickItems(cat).includes(word)) throw new Error("「" + word + "」已經在這個分類裡。");
      setQuickItems(cat, quickItems(cat).concat(word));
      return "已新增「" + word + "」";
    }, () => { pQuickAdding = false; pQuickMsg = ""; renderQuickPhrases(); }));
    const tools = document.createElement("div"); tools.className = "qp-tools";
    if (!pQuickAdding && !pQuickManage) tools.append(chip("＋ 新增", "qp-tool", () => { pQuickAdding = true; pQuickMsg = ""; renderQuickPhrases(); $("pQuickNew").focus(); }));
    if (!pQuickAdding && items.length) tools.append(chip(pQuickManage ? "完成" : "刪除項目", pQuickManage ? "qp-tool qp-done" : "qp-tool", () => { pQuickManage = !pQuickManage; pQuickMsg = ""; renderQuickPhrases(); }));
    if (pQuickManage && quickAutoReason(cat) && quickIsModified(cat)) tools.append(chip("還原預設", "qp-tool", () => {
      resetQuickItems(cat); pQuickManage = false; pQuickMsg = "「" + cat + "」已還原成預設項目"; renderQuickPhrases();
    }));
    if (pQuickMsg) tools.append(msgEl());
    box.append(tools);
  }
  // 記住游標位置：點常用狀況時插在游標處（手機上點按鈕會讓輸入框失去焦點）
  // 複製輸入框內容（手機版：方便貼到 LINE 公布）
  async function copyText(text) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (error) { /* 改用備援方式 */ }
    const temp = document.createElement("textarea");
    temp.value = text; temp.setAttribute("readonly", ""); temp.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
    document.body.appendChild(temp); temp.select(); temp.setSelectionRange(0, text.length);
    let ok = false; try { ok = document.execCommand("copy"); } catch (error) { ok = false; }
    temp.remove(); return ok;
  }
  let copyTimer = null;
  $("pCopy").addEventListener("click", async () => {
    const btn = $("pCopy");
    const text = $("pIds").value.split("\n").map(line => line.replace(/[ \t\u3000]+$/, "")).join("\n").trim();
    clearTimeout(copyTimer);
    if (!text) { btn.textContent = "沒有內容"; btn.classList.remove("done"); }
    else if (await copyText(text)) { btn.textContent = "已複製 ✓"; btn.classList.add("done"); }
    else { btn.textContent = "無法複製"; btn.classList.remove("done"); }
    copyTimer = setTimeout(() => { btn.textContent = "複製"; btn.classList.remove("done"); }, 1800);
  });
  // 貼上鍵：把剪貼簿內容貼到游標處（沒有游標就接在最後）
  let pasteTimer = null;
  async function pasteInto(input, btn) {
    const done = (label, ok) => { clearTimeout(pasteTimer); btn.textContent = label; btn.classList.toggle("done", !!ok); pasteTimer = setTimeout(() => { btn.textContent = "貼上"; btn.classList.remove("done"); }, 1800); };
    let text = "";
    try { if (navigator.clipboard && navigator.clipboard.readText) text = await navigator.clipboard.readText(); else throw new Error("no clipboard"); }
    catch (error) { input.focus(); done("請長按輸入框貼上"); return; }
    if (!text) { done("剪貼簿是空的"); return; }
    const v = input.value, focused = document.activeElement === input;
    const start = focused ? input.selectionStart : v.length, end = focused ? input.selectionEnd : v.length;
    const ins = !focused && v && !/\n$/.test(v) ? "\n" + text : text;
    input.value = v.slice(0, start) + ins + v.slice(end);
    const pos = start + ins.length; input.focus(); try { input.setSelectionRange(pos, pos); } catch (error) { /* 部分瀏覽器不支援 */ }
    input.dispatchEvent(new Event("input", {bubbles: true}));
    done("已貼上 ✓", true);
  }
  window.pasteInto = pasteInto;
  $("pPaste").addEventListener("click", () => pasteInto($("pIds"), $("pPaste")));
  // 清空鍵：按一次變「確定清空？」，2 秒內再按一次才清空（避免誤觸）
  const clearArmed = new WeakMap();
  function clearInput(input, btn) {
    if (!input.value) { btn.textContent = "已是空的"; clearTimeout(clearArmed.get(btn)); clearArmed.set(btn, setTimeout(() => { btn.textContent = "清空"; }, 1200)); return; }
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1"; btn.textContent = "確定清空？"; btn.classList.add("armed");
      clearTimeout(clearArmed.get(btn));
      clearArmed.set(btn, setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "清空"; btn.classList.remove("armed"); }, 2000));
      return;
    }
    clearTimeout(clearArmed.get(btn)); btn.dataset.armed = ""; btn.textContent = "清空"; btn.classList.remove("armed");
    input.value = ""; input.dispatchEvent(new Event("input", {bubbles: true})); input.focus();
  }
  window.clearInput = clearInput;
  $("pIdsClear").addEventListener("click", () => clearInput($("pIds"), $("pIdsClear")));
  // 常用狀況面板在「加扣分」和「內務」兩個分頁共用：切換分頁時把面板搬過去，點選的字詞填進該分頁的輸入框
  let quickTarget = "pIds";
  const quickCarets = {};
  ["focus", "click", "keyup", "input", "select"].forEach(type => document.addEventListener(type, event => {
    const el = event.target;
    if (el && (el.id === "pIds" || el.id === "dRaw")) quickCarets[el.id] = {start: el.selectionStart, end: el.selectionEnd};
  }, true));
  function placeQuickPanel(tab) {
    const panel = $("pQuick"), slot = $("dQuickSlot");
    if (tab === "dorm" && slot) { if (panel.parentNode !== slot) slot.append(panel); quickTarget = "dRaw"; }
    else if (tab === "points") { if (panel.nextElementSibling !== $("pCheck")) $("pCheck").before(panel); quickTarget = "pIds"; }
    $("pQuickHint").textContent = "";
  }
  function insertQuickPhrase(text, autoReason) {
    const box = $(quickTarget), value = box.value, mark = quickCarets[quickTarget];
    const start = mark ? Math.min(mark.start, value.length) : value.length;
    const end = mark ? Math.min(mark.end, value.length) : value.length;
    let before = value.slice(0, start), after = value.slice(end);
    const trimmed = before.replace(/[ \t\u3000]+$/, "");
    const lastToken = trimmed.split(/[\s、,，]+/).pop();
    if (quickTarget === "dRaw") {
      // 內務公告：一個項目一行；寢室號（育五3）接在同一行後面
      const isRoom = window.DormCore && window.DormCore.normRoom(text);
      if (isRoom) { if (before && !/\s$/.test(before)) before += /育[一二三四五六七八九十\d]+$/.test(trimmed) ? "、" : " "; }
      else if (trimmed && !/\n$/.test(before)) before = trimmed + "\n";
    }
    else if (trimmed && ALL_PHRASES.has(lastToken)) before = trimmed + "、"; // 緊接在另一個常用狀況後：用「、」合併成同一個註記
    else if (before && !/\s$/.test(before)) before += " ";              // 前面是學號或其他文字：補空格
    const insert = text + (/^[ \t\u3000]/.test(after) ? "" : " ");
    box.value = before + insert + after;
    const caret = (before + insert).length;
    box.dispatchEvent(new Event("input", {bubbles: true}));
    box.focus();
    box.setSelectionRange(caret, caret);
    quickCarets[quickTarget] = {start: caret, end: caret};
    if (autoReason !== false && quickTarget === "pIds") autoQuickReason();
  }
  // 這一批還沒動過事由時，自動帶入「扣分｜63.內務不整者」；已手動選過就只提醒、不覆蓋
  function autoQuickReason() {
    const hint = $("pQuickHint");
    hint.className = "qp-hint";
    if (!pTpl) { hint.textContent = ""; return; }
    const isTarget = $("pKind").value === "扣分" && reasonKey($("pItem").value) === reasonKey(QUICK_REASON);
    if (isTarget) { hint.textContent = (pAutoApplied ? "已自動帶入：扣分｜" : "事由：扣分｜") + $("pItem").value + (pAutoApplied ? "（可在下方修改）" : ""); return; }
    if (pReasonTouched) {
      hint.className = "qp-hint warn";
      hint.textContent = "目前事由是「" + $("pKind").value + "｜" + $("pItem").value + "」，與內務缺失不同，請確認是否正確。";
      return;
    }
    const match = Object.entries(pOptions()).filter(([cat]) => cat.startsWith("不良"))
      .flatMap(([cat, items]) => items.filter(item => reasonKey(item) === reasonKey(QUICK_REASON)).map(item => [cat, item]))[0];
    if (!match) {
      hint.className = "qp-hint warn";
      hint.textContent = "範本中找不到「" + QUICK_REASON + "」，請在下方手動選擇事由。";
      return;
    }
    $("pKind").value = "扣分"; pRenderCategories();
    $("pCategory").value = match[0]; pRenderItems(); $("pItem").value = match[1]; pRenderReasonBrowser(false);
    pAutoApplied = true;
    hint.textContent = "已自動帶入：扣分｜" + match[1] + "（可在下方修改）";
  }
  renderQuickPhrases();

  $("pAdd").addEventListener("click", () => {
    const out = $("pError");
    out.style.color = "var(--err)";
    try {
      const result = core.buildPointsRecords($("pIds").value, activeCohort(), otherCohorts(), pTpl, {
        kind: $("pKind").value, score: $("pScore").value, cat: $("pCategory").value, reason: $("pItem").value, detail: $("pDetail").value
      });
      pRecords.push(...result.records);
      pRenderRecords(); saveDrafts();
      pReasonTouched = false; pAutoApplied = false; $("pQuickHint").textContent = ""; // 下一批重新判斷是否自動帶入事由
      out.style.color = "var(--ok)";
      out.textContent = "已新增 " + result.records.length + " 筆紀錄（" + activeCohort().label + "）" +
        (result.warnings.length ? "；以下輸入未新增或已合併：\n" + result.warnings.join("\n") : "。");
      if (result.warnings.length) out.style.color = "var(--warn)";
    } catch (error) {
      out.textContent = error.message + (pRecords.length ? "\n原有 " + pRecords.length + " 筆紀錄已保留。" : "");
    }
  });

  // 只有電腦（滑鼠操作、寬螢幕）才在進入編輯時自動選中第一個欄位
  const autoFocusOK = () => window.matchMedia("(pointer: fine) and (min-width: 1024px)").matches;

  // ── 預覽、勾選、在列上直接編輯 ──
  const pSelected = new Set();
  let pInline = null; // {anchor, targets, original}

  function pUpdateSelection() {
    for (const r of Array.from(pSelected)) if (!pRecords.includes(r)) pSelected.delete(r);
    const n = pSelected.size, visible = pRecords.filter(r => matchesFilter("p", r));
    const all = visible.length > 0 && visible.every(r => pSelected.has(r)), some = !all && visible.some(r => pSelected.has(r));
    $("pSelected").textContent = $("pSelectedBottom").textContent = "已勾選 " + n + " 筆";
    setBulkHint("p", n);
    ["pSelectAll", "pSelectAllBottom"].forEach(id => {
      $(id).disabled = pRecords.length === 0; $(id).checked = all; $(id).indeterminate = some;
    });
    // 勾選多筆時，勾選列上的按鈕會一次處理全部勾選的紀錄（按鈕文字不變，以提示說明）
    $("pRecords").querySelectorAll("button[data-edit-index]").forEach(button => {
      button.title = n > 1 && pSelected.has(pRecords[Number(button.dataset.editIndex)]) ? "將一次編輯勾選的 " + n + " 筆紀錄" : "";
    });
    $("pRecords").querySelectorAll("button[data-delete-index]").forEach(button => {
      button.title = n > 1 && pSelected.has(pRecords[Number(button.dataset.deleteIndex)]) ? "將一次刪除勾選的 " + n + " 筆紀錄" : "";
    });
    updateSelBar();
    $("pRecords").querySelectorAll("input[data-record-index]").forEach(box => {
      box.checked = pSelected.has(pRecords[Number(box.dataset.recordIndex)]);
      box.closest("tr").classList.toggle("selected-record", box.checked);
    });
  }
  function pSelectAll(event) {
    lastTouched.p = null; // 全選時沒有「最後一筆」，懸浮列放在畫面底部
    if (pInline && pInline.targets.length > 1) pCancelInline();
    // 有篩選時，全選只作用在目前看得到的紀錄
    pRecords.filter(r => matchesFilter("p", r)).forEach(r => { if (event.target.checked) pSelected.add(r); else pSelected.delete(r); });
    pUpdateSelection();
  }
  $("pSelectAll").addEventListener("change", pSelectAll);
  $("pSelectAllBottom").addEventListener("change", pSelectAll);

  function pDeleteSelected() {
    const targets = new Set(pRecords.filter(r => pSelected.has(r)));
    if (!targets.size) return;
    const hidden = Array.from(targets).filter(r => !matchesFilter("p", r)).length;
    if (!confirm("確定刪除勾選的 " + targets.size + " 筆紀錄？" + (hidden ? "\n（其中 " + hidden + " 筆目前被篩選隱藏）" : "") + "\n未勾選的紀錄會保留。")) return;
    pCancelInline(false);
    pRecords = pRecords.filter(r => !targets.has(r)); pSelected.clear();
    pRenderRecords(); saveDrafts();
    $("pCount").textContent += "（已刪除 " + targets.size + " 筆紀錄）";
  }

  /* 在預覽列上直接修改「說明、類型、分數、事由」。
     勾選多筆時從勾選列開始編輯：只把「有改動的欄位」套用到全部勾選紀錄，沒改的欄位保留各筆原值。 */
  function pReasonOptions(select, kind, cat, reason) {
    select.replaceChildren(new Option("請選擇事由", ""));
    Object.entries(pOptions()).filter(([c]) => c.startsWith(core.kindPrefix(kind))).forEach(([c, items]) => {
      const group = document.createElement("optgroup"); group.label = c;
      core.unique(items).forEach(item => { const o = new Option(item, c + "\u0001" + item); o.title = c + "：" + item; group.append(o); });
      select.append(group);
    });
    select.value = cat && reason ? cat + "\u0001" + reason : "";
  }
  function pCancelInline(rerender = true) {
    if (!pInline) return;
    if (!pInline.wasExpanded) expanded.p.delete(pInline.anchor); // 取消時恢復編輯前的展開狀態
    pInline = null;
    if (rerender) pRenderRecords();
  }
  function pStartInline(r) {
    if (!pTpl) { alert("請先到「名冊」匯入加扣分範本才能編輯。"); return; }
    if (pInline) pCancelInline();
    const targets = pSelected.size > 1 && pSelected.has(r) ? pRecords.filter(x => pSelected.has(x)) : [r];
    // 勾選的各筆原值不同的欄位，顯示「多個值」：要改就重新選，不動就保留各筆原值
    const same = fn => targets.every(t => fn(t) === fn(r));
    const mixed = {
      detail: !same(t => (t.detail || "").trim()),
      score: !same(t => t.score.toFixed(1)),
      kind: !same(t => t.kind),
      reason: !same(t => t.kind + "\u0001" + t.cat + "\u0001" + t.reason)
    };
    pInline = {anchor: r, targets, mixed, detailDirty: false, wasExpanded: expanded.p.has(r), original: {detail: r.detail || "", kind: r.kind, score: r.score.toFixed(1), key: r.cat + "\u0001" + r.reason}};
    const tr = $("pRecords").querySelector('tr[data-index="' + pRecords.indexOf(r) + '"]');
    if (!tr) return;
    tr.classList.add("inline-editing", "expanded"); expanded.p.add(r);
    targets.forEach(t => { const row = $("pRecords").querySelector('tr[data-index="' + pRecords.indexOf(t) + '"]'); if (row) row.classList.add("edit-target"); });
    const cell = label => tr.querySelector('td[data-label="' + label + '"]');

    const detail = document.createElement("textarea"); detail.className = "inline-field inline-detail"; detail.value = mixed.detail ? "" : r.detail || "";
    if (mixed.detail) detail.placeholder = "（各筆說明不同；不填寫就保留原值）";
    detail.addEventListener("input", () => { pInline.detailDirty = true; });
    detail.setAttribute("aria-label", "說明");
    cell("說明").replaceChildren(detail);
    if (targets.length > 1) {
      const hint = document.createElement("div"); hint.className = "inline-hint";
      hint.textContent = "改動的欄位會套用到勾選的 " + targets.length + " 筆（虛線框）；沒改的欄位保留各筆原值。";
      cell("說明").append(hint);
    }
    const kind = document.createElement("select"); kind.className = "inline-field inline-kind"; kind.setAttribute("aria-label", "類型");
    if (mixed.kind) kind.add(new Option("（多種）", ""));
    ["加分", "扣分"].forEach(k => kind.add(new Option(k, k))); kind.value = mixed.kind ? "" : r.kind;
    cell("類型").replaceChildren(kind);
    const score = document.createElement("select"); score.className = "inline-field inline-score"; score.setAttribute("aria-label", "分數");
    if (mixed.score) score.add(new Option("（多個分數）", ""));
    SCORES.forEach(v => score.add(new Option(v, v))); score.value = mixed.score ? "" : r.score.toFixed(1);
    cell("分數").replaceChildren(score);
    const reason = document.createElement("select"); reason.className = "inline-field inline-reason"; reason.setAttribute("aria-label", "事由");
    const fillReason = (k, cat, item) => {
      if (!k) { reason.replaceChildren(new Option("（多個事由，不變更）", "")); return; }
      pReasonOptions(reason, k, cat, item);
      if (mixed.reason && k === r.kind && !mixed.kind && !cat) reason.options[0].text = "（多個事由，不變更）";
    };
    if (mixed.reason) fillReason(mixed.kind ? "" : r.kind, "", ""); else pReasonOptions(reason, r.kind, r.cat, r.reason);
    const error = document.createElement("div"); error.className = "inline-error"; error.setAttribute("role", "alert");
    cell("事由").replaceChildren(reason, error);
    kind.addEventListener("change", () => {
      if (mixed.reason) fillReason(kind.value, "", "");
      else pReasonOptions(reason, kind.value, r.kind === kind.value ? r.cat : "", r.kind === kind.value ? r.reason : "");
    });

    const actions = tr.querySelector("td.cell-actions");
    const save = document.createElement("button"), cancel = document.createElement("button");
    save.type = "button"; save.className = "inline-save"; save.textContent = "儲存";
    cancel.type = "button"; cancel.className = "secondary inline-cancel"; cancel.textContent = "取消";
    const copy = document.createElement("button");
    copy.type = "button"; copy.className = "secondary inline-copy"; copy.textContent = "複製";
    copy.title = targets.length > 1 ? "在每一筆下方各複製一筆完全相同的紀錄" : "在下方複製一筆完全相同的紀錄";
    actions.replaceChildren(save, cancel, copy);
    copy.addEventListener("click", () => pCopyInline());
    save.addEventListener("click", () => pSaveInline(detail, kind, score, reason, error));
    cancel.addEventListener("click", () => pCancelInline());
    tr.addEventListener("keydown", event => {
      if (!pInline) return;
      if (event.key === "Escape") { event.preventDefault(); pCancelInline(); }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save.click(); }
    });
    if (autoFocusOK()) detail.focus(); // 手機不自動選中，避免一進編輯就跳出鍵盤
  }
  /** 複製：在原紀錄正下方插入一筆完全相同的紀錄（以已儲存的內容為準；編輯中未儲存的修改會放棄） */
  function pCopyInline() {
    if (!pInline) return;
    const targets = pInline.targets.filter(t => pRecords.includes(t));
    pCancelInline(false);
    const copies = [];
    targets.slice().sort((a, b) => pRecords.indexOf(b) - pRecords.indexOf(a)).forEach(t => {
      const clone = JSON.parse(JSON.stringify(t));
      pRecords.splice(pRecords.indexOf(t) + 1, 0, clone);
      copies.unshift(clone);
    });
    pSelected.clear();
    justEdited.p = new Set(copies);
    pRenderRecords(); saveDrafts();
    $("pCount").textContent += "（已複製 " + copies.length + " 筆，新的一筆在原紀錄正下方，以淺藍色標示）";
    if (copies.length === 1) pStartInline(copies[0]); // 單筆：直接編輯新的一筆，方便改成另一個事由
  }
  function pSaveInline(detail, kind, score, reason, error) {
    if (!pInline) return;
    const o = pInline.original, m = pInline.mixed, patch = {};
    // 原值各筆不同的欄位：只要有選／有填就套用（即使和第一筆相同）；原值相同的欄位：和原值不同才套用
    if (m.detail ? pInline.detailDirty : detail.value.trim() !== o.detail.trim()) patch.detail = detail.value.trim();
    if (score.value !== "" && (m.score || score.value !== o.score)) patch.score = Math.round(Number(score.value) * 10) / 10;
    if (m.reason) {
      if (kind.value && !reason.value && (m.kind || kind.value !== o.kind)) { error.textContent = "換類型時請一併選擇事由。"; return; }
      if (kind.value && reason.value) {
        const [cat, item] = reason.value.split("\u0001");
        Object.assign(patch, {kind: kind.value, cat, reason: item});
      }
    } else if (kind.value !== o.kind || reason.value !== o.key) {
      const [cat, item] = reason.value ? reason.value.split("\u0001") : ["", ""];
      Object.assign(patch, {kind: kind.value, cat, reason: item});
    }
    if (!Object.keys(patch).length) { pCancelInline(); return; } // 沒有改動
    const errors = core.validatePointsPatch(pTpl, patch);
    if (errors.length) { error.textContent = errors.join("\n"); return; }
    const targets = pInline.targets.filter(t => pRecords.includes(t));
    targets.forEach(t => Object.assign(t, patch));
    pSelected.clear(); // 儲存後取消勾選
    justEdited.p = new Set(targets);
    targets.forEach(t => expanded.p.delete(t)); // 手機：儲存後卡片收起
    pInline = null;
    pRenderRecords(); saveDrafts();
    $("pCount").textContent += "（已儲存 " + targets.length + " 筆修改，以淺藍色標示）";
  }

  /* ───────── 預覽清單：精簡／完整、依事由分組、篩選 ───────── */
  const filters = {p: {cohort: "", text: "", group: ""}, r: {cohort: "", text: "", group: ""}};
  const expanded = {p: new WeakSet(), r: new WeakSet()};
  const listRecords = prefix => (prefix === "p" ? pRecords : rRecords);
  const listBody = prefix => $(prefix === "p" ? "pRecords" : "rBody");
  const groupKeyOf = {
    p: r => [r.kind, r.cat, r.reason, r.score.toFixed(1)].join("|"),
    r: r => [r.article, r.clause, r.item, r.amount].join("|")
  };
  function groupLabel(prefix, r) {
    if (prefix === "p") return r.kind + "｜" + r.reason + "｜" + r.score.toFixed(1) + " 分";
    return (ARTICLE_LEVELS[r.article] ? r.article + " " + ARTICLE_LEVELS[r.article] : r.article) + "｜" +
      r.clause + (r.item || "") + "｜" + r.amount;
  }
  function matchesFilter(prefix, r) {
    const f = filters[prefix];
    if (f.cohort && r.cohort !== f.cohort) return false;
    if (f.group && groupKeyOf[prefix](r) !== f.group) return false;
    if (f.text) {
      const t = core.normalize(f.text);
      if (![r.name, r.female, r.team, r.school].some(v => core.normalize(v).includes(t))) return false;
    }
    return true;
  }
  function summaryCell(prefix, r, tr) {
    const td = document.createElement("td");
    td.className = "cell-summary"; td.tabIndex = 0; td.setAttribute("role", "button");
    td.setAttribute("aria-label", "展開或收合 " + r.name + " 的詳細內容");
    const line1 = document.createElement("div"); line1.className = "sum-line1";
    const who = document.createElement("span"); who.className = "sum-who";
    who.textContent = (r.female || r.team || "") + " " + r.name;
    const amt = document.createElement("span"), chev = document.createElement("span");
    if (prefix === "p") { amt.className = "sum-amt " + (r.kind === "加分" ? "plus" : "minus"); amt.textContent = (r.kind === "加分" ? "加 " : "扣 ") + r.score.toFixed(1); }
    else { amt.className = "sum-amt"; amt.textContent = r.article + " " + r.amount; }
    chev.className = "sum-chev"; chev.textContent = "›";
    line1.append(cohortTag(r.cohort), who, amt, chev);
    // 小字分兩行完整顯示：事由一行、說明一行（獎懲為獎懲事由與加重減輕）
    const subLine = (label, text) => {
      const div = document.createElement("div"); div.className = "sum-line2";
      const b = document.createElement("span"); b.className = "sum-label"; b.textContent = label + "：";
      div.append(b, document.createTextNode(text));
      return div;
    };
    td.append(line1, subLine("事由", r.reason));
    if (prefix === "p" && r.detail) td.append(subLine("說明", r.detail));
    if (prefix === "r" && r.adjustReason) td.append(subLine("加重減輕", r.adjustReason + (r.adjustAmount ? " " + r.adjustAmount : "")));
    if (expanded[prefix].has(r)) tr.classList.add("expanded");
    const toggle = () => {
      if (expanded[prefix].has(r)) expanded[prefix].delete(r); else expanded[prefix].add(r);
      tr.classList.toggle("expanded", expanded[prefix].has(r));
    };
    td.addEventListener("click", toggle);
    td.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); } });
    return td;
  }
  function renderListTools(prefix) {
    const records = listRecords(prefix), f = filters[prefix];
    const labels = core.unique(records.map(r => r.cohort));
    if (!labels.includes(f.cohort)) f.cohort = "";
    fillOptions($(prefix + "FilterCohort"), labels, "全部期別");
    $(prefix + "FilterCohort").value = f.cohort;
    $(prefix + "FilterCohort").hidden = labels.length < 2 && !f.cohort;
    $(prefix + "FilterBar").hidden = records.length < 2;
    if (records.length < 2) { f.text = ""; f.group = ""; $(prefix + "FilterText").value = ""; }
    if (f.group && !records.some(r => groupKeyOf[prefix](r) === f.group)) f.group = "";
    applyFilter(prefix);
  }
  function renderGroups(prefix) {
    const records = listRecords(prefix), f = filters[prefix], groups = new Map();
    records.forEach(r => {
      const key = groupKeyOf[prefix](r);
      const g = groups.get(key) || {key, label: groupLabel(prefix, r), names: [], count: 0};
      g.count++; if (!g.names.includes(r.name)) g.names.push(r.name);
      groups.set(key, g);
    });
    const box = $(prefix + "Groups");
    box.replaceChildren();
    Array.from(groups.values()).sort((a, b) => b.count - a.count).forEach(g => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "group-item";
      button.setAttribute("aria-pressed", String(f.group === g.key));
      const head = document.createElement("div"); head.className = "g-head";
      const label = document.createElement("span"); label.textContent = g.label;
      const count = document.createElement("span"); count.className = "g-count"; count.textContent = g.count + " 筆";
      head.append(label, count);
      const names = document.createElement("div"); names.className = "g-names";
      names.textContent = g.names.slice(0, 15).join("、") + (g.names.length > 15 ? "…等 " + g.names.length + " 人" : "");
      button.append(head, names);
      button.addEventListener("click", () => { f.group = f.group === g.key ? "" : g.key; applyFilter(prefix); });
      box.append(button);
    });
    $(prefix + "GroupsBox").hidden = !records.length;
    $(prefix + "GroupsTitle").textContent = "依事由分組（" + groups.size + " 組，點一組可只看該組）";
  }
  function applyFilter(prefix) {
    const records = listRecords(prefix), f = filters[prefix];
    let shown = 0;
    Array.from(listBody(prefix).children).forEach(tr => {
      const r = records[Number(tr.dataset.index)];
      const ok = !!r && matchesFilter(prefix, r);
      tr.hidden = !ok; if (ok) shown++;
    });
    const active = !!(f.cohort || f.text || f.group);
    $(prefix + "FilterInfo").textContent = active ? "目前顯示 " + shown + " / " + records.length + " 筆；匯出時仍包含全部 " + records.length + " 筆。" : "";
    $(prefix + "FilterClear").hidden = !active;
    renderGroups(prefix);
    if (prefix === "p") pUpdateSelection(); else rUpdateSelection();
  }
  ["p", "r"].forEach(prefix => {
    $(prefix + "FilterCohort").addEventListener("change", () => { filters[prefix].cohort = $(prefix + "FilterCohort").value; applyFilter(prefix); });
    $(prefix + "FilterText").addEventListener("input", () => { filters[prefix].text = $(prefix + "FilterText").value.trim(); applyFilter(prefix); });
    $(prefix + "FilterClear").addEventListener("click", () => {
      Object.assign(filters[prefix], {cohort: "", text: "", group: ""});
      $(prefix + "FilterCohort").value = ""; $(prefix + "FilterText").value = "";
      applyFilter(prefix);
    });
  });
  function applyViewMode() {
    const mode = settings.viewMode === "full" ? "full" : "compact";
    document.querySelectorAll(".tablewrap.records").forEach(el => el.classList.toggle("compact", mode === "compact"));
    document.querySelectorAll(".view-seg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === mode)));
  }
  document.querySelectorAll(".view-seg button").forEach(b => b.addEventListener("click", () => {
    settings.viewMode = b.dataset.view; saveSettings(); applyViewMode();
  }));
  applyViewMode();
  window.addEventListener("scroll", () => { $("toTop").hidden = window.scrollY < 700; }, {passive: true});
  $("toTop").addEventListener("click", () => window.scrollTo({top: 0, behavior: "smooth"}));

  function cohortSummary(records) {
    const counts = new Map();
    records.forEach(r => counts.set(r.cohort, (counts.get(r.cohort) || 0) + 1));
    return counts.size > 1 ? "（" + Array.from(counts).map(([label, n]) => label + " " + n + " 筆").join("、") + "）" : "";
  }

  function pRenderRecords() {
    pInline = null; // 重新繪製時放棄未儲存的列內編輯
    $("pCount").textContent = pRecords.length ? "本次共 " + pRecords.length + " 筆" + cohortSummary(pRecords) : "尚無紀錄";
    $("pRecords").replaceChildren();
    pRecords.forEach((r, i) => {
      const tr = document.createElement("tr"); tr.dataset.index = i;
      if (justEdited.p.has(r)) tr.classList.add("just-edited");
      const selectCell = document.createElement("td"), box = document.createElement("input");
      box.type = "checkbox"; box.dataset.recordIndex = i;
      box.setAttribute("aria-label", "勾選第 " + (i + 1) + " 筆：" + (r.female || "") + " " + r.name);
      box.addEventListener("change", () => {
        if (pInline && pInline.targets.length > 1) pCancelInline();
        if (box.checked) pSelected.add(r); else pSelected.delete(r); pUpdateSelection();
      });
      selectCell.className = "cell-select"; selectCell.append(box); tr.append(selectCell);
      tr.append(summaryCell("p", r, tr));
      const cohortCell = document.createElement("td"); cohortCell.className = "cell-cohort"; cohortCell.append(cohortTag(r.cohort)); tr.append(cohortCell);
      [["女生隊號", r.female, "nowrap"], ["建制隊號", r.team, "nowrap"], ["姓名", r.name, "nowrap cell-name"], ["說明", r.detail || "", "wrap"], ["學籍號碼", r.school, "nowrap"], ["類型", r.kind, "nowrap"], ["分數", r.score.toFixed(1), "nowrap"], ["事由", r.reason, "wrap"]].forEach(([label, text, cls]) => {
        const td = document.createElement("td"); td.className = cls; td.dataset.label = label; td.textContent = text; tr.appendChild(td);
      });
      const td = document.createElement("td"); td.className = "nowrap cell-actions";
      const edit = document.createElement("button"), del = document.createElement("button");
      edit.type = "button"; edit.textContent = "編輯"; edit.dataset.editIndex = i;
      edit.addEventListener("click", () => pStartInline(r));
      del.type = "button"; del.textContent = "刪除"; del.className = "danger"; del.dataset.deleteIndex = i;
      del.addEventListener("click", () => {
        if (pSelected.size > 1 && pSelected.has(r)) { pDeleteSelected(); return; }
        pRecords.splice(pRecords.indexOf(r), 1); pSelected.delete(r); pRenderRecords(); saveDrafts();
      });
      td.append(edit, del); tr.prepend(td); tr.prepend(selectCell); // 勾選 → 操作 在最左邊（手機卡片的按鈕仍排在底部）
      $("pRecords").appendChild(tr);
    });
    $("pExport").disabled = !pRecords.length;
    $("pClear").disabled = !pRecords.length;
    renderListTools("p"); updateTabCounts();
  }

  $("pClear").addEventListener("click", () => {
    if (!confirm("確定清空全部 " + pRecords.length + " 筆加扣分紀錄？")) return;
    pRecords = []; pSelected.clear(); pInline = null; pRenderRecords(); saveDrafts();
    $("pError").textContent = "";
  });
  $("pExport").addEventListener("click", () => {
    const out = $("pError");
    try {
      if (!pTpl) throw new Error("請先到「名冊」匯入加扣分範本");
      if (!pRecords.length) throw new Error("尚無紀錄");
      const bytes = core.exportPointsWorkbook(pTpl.bytes, pRecords, X, window);
      download(bytes, "加扣分APP匯入_" + stampDash() + ".xlsx");
      out.style.color = "var(--ok)"; out.textContent = "已下載 " + pRecords.length + " 筆紀錄。確認匯入學校系統成功後，可按「清空紀錄」。";
    } catch (error) { out.style.color = "var(--err)"; out.textContent = "匯出失敗：" + error.message; }
  });

  /* ═══════════ 獎懲分頁 ═══════════ */

  const rT = () => (rTpl ? rTpl.parsed : null);
  const rSelectedRows = new Set();

  // 按鈕一律可按；缺名冊或範本時，按下後會以紅字說明缺什麼（避免重新開啟後按鈕停用卻不知原因）
  function rRefreshAddState() { $("rAdd").disabled = false; }
  function rCheckStudents() { renderCheck($("rCheck"), $("rIds").value, "reward"); }
  $("rIds").addEventListener("input", rCheckStudents);

  function rResetRuleControls() {
    const t = rT();
    fillLabeled($("rArticle"), t ? articleChoices(t) : [], t ? "請選擇條" : "請先匯入獎懲範本");
    fillOptions($("rClause"), [], "請先選擇條");
    fillOptions($("rItem"), [], "請先選擇款");
    $("rAmount").value = "";
    fillOptions($("rAdjustReason"), t ? t.adjustmentOptions : [], "無（選填）");
    fillOptions($("rAdjustAmount"), t ? t.amountOptions : [], "無（選填）");
    $("rArticle").disabled = !t;
    ["rClause", "rItem", "rAmount", "rAdjustReason", "rAdjustAmount"].forEach(id => { $(id).disabled = true; });
    $("rReason").value = ""; $("rReason").disabled = true;
  }
  function rSyncRuleDetails() {
    const t = rT();
    const rule = t && t.rules.find(row => row.article === $("rArticle").value && row.clause === $("rClause").value && row.item === $("rItem").value);
    $("rReason").value = rule ? rule.reason : "";
    $("rReason").disabled = !rule; $("rAmount").disabled = !rule; $("rAdjustReason").disabled = !rule;
    $("rAmount").value = rule ? t.defaultAmounts[rule.article] || "" : "";
    $("rAdjustReason").value = ""; $("rAdjustAmount").value = ""; $("rAdjustAmount").disabled = true;
  }
  $("rArticle").addEventListener("change", () => {
    const t = rT(), article = $("rArticle").value;
    fillLabeled($("rClause"), article ? clauseChoices(t, article) : [], article ? "請選擇款" : "請先選擇條");
    $("rClause").disabled = !article;
    fillOptions($("rItem"), [], "請先選擇款"); $("rItem").disabled = true;
    rSyncRuleDetails();
  });
  $("rClause").addEventListener("change", () => {
    const relevant = rT().rules.filter(rule => rule.article === $("rArticle").value && rule.clause === $("rClause").value);
    const items = itemChoices(relevant);
    fillLabeled($("rItem"), items, items.length ? "請選擇目" : relevant.length ? "無目（不需選擇）" : "請先選擇款");
    $("rItem").disabled = !items.length;
    rSyncRuleDetails();
  });
  $("rItem").addEventListener("change", rSyncRuleDetails);
  $("rAdjustReason").addEventListener("change", () => {
    $("rAdjustAmount").disabled = !$("rAdjustReason").value;
    if (!$("rAdjustReason").value) $("rAdjustAmount").value = "";
  });

  const REWARD_LABELS = {school: "學號", name: "姓名", article: "條", clause: "款", item: "目", reason: "獎懲事由", amount: "額度", adjustReason: "加重減輕事由", adjustAmount: "加重減輕額度"};
  function rReport(message, kind) { status("rResult", message, kind); }

  $("rAdd").addEventListener("click", () => {
    try {
      const selection = Object.fromEntries([["article", "rArticle"], ["clause", "rClause"], ["item", "rItem"], ["reason", "rReason"], ["adjustReason", "rAdjustReason"], ["adjustAmount", "rAdjustAmount"]].map(([key, id]) => [key, $(id).value]));
      const result = core.buildRewardRecords($("rIds").value, activeCohort(), otherCohorts(), rT(), selection);
      rRecords = rRecords.concat(result.records);
      rRender(); saveDrafts();
      const skipped = result.resolved.errors.length;
      rReport("已新增 " + result.records.length + " 筆紀錄（" + activeCohort().label + "）；目前共 " + rRecords.length + " 筆，可直接匯出。" +
        (skipped ? "\n已略過 " + skipped + " 筆無法辨識的輸入，請看上方紅字。" : ""), skipped ? "warning" : "ok");
    } catch (error) {
      rReport("新增失敗：" + error.message + (rRecords.length ? "\n原有 " + rRecords.length + " 筆紀錄已保留。" : ""), "error");
    }
  });
  $("rClearInput").addEventListener("click", () => {
    $("rIds").value = ""; rResetRuleControls(); rCheckStudents();
    rReport(rRecords.length ? "已清除上方輸入；原有 " + rRecords.length + " 筆紀錄保留。" : "已清除輸入。");
  });

  function rUpdateSelection() {
    const n = rSelectedRows.size, total = rRecords.length;
    const visible = rRecords.map((r, i) => i).filter(i => matchesFilter("r", rRecords[i]));
    const allVisible = visible.length > 0 && visible.every(i => rSelectedRows.has(i)), someVisible = !allVisible && visible.some(i => rSelectedRows.has(i));
    $("rSelected").textContent = $("rSelectedBottom").textContent = "已勾選 " + n + " / " + total + " 筆";
    setBulkHint("r", n);
    ["rSelectAll", "rSelectAllBottom"].forEach(id => {
      $(id).disabled = !total; $(id).checked = allVisible; $(id).indeterminate = someVisible;
    });
    $("rBody").querySelectorAll("button[data-edit-index]").forEach(button => {
      button.title = n > 1 && rSelectedRows.has(Number(button.dataset.editIndex)) ? "將一次編輯勾選的 " + n + " 筆紀錄" : "";
    });
    $("rBody").querySelectorAll("button[data-delete-index]").forEach(button => {
      button.title = n > 1 && rSelectedRows.has(Number(button.dataset.deleteIndex)) ? "將一次刪除勾選的 " + n + " 筆紀錄" : "";
    });
    updateSelBar();
    $("rClearRecords").disabled = !total;
    updateBatchClear();
    $("rExport").disabled = !total;
  }
  function rUpdateDuplicates() {
    const duplicates = core.duplicateStudents(rRecords);
    $("rDup").hidden = !duplicates.length;
    $("rDup").textContent = duplicates.length ? "重複學生提醒（各筆均會保留及匯出）\n" +
      duplicates.map(s => s.name + "（" + s.cohort + "，學號 " + s.school + "）：共 " + s.count + " 筆，重複 " + (s.count - 1) + " 次。").join("\n") : "";
  }
  function rRender() {
    rInline = null; // 重新繪製時放棄未儲存的列內編輯
    for (const i of Array.from(rSelectedRows)) if (i >= rRecords.length) rSelectedRows.delete(i);
    $("rBody").replaceChildren();
    rRecords.forEach((record, index) => {
      const row = document.createElement("tr"); row.dataset.index = index;
      const selectCell = document.createElement("td"), label = document.createElement("label"), checkbox = document.createElement("input");
      label.className = "check-label"; checkbox.type = "checkbox";
      checkbox.checked = rSelectedRows.has(index);
      checkbox.setAttribute("aria-label", "選取 " + record.name + "（" + record.school + "）");
      checkbox.addEventListener("change", () => {
        if (rInline && rInline.targets.length > 1) { rCancelInline(); }
        if (checkbox.checked) rSelectedRows.add(index); else rSelectedRows.delete(index);
        const current = $("rBody").querySelector('tr[data-index="' + index + '"]');
        if (current) current.classList.toggle("selected-record", rSelectedRows.has(index));
        rUpdateSelection();
      });
      label.append(checkbox); selectCell.className = "cell-select"; selectCell.append(label); row.append(selectCell);
      row.append(summaryCell("r", record, row));
      row.classList.toggle("selected-record", checkbox.checked);
      if (justEdited.r.has(record)) row.classList.add("just-edited");
      const actionCell = document.createElement("td"); actionCell.className = "nowrap cell-actions";
      const edit = document.createElement("button"), remove = document.createElement("button");
      edit.type = "button"; edit.textContent = "編輯"; edit.disabled = !rTpl; edit.dataset.editIndex = index;
      edit.addEventListener("click", () => {
        rStartInline(index);
      });
      remove.type = "button"; remove.className = "danger"; remove.textContent = "刪除"; remove.dataset.deleteIndex = index;
      remove.addEventListener("click", () => {
        if (rSelectedRows.size > 1 && rSelectedRows.has(index)) rDeleteSelected(); else rDelete(index);
      });
      actionCell.append(edit, remove); row.prepend(actionCell); row.prepend(selectCell);
      const cohortCell = document.createElement("td"); cohortCell.className = "cell-cohort"; cohortCell.append(cohortTag(record.cohort)); row.append(cohortCell);
      core.rewardFields.forEach(field => {
        const cell = document.createElement("td");
        cell.className = (field === "reason" || field === "adjustReason" ? "wrap" : "nowrap") + (field === "name" ? " cell-name" : "");
        cell.dataset.label = REWARD_LABELS[field];
        cell.textContent = record[field] || "";
        row.append(cell);
      });
      $("rBody").append(row);
    });
    rUpdateDuplicates(); renderListTools("r"); updateTabCounts();
  }
  function rDelete(index) {
    if (!rRecords[index]) return;
    rRecords = rRecords.filter((r, i) => i !== index);
    const next = Array.from(rSelectedRows).filter(i => i !== index).map(i => i > index ? i - 1 : i);
    rSelectedRows.clear(); next.forEach(i => rSelectedRows.add(i));
    rRender(); saveDrafts();
    rReport(rRecords.length ? "已刪除 1 筆紀錄；目前共 " + rRecords.length + " 筆。" : "已刪除最後一筆紀錄；可再次批次新增。", "ok");
  }
  ["rSelectAll", "rSelectAllBottom"].forEach(id => $(id).addEventListener("change", () => {
    const checked = $(id).checked;
    lastTouched.r = null;
    rRecords.forEach((r, i) => { if (!matchesFilter("r", r)) return; if (checked) rSelectedRows.add(i); else rSelectedRows.delete(i); });
    rRender();
  }));
  function rDeleteSelected() {
    const targets = new Set(rSelectedRows);
    if (!targets.size) return;
    const hidden = Array.from(targets).filter(i => rRecords[i] && !matchesFilter("r", rRecords[i])).length;
    if (!confirm("確定刪除勾選的 " + targets.size + " 筆獎懲紀錄？" + (hidden ? "\n（其中 " + hidden + " 筆目前被篩選隱藏）" : "") + "\n未勾選的紀錄會保留。")) return;
    rCancelInline(false);
    rRecords = rRecords.filter((r, i) => !targets.has(i));
    rSelectedRows.clear();
    rRender(); saveDrafts();
    rReport("已刪除 " + targets.size + " 筆紀錄；" + (rRecords.length ? "目前共 " + rRecords.length + " 筆。" : "已無紀錄，可再次批次新增。"), "ok");
  }

  $("rClearRecords").addEventListener("click", () => {
    if (!confirm("確定清空全部 " + rRecords.length + " 筆獎懲紀錄？")) return;
    rRecords = []; rSelectedRows.clear(); rRender(); saveDrafts();
    rReport("已清空紀錄；名冊、範本與上方輸入都保留。");
  });
  $("rExport").addEventListener("click", () => {
    try {
      if (!rTpl) throw new Error("請先到「名冊」匯入獎懲範本");
      const workbook = core.exportRewardWorkbook(rRecords, rT(), X);
      const bytes = X.write(workbook, {bookType: "xlsx", type: "array"});
      download(bytes, "獎懲紀錄_" + stampDash().replace(/-/g, "") + ".xlsx");
      rReport("已下載 " + rRecords.length + " 筆紀錄。確認匯入學校系統成功後，可按「清空紀錄」。", "ok");
    } catch (error) { rReport("匯出失敗：" + error.message, "error"); }
  });

  // ── 獎懲：在預覽列上直接編輯 ──
  /* 條、款、目連動；換條款目時自動帶入範本事由與固定額度。
     勾選多筆時從勾選列開始編輯：只把「有改動的欄位」套用到全部勾選紀錄，沒改的欄位保留各筆原值。 */
  let rInline = null; // {anchor, targets, wasExpanded, reasonDirty}
  function rCancelInline(rerender = true) {
    if (!rInline) return;
    const r = rRecords[rInline.anchor];
    if (r && !rInline.wasExpanded) expanded.r.delete(r);
    rInline = null;
    if (rerender) rRender();
  }
  function rStartInline(index) {
    if (!rTpl) { alert("請先到「名冊」匯入獎懲範本才能編輯。"); return; }
    if (rInline) rCancelInline();
    const r = rRecords[index]; if (!r) return;
    const t = rT();
    const targets = rSelectedRows.size > 1 && rSelectedRows.has(index) ? Array.from(rSelectedRows).sort((a, b) => a - b) : [index];
    // 勾選的各筆原值不同的欄位，顯示「多個值」：要改就重新選，不動就保留各筆原值
    const same = fn => targets.every(i => fn(rRecords[i]) === fn(r));
    const mixed = {
      rule: !same(x => [x.article, x.clause, x.item || ""].join("|")),
      reason: !same(x => (x.reason || "").trim()),
      adjust: !same(x => (x.adjustReason || "") + "|" + (x.adjustAmount || ""))
    };
    const KEEP = "\u0002keep";
    rInline = {anchor: index, targets, mixed, wasExpanded: expanded.r.has(r), reasonDirty: false};
    const rowOf = i => $("rBody").querySelector('tr[data-index="' + i + '"]');
    const tr = rowOf(index); if (!tr) return;
    tr.classList.add("inline-editing", "expanded"); expanded.r.add(r);
    targets.forEach(i => { const row = rowOf(i); if (row) row.classList.add("edit-target"); });
    const cell = label => tr.querySelector('td[data-label="' + label + '"]');
    const select = (cls, label) => { const el = document.createElement("select"); el.className = "inline-field " + cls; el.setAttribute("aria-label", label); return el; };
    const article = select("inline-article", "條"), clause = select("inline-clause", "款"), item = select("inline-item", "目");
    const adjReason = select("inline-adjreason", "加重減輕事由"), adjAmount = select("inline-adjamount", "加重減輕額度");
    const reason = document.createElement("textarea"); reason.className = "inline-field inline-rreason"; reason.value = mixed.reason ? "" : r.reason || ""; reason.setAttribute("aria-label", "獎懲事由");
    if (mixed.reason) reason.placeholder = "（各筆事由不同；不填寫就保留原值）";
    const amount = document.createElement("span"); amount.className = "inline-amount"; amount.textContent = mixed.rule ? "（多個）" : r.amount || "";
    const error = document.createElement("div"); error.className = "inline-error"; error.setAttribute("role", "alert");

    const fillItems = keep => {
      const relevant = t.rules.filter(x => x.article === article.value && x.clause === clause.value);
      const items = itemChoices(relevant);
      fillLabeled(item, items, items.length ? "請選擇目" : relevant.length ? "無目" : "請先選擇款");
      item.disabled = !items.length;
      if (keep) item.value = r.item || "";
    };
    const fillClauses = keep => {
      fillLabeled(clause, article.value ? clauseChoices(t, article.value) : [], article.value ? "請選擇款" : "請先選擇條");
      if (keep) clause.value = r.clause || "";
      fillItems(keep);
    };
    const syncRule = () => {
      const rule = t.rules.find(x => x.article === article.value && x.clause === clause.value && x.item === item.value);
      amount.textContent = rule ? t.defaultAmounts[rule.article] || "" : "";
      if (!rInline.reasonDirty) reason.value = rule ? rule.reason : "";
    };
    fillLabeled(article, articleChoices(t), mixed.rule ? "（多個條款目，不變更）" : "請選擇條"); article.value = mixed.rule ? "" : r.article;
    fillClauses(!mixed.rule);
    if (mixed.rule) { clause.disabled = true; item.disabled = true; }
    article.addEventListener("change", () => { clause.disabled = !article.value; });
    article.addEventListener("change", () => { fillClauses(false); syncRule(); });
    clause.addEventListener("change", () => { fillItems(false); syncRule(); });
    item.addEventListener("change", syncRule);
    reason.addEventListener("input", () => { rInline.reasonDirty = true; });
    fillOptions(adjReason, t.adjustmentOptions, "無"); adjReason.value = r.adjustReason || "";
    fillOptions(adjAmount, t.amountOptions, "無"); adjAmount.value = r.adjustAmount || "";
    if (mixed.adjust) {
      adjReason.insertBefore(new Option("（多個值，不變更）", KEEP), adjReason.firstChild); adjReason.value = KEEP;
      adjAmount.insertBefore(new Option("（多個值）", KEEP), adjAmount.firstChild); adjAmount.value = KEEP;
    }
    const keepAdj = () => adjReason.value === KEEP;
    adjAmount.disabled = !adjReason.value || keepAdj();
    adjReason.addEventListener("change", () => {
      adjAmount.disabled = !adjReason.value || keepAdj();
      if (keepAdj()) adjAmount.value = KEEP;
      else if (!adjReason.value || adjAmount.value === KEEP) adjAmount.value = "";
    });

    cell("條").replaceChildren(article);
    cell("款").replaceChildren(clause);
    cell("目").replaceChildren(item);
    cell("獎懲事由").replaceChildren(reason);
    if (targets.length > 1) {
      const hint = document.createElement("div"); hint.className = "inline-hint";
      hint.textContent = "改動的欄位會套用到勾選的 " + targets.length + " 筆（虛線框）；沒改的欄位保留各筆原值。";
      cell("獎懲事由").append(hint);
    }
    cell("獎懲事由").append(error);
    cell("額度").replaceChildren(amount);
    cell("加重減輕事由").replaceChildren(adjReason);
    cell("加重減輕額度").replaceChildren(adjAmount);

    const actions = tr.querySelector("td.cell-actions");
    const save = document.createElement("button"), cancel = document.createElement("button");
    save.type = "button"; save.className = "inline-save"; save.textContent = "儲存";
    cancel.type = "button"; cancel.className = "secondary inline-cancel"; cancel.textContent = "取消";
    const copy = document.createElement("button");
    copy.type = "button"; copy.className = "secondary inline-copy"; copy.textContent = "複製";
    copy.title = targets.length > 1 ? "在每一筆下方各複製一筆完全相同的紀錄" : "在下方複製一筆完全相同的紀錄";
    actions.replaceChildren(save, cancel, copy);
    copy.addEventListener("click", () => {
      // 複製：在原紀錄正下方插入一筆完全相同的紀錄（以已儲存的內容為準；未儲存的修改會放棄）
      if (!rInline) return;
      const indexes = rInline.targets.filter(i => rRecords[i]).sort((a, b) => b - a);
      rCancelInline(false);
      const copies = [];
      indexes.forEach(i => { const clone = JSON.parse(JSON.stringify(rRecords[i])); rRecords.splice(i + 1, 0, clone); copies.unshift(clone); });
      rSelectedRows.clear();
      justEdited.r = new Set(copies);
      rRender(); saveDrafts();
      rReport("已複製 " + copies.length + " 筆，新的一筆在原紀錄正下方（以淺藍色標示）；目前共 " + rRecords.length + " 筆。", "ok");
      if (copies.length === 1) rStartInline(rRecords.indexOf(copies[0]));
    });
    cancel.addEventListener("click", () => rCancelInline());
    save.addEventListener("click", () => {
      if (!rInline) return;
      const o = rRecords[rInline.anchor], m = rInline.mixed, patch = {};
      // 原值各筆不同的欄位：只要有選／有填就套用（即使和第一筆相同）；原值相同的欄位：和原值不同才套用
      if (m.rule ? article.value !== "" : article.value !== o.article || clause.value !== o.clause || (item.value || "") !== (o.item || "")) {
        Object.assign(patch, {article: article.value, clause: clause.value, item: item.value});
      }
      if (rInline.reasonDirty && (m.reason || reason.value.trim() !== (o.reason || "").trim())) patch.reason = reason.value;
      if (!keepAdj() && (m.adjust || (adjReason.value || "") !== (o.adjustReason || "") || (adjAmount.value || "") !== (o.adjustAmount || ""))) {
        patch.adjustReason = adjReason.value;
        patch.adjustAmount = adjReason.value ? adjAmount.value : "";
      }
      if (!Object.keys(patch).length) { rCancelInline(); return; } // 沒有改動
      try {
        const indexes = rInline.targets.filter(i => rRecords[i]);
        const before = rRecords;
        rRecords = core.editRewardRecords(rRecords, indexes, rT(), patch);
        rRecords.forEach((r, i) => { if (r !== before[i] && prevSet.r.has(before[i])) prevSet.r.add(r); }); // 編輯後仍算上次的紀錄
        rSelectedRows.clear(); // 儲存後取消勾選
        justEdited.r = new Set(indexes.map(i => rRecords[i]));
        rInline = null;
        rRender(); saveDrafts();
        rReport("已更新 " + indexes.length + " 筆紀錄（以淺藍色標示）；目前共 " + rRecords.length + " 筆。", "ok");
      } catch (err) { error.textContent = err.message; }
    });
    tr.addEventListener("keydown", event => {
      if (!rInline) return;
      if (event.key === "Escape") { event.preventDefault(); rCancelInline(); }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save.click(); }
    });
    if (autoFocusOK()) article.focus(); // 手機不自動選中，避免一進編輯就跳出下拉選單
  }

  window.addEventListener("pagehide", () => { if (!$("app").hidden) flushDrafts(); });
  boot();
})();
