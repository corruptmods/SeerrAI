import { posterPathsOf } from '@server/middleware/warmPosters';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('posters warmed from a page of titles', () => {
  it('takes each card poster, at the size the cards ask for', () => {
    assert.deepEqual(
      posterPathsOf({
        page: 1,
        results: [
          { id: 1, posterPath: '/abc123.jpg' },
          { id: 2, posterPath: null },
          { id: 3, profilePath: '/person.jpg' },
          { id: 4, posterPath: '/def-456.png' },
        ],
      }),
      [
        '/t/p/w300_and_h450_face/abc123.jpg',
        '/t/p/w300_and_h450_face/def-456.png',
      ]
    );
  });

  it('stops at one page, and ignores anything that is not a poster path', () => {
    const results = Array.from({ length: 30 }, (_, i) => ({
      posterPath: `/p${i}.jpg`,
    }));
    assert.equal(posterPathsOf({ results }).length, 20);
    assert.deepEqual(
      posterPathsOf({
        results: [
          { posterPath: 'https://elsewhere.example/x.jpg' },
          { posterPath: '/../../etc/passwd' },
        ],
      }),
      []
    );
    assert.deepEqual(posterPathsOf(null), []);
    assert.deepEqual(posterPathsOf({ results: 'nope' }), []);
  });
});
