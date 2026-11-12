const CACHE = 'expiry-v4';
const ASSETS = ['./', './index.html', './manifest.json', './icon.svg'];
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); });
self.addEventListener('activate', e => e.waitUntil(self.clients.claim().then(() => caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x))))
)));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // API/CDN은 네트워크 그대로
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
