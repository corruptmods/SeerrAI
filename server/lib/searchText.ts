import TheMovieDb from '@server/api/themoviedb';
import logger from '@server/logger';
import { normalizeSearchText } from '@server/utils/searchText';

/*
 * What a title can be found by when filtering a poster page: names, cast and
 * characters, key crew, studios (and series networks), genres and keywords.
 * Built from TMDB's details (the same lookup the title page makes, so usually
 * cached) and kept a day, bounded.
 */

export type SearchKey = `${'movie' | 'tv'}:${number}`;

const TTL_MS = 24 * 60 * 60 * 1000;
/** Titles kept: a few pages' worth for everyone at once. */
const MAX_ENTRIES = 5000;
/** Concurrent TMDB lookups across all users: well inside its rate limit. */
const CONCURRENCY = 6;
/** Cast members included: well past anyone searched by name. */
const CAST_LIMIT = 60;

/** Crew jobs worth finding a title by. */
const CREW_JOBS = new Set([
  'Director',
  'Screenplay',
  'Writer',
  'Story',
  'Novel',
  'Creator',
]);

const cache = new Map<string, { at: number; text: string }>();

const build = async (tmdb: TheMovieDb, key: SearchKey): Promise<string> => {
  const [type, idText] = key.split(':');
  const id = Number(idText);
  const words: (string | undefined)[] = [];

  if (type === 'movie') {
    const movie = await tmdb.getMovie({ movieId: id });
    words.push(
      movie.title,
      movie.original_title,
      ...movie.credits.cast
        .slice(0, CAST_LIMIT)
        .flatMap((c) => [c.name, c.character]),
      ...movie.credits.crew
        .filter((c) => CREW_JOBS.has(c.job))
        .map((c) => c.name),
      ...movie.genres.map((g) => g.name),
      ...(movie.keywords?.keywords ?? []).map((k) => k.name),
      ...(movie.production_companies ?? []).map((c) => c.name)
    );
  } else {
    const show = await tmdb.getTvShow({ tvId: id });
    words.push(
      show.name,
      show.original_name,
      ...(show.aggregate_credits?.cast ?? [])
        .slice(0, CAST_LIMIT)
        .flatMap((c) => [c.name, ...c.roles.map((r) => r.character)]),
      ...(show.credits?.crew ?? [])
        .filter((c) => CREW_JOBS.has(c.job))
        .map((c) => c.name),
      ...show.created_by.map((c) => c.name),
      ...show.genres.map((g) => g.name),
      ...(show.keywords?.results ?? []).map((k) => k.name),
      ...(show.production_companies ?? []).map((c) => c.name),
      ...(show.networks ?? []).map((n) => n.name)
    );
  }

  // Duplicate names (an actor in several roles) add nothing to a match.
  return [
    ...new Set(normalizeSearchText(words.filter(Boolean).join(' ')).split(' ')),
  ].join(' ');
};

/** How long a request waits for titles still being looked up. */
const ANSWER_WITHIN_MS = 5000;
/** A title TMDB failed for isn't retried for this long. */
const FAILED_FOR_MS = 10 * 60 * 1000;

const failed = new Map<string, number>();
const building = new Map<string, Promise<void>>();
const queue: { key: SearchKey; done: () => void }[] = [];
let workers = 0;

/**
 * One shared queue, so pages filtering at once share lookups instead of each
 * starting their own.
 */
const work = async () => {
  workers++;
  const tmdb = new TheMovieDb();
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        const text = await build(tmdb, job.key);
        cache.delete(job.key);
        cache.set(job.key, { at: Date.now(), text });
      } catch (e) {
        failed.set(job.key, Date.now());
        logger.debug('Could not read details to search a title by', {
          label: 'Search Text',
          key: job.key,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      } finally {
        building.delete(job.key);
        job.done();
      }
    }
  } finally {
    workers--;
  }
};

const lookUp = (key: SearchKey): Promise<void> => {
  const existing = building.get(key);
  if (existing) {
    return existing;
  }
  const promise = new Promise<void>((done) => queue.push({ key, done }));
  building.set(key, promise);
  // A worker takes its first job on start, so start one per waiting job up to
  // the limit.
  while (workers < CONCURRENCY && queue.length > 0) {
    void work();
  }
  return promise;
};

const prune = (now: number) => {
  // Maps keep insertion order, so oldest first: drop expired entries, then the
  // oldest past the limit.
  for (const [key, entry] of cache) {
    if (cache.size <= MAX_ENTRIES && now - entry.at < TTL_MS) {
      break;
    }
    cache.delete(key);
  }
  for (const [key, at] of failed) {
    if (now - at < FAILED_FOR_MS) {
      break;
    }
    failed.delete(key);
  }
};

/**
 * Searchable text per requested title, and which are still being looked up.
 * A page of new titles can take TMDB longer than one answer should wait, so
 * this returns what is ready within a few seconds and continues in the
 * background; the page asks again for the rest. A title TMDB fails for is in
 * neither list, and the page falls back to matching its name.
 */
export const getSearchText = async (
  keys: SearchKey[]
): Promise<{ text: Record<string, string>; pending: string[] }> => {
  const now = Date.now();
  prune(now);

  const wanted = [...new Set(keys)].filter((key) => !failed.has(key));
  const lookups = wanted
    .filter((key) => {
      const hit = cache.get(key);
      return !hit || now - hit.at >= TTL_MS;
    })
    .map(lookUp);

  if (lookups.length) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(lookups),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ANSWER_WITHIN_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  const text: Record<string, string> = {};
  const pending: string[] = [];
  for (const key of wanted) {
    const hit = cache.get(key);
    if (hit) {
      text[key] = hit.text;
    } else if (building.has(key)) {
      pending.push(key);
    }
  }
  return { text, pending };
};
