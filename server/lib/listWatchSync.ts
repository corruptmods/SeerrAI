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

/** The server is local, but a shared list still costs one query per viewer. */
const ITEM_CONCURRENCY = 3;

const episodeKey = (season: number, episode: number) => `${season}:${episode}`;

/** In-progress checks by owner, so a second load joins the first. */
const inFlight = new Map<number, Promise<void>>();

/**
 * Checks the owner's watch-sync lists and records a suggestion for any title
 * everyone on the list has finished since it was added. One check per owner
 * at a time; a second call waits for the running one.
 *
 * Nothing is removed here: the owner is prompted and decides.
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

    // Write only the check time. Saving the loaded list would overwrite a name
    // or setting changed meanwhile, and a check isn't activity: updatedAt stays
    // so the list doesn't move up the page.
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

  // Everyone on the list must have finished it: one viewer doesn't mean the
  // household is done. A share recipient counts only once they accept; until
  // then their history is private.
  const viewers = [
    owner,
    ...members.filter((m) => m.acceptedAt).map((m) => m.user),
  ].filter((user): user is User => !!user);

  // A viewer with no media server account has no history, so "everyone watched
  // it" is unknowable; suggest nothing instead of going by the others. The list
  // page tells the owner who it is.
  if (viewers.some((user) => !source.viewerOf(user))) {
    return;
  }

  const items = await getRepository(MediaListItem).find({
    where: { listId: list.id },
  });

  if (!items.length) {
    return;
  }

  // Skip titles already decided: a kept suggestion shouldn't return, and a
  // pending one needn't be recomputed.
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

    // For a series, "watched" means every available episode Seerr knows of.
    let available: Set<string> | undefined;

    if (isSeries) {
      available = new Set<string>();

      // Episode numbers live on Episode and season numbers on Season, so walk
      // the media's seasons.
      for (const season of media.seasons ?? []) {
        // Specials never count towards finishing, matching Seerr's
        // availability, so an unwatched special can't keep a show on a list
        // forever.
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
        // Unreachable is not watched: no suggestion this time.
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
