// 离线缓存：页面外壳优先用网络、失败时用缓存；实时数据不缓存
const CACHE = "rapid-bus-v4";
const SHELL = ["./", "index.html", "style.css", "app.js", "config.js", "manifest.webmanifest", "icons/icon-192.png", "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // cache: "no-cache" 让浏览器每次向服务器确认是否有新版本，避免更新后还看到旧页面
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then(res => {
    const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res;
  }).catch(() => caches.match(e.request)));
});
