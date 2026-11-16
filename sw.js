// 오프라인에서도 열리도록 앱 파일을 캐시한다(데이터는 기기 localStorage에만 있음).
const CACHE = 'planpick-v1';
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  "./js/agent.js",
  "./js/app.js",
  "./js/extract.js",
  "./js/ics.js",
  "./js/ledger.js",
  "./js/llm.js",
  "./js/nlu.js",
  "./js/onboarding.js",
  "./js/opportunities.js",
  "./js/report.js",
  "./js/scheduler.js",
  "./js/share.js",
  "./js/state.js",
  './icons/icon-192.png', './icons/icon-512.png',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// 같은 출처 파일: 네트워크 우선(최신 배포 반영), 실패하면 캐시. 외부(API·폰트)는 건드리지 않음.
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
