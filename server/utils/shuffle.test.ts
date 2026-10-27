import { seededShuffle, shuffleSeed } from '@server/utils/shuffle';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('a seeded shuffle', () => {
  const titles = Array.from({ length: 50 }, (_, i) => i);

  it('mixes the same way for the same seed, and leaves the list alone', () => {
    const once = seededShuffle(titles, 1234);
    assert.deepEqual(seededShuffle(titles, 1234), once);
    assert.deepEqual(
      [...once].sort((a, b) => a - b),
      titles,
      'every title once'
    );
    assert.notDeepEqual(once, titles);
    assert.deepEqual(titles[0], 0, 'the list given is not changed');
  });

  it('mixes another way for another seed', () => {
    const starts = new Set(
      Array.from({ length: 20 }, (_, seed) => seededShuffle(titles, seed)[0])
    );
    // Twenty visits don't all start with the same title.
    assert.ok(starts.size > 10);
  });

  it('takes only a whole number in range as a seed', () => {
    assert.equal(shuffleSeed('42'), 42);
    assert.equal(shuffleSeed('0'), 0);
    // As the API's validator passes it on.
    assert.equal(shuffleSeed(7), 7);
    for (const bad of [
      '',
      '-1',
      '1.5',
      'x',
      String(2 ** 32),
      undefined,
      -1,
      1.5,
      2 ** 32,
      Number.NaN,
    ]) {
      assert.equal(shuffleSeed(bad), undefined, String(bad));
    }
  });
});
