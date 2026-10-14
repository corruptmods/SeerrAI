import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import {
  claimDelivery,
  notifyRequestWatchers,
  releaseDelivery,
} from '@server/lib/notificationDelivery';
import { Notification } from '@server/lib/notifications';
import { requestAvailableEvent } from '@server/lib/notifications/eventTitles';
import logger from '@server/logger';
import { In } from 'typeorm';

/*
 * Closing the loop on music requests: once the albums asked for are here,
 * the request is done and whoever asked is told.
 *
 * Done here, by the music scans after they have saved what they found,
 * rather than in a save hook: albums change through update(), which the
 * hooks never see, and an artist's own status says nothing about which of
 * their albums arrived.
 *
 * Each album asked for is done once it is here, or gone again (deleted, as
 * a series' season is). A request is done once all of them are. Only a
 * request whose albums are all here says so; one finished by albums being
 * deleted says nothing. Every notification is claimed first, so nothing is
 * announced twice, whichever of this and the catch-up pass gets there
 * first.
 */

const DONE = [MediaStatus.AVAILABLE, MediaStatus.DELETED];

/** Requests that can still be done: on their way, or failed to send. */
const OPEN = [MediaRequestStatus.APPROVED, MediaRequestStatus.FAILED];

/** The albums of a request that count: all but those declined. */
const wantedAlbums = (request: Pick<MediaRequest, 'albums'>): AlbumRequest[] =>
  (request.albums ?? []).filter(
    (album) => album.status !== MediaRequestStatus.DECLINED
  );

/**
 * Whether every album a request asked for is here, from the artist's
 * album rows.
 */
export const musicRequestAvailable = (
  request: Pick<MediaRequest, 'albums'>,
  rows: Pick<MusicAlbum, 'mbId' | 'status'>[]
): boolean => {
  const wanted = wantedAlbums(request);
  return (
    wanted.length > 0 &&
    wanted.every((album) =>
      rows.some(
        (row) =>
          row.mbId === album.albumMbid && row.status === MediaStatus.AVAILABLE
      )
    )
  );
};

/**
 * Tells whoever asked, and everyone watching, that a music request is
 * here: only when every album it asked for is, and only once.
 */
export const notifyAvailableMusic = async (
  request: MediaRequest
): Promise<void> => {
  if (!request.media?.id) {
    return;
  }
  const media = await getRepository(Media).findOne({
    where: { id: request.media.id },
  });
  if (!media) {
    return;
  }
  const rows = await getRepository(MusicAlbum).find({
    select: { id: true, mbId: true, status: true },
    where: { mediaId: media.id },
  });
  if (!musicRequestAvailable(request, rows)) {
    return;
  }

  if (!(await claimDelivery(request.id, Notification.MEDIA_AVAILABLE))) {
    return;
  }

  const event = requestAvailableEvent(MediaType.MUSIC, false);
  const sent = await MediaRequest.sendNotification(
    request,
    media,
    Notification.MEDIA_AVAILABLE,
    event
  );
  if (!sent) {
    // Already logged; the catch-up pass tries again.
    await releaseDelivery(request.id, Notification.MEDIA_AVAILABLE);
    return;
  }

  await notifyRequestWatchers(request.id, (watcher) =>
    MediaRequest.sendNotification(
      request,
      media,
      Notification.MEDIA_AVAILABLE,
      event,
      undefined,
      watcher
    )
  );
};

/** Ids looked up at once; well under SQLite's 999 bound parameters. */
const CHUNK = 400;

/**
 * Marks done what the albums now here (or gone) finish, for these
 * artists, then says so for each request that is now done. Each artist's
 * changes are written together. Returns the requests completed.
 */
export const completeMusicRequests = async (
  mediaIds: Iterable<number>
): Promise<number[]> => {
  const ids = [...new Set(mediaIds)];
  const completed: number[] = [];

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const requests = await getRepository(MediaRequest).find({
      where: {
        type: MediaType.MUSIC,
        status: In(OPEN),
        media: { id: In(chunk) },
      },
    });
    if (!requests.length) {
      continue;
    }
    const rows = await getRepository(MusicAlbum).find({
      select: { id: true, mediaId: true, mbId: true, status: true },
      where: { mediaId: In([...new Set(requests.map((r) => r.media.id))]) },
    });

    for (const request of requests) {
      const own = rows.filter((row) => row.mediaId === request.media.id);
      const statusOf = (mbId: string) =>
        own.find((row) => row.mbId === mbId)?.status;
      const wanted = wantedAlbums(request);
      const finished = wanted.filter(
        (album) =>
          album.status !== MediaRequestStatus.COMPLETED &&
          DONE.includes(statusOf(album.albumMbid) as MediaStatus)
      );
      const allDone =
        wanted.length > 0 &&
        wanted.every(
          (album) =>
            album.status === MediaRequestStatus.COMPLETED ||
            finished.includes(album)
        );
      if (!finished.length && !allDone) {
        continue;
      }

      await dataSource.transaction(async (manager) => {
        if (finished.length) {
          await manager.update(
            AlbumRequest,
            { id: In(finished.map((album) => album.id)) },
            { status: MediaRequestStatus.COMPLETED }
          );
        }
        if (allDone) {
          await manager.update(MediaRequest, request.id, {
            status: MediaRequestStatus.COMPLETED,
          });
        }
      });
      finished.forEach(
        (album) => (album.status = MediaRequestStatus.COMPLETED)
      );

      if (allDone) {
        request.status = MediaRequestStatus.COMPLETED;
        completed.push(request.id);
        logger.info('A music request is complete', {
          label: 'Music Scan',
          requestId: request.id,
          mediaId: request.media.id,
        });
        try {
          await notifyAvailableMusic(request);
        } catch (e) {
          logger.error('Could not say a music request is here', {
            label: 'Notifications',
            requestId: request.id,
            errorMessage: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  }

  return completed;
};
