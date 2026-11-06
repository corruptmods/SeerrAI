import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import { savedWatchlistPage } from '@server/lib/savedWatchlist';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/* A Seerr-side watchlist (for users not on Plex), paged, in added order. */

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

  it('pages newest added first, or oldest first, when asked', async () => {
    const [newest, total] = await savedWatchlistPage(
      user.id,
      0,
      3,
      'added-desc'
    );
    assert.equal(total, 7);
    assert.deepEqual(ids(newest), [7, 6, 5]);
    const [next] = await savedWatchlistPage(user.id, 3, 3, 'added-desc');
    assert.deepEqual(ids(next), [4, 3, 2]);
    const [oldest] = await savedWatchlistPage(user.id, 0, 3, 'added-asc');
    assert.deepEqual(ids(oldest), [1, 2, 3]);
  });

  it('pages by title, leaving out a leading article', async () => {
    const titles: Record<number, string> = {
      1: 'Static Garden',
      2: 'The Harbour Lights',
      3: 'glasswing',
      4: 'Lantern Song',
      5: 'A Lantern Song 2',
      6: 'Lantern Song 10',
      7: 'Amber Fields',
    };
    for (const [tmdbId, title] of Object.entries(titles)) {
      await getRepository(Watchlist).update(
        { tmdbId: Number(tmdbId) },
        { title }
      );
    }

    const [first, total] = await savedWatchlistPage(user.id, 0, 4, 'title');
    assert.equal(total, 7);
    assert.deepEqual(ids(first), [7, 3, 2, 4]);
    assert.equal(first[0].media.tmdbId, 7, 'with its media');
    const [rest] = await savedWatchlistPage(user.id, 4, 4, 'title');
    assert.deepEqual(ids(rest), [5, 6, 1]);
  });
});
