/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║              COBINAR SERVICE WORKER  v1.0.0                 ║
 * ║              Cobernal Systems — Marc-Arthur Samuel Dalus    ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Strategy:
 *  • Core shell  → Cache First  (instant load on repeat visits)
 *  • Pages       → Stale While Revalidate  (serve cache, refresh in bg)
 *  • Images      → Cache First with expiry  (24h max-age)
 *  • API / CDN   → Network First with cache fallback
 *  • Offline     → Serve /offline.html when network & cache both fail
 */

const APP_VERSION   = 'cobinar-v1.0.0';
const SHELL_CACHE   = `${APP_VERSION}-shell`;
const PAGES_CACHE   = `${APP_VERSION}-pages`;
const IMAGES_CACHE  = `${APP_VERSION}-images`;
const RUNTIME_CACHE = `${APP_VERSION}-runtime`;

/* ── Files to pre-cache on install ──────────────────────────── */
const SHELL_FILES = [
  '/cobinar.html',
  '/about.html',
  '/privacy.html',
  '/manifest.json',
  /* Icons — both themes */
  '/icons/black.png',
  '/icons/black-icon-16.png',
  '/icons/black-icon-48.png',
  '/icons/black-icon-64.png',
  '/icons/black-icon-180.png',
  '/icons/black-icon-192.png',
  '/icons/black-icon-512.png',
  '/icons/white.png',
  '/icons/white-icon-16.png',
  '/icons/white-icon-48.png',
  '/icons/white-icon-64.png',
  '/icons/white-icon-180.png',
  '/icons/white-icon-192.png',
  '/icons/white-icon-512.png',
  '/icons/favicon.ico',
];

/* ── Fonts from Google — runtime cache ──────────────────────── */
const FONT_ORIGINS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

/* ── Helpers ─────────────────────────────────────────────────── */

/** Is this request for a navigation (HTML page)? */
function isNavigation(req) {
  return req.mode === 'navigate' ||
    req.headers.get('Accept')?.includes('text/html');
}

/** Is this request for an image? */
function isImage(req) {
  return req.destination === 'image' ||
    /\.(png|jpg|jpeg|gif|webp|ico|svg)(\?.*)?$/.test(req.url);
}

/** Is this request for a font? */
function isFont(req) {
  return req.destination === 'font' ||
    FONT_ORIGINS.some(o => req.url.startsWith(o));
}

/** Is this a cross-origin CDN request we should cache? */
function isCDN(req) {
  return req.url.includes('api.microlink.io') ||
    req.url.includes('cdnjs.cloudflare.com');
}

/** Clone response and store in a named cache. */
async function cacheResponse(cacheName, req, res) {
  if (!res || res.status !== 200 || res.type === 'opaque') return res;
  const cache = await caches.open(cacheName);
  cache.put(req, res.clone());
  return res;
}

/** Delete all caches except the current version's caches. */
async function cleanOldCaches() {
  const currentCaches = [SHELL_CACHE, PAGES_CACHE, IMAGES_CACHE, RUNTIME_CACHE];
  const allCaches = await caches.keys();
  return Promise.all(
    allCaches
      .filter(name => !currentCaches.includes(name))
      .map(name => {
        console.log(`[SW] Deleting old cache: ${name}`);
        return caches.delete(name);
      })
  );
}

/* ── Lifecycle: Install ───────────────────────────────────────── */
self.addEventListener('install', event => {
  console.log(`[SW] Installing ${APP_VERSION}`);
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => {
        console.log('[SW] Pre-caching shell files');
        // Use { cache: 'reload' } to bypass HTTP cache on install
        return Promise.allSettled(
          SHELL_FILES.map(url =>
            cache.add(new Request(url, { cache: 'reload' })).catch(err => {
              console.warn(`[SW] Failed to cache: ${url}`, err);
            })
          )
        );
      })
      .then(() => {
        console.log('[SW] Shell pre-cached. Skipping wait.');
        return self.skipWaiting();
      })
  );
});

/* ── Lifecycle: Activate ─────────────────────────────────────── */
self.addEventListener('activate', event => {
  console.log(`[SW] Activating ${APP_VERSION}`);
  event.waitUntil(
    cleanOldCaches()
      .then(() => {
        console.log('[SW] Old caches cleaned. Claiming clients.');
        return self.clients.claim();
      })
  );
});

/* ── Lifecycle: Fetch ────────────────────────────────────────── */
self.addEventListener('fetch', event => {
  const req = event.request;

  // Ignore non-GET requests
  if (req.method !== 'GET') return;

  // Ignore chrome-extension requests
  if (req.url.startsWith('chrome-extension://')) return;

  /* ── 1. Shell files → Cache First ─────────────────────────── */
  if (SHELL_FILES.some(f => req.url.endsWith(f))) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => cacheResponse(SHELL_CACHE, req, res));
      })
    );
    return;
  }

  /* ── 2. Fonts → Cache First (long-lived) ──────────────────── */
  if (isFont(req)) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req)
          .then(res => cacheResponse(RUNTIME_CACHE, req, res))
          .catch(() => new Response('', { status: 503 }));
      })
    );
    return;
  }

  /* ── 3. Images → Cache First (24h TTL) ────────────────────── */
  if (isImage(req)) {
    event.respondWith(
      caches.open(IMAGES_CACHE).then(async cache => {
        const cached = await cache.match(req);

        if (cached) {
          // Check if cached image is older than 24h
          const cachedDate = cached.headers.get('sw-cache-date');
          if (cachedDate) {
            const age = Date.now() - parseInt(cachedDate, 10);
            if (age < 86400000) return cached; // under 24h — serve cache
          } else {
            return cached; // No date stored — serve as-is
          }
        }

        try {
          const res = await fetch(req);
          if (res.ok) {
            // Inject our own cache timestamp header
            const headers = new Headers(res.headers);
            headers.set('sw-cache-date', Date.now().toString());
            const dated = new Response(await res.blob(), {
              status: res.status,
              statusText: res.statusText,
              headers,
            });
            cache.put(req, dated.clone());
            return dated;
          }
          return res;
        } catch {
          return cached || new Response('', { status: 503 });
        }
      })
    );
    return;
  }

  /* ── 4. HTML pages → Stale While Revalidate ───────────────── */
  if (isNavigation(req)) {
    event.respondWith(
      caches.open(PAGES_CACHE).then(async cache => {
        const cached = await cache.match(req);

        // Kick off a background fetch regardless
        const networkPromise = fetch(req)
          .then(res => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => null);

        // Return cache immediately if available, else wait for network
        return cached || networkPromise || caches.match('/cobinar.html');
      })
    );
    return;
  }

  /* ── 5. CDN / API → Network First with cache fallback ─────── */
  if (isCDN(req)) {
    event.respondWith(
      fetch(req)
        .then(res => cacheResponse(RUNTIME_CACHE, req, res))
        .catch(() => caches.match(req))
    );
    return;
  }

  /* ── 6. Everything else → Network First ───────────────────── */
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) cacheResponse(RUNTIME_CACHE, req, res.clone());
        return res;
      })
      .catch(() => caches.match(req))
  );
});

/* ── Message: Force update from client ───────────────────────── */
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    console.log('[SW] Force skip waiting received.');
    self.skipWaiting();
  }

  if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: APP_VERSION });
  }

  /* ── Theme change notification ─────────────────────────────── *
   * When the page changes theme (sky / sakura / mint / OS dark), *
   * it can notify the SW to swap the active icon set.            *
   * The SW relays this to all open clients so they can update    *
   * the <link rel="icon"> and apple-touch-icon tags.             *
   * ─────────────────────────────────────────────────────────────*/
  if (event.data?.type === 'THEME_CHANGE') {
    const theme = event.data.theme; // 'light' | 'dark'
    self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
      clients.forEach(client => {
        client.postMessage({ type: 'ICON_UPDATE', theme });
      });
    });
  }
});

/* ── Background Sync: retry failed network requests ──────────── */
self.addEventListener('sync', event => {
  if (event.tag === 'cobinar-sync') {
    console.log('[SW] Background sync triggered.');
    event.waitUntil(
      // Placeholder — wire up to IndexedDB queue if needed
      Promise.resolve()
    );
  }
});

/* ── Push Notifications (placeholder) ───────────────────────── */
self.addEventListener('push', event => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); }
  catch { payload = { title: 'Cobinar', body: event.data.text() }; }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Cobinar', {
      body:  payload.body  || '',
      icon:  '/icons/black-icon-192.png',
      badge: '/icons/black-icon-64.png',
      data:  payload.url || '/',
      vibrate: [100, 50, 100],
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data || '/')
  );
});

console.log(`[SW] ${APP_VERSION} loaded.`);
