import { Cache } from '@server/lib/cache';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* The in-memory caches for outside services. */

describe('a cache with a size limit', () => {
  const roster = (people: number) => ({
    cast: Array.from({ length: people }, (_, i) => ({
      id: i,
      name: `Lantern Song ${i}`,
    })),
  });

  it('drops the least recently used answers to stay under it', () => {
    const cache = new Cache('tmdb', 'Test', { max: 1000, maxBytes: 4000 });
    const each = JSON.stringify(roster(30)).length;
    const kept = Math.floor(4000 / each);
    for (let i = 0; i < kept + 3; i++) {
      assert.equal(cache.data.set(`/credits/${i}`, roster(30)), true);
    }
    assert.equal(cache.data.getStats().keys, kept);
    assert.equal(cache.data.get('/credits/0'), undefined);
    assert.deepEqual(cache.data.get(`/credits/${kept + 2}`), roster(30));
  });

  it('keeps nothing larger than the whole limit, and counts only what it keeps', () => {
    const cache = new Cache('tmdb', 'Test', { max: 1000, maxBytes: 4000 });
    assert.equal(cache.data.set('/credits/huge', roster(500)), false);
    assert.equal(cache.data.get('/credits/huge'), undefined);
    assert.deepEqual(
      [cache.data.getStats().keys, cache.data.getStats().vsize],
      [0, 0]
    );
  });

  it('is only a count of answers without one', () => {
    const cache = new Cache('tmdb', 'Test', { max: 2 });
    cache.data.set('/a', roster(500));
    cache.data.set('/b', roster(500));
    assert.equal(cache.data.getStats().keys, 2);
  });
});
