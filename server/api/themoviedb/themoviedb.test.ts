import TheMovieDb from '@server/api/themoviedb';
import cacheManager from '@server/lib/cache';
import logger from '@server/logger';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * TMDB's searches, when TMDB does not answer: still an empty page for the
 * callers, but no longer silent.
 */

let warned: unknown[][] = [];

beforeEach(() => {
  cacheManager.getCache('tmdb').flush();
  warned = [];
  mock.method(logger, 'warn', (...args: unknown[]) => {
    warned.push(args);
    return logger;
  });
});

afterEach(() => mock.restoreAll());

const failing = () => {
  const tmdb = new TheMovieDb();
  (tmdb as unknown as { axios: { get: () => Promise<never> } }).axios = {
    get: async () => {
      throw new Error('Request failed with status code 503');
    },
  };
  return tmdb;
};

describe('a TMDB search TMDB does not answer', () => {
  for (const search of [
    'searchMulti',
    'searchMovies',
    'searchTvShows',
  ] as const) {
    it(`${search} says so in the log, and finds nothing`, async () => {
      const result = await failing()[search]({ query: 'Alien' });
      assert.deepEqual(result.results, []);
      assert.equal(warned.length, 1);
      assert.match(JSON.stringify(warned[0]), /status code 503/);
    });
  }
});
