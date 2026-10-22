import { coverPathsOf, posterPathsOf } from '@server/middleware/warmPosters';
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

describe('covers warmed from a page of music', () => {
  const cover = (id: string, size = '500') =>
    `https://coverartarchive.org/release-group/${id}/front-${size}`;
  const A = '7e41c0d8-5b29-3f6c-b8a4-91d6e2f07a35';
  const B = '4f6a2d93-c1e8-3a57-9b02-6d3e8f1c7a40';

  it('takes each album’s cover, from a page of results or search', () => {
    assert.deepEqual(
      coverPathsOf({
        results: [
          { mediaType: 'album', coverUrl: cover(A) },
          { mediaType: 'artist', id: 'x' },
        ],
      }),
      [`/release-group/${A}/front-500`]
    );
    assert.deepEqual(
      coverPathsOf({
        artists: [{ mediaType: 'artist' }],
        albums: [{ coverUrl: cover(B) }],
      }),
      [`/release-group/${B}/front-500`]
    );
  });

  it('stops at one page, and takes only the archive’s covers', () => {
    const results = Array.from({ length: 30 }, () => ({ coverUrl: cover(A) }));
    assert.equal(coverPathsOf({ results }).length, 20);
    assert.deepEqual(
      coverPathsOf({
        results: [
          { coverUrl: 'https://elsewhere.example/release-group/x/front-500' },
          { coverUrl: `https://coverartarchive.org/release-group/${A}/back` },
          { coverUrl: `https://coverartarchive.org/../release/${A}/front` },
          { posterPath: '/abc.jpg' },
        ],
      }),
      []
    );
    assert.deepEqual(coverPathsOf(null), []);
  });
});
