import { WATCH_CHECK_INTERVAL_MS } from '@server/constants/lists';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Episode from '@server/entity/Episode';
import Media from '@server/entity/Media';
import {
  MediaList,
  MediaListItem,
  MediaListMember,
  MediaListWatchSuggestion,
} from '@server/entity/MediaList';
import type { User } from '@server/entity/User';
import {
  everyoneHasWatched,
  hasWatchedMovie,
  hasWatchedSeries,
} from '@server/lib/listWatchRules';
import type { WatchSource } from '@server/lib/watchHistory';
import { watchSource } from '@server/lib/watchHistory';
import logger from '@server/logger';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';
import { In } from 'typeorm';

/** The server is local, but a shared list still means one query per person. */
const ITEM_CONCURRENCY = 3;

const episodeKey = (season: number, episode: number) => `${season}:${episode}`;

/** Checks in progress, by owner, so a second load joins the first. */
const inFlight = new Map<number, Promise<void>>();

/**
 * Checks the owner's watch-sync lists and records a suggestion for any title
 * everyone on the list has finished since it was added. One check at a time
 * for each owner: asking while one runs waits for that one.
 *
 * Nothing is removed here — the owner is prompted and decides.
 */
export const refreshWatchSuggestions = (owner: User): Promise<void> => {
  const running = inFlight.get(owner.id);

  if (running) {
    return running;
  }

  const check = checkOwnerLists(owner).finally(() => {
    inFlight.delete(owner.id);
  });
  inFlight.set(owner.id, check);

  return check;
};

const checkOwnerLists = async (owner: User): Promise<void> => {
  const source = watchSource();

  if (!source) {
    return;
  }

  const listRepository = getRepository(MediaList);

  const lists = await listRepository.find({
    where: { ownerId: owner.id, watchedSync: true },
  });

  if (!lists.length) {
    return;
  }

  const cutoff = new Date(Date.now() - WATCH_CHECK_INTERVAL_MS);

  for (const list of lists) {
    if (list.lastWatchCheck && list.lastWatchCheck > cutoff) {
      continue;
    }

    try {
      await checkList(list, owner, source);
    } catch (e) {
      logger.error('Failed to check watch suggestions for list', {
        label: 'Watch Sync',
        listId: list.id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }

    // Only the check time is written. Saving the loaded list would write back
    // a name or setting the owner changed meanwhile, and a check is not
    // activity: updatedAt is kept so the list does not move up the page.
    await listRepository
      .createQueryBuilder()
      .update()
      .set({ lastWatchCheck: new Date(), updatedAt: () => '"updatedAt"' })
      .where('id = :id', { id: list.id })
      .execute();
  }
};

const checkList = async (
  list: MediaList,
  owner: User,
  source: WatchSource
): Promise<void> => {
  const members = await getRepository(MediaListMember).find({
    where: { listId: list.id },
    relations: { user: true },
  });

  // Everyone on the list has to have finished it — one person watching does
  // not mean the household is done with it. Someone it was shared with only
  // counts once they have accepted it: until then their history is theirs.
  const viewers = [
    owner,
    ...members.filter((m) => m.acceptedAt).map((m) => m.user),
  ].filter((user): user is User => !!user);

  // Someone with no account on the media server has no history to ask, so
  // "everyone has watched it" cannot be known; suggest nothing rather than
  // go by the others alone. The list page tells the owner who it is.
  if (viewers.some((user) => !source.viewerOf(user))) {
    return;
  }

  const items = await getRepository(MediaListItem).find({
    where: { listId: list.id },
  });

  if (!items.length) {
    return;
  }

  // Skip anything already decided on: a suggestion the owner kept should not
  // come back, and one still pending does not need recomputing.
  const existing = await getRepository(MediaListWatchSuggestion).find({
    where: { itemId: In(items.map((item) => item.id)) },
  });

  const decided = new Set(existing.map((s) => s.itemId));
  const pending = items.filter((item) => !decided.has(item.id));

  if (!pending.length) {
    return;
  }

  const suggestions: MediaListWatchSuggestion[] = [];

  await mapWithConcurrency(pending, ITEM_CONCURRENCY, async (item) => {
    const media = await getRepository(Media).findOne({
      where: {
        tmdbId: item.tmdbId,
        mediaType: item.mediaType === 'tv' ? MediaType.TV : MediaType.MOVIE,
      },
    });

    // Not in the library means nobody can have watched it here.
    if (!media || !source.titleIdsOf(media).length) {
      return;
    }

    const isSeries = item.mediaType === 'tv';

    // For a series, "watched" means every episode Seerr knows is available.
    let available: Set<string> | undefined;

    if (isSeries) {
      available = new Set<string>();

      // The episode number lives on Episode and the season number on its
      // Season, so walk the seasons the media already carries.
      for (const season of media.seasons ?? []) {
        // Specials never count towards a series being finished, matching how
        // Seerr decides availability. An unwatched special should not keep a
        // show on a list forever.
        if (season.seasonNumber < 1) {
          continue;
        }

        const episodes = await getRepository(Episode).find({
          where: { season: { id: season.id } },
        });

        for (const episode of episodes) {
          if (episode.status === MediaStatus.AVAILABLE) {
            available.add(
              episodeKey(season.seasonNumber, episode.episodeNumber)
            );
          }
        }
      }

      // Nothing available means nothing could have been watched.
      if (!available.size) {
        return;
      }
    }

    const perViewer = await mapWithConcurrency(
      viewers,
      ITEM_CONCURRENCY,
      async (viewer) => {
        // Could not ask is not watched: no suggestion this time.
        const plays = await source
          .playsSince(viewer, media, item.createdAt)
          .catch(() => []);

        return isSeries
          ? hasWatchedSeries(plays, item.createdAt, available as Set<string>)
          : hasWatchedMovie(plays, item.createdAt);
      }
    );

    if (everyoneHasWatched(perViewer)) {
      suggestions.push(
        new MediaListWatchSuggestion({ listId: list.id, itemId: item.id })
      );
    }
  });

  if (suggestions.length) {
    await getRepository(MediaListWatchSuggestion).save(suggestions);

    logger.info('Recorded watch suggestions', {
      label: 'Watch Sync',
      listId: list.id,
      count: suggestions.length,
    });
  }
};

export default refreshWatchSuggestions;
