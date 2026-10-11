import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { runHealthCheck } from '@server/lib/health';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Collections the library has part of, as the health page lists them, with
 * TMDB stubbed.
 */

setupTestDb();

const DAY = 24 * 60 * 60 * 1000;
const released = (days: number) =>
  new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
const collectionOf: Record<number, { id: number; name: string } | undefined> = {
  1: { id: 10, name: 'Insidious Collection' },
  2: { id: 10, name: 'Insidious Collection' },
  5: { id: 20, name: 'Complete Collection' },
  7: undefined,
};
const collections: Record<
  number,
  { name: string; parts: { id: number; release_date: string }[] }
> = {
  10: {
    name: 'Insidious Collection',
    parts: [
      { id: 1, release_date: released(3000) },
      { id: 2, release_date: released(2000) },
      { id: 3, release_date: released(1000) },
      { id: 4, release_date: released(-30) },
    ],
  },
  20: {
    name: 'Complete Collection',
    parts: [
      { id: 5, release_date: released(500) },
      { id: 6, release_date: released(400) },
    ],
  },
};
Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async ({ movieId }: { movieId: number }) => ({
      id: movieId,
      belongs_to_collection: collectionOf[movieId],
    });
  },
});
Object.defineProperty(TheMovieDb.prototype, 'getCollection', {
  configurable: true,
  set() {},
  get() {
    return async ({ collectionId }: { collectionId: number }) => ({
      id: collectionId,
      ...collections[collectionId],
    });
  },
});

describe('collection gaps', () => {
  it('lists collections with released films missing, and not complete or unreleased ones', async () => {
    const save = (tmdbId: number, status: MediaStatus) =>
      getRepository(Media).save(
        new Media({ tmdbId, mediaType: MediaType.MOVIE, status })
      );
    await save(1, MediaStatus.AVAILABLE);
    await save(2, MediaStatus.PARTIALLY_AVAILABLE);
    await save(5, MediaStatus.AVAILABLE);
    await save(6, MediaStatus.PROCESSING);
    await save(7, MediaStatus.AVAILABLE);

    const first = await runHealthCheck('collectionGaps', 1);
    assert.match(
      first!.name!,
      /checking your library/,
      'the first list is still being built'
    );
    assert.equal(first!.status, 'ok', 'a gap is not a problem');

    let check = first;
    for (let i = 0; i < 50 && check?.name; i++) {
      await new Promise((r) => setTimeout(r, 50));
      check = await runHealthCheck('collectionGaps', 1);
    }
    assert.equal(check!.status, 'ok');
    assert.deepEqual(
      check!.items.map((item) => [item.title, item.detail, item.href]),
      [
        [
          'Insidious Collection',
          '2 of 3 in your library · 1 missing',
          '/collection/10',
        ],
      ],
      'the film not out yet is not missing; the collection with the rest requested has no gap'
    );
  });
});
