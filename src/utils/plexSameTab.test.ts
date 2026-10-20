import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PendingPlexSignIn } from './plexSameTab';
import {
  PENDING_LIFETIME_MS,
  clearPendingPlexSignIn,
  plexForwardUrl,
  plexReturnOf,
  readPendingPlexSignIn,
  savePendingPlexSignIn,
  withoutPlexReturn,
} from './plexSameTab';

/** A sessionStorage stand-in. */
const memoryStore = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    items,
  };
};

const NOW = 1_800_000_000_000;
const pending: PendingPlexSignIn = {
  id: 4242,
  code: 'abc123',
  purpose: 'login',
  startedAt: NOW - 60_000,
};

describe('the address Plex sends someone back to', () => {
  it('is the page they were on, with the PIN id added', () => {
    assert.equal(
      plexForwardUrl(
        'https://seerr.example/login?redirect=%2Fmovie%2F12',
        4242
      ),
      'https://seerr.example/login?redirect=%2Fmovie%2F12&plexPin=4242'
    );
  });

  it('replaces an earlier PIN id and leaves out the fragment', () => {
    assert.equal(
      plexForwardUrl(
        'https://seerr.example/profile/settings/linked-accounts?plexPin=1#top',
        4242
      ),
      'https://seerr.example/profile/settings/linked-accounts?plexPin=4242'
    );
  });

  it('loses only the PIN id once it has been dealt with', () => {
    assert.equal(
      withoutPlexReturn(
        'https://seerr.example/login?redirect=%2Fmovie%2F12&plexPin=4242'
      ),
      '/login?redirect=%2Fmovie%2F12'
    );
    assert.equal(
      withoutPlexReturn('https://seerr.example/setup?plexPin=4242'),
      '/setup'
    );
  });
});

describe('keeping the PIN in this tab', () => {
  it('reads back what was kept, and nothing once cleared', () => {
    const store = memoryStore();
    assert.equal(savePendingPlexSignIn(store, pending), true);
    assert.deepEqual(readPendingPlexSignIn(store), pending);
    clearPendingPlexSignIn(store);
    assert.equal(readPendingPlexSignIn(store), undefined);
  });

  it('says so when it cannot be kept, so the tab is not sent away', () => {
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    };
    assert.equal(savePendingPlexSignIn(full, pending), false);
    assert.equal(savePendingPlexSignIn(undefined, pending), false);
  });

  it('ignores anything that is not a sign-in it made', () => {
    const store = memoryStore();
    store.setItem('seerr-plex-sign-in', 'not json');
    assert.equal(readPendingPlexSignIn(store), undefined);
    store.setItem(
      'seerr-plex-sign-in',
      JSON.stringify({ ...pending, purpose: 'elsewhere' })
    );
    assert.equal(readPendingPlexSignIn(store), undefined);
    store.setItem(
      'seerr-plex-sign-in',
      JSON.stringify({ ...pending, id: '4242' })
    );
    assert.equal(readPendingPlexSignIn(store), undefined);
  });
});

describe('coming back from Plex', () => {
  it('checks the PIN when the address carries this tab’s PIN id', () => {
    assert.deepEqual(plexReturnOf('4242', pending, 'login', NOW), {
      kind: 'check',
      pending,
    });
  });

  it('never uses a PIN id this tab did not start', () => {
    assert.deepEqual(plexReturnOf('9999', pending, 'login', NOW), {
      kind: 'expired',
    });
    assert.deepEqual(plexReturnOf('4242', undefined, 'login', NOW), {
      kind: 'expired',
    });
  });

  it('says they did not sign in when they came back another way', () => {
    assert.deepEqual(plexReturnOf(null, pending, 'login', NOW), {
      kind: 'notSignedIn',
    });
  });

  it('treats an old sign-in as expired, and a stale leftover as nothing', () => {
    const old = { ...pending, startedAt: NOW - PENDING_LIFETIME_MS - 1 };
    assert.deepEqual(plexReturnOf('4242', old, 'login', NOW), {
      kind: 'expired',
    });
    assert.deepEqual(plexReturnOf(null, old, 'login', NOW), { kind: 'none' });
  });

  it('leaves a sign-in for the page that started it', () => {
    const linking = { ...pending, purpose: 'link' as const };
    assert.deepEqual(plexReturnOf('4242', linking, 'login', NOW), {
      kind: 'none',
    });
    assert.deepEqual(plexReturnOf('4242', linking, 'link', NOW), {
      kind: 'check',
      pending: linking,
    });
  });

  it('does nothing on an ordinary visit', () => {
    assert.deepEqual(plexReturnOf(null, undefined, 'login', NOW), {
      kind: 'none',
    });
  });
});
