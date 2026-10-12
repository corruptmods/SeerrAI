import { MediaType } from '@server/constants/media';
import type Media from '@server/entity/Media';
import { watchSource } from '@server/lib/watchHistory';

export interface WatchedBy {
  /** The Seerr user, when the server account has one. */
  user?: { id: number; displayName: string; avatar: string };
  /** The server's name for them, for accounts with no Seerr user. */
  name: string;
  /** Films: completed plays. Series: episodes finished. */
  count: number;
  /** Null when the server kept no date (marked watched by hand, on Emby). */
  lastWatched: string | null;
}

/**
 * Who has watched a title, from the server's watch history (Tautulli for
 * Plex, the server itself for Jellyfin and Emby): completed plays of a
 * film, or episodes finished of a series, and when last, most recent
 * first. Both the regular and 4K copies count. Undefined when there is no
 * watch history to ask.
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
    // Finished, as the server judges it; a few minutes of an episode is not
    // having watched it.
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

  return [...byViewer.entries()]
    .map(([viewerId, entry]) => {
      const user = users.get(viewerId);
      return {
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
      };
    })
    .sort(
      (a, b) =>
        (b.lastWatched ? Date.parse(b.lastWatched) : 0) -
        (a.lastWatched ? Date.parse(a.lastWatched) : 0)
    );
};
