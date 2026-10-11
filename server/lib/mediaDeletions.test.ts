import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MediaDeletion from '@server/entity/MediaDeletion';
import {
  getDeletionTimes,
  recordMediaDeletion,
} from '@server/lib/mediaDeletions';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Deletion times live outside Media because deleting a title can remove that
 * row outright, and watchlist sync still needs the date afterwards.
 */
describe('media deletion records', () => {
  setupTestDb();

  it('records a deletion and reads it back', async () => {
    await recordMediaDeletion(550, MediaType.MOVIE);

    const times = await getDeletionTimes([550]);

    assert.ok(times.get(`${MediaType.MOVIE}:550`) instanceof Date);
  });

  it('keeps the most recent deletion when a title is removed twice', async () => {
    await recordMediaDeletion(550, MediaType.MOVIE);

    const first = (await getDeletionTimes([550])).get(`${MediaType.MOVIE}:550`);

    await new Promise((resolve) => setTimeout(resolve, 10));
    await recordMediaDeletion(550, MediaType.MOVIE);

    const second = (await getDeletionTimes([550])).get(`${MediaType.MOVIE}:550`);

    assert.ok(
      (second as Date).getTime() >= (first as Date).getTime(),
      're-adding and deleting again must move the line forward'
    );
    assert.equal(
      await getRepository(MediaDeletion).countBy({ tmdbId: 550 }),
      1,
      'one row per title, not one per deletion'
    );
  });

  it('keeps a movie and a series with the same id apart', async () => {
    await recordMediaDeletion(550, MediaType.MOVIE);

    const times = await getDeletionTimes([550]);

    assert.ok(times.has(`${MediaType.MOVIE}:550`));
    assert.ok(!times.has(`${MediaType.TV}:550`));
  });

  it('returns nothing for titles never deleted', async () => {
    const times = await getDeletionTimes([999]);

    assert.equal(times.size, 0);
  });

  it('handles an empty lookup without querying', async () => {
    const times = await getDeletionTimes([]);

    assert.equal(times.size, 0);
  });
});
