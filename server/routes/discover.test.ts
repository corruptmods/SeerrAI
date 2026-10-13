import TheMovieDb from '@server/api/themoviedb';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import discoverRoutes from '@server/routes/discover';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * The studio and network pages list titles for the person looking, so they
 * follow that person's Discover region and original language like every
 * other Discover page.
 */

setupTestDb();

// What the TMDB client each route made was set up with, per call.
let asked: { region?: string; language?: string }[] = [];
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
stub('getDiscoverMovies', async function (this: TheMovieDb) {
  asked.push(settingsOf(this));
  return emptyPage;
});
stub('getDiscoverTv', async function (this: TheMovieDb) {
  asked.push(settingsOf(this));
  return emptyPage;
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
