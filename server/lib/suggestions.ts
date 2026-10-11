import TautulliAPI from '@server/api/tautulli';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In } from 'typeorm';

/*
 * "Suggested for you": titles like the ones someone has been watching.
 *
 * Their recent finished plays come from Tautulli. Each of the latest few
 * titles asks TMDB for its recommendations, and a title several of them point
 * to ranks above one only a single show suggested, with more recent watching
 * counting for more. Anything they have already started is left out.
 *
 * That is a TMDB lookup per title, so the list is built once a day per person
 * and kept in memory; statuses are read fresh on every request.
 */

export type SuggestionResult =
  | (TmdbMovieResult & { media_type: 'movie' })
  | (TmdbTvResult & { media_type: 'tv' });

/** Titles whose recommendations are asked for. */
const SEEDS = 15;
/** How many suggestions are kept: enough to fill the full page. */
const KEEP = 100;
const REBUILD_MS = 24 * 60 * 60 * 1000;
/** TMDB lookups at once: well inside its rate limit. */
const CONCURRENCY = 4;

/**
 * Keyed on the Plex account as well as the user: history belongs to the
 * account, so relinking a different one starts afresh.
 */
const built = new Map<
  string,
  { at: number; value: Promise<SuggestionResult[]> }
>();

const keyOf = (mediaType: MediaType, tmdbId: number) =>
  `${mediaType}:${tmdbId}`;

/** The Plex rating key a play belongs to: the film, or the episode's show. */
const titleKeyOf = (record: {
  media_type: string;
  rating_key: number;
  grandparent_rating_key: number;
}) => ({
  mediaType: record.media_type === 'movie' ? MediaType.MOVIE : MediaType.TV,
  ratingKey: String(
    record.media_type === 'movie'
      ? record.rating_key
      : record.grandparent_rating_key
  ),
});

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
  const settings = getSettings().tautulli;
  if (!settings.hostname || !settings.port || !settings.apiKey) {
    return [];
  }

  const history = await new TautulliAPI(settings).getUserHistory(user);
  if (!history.length) {
    return [];
  }

  // Every title they have started, and the ones they finished, newest first.
  const startedKeys = new Set<string>();
  // A Set keeps insertion order, so this stays newest first.
  const finishedOrder = new Set<string>();
  for (const record of history) {
    const { mediaType, ratingKey } = titleKeyOf(record);
    startedKeys.add(`${mediaType}:${ratingKey}`);
    if (record.watched_status === 1) {
      finishedOrder.add(`${mediaType}:${ratingKey}`);
    }
  }

  // Plex rating keys to TMDB ids, through the library Seerr already knows.
  const ratingKeys = [
    ...new Set([...startedKeys].map((key) => key.split(':')[1])),
  ];
  const known = await getRepository(Media).find({
    where: [{ ratingKey: In(ratingKeys) }, { ratingKey4k: In(ratingKeys) }],
  });
  const byRatingKey = new Map<string, Media>();
  for (const media of known) {
    for (const key of [media.ratingKey, media.ratingKey4k]) {
      if (key) {
        byRatingKey.set(`${media.mediaType}:${key}`, media);
      }
    }
  }

  const started = new Set<string>();
  for (const key of startedKeys) {
    const media = byRatingKey.get(key);
    if (media) {
      started.add(keyOf(media.mediaType, media.tmdbId));
    }
  }

  const seeds: Media[] = [];
  for (const key of finishedOrder) {
    const media = byRatingKey.get(key);
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
 * Suggestions for one person, best first. Empty when Tautulli is not set up,
 * they have no Plex account, or they have not finished anything yet.
 */
export const getSuggestions = (user: User): Promise<SuggestionResult[]> => {
  const now = Date.now();
  for (const [key, entry] of built) {
    if (now - entry.at >= REBUILD_MS) {
      built.delete(key);
    }
  }

  const key = `${user.id}:${user.plexId ?? ''}`;
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
