import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import {
  attachRequestCount,
  attachRequestCounts,
} from '@server/lib/userRequestCounts';
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
 * `requestCount` is shown on the profile and in the user list. It used to come
 * from a `@RelationCount` decorator; these cover the explicit replacement.
 */
describe('user request counts', () => {
  setupTestDb();

  let tmdbId: number;

  const makeUser = async (name: string) => {
    await getRepository(User).save(
      new User({
        email: `${name}@test.local`,
        plexUsername: name,
        permissions: Permission.REQUEST,
        avatar: '',
      })
    );

    return getRepository(User).findOneOrFail({ where: { plexUsername: name } });
  };

  const addRequest = async (user: User) => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: tmdbId++,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PENDING,
      })
    );

    await getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        requestedBy: user,
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        is4k: false,
      })
    );
  };

  beforeEach(() => {
    stubTmdb();
    tmdbId = 94000;
  });

  it('counts each user separately', async () => {
    const one = await makeUser('count-one');
    const two = await makeUser('count-two');

    await addRequest(one);
    await addRequest(one);
    await addRequest(two);

    await attachRequestCounts([one, two]);

    assert.equal(one.requestCount, 2);
    assert.equal(two.requestCount, 1);
  });

  it('counts music requests too, once each however many albums', async () => {
    const user = await makeUser('count-music');
    await addRequest(user);
    const artist = await dataSource.manager.save(
      new Media({
        tmdbId: 0,
        mediaType: MediaType.MUSIC,
        foreignId: '3c9e5f21-8d47-4b6a-a1e3-5f7d2c90b844',
        status: MediaStatus.PENDING,
      }),
      { listeners: false }
    );
    await dataSource.manager.save(
      new MediaRequest({
        media: artist,
        requestedBy: user,
        type: MediaType.MUSIC,
        status: MediaRequestStatus.PENDING,
        is4k: false,
        albums: ['Static Garden', 'Fog B'].map(
          (title, i) => new AlbumRequest({ albumMbid: `album-${i}`, title })
        ),
      }),
      { listeners: false }
    );

    await attachRequestCount(user);

    assert.equal(user.requestCount, 2);
  });

  it('reports zero for a user with no requests', async () => {
    const user = await makeUser('count-none');

    await attachRequestCount(user);

    // Must be 0, not undefined — the profile formats this as a number.
    assert.equal(user.requestCount, 0);
  });

  it('does nothing gracefully with no users', async () => {
    await attachRequestCounts([]);
  });

  it('defaults to zero before anything fills it in', async () => {
    const user = await makeUser('count-default');

    assert.equal(
      user.requestCount,
      0,
      'a freshly loaded user must not read as undefined'
    );
  });
});
