import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { markUndispatchable } from '@server/lib/requestDispatch';
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

  stub('getMovie', { id: 1, title: 'Test Movie', release_date: '2026-01-01' });
  stub('getTvShow', {
    id: 1,
    name: 'Test Series',
    first_air_date: '2026-01-01',
    seasons: [],
  });
};

/**
 * Upstream logs and returns when no Radarr or Sonarr server can be resolved,
 * leaving the request APPROVED forever. `POST /request/:id/retry` refuses
 * anything that is not FAILED, so the request could only be deleted and
 * remade (seerr-team/seerr#3460).
 */
describe('markUndispatchable', () => {
  setupTestDb();

  let request: MediaRequest;

  beforeEach(async () => {
    stubTmdb();

    await getRepository(User).save(
      new User({
        email: 'dispatch@test.local',
        plexUsername: 'dispatch-user',
        permissions: Permission.REQUEST,
        avatar: '',
      })
    );
    const user = await getRepository(User).findOneOrFail({
      where: { plexUsername: 'dispatch-user' },
    });

    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 70001,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
      })
    );

    request = await getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        requestedBy: user,
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        is4k: false,
      })
    );
  });

  it('marks a stranded request failed so it can be retried', async () => {
    await markUndispatchable(request, 'No default Radarr server configured.');

    const stored = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
    });

    assert.equal(
      stored.status,
      MediaRequestStatus.FAILED,
      'retry only accepts FAILED, so the request must land there'
    );
  });

  it('keeps the request rather than discarding it', async () => {
    await markUndispatchable(request, 'No default Radarr server configured.');

    assert.equal(
      await getRepository(MediaRequest).countBy({ id: request.id }),
      1
    );
  });

  it('is safe to call twice', async () => {
    await markUndispatchable(request, 'first');
    await markUndispatchable(request, 'second');

    const stored = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
    });

    assert.equal(stored.status, MediaRequestStatus.FAILED);
    assert.equal(
      await getRepository(MediaRequest).countBy({ id: request.id }),
      1
    );
  });
});
