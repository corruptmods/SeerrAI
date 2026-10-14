import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

/*
 * The service worker is plain script, so it runs here in a sandbox standing
 * in for the browser: the parts the notification actions touch, and a
 * server that answers every request.
 */
const ORIGIN = 'https://seerr.example';
const source = readFileSync(join(__dirname, '../../public/sw.js'), 'utf8');

type Handler = (event: unknown) => void;

interface Shown {
  title: string;
  options: { actions?: { action: string; title: string }[]; body?: string };
}

const loadWorker = (
  cookies: Record<string, string> | undefined,
  { refuse = false } = {}
) => {
  const handlers: Record<string, Handler> = {};
  const sent: Request[] = [];
  const shown: Shown[] = [];
  const jar = cookies ? { ...cookies } : undefined;

  class WorkerRequest extends Request {
    constructor(input: string, init?: RequestInit) {
      super(new URL(input, ORIGIN), init);
    }
  }

  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
    registration: {
      showNotification: async (title: string, options: Shown['options']) => {
        shown.push({ title, options });
      },
    },
    cookieStore: jar && {
      get: async (name: string) =>
        jar[name] === undefined ? null : { name, value: jar[name] },
    },
  };

  runInNewContext(source, {
    self,
    clients: { matchAll: async () => [], openWindow: async () => null },
    caches: {},
    navigator: {},
    Request: WorkerRequest,
    Response,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (request: Request) => {
      sent.push(request);
      if (request.method === 'GET' && jar && !jar['XSRF-TOKEN']) {
        // CSRF protection on: any answer hands out a fresh token.
        jar['XSRF-TOKEN'] = 'fresh-token';
      }
      if (refuse && request.method === 'POST') {
        return new Response(null, { status: 403 });
      }
      return new Response(JSON.stringify({ pending: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const tap = async (action: string, data: object = {}) => {
    const waits: Promise<unknown>[] = [];
    handlers.notificationclick({
      action,
      notification: {
        data: { requestId: 7, subject: 'A film', ...data },
        close: () => undefined,
      },
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    });
    await Promise.all(waits);
  };

  const push = async (payload: object) => {
    const waits: Promise<unknown>[] = [];
    handlers.push({
      data: { json: () => payload },
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    });
    await Promise.all(waits);
  };

  return { tap, push, sent, shown, handlers };
};

const actionOn = (sent: Request[]) =>
  sent.find((request) => request.method === 'POST');

describe('approving from a notification', () => {
  it('sends the CSRF token the server asks for', async () => {
    const worker = loadWorker({ 'XSRF-TOKEN': 'the-token' });

    await worker.tap('approve');

    const post = actionOn(worker.sent);
    assert.equal(post?.url, `${ORIGIN}/api/v1/request/7/approve`);
    assert.equal(post?.headers.get('X-XSRF-TOKEN'), 'the-token');
    assert.equal(worker.shown.length, 0);
  });

  it('gets a token first when there is none yet', async () => {
    const worker = loadWorker({});

    await worker.tap('decline');

    assert.equal(
      actionOn(worker.sent)?.headers.get('X-XSRF-TOKEN'),
      'fresh-token'
    );
  });

  it('still sends the action where cookies cannot be read', async () => {
    // Without CSRF protection none is needed; with it, the server refuses
    // and the person is told to open the app.
    const worker = loadWorker(undefined);

    await worker.tap('approve');

    const post = actionOn(worker.sent);
    assert.equal(post?.url, `${ORIGIN}/api/v1/request/7/approve`);
    assert.equal(post?.headers.get('X-XSRF-TOKEN'), null);
  });
});

describe('the words on a request waiting for approval', () => {
  const actionLabels = {
    approve: 'Genehmigen',
    decline: 'Ablehnen',
    approveFailed: 'Nicht genehmigt',
    declineFailed: 'Nicht abgelehnt',
    failedBody: 'Ein Film — öffne Seerr AI und versuche es erneut.',
  };

  it('are the ones the server sent, in the person’s language', async () => {
    const worker = loadWorker({ 'XSRF-TOKEN': 'the-token' });

    await worker.push({
      notificationType: 'MEDIA_PENDING',
      subject: 'Ein Film',
      requestId: 7,
      actionLabels,
    });

    assert.deepEqual(
      // Copied out of the worker's sandbox, whose arrays are its own.
      Array.from(worker.shown[0].options.actions ?? [], (a) => a.title),
      ['Genehmigen', 'Ablehnen']
    );
  });

  it('are English from a server that sends none', async () => {
    const worker = loadWorker({ 'XSRF-TOKEN': 'the-token' });

    await worker.push({
      notificationType: 'MEDIA_PENDING',
      subject: 'A film',
      requestId: 7,
    });

    assert.deepEqual(
      // Copied out of the worker's sandbox, whose arrays are its own.
      Array.from(worker.shown[0].options.actions ?? [], (a) => a.title),
      ['Approve', 'Decline']
    );
  });

  it('say so in the same language when a tap does not go through', async () => {
    const worker = loadWorker({ 'XSRF-TOKEN': 'the-token' }, { refuse: true });

    await worker.tap('approve', { actionLabels });

    assert.equal(worker.shown[0].title, 'Nicht genehmigt');
    assert.equal(worker.shown[0].options.body, actionLabels.failedBody);
  });
});

/*
 * The image cache: the worker with a cache standing in for the browser's,
 * and a server whose answers each test sets.
 */
const loadImageWorker = () => {
  const handlers: Record<string, Handler> = {};
  const stored = new Map<string, Response>();
  const fetched: string[] = [];
  const answer = {
    cacheControl: 'public, max-age=31536000, immutable',
    sentAt: new Date(),
    contentType: 'image/jpeg',
    /** Whether it came by way of a redirect (a sign-in page in front). */
    redirected: false,
    /** The chunks /sw-precache.json lists. */
    precache: [] as string[],
  };

  class WorkerRequest extends Request {
    constructor(input: string, init?: RequestInit) {
      super(new URL(input, ORIGIN), init);
    }
  }

  // A path is taken against the worker's own address, as the Cache API does.
  const urlOf = (request: Request | string) =>
    typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
  const cache = {
    match: async (request: Request) => stored.get(urlOf(request))?.clone(),
    put: async (request: Request, response: Response) => {
      stored.set(urlOf(request), response);
    },
    keys: async () => [...stored.keys()].map((url) => new Request(url)),
    delete: async (request: Request) => stored.delete(urlOf(request)),
  };

  runInNewContext(source, {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, handler: Handler) => {
        handlers[type] = handler;
      },
    },
    clients: { matchAll: async () => [], openWindow: async () => null },
    caches: { open: async () => cache },
    navigator: {},
    Request: WorkerRequest,
    Response,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (request: Request | string) => {
      const path = new URL(urlOf(request)).pathname;
      if (path === '/sw-precache.json') {
        return new Response(JSON.stringify({ files: answer.precache }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      fetched.push(path);
      const html = /\bpage\b/.test(path) || answer.contentType === 'text/html';
      const response = new Response(
        html ? '<html>Sign in</html>' : new Uint8Array([0xff, 0xd8]),
        {
          headers: {
            'Content-Type': html ? 'text/html' : answer.contentType,
            'Cache-Control': answer.cacheControl,
            Date: answer.sentAt.toUTCString(),
          },
        }
      );
      Object.defineProperty(response, 'redirected', {
        value: html || answer.redirected,
      });
      return response;
    },
  });

  /** The page showing an image: what it is handed, once all is stored. */
  const view = async (path: string) => {
    let response: Promise<Response> | undefined;
    const waits: Promise<unknown>[] = [];
    handlers.fetch({
      request: new WorkerRequest(path),
      respondWith: (promise: Promise<Response>) => {
        response = promise;
      },
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    });
    const shown = await response;
    await Promise.all(waits);
    return shown;
  };

  /** The page, settled, asking the worker to fetch the app's code ahead. */
  const precache = async () => {
    const waits: Promise<unknown>[] = [];
    handlers.message({
      data: { type: 'PRECACHE_ROUTES' },
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    });
    await Promise.all(waits);
  };

  return { view, precache, fetched, answer, stored };
};

describe('images kept on the device', () => {
  const HOUR_AGO = () => new Date(Date.now() - 60 * 60 * 1000);

  it('are kept for good when they never change', async () => {
    const worker = loadImageWorker();
    worker.answer.sentAt = HOUR_AGO();
    const poster = '/imageproxy/tmdb/t/p/w300_and_h450_face/a.jpg';
    await worker.view(poster);
    await worker.view(poster);
    assert.deepEqual(worker.fetched, [poster]);
  });

  it('are shown once more when out of date, and fetched again for next time', async () => {
    const worker = loadImageWorker();
    const cover =
      '/imageproxy/caa/release-group/b1392450-e666-3926-a536-22c65f834433/front-500';
    worker.answer.cacheControl = 'public, max-age=60';
    worker.answer.sentAt = HOUR_AGO();
    await worker.view(cover);

    worker.answer.sentAt = new Date();
    const shown = await worker.view(cover);
    assert.equal(shown?.status, 200, 'the copy it had, at once');
    assert.equal(worker.fetched.length, 2, 'and a fresh one fetched');

    await worker.view(cover);
    assert.equal(worker.fetched.length, 2, 'which is kept while fresh');
  });

  it('are never kept when the server says not to', async () => {
    const worker = loadImageWorker();
    worker.answer.cacheControl = 'no-store';
    const converting = '/imageproxy/tmdb/t/p/w1280/b.jpg?f=avif';
    await worker.view(converting);
    await worker.view(converting);
    assert.equal(worker.fetched.length, 2);
  });
});

describe('what the worker never keeps', () => {
  it('a sign-in page answered in a poster’s place', async () => {
    // A proxy's single sign-on whose session ran out redirects every
    // request to its own page.
    const worker = loadImageWorker();
    worker.answer.contentType = 'text/html';
    const poster = '/imageproxy/tmdb/t/p/w300_and_h450_face/a.jpg';
    await worker.view(poster);
    await worker.view(poster);
    assert.equal(worker.fetched.length, 2, 'asked again each time');

    worker.answer.contentType = 'image/jpeg';
    await worker.view(poster);
    await worker.view(poster);
    assert.equal(worker.fetched.length, 3, 'the real poster is kept');
  });

  it('a picture that came by way of a redirect', async () => {
    const worker = loadImageWorker();
    worker.answer.redirected = true;
    const poster = '/imageproxy/tmdb/t/p/w300_and_h450_face/b.jpg';
    await worker.view(poster);
    await worker.view(poster);
    assert.equal(worker.fetched.length, 2);
  });

  it('a page in place of the app’s code, nor serves one kept before', async () => {
    const worker = loadImageWorker();
    const chunk = '/_next/static/chunks/page-abc.js';
    await worker.view(chunk);
    await worker.view(chunk);
    assert.equal(worker.fetched.length, 2);

    // A copy stored by an earlier worker is dropped and fetched again.
    const kept = '/_next/static/chunks/main-abc.js';
    worker.stored.set(
      `${ORIGIN}${kept}`,
      new Response('<html>Sign in</html>', {
        headers: { 'Content-Type': 'text/html' },
      })
    );
    worker.answer.contentType = 'application/javascript';
    const shown = await worker.view(kept);
    assert.equal(shown?.headers.get('Content-Type'), 'application/javascript');
    assert.deepEqual(worker.fetched.slice(2), [kept]);
  });

  it('a page among the code it fetches ahead', async () => {
    const worker = loadImageWorker();
    worker.answer.contentType = 'application/javascript';
    worker.answer.precache = [
      '/_next/static/chunks/main-abc.js',
      '/_next/static/chunks/page-def.js',
    ];
    await worker.precache();
    assert.deepEqual(
      [...worker.stored.keys()],
      [`${ORIGIN}/_next/static/chunks/main-abc.js`]
    );
  });
});

describe('a push that is not what Seerr sends', () => {
  it('still shows a notification, with its text', async () => {
    const worker = loadWorker({});
    const waits: Promise<unknown>[] = [];
    worker.handlers.push({
      data: {
        json: () => {
          throw new SyntaxError('Unexpected token');
        },
        text: () => 'Something arrived',
      },
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    });
    await Promise.all(waits);
    assert.equal(worker.shown.length, 1);
    assert.equal(worker.shown[0].title, 'Seerr AI');
    assert.equal(worker.shown[0].options.body, 'Something arrived');
  });
});
