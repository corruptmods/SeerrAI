import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import discoverRoutes from '@server/routes/discover';
import { setupTestDb } from '@server/test/db';
import { seasonDates, seasonOf } from '@server/utils/animeSeason';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * The studio and network pages list titles for the person looking, so they
 * follow that person's Discover region and original language like every
 * other Discover page. The Anime pages follow their region, and list what
 * Seerr counts as anime (utils/isAnime): what TMDB tags as anime, apart
 * from the countries an admin leaves out, and Japanese animation.
 */

setupTestDb();

// What the TMDB client each route made was set up with, per call.
let asked: { region?: string; language?: string }[] = [];
// What each discover call asked TMDB for.
let searched: ({ kind: 'movie' | 'tv' } & Record<string, unknown>)[] = [];
interface TmdbPage {
  page: number;
  total_pages: number;
  total_results: number;
  results: unknown[];
}
// The page TMDB answers with: the same for every call, or by what was asked.
let tmdbPage: TmdbPage;
let tmdbAnswer:
  | ((kind: 'movie' | 'tv', options: Record<string, unknown>) => TmdbPage)
  | undefined;
// The films looked up one by one, to see where they were made.
let lookedUp: number[] = [];
let filmCountries: Record<number, string[]> = {};
const settingsOf = (tmdb: TheMovieDb) => {
  const raw = tmdb as unknown as {
    discoverRegion?: string;
    originalLanguage?: string;
  };
  return { region: raw.discoverRegion, language: raw.originalLanguage };
};
const stub = (name: string, value: unknown) =>
  Object.defineProperty(TheMovieDb.prototype, name, {
    configurable: true,
    set() {},
    get() {
      return value;
    },
  });
const emptyPage = { page: 1, total_pages: 1, total_results: 0, results: [] };
stub('getStudio', async () => ({ id: 1, name: 'Studio', logo_path: null }));
stub('getNetwork', async () => ({ id: 2, name: 'Network', logo_path: null }));
stub(
  'getDiscoverMovies',
  async function (this: TheMovieDb, options: Record<string, unknown>) {
    asked.push(settingsOf(this));
    searched.push({ kind: 'movie', ...options });
    return tmdbAnswer?.('movie', options) ?? tmdbPage;
  }
);
stub(
  'getDiscoverTv',
  async function (this: TheMovieDb, options: Record<string, unknown>) {
    asked.push(settingsOf(this));
    searched.push({ kind: 'tv', ...options });
    return tmdbAnswer?.('tv', options) ?? tmdbPage;
  }
);
stub('getMovieForScan', async ({ movieId }: { movieId: number }) => {
  lookedUp.push(movieId);
  return {
    id: movieId,
    production_countries: (filmCountries[movieId] ?? []).map((iso) => ({
      iso_3166_1: iso,
    })),
    keywords: { keywords: [{ id: 210024, name: 'anime' }] },
  };
});

let app: Server;
let port: number;
let actingAs: User;

before(async () => {
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
});

beforeEach(async () => {
  asked = [];
  searched = [];
  tmdbPage = emptyPage;
  tmdbAnswer = undefined;
  lookedUp = [];
  filmCountries = {};
  getSettings().main.animeExcludedCountries = [];
  getSettings().main.discoverRegion = 'US';
  getSettings().main.originalLanguage = 'en';
  actingAs = await getRepository(User).save(
    new User({
      email: 'region@test.local',
      plexUsername: 'Viewer',
      permissions: Permission.REQUEST,
      avatar: '/a.png',
      settings: new UserSettings({
        streamingRegion: 'GB',
        originalLanguage: 'ja',
      }),
    })
  );
});

const get = (url: string) =>
  fetch(`http://127.0.0.1:${port}/api/v1/discover${url}`);

describe('studio and network pages', () => {
  it("list a studio's films in the person's region and language", async () => {
    const res = await get('/movies/studio/1');
    assert.equal(res.status, 200);
    assert.deepEqual(asked, [{ region: 'GB', language: 'ja' }]);
  });

  it("list a network's series in the person's region and language", async () => {
    const res = await get('/tv/network/2');
    assert.equal(res.status, 200);
    assert.deepEqual(asked, [{ region: 'GB', language: 'ja' }]);
  });

  it("use the server's defaults for someone who has not chosen", async () => {
    actingAs.settings = undefined;
    await get('/movies/studio/1');
    await get('/tv/network/2');
    assert.deepEqual(asked, [
      { region: 'US', language: 'en' },
      { region: 'US', language: 'en' },
    ]);
  });
});

describe('the Anime pages', () => {
  const series = (
    id: number,
    name: string,
    {
      language = 'ja',
      country = 'JP',
      popularity = 10,
    }: { language?: string; country?: string; popularity?: number } = {}
  ) => ({
    id,
    name,
    original_name: name,
    original_language: language,
    origin_country: [country],
    genre_ids: [16],
    overview: '',
    popularity,
    first_air_date: '2026-10-04',
    vote_average: 8,
    vote_count: 100,
    backdrop_path: null,
    poster_path: null,
  });
  const film = (id: number, title: string, language: string) => ({
    id,
    title,
    original_title: title,
    original_language: language,
    genre_ids: [16],
    overview: '',
    popularity: 10,
    release_date: '2026-01-01',
    vote_average: 8,
    vote_count: 100,
    adult: false,
    video: false,
    backdrop_path: null,
    poster_path: null,
  });
  const page = (results: unknown[], totalPages = 1): TmdbPage => ({
    page: 1,
    total_pages: totalPages,
    total_results: results.length * totalPages,
    results,
  });
  // TMDB's two answers: what it tags as anime, and Japanese animation it
  // has not tagged.
  const answer = (tagged: TmdbPage, untagged: TmdbPage) => {
    tmdbAnswer = (_kind, options) => (options.keywords ? tagged : untagged);
  };
  const names = async (url: string) =>
    (
      (await (await get(url)).json()) as {
        results: { name?: string; title?: string }[];
      }
    ).results.map((r) => r.name ?? r.title);

  it('ask for what TMDB tags as anime, and Japanese animation it has not tagged', async () => {
    const res = await get('/anime?show=airing&season=2026-fall');
    assert.equal(res.status, 200);
    assert.equal(searched.length, 2);
    const tagged = searched.find((s) => s.keywords)!;
    const untagged = searched.find((s) => !s.keywords)!;
    assert.equal(tagged.kind, 'tv');
    assert.equal(tagged.keywords, '210024');
    assert.equal(tagged.originalLanguage, 'all');
    assert.equal(tagged.genre, undefined);
    assert.equal(untagged.kind, 'tv');
    assert.equal(untagged.genre, '16');
    assert.equal(untagged.originalLanguage, 'ja');
    assert.equal(untagged.excludeKeywords, '210024');
    for (const one of [tagged, untagged]) {
      assert.equal(one.airDateGte, '2026-10-01');
      assert.equal(one.airDateLte, '2026-12-31');
      assert.equal(one.firstAirDateGte, undefined);
      assert.equal(one.firstAirDateLte, undefined);
      assert.equal(one.sortBy, 'popularity.desc');
      assert.equal(one.originCountry, undefined);
      assert.equal(one.page, 1);
    }
  });

  it('list the series premiering in a season', async () => {
    const res = await get('/anime?show=premieres&season=2027-winter');
    assert.equal(res.status, 200);
    for (const one of searched) {
      assert.equal(one.kind, 'tv');
      assert.equal(one.firstAirDateGte, '2027-01-01');
      assert.equal(one.firstAirDateLte, '2027-03-31');
      assert.equal(one.airDateGte, undefined);
      assert.equal(one.airDateLte, undefined);
    }
  });

  it('show what is airing this season when nothing is chosen', async () => {
    const res = await get('/anime');
    assert.equal(res.status, 200);
    const { start, end } = seasonDates(seasonOf(new Date()));
    assert.equal(searched.length, 2);
    for (const one of searched) {
      assert.equal(one.airDateGte, start);
      assert.equal(one.airDateLte, end);
    }
  });

  it('list the most popular series of any season', async () => {
    await get('/anime?show=popular');
    assert.equal(searched.length, 2);
    for (const one of searched) {
      assert.equal(one.kind, 'tv');
      assert.equal(one.airDateGte, undefined);
      assert.equal(one.firstAirDateGte, undefined);
    }
  });

  it('list films', async () => {
    await get('/anime?show=films');
    assert.deepEqual(
      searched.map((one) => [one.kind, one.keywords ?? one.genre]),
      [
        ['movie', '210024'],
        ['movie', '16'],
      ]
    );
  });

  it("follow the person's region, whatever their Discover Language", async () => {
    actingAs.settings!.originalLanguage = 'en';
    await get('/anime?show=popular');
    assert.deepEqual(asked, [
      { region: 'GB', language: 'en' },
      { region: 'GB', language: 'en' },
    ]);
    assert.deepEqual(searched.map((one) => one.originalLanguage).sort(), [
      'all',
      'ja',
    ]);
  });

  it('merge the two, most popular first, with as many pages as the longer', async () => {
    answer(
      page(
        [
          series(1, 'Tagged, popular', { popularity: 50 }),
          series(2, 'Tagged', { popularity: 5 }),
        ],
        3
      ),
      page([series(3, 'Untagged', { popularity: 20 })], 1)
    );
    const res = await get('/anime?show=popular&page=2');
    const body = (await res.json()) as {
      page: number;
      totalPages: number;
      totalResults: number;
      results: { name: string }[];
    };
    assert.deepEqual(
      searched.map((one) => one.page),
      [2, 2]
    );
    assert.equal(body.page, 2);
    assert.equal(body.totalPages, 3);
    assert.equal(body.totalResults, 7);
    assert.deepEqual(
      body.results.map((r) => r.name),
      ['Tagged, popular', 'Untagged', 'Tagged']
    );
  });

  it('include anime from every country when none is left out', async () => {
    answer(
      page([
        series(1, 'Gravespire', { language: 'en', country: 'US' }),
        series(2, 'Korean', { language: 'ko', country: 'KR' }),
      ]),
      page([series(3, 'Japanese')])
    );
    assert.deepEqual((await names('/anime?show=popular')).sort(), [
      'Gravespire',
      'Japanese',
      'Korean',
    ]);
  });

  it('leave out countries an admin listed, unless the title is in Japanese', async () => {
    getSettings().main.animeExcludedCountries = ['US'];
    answer(
      page([
        series(1, 'Gravespire', { language: 'en', country: 'US' }),
        series(2, 'Yorumaki', { language: 'ja', country: 'US' }),
        series(3, 'Korean', { language: 'ko', country: 'KR' }),
      ]),
      page([])
    );
    assert.deepEqual((await names('/anime?show=popular')).sort(), [
      'Korean',
      'Yorumaki',
    ]);
  });

  it('look up where a film was made only when it could be left out', async () => {
    answer(
      page([film(201, 'American', 'en'), film(202, 'Japanese', 'ja')]),
      page([film(203, 'Untagged', 'ja')])
    );
    filmCountries = { 201: ['US'] };
    assert.deepEqual((await names('/anime?show=films')).sort(), [
      'American',
      'Japanese',
      'Untagged',
    ]);
    assert.deepEqual(lookedUp, [], 'nothing is left out, so nothing to ask');

    getSettings().main.animeExcludedCountries = ['US'];
    answer(
      page([
        film(201, 'American', 'en'),
        film(202, 'Japanese', 'ja'),
        film(204, 'French', 'fr'),
      ]),
      page([film(203, 'Untagged', 'ja')])
    );
    filmCountries = { 201: ['US'], 204: ['FR'] };
    assert.deepEqual((await names('/anime?show=films')).sort(), [
      'French',
      'Japanese',
      'Untagged',
    ]);
    assert.deepEqual(lookedUp.sort(), [201, 204]);
  });

  it('narrow to where a title was made', async () => {
    const res = await get('/anime?show=popular&country=kr');
    assert.equal(res.status, 200);
    assert.deepEqual(
      searched.map((one) => one.originCountry),
      ['KR', 'KR']
    );
  });

  it('leave out a series an admin has said is not anime', async () => {
    answer(page([series(101, 'Kept'), series(102, 'Not anime')]), page([]));
    await getRepository(Media).save(
      new Media({
        tmdbId: 102,
        mediaType: MediaType.TV,
        status: MediaStatus.UNKNOWN,
        animeSetting: false,
      })
    );
    assert.deepEqual(await names('/anime?show=popular'), ['Kept']);
  });

  it('refuse a season, list or country it does not know', async () => {
    assert.equal((await get('/anime?season=2026-autumn')).status, 400);
    assert.equal((await get('/anime?show=winter')).status, 400);
    assert.equal((await get('/anime?country=Japan')).status, 400);
    assert.equal(searched.length, 0);
  });
});

describe('leaving out streaming services', () => {
  const services = () =>
    searched.map(
      ({ kind, watchRegion, watchProviders, excludeWatchProviders }) => ({
        kind,
        watchRegion,
        watchProviders,
        excludeWatchProviders,
      })
    );

  it('asks for films and series not on the services left out', async () => {
    for (const kind of ['movies', 'tv']) {
      const res = await get(
        `/${kind}?watchRegion=US&watchProviders=8&excludeWatchProviders=337|350`
      );
      assert.equal(res.status, 200);
    }
    assert.deepEqual(services(), [
      {
        kind: 'movie',
        watchRegion: 'US',
        watchProviders: '8',
        excludeWatchProviders: '337|350',
      },
      {
        kind: 'tv',
        watchRegion: 'US',
        watchProviders: '8',
        excludeWatchProviders: '337|350',
      },
    ]);
  });

  it('can leave out services without choosing any to show', async () => {
    // A comma has to be written %2C in an address.
    const res = await get('/movies?watchRegion=GB&excludeWatchProviders=8%2C9');
    assert.equal(res.status, 200);
    assert.deepEqual(services(), [
      {
        kind: 'movie',
        watchRegion: 'GB',
        watchProviders: undefined,
        excludeWatchProviders: '8|9',
      },
    ]);
  });

  it('keeps a service that is both shown and left out shown', async () => {
    await get(
      '/tv?watchRegion=US&watchProviders=8|9&excludeWatchProviders=9|8'
    );
    assert.equal(services()[0].excludeWatchProviders, undefined);
    await get('/tv?watchRegion=US&watchProviders=8&excludeWatchProviders=8|9');
    assert.equal(services()[1].excludeWatchProviders, '9');
  });

  it('leaves nothing out when not asked, as before', async () => {
    await get('/movies?watchRegion=US&watchProviders=8|9');
    assert.deepEqual(services(), [
      {
        kind: 'movie',
        watchRegion: 'US',
        watchProviders: '8|9',
        excludeWatchProviders: undefined,
      },
    ]);
  });

  it('refuses services that are not TMDB ids', async () => {
    for (const bad of ['netflix', '8|', '8;9', '-8', '']) {
      const res = await get(
        `/movies?watchRegion=US&excludeWatchProviders=${encodeURIComponent(bad)}`
      );
      assert.equal(res.status, 400, bad);
    }
    assert.equal(searched.length, 0);
  });
});
