// v6 — see the auth/API bypass below. The version bump matters: `activate`
// deletes every cache that is not this one. v5 evicted the poisoned /.auth/me
// entries left behind by v4; v6 evicts the stale manifest.json precached below,
// which is what points at the app icon.
//
// Note the bump alone is NOT enough to change an already-shipped asset: a fresh
// cache re-fetches through the HTTP cache, so a still-fresh long-max-age entry
// comes straight back and gets re-cached. That is why the icons are versioned
// in the filename (icon-512.v2.png) — a new URL cannot have a stale entry.
const CACHE = 'wesworld-v6';
const ASSETS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Auth and API traffic must never be cached or replayed. Both are per-session
  // and change the moment someone signs in or logs anything. Caching /.auth/me
  // is especially destructive: the signed-out response gets replayed after a
  // successful login, so the app decides nobody is signed in and bounces
  // straight back to the login screen, forever.
  if (sameOrigin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.auth/'))) return;

  // Only GETs are cacheable; a POST must always reach the network.
  if (e.request.method !== 'GET') return;

  // HTML: network-first, so a new deploy is picked up immediately.
  // Cache-first here would pin every installed device to the version it
  // first cached and no future deploy would ever reach it.
  if (e.request.mode === 'navigate' || e.request.destination === 'document') {
    e.respondWith(
      fetch(e.request).then(res => {
        const c = res.clone();
        caches.open(CACHE).then(ca => ca.put(e.request, c));
        return res;
      }).catch(() => caches.match(e.request).then(r => r || caches.match('/index.html')))
    );
    return;
  }

  if (e.request.url.includes('fonts.googleapis') || e.request.url.includes('fonts.gstatic')) {
    e.respondWith(
      fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(ca=>ca.put(e.request,c)); return r; })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Static assets (icons, manifest): cache-first is safe, they are versioned by
  // deploy and served with long cache headers anyway.
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      const c = res.clone(); caches.open(CACHE).then(ca=>ca.put(e.request,c)); return res;
    }))
  );
});
