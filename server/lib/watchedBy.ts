import TautulliAPI from '@server/api/tautulli';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import { In } from 'typeorm';

export interface WatchedBy {
  /** The Seerr user, when the Plex account has one. */
  user?: { id: number; displayName: string; avatar: string };
  /** Plex's name for them, for accounts with no Seerr user. */
  name: string;
  /** Films: completed plays. Series: episodes finished. */
  count: number;
  lastWatched: string;
}

/**
 * Who has watched a title, from Tautulli's history for it: completed plays
 * of a film, or episodes finished of a series, and when last — most recent
 * first. Both the regular and 4K copies count. Undefined when Tautulli is not
 * set up.
 */
export const getWatchedBy = async (
  media: Media
): Promise<WatchedBy[] | undefined> => {
  const settings = getSettings().tautulli;
  if (!settings.hostname || !settings.port || !settings.apiKey) {
    return undefined;
  }

  const isShow = media.mediaType === MediaType.TV;
  const keys = [media.ratingKey, media.ratingKey4k].filter(
    (key): key is string => !!key
  );
  if (!keys.length) {
    return [];
  }

  const tautulli = new TautulliAPI(settings);
  const records = (
    await Promise.all(keys.map((key) => tautulli.getTitleHistory(key, isShow)))
  ).flat();

  const byUser = new Map<
    number,
    { name: string; plays: number; episodes: Set<string>; last: number }
  >();
  for (const record of records) {
    // Finished, as Tautulli judges it; a few minutes of an episode is not
    // having watched it.
    if (record.watched_status !== 1) {
      continue;
    }
    const entry = byUser.get(record.user_id) ?? {
      name: record.friendly_name,
      plays: 0,
      episodes: new Set<string>(),
      last: 0,
    };
    entry.plays += 1;
    entry.episodes.add(String(record.rating_key));
    entry.last = Math.max(entry.last, record.date * 1000);
    byUser.set(record.user_id, entry);
  }

  if (!byUser.size) {
    return [];
  }

  const users = await getRepository(User).find({
    where: { plexId: In([...byUser.keys()]) },
  });
  const byPlexId = new Map(users.map((user) => [user.plexId, user]));

  return [...byUser.entries()]
    .map(([plexId, entry]) => {
      const user = byPlexId.get(plexId);
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
        lastWatched: new Date(entry.last).toISOString(),
      };
    })
    .sort(
      (a, b) =>
        new Date(b.lastWatched).getTime() - new Date(a.lastWatched).getTime()
    );
};
