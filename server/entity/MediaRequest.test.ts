import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import ExternalAPI from '@server/api/externalapi';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  DuplicateMediaRequestError,
  MediaRequest,
  QuotaRestrictedError,
} from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import { requestMissing } from '@server/lib/requestMissing';
import { getSettings } from '@server/lib/settings';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';

// get is a prototype method, unlike getMovie, and also replaces the cache
// lookup.
const externalApiGetMock = mock.method(
  ExternalAPI.prototype as unknown as {
    get: (endpoint: string) => Promise<unknown>;
  },
  'get',
  async (endpoint: string) => {
    const tmdbId = Number(endpoint.replace(/^\/(movie|tv)\//, ''));

    if (!tmdbId) {
      throw new Error(`Unstubbed external endpoint: ${endpoint}`);
    }

    return {
      id: tmdbId,
      external_ids: {},
      seasons: [1, 2, 3].map((season_number) => ({ season_number })),
      // Skips getMovie's localized fallback call.
      videos: { results: [{ type: 'Trailer', key: 'trailer' }] },
    };
  }
).mock;

mock.method(MediaRequest, 'sendNotification', async () => undefined);

setupTestDb();

beforeEach(() => {
  externalApiGetMock.resetCalls();
});

async function seedRequester(movieQuotaLimit: number): Promise<User> {
  const userRepository = getRepository(User);

  const requester = await userRepository.findOneOrFail({
    where: { email: 'friend@seerr.dev' },
  });
  requester.movieQuotaLimit = movieQuotaLimit;

  return userRepository.save(requester);
}

async function createRequester(
  email: string,
  permissions = Permission.REQUEST
): Promise<User> {
  return getRepository(User).save(new User({ email, permissions, avatar: '' }));
}

function requestMovies(mediaIds: number[], requester: User) {
  return Promise.allSettled(
    mediaIds.map((mediaId) =>
      MediaRequest.request(
        { mediaId, mediaType: MediaType.MOVIE, is4k: false },
        requester
      )
    )
  );
}

function rejections(results: PromiseSettledResult<MediaRequest>[]) {
  return results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
}

describe('MediaRequest.request', () => {
  it('rejects the second of two concurrent requests at the movie quota', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(1);

    const results = await requestMovies([11111, 22222], requester);
    const rejected = rejections(results);

    assert.strictEqual(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof QuotaRestrictedError);
    assert.strictEqual(await requestRepository.count(), 1);
    assert.strictEqual(externalApiGetMock.callCount(), 1);
  });

  it('makes no automatic request for a movie already available', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    await getRepository(Media).save(
      new Media({
        tmdbId: 77777,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const body = { mediaId: 77777, mediaType: MediaType.MOVIE, is4k: false };

    await assert.rejects(
      () => MediaRequest.request(body, requester, { isAutoRequest: true }),
      DuplicateMediaRequestError
    );
    assert.strictEqual(await requestRepository.count(), 0);
  });

  it('never tells a user a request was declined because it completed meanwhile', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 88888,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const request = new MediaRequest({
      type: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
      media,
      is4k: false,
    });
    // Dispatch completes it while its media is being looked up.
    const repository = getRepository(Media);
    const findOne = repository.findOne.bind(repository);
    const lookup = mock.method(
      repository,
      'findOne',
      async (...args: Parameters<typeof findOne>) => {
        request.status = MediaRequestStatus.COMPLETED;
        return findOne(...args);
      }
    );
    const sent: Notification[] = [];
    const notify = mock.method(
      MediaRequest,
      'sendNotification',
      async (_request: MediaRequest, _media: Media, type: Notification) => {
        sent.push(type);
      }
    );
    try {
      await request.notifyApprovedOrDeclined(true);
    } finally {
      lookup.mock.restore();
      notify.mock.restore();
    }
    assert.deepStrictEqual(sent, [Notification.MEDIA_AVAILABLE]);
  });

  it('rejects a concurrent duplicate request for the same movie', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);

    const results = await requestMovies([33333, 33333], requester);
    const rejected = rejections(results);

    assert.strictEqual(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof DuplicateMediaRequestError);
    assert.strictEqual(await requestRepository.count(), 1);
    assert.strictEqual(externalApiGetMock.callCount(), 2);
  });

  it('rejects a duplicate request that omits is4k', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const body = { mediaId: 66666, mediaType: MediaType.MOVIE };

    await MediaRequest.request(body, requester);

    await assert.rejects(
      () => MediaRequest.request(body, requester),
      DuplicateMediaRequestError
    );
    assert.strictEqual(await requestRepository.count(), 1);
  });

  it('rejects a duplicate while any earlier request is still open', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const other = await createRequester('second@seerr.dev');
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 99001,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    // An old declined request, then one awaiting approval.
    for (const status of [
      MediaRequestStatus.DECLINED,
      MediaRequestStatus.PENDING,
    ]) {
      await requestRepository.save(
        new MediaRequest({
          type: MediaType.MOVIE,
          status,
          media,
          requestedBy: other,
          is4k: false,
        })
      );
    }

    await assert.rejects(
      () =>
        MediaRequest.request(
          { mediaId: 99001, mediaType: MediaType.MOVIE, is4k: false },
          requester
        ),
      DuplicateMediaRequestError
    );
    assert.strictEqual(await requestRepository.count(), 2);
  });

  it('rejects a concurrent duplicate request from a different user', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester('second@seerr.dev');

    const results = await Promise.allSettled(
      [requester, otherRequester].map((user) =>
        MediaRequest.request(
          { mediaId: 44444, mediaType: MediaType.MOVIE, is4k: false },
          user
        )
      )
    );
    const rejected = rejections(results);

    assert.strictEqual(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof DuplicateMediaRequestError);
    assert.strictEqual(await requestRepository.count(), 1);
  });

  it('gives an overlapping season to only one of two concurrent users', async () => {
    const seasonRequestRepository = getRepository(SeasonRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester('second@seerr.dev');

    const results = await Promise.allSettled(
      [
        [requester, [1, 2]],
        [otherRequester, [2, 3]],
      ].map(([user, seasons]) =>
        MediaRequest.request(
          {
            mediaId: 55555,
            mediaType: MediaType.TV,
            seasons: seasons as number[],
            is4k: false,
          },
          user as User
        )
      )
    );

    assert.strictEqual(rejections(results).length, 0);
    assert.strictEqual(
      await seasonRequestRepository.count({ where: { seasonNumber: 2 } }),
      1
    );
    assert.strictEqual(await seasonRequestRepository.count(), 3);
  });

  it('creates one media row for concurrent 4k and non-4k requests', async () => {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester(
      'second@seerr.dev',
      Permission.REQUEST_4K
    );

    const results = await Promise.allSettled(
      [
        [requester, false],
        [otherRequester, true],
      ].map(([user, is4k]) =>
        MediaRequest.request(
          { mediaId: 88888, mediaType: MediaType.MOVIE, is4k: is4k as boolean },
          user as User
        )
      )
    );

    assert.strictEqual(rejections(results).length, 0);
    assert.strictEqual(await requestRepository.count(), 2);
    assert.strictEqual(
      await mediaRepository.count({
        where: { tmdbId: 88888, mediaType: MediaType.MOVIE },
      }),
      1
    );
  });
});

describe('saving a request', () => {
  it('neither announces it again nor sends it on when its status is unchanged', async (t) => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 99101,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const { id } = await requestRepository.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: requester,
        is4k: false,
      })
    );
    // Approved long ago, bypassing save hooks.
    await requestRepository.update(id, {
      status: MediaRequestStatus.APPROVED,
    });

    const notify = t.mock.method(
      MediaRequest,
      'sendNotification',
      async () => true
    );
    const sendToRadarr = t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );

    const request = await requestRepository.findOneOrFail({ where: { id } });
    request.requesterMuted = true;
    await requestRepository.save(request);

    assert.strictEqual(notify.mock.callCount(), 0, 'nobody told again');
    assert.strictEqual(sendToRadarr.mock.callCount(), 0, 'not sent again');
    assert.strictEqual(
      (await getRepository(Media).findOneOrFail({ where: { id: media.id } }))
        .status,
      MediaStatus.PROCESSING
    );

    // A real status change is still announced.
    request.status = MediaRequestStatus.DECLINED;
    await requestRepository.save(request);

    assert.deepStrictEqual(
      notify.mock.calls.map((call) => call.arguments[2]),
      [Notification.MEDIA_DECLINED]
    );
  });

  it('logs a failed automatic approval notice rather than leaving it unhandled', async (t) => {
    t.mock.method(
      MediaRequest.prototype,
      'notifyApprovedOrDeclined',
      async () => {
        throw new Error('The database went away');
      }
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      await new MediaRequest({
        status: MediaRequestStatus.APPROVED,
      }).autoapprovalNotification();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    assert.deepStrictEqual(unhandled, []);
  });
});

describe('a request over the quota, when such requests wait for an admin', () => {
  const settings = getSettings();

  beforeEach(() => {
    settings.main.overQuotaRequests = true;
  });

  afterEach(() => {
    settings.main.overQuotaRequests = false;
  });

  const limited = async (
    email: string,
    permissions: number,
    quota: { movieQuotaLimit?: number; tvQuotaLimit?: number }
  ) => {
    const user = await createRequester(email, permissions);
    Object.assign(user, quota);
    return getRepository(User).save(user);
  };

  it('is saved pending and marked, never approved automatically', async () => {
    const requester = await limited(
      'glasswing@example.invalid',
      Permission.REQUEST + Permission.AUTO_APPROVE,
      { movieQuotaLimit: 1 }
    );
    await MediaRequest.request(
      { mediaId: 41001, mediaType: MediaType.MOVIE, is4k: false },
      requester
    );
    settings.main.overQuotaRequests = false;
    await assert.rejects(
      () =>
        MediaRequest.request(
          { mediaId: 41002, mediaType: MediaType.MOVIE, is4k: false },
          requester
        ),
      QuotaRestrictedError
    );
    settings.main.overQuotaRequests = true;

    const request = await MediaRequest.request(
      { mediaId: 41002, mediaType: MediaType.MOVIE, is4k: false },
      requester
    );

    assert.strictEqual(request.status, MediaRequestStatus.PENDING);
    assert.strictEqual(request.overQuota, true);
    assert.strictEqual(request.modifiedBy ?? null, null);
  });

  it('is not marked when within the quota', async () => {
    const requester = await limited(
      'harbour@example.invalid',
      Permission.REQUEST,
      { movieQuotaLimit: 2 }
    );

    const request = await MediaRequest.request(
      { mediaId: 41003, mediaType: MediaType.MOVIE, is4k: false },
      requester
    );

    assert.strictEqual(request.status, MediaRequestStatus.PENDING);
    assert.strictEqual(request.overQuota, false);
  });

  it('takes every season of a series that needs more than are left', async () => {
    const requester = await limited(
      'lantern@example.invalid',
      Permission.REQUEST + Permission.AUTO_APPROVE,
      { tvQuotaLimit: 2 }
    );

    const request = await MediaRequest.request(
      { mediaId: 41004, mediaType: MediaType.TV, seasons: [1, 2, 3] },
      requester
    );

    assert.strictEqual(request.status, MediaRequestStatus.PENDING);
    assert.strictEqual(request.overQuota, true);
    assert.deepStrictEqual(
      request.seasons.map((season) => season.status),
      [
        MediaRequestStatus.PENDING,
        MediaRequestStatus.PENDING,
        MediaRequestStatus.PENDING,
      ]
    );
    assert.strictEqual((await requester.getQuota()).tv.used, 3);
  });

  it('stops counting towards the quota once declined', async () => {
    const requester = await limited(
      'static@example.invalid',
      Permission.REQUEST,
      { movieQuotaLimit: 1 }
    );
    await MediaRequest.request(
      { mediaId: 41005, mediaType: MediaType.MOVIE, is4k: false },
      requester
    );
    const over = await MediaRequest.request(
      { mediaId: 41006, mediaType: MediaType.MOVIE, is4k: false },
      requester
    );
    assert.strictEqual((await requester.getQuota()).movie.used, 2);

    over.status = MediaRequestStatus.DECLINED;
    await getRepository(MediaRequest).save(over);

    assert.strictEqual((await requester.getQuota()).movie.used, 1);
  });

  it('is still refused for an automatic request', async () => {
    const requester = await limited(
      'watchlist@example.invalid',
      Permission.REQUEST + Permission.AUTO_REQUEST,
      { movieQuotaLimit: 1 }
    );
    await MediaRequest.request(
      { mediaId: 41007, mediaType: MediaType.MOVIE, is4k: false },
      requester
    );

    await assert.rejects(
      () =>
        MediaRequest.request(
          { mediaId: 41008, mediaType: MediaType.MOVIE, is4k: false },
          requester,
          { isAutoRequest: true }
        ),
      QuotaRestrictedError
    );
  });

  it('is still refused for a title added to a list, or several requested at once', async () => {
    const requester = await limited(
      'lists@example.invalid',
      Permission.REQUEST,
      { movieQuotaLimit: 1 }
    );
    await MediaRequest.request(
      { mediaId: 41009, mediaType: MediaType.MOVIE, is4k: false },
      requester
    );

    assert.deepStrictEqual(await requestMissing(41010, 'movie', requester), {
      outcome: 'failed',
      message: 'Your request limit has been reached.',
    });
    assert.strictEqual((await requester.getQuota()).movie.used, 1);
  });

  it('tells admins in the pending notification that it is over the limit', async (t) => {
    const notify = t.mock.method(
      MediaRequest,
      'sendNotification',
      async () => true
    );
    const requester = await limited(
      'notice@example.invalid',
      Permission.REQUEST,
      { movieQuotaLimit: 1 }
    );
    await MediaRequest.request(
      { mediaId: 41009, mediaType: MediaType.MOVIE, is4k: false },
      requester
    );
    await MediaRequest.request(
      { mediaId: 41010, mediaType: MediaType.MOVIE, is4k: false },
      requester
    );

    const pending = notify.mock.calls.filter(
      (call) => call.arguments[2] === Notification.MEDIA_PENDING
    );
    assert.strictEqual(pending.length, 2);
    assert.strictEqual(pending[0].arguments[4], undefined);
    assert.deepStrictEqual(pending[1].arguments[4], [
      { name: 'Quota', value: 'Over the requester’s limit' },
    ]);
  });
});
