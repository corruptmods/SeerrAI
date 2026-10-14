import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import {
  MediaStatus,
  MediaType,
  VIDEO_MEDIA_TYPES,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type { User } from '@server/entity/User';
import { watchSource } from '@server/lib/watchHistory';
import logger from '@server/logger';
import { In } from 'typeorm';

/*
 * "Suggested for you": titles like the ones someone has been watching.
 *
 * Their recent finished plays come from the server's watch history:
 * Tautulli for Plex, the server itself for Jellyfin and Emby. Each of the
 * latest few titles asks TMDB for its recommendations, and a title several
 * of them point to ranks above one only a single show suggested, with more
 * recent watching counting for more. Anything they have already started is left out.
 *
 * That is a TMDB lookup per title, so the list is built once a day per person
 * and kept in memory; statuses are read fresh on every request.
 */

export type SuggestionResult =
  | (TmdbMovieResult & { media_type: 'movie' })
  | (TmdbTvResult & { media_type: 'tv' });

/** Plays read: enough to reach well back past the latest few titles. */
const HISTORY_LENGTH = 3000;
/** Titles whose recommendations are asked for. */
const SEEDS = 15;
/** How many suggestions are kept: enough to fill the full page. */
const KEEP = 100;
const REBUILD_MS = 24 * 60 * 60 * 1000;
/** TMDB lookups at once: well inside its rate limit. */
const CONCURRENCY = 4;

/**
 * Keyed on the server account as well as the user: history belongs to the
 * account, so relinking a different one starts afresh.
 */
const built = new Map<
  string,
  { at: number; value: Promise<SuggestionResult[]> }
>();

const keyOf = (mediaType: MediaType, tmdbId: number) =>
  `${mediaType}:${tmdbId}`;

const eachLimited = async <T>(
  items: T[],
  run: (item: T, index: number) => Promise<void>
): Promise<void> => {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        await run(items[index], index);
      }
    })
  );
};

const build = async (user: User): Promise<SuggestionResult[]> => {
  const source = watchSource();
  if (!source || !source.viewerOf(user)) {
    return [];
  }

  const history = await source.history(user, HISTORY_LENGTH);
  if (!history.length) {
    return [];
  }

  // Every title they have started, and the ones they finished, newest first.
  const startedIds = new Set<string>();
  // A Set keeps insertion order, so this stays newest first.
  const finishedOrder = new Set<string>();
  for (const play of history) {
    if (!play.titleId) continue;
    startedIds.add(play.titleId);
    if (play.finished) {
      finishedOrder.add(play.titleId);
    }
  }

  // The server's ids to TMDB ids, through the library Seerr already knows.
  const byTitleId = await source.mediaFor([...startedIds]);

  const started = new Set<string>();
  for (const id of startedIds) {
    const media = byTitleId.get(id);
    if (media) {
      started.add(keyOf(media.mediaType, media.tmdbId));
    }
  }

  const seeds: Media[] = [];
  for (const id of finishedOrder) {
    const media = byTitleId.get(id);
    if (media && !seeds.some((seed) => seed.id === media.id)) {
      seeds.push(media);
    }
    if (seeds.length === SEEDS) {
      break;
    }
  }
  if (!seeds.length) {
    return [];
  }

  const tmdb = new TheMovieDb();
  const scores = new Map<string, { score: number; result: SuggestionResult }>();

  await eachLimited(seeds, async (seed, index) => {
    // The most recent watch counts fully, the oldest seed half as much.
    const seedWeight = 1 - index / (2 * seeds.length);
    try {
      const results: SuggestionResult[] =
        seed.mediaType === MediaType.MOVIE
          ? (
              await tmdb.getMovieRecommendations({ movieId: seed.tmdbId })
            ).results.map((result) => ({
              ...result,
              media_type: 'movie' as const,
            }))
          : (
              await tmdb.getTvRecommendations({ tvId: seed.tmdbId })
            ).results.map((result) => ({
              ...result,
              media_type: 'tv' as const,
            }));

      results.forEach((result, rank) => {
        if ('adult' in result && result.adult) {
          return;
        }
        const mediaType =
          result.media_type === 'movie' ? MediaType.MOVIE : MediaType.TV;
        const key = keyOf(mediaType, result.id);
        if (started.has(key)) {
          return;
        }
        // TMDB lists its closest matches first.
        const add = seedWeight * (1 - rank / 40);
        const current = scores.get(key);
        scores.set(key, {
          score: (current?.score ?? 0) + add,
          result: current?.result ?? result,
        });
      });
    } catch (e) {
      // One title TMDB cannot answer for is not a reason to show nothing.
      logger.debug('Could not read recommendations for a title', {
        label: 'Suggestions',
        tmdbId: seed.tmdbId,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  });

  const ranked = [...scores.values()].sort(
    (a, b) =>
      b.score - a.score ||
      (b.result.popularity ?? 0) - (a.result.popularity ?? 0)
  );

  // Blocklisted titles are never suggested, whoever is looking.
  const blocklisted = new Set(
    (
      await getRepository(Media).find({
        where: {
          status: MediaStatus.BLOCKLISTED,
          mediaType: In(VIDEO_MEDIA_TYPES),
          tmdbId: In(ranked.map(({ result }) => result.id)),
        },
      })
    ).map((media) => keyOf(media.mediaType, media.tmdbId))
  );

  return ranked
    .filter(
      ({ result }) =>
        !blocklisted.has(
          keyOf(
            result.media_type === 'movie' ? MediaType.MOVIE : MediaType.TV,
            result.id
          )
        )
    )
    .slice(0, KEEP)
    .map(({ result }) => result);
};

/**
 * Suggestions for one person, best first. Empty when there is no watch
 * history to read (Plex without Tautulli), they have no account on the
 * media server, or they have not finished anything yet.
 */
export const getSuggestions = (user: User): Promise<SuggestionResult[]> => {
  const now = Date.now();
  for (const [key, entry] of built) {
    if (now - entry.at >= REBUILD_MS) {
      built.delete(key);
    }
  }

  const key = `${user.id}:${watchSource()?.viewerOf(user) ?? ''}`;
  const hit = built.get(key);
  if (hit) {
    return hit.value;
  }

  const value = build(user).catch((e) => {
    built.delete(key);
    throw e;
  });
  built.set(key, { at: now, value });
  return value;
};
