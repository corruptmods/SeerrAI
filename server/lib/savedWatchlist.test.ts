import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import { savedWatchlistPage } from '@server/lib/savedWatchlist';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/*
 * A watchlist kept here (for someone not on Plex), a page at a time: in
 * the order added, or mixed by a seed that keeps its pages following on.
 */

setupTestDb();

let user: User;

beforeEach(async () => {
  user = await getRepository(User).findOneByOrFail({ id: 1 });
  for (let tmdbId = 1; tmdbId <= 7; tmdbId++) {
    const media = await getRepository(Media).save(
      new Media({ tmdbId, mediaType: MediaType.MOVIE })
    );
    await getRepository(Watchlist).save(
      Object.assign(new Watchlist(), {
        tmdbId,
        mediaType: MediaType.MOVIE,
        title: `Film ${tmdbId}`,
        requestedBy: user,
        media,
      })
    );
  }
});

const ids = (page: Watchlist[]) => page.map((item) => item.tmdbId);

describe('a watchlist kept here', () => {
  it('pages in the order added without a seed', async () => {
    const [first, total] = await savedWatchlistPage(user.id, 0, 3);
    assert.equal(total, 7);
    assert.deepEqual(ids(first), [1, 2, 3]);
  });

  it('mixes it by the seed, each page following on, none twice', async () => {
    const pages = [];
    for (const offset of [0, 3, 6]) {
      const [page, total] = await savedWatchlistPage(user.id, offset, 3, 42);
      assert.equal(total, 7);
      pages.push(...ids(page));
    }
    assert.deepEqual(
      [...pages].sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7]
    );
    assert.notDeepEqual(pages, [1, 2, 3, 4, 5, 6, 7], 'mixed');
    // The same seed gives the same order again.
    const [again] = await savedWatchlistPage(user.id, 0, 3, 42);
    assert.deepEqual(ids(again), pages.slice(0, 3));
  });
});
