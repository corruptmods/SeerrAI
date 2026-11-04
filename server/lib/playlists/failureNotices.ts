import { albumCoverUrl } from '@server/api/coverartarchive';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaList, MediaListSong } from '@server/entity/MediaList';
import { MediaRequest } from '@server/entity/MediaRequest';
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
    select: { listId: true, requestId: true, requestForId: true },
    where: { requestId: In(requestIds) },
    order: { id: 'ASC' },
  });
  // Made from the playlist: in its owner's name. A song may follow someone
  // else's request for it, which is theirs to be told of.
  const requesters = new Map(
    (
      await getRepository(MediaRequest).find({
        select: { id: true, requestedBy: { id: true } },
        relations: { requestedBy: true },
        where: {
          id: In([...new Set(songs.map((song) => song.requestId as number))]),
        },
      })
    ).map((request) => [request.id, request.requestedBy?.id])
  );
  const lists = new Map<number, number>();
  for (const song of songs) {
    if (
      song.requestId &&
      !lists.has(song.requestId) &&
      requesters.get(song.requestId) === song.requestForId
    ) {
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
      const owner = first.requesterMuted ? undefined : first.requestedBy;
      const image = songs[0]?.albumMbid
        ? albumCoverUrl(songs[0].albumMbid)
        : undefined;
      const message = truncate(names.join(', '), {
        length: 500,
        separator: /,? /,
        omission: '…',
      });
      // Admins and channels as a failed request; the owner by Playlist
      // Updates, which they choose apart from failed requests.
      notificationManager.sendNotification(Notification.MEDIA_FAILED, {
        ...mediaEvent(Notification.MEDIA_FAILED, MediaType.MUSIC, false),
        // The playlist's own name stays on its page.
        subject: `Playlist import — ${
          count
            ? `${count} ${count === 1 ? 'song' : 'songs'}`
            : `${claimed.length} ${claimed.length === 1 ? 'request' : 'requests'}`
        }`,
        message,
        image,
        media: first.media,
        request: first,
        notifyAdmin: true,
        notifySystem: true,
        // Named so they aren't sent the admins' copy as well.
        notifyUser: owner,
        holdUser: true,
        actionUrl: `/lists/${listId}`,
        extra: count ? [{ name: 'Failed Songs', value: String(count) }] : [],
      });
      if (owner) {
        const list = await getRepository(MediaList).findOne({
          select: { id: true, name: true },
          where: { id: listId },
        });
        const what = count
          ? `${count} ${count === 1 ? 'song' : 'songs'}`
          : `${claimed.length} ${claimed.length === 1 ? 'request' : 'requests'}`;
        notificationManager.sendNotification(Notification.PLAYLIST_UPDATE, {
          subject: `${list?.name ?? 'Your playlist'}: ${what} couldn’t be got`,
          message,
          image,
          notifyAdmin: false,
          notifySystem: false,
          notifyUser: owner,
          actionUrl: `/lists/${listId}`,
          actionUrlTitle: 'View Playlist',
        });
      }
    } catch (e) {
      logger.error('Could not tell a playlist’s failed songs', {
        label: 'Notifications',
        listId,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }
};
