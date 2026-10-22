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
      const result = await failing()[search]({ query: 'Aurelin' });
      assert.deepEqual(result.results, []);
      assert.equal(warned.length, 1);
      assert.match(JSON.stringify(warned[0]), /status code 503/);
    });
  }
});

describe('discovering series by when their episodes air', () => {
  it('asks TMDB for episodes airing between two days', async () => {
    const tmdb = new TheMovieDb();
    let params: Record<string, unknown> = {};
    (
      tmdb as unknown as {
        axios: { get: (url: string, config: { params: object }) => unknown };
      }
    ).axios = {
      get: async (_url, config) => {
        params = config.params as Record<string, unknown>;
        return { data: { page: 1, total_pages: 1, results: [] } };
      },
    };
    await tmdb.getDiscoverTv({
      airDateGte: '2026-10-01',
      airDateLte: '2026-12-31',
    });
    assert.equal(params['air_date.gte'], '2026-10-01');
    assert.equal(params['air_date.lte'], '2026-12-31');
    assert.equal(params['first_air_date.gte'], undefined);
    assert.equal(params['first_air_date.lte'], undefined);
  });
});

describe('discovering titles by where they were made', () => {
  const capture = (tmdb: TheMovieDb) => {
    const asked: Record<string, unknown>[] = [];
    (
      tmdb as unknown as {
        axios: { get: (url: string, config: { params: object }) => unknown };
      }
    ).axios = {
      get: async (_url, config) => {
        asked.push(config.params as Record<string, unknown>);
        return { data: { page: 1, total_pages: 1, results: [] } };
      },
    };
    return asked;
  };

  it('asks TMDB for series and films from one country', async () => {
    const tmdb = new TheMovieDb();
    const asked = capture(tmdb);
    await tmdb.getDiscoverTv({ originCountry: 'KR' });
    await tmdb.getDiscoverMovies({ originCountry: 'KR' });
    assert.deepEqual(
      asked.map((params) => params.with_origin_country),
      ['KR', 'KR']
    );
  });

  it('does not narrow by country unless asked', async () => {
    const tmdb = new TheMovieDb();
    const asked = capture(tmdb);
    await tmdb.getDiscoverTv({});
    await tmdb.getDiscoverMovies({});
    assert.deepEqual(
      asked.map((params) => params.with_origin_country),
      [undefined, undefined]
    );
  });
});

describe('discovering titles by streaming service', () => {
  const capture = (tmdb: TheMovieDb) => {
    const asked: Record<string, unknown>[] = [];
    (
      tmdb as unknown as {
        axios: { get: (url: string, config: { params: object }) => unknown };
      }
    ).axios = {
      get: async (_url, config) => {
        asked.push(config.params as Record<string, unknown>);
        return { data: { page: 1, total_pages: 1, results: [] } };
      },
    };
    return asked;
  };
  const services = (params: Record<string, unknown>) => ({
    region: params.watch_region,
    on: params.with_watch_providers,
    notOn: params.without_watch_providers,
  });

  it('asks TMDB for titles on some services and not on others', async () => {
    const tmdb = new TheMovieDb();
    const asked = capture(tmdb);
    const options = {
      watchRegion: 'US',
      watchProviders: '8|9',
      excludeWatchProviders: '337|350',
    };
    await tmdb.getDiscoverMovies(options);
    await tmdb.getDiscoverTv(options);
    const expected = { region: 'US', on: '8|9', notOn: '337|350' };
    assert.deepEqual(asked.map(services), [expected, expected]);
  });

  it('leaves nothing out unless asked', async () => {
    const tmdb = new TheMovieDb();
    const asked = capture(tmdb);
    await tmdb.getDiscoverMovies({ watchRegion: 'US', watchProviders: '8' });
    await tmdb.getDiscoverTv({ watchRegion: 'US', watchProviders: '8' });
    assert.deepEqual(
      asked.map((params) => params.without_watch_providers),
      [undefined, undefined]
    );
  });
});
