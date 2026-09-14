// MeetMemo SW — 네트워크 우선(업데이트 즉시 반영), 실패 시 캐시 (오프라인에서 저장본 열람)
const CACHE = 'meetmemo-v10';
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest', './icon-180.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'no-cache' })))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  e.respondWith(
    // no-cache: HTTP 캐시(GitHub Pages max-age=600)를 건너뛰고 항상 서버 재검증 — index.html과 app.js가 다른 버전으로 섞이는 것 방지
    fetch(e.request, { cache: 'no-cache' }).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
