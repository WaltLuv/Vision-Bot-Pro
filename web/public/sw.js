// App-shell cache only. Nothing under /api or /livekit-token is ever cached:
// those carry owner-scoped data and the gateway marks them no-store, so serving
// a stale copy could show one person another person's state after a sign-out.
const CACHE = 'visionclaw-shell-v1';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/manifest.webmanifest'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const {request} = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/livekit-token') return;

  // Navigations to the app: network first so a deployed update is picked up,
  // falling back to the cached shell when the phone is offline. Other pages --
  // the Google sign-in page, the preview -- are left alone: caching them as the
  // shell would open them in place of the app.
  if (request.mode === 'navigate') {
    if (url.pathname !== '/') return;
    event.respondWith(fetch(request).then(res => {
      const copy = res.clone();
      void caches.open(CACHE).then(c => c.put('/', copy));
      return res;
    }).catch(() => caches.match('/').then(r => r ?? Response.error())));
    return;
  }

  // Fingerprinted build assets are immutable, so cache-first is safe and makes
  // a cold start on a bad connection instant.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(request).then(hit => hit ?? fetch(request).then(res => {
      const copy = res.clone();
      if (res.ok) void caches.open(CACHE).then(c => c.put(request, copy));
      return res;
    })));
  }
});
