// 네트워크 우선(network-first) 서비스워커: 항상 최신 파일을 먼저 받고, 오프라인일 때만 캐시를 사용
const CACHE = 'expiry-v20';
const ASSETS = ['./', './index.html', './manifest.json', './icon.svg'];
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});
self.addEventListener('activate', e => e.waitUntil(
  self.clients.claim().then(() => caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))))
));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // API/CDN 요청은 그대로 통과
  e.respondWith(
    fetch(e.request, {cache: 'no-cache'})                                     // 브라우저 HTTP 캐시를 우회해 최신본 확인
      .then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request))
  );
});
