import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import Media from '@server/entity/Media';
import MediaEvent from '@server/entity/MediaEvent';
import { MediaRequest } from '@server/entity/MediaRequest';
import { MediaRequestWatcher } from '@server/entity/MediaRequestWatcher';
import MusicAlbum from '@server/entity/MusicAlbum';
import { User } from '@server/entity/User';
import {
  completeMusicRequests,
  notifyAvailableMusic,
} from '@server/lib/music/completion';
import notificationReconciler from '@server/lib/notificationReconciler';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * Closing the loop on music: a request is done once every album it asked
 * for is here, and whoever asked hears about it exactly once, whether the
 * scan or the catch-up pass gets there first.
 */

setupTestDb();

const ARTIST = '3c9e5f21-8d47-4b6a-a1e3-5f7d2c90b844';
const STATIC_GARDEN = '4f6a2d93-c1e8-3a57-9b02-6d3e8f1c7a40';
const FOG_B = '7e41c0d8-5b29-3f6c-b8a4-91d6e2f07a35';

const sent: { type: Notification; payload: NotificationPayload }[] = [];
const ofType = (type: Notification) =>
  sent.filter((s) => s.type === type).map((s) => s.payload);

/** The artist, as the music scans keep them, with albums in these states. */
const seedArtist = async (
  albums: { mbId: string; title: string; status: MediaStatus }[],
  status = MediaStatus.PROCESSING
): Promise<Media> => {
  const media = await dataSource.manager.save(
    new Media({
      mediaType: MediaType.MUSIC,
      tmdbId: 0,
      foreignId: ARTIST,
      foreignTitle: 'Glasswing',
      status,
    }),
    { listeners: false }
  );
  for (const album of albums) {
    await getRepository(MusicAlbum).insert(
      new MusicAlbum({
        mediaId: media.id,
        mbId: album.mbId,
        title: album.title,
        secondaryTypes: [],
        status: album.status,
      })
    );
  }
  return media;
};

/** A request for these albums, saved as it would be, without its hooks. */
const seedRequest = async (
  media: Media,
  albums: { mbId: string; title: string; status?: MediaRequestStatus }[],
  status = MediaRequestStatus.APPROVED
): Promise<MediaRequest> => {
  const saved = await dataSource.manager.save(
    new MediaRequest({
      type: MediaType.MUSIC,
      status,
      media,
      requestedBy: await getRepository(User).findOneByOrFail({ id: 2 }),
      is4k: false,
      albums: albums.map(
        (album) =>
          new AlbumRequest({
            albumMbid: album.mbId,
            title: album.title,
            status: album.status ?? status,
          })
      ),
    }),
    { listeners: false }
  );
  return getRepository(MediaRequest).findOneByOrFail({ id: saved.id });
};

const setAlbum = (mbId: string, status: MediaStatus) =>
  getRepository(MusicAlbum).update({ mbId }, { status });

const statusOf = async (id: number) =>
  (await getRepository(MediaRequest).findOneByOrFail({ id })).status;

const albumStatuses = async (requestId: number) =>
  Object.fromEntries(
    (
      await getRepository(AlbumRequest).find({
        where: { request: { id: requestId } },
      })
    ).map((album) => [album.albumMbid, album.status])
  );

beforeEach(() => {
  sent.length = 0;
  mock.method(
    notificationManager,
    'sendNotification',
    (type: Notification, payload: NotificationPayload) => {
      sent.push({ type, payload });
    }
  );
});

afterEach(() => {
  mock.restoreAll();
});

describe('completing music requests', () => {
  it('completes a request once every album asked for is here, and says so once', async () => {
    const media = await seedArtist([
      {
        mbId: STATIC_GARDEN,
        title: 'Static Garden',
        status: MediaStatus.AVAILABLE,
      },
      { mbId: FOG_B, title: 'Fog B', status: MediaStatus.PROCESSING },
    ]);
    const request = await seedRequest(media, [
      { mbId: STATIC_GARDEN, title: 'Static Garden' },
      { mbId: FOG_B, title: 'Fog B' },
    ]);

    // One of two here: that album is done, the request is not.
    assert.deepEqual(await completeMusicRequests([media.id]), []);
    assert.equal(await statusOf(request.id), MediaRequestStatus.APPROVED);
    assert.deepEqual(await albumStatuses(request.id), {
      [STATIC_GARDEN]: MediaRequestStatus.COMPLETED,
      [FOG_B]: MediaRequestStatus.APPROVED,
    });
    assert.equal(sent.length, 0);

    await setAlbum(FOG_B, MediaStatus.AVAILABLE);
    assert.deepEqual(await completeMusicRequests([media.id]), [request.id]);
    assert.equal(await statusOf(request.id), MediaRequestStatus.COMPLETED);

    const available = ofType(Notification.MEDIA_AVAILABLE);
    assert.equal(available.length, 1);
    assert.equal(available[0].event, 'Music Request Now Available');
    assert.equal(available[0].subject, 'Glasswing — 2 albums');
    assert.equal(available[0].notifyUser?.id, 2);
    assert.equal(available[0].notifySystem, true);
    assert.equal(available[0].notifyAdmin, false);

    // Nothing says it twice: not another scan, not the hook's own call,
    // not the catch-up pass.
    assert.deepEqual(await completeMusicRequests([media.id]), []);
    await notifyAvailableMusic(
      await getRepository(MediaRequest).findOneByOrFail({ id: request.id })
    );
    await notificationReconciler.run();
    assert.equal(ofType(Notification.MEDIA_AVAILABLE).length, 1);
  });

  it('tells each watcher once, apart from the requester', async () => {
    const media = await seedArtist([
      {
        mbId: STATIC_GARDEN,
        title: 'Static Garden',
        status: MediaStatus.AVAILABLE,
      },
    ]);
    const request = await seedRequest(media, [
      { mbId: STATIC_GARDEN, title: 'Static Garden' },
    ]);
    await getRepository(MediaRequestWatcher).save(
      new MediaRequestWatcher({ requestId: request.id, userId: 1 })
    );

    await completeMusicRequests([media.id]);
    await notificationReconciler.run();

    const available = ofType(Notification.MEDIA_AVAILABLE);
    assert.equal(available.length, 2);
    assert.equal(available.filter((p) => p.notifySystem).length, 1);
    const watcher = available.find((p) => p.notifyUser?.id === 1);
    assert.equal(watcher?.notifySystem, false);
    assert.equal(watcher?.subject, 'Static Garden — Glasswing');
  });

  it('completes without a word when an album asked for was deleted', async () => {
    const media = await seedArtist([
      {
        mbId: STATIC_GARDEN,
        title: 'Static Garden',
        status: MediaStatus.AVAILABLE,
      },
      { mbId: FOG_B, title: 'Fog B', status: MediaStatus.DELETED },
    ]);
    const request = await seedRequest(media, [
      { mbId: STATIC_GARDEN, title: 'Static Garden' },
      { mbId: FOG_B, title: 'Fog B' },
    ]);

    assert.deepEqual(await completeMusicRequests([media.id]), [request.id]);
    await notificationReconciler.run();

    assert.equal(await statusOf(request.id), MediaRequestStatus.COMPLETED);
    assert.equal(ofType(Notification.MEDIA_AVAILABLE).length, 0);
  });

  it('leaves pending and declined requests, and declined albums, alone', async () => {
    const media = await seedArtist([
      {
        mbId: STATIC_GARDEN,
        title: 'Static Garden',
        status: MediaStatus.AVAILABLE,
      },
      { mbId: FOG_B, title: 'Fog B', status: MediaStatus.PROCESSING },
    ]);
    const pending = await seedRequest(
      media,
      [{ mbId: STATIC_GARDEN, title: 'Static Garden' }],
      MediaRequestStatus.PENDING
    );
    // Fog B was taken off: only Static Garden counts.
    const trimmed = await seedRequest(media, [
      { mbId: STATIC_GARDEN, title: 'Static Garden' },
      {
        mbId: FOG_B,
        title: 'Fog B',
        status: MediaRequestStatus.DECLINED,
      },
    ]);

    assert.deepEqual(await completeMusicRequests([media.id]), [trimmed.id]);
    assert.equal(await statusOf(pending.id), MediaRequestStatus.PENDING);
    assert.equal(
      (await albumStatuses(trimmed.id))[FOG_B],
      MediaRequestStatus.DECLINED
    );
    assert.equal(ofType(Notification.MEDIA_AVAILABLE).length, 1);
  });

  it('completes a request that failed to send, once its albums came anyway', async () => {
    const media = await seedArtist([
      {
        mbId: STATIC_GARDEN,
        title: 'Static Garden',
        status: MediaStatus.AVAILABLE,
      },
    ]);
    const request = await seedRequest(
      media,
      [{ mbId: STATIC_GARDEN, title: 'Static Garden' }],
      MediaRequestStatus.FAILED
    );

    assert.deepEqual(await completeMusicRequests([media.id]), [request.id]);
  });
});

describe('catching up on music notifications', () => {
  it('says a music request is here when that was missed, and only once', async () => {
    const media = await seedArtist([
      {
        mbId: STATIC_GARDEN,
        title: 'Static Garden',
        status: MediaStatus.AVAILABLE,
      },
    ]);
    await seedRequest(
      media,
      [{ mbId: STATIC_GARDEN, title: 'Static Garden' }],
      MediaRequestStatus.COMPLETED
    );

    await notificationReconciler.run();
    await notificationReconciler.run();

    const available = ofType(Notification.MEDIA_AVAILABLE);
    assert.equal(available.length, 1);
    assert.equal(available[0].event, 'Music Now Available');
    assert.equal(available[0].subject, 'Static Garden — Glasswing');
  });

  it('waits while an album asked for is not here', async () => {
    const media = await seedArtist([
      {
        mbId: STATIC_GARDEN,
        title: 'Static Garden',
        status: MediaStatus.AVAILABLE,
      },
      { mbId: FOG_B, title: 'Fog B', status: MediaStatus.DELETED },
    ]);
    await seedRequest(
      media,
      [
        { mbId: STATIC_GARDEN, title: 'Static Garden' },
        { mbId: FOG_B, title: 'Fog B' },
      ],
      MediaRequestStatus.COMPLETED
    );

    await notificationReconciler.run();

    assert.equal(ofType(Notification.MEDIA_AVAILABLE).length, 0);
  });

  it('tells the requester a music request failed, once', async () => {
    const media = await seedArtist([
      {
        mbId: STATIC_GARDEN,
        title: 'Static Garden',
        status: MediaStatus.PROCESSING,
      },
    ]);
    await seedRequest(
      media,
      [{ mbId: STATIC_GARDEN, title: 'Static Garden' }],
      MediaRequestStatus.FAILED
    );

    await notificationReconciler.run();
    await notificationReconciler.run();

    const failed = ofType(Notification.MEDIA_FAILED);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].event, 'Music Request Failed');
    assert.equal(failed[0].notifyUser?.id, 2);
  });
});

describe('an artist’s own status', () => {
  it('becoming available does not approve a pending music request', async () => {
    const media = await seedArtist(
      [{ mbId: FOG_B, title: 'Fog B', status: MediaStatus.AVAILABLE }],
      MediaStatus.PENDING
    );
    const request = await seedRequest(
      media,
      [{ mbId: STATIC_GARDEN, title: 'Static Garden' }],
      MediaRequestStatus.PENDING
    );

    const artist = await getRepository(Media).findOneByOrFail({ id: media.id });
    artist.status = MediaStatus.AVAILABLE;
    await getRepository(Media).save(artist);

    assert.equal(await statusOf(request.id), MediaRequestStatus.PENDING);
    assert.equal(
      (await albumStatuses(request.id))[STATIC_GARDEN],
      MediaRequestStatus.PENDING
    );
  });

  it('is written into the artist’s history by their MusicBrainz id', async () => {
    const media = await seedArtist([], MediaStatus.PENDING);

    const artist = await getRepository(Media).findOneByOrFail({ id: media.id });
    artist.status = MediaStatus.PROCESSING;
    await getRepository(Media).save(artist);

    const events = await getRepository(MediaEvent).find();
    assert.deepEqual(
      events.map((e) => [e.foreignId, e.mediaType, e.tmdbId, e.type]),
      [[ARTIST, MediaType.MUSIC, 0, 'processing']]
    );
  });
});
