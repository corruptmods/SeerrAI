import TautulliAPI from '@server/api/tautulli';
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
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';
import { In } from 'typeorm';

/**
 * How long a list's result is trusted before Tautulli is asked again. The
 * check runs when the owner opens Seerr, so without this it would run on
 * every page load.
 */

/** Tautulli is local, but a shared list still means one query per person. */
const ITEM_CONCURRENCY = 3;

const episodeKey = (season: number, episode: number) => `${season}:${episode}`;

/**
 * Checks the owner's watch-sync lists and records a suggestion for any title
 * everyone on the list has finished since it was added.
 *
 * Nothing is removed here — the owner is prompted and decides.
 */
export const refreshWatchSuggestions = async (owner: User): Promise<void> => {
  const settings = getSettings();

  if (!settings.tautulli.hostname || !settings.tautulli.apiKey) {
    return;
  }

  const listRepository = getRepository(MediaList);

  const lists = await listRepository.find({
    where: { ownerId: owner.id, watchedSync: true },
  });

  if (!lists.length) {
    return;
  }

  const tautulli = new TautulliAPI(settings.tautulli);
  const cutoff = new Date(Date.now() - WATCH_CHECK_INTERVAL_MS);

  for (const list of lists) {
    if (list.lastWatchCheck && list.lastWatchCheck > cutoff) {
      continue;
    }

    try {
      await checkList(list, owner, tautulli);
    } catch (e) {
      logger.error('Failed to check watch suggestions for list', {
        label: 'Watch Sync',
        listId: list.id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }

    list.lastWatchCheck = new Date();
    await listRepository.save(list);
  }
};

const checkList = async (
  list: MediaList,
  owner: User,
  tautulli: TautulliAPI
): Promise<void> => {
  const members = await getRepository(MediaListMember).find({
    where: { listId: list.id },
    relations: { user: true },
  });

  // Everyone who can see the list has to have finished it — one person
  // watching does not mean the household is done with it.
  const viewers = [owner, ...members.map((m) => m.user)].filter(
    (user): user is User => !!user && !!user.plexId
  );

  if (!viewers.length) {
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
    if (!media?.ratingKey) {
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
        const plays = await tautulli.getUserPlaysSince(viewer, {
          ...(isSeries
            ? { grandparentRatingKey: media.ratingKey as string }
            : { ratingKey: media.ratingKey as string }),
          after: item.createdAt,
        });

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
