import TheMovieDb from '@server/api/themoviedb';
import logger from '@server/logger';
import { normalizeSearchText } from '@server/utils/searchText';

/*
 * What a title can be found by when filtering a page of posters: its names,
 * the cast and the characters they play, the people who made it, its studios
 * (and a series' networks), genres and keywords. From TMDB's details for the
 * title — the same lookup its page makes, so usually cached already — and
 * kept here a day, bounded.
 */

export type SearchKey = `${'movie' | 'tv'}:${number}`;

const TTL_MS = 24 * 60 * 60 * 1000;
/** Titles kept: a few pages' worth for everyone at once. */
const MAX_ENTRIES = 5000;
/** TMDB lookups at once, for everyone together: well inside its rate limit. */
const CONCURRENCY = 6;
/** Cast listed: well past anyone searched for by name. */
const CAST_LIMIT = 60;

/** Crew worth finding a title by. */
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
/** A title TMDB could not answer for is not asked about again for this long. */
const FAILED_FOR_MS = 10 * 60 * 1000;

const failed = new Map<string, number>();
const building = new Map<string, Promise<void>>();
const queue: { key: SearchKey; done: () => void }[] = [];
let workers = 0;

/**
 * One queue for everyone, so several pages filtering at once share the same
 * few lookups rather than each starting their own.
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
  // A worker takes its first job as it starts, so start one per waiting job
  // until the limit.
  while (workers < CONCURRENCY && queue.length > 0) {
    void work();
  }
  return promise;
};

const prune = (now: number) => {
  // Oldest first, as a Map keeps insertion order: drop what is past its day,
  // then the oldest past the limit.
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
 * Searchable text for each title asked about, and which are still being
 * looked up. A page of new titles can take TMDB longer than anyone should
 * wait for one answer, so this answers with what is ready within a few
 * seconds and carries on in the background; the page asks again for the
 * rest. A title TMDB cannot answer for is in neither list, and the page
 * falls back to matching its name.
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
