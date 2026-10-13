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

  return { tap, push, sent, shown };
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
