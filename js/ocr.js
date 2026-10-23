/* 圖片公告文字辨識（Tesseract.js，繁體中文）。圖片只在這台裝置上處理，不會上傳。
   網站版：用到時才載入 vendor/ocr/ 的辨識引擎（第一次約 6 MB，之後由離線快取提供）。
   單機版：引擎已包在檔案裡（window.__OCR_EMBED），直接開檔案也能用。 */
(function () {
  "use strict";
  const BASE = "vendor/ocr/";
  let libPromise = null;

  function loadLib() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (libPromise) return libPromise;
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = BASE + "tesseract.min.js";
      s.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error("辨識元件載入失敗"));
      s.onerror = () => { libPromise = null; reject(new Error("無法載入辨識元件，請確認網路連線後再試一次")); };
      document.head.append(s);
    });
    return libPromise;
  }

  async function createWorker(onStatus) {
    const T = await loadLib();
    const logger = m => { if (onStatus && m && m.status) onStatus(m.status, m.progress || 0); };
    const E = window.__OCR_EMBED;
    let opts;
    if (E) {
      // 單機版：把語言資料、辨識核心和 worker 合成一個 blob（file:// 不能另外載入檔案）
      const pre = "var __L=" + JSON.stringify(E.lang) + ";var __F=self.fetch;self.fetch=function(u,o){if(/chi_tra\\.traineddata/.test(String(u))){var b=atob(__L),a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return Promise.resolve(new Response(a));}return __F.apply(self,arguments);};\n";
      const url = URL.createObjectURL(new Blob([pre + E.core + "\n;\n" + E.worker], {type: "application/javascript"}));
      opts = {workerPath: url, workerBlobURL: false, corePath: "embedded.js", langPath: "embedded", gzip: true, cacheMethod: "none", logger};
    } else {
      const abs = p => new URL(p, location.href).href;
      opts = {workerPath: abs(BASE + "worker.min.js"), corePath: abs(BASE), langPath: abs(BASE), gzip: true, cacheMethod: "none", logger};
    }
    const w = await T.createWorker("chi_tra", 1, opts);
    // 6＝整張當成一個文字區塊；這種公告用這個設定最準
    await w.setParameters({tessedit_pageseg_mode: "6", preserve_interword_spaces: "1"});
    return w;
  }

  async function decode(file) {
    try { return await createImageBitmap(file); }
    catch (e) {
      const url = URL.createObjectURL(file), img = new Image();
      img.src = url;
      try { await img.decode(); return img; } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
  }

  // 縮放到指定寬度，並用 R、G、B 最大值轉灰階：黃色螢光底會變白，字仍然是黑的
  function prep(img, targetW) {
    const w0 = img.width, h0 = img.height;
    const scale = Math.max(0.15, Math.min(3, targetW / w0));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w0 * scale)); c.height = Math.max(1, Math.round(h0 * scale));
    const x = c.getContext("2d");
    x.imageSmoothingQuality = "high";
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(img, 0, 0, c.width, c.height);
    const d = x.getImageData(0, 0, c.width, c.height), a = d.data;
    for (let i = 0; i < a.length; i += 4) { const g = Math.max(a[i], a[i + 1], a[i + 2]); a[i] = a[i + 1] = a[i + 2] = g; }
    x.putImageData(d, 0, 0);
    return c;
  }

  // 辨識結果整理：中文字之間的空白、0. 2 → 0.2、「樂五4寐」這類寢字辨識錯誤、空行
  const CJK = "[\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef]";
  function clean(t) {
    return String(t || "")
      .replace(new RegExp("(" + CJK + ")[ \\t]+(?=" + CJK + ")", "g"), "$1")
      .replace(new RegExp("(" + CJK + ")[ \\t]+(?=[\\x21-\\x7e])", "g"), "$1")
      .replace(new RegExp("([\\x21-\\x7e])[ \\t]+(?=" + CJK + ")", "g"), "$1")
      .replace(/(\d)\.[ \t]+(?=\d)/g, "$1.")
      // 隊號裡被認成英文字母的數字：O→0、l／I／|→1、S→5、B→8（只改 5～8 碼、至少 4 個數字的字串）
      .replace(/(?<![A-Za-z\d])[\dOoIl|SB]{5,8}(?![A-Za-z\d])/g, t => (t.match(/\d/g) || []).length >= 4 ? t.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1").replace(/S/g, "5").replace(/B/g, "8") : t)
      .replace(/([育樂][一二三四五六七八九十])(\d{1,2})(?![\d寢室])[^\s\d、,，:：;；()（）]/g, "$1$2寢")
      .split(/\r?\n/).map(l => l.trim()).filter(Boolean).join("\n");
  }

  /**
   * 辨識圖片。score(text) 回傳 {known, problems}：用名冊檢查號碼對不對，
   * 試幾種縮放大小，留下對得上最多同學的那一次。
   */
  async function recognize(file, score, onStatus) {
    const img = await decode(file);
    const say = (s, p) => onStatus && onStatus(s, p);
    say("準備辨識引擎…", 0);
    const w = await createWorker((status, p) => {
      if (/load|initial/.test(status)) say("準備辨識引擎…", p);
    });
    const widths = [650, 550, 800, 1000, 450];
    let best = null;
    try {
      for (let i = 0; i < widths.length; i++) {
        say("辨識中（第 " + (i + 1) + " 次）…", 0);
        const r = await w.recognize(prep(img, widths[i]));
        const text = clean(r.data.text), s = score(text), val = s.known * 2 - s.problems;
        if (!best || val > best.val) best = {val, text, s};
        if (s.known > 0 && s.problems <= Math.max(2, Math.round(s.known * 0.03))) break;
      }
    } finally {
      await w.terminate().catch(() => {});
      if (img.close) img.close();
    }
    return best ? best.text : "";
  }

  window.DormOCR = {recognize, clean};
})();
