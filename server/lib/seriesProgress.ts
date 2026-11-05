import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Episode from '@server/entity/Episode';
import Media from '@server/entity/Media';
import type { User } from '@server/entity/User';
import { isCompletedPlay, watchSource } from '@server/lib/watchHistory';
import logger from '@server/logger';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';
import { In } from 'typeorm';

export interface EpisodeRef {
  season: number;
  episode: number;
}

export interface SeriesProgress {
  /** not_started: nothing finished; up_next: behind what's here; caught_up. */
  state: 'not_started' | 'up_next' | 'caught_up';
  /** The next available episode to watch, if any. */
  next?: EpisodeRef;
  /** Available episodes after the furthest one finished. */
  remaining: number;
  /** The furthest episode finished, if any. */
  furthest?: EpisodeRef;
}

/** Cache lifetime for a viewer's position. */
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: SeriesProgress | null }>();

const compare = (a: EpisodeRef, b: EpisodeRef) =>
  a.season - b.season || a.episode - b.episode;

/**
 * A viewer's position in a series from their completed plays and the library.
 *
 * Uses the *furthest* finished episode, not the latest: rewatching an early
 * episode after finishing season two still leaves them at season three.
 * Specials are ignored, being outside the show's run.
 */
export const workOutProgress = (
  finished: EpisodeRef[],
  available: EpisodeRef[]
): SeriesProgress | null => {
  const inLibrary = available.filter((ep) => ep.season >= 1).sort(compare);

  if (!inLibrary.length) {
    return null;
  }

  const furthest = finished
    .filter((ep) => ep.season >= 1)
    .sort(compare)
    .pop();

  if (!furthest) {
    return {
      state: 'not_started',
      next: inLibrary[0],
      remaining: inLibrary.length,
    };
  }

  const ahead = inLibrary.filter((ep) => compare(ep, furthest) > 0);

  if (!ahead.length) {
    return { state: 'caught_up', remaining: 0, furthest };
  }

  return {
    state: 'up_next',
    next: ahead[0],
    remaining: ahead.length,
    furthest,
  };
};

/**
 * One viewer's progress through each series on a list.
 *
 * Omits a series it can't answer honestly (no media server account, no watch
 * history source such as Tautulli for Plex or it isn't answering, or nothing
 * of the series in the library) instead of a misleading "not started".
 */
export const getSeriesProgress = async (
  viewer: User,
  tmdbIds: number[]
): Promise<Record<number, SeriesProgress>> => {
  // Drop expired positions on each call, or every viewer and series ever seen
  // would stay in memory for the server's lifetime.
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at >= CACHE_MS) {
      cache.delete(key);
    }
  }

  const source = watchSource();
  const viewerId = source?.viewerOf(viewer);

  if (!tmdbIds.length || !source || !viewerId) {
    return {};
  }

  const media = await getRepository(Media).find({
    where: { tmdbId: In(tmdbIds), mediaType: MediaType.TV },
    relations: { seasons: true },
  });

  const result: Record<number, SeriesProgress> = {};

  await mapWithConcurrency(media, 3, async (series) => {
    const ids = source.titleIdsOf(series);
    if (!ids.length) {
      return;
    }

    // Keyed on the server's own viewer and series ids, so a re-added title or
    // relinked account never inherits a cached position.
    const key = `${viewer.id}:${viewerId}:${ids.join(',')}`;
    const cached = cache.get(key);

    if (cached && Date.now() - cached.at < CACHE_MS) {
      if (cached.value) {
        result[series.tmdbId] = cached.value;
      }

      return;
    }

    const seasonNumbers = new Map(
      (series.seasons ?? []).map((season) => [season.id, season.seasonNumber])
    );

    if (!seasonNumbers.size) {
      return;
    }

    let finished: EpisodeRef[];

    try {
      const plays = await source.playsSince(viewer, series, new Date(0));

      finished = plays
        .filter((play) => play.kind === 'episode' && isCompletedPlay(play))
        .map((play) => ({
          season: Number(play.season),
          episode: Number(play.episode),
        }));
    } catch (e) {
      // Omit this series instead of claiming it was never watched. Not cached,
      // so the next load retries.
      logger.debug(`Could not read watch progress from ${source.label}`, {
        label: 'Watch Progress',
        tmdbId: series.tmdbId,
        errorMessage: e instanceof Error ? e.message : String(e),
      });

      return;
    }

    const rows = await getRepository(Episode)
      .createQueryBuilder('episode')
      .select('episode.seasonId', 'seasonId')
      .addSelect('episode.episodeNumber', 'episodeNumber')
      .where('episode.seasonId IN (:...seasonIds)', {
        seasonIds: [...seasonNumbers.keys()],
      })
      .andWhere('episode.status = :status', { status: MediaStatus.AVAILABLE })
      .getRawMany<{ seasonId: number; episodeNumber: number }>();

    const available = rows.map((row) => ({
      season: seasonNumbers.get(Number(row.seasonId)) ?? 0,
      episode: Number(row.episodeNumber),
    }));

    const value = workOutProgress(finished, available);

    cache.set(key, { at: Date.now(), value });

    if (value) {
      result[series.tmdbId] = value;
    }
  });

  return result;
};

/** Tests only: number of cached positions. */
export const seriesProgressCachedForTests = (): number => cache.size;
