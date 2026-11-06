/* eslint-disable no-undef */
// Bump to reinstall the worker and refetch cached resources. Intentionally unused.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const OFFLINE_VERSION = 17;
const CACHE_NAME = 'offline';
const OFFLINE_URL = '/offline.html';
// The offline page's script, kept with it: pages run only scripts from here.
const OFFLINE_SCRIPT_URL = '/offline.js';

// Hashed, immutable Next.js assets, cache-first so an installed app doesn't
// re-download the bundle after the OS evicts the HTTP cache.
const STATIC_CACHE = 'static-v1';
// Each deploy ships new hashed chunks; the old ones are never requested again.
const STATIC_CACHE_MAX_ENTRIES = 300;
// Proxied posters and backdrops, cache-first and bounded. One Discover trip
// stores about 160; the cap keeps several (about 20 MB) before evicting.
const IMAGE_CACHE = 'images-v1';
const IMAGE_CACHE_MAX_ENTRIES = 1000;
// Discover rows are per person (region, language, requests, suggestions).
// v2: emptied on session change (SESSION_CHANGES); v3: checked readable (readsAsJson).
const DISCOVER_CACHE = 'discover-v3';
const DISCOVER_CACHE_MAX_ENTRIES = 60;

const PRECACHE_CONCURRENCY = 3;

/**
 * Requests that start or end a session. On success the Discover cache is
 * emptied before the page continues, so the next person never sees the last
 * one's rows. SSO sign-in is a navigation to the provider and back, which
 * empties it whatever the answer.
 */
const SESSION_CHANGES =
  /^\/api\/v1\/auth\/(local|plex|jellyfin|jellyfin\/quickconnect\/authenticate|passkey\/login|logout|oidc\/[^/]+\/(sign-in|link|callback))$/;

/**
 * The user's music requests, which a playlist import adds to in the
 * background. Rows derived from it change little and are cached like the rest.
 */
const OWN_MUSIC_REQUESTS = /^\/api\/v1\/discover\/music\/your-requests$/;
/** Wait for the server before showing the stored copy. */
const OWN_MUSIC_WAIT_MS = 3000;

/** Changes that make cached Discover rows stale. */
const DISCOVER_CHANGES =
  /^\/api\/v1\/(request|media|blocklist|watchlist)(\/|$)/;

/*
 * Whose Discover rows are cached. Covers sign-ins the worker never saw (e.g.
 * after a hard refresh): each server-rendered page names its user
 * (X-Seerr-User), and a mismatch empties the rows.
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
            const response = await fetchWithTimeout(new Request(url));
            if (response.ok && fitsCache(STATIC_CACHE, response)) {
              await cache.put(url, response);
            }
          }
        } catch {
          // Keep warming the rest.
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
 * Statuses meaning the server is unreachable: gateway errors and Cloudflare
 * origin errors (520–527, 530). 500 is excluded: that is Seerr answering.
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
 * The stored offline page, if any, told the reason: "network", "timeout" or
 * "status:522" (an unreachable status from Cloudflare or a proxy).
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
      // {cache: 'reload'} bypasses the HTTP cache.
      // Never reject: a failed install keeps the previous worker, which may
      // serve a stale shell until reinstall.
      try {
        await cache.addAll([
          new Request(OFFLINE_URL, { cache: 'reload' }),
          new Request(OFFLINE_SCRIPT_URL, { cache: 'reload' }),
        ]);
      } catch {
        // No offline page until the next install.
      }
    })()
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // See https://developers.google.com/web/updates/2017/02/navigation-preload
      if ('navigationPreload' in self.registration) {
        await self.registration.navigationPreload.enable();
      }

      // Drop caches from previous worker versions.
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

  clients.claim();

  // Chunk warming waits for the page to finish loading (PRECACHE_ROUTES), so
  // it doesn't starve the page's own requests on a slow server.
});

/*
 * A trim lists every cache entry; throttled so a page of posters doesn't run
 * dozens of listings that compete with serving them.
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
 * Last-served time per entry, per cache. The Cache API only keeps insertion
 * order, so this lets trims evict least recently used. Lost when the worker
 * stops; best effort.
 */
const lastUsed = new Map();
const LAST_USED_LIMIT = 2000;

const markUsed = (cacheName, url) => {
  let used = lastUsed.get(cacheName);
  if (!used) {
    used = new Map();
    lastUsed.set(cacheName, used);
  }
  // Re-insert to keep the map ordered by use, oldest first.
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

  // LRU order: entries unused since worker start (in keys() order), then the
  // rest by last use.
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

/** A fetch that times out, so an unanswered request can't hang the page. */
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
 * Whether a response is readable JSON. Anything else (empty, truncated, or
 * another page) is never stored or served, or it would be served every time.
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

/**
 * Serve from cache and refresh in the background; network when nothing is
 * cached. `fetchResponse` reuses a preload response to save a request.
 */
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
      // The preload promise resolves to undefined when preload is unavailable.
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

  // The worker can stop once a response is returned; keep it alive or the
  // refresh never writes and the stale copy is served forever.
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

/**
 * Network first, stored copy only on timeout. For rows that change without
 * the page acting, such as music requests added by a playlist import.
 */
const networkFirst = async (request, cacheName, maxEntries, timeoutMs) => {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetchWithTimeout(request, timeoutMs);
    if (
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
  } catch (e) {
    const cached = await cache.match(request);
    if (cached && (await readsAsJson(cached))) {
      return cached;
    }
    throw e;
  }
};

/**
 * Whether a stored copy is still servable. Immutable or lifetime-less copies
 * always are; one with a max-age (e.g. an album cover) is good until it expires.
 */
const stillFresh = (response) => {
  const cacheControl = response.headers.get('Cache-Control') ?? '';
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl);
  const sentAt = Date.parse(response.headers.get('Date') ?? '');
  if (/immutable/i.test(cacheControl) || !maxAge || Number.isNaN(sentAt)) {
    return true;
  }
  return Date.now() < sentAt + Number(maxAge[1]) * 1000;
};

/**
 * Whether a response belongs in its cache: an image for images, non-HTML for
 * code. A proxy's SSO page can answer a chunk or poster after a redirect;
 * cached, it would break the app until the cache is cleared by hand.
 */
const fitsCache = (cacheName, response) => {
  if (response.redirected) {
    return false;
  }
  const type = response.headers.get('Content-Type') ?? '';
  return cacheName === IMAGE_CACHE
    ? /^image\//i.test(type)
    : !/^text\/html/i.test(type);
};

const cacheFirst = async (request, cacheName, maxEntries, keepAlive) => {
  const cache = await caches.open(cacheName);
  let cached = await cache.match(request);

  // Drop and refetch a copy stored before this check existed.
  if (cached && !fitsCache(cacheName, cached)) {
    await cache.delete(request).catch(() => undefined);
    cached = undefined;
  }

  if (cached) {
    markUsed(cacheName, request.url);
    if (!stillFresh(cached)) {
      // Serve it now, refetch for next time.
      keepAlive?.(
        fetchAndStore(request, cache, cacheName, maxEntries).catch(
          () => undefined
        )
      );
    }
    return cached;
  }

  const response = await fetch(request);
  const store = keep(response, request, cache, cacheName, maxEntries);
  if (store) {
    // Keep the worker alive until stored, or the next view downloads it again.
    keepAlive?.(store);
  }

  return response;
};

/**
 * Stores a copy unless it is an error or no-store (a placeholder from an image
 * proxy still converting). Returns the store promise, or nothing.
 */
const keep = (response, request, cache, cacheName, maxEntries) => {
  if (
    !response ||
    !response.ok ||
    /no-store/i.test(response.headers.get('Cache-Control') ?? '') ||
    !fitsCache(cacheName, response)
  ) {
    return undefined;
  }
  markUsed(cacheName, request.url);
  return cache
    .put(request, response.clone())
    .then(() => (maxEntries ? trimCacheSoon(cacheName, maxEntries) : undefined))
    .catch(() => undefined);
};

const fetchAndStore = async (request, cache, cacheName, maxEntries) =>
  keep(await fetchWithTimeout(request), request, cache, cacheName, maxEntries);

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
          // Owned by nobody until the next page names its user.
          await clearDiscover().catch(() => undefined);
        }
        return response;
      })()
    );
    return;
  }

  // Requests, approvals, blocklisting and watchlist changes alter Discover
  // rows. Empty the cache before the page hears back, or its next read gets a
  // copy still saying "Request".
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
    // The copy stored with the offline page, so the two always match.
    if (url.pathname === OFFLINE_SCRIPT_URL) {
      event.respondWith(
        (async () =>
          (await (await caches.open(CACHE_NAME)).match(OFFLINE_SCRIPT_URL)) ??
          fetch(request))()
      );
      return;
    }

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

    // Music requests change server-side (playlist import) with no page call to
    // empty the cache: network first, stored copy when slow or offline.
    if (OWN_MUSIC_REQUESTS.test(url.pathname)) {
      event.respondWith(
        networkFirst(
          request,
          DISCOVER_CACHE,
          DISCOVER_CACHE_MAX_ENTRIES,
          OWN_MUSIC_WAIT_MS
        )
      );
      return;
    }

    // Watchlist is per user (a URL-keyed copy would leak across users).
    // search-text batches change as the page loads and can be slow: caching
    // evicts real rows and the timeout would cut them off. Both skip the cache.
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

  // Navigations always go to the network: cached HTML can serve the previous
  // build after a deploy (reload loop, stalled launch).
  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await raceTimeout(
            (async () =>
              (await event.preloadResponse) || fetch(event.request))(),
            NETWORK_TIMEOUT_MS
          );

          // Cloudflare answers for a down server with its own error page;
          // show ours instead. Ordinary server errors pass through.
          if (UNREACHABLE_STATUSES.has(response.status)) {
            return (await offlinePage(`status:${response.status}`)) ?? response;
          }

          // Settle before responding so no request gets someone else's rows.
          if (
            url.origin === self.location.origin &&
            SESSION_CHANGES.test(url.pathname)
          ) {
            await clearDiscover().catch(() => undefined);
          }
          await checkDiscoverOwner(response).catch(() => undefined);

          return response;
        } catch (error) {
          // No connection, or timed out.
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
  // Sent once the page has settled. Guarded against a parallel run.
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

/**
 * Parses a push. Non-JSON is shown as text, since a push must always show
 * something (see below).
 */
const pushPayload = (data) => {
  if (!data) {
    return {};
  }
  try {
    const payload = data.json();
    return payload && typeof payload === 'object' ? payload : {};
  } catch {
    try {
      return { message: data.text() };
    } catch {
      return {};
    }
  }
};

self.addEventListener('push', (event) => {
  const payload = pushPayload(event.data);

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
    // Localised when the server sends labels; English otherwise.
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

  // Every push must show a notification, or WebKit revokes the subscription
  // and iPhone notifications silently stop.
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

/** Focuses the app on `url`, reusing an open window when possible. */
const openApp = async (url) => {
  let target = new URL('/', self.location.origin).href;
  try {
    const asked = new URL(url || '/', self.location.origin);
    // Only this app's own pages; anything else opens the home page.
    if (asked.origin === self.location.origin) {
      target = asked.href;
    }
  } catch {
    // Not a URL: the home page.
  }
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
      // Not controlled by this worker: open a new one.
    }
  }

  await clients.openWindow(target);
};

/**
 * The CSRF token for mutating requests, read via cookieStore. With none yet,
 * any server response sets one. Undefined where cookies can't be read or CSRF
 * protection is off.
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
 * alive until the server answers, or the request may never be sent. On
 * failure, a notification links to the request.
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

  // One fewer pending.
  try {
    const response = await fetchWithTimeout(
      new Request('/api/v1/request/count', { credentials: 'same-origin' })
    );
    if (response.ok) {
      await setBadge((await response.json()).pending);
    }
  } catch {
    // The app corrects the badge when next opened.
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
