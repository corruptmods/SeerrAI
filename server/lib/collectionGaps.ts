import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import logger from '@server/logger';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';
import { In } from 'typeorm';

/*
 * Collections the library has part of: some films here, some released ones
 * not. Found by looking up each library film's TMDB collection (cached
 * lookups), rebuilt daily in the background since it is one lookup per film.
 */

export interface CollectionGap {
  id: number;
  name: string;
  /** Released films in the collection. */
  total: number;
  inLibrary: number;
  requested: number;
  /** Released, and neither here nor requested. */
  missing: number;
}

const REBUILD_MS = 24 * 60 * 60 * 1000;
/** Concurrent TMDB lookups; well inside its rate limit. */
const CONCURRENCY = 4;

let built: { at: number; gaps: CollectionGap[] } | undefined;
let building: Promise<void> | undefined;

const build = async (): Promise<void> => {
  const tmdb = new TheMovieDb();
  const inLibrary = await getRepository(Media).find({
    where: {
      mediaType: MediaType.MOVIE,
      status: In([MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE]),
    },
  });

  const collections = new Map<number, string>();
  await mapWithConcurrency(inLibrary, CONCURRENCY, async (media) => {
    try {
      const movie = await tmdb.getMovie({ movieId: media.tmdbId });
      if (movie.belongs_to_collection) {
        collections.set(
          movie.belongs_to_collection.id,
          movie.belongs_to_collection.name
        );
      }
    } catch {
      // Skip a film TMDB can't answer for.
    }
  });

  const gaps: CollectionGap[] = [];
  const now = Date.now();
  await mapWithConcurrency(
    [...collections.keys()],
    CONCURRENCY,
    async (collectionId) => {
      try {
        const collection = await tmdb.getCollection({ collectionId });
        // An unreleased film isn't missing.
        const released = collection.parts.filter((part) => {
          const at = part.release_date
            ? new Date(part.release_date).getTime()
            : NaN;
          return !Number.isNaN(at) && at <= now;
        });
        if (released.length < 2) {
          return;
        }
        const known = await getRepository(Media).find({
          where: {
            mediaType: MediaType.MOVIE,
            tmdbId: In(released.map((part) => part.id)),
          },
        });
        const statusOf = new Map(known.map((m) => [m.tmdbId, m.status]));
        const count = (statuses: MediaStatus[]) =>
          released.filter((part) =>
            statuses.includes(statusOf.get(part.id) ?? MediaStatus.UNKNOWN)
          ).length;
        const have = count([
          MediaStatus.AVAILABLE,
          MediaStatus.PARTIALLY_AVAILABLE,
        ]);
        const requested = count([MediaStatus.PENDING, MediaStatus.PROCESSING]);
        const missing = count([MediaStatus.UNKNOWN, MediaStatus.DELETED]);
        if (have > 0 && missing > 0) {
          gaps.push({
            id: collectionId,
            name: collection.name ?? collections.get(collectionId) ?? '',
            total: released.length,
            inLibrary: have,
            requested,
            missing,
          });
        }
      } catch {
        // Skip what TMDB can't answer.
      }
    }
  );

  // Nearest to complete first: a request finishes those.
  gaps.sort(
    (a, b) =>
      a.missing - b.missing ||
      b.inLibrary - a.inLibrary ||
      a.name.localeCompare(b.name)
  );
  built = { at: Date.now(), gaps };
  logger.info('Found collections partly in the library', {
    label: 'Collections',
    films: inLibrary.length,
    collections: collections.size,
    withGaps: gaps.length,
  });
};

/**
 * Collections with gaps, or undefined while the first list builds. A list
 * older than a day is served while a new one builds.
 */
export const getCollectionGaps = (): CollectionGap[] | undefined => {
  const stale = !built || Date.now() - built.at > REBUILD_MS;
  if (stale && !building) {
    building = build()
      .catch((e) => {
        logger.warn('Could not look for collection gaps', {
          label: 'Collections',
          errorMessage: e.message,
        });
      })
      .finally(() => {
        building = undefined;
      });
  }
  return built?.gaps;
};
