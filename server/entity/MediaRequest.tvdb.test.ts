import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/**
 * `media.tvdbId` is unique across the table, but media is looked up by
 * `tmdbId`. Plex sometimes maps two TMDB entries onto one TVDB id — a remake
 * and its original — and the insert then fails, losing the request.
 */
describe('request creation with a conflicting TVDB ID', () => {
  setupTestDb();

  let user: User;

  const stubTmdb = (tmdbId: number, tvdbId: number | null) => {
    const stub = (name: string, value: unknown) =>
      Object.defineProperty(TheMovieDb.prototype, name, {
        configurable: true,
        set() {},
        get() {
          return async () => value;
        },
      });

    stub('getTvShow', {
      id: tmdbId,
      name: `Show ${tmdbId}`,
      first_air_date: '2026-01-01',
      external_ids: { tvdb_id: tvdbId },
      seasons: [{ season_number: 1, episode_count: 4 }],
    });
    stub('getMovie', {
      id: tmdbId,
      title: `Movie ${tmdbId}`,
      release_date: '2026-01-01',
      external_ids: { tvdb_id: tvdbId },
    });
  };

  beforeEach(async () => {
    await getRepository(User).save(
      new User({
        email: 'tvdb@test.local',
        plexUsername: 'tvdb-user',
        permissions: Permission.ADMIN,
        avatar: '',
      })
    );

    user = await getRepository(User).findOneOrFail({
      where: { plexUsername: 'tvdb-user' },
    });
  });

  it('still creates the request when another title holds that TVDB ID', async () => {
    // An existing title already using TVDB 12345.
    await getRepository(Media).save(
      new Media({
        tmdbId: 700,
        tvdbId: 12345,
        mediaType: MediaType.TV,
        status: MediaStatus.AVAILABLE,
      })
    );

    stubTmdb(701, 12345);

    await MediaRequest.request(
      {
        mediaId: 701,
        mediaType: MediaType.TV,
        seasons: 'all',
        tvdbId: 12345,
      } as never,
      user
    );

    const created = await getRepository(Media).findOne({
      where: { tmdbId: 701, mediaType: MediaType.TV },
    });

    assert.ok(created, 'the request must not be lost to the collision');
    assert.equal(
      created?.tvdbId,
      null,
      'the colliding id is dropped rather than failing the insert'
    );

    assert.equal(
      await getRepository(Media).countBy({ tvdbId: 12345 }),
      1,
      'the original keeps the id'
    );
  });

  it('keeps the TVDB ID when nothing else is using it', async () => {
    stubTmdb(702, 54321);

    await MediaRequest.request(
      {
        mediaId: 702,
        mediaType: MediaType.TV,
        seasons: 'all',
        tvdbId: 54321,
      } as never,
      user
    );

    const created = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 702, mediaType: MediaType.TV },
    });

    assert.equal(created.tvdbId, 54321);
  });

  it('handles a title with no TVDB ID at all', async () => {
    stubTmdb(703, null);

    await MediaRequest.request(
      { mediaId: 703, mediaType: MediaType.MOVIE } as never,
      user
    );

    const created = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 703, mediaType: MediaType.MOVIE },
    });

    assert.ok(!created.tvdbId);
  });
});
