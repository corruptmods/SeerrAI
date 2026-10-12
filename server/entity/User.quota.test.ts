import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const stubTmdb = () => {
  const stub = (name: string, value: unknown) =>
    Object.defineProperty(TheMovieDb.prototype, name, {
      configurable: true,
      set() {},
      get() {
        return async () => value;
      },
    });

  stub('getMovie', { id: 1, title: 'M', release_date: '2026-01-01' });
  stub('getTvShow', {
    id: 1,
    name: 'S',
    first_air_date: '2026-01-01',
    seasons: [],
  });
};

/**
 * Quota accounting counts *seasons* for series, not requests — asking for four
 * seasons uses four of the allowance. This is the behaviour the UI and the
 * request path both depend on, and it had no coverage.
 */
describe('user request quotas', () => {
  setupTestDb();

  let user: User;
  let tmdbId: number;

  const addSeriesRequest = async (seasonNumbers: number[]) => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: tmdbId++,
        mediaType: MediaType.TV,
        status: MediaStatus.PENDING,
      })
    );

    const request = await getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        requestedBy: user,
        type: MediaType.TV,
        status: MediaRequestStatus.APPROVED,
        is4k: false,
      })
    );

    for (const seasonNumber of seasonNumbers) {
      await getRepository(SeasonRequest).save(
        new SeasonRequest({
          seasonNumber,
          status: MediaRequestStatus.APPROVED,
          request,
        } as never)
      );
    }

    return request;
  };

  const addMovieRequest = async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: tmdbId++,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PENDING,
      })
    );

    return getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        requestedBy: user,
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        is4k: false,
      })
    );
  };

  beforeEach(async () => {
    stubTmdb();
    tmdbId = 92000;

    await getRepository(User).save(
      new User({
        email: 'quota@test.local',
        plexUsername: 'quota-user',
        permissions: Permission.REQUEST,
        avatar: '',
        movieQuotaLimit: 5,
        movieQuotaDays: 7,
        tvQuotaLimit: 10,
        tvQuotaDays: 7,
      })
    );

    user = await getRepository(User).findOneOrFail({
      where: { plexUsername: 'quota-user' },
    });
  });

  it('counts seasons rather than series requests', async () => {
    await addSeriesRequest([1, 2, 3]);
    await addSeriesRequest([1]);

    const quota = await user.getQuota();

    assert.equal(quota.tv.used, 4, 'three seasons plus one');
    assert.equal(quota.tv.remaining, 6);
  });

  it('reports nothing used when there are no requests', async () => {
    const quota = await user.getQuota();

    assert.equal(quota.tv.used, 0);
    assert.equal(quota.movie.used, 0);
  });

  it('counts movies one apiece', async () => {
    await addMovieRequest();
    await addMovieRequest();

    const quota = await user.getQuota();

    assert.equal(quota.movie.used, 2);
    assert.equal(quota.movie.remaining, 3);
  });

  it('keeps movie and series allowances separate', async () => {
    await addSeriesRequest([1, 2]);
    await addMovieRequest();

    const quota = await user.getQuota();

    assert.equal(quota.tv.used, 2);
    assert.equal(quota.movie.used, 1);
  });

  it('ignores requests marked to bypass the quota', async () => {
    const request = await addSeriesRequest([1, 2]);
    request.ignoreQuota = true;
    await getRepository(MediaRequest).save(request);

    const quota = await user.getQuota();

    assert.equal(quota.tv.used, 0);
  });

  it('ignores declined requests', async () => {
    const request = await addSeriesRequest([1, 2, 3]);
    request.status = MediaRequestStatus.DECLINED;
    await getRepository(MediaRequest).save(request);

    const quota = await user.getQuota();

    assert.equal(quota.tv.used, 0);
  });
});
