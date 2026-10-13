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
 * other Discover page. The Anime pages follow their region, and are always
 * Japanese animation, the way Seerr tells anime apart (utils/isAnime).
 */

setupTestDb();

// What the TMDB client each route made was set up with, per call.
let asked: { region?: string; language?: string }[] = [];
// What each discover call asked TMDB for.
let searched: ({ kind: 'movie' | 'tv' } & Record<string, unknown>)[] = [];
// The page TMDB answers with.
let tmdbPage: {
  page: number;
  total_pages: number;
  total_results: number;
  results: unknown[];
};
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
    return tmdbPage;
  }
);
stub(
  'getDiscoverTv',
  async function (this: TheMovieDb, options: Record<string, unknown>) {
    asked.push(settingsOf(this));
    searched.push({ kind: 'tv', ...options });
    return tmdbPage;
  }
);

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
  const series = (id: number, name: string) => ({
    id,
    name,
    original_name: name,
    original_language: 'ja',
    origin_country: ['JP'],
    genre_ids: [16],
    overview: '',
    popularity: 10,
    first_air_date: '2026-10-04',
    vote_average: 8,
    vote_count: 100,
    backdrop_path: null,
    poster_path: null,
  });

  it('list the series airing in a season', async () => {
    const res = await get('/anime?show=airing&season=2026-fall');
    assert.equal(res.status, 200);
    assert.equal(searched.length, 1);
    const [asked0] = searched;
    assert.equal(asked0.kind, 'tv');
    assert.equal(asked0.genre, '16');
    assert.equal(asked0.originalLanguage, 'ja');
    assert.equal(asked0.airDateGte, '2026-10-01');
    assert.equal(asked0.airDateLte, '2026-12-31');
    assert.equal(asked0.firstAirDateGte, undefined);
    assert.equal(asked0.firstAirDateLte, undefined);
    assert.equal(asked0.sortBy, 'popularity.desc');
  });

  it('list the series premiering in a season', async () => {
    const res = await get('/anime?show=premieres&season=2027-winter');
    assert.equal(res.status, 200);
    const [asked0] = searched;
    assert.equal(asked0.kind, 'tv');
    assert.equal(asked0.firstAirDateGte, '2027-01-01');
    assert.equal(asked0.firstAirDateLte, '2027-03-31');
    assert.equal(asked0.airDateGte, undefined);
    assert.equal(asked0.airDateLte, undefined);
  });

  it('show what is airing this season when nothing is chosen', async () => {
    const res = await get('/anime');
    assert.equal(res.status, 200);
    const { start, end } = seasonDates(seasonOf(new Date()));
    assert.equal(searched[0].airDateGte, start);
    assert.equal(searched[0].airDateLte, end);
  });

  it('list the most popular series of any season', async () => {
    await get('/anime?show=popular');
    const [asked0] = searched;
    assert.equal(asked0.kind, 'tv');
    assert.equal(asked0.genre, '16');
    assert.equal(asked0.originalLanguage, 'ja');
    assert.equal(asked0.airDateGte, undefined);
    assert.equal(asked0.firstAirDateGte, undefined);
  });

  it('list films', async () => {
    await get('/anime?show=films');
    const [asked0] = searched;
    assert.equal(asked0.kind, 'movie');
    assert.equal(asked0.genre, '16');
    assert.equal(asked0.originalLanguage, 'ja');
  });

  it("follow the person's region, whatever their Discover Language", async () => {
    actingAs.settings!.originalLanguage = 'en';
    await get('/anime?show=popular');
    assert.deepEqual(asked, [{ region: 'GB', language: 'en' }]);
    assert.equal(searched[0].originalLanguage, 'ja');
  });

  it('leave out a series an admin has said is not anime', async () => {
    tmdbPage = {
      page: 1,
      total_pages: 1,
      total_results: 2,
      results: [series(101, 'Kept'), series(102, 'Not anime')],
    };
    await getRepository(Media).save(
      new Media({
        tmdbId: 102,
        mediaType: MediaType.TV,
        status: MediaStatus.UNKNOWN,
        animeSetting: false,
      })
    );
    const res = await get('/anime?show=popular');
    const body = (await res.json()) as { results: { name: string }[] };
    assert.deepEqual(
      body.results.map((r) => r.name),
      ['Kept']
    );
  });

  it('refuse a season or list it does not know', async () => {
    assert.equal((await get('/anime?season=2026-autumn')).status, 400);
    assert.equal((await get('/anime?show=winter')).status, 400);
    assert.equal(searched.length, 0);
  });
});
