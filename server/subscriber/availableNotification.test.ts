import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { MediaRequestWatcher } from '@server/entity/MediaRequestWatcher';
import NotificationDelivery from '@server/entity/NotificationDelivery';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import { Permission } from '@server/lib/permissions';
import { MediaSubscriber } from '@server/subscriber/MediaSubscriber';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { EntityManager } from 'typeorm';

/*
 * When a scan marks an approved title available, "now available" should go
 * out during that save — not minutes later from the reconciler — and once.
 *
 * Suspected: the notification reads the title on a connection that cannot
 * see the save's own uncommitted status on Postgres, skips, and is later
 * delivered by the reconciler.
 */

setupTestDb();

let sent: Notification[] = [];
let payloads: NotificationPayload[] = [];
Object.defineProperty(notificationManager, 'sendNotification', {
  configurable: true,
  value: (type: Notification, payload: NotificationPayload) => {
    sent.push(type);
    payloads.push(payload);
  },
});
Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async ({ movieId }: { movieId: number }) => ({
      id: movieId,
      title: 'Film',
      overview: '',
      release_date: '2020-01-01',
    });
  },
});
Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  configurable: true,
  set() {},
  get() {
    return async ({ tvId }: { tvId: number }) => ({
      id: tvId,
      name: 'Show',
      overview: '',
      first_air_date: '2020-01-01',
      seasons: [],
      external_ids: {},
      keywords: { results: [] },
    });
  },
});

let user: User;

beforeEach(async () => {
  sent = [];
  user = await getRepository(User).save(
    new User({
      email: 'avail@test.local',
      plexUsername: 'avail',
      permissions: Permission.REQUEST,
      avatar: '',
    })
  );
});

// Approved and sent, as a request is by the time its title arrives. Moved to
// approved without the save hooks, so no dispatch is attempted here.
const approvedRequest = async (media: Media, seasons?: number[]) => {
  const request = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: media.mediaType,
      media,
      requestedBy: user,
      status: MediaRequestStatus.PENDING,
      is4k: false,
      seasons: seasons?.map(
        (n) =>
          new SeasonRequest({
            seasonNumber: n,
            status: MediaRequestStatus.PENDING,
          })
      ),
    })
  );
  await getRepository(MediaRequest)
    .createQueryBuilder()
    .update()
    .set({ status: MediaRequestStatus.APPROVED })
    .where('id = :id', { id: request.id })
    .execute();
  await getRepository(SeasonRequest)
    .createQueryBuilder()
    .update()
    .set({ status: MediaRequestStatus.APPROVED })
    .where('requestId = :id', { id: request.id })
    .execute();
  return request;
};

describe('"now available" when a scan marks the title available', () => {
  it('goes out during the save for a movie, once', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 9101,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
        externalServiceId: 5,
      })
    );
    const request = await approvedRequest(media);
    sent = [];

    // What a scan does when the file arrives.
    const fresh = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    fresh.status = MediaStatus.AVAILABLE;
    await getRepository(Media).save(fresh);

    assert.deepEqual(
      sent.filter((t) => t === Notification.MEDIA_AVAILABLE).length,
      1,
      `sent during the save: ${JSON.stringify(sent)}`
    );
    assert.equal(
      await getRepository(NotificationDelivery).countBy({
        requestId: request.id,
        type: Notification.MEDIA_AVAILABLE,
      }),
      1,
      'claimed once'
    );
    const after = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
    });
    assert.equal(after.status, MediaRequestStatus.COMPLETED);
  });

  it('goes out during the save for a series, once', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 9201,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
        externalServiceId: 6,
        seasons: [
          new Season({ seasonNumber: 1, status: MediaStatus.PROCESSING }),
        ],
      })
    );
    const request = await approvedRequest(media, [1]);
    sent = [];

    const fresh = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
      relations: { seasons: true },
    });
    fresh.status = MediaStatus.AVAILABLE;
    fresh.seasons[0].status = MediaStatus.AVAILABLE;
    await getRepository(Media).save(fresh);

    assert.deepEqual(
      sent.filter((t) => t === Notification.MEDIA_AVAILABLE).length,
      1,
      `sent during the save: ${JSON.stringify(sent)}`
    );
    assert.equal(
      await getRepository(NotificationDelivery).countBy({
        requestId: request.id,
        type: Notification.MEDIA_AVAILABLE,
      }),
      1,
      'claimed once'
    );
  });

  it('posts to the channels once, however many people are watching', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 9102,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
        externalServiceId: 7,
      })
    );
    const request = await approvedRequest(media);
    for (const name of ['watcher-one', 'watcher-two']) {
      const watcher = await getRepository(User).save(
        new User({
          email: `${name}@test.local`,
          plexUsername: name,
          permissions: Permission.REQUEST,
          avatar: '',
        })
      );
      await getRepository(MediaRequestWatcher).save(
        new MediaRequestWatcher({ requestId: request.id, userId: watcher.id })
      );
    }
    sent = [];
    payloads = [];

    const fresh = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    fresh.status = MediaStatus.AVAILABLE;
    await getRepository(Media).save(fresh);

    assert.equal(payloads.length, 3, 'the requester and both watchers');
    assert.equal(
      payloads.filter((p) => p.notifySystem || p.notifyAdmin).length,
      1,
      'one post to the channels'
    );
    assert.deepEqual(payloads.map((p) => p.notifyUser?.plexUsername).sort(), [
      'avail',
      'watcher-one',
      'watcher-two',
    ]);
  });
});

// Several people asking for the same title is common in a household. When it
// arrives, every one of their requests completes in the same save, and each
// of them must hear about it once.
describe('several requests for the same title completing together', () => {
  const otherUsers = async (names: string[]) =>
    Promise.all(
      names.map((name) =>
        getRepository(User).save(
          new User({
            email: `${name}@test.local`,
            plexUsername: name,
            permissions: Permission.REQUEST,
            avatar: '',
          })
        )
      )
    );

  const requestBy = async (
    media: Media,
    requester: User,
    seasons?: number[]
  ) => {
    const original = user;
    user = requester;
    try {
      return await approvedRequest(media, seasons);
    } finally {
      user = original;
    }
  };

  it('completes every request for a movie and tells each requester once', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 9301,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
        externalServiceId: 8,
      })
    );
    const requesters = [user, ...(await otherUsers(['two', 'three']))];
    const requests = [];
    for (const requester of requesters) {
      requests.push(await requestBy(media, requester));
    }
    sent = [];
    payloads = [];

    const fresh = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    fresh.status = MediaStatus.AVAILABLE;
    await getRepository(Media).save(fresh);

    const after = await getRepository(MediaRequest).find({
      where: { media: { id: media.id } },
      order: { id: 'ASC' },
    });
    assert.deepEqual(
      after.map((r) => r.status),
      requests.map(() => MediaRequestStatus.COMPLETED),
      'every request completed'
    );
    assert.deepEqual(
      payloads.map((p) => p.notifyUser?.plexUsername).sort(),
      ['avail', 'three', 'two'],
      'each requester told once'
    );
    for (const request of requests) {
      assert.equal(
        await getRepository(NotificationDelivery).countBy({
          requestId: request.id,
          type: Notification.MEDIA_AVAILABLE,
        }),
        1,
        `request ${request.id} claimed once`
      );
    }
    const title = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.equal(title.status, MediaStatus.AVAILABLE, 'the scan was kept');
  });

  it('completes every request for a season and tells each requester once', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 9302,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
        externalServiceId: 9,
        seasons: [
          new Season({ seasonNumber: 1, status: MediaStatus.PROCESSING }),
        ],
      })
    );
    const [second] = await otherUsers(['two']);
    const requests = [
      await requestBy(media, user, [1]),
      await requestBy(media, second, [1]),
    ];
    sent = [];
    payloads = [];

    const fresh = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
      relations: { seasons: true },
    });
    fresh.status = MediaStatus.AVAILABLE;
    fresh.seasons[0].status = MediaStatus.AVAILABLE;
    await getRepository(Media).save(fresh);

    const after = await getRepository(MediaRequest).find({
      where: { media: { id: media.id } },
      order: { id: 'ASC' },
    });
    assert.deepEqual(
      after.map((r) => r.status),
      requests.map(() => MediaRequestStatus.COMPLETED),
      'every request completed'
    );
    assert.deepEqual(
      payloads.map((p) => p.notifyUser?.plexUsername).sort(),
      ['avail', 'two'],
      'each requester told once'
    );
    const title = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
      relations: { seasons: true },
    });
    assert.equal(title.status, MediaStatus.AVAILABLE, 'the scan was kept');
    assert.equal(title.seasons[0].status, MediaStatus.AVAILABLE);
  });

  // The save hook saves its completed requests one at a time. Put back the
  // single save of all of them that tripped over itself on Postgres: the
  // nested transactions their hooks open must now take turns by themselves.
  it('completes them all even when they are saved together', async () => {
    type Hook = (
      manager: EntityManager,
      event: Media,
      databaseEvent: Media,
      is4k: boolean
    ) => Promise<void>;
    const hooks = MediaSubscriber.prototype as unknown as {
      updateRelatedMediaRequest: Hook;
    };
    const oneAtATime = hooks.updateRelatedMediaRequest;
    hooks.updateRelatedMediaRequest = async (manager, event, _old, is4k) => {
      const repository = manager.getRepository(MediaRequest);
      const requests = await repository.find({
        relations: { media: true, requestedBy: true },
        where: {
          media: { id: event.id },
          status: MediaRequestStatus.APPROVED,
          is4k,
        },
      });
      requests.forEach((request) => {
        request.status = MediaRequestStatus.COMPLETED;
      });
      await repository.save(requests);
    };

    try {
      const media = await getRepository(Media).save(
        new Media({
          tmdbId: 9303,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.PROCESSING,
          externalServiceId: 10,
        })
      );
      const requesters = [user, ...(await otherUsers(['two', 'three']))];
      for (const requester of requesters) {
        await requestBy(media, requester);
      }
      payloads = [];

      const fresh = await getRepository(Media).findOneOrFail({
        where: { id: media.id },
      });
      fresh.status = MediaStatus.AVAILABLE;
      await getRepository(Media).save(fresh);

      const after = await getRepository(MediaRequest).find({
        where: { media: { id: media.id } },
      });
      assert.deepEqual(
        after.map((r) => r.status),
        requesters.map(() => MediaRequestStatus.COMPLETED),
        'every request completed'
      );
      assert.deepEqual(
        payloads.map((p) => p.notifyUser?.plexUsername).sort(),
        ['avail', 'three', 'two'],
        'each requester told once'
      );
      const title = await getRepository(Media).findOneOrFail({
        where: { id: media.id },
      });
      assert.equal(title.status, MediaStatus.AVAILABLE, 'the scan was kept');
    } finally {
      hooks.updateRelatedMediaRequest = oneAtATime;
    }
  });
});
