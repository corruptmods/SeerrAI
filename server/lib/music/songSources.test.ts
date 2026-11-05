import type { ProwlarrRelease } from '@server/api/prowlarr';
import { MAX_NAMED, readNamed } from '@server/lib/music/songSources';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * AI fallback picks: only listed releases, deduplicated, at most three.
 * Names are invented.
 */

const release = (n: number): ProwlarrRelease => ({
  guid: `https://indexer/${n}`,
  title: `Glasswing - Album ${n}`,
  size: 100_000_000,
  indexerId: 1,
  indexer: 'Knaben',
  protocol: 'torrent',
});

describe('the releases the model names', () => {
  it('are only those it was shown, each once, at most three', () => {
    const listed = [1, 2, 3, 4, 5].map(release);
    assert.deepEqual(
      readNamed([2, 9, 0, -1, 2, 1, 4, 5], listed).map((r) => r.guid),
      ['https://indexer/2', 'https://indexer/1', 'https://indexer/4']
    );
    assert.equal(readNamed([1, 2, 3, 4, 5], listed).length, MAX_NAMED);
    assert.deepEqual(readNamed([], listed), []);
  });
});
