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
 * Pins the path behind a live loop: TMDB 113988 requested as a movie with
 * TVDB 389492, which media 225634 already holds. Every three minutes it
 * notified and left no row behind.
 *
 * These pass, which is the point — on SQLite the media row persists and the
 * repeat is refused, so the request logic is sound and the live divergence is
 * elsewhere. They guard the two properties the loop violated.
 */
describe('repeat auto-requests for a colliding title', () => {
  setupTestDb();

  let user: User;

  const stub = (name: string, value: unknown) =>
    Object.defineProperty(TheMovieDb.prototype, name, {
      configurable: true,
      set() {},
      get() {
        return async () => value;
      },
    });

  beforeEach(async () => {
    stub('getMovie', {
      id: 113988,
      title: 'Monster',
      release_date: '2022-01-01',
      external_ids: { tvdb_id: 389492 },
    });
    stub('getTvShow', {
      id: 113988,
      name: 'DAHMER',
      first_air_date: '2022-09-21',
      external_ids: { tvdb_id: 389492 },
      seasons: [{ season_number: 1, episode_count: 10 }],
    });

    await getRepository(User).save(
      new User({
        email: 'loop@test.local',
        plexUsername: 'loop-user',
        permissions: Permission.ADMIN,
        avatar: '',
      })
    );
    user = await getRepository(User).findOneOrFail({
      where: { plexUsername: 'loop-user' },
    });

    // The anthology row that already owns the TVDB id.
    await getRepository(Media).save(
      new Media({
        tmdbId: 225634,
        tvdbId: 389492,
        mediaType: MediaType.TV,
        status: MediaStatus.AVAILABLE,
      })
    );
  });

  it('persists media when requested as a movie with a colliding TVDB id', async () => {
    await MediaRequest.request(
      {
        mediaId: 113988,
        mediaType: MediaType.MOVIE,
        tvdbId: 389492,
        is4k: false,
      } as never,
      user,
      { isAutoRequest: true }
    );

    const media = await getRepository(Media).findOne({
      where: { tmdbId: 113988, mediaType: MediaType.MOVIE },
    });

    assert.ok(media, 'the media row must survive the request');

    const requests = await getRepository(MediaRequest).countBy({});
    assert.equal(requests, 1, 'and so must the request');
  });

  it('does not create a second request on the next sync', async () => {
    const attempt = async () =>
      MediaRequest.request(
        {
          mediaId: 113988,
          mediaType: MediaType.MOVIE,
          tvdbId: 389492,
          is4k: false,
        } as never,
        user,
        { isAutoRequest: true }
      ).catch((e) => e);

    await attempt();
    const second = await attempt();

    // The second attempt should be refused as a duplicate, not create another.
    assert.ok(second instanceof Error, 'a repeat must be refused');
    assert.equal(await getRepository(MediaRequest).countBy({}), 1);
  });
});
