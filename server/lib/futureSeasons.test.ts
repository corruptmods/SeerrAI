import TheMovieDb from '@server/api/themoviedb';
import type { TmdbTvDetails } from '@server/api/themoviedb/interfaces';
import { getRepository } from '@server/datasource';
import FutureSeasonSubscription from '@server/entity/FutureSeasonSubscription';
import {
  DuplicateMediaRequestError,
  MediaRequest,
  QuotaRestrictedError,
  RequestPermissionError,
} from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import futureSeasons, {
  dueSeasons,
  firstFutureSeason,
  subscribe,
} from '@server/lib/futureSeasons';
import tvRoutes from '@server/routes/tv';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * "Future seasons only": which seasons count as future, the scheduled check
 * that requests each as it premieres, and the routes behind the series page
 * button, through the real API validator.
 */

// The real time: following a series goes by the clock, so the seasons'
// dates are set from today, not from a fixed day that would pass.
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const date = (offsetDays: number) =>
  new Date(NOW + offsetDays * DAY).toISOString().slice(0, 10);

type Season = { season_number: number; air_date: string | null };
const shows = new Map<number, { status: string; seasons: Season[] }>();
let lookups: number[] = [];

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  configurable: true,
  set() {},
  get() {
    return async ({ tvId }: { tvId: number }) => {
      lookups.push(tvId);
      const show = shows.get(tvId);
      if (!show) {
        throw new Error('not found');
      }
      return {
        id: tvId,
        name: `Show ${tvId}`,
        status: show.status,
        seasons: show.seasons,
        external_ids: { tvdb_id: tvId * 10 },
      };
    };
  },
});

let requests: { mediaId: number; seasons: unknown; userId: number }[] = [];
let requestError: Error | null = null;
Object.defineProperty(MediaRequest, 'request', {
  configurable: true,
  writable: true,
  value: async (
    body: { mediaId: number; seasons: unknown },
    user: User,
    options: { isAutoRequest?: boolean }
  ) => {
    assert.equal(options.isAutoRequest, true, 'requested as automatic');
    requests.push({
      mediaId: body.mediaId,
      seasons: body.seasons,
      userId: user.id,
    });
    if (requestError) {
      throw requestError;
    }
    return {} as MediaRequest;
  },
});

setupTestDb();

beforeEach(() => {
  shows.clear();
  lookups = [];
  requests = [];
  requestError = null;
  // Seasons 1 and 2 are out, 3 is announced for next month.
  shows.set(100, {
    status: 'Returning Series',
    seasons: [
      { season_number: 0, air_date: date(-900) },
      { season_number: 1, air_date: date(-700) },
      { season_number: 2, air_date: date(-300) },
      { season_number: 3, air_date: date(30) },
    ],
  });
});

const user = (email: string) =>
  getRepository(User).findOneOrFail({ where: { email } });
const subscriptions = () =>
  getRepository(FutureSeasonSubscription).find({
    relations: { user: true },
  });
const premiere = (tmdbId: number, season: number, offsetDays: number) => {
  const show = shows.get(tmdbId);
  const entry = show?.seasons.find((s) => s.season_number === season);
  if (entry) {
    entry.air_date = date(offsetDays);
  } else {
    show?.seasons.push({ season_number: season, air_date: date(offsetDays) });
  }
};

describe('which seasons are future', () => {
  const show = (seasons: Season[]) =>
    ({ seasons }) as unknown as Pick<TmdbTvDetails, 'seasons'>;

  it('starts one past the latest season already out', () => {
    assert.equal(
      firstFutureSeason(
        show([
          { season_number: 1, air_date: date(-100) },
          { season_number: 2, air_date: date(-5) },
          { season_number: 3, air_date: null },
        ]),
        NOW
      ),
      3
    );
  });

  it('counts a season still airing as out, and ignores specials', () => {
    assert.equal(
      firstFutureSeason(
        show([
          { season_number: 0, air_date: date(10) },
          { season_number: 1, air_date: date(-3) },
        ]),
        NOW
      ),
      2
    );
  });

  it('starts at season 1 for a series not out yet', () => {
    assert.equal(
      firstFutureSeason(show([{ season_number: 1, air_date: date(20) }]), NOW),
      1
    );
  });

  it('is due within a day of its premiere, not before, and not undated', () => {
    const seasons = show([
      { season_number: 3, air_date: date(0) },
      { season_number: 4, air_date: date(2) },
      { season_number: 5, air_date: null },
    ]);
    assert.deepEqual(dueSeasons(seasons, 3, NOW), [3]);
    assert.deepEqual(dueSeasons(seasons, 4, NOW - 2 * DAY), []);
    assert.deepEqual(dueSeasons(seasons, 4, NOW + 1.5 * DAY), [4]);
  });
});

describe('the scheduled check', () => {
  it('requests a season for its follower once it premieres, and only once', async () => {
    const friend = await user('friend@seerr.dev');
    const subscription = await subscribe(friend, 100);
    assert.equal(subscription.fromSeason, 3);

    await futureSeasons.run(NOW);
    assert.deepEqual(requests, [], 'nothing before the premiere');

    premiere(100, 3, 0);
    await futureSeasons.run(NOW);
    assert.deepEqual(requests, [
      { mediaId: 100, seasons: [3], userId: friend.id },
    ]);
    assert.equal((await subscriptions())[0].fromSeason, 4);

    await futureSeasons.run(NOW + DAY);
    assert.equal(requests.length, 1, 'not asked for again');
  });

  it('tries again later when over quota', async () => {
    await subscribe(await user('friend@seerr.dev'), 100);
    premiere(100, 3, 0);

    requestError = new QuotaRestrictedError('Series Quota exceeded.');
    await futureSeasons.run(NOW);
    assert.equal((await subscriptions())[0].fromSeason, 3);

    requestError = null;
    await futureSeasons.run(NOW);
    assert.equal(requests.length, 2);
    assert.equal((await subscriptions())[0].fromSeason, 4);
  });

  it('moves on when the season was already requested by anyone', async () => {
    await subscribe(await user('friend@seerr.dev'), 100);
    premiere(100, 3, 0);
    requestError = new DuplicateMediaRequestError('Request already exists.');

    await futureSeasons.run(NOW);
    assert.equal((await subscriptions())[0].fromSeason, 4);
  });

  it('stops for someone who can no longer request series', async () => {
    const friend = await user('friend@seerr.dev');
    await subscribe(friend, 100);
    premiere(100, 3, 0);

    requestError = new RequestPermissionError('No permission.');
    await futureSeasons.run(NOW);
    assert.equal((await subscriptions()).length, 0);
  });

  it('does not request for someone whose permission was taken away', async () => {
    const friend = await user('friend@seerr.dev');
    await subscribe(friend, 100);
    await getRepository(User).update(friend.id, { permissions: 0 });
    premiere(100, 3, 0);

    await futureSeasons.run(NOW);
    assert.deepEqual(requests, []);
    assert.equal((await subscriptions()).length, 0);
  });

  it('lets go of a finished series with nothing left to come', async () => {
    await subscribe(await user('friend@seerr.dev'), 100);
    premiere(100, 3, 0);
    shows.get(100)!.status = 'Ended';

    await futureSeasons.run(NOW);
    assert.equal(requests.length, 1, 'the last season still comes');
    assert.equal((await subscriptions()).length, 0);
  });

  it('looks each series up once however many people follow it', async () => {
    const friend = await user('friend@seerr.dev');
    const admin = await user('admin@seerr.dev');
    await subscribe(friend, 100);
    await subscribe(admin, 100);
    premiere(100, 3, 0);
    lookups = [];

    await futureSeasons.run(NOW);
    assert.deepEqual(lookups, [100]);
    assert.deepEqual(requests.map((r) => r.userId).sort(), [
      admin.id,
      friend.id,
    ]);
  });
});

describe('/tv/{tvId}/future-seasons', () => {
  let app: Server;
  let port: number;
  let signedIn = 'friend@seerr.dev';

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
    ex.use(async (req, _res, next) => {
      (req as unknown as { user: User }).user = await user(signedIn);
      next();
    });
    ex.use('/api/v1/tv', tvRoutes);
    ex.use(
      (
        err: { status?: number; message?: string },
        _req: express.Request,
        res: express.Response,
        // Express knows an error handler by its four parameters.
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
  after(() => app?.close());
  beforeEach(() => {
    signedIn = 'friend@seerr.dev';
  });

  const call = async (method: string, tmdbId = 100) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/v1/tv/${tmdbId}/future-seasons`,
      { method }
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };

  it('follows, reports, and stops', async () => {
    assert.deepEqual((await call('GET')).body, { following: false });

    const followed = await call('POST');
    assert.equal(followed.status, 201);
    assert.deepEqual(followed.body, { following: true, fromSeason: 3 });
    assert.deepEqual((await call('GET')).body, {
      following: true,
      fromSeason: 3,
    });

    assert.equal((await call('POST')).status, 201, 'following twice is fine');
    assert.equal((await subscriptions()).length, 1);

    assert.equal((await call('DELETE')).status, 204);
    assert.deepEqual((await call('GET')).body, { following: false });
  });

  it('refuses a series that has ended', async () => {
    shows.get(100)!.status = 'Ended';
    const res = await call('POST');
    assert.equal(res.status, 400);
    assert.equal((await subscriptions()).length, 0);
  });

  it('refuses someone who cannot request series', async () => {
    const friend = await user('friend@seerr.dev');
    await getRepository(User).update(friend.id, { permissions: 0 });
    assert.equal((await call('POST')).status, 403);
  });
});
