import { getRepository } from '@server/datasource';
import { MediaList, MediaListSong } from '@server/entity/MediaList';
import type { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type { PlaylistRequestGroup } from '@server/interfaces/api/requestInterfaces';
import { accessibleListIds } from '@server/lib/listAccess';
import { playlistView } from '@server/lib/playlists/view';
import type { SelectQueryBuilder } from 'typeorm';
import { In } from 'typeorm';

/*
 * A playlist import makes many song requests at once. Where requests are
 * shown in a row (Recent Requests), those are shown as one card for their
 * playlist instead of a card each.
 */

/** The most playlist requests looked through for the playlists to show. */
const LOOK_BACK = 500;

/** Covers on a playlist's card. */
const COVERS = 4;

/** The requests a playlist's songs went into. */
const playlistRequestIds = (query: SelectQueryBuilder<MediaRequest>) =>
  query
    .subQuery()
    .select('song.requestId')
    .from(MediaListSong, 'song')
    .where('song.requestId IS NOT NULL')
    .getQuery();

/** Leaves out the requests made from playlists. */
export const withoutPlaylistRequests = (
  query: SelectQueryBuilder<MediaRequest>
): SelectQueryBuilder<MediaRequest> =>
  query.andWhere(`request.id NOT IN ${playlistRequestIds(query)}`);

/**
 * The playlists behind the requests this query finds (with its filters and
 * whose requests this person may see), newest request first: one each,
 * with how its songs are getting on.
 */
export const playlistRequestGroups = async (
  query: SelectQueryBuilder<MediaRequest>,
  viewer: User,
  take: number
): Promise<PlaylistRequestGroup[]> => {
  const found = await query
    .clone()
    .andWhere(`request.id IN ${playlistRequestIds(query)}`)
    .select(['request.id', 'request.createdAt'])
    .orderBy('request.createdAt', 'DESC')
    .addOrderBy('request.id', 'DESC')
    .take(LOOK_BACK)
    .getMany();
  if (!found.length) return [];

  const madeAt = new Map(found.map((r) => [r.id, new Date(r.createdAt)]));
  const songs = await getRepository(MediaListSong).find({
    select: { listId: true, requestId: true },
    where: { requestId: In([...madeAt.keys()]) },
  });
  const latest = new Map<number, Date>();
  for (const song of songs) {
    const at = madeAt.get(song.requestId ?? 0);
    const seen = latest.get(song.listId);
    if (at && (!seen || at > seen)) latest.set(song.listId, at);
  }
  const listIds = [...latest.entries()]
    .sort((a, b) => b[1].getTime() - a[1].getTime())
    .slice(0, take)
    .map(([id]) => id);
  if (!listIds.length) return [];

  const [lists, openable] = await Promise.all([
    getRepository(MediaList).find({ where: { id: In(listIds) } }),
    accessibleListIds(viewer.id),
  ]);
  const people = new Map<number, User>();
  const groups: PlaylistRequestGroup[] = [];
  for (const id of listIds) {
    const list = lists.find((l) => l.id === id);
    if (!list) continue;
    const view = await playlistView(list);
    const count = (...states: string[]) =>
      view.songs.filter((s) => states.includes(s.state)).length;
    const requesterId = list.sourceUserId ?? list.ownerId;
    let requester = requesterId === list.ownerId ? list.owner : undefined;
    if (!requester) {
      requester =
        people.get(requesterId) ??
        (await getRepository(User).findOne({ where: { id: requesterId } })) ??
        list.owner;
      people.set(requesterId, requester);
    }
    const covers = [
      ...new Set(
        view.songs
          .map((s) => s.albumMbid)
          .filter((mbid): mbid is string => !!mbid)
      ),
    ].slice(0, COVERS);
    groups.push({
      listId: list.id,
      ...(openable.includes(list.id) ? { name: list.name } : {}),
      requestedBy: {
        id: requester.id,
        displayName: requester.displayName,
        avatar: requester.avatar,
      },
      songs: view.songs.length,
      here: count('here'),
      onTheWay: count('requested'),
      approval: count('approval'),
      waiting: count('queued', 'limit', 'matching'),
      failed: count('failed', 'notGot'),
      albums: covers,
      latestAt: (latest.get(list.id) ?? new Date()).toISOString(),
    });
  }
  return groups;
};
