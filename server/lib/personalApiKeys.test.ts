import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  expiresAtFor,
  hashKey,
  isExpired,
  keyMatches,
  makeKey,
  publicIdOf,
  shouldRecordUse,
} from '@server/lib/personalApiKeys';

const DAY = 24 * 60 * 60 * 1000;

describe('making a personal API key', () => {
  it('starts with sai_ and its visible id, then a long random secret', () => {
    const { key, publicId, secretHash } = makeKey();
    assert.match(key, /^sai_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    assert.equal(key.slice(4, 12), publicId);
    assert.equal(secretHash, hashKey(key));
    // The hash is kept, never the key.
    assert.equal(secretHash.includes(key.slice(13)), false);
  });

  it('never makes the same key twice', () => {
    const keys = new Set(Array.from({ length: 200 }, () => makeKey().key));
    assert.equal(keys.size, 200);
  });
});

describe('checking a personal API key', () => {
  it('hashes with SHA-256, as hex', () => {
    assert.equal(
      hashKey('sai_00000000_abc'),
      createHash('sha256').update('sai_00000000_abc').digest('hex')
    );
  });

  it('matches only the key it was made from', () => {
    const { key, secretHash } = makeKey();
    assert.equal(keyMatches(key, secretHash), true);
    assert.equal(keyMatches(`${key}x`, secretHash), false);
    assert.equal(keyMatches(makeKey().key, secretHash), false);
    // A stored hash that isn't one is no match, rather than an error.
    assert.equal(keyMatches(key, ''), false);
    assert.equal(keyMatches(key, 'not hex at all'), false);
  });

  it('reads the visible id only from something shaped like a key', () => {
    const { key, publicId } = makeKey();
    assert.equal(publicIdOf(key), publicId);
    assert.equal(publicIdOf('sai_ABCDEF12_' + 'a'.repeat(43)), undefined);
    assert.equal(publicIdOf('sai_abcdef12_short'), undefined);
    assert.equal(publicIdOf(`${key} `), undefined);
    assert.equal(publicIdOf('MTYwMDAwMDAwMDAwMGFiYw=='), undefined);
  });
});

describe('when a key stops working', () => {
  const now = new Date('2026-10-19T12:00:00Z');

  it('lasts the chosen number of days, or for ever', () => {
    assert.equal(expiresAtFor(30, now)?.getTime(), now.getTime() + 30 * DAY);
    assert.equal(expiresAtFor(365, now)?.getTime(), now.getTime() + 365 * DAY);
    assert.equal(expiresAtFor(null, now), null);
  });

  it('is expired from the moment it expires', () => {
    assert.equal(isExpired(null, now), false);
    assert.equal(isExpired(new Date(now.getTime() + 1), now), false);
    assert.equal(isExpired(now, now), true);
    assert.equal(isExpired(new Date(now.getTime() - DAY), now), true);
  });
});

describe('recording when a key was last used', () => {
  const now = new Date('2026-10-19T12:00:00Z');

  it('writes at most once a minute', () => {
    assert.equal(shouldRecordUse(null, now), true);
    assert.equal(shouldRecordUse(new Date(now.getTime() - 5_000), now), false);
    assert.equal(shouldRecordUse(new Date(now.getTime() - 59_000), now), false);
    assert.equal(shouldRecordUse(new Date(now.getTime() - 60_000), now), true);
  });
});
