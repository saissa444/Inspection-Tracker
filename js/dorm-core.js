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
  // 其他棟：樂五3寢、樂5-3 → "樂5-3"（育以外的棟別保留棟名；「育」與沒寫棟名的維持舊格式）
  // 「育」「樂」可省略「寢」；其他棟名（例如 智五3寢）要寫「寢」或「室」才認得，避免誤判項目名稱
  const BUILDINGS = "育樂";
  const BUILDING_NAMES = {"育": "育才樓", "樂": "樂群樓"};
  const buildingOf = key => { const m = /^([^\d]?)\d/.exec(key || ""); return m ? (m[1] || "育") : ""; };
  const NUM = "([一二三四五六七八九十]|\\d{1,2})";
  const ROOM_RE = new RegExp("^([" + BUILDINGS + "]|[\\u4e00-\\u9fff](?=.*[寢室]$))?\\s*" + NUM + "-?(\\d{1,2}|[一二三四五六七八九十])([寢室]?)$");
  // defB：這一期住的棟別（"育" 或 "樂"）；寢室號沒寫棟名（5-3）時算這一棟
  function normRoom(t, defB) {
    t = String(t).trim().replace(/[－–—_]/g, "-");
    let m = t.match(ROOM_RE), b = "";
    if (m) {
      b = m[1] || "";
      if (!b && !/-/.test(t)) return null;            // 沒寫棟名時要用「5-7」格式
      if (b && /[一二三四五六七八九十]/.test(b)) return null;
    } else return null;
    const f = CN[m[2]] || parseInt(m[2], 10), r = CN[m[3]] || parseInt(m[3], 10);
    if (!f || !r || f > 20 || r > 40) return null;
    if (!b) b = defB || "";
    return (b && b !== "育" ? b : "") + f + "-" + r;
  }
  // 顯示用：5-3 → 育五3寢、樂5-3 → 樂五3寢
  function roomLabel(r) {
    const m = /^([^\d]?)(\d{1,2})-(\d{1,2})$/.exec(r || "");
    return m && CNR[+m[2]] ? (m[1] || "育") + CNR[+m[2]] + (+m[3]) + "寢" : (r || "");
  }

  /* ───── 學生號碼 ─────
     roster: [{school, name, female, team}]。回傳以學籍號碼為鍵的查找器；
     查不到的號碼回傳 "?" + 原號碼，讓畫面標示出來。 */
  // others：其他期別 [{label, students}]。建制隊號（6 碼，含期別）也會到其他期別找；
  // 女生隊號（3 碼）各期會重複，只查目前這一期。
  function studentIndex(roster, others) {
    const byFemale = new Map(), byTeam = new Map(), bySchool = new Map(), otherOf = new Map();
    for (const s of roster || []) {
      bySchool.set(s.school, s);
      if (s.female) byFemale.set(String(parseInt(s.female, 10)), s.school);
      if (s.team) byTeam.set(String(parseInt(s.team, 10)), s.school);
    }
    for (const o of others || []) for (const s of o.students || []) {
      if (bySchool.has(s.school)) continue;
      const n = s.team ? String(parseInt(s.team, 10)) : "";
      if (n && !byTeam.has(n)) { byTeam.set(n, s.school); bySchool.set(s.school, s); otherOf.set(s.school, o.label); }
    }
    const norm = t => {
      if (!/^(\d{1,3}|\d{6})$/.test(t)) return null;
      const n = String(parseInt(t, 10));
      const hit = t.length >= 5 ? byTeam.get(n) : byFemale.get(n);
      return hit || ("?" + t);
    };
    return {norm, get: k => bySchool.get(k) || null, otherCohort: k => otherOf.get(k) || null};
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
    else line = line.replace(new RegExp("([^\\s、,，;；:：])(?=[" + BUILDINGS + "][一二三四五六七八九十\\d])", "g"), "$1 ").replace(/([^\d\s、,，;；:：育一二三四五六七八九十\-－])(?=\d{1,2}[-－]\d)/g, "$1 ");
    const toks = line.split(/[\s、,，;；:：。．.!！?？~～]+/).filter(Boolean);
    const split = t => { const j = t.indexOf(MARK); return j < 0 ? [t, ""] : [t.slice(0, j), notes[t.charCodeAt(j + 1) - 0xE100] || ""]; };
    return {toks, split};
  }

  /* ───── 解析整則公告 ─────
     normStu：號碼 → 學籍號碼（查不到回傳 "?xxx"，不是號碼回傳 null）
     回傳 {date, items:[{scope:"p"|"g", item, sign, targets, bad, notes}], ignored, floor} */
  function parseReport(raw, normStu, now, defB) {
    const lines = String(raw || "").split(/\r?\n/);
    let mode = "p", date = null, pending = null, cont = null;
    const items = [], ignored = [], floor = [];
    const dropPending = () => { if (pending && !pending.used) ignored.push(pending.text); pending = null; };
    const roomOf = t => normRoom(t, defB);
    const isTof = m => m === "p" ? normStu : roomOf;
    const hasT = (pp, m) => pp.toks.some(t => isTof(m)(pp.split(t)[0]));
    for (let line of lines) {
      // 全形數字轉半形，去掉看不見的字元
      line = line.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .replace(/[​-‍⁠﻿]/g, "").replace(/　/g, " ").trim();
      if (!line) { cont = null; continue; }
      // 項目後面標分數或處分：床鋪整潔(+0.2)：、枕頭有毛髮(-0.2)：、抽風扇不潔(寢室記大X)：
      let mkSign = null, mkRoom = false;
      const mk = line.match(/^([^()（）:：]*[^\s()（）:：])\s*[（(]\s*([^()（）]*?)\s*[）)]\s*([:：]\s*.*)?$/);
      if (mk && /^[+＋]\s*\d|^[-－−]\s*\d|[xX×Ｘ]|大過|記過|小過|申誡/.test(mk[2])) {
        mkSign = /^[+＋]/.test(mk[2]) ? 1 : -1;
        mkRoom = /寢|室/.test(mk[2]);
        line = mk[1] + "：" + (mk[3] ? mk[3].replace(/^[:：]\s*/, "") : "");
      }
      const signFor = it => mkSign !== null ? mkSign : signOf(it);
      // 開頭的表情符號或符號（📢、【】）不影響日期判讀
      if (!date && !items.length) { const d = parseDate(line.replace(/^[^\d一-鿿]+/, ""), now); if (d) { date = d; pending = null; continue; } }
      // 標題詞和結尾提醒直接略過
      if (/^[（(【\[]?(更正|修正|更新|更新版|內務檢查|內務查察|大掃除|大掃除缺失|大掃除檢查)[）)】\]]?$/.test(line) || /疑義|向我反|告知本人/.test(line)) { cont = null; continue; }
      const sw = line.match(/^(公物|公區|公共區域|公共)\s*[:：]?\s*(.*)$/);
      let lm = mode, P;
      if (sw) {
        const rest = sw[2];
        if (!rest) { dropPending(); mode = "g"; continue; }
        const pg = prepLine(rest, "g"), pp = prepLine(line, "p");
        // 「公區置物 176 153」是個人項目：後面接個人號碼就不切換到公區
        if (!hasT(pg, "g") && hasT(pp, "p")) { lm = "p"; P = pp; }
        else { dropPending(); mode = "g"; lm = "g"; P = pg; }
      } else if (mkRoom) {
        lm = "g"; P = prepLine(line, "g");
      } else {
        P = prepLine(line, lm);
        if (lm === "g" && !hasT(P, "g")) { const pp = prepLine(line, "p"); if (hasT(pp, "p")) { lm = "p"; P = pp; } }
        else if (lm === "p" && !hasT(P, "p")) { const pg = prepLine(line, "g"); if (hasT(pg, "g")) { lm = "g"; P = pg; } }
      }
      const {toks, split} = P, isT = isTof(lm);
      let i = toks.findIndex(t => isT(split(t)[0]));
      // 開頭幾個是「號碼但對不上」（打錯、辨識錯，例如 47041、45l183）：不能當成項目名稱，當成看不懂的號碼
      const numish = t => /^[\dOoIl|]{3,9}$/.test(t) && (t.match(/\d/g) || []).length >= t.length - 1;
      let leadBad = [];
      if (i > 0 && toks.slice(0, i).every(t => { const [n, note] = split(t); return !note && numish(n); })) { leadBad = toks.slice(0, i).map(t => split(t)[0]); toks.splice(0, i); i = 0; }
      let item;
      if (i > 0) { dropPending(); item = toks.slice(0, i).join(" "); }
      else if (i === 0 && pending && pending.mode === lm) { item = pending.text; pending.used = true; if (pending.sign !== null) mkSign = pending.sign; }
      // 上一行的號碼太長換行：整行只有號碼（沒有括號說明），接到上一個項目
      // （打錯的號碼，例如多一碼，也留在這個項目裡標成「看不懂」）
      else if (i === 0 && cont && cont.scope === lm && toks.every(t => { const [n, note] = split(t); return !note && (isT(n) || numish(n)); })) {
        cont.bad.push(...leadBad);
        for (const t of toks) { const n = split(t)[0], k = isT(n); if (k) cont.targets.push(k); else cont.bad.push(n); }
        continue;
      }
      else if (i === 0) {
        // 只有「號碼（說明）」：用括號裡的說明當項目
        const groups = new Map();
        for (const t of toks) {
          const [n, note] = split(t), k = isT(n); if (!k) continue;
          const key = note || "未註明項目"; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(k);
        }
        let first = true;
        for (const [it, ts] of groups) { items.push({scope: lm, item: it, sign: signOf(it), targets: ts, bad: first ? leadBad : [], notes: {}}); first = false; }
        cont = null;
        continue;
      }
      // 「育五廁所」「育六曬衣場」這類樓層公共區域，不屬於任何寢室，不計分
      else if (i < 0 && new RegExp("^[" + BUILDINGS + "][一二三四五六七八九十\\d](?![一二三四五六七八九十\\d\\-－])").test(line)) { dropPending(); cont = null; floor.push(line); continue; }
      else if (i < 0 && /[一-鿿]/.test(line) && line.length <= 20) { dropPending(); cont = null; pending = {text: toks.map(t => split(t)[0]).join(" "), mode: lm, sign: mkSign}; continue; }
      else { cont = null; ignored.push(line); continue; }
      const targets = [], bad = [], tnotes = {};
      for (const t of toks.slice(Math.max(i, 0))) {
        const [n, note] = split(t), k = isT(n);
        if (k) { targets.push(k); if (note) tnotes[k] = note; } else bad.push(n);
      }
      const last = items[items.length - 1];
      if (i === 0 && last && last.item === item && last.scope === lm) { last.targets.push(...targets); last.bad.push(...bad); Object.assign(last.notes, tnotes); cont = last; }
      else { items.push({scope: lm, item, sign: signFor(item), targets, bad, notes: tnotes}); cont = items[items.length - 1]; }
    }
    dropPending();
    return {date, items, ignored, floor};
  }

  /* ───── 寢室名單：一行一間「寢室 號碼 號碼…」───── */
  function parseRooms(text, normStu, defB) {
    const rooms = [], issues = [];
    for (let line of String(text || "").split(/\r?\n/)) {
      line = line.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim();
      if (!line) continue;
      const toks = line.split(/[\s、,，;；:：。]+/).filter(Boolean);
      const room = normRoom(toks[0], defB) || toks[0];
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

  /** 期間統計：每人分數、每間寢室分數、最劣寢／最優寢。
      rooms 可以是寢室名單陣列，或 {roomsAt(date), roomOf(k, date)}：寢室名單會換（外派、換寢），
      每一筆個人優缺點算進「檢查那天」他住的寢室。 */
  function summarize(reports, rooms, from, to) {
    if (rooms && !Array.isArray(rooms)) return summarizeAt(reports, rooms, from, to);
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

  function summarizeAt(reports, R, from, to) {
    const E = entries(reports, from, to);
    const people = new Map(), pub = new Map(), byRoom = new Map();
    const bump = (map, k, e) => { const v = map.get(k) || {score: 0, plus: 0, minus: 0}; v.score += pts(e); if (e.sign > 0) v.plus++; else v.minus++; map.set(k, v); return v; };
    for (const e of E) {
      if (e.scope === "p") {
        bump(people, e.target, e);
        const room = R.roomOf(e.target, e.date);
        if (room) { if (!byRoom.has(room)) byRoom.set(room, new Map()); bump(byRoom.get(room), e.target, e); }
      } else bump(pub, e.target, e);
    }
    const endRooms = R.roomsAt(to);
    const memberOf = new Map(); endRooms.forEach(r => r.members.forEach(k => memberOf.set(k, r.room)));
    // 期間內出現過的寢室：期末名單裡的、有室員分數算進去的、公區有被登記的（與舊版相同）
    const names = Array.from(new Set(endRooms.map(r => r.room).concat(Array.from(byRoom.keys()), Array.from(pub.keys()))));
    const roomRows = names.map(name => {
      const scores = byRoom.get(name) || new Map();
      const end = (endRooms.find(r => r.room === name) || {members: []}).members;
      const members = Array.from(new Set(end.concat(Array.from(scores.keys()))));
      let ms = 0, pp = 0, pm = 0;
      scores.forEach(v => { ms += v.score; pp += v.plus; pm += v.minus; });
      const g = pub.get(name) || {score: 0, plus: 0, minus: 0};
      return {room: name, members, memberScores: scores, mScore: ms, pub: g.score, total: ms + g.score, pp, pm, gp: g.plus, gm: g.minus};
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
  function pointsFromReport(report, cohort, mapping, studentOf, cohortOf) {
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
          cohort: (cohortOf && cohortOf(k)) || cohort.label, school: s.school, name: s.name, female: s.female, team: s.team,
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

  return {CN, P_UNIT, G_UNIT, BUILDINGS, BUILDING_NAMES, buildingOf, normRoom, roomLabel, studentIndex, signOf, parseDate, todayStr, parseReport, parseRooms,
    entries, summarize, pts, fmt, monthRange, rocMonth, pointsFromReport, guessMapping};
});
