/* 離線快取：只快取程式檔案。學生資料存在 IndexedDB（加密），不經過這裡。 */
const CACHE = "student-records-v20261023h";
const APP = ["./", "./index.html", "./manifest.webmanifest", "./vendor/xlsx.full.min.js?v=0.20.3",
  "./js/core.js?v=20261023h", "./js/store.js?v=20261023h", "./js/dorm-core.js?v=20261023h", "./js/ocr.js?v=20261023h", "./js/dorm.js?v=20261023h", "./js/app.js?v=20261023h",
  "./icons/icon-192.png?v=20261023h", "./icons/icon-512.png?v=20261023h", "./icons/icon-180.png?v=20261023h"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(APP)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("student-records-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// 圖片辨識引擎（約 6 MB）：用到時才下載，存在獨立的快取，App 改版也不用重新下載
const OCR_CACHE = "ocr-engine-tesseract-5.1.1";
// 先上網取最新版，離線時改用快取。
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  if (new URL(req.url).pathname.includes("/vendor/ocr/")) {
    e.respondWith(caches.open(OCR_CACHE).then(c => c.match(req).then(hit => hit || fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }))));
    return;
  }
  const fromCache = () => caches.match(req).then(hit => hit || caches.match("./index.html"));
  // 網站暫時無法連線或檔案不見時，一律改用手機上已存的版本
  e.respondWith(fetch(req).then(res => {
    if (!res.ok) return fromCache().then(hit => hit || res);
    const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy));
    return res;
  }).catch(fromCache));
});
