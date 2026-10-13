/* eslint-disable no-undef */
// Incrementing OFFLINE_VERSION will kick off the install event and force
// previously cached resources to be updated from the network.
// This variable is intentionally declared and unused.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const OFFLINE_VERSION = 16;
const CACHE_NAME = 'offline';
// Customize this with a different URL if needed.
const OFFLINE_URL = '/offline.html';

// Next.js emits content-hashed, immutable static assets. Caching them
// cache-first means an installed web app does not re-download the bundle on
// every cold launch after the OS has evicted the HTTP cache.
const STATIC_CACHE = 'static-v1';
// Every deploy ships new content-hashed chunks; the old ones are never
// requested again but would otherwise sit in the cache indefinitely.
const STATIC_CACHE_MAX_ENTRIES = 300;
// Proxied poster and backdrop images. Cache-first with a bounded size so
// repeat views are instant and the origin proxy is not hit again.
const IMAGE_CACHE = 'images-v1';
const IMAGE_CACHE_MAX_ENTRIES = 400;
// Discover rows answer per person: their region and language, what they have
// requested, their own suggestions. v2 dropped copies stored before the cache
// was emptied on every sign-in and sign-out (see SESSION_CHANGES); v3 drops
// copies stored before they were checked to be readable (see readsAsJson).
const DISCOVER_CACHE = 'discover-v3';
const DISCOVER_CACHE_MAX_ENTRIES = 60;

const PRECACHE_CONCURRENCY = 3;

/**
 * Requests that start or end a session. Once one succeeds, the Discover cache
 * belongs to someone else: it is emptied before the page carries on, so the
 * next person on the device never sees the last one's rows or suggestions.
 */
const SESSION_CHANGES =
  /^\/api\/v1\/auth\/(local|plex|jellyfin|jellyfin\/quickconnect\/authenticate|passkey\/login|logout)$/;

/** Changes after which the cached Discover rows are out of date. */
const DISCOVER_CHANGES =
  /^\/api\/v1\/(request|media|blocklist|watchlist)(\/|$)/;

/*
 * Whose Discover rows are cached. A sign-in the worker never saw (made from a
 * page it did not control, such as right after a hard refresh) must not leave
 * the last person's rows to be shown to the next. Every page the server
 * renders says who it was rendered for (X-Seerr-User), and every page load
 * passes through here: when that is not who the rows belong to, they go.
 */
const SESSION_CACHE = 'session-v1';
const DISCOVER_OWNER = '/__sw/discover-owner';

const clearDiscover = async () => {
  await caches.delete(DISCOVER_CACHE).catch(() => undefined);
  const cache = await caches.open(SESSION_CACHE);
  await cache.delete(DISCOVER_OWNER);
};

const checkDiscoverOwner = async (response) => {
  const user = response.headers.get('X-Seerr-User');
  if (user === null) {
    return;
  }
  const cache = await caches.open(SESSION_CACHE);
  const stored = await cache.match(DISCOVER_OWNER);
  const owner = stored ? await stored.text() : null;
  if (owner === user) {
    return;
  }
  if (owner !== null) {
    await caches.delete(DISCOVER_CACHE).catch(() => undefined);
  }
  await cache.put(DISCOVER_OWNER, new Response(user));
};

/** Longest the worker will wait on the network before giving up. */
const NETWORK_TIMEOUT_MS = 20000;

const precacheRouteChunks = async () => {
  try {
    const response = await fetch('/sw-precache.json', { cache: 'no-store' });

    if (!response.ok) {
      return;
    }

    const { files } = await response.json();

    if (!Array.isArray(files) || !files.length) {
      return;
    }

    const cache = await caches.open(STATIC_CACHE);
    const queue = files.slice();

    const worker = async () => {
      while (queue.length) {
        const url = queue.shift();

        try {
          if (!(await cache.match(url))) {
            await cache.add(url);
          }
        } catch {
          // One missing chunk is not a reason to stop warming the rest.
        }
      }
    };

    await Promise.all(
      Array.from({ length: PRECACHE_CONCURRENCY }, () => worker())
    );
  } catch {
    // Precaching is best-effort.
  }
};

/**
 * Responses that mean the server could not be reached at all: gateway errors,
 * and Cloudflare's origin errors (520–527, 530). A plain 500 is deliberately
 * absent — that is Seerr answering, with a bug, not Seerr being unreachable.
 */
const UNREACHABLE_STATUSES = new Set([
  502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530,
]);

/** Rejects if the promise has not settled in time. */
const raceTimeout = (promise, timeoutMs) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

/**
 * The stored offline page, if the worker managed to store one, told what
 * went wrong so it can say so: "network" (no connection at all),
 * "timeout" (no answer in time) or "status:522" (an answer that means the
 * server could not be reached, from Cloudflare or a proxy).
 */
const offlinePage = async (reason) => {
  const cache = await caches.open(CACHE_NAME);
  const stored = await cache.match(OFFLINE_URL);
  if (!stored || !reason) {
    return stored;
  }
  try {
    const html = (await stored.text()).replace(
      '<html lang="en">',
      `<html lang="en" data-reason="${String(reason).replace(/[^a-z0-9:]/gi, '')}">`
    );
    return new Response(html, {
      status: stored.status,
      headers: stored.headers,
    });
  } catch {
    return cache.match(OFFLINE_URL);
  }
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Setting {cache: 'reload'} in the new request will ensure that the
      // response isn't fulfilled from the HTTP cache; i.e., it will be from
      // the network.
      //
      // Never let this reject. If installing fails, the previous worker stays
      // in control — and if that worker is serving a stale app shell, the
      // user is stuck until they reinstall. An offline page is not worth that.
      try {
        await cache.add(new Request(OFFLINE_URL, { cache: 'reload' }));
      } catch {
        // Offline fallback simply will not be available until the next
        // install; everything else proceeds.
      }
    })()
  );
  // Force the waiting service worker to become the active service worker.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Enable navigation preload if it's supported.
      // See https://developers.google.com/web/updates/2017/02/navigation-preload
      if ('navigationPreload' in self.registration) {
        await self.registration.navigationPreload.enable();
      }

      // Drop caches from previous versions of this worker.
      const keep = new Set([
        CACHE_NAME,
        STATIC_CACHE,
        IMAGE_CACHE,
        DISCOVER_CACHE,
        SESSION_CACHE,
      ]);
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => !keep.has(name))
          .map((name) => caches.delete(name))
      );
    })()
  );

  // Tell the active service worker to take control of the page immediately.
  clients.claim();

  // Warming the chunk cache used to start here. On the first launch after a
  // deploy that meant downloading well over a megabyte across six connections
  // while the page was still fetching the data it needs to render anything —
  // on a home-hosted server that starves the page's own requests. The client
  // now asks for it once it has finished loading (see the message handler).
});

/*
 * A trim lists every entry in the cache. Run after each image stored, a page
 * of posters arriving at once meant dozens of listings of hundreds of entries
 * competing with the lookups that serve the posters themselves; one trim per
 * cache every few seconds is plenty.
 */
const TRIM_EVERY_MS = 5000;
const lastTrim = new Map();

const trimCacheSoon = (cacheName, maxEntries) => {
  const now = Date.now();
  if (now - (lastTrim.get(cacheName) ?? 0) < TRIM_EVERY_MS) {
    return undefined;
  }
  lastTrim.set(cacheName, now);
  return trimCache(cacheName, maxEntries);
};

/*
 * When entries were last served from each cache, while this worker runs. The
 * Cache API keeps only the order entries were stored in, so without this a
 * poster on every visit was evicted as soon as it was among the oldest
 * stored. Lost when the worker stops, so it is a best effort: what was used
 * since then is kept over what was not.
 */
const lastUsed = new Map();
const LAST_USED_LIMIT = 2000;

const markUsed = (cacheName, url) => {
  let used = lastUsed.get(cacheName);
  if (!used) {
    used = new Map();
    lastUsed.set(cacheName, used);
  }
  // Re-inserted, so the map stays in order of use, oldest first.
  used.delete(url);
  used.set(url, Date.now());
  if (used.size > LAST_USED_LIMIT) {
    used.delete(used.keys().next().value);
  }
};

const trimCache = async (cacheName, maxEntries) => {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();

  if (keys.length <= maxEntries) {
    return;
  }

  // Least recently used first: entries not served since the worker started,
  // in the order they were stored (the order keys() gives), then the rest
  // by when they were last served.
  const used = lastUsed.get(cacheName) ?? new Map();
  const order = [
    ...keys.filter((request) => !used.has(request.url)),
    ...keys
      .filter((request) => used.has(request.url))
      .sort((a, b) => used.get(a.url) - used.get(b.url)),
  ];
  const excess = order.slice(0, keys.length - maxEntries);
  await Promise.all(excess.map((request) => cache.delete(request)));
};

/**
 * Serve from cache immediately when available and refresh the cached copy in
 * the background; fall back to the network when there is nothing cached.
 * `fetchResponse` lets a navigation reuse its preload response so the
 * refresh does not cost a second request.
 */
/**
 * A fetch that gives up rather than hanging.
 *
 * Without this a request the server never answers leaves the page waiting
 * forever — the shell renders and the content spinner never stops.
 */
const fetchWithTimeout = async (request, timeoutMs = NETWORK_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Whether a response is JSON the page can read. A copy that is not (an
 * empty or cut-off body, or some other page answering in its place) is
 * never stored, and never served: the page cannot draw from it, and served
 * from the cache it would come back every time.
 */
const readsAsJson = async (response) => {
  if (!(response.headers.get('Content-Type') ?? '').includes('json')) {
    return false;
  }

  try {
    const text = await response.clone().text();
    return text.length > 0 && JSON.parse(text) !== null;
  } catch {
    return false;
  }
};

const staleWhileRevalidate = async (
  request,
  cacheName,
  maxEntries,
  fetchResponse,
  keepAlive
) => {
  const cache = await caches.open(cacheName);
  let cached = await cache.match(request);

  if (cached && !(await readsAsJson(cached))) {
    await cache.delete(request).catch(() => undefined);
    cached = undefined;
  }

  const refresh = (async () => {
    try {
      // The preload promise resolves to undefined when preload is unavailable,
      // so it cannot be trusted as the response on its own.
      let response = fetchResponse ? await fetchResponse : undefined;

      if (!response) {
        response = await fetchWithTimeout(request);
      }

      if (
        response &&
        response.ok &&
        response.type !== 'opaqueredirect' &&
        (await readsAsJson(response))
      ) {
        await cache.put(request, response.clone());

        if (maxEntries) {
          trimCache(cacheName, maxEntries);
        }
      }

      return response;
    } catch {
      return undefined;
    }
  })();

  // The worker may be terminated as soon as a response is returned. Without
  // keeping it alive the background refresh never finishes writing, the cache
  // never updates, and every subsequent load serves the same stale copy.
  if (keepAlive) {
    keepAlive(refresh);
  }

  if (cached) {
    return cached;
  }

  const fresh = await refresh;

  if (fresh) {
    return fresh;
  }

  throw new Error('No cached or network response available');
};

const cacheFirst = async (request, cacheName, maxEntries, keepAlive) => {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    markUsed(cacheName, request.url);
    return cached;
  }

  const response = await fetch(request);

  // no-store: a stand-in for now (an image proxy still converting the real
  // one), never to be kept under this address.
  if (
    response &&
    response.ok &&
    !/no-store/i.test(response.headers.get('Cache-Control') ?? '')
  ) {
    markUsed(cacheName, request.url);
    // The worker can be stopped as soon as the response is handed over; keep
    // it alive until the copy is stored, or the next view downloads it again.
    const store = cache
      .put(request, response.clone())
      .then(() =>
        maxEntries ? trimCacheSoon(cacheName, maxEntries) : undefined
      )
      .catch(() => undefined);
    keepAlive?.(store);
  }

  return response;
};

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (
    request.method === 'POST' &&
    url.origin === self.location.origin &&
    SESSION_CHANGES.test(url.pathname)
  ) {
    event.respondWith(
      (async () => {
        const response = await fetch(request);
        if (response.ok) {
          // Emptied, and owned by nobody until the next page says who.
          await clearDiscover().catch(() => undefined);
        }
        return response;
      })()
    );
    return;
  }

  // A request, an approval, a blocklisting or a watchlist change alters what
  // the Discover rows show for a title. The rows are served from the cache
  // first, so without this the page would ask again after a request and be
  // handed the copy that still says "Request". Emptied before the page hears
  // back, the next read of each row goes to the server.
  if (
    request.method !== 'GET' &&
    url.origin === self.location.origin &&
    DISCOVER_CHANGES.test(url.pathname)
  ) {
    event.respondWith(
      (async () => {
        const response = await fetch(request);
        if (response.ok) {
          await caches.delete(DISCOVER_CACHE).catch(() => undefined);
        }
        return response;
      })()
    );
    return;
  }

  if (request.method !== 'GET') {
    return;
  }

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/_next/static/')) {
      event.respondWith(
        cacheFirst(request, STATIC_CACHE, STATIC_CACHE_MAX_ENTRIES, (promise) =>
          event.waitUntil(promise)
        )
      );
      return;
    }

    if (url.pathname.startsWith('/imageproxy/')) {
      event.respondWith(
        cacheFirst(request, IMAGE_CACHE, IMAGE_CACHE_MAX_ENTRIES, (promise) =>
          event.waitUntil(promise)
        )
      );
      return;
    }

    // The watchlist belongs to whoever is signed in; a cached copy keyed by
    // address alone would show the last person's to the next one. The text a
    // page is filtered by is asked for in batches that change as it loads,
    // and each can take seconds while the server looks titles up: caching it
    // only pushes real rows out of the cache, and a timeout here would cut it
    // off. Both go straight to the network.
    if (
      url.pathname.startsWith('/api/v1/discover/') &&
      url.pathname !== '/api/v1/discover/watchlist' &&
      url.pathname !== '/api/v1/discover/search-text'
    ) {
      event.respondWith(
        staleWhileRevalidate(
          request,
          DISCOVER_CACHE,
          DISCOVER_CACHE_MAX_ENTRIES,
          undefined,
          (promise) => event.waitUntil(promise)
        )
      );
      return;
    }
  }

  // We only want to call event.respondWith() if this is a navigation request
  // for an HTML page.
  //
  // Navigations go straight to the network. Caching the HTML meant every
  // deploy risked serving the previous build — which caused a reload loop and
  // a stalled first launch — for a benefit that only showed on a slow
  // connection. Static assets and images are still cached, which is where the
  // real saving is.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          // Network first, always: pages are never served from a cache.
          const response = await raceTimeout(
            (async () =>
              (await event.preloadResponse) || fetch(event.request))(),
            NETWORK_TIMEOUT_MS
          );

          // Behind Cloudflare, a server that is down does not fail the
          // request: Cloudflare answers with its own error page. Show ours
          // for those, but let an ordinary server error through, since
          // "unreachable" would be the wrong message for a bug.
          if (UNREACHABLE_STATUSES.has(response.status)) {
            return (await offlinePage(`status:${response.status}`)) ?? response;
          }

          // Settled before the page gets its response, so none of its own
          // requests can be answered with someone else's rows.
          await checkDiscoverOwner(response).catch(() => undefined);

          return response;
        } catch (error) {
          // No connection, or the request hung past the timeout.
          return (
            (await offlinePage(
              error && error.message === 'timeout' ? 'timeout' : 'network'
            )) ?? Response.error()
          );
        }
      })()
    );
  }
});

self.addEventListener('message', (event) => {
  // The page tells us it has settled, so warming the cache competes with
  // nothing. Guarded so a second message cannot start a parallel run.
  if (event.data && event.data.type === 'PRECACHE_ROUTES') {
    if (!self.__precacheStarted) {
      self.__precacheStarted = true;
      event.waitUntil(precacheRouteChunks());
    }
  }
});

const setBadge = async (count) => {
  if (!('setAppBadge' in navigator)) {
    return;
  }

  try {
    if (count > 0) {
      await navigator.setAppBadge(count);
    } else {
      await navigator.clearAppBadge();
    }
  } catch {
    // The badge is a nicety.
  }
};

self.addEventListener('push', (event) => {
  const payload = event.data ? event.data.json() : {};

  const options = {
    body: payload.message,
    badge: 'badge-128x128.png',
    icon: payload.image ? payload.image : 'android-chrome-192x192.png',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: '2',
      actionUrl: payload.actionUrl,
      requestId: payload.requestId,
      subject: payload.subject,
      actionLabels: payload.actionLabels,
    },
    actions: [],
  };

  if (payload.actionUrl) {
    options.actions.push({
      action: 'view',
      title: payload.actionUrlTitle ?? 'View',
    });
  }

  if (payload.notificationType === 'MEDIA_PENDING') {
    // In the person's language when the server sent the words; English
    // from a server that predates them.
    const labels = payload.actionLabels ?? {};
    options.actions.push(
      {
        action: 'approve',
        title: labels.approve ?? 'Approve',
      },
      {
        action: 'decline',
        title: labels.decline ?? 'Decline',
      }
    );
  }

  // Every push shows a notification. A push that shows nothing breaks the
  // promise made when subscribing, and WebKit revokes the subscription of an
  // app that does it — on an iPhone, notifications would quietly stop.
  event.waitUntil(
    Promise.all([
      payload.notificationType === 'MEDIA_PENDING' &&
      typeof payload.pendingRequestsCount === 'number'
        ? setBadge(payload.pendingRequestsCount)
        : undefined,
      self.registration.showNotification(
        payload.subject || 'Seerr AI',
        options
      ),
    ])
  );
});

/**
 * Brings the app forward on `url`, reusing an open window rather than
 * opening a second copy of the app.
 */
const openApp = async (url) => {
  const target = new URL(url || '/', self.location.origin).href;
  const windows = await clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  const existing = windows.find(
    (client) => new URL(client.url).origin === self.location.origin
  );

  if (existing) {
    try {
      const focused = await existing.focus();
      if (focused.url !== target && 'navigate' in focused) {
        await focused.navigate(target);
      }
      return;
    } catch {
      // Could not reuse it (not controlled by this worker): open a new one.
    }
  }

  await clients.openWindow(target);
};

/**
 * The token the server wants with anything that changes something, when its
 * CSRF protection is on. The page reads it from a cookie; the worker can only
 * where the browser lets it read cookies (cookieStore). With none yet, any
 * answer from the server hands one out. Undefined where cookies cannot be
 * read, or with the protection off.
 */
const csrfToken = async () => {
  if (!self.cookieStore) {
    return undefined;
  }

  const read = async () =>
    (await self.cookieStore.get('XSRF-TOKEN'))?.value || undefined;

  try {
    const token = await read();
    if (token) {
      return token;
    }
    await fetchWithTimeout(
      new Request('/api/v1/request/count', { credentials: 'same-origin' })
    );
    return await read();
  } catch {
    return undefined;
  }
};

/**
 * Approves or declines a request from the notification. The worker is kept
 * alive until the server answers — otherwise it can be stopped as soon as the
 * tap is handled, and the request is never sent. If it did not go through,
 * a notification says to open the app, and tapping it opens the request.
 */
const actOnRequest = async (data, status) => {
  let ok = false;

  try {
    const token = await csrfToken();
    const response = await fetchWithTimeout(
      new Request(`/api/v1/request/${data.requestId}/${status}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: token ? { 'X-XSRF-TOKEN': token } : {},
      })
    );
    ok = response.ok;
  } catch {
    ok = false;
  }

  if (!ok) {
    const labels = data.actionLabels ?? {};
    await self.registration.showNotification(
      status === 'approve'
        ? (labels.approveFailed ?? 'Could not approve')
        : (labels.declineFailed ?? 'Could not decline'),
      {
        body:
          labels.failedBody ??
          (data.subject
            ? `${data.subject} — open Seerr AI to try again.`
            : 'Open Seerr AI to try again.'),
        badge: 'badge-128x128.png',
        icon: 'android-chrome-192x192.png',
        data: { actionUrl: data.actionUrl ?? '/requests' },
      }
    );
    return;
  }

  // One fewer waiting: bring the badge up to date.
  try {
    const response = await fetchWithTimeout(
      new Request('/api/v1/request/count', { credentials: 'same-origin' })
    );
    if (response.ok) {
      await setBadge((await response.json()).pending);
    }
  } catch {
    // The app corrects the badge the next time it is opened.
  }
};

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data ?? {};

  event.notification.close();

  if (
    (event.action === 'approve' || event.action === 'decline') &&
    data.requestId
  ) {
    event.waitUntil(actOnRequest(data, event.action));
    return;
  }

  event.waitUntil(openApp(data.actionUrl));
});
