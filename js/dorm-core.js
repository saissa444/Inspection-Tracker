/* 內務檢查：公告辨識與統計（純邏輯，不碰畫面）。所有資料只在本機處理。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DormCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CN = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10};
  const CNR = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  const P_UNIT = 2, G_UNIT = 10;   // 以 0.1 分為單位：個人 0.2、公區 1
  const MARK = "";           // 括號註記的暫存記號

  /* ───── 寢室 ───── */
  // 育五7、育五-7、育五7寢、5-7、育六九（中文寢號）、育五十 → "5-7"
  function normRoom(t) {
    t = String(t).trim().replace(/[－–—_]/g, "-");
    let m = t.match(/^育\s*([一二三四五六七八九十]|\d{1,2})-?(\d{1,2}|[一二三四五六七八九十])[寢室]?$/);
    if (!m) m = t.match(/^(\d{1,2})-(\d{1,2})[寢室]?$/);
    if (!m) return null;
    const f = CN[m[1]] || parseInt(m[1], 10), r = CN[m[2]] || parseInt(m[2], 10);
    return f + "-" + r;
  }
  // 顯示用：5-3 → 育五3寢
  function roomLabel(r) {
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(r || "");
    return m && CNR[+m[1]] ? "育" + CNR[+m[1]] + (+m[2]) + "寢" : (r || "");
  }

  /* ───── 學生號碼 ─────
     roster: [{school, name, female, team}]。回傳以學籍號碼為鍵的查找器；
     查不到的號碼回傳 "?" + 原號碼，讓畫面標示出來。 */
  function studentIndex(roster) {
    const byFemale = new Map(), byTeam = new Map(), bySchool = new Map();
    for (const s of roster || []) {
      bySchool.set(s.school, s);
      if (s.female) byFemale.set(String(parseInt(s.female, 10)), s.school);
      if (s.team) byTeam.set(String(parseInt(s.team, 10)), s.school);
    }
    const norm = t => {
      if (!/^(\d{1,3}|\d{6})$/.test(t)) return null;
      const n = String(parseInt(t, 10));
      const hit = t.length >= 5 ? byTeam.get(n) : byFemale.get(n);
      return hit || ("?" + t);
    };
    return {norm, get: k => bySchool.get(k) || null};
  }

  function signOf(item) {
    if (/不|未|髒|毛髮|亂|缺|沒|破|垃圾|灰/.test(item)) return -1;
    if (/優|整潔|整齊|乾淨|良好|佳|讚/.test(item)) return 1;
    return -1;
  }

  /* ───── 日期 ───── */
  const ymd = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31) ? y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0") : null;
  function todayStr(now) { const t = now || new Date(); return ymd(t.getFullYear(), t.getMonth() + 1, t.getDate()); }
  // 1151019、11509091440、0915、09151030、115/10/19、2026/10/19、20260909、10/19、9/20、10月7日；沒寫年份用當年度
  function parseDate(s, now) {
    const y = (now || new Date()).getFullYear();
    let m;
    if ((m = s.match(/^\s*(20\d{2})(\d{2})(\d{2})(\d{4})?(?!\d)/))) { const d = ymd(+m[1], +m[2], +m[3]); if (d) return d; }
    if ((m = s.match(/^\s*(\d{3})(\d{2})(\d{2})(\d{4})?(?!\d)/))) { const d = ymd(+m[1] + 1911, +m[2], +m[3]); if (d) return d; }
    if ((m = s.match(/^\s*(\d{2})(\d{2})(\d{4})(?!\d)/))) { const d = ymd(y, +m[1], +m[2]); if (d) return d; }
    if ((m = s.match(/(?<!\d)(\d{4})\s*[\/.年]\s*(\d{1,2})\s*[\/.月]\s*(\d{1,2})/))) return ymd(+m[1], +m[2], +m[3]);
    if ((m = s.match(/(?<!\d)(\d{2,3})\s*[\/.年]\s*(\d{1,2})\s*[\/.月]\s*(\d{1,2})/))) return ymd(+m[1] + 1911, +m[2], +m[3]);
    if ((m = s.match(/^\s*(\d{2})(\d{2})(?!\d)/))) { const d = ymd(y, +m[1], +m[2]); if (d) return d; }
    if ((m = s.match(/(?<![\d\/])(\d{1,2})\s*[\/.]\s*(\d{1,2})(?![\d\/])/))) return ymd(y, +m[1], +m[2]);
    if ((m = s.match(/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*[日號]?/))) return ymd(y, +m[1], +m[2]);
    return null;
  }

  /* ───── 一行切成項目和號碼；m = "p" 個人、"g" 公區 ───── */
  function prepLine(line, m) {
    const notes = [];
    // 號碼後面的括號是細項註記：442250（拉鍊朝外）、育六九（空床位）
    line = line.replace(/([\d一二三四五六七八九十][寢室床]?)\s*[（(]([^）)]*)[）)]/g, (x, d, n) => {
      notes.push(n.trim()); return d + MARK + String.fromCharCode(0xE100 + notes.length - 1);
    });
    // 項目名稱和號碼連在一起時切開：底層櫃下不潔446041、窗溝不潔育五7、6-2整潔
    if (m === "p") line = line.replace(/([^\d\s、,，;；:：])(?=\d)/g, "$1 ");
    else line = line.replace(/([^\s、,，;；:：])(?=育[一二三四五六七八九十\d])/g, "$1 ").replace(/([^\d\s、,，;；:：育一二三四五六七八九十\-－])(?=\d{1,2}[-－]\d)/g, "$1 ");
    const toks = line.split(/[\s、,，;；:：。．.!！?？~～]+/).filter(Boolean);
    const split = t => { const j = t.indexOf(MARK); return j < 0 ? [t, ""] : [t.slice(0, j), notes[t.charCodeAt(j + 1) - 0xE100] || ""]; };
    return {toks, split};
  }

  /* ───── 解析整則公告 ─────
     normStu：號碼 → 學籍號碼（查不到回傳 "?xxx"，不是號碼回傳 null）
     回傳 {date, items:[{scope:"p"|"g", item, sign, targets, bad, notes}], ignored, floor} */
  function parseReport(raw, normStu, now) {
    const lines = String(raw || "").split(/\r?\n/);
    let mode = "p", date = null, pending = null;
    const items = [], ignored = [], floor = [];
    const dropPending = () => { if (pending && !pending.used) ignored.push(pending.text); pending = null; };
    const isTof = m => m === "p" ? normStu : normRoom;
    const hasT = (pp, m) => pp.toks.some(t => isTof(m)(pp.split(t)[0]));
    for (let line of lines) {
      // 全形數字轉半形，去掉看不見的字元
      line = line.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .replace(/[​-‍⁠﻿]/g, "").replace(/　/g, " ").trim();
      if (!line) continue;
      // 開頭的表情符號或符號（📢、【】）不影響日期判讀
      if (!date && !items.length) { const d = parseDate(line.replace(/^[^\d一-鿿]+/, ""), now); if (d) { date = d; pending = null; continue; } }
      // 標題詞和結尾提醒直接略過
      if (/^[（(【\[]?(更正|修正|更新|更新版|內務檢查|內務查察|大掃除|大掃除缺失|大掃除檢查)[）)】\]]?$/.test(line) || /疑義|向我反|告知本人/.test(line)) continue;
      const sw = line.match(/^(公物|公區|公共區域|公共)\s*[:：]?\s*(.*)$/);
      let lm = mode, P;
      if (sw) {
        const rest = sw[2];
        if (!rest) { dropPending(); mode = "g"; continue; }
        const pg = prepLine(rest, "g"), pp = prepLine(line, "p");
        // 「公區置物 176 153」是個人項目：後面接個人號碼就不切換到公區
        if (!hasT(pg, "g") && hasT(pp, "p")) { lm = "p"; P = pp; }
        else { dropPending(); mode = "g"; lm = "g"; P = pg; }
      } else {
        P = prepLine(line, lm);
        if (lm === "g" && !hasT(P, "g")) { const pp = prepLine(line, "p"); if (hasT(pp, "p")) { lm = "p"; P = pp; } }
        else if (lm === "p" && !hasT(P, "p")) { const pg = prepLine(line, "g"); if (hasT(pg, "g")) { lm = "g"; P = pg; } }
      }
      const {toks, split} = P, isT = isTof(lm);
      const i = toks.findIndex(t => isT(split(t)[0]));
      let item;
      if (i > 0) { dropPending(); item = toks.slice(0, i).join(" "); }
      else if (i === 0 && pending && pending.mode === lm) { item = pending.text; pending.used = true; }
      else if (i === 0) {
        // 只有「號碼（說明）」：用括號裡的說明當項目
        const groups = new Map();
        for (const t of toks) {
          const [n, note] = split(t), k = isT(n); if (!k) continue;
          const key = note || "未註明項目"; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(k);
        }
        for (const [it, ts] of groups) items.push({scope: lm, item: it, sign: signOf(it), targets: ts, bad: [], notes: {}});
        continue;
      }
      // 「育五廁所」「育六曬衣場」這類樓層公共區域，不屬於任何寢室，不計分
      else if (i < 0 && /^育[一二三四五六七八九十\d](?![一二三四五六七八九十\d\-－])/.test(line)) { dropPending(); floor.push(line); continue; }
      else if (i < 0 && /[一-鿿]/.test(line) && line.length <= 20) { dropPending(); pending = {text: toks.map(t => split(t)[0]).join(" "), mode: lm}; continue; }
      else { ignored.push(line); continue; }
      const targets = [], bad = [], tnotes = {};
      for (const t of toks.slice(Math.max(i, 0))) {
        const [n, note] = split(t), k = isT(n);
        if (k) { targets.push(k); if (note) tnotes[k] = note; } else bad.push(n);
      }
      const last = items[items.length - 1];
      if (i === 0 && last && last.item === item && last.scope === lm) { last.targets.push(...targets); last.bad.push(...bad); Object.assign(last.notes, tnotes); }
      else items.push({scope: lm, item, sign: signOf(item), targets, bad, notes: tnotes});
    }
    dropPending();
    return {date, items, ignored, floor};
  }

  /* ───── 寢室名單：一行一間「寢室 號碼 號碼…」───── */
  function parseRooms(text, normStu) {
    const rooms = [], issues = [];
    for (let line of String(text || "").split(/\r?\n/)) {
      line = line.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim();
      if (!line) continue;
      const toks = line.split(/[\s、,，;；:：。]+/).filter(Boolean);
      const room = normRoom(toks[0]) || toks[0];
      const members = [], unknown = [];
      for (const t of toks.slice(1)) { const k = normStu(t); if (!k) continue; if (k[0] === "?") unknown.push(t); else members.push(k); }
      if (unknown.length) issues.push(roomLabel(room) + " 名冊裡找不到：" + unknown.join("、"));
      if (!members.length && !unknown.length) issues.push("「" + line + "」沒有隊號");
      rooms.push({room, members});
    }
    const seen = new Map();
    for (const r of rooms) for (const k of r.members) {
      if (seen.has(k)) issues.push("同一人出現在 " + roomLabel(seen.get(k)) + " 和 " + roomLabel(r.room));
      else seen.set(k, r.room);
    }
    return {rooms, issues};
  }

  /* ───── 統計 ───── */
  const pts = e => e.sign * (e.scope === "p" ? P_UNIT : G_UNIT);
  const fmt = t => { const v = t / 10; return (v > 0 ? "+" : "") + v.toFixed(1); };

  /** 期間內每一筆優缺點，依日期排序。 */
  function entries(reports, from, to) {
    const out = [];
    for (const r of reports) {
      if (!r.date || r.date < from || r.date > to) continue;
      for (const it of (r.items || [])) for (const t of it.targets) {
        out.push({date: r.date, insp: r.inspector || "", scope: it.scope, item: it.item, sign: it.sign, target: t, note: (it.notes || {})[t] || ""});
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  /** 期間統計：每人分數、每間寢室分數、最劣寢／最優寢。 */
  function summarize(reports, rooms, from, to) {
    const E = entries(reports, from, to);
    const people = new Map(), pub = new Map();
    for (const e of E) {
      if (e.scope === "p") {
        const p = people.get(e.target) || {score: 0, plus: 0, minus: 0};
        p.score += pts(e); if (e.sign > 0) p.plus++; else p.minus++;
        people.set(e.target, p);
      } else {
        const g = pub.get(e.target) || {score: 0, plus: 0, minus: 0};
        g.score += pts(e); if (e.sign > 0) g.plus++; else g.minus++;
        pub.set(e.target, g);
      }
    }
    const memberOf = new Map();
    rooms.forEach(r => r.members.forEach(k => memberOf.set(k, r.room)));
    const names = Array.from(new Set(rooms.map(r => r.room).concat(Array.from(pub.keys()))));
    const roomRows = names.map(name => {
      const members = (rooms.find(r => r.room === name) || {members: []}).members;
      let ms = 0, pp = 0, pm = 0;
      members.forEach(k => { const p = people.get(k); if (p) { ms += p.score; pp += p.plus; pm += p.minus; } });
      const g = pub.get(name) || {score: 0, plus: 0, minus: 0};
      return {room: name, members, mScore: ms, pub: g.score, total: ms + g.score, pp, pm, gp: g.plus, gm: g.minus};
    }).sort((a, b) => a.total - b.total || a.room.localeCompare(b.room, "zh-Hant", {numeric: true}));
    let worst = [], best = [];
    if (roomRows.length) {
      const lo = roomRows[0].total, hi = roomRows[roomRows.length - 1].total;
      if (lo !== hi) { worst = roomRows.filter(r => r.total === lo); best = roomRows.filter(r => r.total === hi); }
    }
    const reps = reports.filter(r => r.date && r.date >= from && r.date <= to);
    return {entries: E, people, rooms: roomRows, worst, best, memberOf, reportCount: reps.length};
  }

  function monthRange(ym) {
    const [y, m] = ym.split("-").map(Number);
    return [ym + "-01", ym + "-" + String(new Date(y, m, 0).getDate()).padStart(2, "0")];
  }
  const rocMonth = ym => { const [y, m] = ym.split("-"); return (+y - 1911) + "年" + (+m) + "月"; };

  /* ───── 轉成加扣分紀錄 ─────
     每一位同學的每一項個人優缺點變成一筆（0.2 分）。公區只算寢室統計，不轉。 */
  function pointsFromReport(report, cohort, mapping, studentOf) {
    const records = [], skipped = [];
    const md = report.date ? (+report.date.slice(5, 7)) + "/" + (+report.date.slice(8, 10)) : "";
    for (const it of report.items || []) {
      if (it.scope !== "p") continue;
      const kind = it.sign > 0 ? "加分" : "扣分";
      const pick = mapping && mapping[kind === "加分" ? "plus" : "minus"];
      for (const k of it.targets) {
        const s = studentOf(k);
        if (!s) { skipped.push(k.replace(/^\?/, "")); continue; }
        if (!pick || !pick.cat || !pick.reason) { skipped.push(k); continue; }
        const note = (it.notes || {})[k];
        records.push({
          cohort: cohort.label, school: s.school, name: s.name, female: s.female, team: s.team,
          kind, score: 0.2, cat: pick.cat, reason: pick.reason,
          detail: md + " 內務檢查：" + it.item + (note ? "（" + note + "）" : ""),
          src: "dorm:" + cohort.id + ":" + report.date
        });
      }
    }
    return {records, skipped};
  }

  /** 從範本選項中猜「內務」相關的事蹟說明。 */
  function guessMapping(options) {
    const pick = prefix => {
      const cats = Object.keys(options || {}).filter(c => c.startsWith(prefix));
      for (const c of cats) { const r = options[c].find(x => /內務/.test(x)); if (r) return {cat: c, reason: r}; }
      return null;
    };
    return {plus: pick("優良"), minus: pick("不良")};
  }

  return {CN, P_UNIT, G_UNIT, normRoom, roomLabel, studentIndex, signOf, parseDate, todayStr, parseReport, parseRooms,
    entries, summarize, pts, fmt, monthRange, rocMonth, pointsFromReport, guessMapping};
});
