import { MediaType } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { User } from '@server/entity/User';
import { watchSource } from '@server/lib/watchHistory';

export interface WatchedBy {
  /** The Seerr user, when the server account has one. */
  user?: { id: number; displayName: string; avatar: string };
  /** The server's name for them, for accounts with no Seerr user. */
  name: string;
  /** Films: completed plays. Series: episodes finished. */
  count: number;
  /** Null when the server stored no date (marked watched by hand, on Emby). */
  lastWatched: string | null;
}

/**
 * Who has watched a title, from watch history (Tautulli for Plex, the server
 * itself for Jellyfin and Emby): completed film plays or finished episodes,
 * with when last, most recent first. Regular and 4K copies both count.
 * Undefined when there is no watch history source.
 */
export const getWatchedBy = async (
  media: Media
): Promise<WatchedBy[] | undefined> => {
  const source = watchSource();
  if (!source) {
    return undefined;
  }

  const isShow = media.mediaType === MediaType.TV;
  if (!source.titleIdsOf(media).length) {
    return [];
  }

  const plays = await source.titleHistory(media);

  const byViewer = new Map<
    string,
    { name: string; plays: number; episodes: Set<string>; last: number }
  >();
  for (const play of plays) {
    // Finished as the server judges it; a few minutes of an episode doesn't
    // count.
    if (!play.finished) {
      continue;
    }
    const entry = byViewer.get(play.viewerId) ?? {
      name: play.viewerName,
      plays: 0,
      episodes: new Set<string>(),
      last: 0,
    };
    entry.plays += 1;
    entry.episodes.add(play.itemId);
    entry.last = Math.max(entry.last, play.at * 1000);
    byViewer.set(play.viewerId, entry);
  }

  if (!byViewer.size) {
    return [];
  }

  const users = await source.usersFor([...byViewer.keys()]);

  // One user with accounts on two servers is one person: their plays are
  // summed. Accounts with no Seerr user stay separate.
  const byPerson = new Map<
    string,
    {
      user?: User;
      name: string;
      plays: number;
      episodes: Set<string>;
      last: number;
    }
  >();
  for (const [viewerId, entry] of byViewer) {
    const user = users.get(viewerId);
    const key = user ? `user:${user.id}` : `viewer:${viewerId}`;
    const person = byPerson.get(key);
    if (person) {
      person.plays += entry.plays;
      entry.episodes.forEach((episode) => person.episodes.add(episode));
      person.last = Math.max(person.last, entry.last);
    } else {
      byPerson.set(key, { ...entry, user });
    }
  }

  return [...byPerson.values()]
    .map(({ user, ...entry }) => ({
      user: user
        ? {
            id: user.id,
            displayName: user.displayName,
            avatar: user.avatar,
          }
        : undefined,
      name: user?.displayName ?? entry.name,
      count: isShow ? entry.episodes.size : entry.plays,
      lastWatched: entry.last ? new Date(entry.last).toISOString() : null,
    }))
    .sort(
      (a, b) =>
        (b.lastWatched ? Date.parse(b.lastWatched) : 0) -
        (a.lastWatched ? Date.parse(a.lastWatched) : 0)
    );
};
