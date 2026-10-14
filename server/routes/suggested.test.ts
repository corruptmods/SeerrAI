import TheMovieDb from '@server/api/themoviedb';
import { DiscoverSliderType, defaultSliders } from '@server/constants/discover';
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import DiscoverSlider from '@server/entity/DiscoverSlider';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import discoverRoutes from '@server/routes/discover';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * "Suggested for you": a fake Tautulli's history and stubbed TMDB
 * recommendations, behind the real API validator.
 */

setupTestDb();

// Tautulli's get_history for one user, newest first.
let history: unknown[] = [];
let historyAsks = 0;
const fake = http.createServer((_req, res) => {
  historyAsks++;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      response: { result: 'success', data: { data: history } },
    })
  );
});

// TMDB recommendations, by the title asked about.
let movieRecs: Record<number, { id: number; adult?: boolean }[]> = {};
let tvRecs: Record<number, { id: number }[]> = {};
let tmdbAsks = 0;
const result = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Title ${id}`,
  name: `Title ${id}`,
  overview: '',
  poster_path: null,
  backdrop_path: null,
  genre_ids: [],
  original_language: 'en',
  popularity: 1,
  vote_average: 7,
  vote_count: 10,
  adult: false,
  release_date: '2020-01-01',
  first_air_date: '2020-01-01',
  origin_country: [],
  original_title: `Title ${id}`,
  original_name: `Title ${id}`,
  video: false,
  ...extra,
});
const stub = (name: string, value: unknown) =>
  Object.defineProperty(TheMovieDb.prototype, name, {
    configurable: true,
    set() {},
    get() {
      return value;
    },
  });
stub('getMovieRecommendations', async ({ movieId }: { movieId: number }) => {
  tmdbAsks++;
  return {
    page: 1,
    total_pages: 1,
    total_results: 0,
    results: (movieRecs[movieId] ?? []).map((r) => result(r.id, r)),
  };
});
stub('getTvRecommendations', async ({ tvId }: { tvId: number }) => {
  tmdbAsks++;
  return {
    page: 1,
    total_pages: 1,
    total_results: 0,
    results: (tvRecs[tvId] ?? []).map((r) => result(r.id, r)),
  };
});

let app: Server;
let port: number;
let actingAs: User;
// Suggestions are kept a day per Plex account, so each test uses its own.
let nextPlexId = 1000;

before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  const ex = express();
  ex.use(express.json());
  ex.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  ex.use((req, _res, next) => {
    (req as unknown as { user: User }).user = actingAs;
    next();
  });
  ex.use('/api/v1/discover', discoverRoutes);
  app = await new Promise<Server>((resolve) => {
    const s = ex.listen(0, () => resolve(s));
  });
  port = (app.address() as { port: number }).port;
});
after(() => {
  app?.close();
  fake.close();
});

beforeEach(async () => {
  history = [];
  historyAsks = 0;
  movieRecs = {};
  tvRecs = {};
  tmdbAsks = 0;
  // Tautulli is Plex's watch history, read while Plex is connected.
  getSettings().main.mediaServerType = MediaServerType.PLEX;
  getSettings().tautulli = {
    hostname: '127.0.0.1',
    port: (fake.address() as { port: number }).port,
    apiKey: 'k',
    useSsl: false,
  };
  actingAs = await getRepository(User).save(
    new User({
      email: `suggest-${nextPlexId}@test.local`,
      plexUsername: 'Viewer',
      plexId: nextPlexId++,
      permissions: Permission.REQUEST,
      avatar: '/a.png',
    })
  );
});

const library = (
  tmdbId: number,
  mediaType: MediaType,
  ratingKey: string,
  status = MediaStatus.AVAILABLE
) =>
  getRepository(Media).save(
    new Media({ tmdbId, mediaType, ratingKey, status })
  );

const moviePlay = (ratingKey: number, watched = 1) => ({
  media_type: 'movie',
  rating_key: ratingKey,
  grandparent_rating_key: 0,
  watched_status: watched,
});
const episodePlay = (showKey: number, episodeKey: number, watched = 1) => ({
  media_type: 'episode',
  rating_key: episodeKey,
  grandparent_rating_key: showKey,
  watched_status: watched,
});

const get = async (page = 1) => {
  const res = await fetch(
    `http://127.0.0.1:${port}/api/v1/discover/suggested?page=${page}`
  );
  return {
    status: res.status,
    body: (await res.json()) as {
      page: number;
      totalPages: number;
      totalResults: number;
      results: {
        id: number;
        mediaType: string;
        mediaInfo?: { status: MediaStatus };
      }[];
    },
  };
};
const ids = (results: { id: number; mediaType: string }[]) =>
  results.map((r) => `${r.mediaType}:${r.id}`);

describe('GET /discover/suggested', () => {
  it('is empty, not an error, without Tautulli', async () => {
    // The setter merges, so each field is cleared.
    getSettings().tautulli = {
      hostname: '',
      port: undefined,
      apiKey: '',
      useSsl: false,
    };

    const { status, body } = await get();

    assert.equal(status, 200);
    assert.deepEqual(body.results, []);
    assert.equal(historyAsks, 0);
  });

  it('is empty for someone who has watched nothing', async () => {
    const { status, body } = await get();

    assert.equal(status, 200);
    assert.equal(body.totalResults, 0);
    assert.equal(tmdbAsks, 0);
  });

  it('suggests from finished films and series, most shared first', async () => {
    await library(10, MediaType.MOVIE, '110');
    await library(11, MediaType.MOVIE, '111');
    await library(20, MediaType.TV, '220');
    // The series counts through its episode, by the show's rating key.
    history = [moviePlay(110), episodePlay(220, 2201), moviePlay(111)];
    // 500 is recommended by both films, so it outranks what only one points
    // to, even the most recent watch's first pick.
    movieRecs = { 10: [{ id: 400 }, { id: 500 }], 11: [{ id: 500 }] };
    tvRecs = { 20: [{ id: 600 }] };

    const { body } = await get();

    assert.equal(ids(body.results)[0], 'movie:500');
    assert.deepEqual(
      new Set(ids(body.results)),
      new Set(['movie:400', 'movie:500', 'tv:600'])
    );
  });

  it('leaves out anything already started, finished or not', async () => {
    await library(10, MediaType.MOVIE, '110');
    await library(11, MediaType.MOVIE, '111');
    // 11 was started and abandoned: never a seed, and never suggested.
    history = [moviePlay(110), moviePlay(111, 0)];
    movieRecs = { 10: [{ id: 11 }, { id: 12 }], 11: [{ id: 99 }] };

    const { body } = await get();

    assert.deepEqual(ids(body.results), ['movie:12']);
  });

  it('never suggests a blocklisted or adult title', async () => {
    await library(10, MediaType.MOVIE, '110');
    await library(13, MediaType.MOVIE, '', MediaStatus.BLOCKLISTED);
    history = [moviePlay(110)];
    movieRecs = {
      10: [{ id: 13 }, { id: 14, adult: true }, { id: 15 }],
    };

    const { body } = await get();

    assert.deepEqual(ids(body.results), ['movie:15']);
  });

  it('says what is already in the library', async () => {
    await library(10, MediaType.MOVIE, '110');
    await library(16, MediaType.MOVIE, '116');
    history = [moviePlay(110)];
    movieRecs = { 10: [{ id: 16 }, { id: 17 }] };

    const { body } = await get();

    const inLibrary = body.results.find((r) => r.id === 16);
    assert.equal(inLibrary?.mediaInfo?.status, MediaStatus.AVAILABLE);
    assert.equal(body.results.find((r) => r.id === 17)?.mediaInfo, undefined);
  });

  it('narrows to films or series for the full page', async () => {
    await library(10, MediaType.MOVIE, '110');
    await library(20, MediaType.TV, '220');
    history = [moviePlay(110), episodePlay(220, 2201)];
    movieRecs = { 10: [{ id: 400 }] };
    tvRecs = { 20: [{ id: 600 }] };

    const films = await fetch(
      `http://127.0.0.1:${port}/api/v1/discover/suggested?mediaType=movie`
    ).then((r) => r.json());
    const series = await fetch(
      `http://127.0.0.1:${port}/api/v1/discover/suggested?mediaType=tv`
    ).then((r) => r.json());

    assert.deepEqual(ids(films.results), ['movie:400']);
    assert.deepEqual(ids(series.results), ['tv:600']);
    assert.equal(films.totalResults, 1);
  });

  it('pages twenty at a time', async () => {
    await library(10, MediaType.MOVIE, '110');
    history = [moviePlay(110)];
    movieRecs = {
      10: Array.from({ length: 30 }, (_, i) => ({ id: 1000 + i })),
    };

    const first = await get(1);
    const second = await get(2);

    assert.equal(first.body.totalResults, 30);
    assert.equal(first.body.totalPages, 2);
    assert.equal(first.body.results.length, 20);
    assert.equal(second.body.results.length, 10);
  });

  it('asks Tautulli and TMDB once, not on every visit', async () => {
    await library(10, MediaType.MOVIE, '110');
    history = [moviePlay(110)];
    movieRecs = { 10: [{ id: 18 }] };

    await get();
    await get();
    await get(2);

    assert.equal(historyAsks, 1);
    assert.equal(tmdbAsks, 1);
  });
});

describe('the Deleting Soon row', () => {
  it('goes first when added to an existing home page', async () => {
    const repository = getRepository(DiscoverSlider);
    await repository.clear();
    let order = 0;
    for (const slider of defaultSliders) {
      if (slider.type !== DiscoverSliderType.DELETING_SOON) {
        await repository.save(
          new DiscoverSlider({ ...slider, order: order++ })
        );
      }
    }
    await DiscoverSlider.bootstrapSliders();
    const sliders = await repository.find({ order: { order: 'ASC' } });
    assert.deepEqual(
      sliders.slice(0, 2).map((s) => s.type),
      [DiscoverSliderType.DELETING_SOON, DiscoverSliderType.RECENTLY_ADDED]
    );
    assert.equal(new Set(sliders.map((s) => s.order)).size, sliders.length);
  });
});

describe('the Suggested for You row', () => {
  it('goes straight after the watchlist when added to an existing home page', async () => {
    const repository = getRepository(DiscoverSlider);
    await repository.clear();
    // The home page as it was before this row existed, with a custom row.
    let order = 0;
    for (const slider of defaultSliders) {
      if (slider.type !== DiscoverSliderType.SUGGESTED) {
        await repository.save(
          new DiscoverSlider({ ...slider, order: order++ })
        );
      }
    }
    await repository.save(
      new DiscoverSlider({
        type: DiscoverSliderType.TMDB_SEARCH,
        title: 'Mine',
        data: 'x',
        enabled: true,
        isBuiltIn: false,
        order: order++,
      })
    );

    await DiscoverSlider.bootstrapSliders();

    const sliders = await repository.find({ order: { order: 'ASC' } });
    const types = sliders.map((s) => s.type);
    assert.deepEqual(types.slice(3, 6), [
      DiscoverSliderType.PLEX_WATCHLIST,
      DiscoverSliderType.SUGGESTED,
      DiscoverSliderType.TRENDING,
    ]);
    assert.equal(
      new Set(sliders.map((s) => s.order)).size,
      sliders.length,
      'no two rows share a position'
    );
    assert.equal(types[types.length - 1], DiscoverSliderType.TMDB_SEARCH);
  });
});

describe('the Anime row', () => {
  it('keeps a number of its own, past those Seerr uses', () => {
    // Saved in the database: a number already taken would turn existing
    // rows into this one.
    assert.equal(DiscoverSliderType.ANIME, 24);
  });

  it('goes after Upcoming Series when added to an existing home page', async () => {
    const repository = getRepository(DiscoverSlider);
    await repository.clear();
    let order = 0;
    for (const slider of defaultSliders) {
      if (slider.type !== DiscoverSliderType.ANIME) {
        await repository.save(
          new DiscoverSlider({ ...slider, order: order++ })
        );
      }
    }

    await DiscoverSlider.bootstrapSliders();

    const sliders = await repository.find({ order: { order: 'ASC' } });
    const types = sliders.map((s) => s.type);
    const at = types.indexOf(DiscoverSliderType.ANIME);
    assert.deepEqual(types.slice(at - 1, at + 2), [
      DiscoverSliderType.UPCOMING_TV,
      DiscoverSliderType.ANIME,
      DiscoverSliderType.NETWORKS,
    ]);
    assert.equal(sliders[at].enabled, true);
    assert.equal(
      new Set(sliders.map((s) => s.order)).size,
      sliders.length,
      'no two rows share a position'
    );
  });
});
