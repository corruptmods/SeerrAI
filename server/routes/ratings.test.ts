import IMDBGraphQL from '@server/api/rating/imdbGraphql';
import IMDBRadarrProxy from '@server/api/rating/imdbRadarrProxy';
import RottenTomatoes from '@server/api/rating/rottentomatoes';
import TheMovieDb from '@server/api/themoviedb';
import movieRoutes from '@server/routes/movie';
import tvRoutes from '@server/routes/tv';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * The combined ratings on a title page: Rotten Tomatoes and IMDb are asked
 * separately, and one of them being down must not hide the other.
 */

setupTestDb();

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async () => ({
      id: 1,
      title: 'Test Film',
      release_date: '2020-05-01',
      imdb_id: 'tt0000001',
    });
  },
});
Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  configurable: true,
  set() {},
  get() {
    return async () => ({
      id: 2,
      name: 'Test Series',
      first_air_date: '2019-01-01',
      external_ids: { imdb_id: 'tt0000002' },
    });
  },
});

const rt = {
  title: 'Test',
  year: 2020,
  criticsRating: 'Fresh' as const,
  criticsScore: 90,
  url: 'https://www.rottentomatoes.com/m/test',
};
const imdb = {
  title: 'Test',
  url: 'https://www.imdb.com/title/tt0000001',
  criticsScore: 7.5,
  criticsScoreCount: 1000,
};

// Each source either answers, has nothing, or is down.
let rtAnswer: () => Promise<typeof rt | null>;
let imdbAnswer: () => Promise<typeof imdb | null>;
const down = () => Promise.reject(new Error('503 Service Unavailable'));

RottenTomatoes.prototype.getMovieRatings = () => rtAnswer();
RottenTomatoes.prototype.getTVRatings = () => rtAnswer();
IMDBRadarrProxy.prototype.getMovieRatings = () => imdbAnswer();
IMDBGraphQL.prototype.getRatings = () => imdbAnswer();

let app: Server;
let port: number;

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
  ex.use('/api/v1/movie', movieRoutes);
  ex.use('/api/v1/tv', tvRoutes);
  ex.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status ?? 500).json({ message: err.message });
    }
  );
  app = await new Promise<Server>((resolve) => {
    const s = ex.listen(0, () => resolve(s));
  });
  port = (app.address() as { port: number }).port;
});
after(() => {
  app?.close();
});

beforeEach(() => {
  rtAnswer = async () => rt;
  imdbAnswer = async () => imdb;
});

const get = async (url: string) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${url}`);
  return { status: res.status, body: await res.json() };
};

for (const [kind, url] of [
  ['film', '/movie/1/ratingscombined'],
  ['series', '/tv/2/ratingscombined'],
] as const) {
  describe(`combined ratings for a ${kind}`, () => {
    it('has both when both answer', async () => {
      assert.deepEqual(await get(url), {
        status: 200,
        body: { rt, imdb },
      });
    });

    it('still has IMDb when Rotten Tomatoes is down', async () => {
      rtAnswer = down;
      assert.deepEqual(await get(url), { status: 200, body: { imdb } });
    });

    it('still has Rotten Tomatoes when IMDb is down', async () => {
      imdbAnswer = down;
      assert.deepEqual(await get(url), { status: 200, body: { rt } });
    });

    it('has none, not an error page, when neither has anything', async () => {
      rtAnswer = down;
      imdbAnswer = async () => null;
      assert.equal((await get(url)).status, 404);
    });
  });
}
