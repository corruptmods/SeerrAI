import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import NotificationDelivery from '@server/entity/NotificationDelivery';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import notificationManager, { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

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
Object.defineProperty(notificationManager, 'sendNotification', {
  configurable: true,
  value: (type: Notification) => {
    sent.push(type);
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
});
