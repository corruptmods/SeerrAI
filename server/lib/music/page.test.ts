import { MOST_PAGES, pageOf } from '@server/lib/music/page';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The page a music list is asked for, as a page that can be read.
 */

describe('the page asked for', () => {
  it('is a whole number from 1', () => {
    assert.equal(pageOf('3'), 3);
    assert.equal(pageOf(2), 2);
    assert.equal(pageOf('2.7'), 2);
  });

  it('is the first for anything else', () => {
    for (const value of [undefined, '', 'next', '0', '-4', 'NaN', '0.5']) {
      assert.equal(pageOf(value), 1, String(value));
    }
  });

  it('goes no further than a database or MusicBrainz can take', () => {
    assert.equal(pageOf('1e300'), MOST_PAGES);
    assert.equal(pageOf('Infinity'), 1);
    assert.equal(pageOf('40', 20), 20);
  });
});
