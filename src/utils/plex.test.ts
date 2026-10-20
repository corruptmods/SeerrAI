import axios from 'axios';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import PlexOAuth, { PlexSignInError, plexSignInProblemOf } from './plex';

/*
 * Signing in with Plex when the browser won't open the Plex window: the
 * page must go to Plex in the same tab, or say why it can't, and never
 * just stop. The browser is stood in for by the parts this touches.
 */

const PAGE = 'https://seerr.example/login?redirect=%2Fmovie%2F12';

interface FakeWindow {
  open: (url: string) => unknown;
  assigned: string[];
  storage: Map<string, string>;
  storageBroken: boolean;
}

let fake: FakeWindow;
const globals = globalThis as unknown as { window?: unknown };

const installWindow = (open: FakeWindow['open']) => {
  fake = { open, assigned: [], storage: new Map(), storageBroken: false };
  globals.window = {
    open: (url: string) => fake.open(url),
    navigator: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    },
    screen: { width: 1920, height: 1080 },
    screenLeft: 0,
    screenTop: 0,
    innerWidth: 1280,
    innerHeight: 800,
    location: {
      href: PAGE,
      assign: (url: string) => fake.assigned.push(url),
    },
    sessionStorage: {
      getItem: (key: string) => fake.storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (fake.storageBroken) throw new Error('SecurityError');
        fake.storage.set(key, value);
      },
      removeItem: (key: string) => fake.storage.delete(key),
    },
  };
};

const pinCreated = () =>
  mock.method(axios, 'post', async () => ({
    data: { id: 4242, code: 'abc123' },
  }));

const problemOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof PlexSignInError, 'a PlexSignInError');
    return plexSignInProblemOf(e);
  }
  assert.fail('expected the sign-in to fail');
};

beforeEach(() => installWindow(() => null));

afterEach(() => {
  mock.restoreAll();
  delete globals.window;
});

describe('signing in with Plex when the window is blocked', () => {
  it('goes to Plex in the same tab, coming back to the same page', async () => {
    pinCreated();
    const plex = new PlexOAuth();
    plex.preparePopup();

    const token = await plex.login('client-1', 'login');

    assert.equal(token, undefined);
    assert.equal(fake.assigned.length, 1);
    const target = fake.assigned[0];
    assert.ok(target.startsWith('https://app.plex.tv/auth/#!?'), target);
    const params = new URLSearchParams(target.split('#!?')[1]);
    assert.equal(params.get('clientID'), 'client-1');
    assert.equal(params.get('code'), 'abc123');
    assert.equal(
      params.get('forwardUrl'),
      'https://seerr.example/login?redirect=%2Fmovie%2F12&plexPin=4242'
    );
    // The PIN waits in this tab, for the return.
    const kept = JSON.parse(fake.storage.get('seerr-plex-sign-in') ?? '{}');
    assert.equal(kept.id, 4242);
    assert.equal(kept.code, 'abc123');
    assert.equal(kept.purpose, 'login');
  });

  it('treats a window that is closed as soon as it opens as blocked', async () => {
    installWindow(() => ({ closed: true, focus: () => undefined }));
    pinCreated();
    const plex = new PlexOAuth();
    plex.preparePopup();

    assert.equal(await plex.login('client-1', 'link'), undefined);
    assert.equal(fake.assigned.length, 1);
  });

  it('says the window could not open when the tab cannot keep the PIN', async () => {
    pinCreated();
    fake.storageBroken = true;
    const plex = new PlexOAuth();
    plex.preparePopup();

    assert.equal(await problemOf(plex.login('client-1', 'login')), 'popup');
    assert.deepEqual(fake.assigned, []);
  });

  it('says the window could not open when there is nowhere to come back to', async () => {
    pinCreated();
    const plex = new PlexOAuth();
    plex.preparePopup();

    assert.equal(await problemOf(plex.login('client-1')), 'popup');
    assert.deepEqual(fake.assigned, []);
  });

  it('says Plex could not be reached when the PIN request fails', async () => {
    mock.method(axios, 'post', async () => {
      throw new Error('Network Error');
    });
    const plex = new PlexOAuth();
    plex.preparePopup();

    assert.equal(
      await problemOf(plex.login('client-1', 'login')),
      'unreachable'
    );
    assert.deepEqual(fake.assigned, []);
  });

  it('says the window was closed when they closed it themselves', async () => {
    const popup = { closed: false, focus: () => undefined, close: () => {} };
    installWindow(() => popup);
    pinCreated();
    const plex = new PlexOAuth();
    plex.preparePopup();
    popup.closed = true;

    assert.equal(await problemOf(plex.login('client-1', 'login')), 'closed');
    assert.deepEqual(fake.assigned, []);
  });
});

describe('finishing a same-tab sign-in', () => {
  const pending = {
    id: 4242,
    code: 'abc123',
    purpose: 'login' as const,
    startedAt: Date.now(),
  };

  it('hands back the token Plex has for the PIN', async () => {
    const get = mock.method(axios, 'get', async () => ({
      data: { id: 4242, authToken: 'plex-token' },
    }));
    const token = await new PlexOAuth().finishSameTab('client-1', pending);

    assert.equal(token, 'plex-token');
    assert.equal(
      get.mock.calls[0].arguments[0],
      'https://plex.tv/api/v2/pins/4242'
    );
  });

  it('says they did not sign in when Plex has no token for the PIN', async () => {
    const get = mock.method(axios, 'get', async () => ({
      data: { id: 4242, authToken: null },
    }));

    assert.equal(
      await problemOf(new PlexOAuth().finishSameTab('client-1', pending)),
      'notSignedIn'
    );
    // A few looks, not a long wait.
    assert.equal(get.mock.callCount(), 3);
  });

  it('says it expired when Plex no longer knows the PIN', async () => {
    mock.method(axios, 'get', async () => {
      throw new axios.AxiosError('Not Found', '404', undefined, undefined, {
        status: 404,
      } as never);
    });

    assert.equal(
      await problemOf(new PlexOAuth().finishSameTab('client-1', pending)),
      'expired'
    );
  });

  it('says Plex could not be reached when it does not answer', async () => {
    mock.method(axios, 'get', async () => {
      throw new axios.AxiosError('timeout', 'ECONNABORTED');
    });

    assert.equal(
      await problemOf(new PlexOAuth().finishSameTab('client-1', pending)),
      'unreachable'
    );
  });
});
