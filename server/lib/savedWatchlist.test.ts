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
 * A watchlist kept here (for someone not on Plex), a page at a time, in
 * the order added.
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
  it('pages in the order added', async () => {
    const [first, total] = await savedWatchlistPage(user.id, 0, 3);
    assert.equal(total, 7);
    assert.deepEqual(ids(first), [1, 2, 3]);
  });
});
