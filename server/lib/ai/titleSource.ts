import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import { IMPORT_LINE_LIMIT } from '@server/constants/lists';
import type { User } from '@server/entity/User';
import { withLibraryStatus } from '@server/lib/ai/context';
import logger from '@server/logger';

/*
 * A whole franchise, studio, theme or filmography, read from TMDB rather
 * than recalled by a model: complete, current, and the same every time.
 * The model only says which one is meant.
 */

export interface TitleSource {
  /** What kind of set it is. */
  k: 'collection' | 'keyword' | 'company' | 'person';
  /** What to search TMDB for: "Harry Potter", "Marvel Cinematic Universe". */
  q: string;
  /** For a person: films they directed, or ones they appear in. */
  r?: 'director' | 'cast' | null;
}

/** As many as a list import takes at once. */
export const SOURCE_LIMIT = IMPORT_LINE_LIMIT;

/** Discover pages read at most, per kind (20 titles a page). */
const PAGES = Math.ceil(SOURCE_LIMIT / 20);

type Found = { kind: 'movie' | 'tv'; result: TmdbMovieResult | TmdbTvResult };

const named = (name: string) => name.trim().toLowerCase();

/** An exact name match if there is one, else TMDB's best guess. */
const best = <T extends { name: string }>(results: T[], query: string) =>
  results.find((r) => named(r.name) === named(query)) ?? results[0];

const releaseOf = (f: Found) =>
  (f.kind === 'movie'
    ? (f.result as TmdbMovieResult).release_date
    : (f.result as TmdbTvResult).first_air_date) || '9999';

/** Every page of a discover query, up to the limit. */
const allPages = async <T>(
  page: (n: number) => Promise<{ results: T[]; total_pages: number }>,
  more: { cut: boolean }
): Promise<T[]> => {
  const first = await page(1);
  if (first.total_pages > PAGES) {
    more.cut = true;
  }
  const rest = await Promise.all(
    Array.from(
      { length: Math.max(0, Math.min(first.total_pages, PAGES) - 1) },
      (_, i) => page(i + 2)
    )
  );
  return [first, ...rest].flatMap((p) => p.results);
};

const fromTmdb = async (
  source: TitleSource,
  kinds: ('movie' | 'tv')[],
  more: { cut: boolean }
): Promise<{ name: string; found: Found[] } | null> => {
  const tmdb = new TheMovieDb();
  const wantsMovies = kinds.includes('movie');
  const wantsTv = kinds.includes('tv');

  switch (source.k) {
    case 'collection': {
      const hit = best(
        (await tmdb.searchCollection({ query: source.q })).results,
        source.q
      );
      if (!hit || !wantsMovies) {
        return null;
      }
      const collection = await tmdb.getCollection({ collectionId: hit.id });
      return {
        name: collection.name,
        found: (collection.parts ?? []).map((result) => ({
          kind: 'movie',
          result: { ...result, media_type: 'movie' },
        })),
      };
    }
    case 'keyword': {
      const hit = best(
        (await tmdb.searchKeyword({ query: source.q })).results,
        source.q
      );
      if (!hit) {
        return null;
      }
      const keywords = String(hit.id);
      const [movies, shows] = await Promise.all([
        wantsMovies
          ? allPages(
              (page) =>
                tmdb.getDiscoverMovies({
                  keywords,
                  page,
                  originalLanguage: 'all',
                }),
              more
            )
          : [],
        wantsTv
          ? allPages(
              (page) =>
                tmdb.getDiscoverTv({ keywords, page, originalLanguage: 'all' }),
              more
            )
          : [],
      ]);
      return {
        // Keywords are stored in lower case; the name as asked reads better.
        name: named(hit.name) === named(source.q) ? source.q : hit.name,
        found: [
          ...movies.map((result) => ({ kind: 'movie' as const, result })),
          ...shows.map((result) => ({ kind: 'tv' as const, result })),
        ],
      };
    }
    case 'company': {
      const hit = best(
        (await tmdb.searchCompany({ query: source.q })).results,
        source.q
      );
      // TMDB lists a company's films; its series are listed by network.
      if (!hit || !wantsMovies) {
        return null;
      }
      const movies = await allPages(
        (page) =>
          tmdb.getDiscoverMovies({
            studio: String(hit.id),
            page,
            originalLanguage: 'all',
          }),
        more
      );
      return {
        name: hit.name,
        found: movies.map((result) => ({ kind: 'movie', result })),
      };
    }
    case 'person': {
      const people = (await tmdb.searchPerson({ query: source.q })).results;
      const hit =
        people.find((p) => named(p.name) === named(source.q)) ??
        [...people].sort((a, b) => b.popularity - a.popularity)[0];
      if (!hit) {
        return null;
      }
      const credits = await tmdb.getPersonCombinedCredits({
        personId: hit.id,
      });
      const role =
        source.r ??
        (hit.known_for_department === 'Directing' ? 'director' : 'cast');
      const picked =
        role === 'director'
          ? credits.crew.filter((c) => c.job === 'Director')
          : // Appearances as themselves (talk shows, award nights) are not
            // what "their films" means.
            credits.cast.filter(
              (c) => !/\b(self|himself|herself|themselves)\b/i.test(c.character)
            );
      return {
        name: hit.name,
        found: picked
          .filter(
            (c) =>
              (c.media_type === 'movie' && wantsMovies) ||
              (c.media_type === 'tv' && wantsTv)
          )
          .map((c) =>
            c.media_type === 'movie'
              ? {
                  kind: 'movie' as const,
                  result: c as unknown as TmdbMovieResult,
                }
              : { kind: 'tv' as const, result: c as unknown as TmdbTvResult }
          ),
      };
    }
  }
};

/**
 * The titles of a set, oldest first, with what the library has of each.
 * Null when TMDB has nothing by that name.
 */
export const titlesFromSource = async (
  user: User,
  source: TitleSource,
  kind: 'movie' | 'tv' | 'any'
) => {
  try {
    const more = { cut: false };
    const set = await fromTmdb(
      source,
      kind === 'any' ? ['movie', 'tv'] : [kind],
      more
    );
    if (!set) {
      return null;
    }
    let found = set.found.filter(
      (f) => !(f.result as { adult?: boolean }).adult
    );
    // Too many for one list: the best known ones.
    if (found.length > SOURCE_LIMIT) {
      more.cut = true;
      found = [...found]
        .sort((a, b) => b.result.popularity - a.result.popularity)
        .slice(0, SOURCE_LIMIT);
    }
    found.sort((a, b) => releaseOf(a).localeCompare(releaseOf(b)));
    const results = await withLibraryStatus(user, found);
    return { name: set.name, results, more: more.cut };
  } catch (e) {
    logger.warn('Could not read a set of titles from TMDB', {
      label: 'AI',
      kind: source.k,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
};
