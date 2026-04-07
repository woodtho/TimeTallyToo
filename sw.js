// TimeTally service worker — satisfies PWA installability and provides
// basic offline resilience for the app shell.
const CACHE = 'timetally-v1';
const SHELL = ['/', '/styles.css', '/manifest.json', '/img/logo.png', '/img/playstore.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .catch(() => {})   // don't block install if a shell asset is missing
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Remove old caches from previous versions
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  // Only handle same-origin GET requests
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) return;

  if (request.mode === 'navigate') {
    // Navigation: network-first, fall back to cached root shell
    e.respondWith(
      fetch(request).catch(() => caches.match('/'))
    );
    return;
  }

  // Assets: cache-first
  e.respondWith(
    caches.match(request).then(cached => cached || fetch(request))
  );
});
