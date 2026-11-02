import { albumCoverUrl } from '@server/api/coverartarchive';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaList, MediaListSong } from '@server/entity/MediaList';
import type { MediaRequest } from '@server/entity/MediaRequest';
import SongRequest from '@server/entity/SongRequest';
import { claimDelivery } from '@server/lib/notificationDelivery';
import notificationManager, { Notification } from '@server/lib/notifications';
import { mediaEvent } from '@server/lib/notifications/eventTitles';
import logger from '@server/logger';
import { truncate } from 'lodash';
import { In } from 'typeorm';

/*
 * A playlist import makes a request for each artist, and songs that
 * couldn't be got fail them one after another, over hours. Rather than a
 * notification for each, a playlist's failures are told as one, once none
 * has failed for a while (or they have been gathering an hour).
 */

/** How long after the last failure its playlist's are told. */
export const QUIET_MS = 10 * 60_000;
/** The longest failures are held before being told anyway. */
export const LONGEST_MS = 60 * 60_000;

/** The playlist each of these requests was made from, if any. */
export const playlistOfRequests = async (
  requestIds: number[]
): Promise<Map<number, number>> => {
  if (!requestIds.length) return new Map();
  const songs = await getRepository(MediaListSong).find({
    select: { listId: true, requestId: true },
    where: { requestId: In(requestIds) },
    order: { id: 'ASC' },
  });
  const lists = new Map<number, number>();
  for (const song of songs) {
    if (song.requestId && !lists.has(song.requestId)) {
      lists.set(song.requestId, song.listId);
    }
  }
  return lists;
};

const songName = (song: Pick<SongRequest, 'title' | 'version'>): string =>
  song.version ? `${song.title} (${song.version})` : song.title;

/**
 * Tells each playlist's failed requests as one notification, once they
 * have settled: the requests are claimed as told, so none is told again
 * on its own. Those still gathering wait for a later pass.
 */
export const notifyPlaylistFailures = async (
  requests: MediaRequest[],
  listOf: Map<number, number>,
  now = Date.now()
): Promise<void> => {
  const byList = new Map<number, MediaRequest[]>();
  for (const request of requests) {
    const listId = listOf.get(request.id);
    if (listId === undefined) continue;
    byList.set(listId, [...(byList.get(listId) ?? []), request]);
  }

  for (const [listId, failed] of byList) {
    const times = failed.map((r) => new Date(r.updatedAt).getTime());
    if (
      now - Math.max(...times) < QUIET_MS &&
      now - Math.min(...times) < LONGEST_MS
    ) {
      continue;
    }
    const claimed: MediaRequest[] = [];
    for (const request of failed) {
      if (await claimDelivery(request.id, Notification.MEDIA_FAILED)) {
        claimed.push(request);
      }
    }
    if (!claimed.length) continue;

    try {
      const list = await getRepository(MediaList).findOne({
        where: { id: listId },
      });
      const songs = await getRepository(SongRequest).find({
        where: {
          request: { id: In(claimed.map((r) => r.id)) },
          status: MediaRequestStatus.FAILED,
        },
        relations: { request: { media: true } },
        order: { id: 'ASC' },
      });
      const count = songs.length;
      const names = songs.map((song) =>
        `${songName(song)} — ${song.request.media?.foreignTitle ?? ''}`.trim()
      );
      const first = claimed[0];
      notificationManager.sendNotification(Notification.MEDIA_FAILED, {
        ...mediaEvent(Notification.MEDIA_FAILED, MediaType.MUSIC, false),
        subject: `${list?.name ?? 'A playlist'} — ${
          count
            ? `${count} ${count === 1 ? 'song' : 'songs'}`
            : `${claimed.length} ${claimed.length === 1 ? 'request' : 'requests'}`
        }`,
        message: truncate(names.join(', '), {
          length: 500,
          separator: /,? /,
          omission: '…',
        }),
        image: songs[0]?.albumMbid
          ? albumCoverUrl(songs[0].albumMbid)
          : undefined,
        media: first.media,
        request: first,
        notifyAdmin: true,
        notifySystem: true,
        notifyUser: first.requesterMuted ? undefined : first.requestedBy,
        actionUrl: `/lists/${listId}`,
        extra: [
          ...(list ? [{ name: 'Playlist', value: list.name }] : []),
          ...(count ? [{ name: 'Failed Songs', value: String(count) }] : []),
        ],
      });
    } catch (e) {
      logger.error('Could not tell a playlist’s failed songs', {
        label: 'Notifications',
        listId,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }
};
