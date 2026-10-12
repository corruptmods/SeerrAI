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
  /** The next available episode to watch, when there is one. */
  next?: EpisodeRef;
  /** Available episodes after the furthest one finished. */
  remaining: number;
  /** The furthest episode finished, when there is one. */
  furthest?: EpisodeRef;
}

/** How long a viewer's position is reused before asking the server again. */
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: SeriesProgress | null }>();

const compare = (a: EpisodeRef, b: EpisodeRef) =>
  a.season - b.season || a.episode - b.episode;

/**
 * Where a viewer is in a series, given their completed plays and what is in
 * the library.
 *
 * Uses the *furthest* episode they finished, not the most recent: someone who
 * rewatches an early episode after finishing season two is still up to season
 * three. Specials are ignored, since they sit outside the run of the show.
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
 * Progress through each series on a list, for one viewer.
 *
 * Returns nothing for a series it cannot answer honestly — the viewer has
 * no account on the media server, there is no watch history to ask (no
 * Tautulli for Plex) or it is not answering, or nothing of the series is in
 * the library — rather than a misleading "not started".
 */
export const getSeriesProgress = async (
  viewer: User,
  tmdbIds: number[]
): Promise<Record<number, SeriesProgress>> => {
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

    // Keyed on the server's own ids for the viewer and the series, so a
    // re-added title or a relinked account never inherits a cached position.
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
      // Leave this series out rather than claim it was never watched. Not
      // cached, so the next load asks again.
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
