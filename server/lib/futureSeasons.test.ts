import SonarrAPI from '@server/api/servarr/sonarr';
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
  nextSeason,
  seasonsToRequest,
  subscribe,
} from '@server/lib/futureSeasons';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import { getSettings } from '@server/lib/settings';
import tvRoutes from '@server/routes/tv';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import path from 'node:path';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';

/*
 * "Future seasons only": which seasons count as future, the scheduled check
 * requesting each once announced (when Sonarr lists it) or on premiere, what
 * followers are told, and the series page routes, via the real API validator.
 */

// Following uses the real clock, so season dates are set relative to today.
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const date = (offsetDays: number) =>
  new Date(NOW + offsetDays * DAY).toISOString().slice(0, 10);

type Season = { season_number: number; air_date: string | null };
const shows = new Map<
  number,
  { status: string; seasons: Season[]; name?: string }
>();
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
        name: show.name ?? `Show ${tvId}`,
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

  it('shows the series followed to everyone, and who only to managers', async () => {
    assert.equal((await call('POST')).status, 201);
    const friend = await user('friend@seerr.dev');
    assert.deepEqual(
      (await call('GET')).body,
      { following: true, fromSeason: 3 },
      'their own follow, and nobody else'
    );

    signedIn = 'admin@seerr.dev';
    assert.deepEqual((await call('GET')).body, {
      following: false,
      othersFollow: true,
      othersFrom: 3,
      others: [friend.displayName],
    });
    assert.deepEqual(
      (await call('GET', 200)).body,
      { following: false },
      'nobody follows another series'
    );

    // Users who don't manage requests see that it's coming, not for whom.
    await subscribe(await user('admin@seerr.dev'), 100);
    signedIn = 'friend@seerr.dev';
    await getRepository(FutureSeasonSubscription).delete({
      user: { id: friend.id },
    });
    assert.deepEqual((await call('GET')).body, {
      following: false,
      othersFollow: true,
      othersFrom: 3,
    });
  });

  it('stops it for everyone only for a manager', async () => {
    await subscribe(await user('friend@seerr.dev'), 100);
    await subscribe(await user('admin@seerr.dev'), 100);

    const everyone = async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/v1/tv/100/future-seasons?everyone=true`,
        { method: 'DELETE' }
      );
      return res.status;
    };
    assert.equal(await everyone(), 403);
    assert.equal((await subscriptions()).length, 2);

    signedIn = 'admin@seerr.dev';
    assert.equal(await everyone(), 204);
    assert.equal((await subscriptions()).length, 0);
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

describe('which seasons to request now', () => {
  const show = (status: string, seasons: Season[]) =>
    ({ status, seasons }) as unknown as Pick<
      TmdbTvDetails,
      'seasons' | 'status'
    >;

  it('takes announced seasons Sonarr lists, dated or not', () => {
    const series = show('Returning Series', [
      { season_number: 3, air_date: date(60) },
      { season_number: 4, air_date: null },
    ]);
    assert.deepEqual(seasonsToRequest(series, 3, new Set([3, 4]), NOW), [3, 4]);
    assert.deepEqual(seasonsToRequest(series, 3, undefined, NOW), []);
  });

  it('requests a due season past one that waits, and stays at the one waiting', () => {
    const series = show('Returning Series', [
      { season_number: 5, air_date: null },
      { season_number: 6, air_date: date(0) },
    ]);
    assert.deepEqual(seasonsToRequest(series, 5, new Set([6]), NOW), [6]);
    assert.equal(nextSeason(series, 5, [6]), 5);
    assert.equal(nextSeason(series, 5, [5, 6]), 7);
  });

  it('never skips a season Sonarr does not list yet', () => {
    const series = show('Returning Series', [
      { season_number: 3, air_date: date(60) },
      { season_number: 4, air_date: date(400) },
    ]);
    assert.deepEqual(seasonsToRequest(series, 3, new Set([4]), NOW), []);
  });

  it('takes nothing early for a finished series, only what premieres', () => {
    const series = show('Ended', [
      { season_number: 3, air_date: date(0) },
      { season_number: 4, air_date: null },
    ]);
    assert.deepEqual(seasonsToRequest(series, 3, new Set([3, 4]), NOW), [3]);
  });

  it('leaves specials out', () => {
    const series = show('Returning Series', [
      { season_number: 0, air_date: null },
    ]);
    assert.deepEqual(seasonsToRequest(series, 0, new Set([0]), NOW), []);
  });
});

describe('announced seasons and what followers are told', () => {
  // TheTVDB's seasons, as the Sonarr lookup gives them, and Sonarr's own
  // copy once it has the series.
  let tvdbSeasons: number[] = [];
  let librarySeasons: number[] | undefined;
  let sonarrDown = false;
  let sonarrLookups = 0;
  let notices: { type: Notification; payload: NotificationPayload }[] = [];

  beforeEach(() => {
    tvdbSeasons = [1, 2];
    librarySeasons = undefined;
    sonarrDown = false;
    sonarrLookups = 0;
    notices = [];
    getSettings().sonarr = [
      {
        id: 0,
        name: 'Sonarr',
        hostname: 'sonarr.test',
        port: 8989,
        apiKey: 'k',
        useSsl: false,
        is4k: false,
        isDefault: true,
      } as never,
    ];
    shows.set(300, {
      name: 'Glasswing',
      status: 'Returning Series',
      seasons: [
        { season_number: 0, air_date: null },
        { season_number: 1, air_date: date(-700) },
        { season_number: 2, air_date: date(-300) },
      ],
    });
    const seasonsOf = (numbers: number[]) =>
      numbers.map((seasonNumber) => ({ seasonNumber, monitored: false }));
    mock.method(SonarrAPI.prototype, 'getLibrarySeriesByTvdbId', async () => {
      sonarrLookups++;
      if (sonarrDown) {
        throw new Error('connect ECONNREFUSED');
      }
      return librarySeasons
        ? [{ id: 7, seasons: seasonsOf(librarySeasons) }]
        : [];
    });
    mock.method(SonarrAPI.prototype, 'getSeriesByTvdbId', async () => ({
      seasons: seasonsOf(tvdbSeasons),
    }));
    mock.method(
      notificationManager,
      'sendNotification',
      (type: Notification, payload: NotificationPayload) => {
        notices.push({ type, payload });
      }
    );
  });
  afterEach(() => {
    mock.restoreAll();
    getSettings().sonarr = [];
  });

  const renew = (season: number, airDate: string | null) =>
    shows.get(300)!.seasons.push({ season_number: season, air_date: airDate });
  const told = () =>
    notices.map(({ type, payload }) => {
      assert.equal(type, Notification.FOLLOWED_SERIES);
      assert.equal(payload.notifySystem, false, 'never a channel');
      assert.equal(payload.notifyAdmin, false, 'never the admins');
      return `${payload.notifyUser?.email}: ${payload.subject}. ${payload.message}`;
    });

  it('requests a renewed season once Sonarr lists it, then tells of its premiere', async () => {
    const friend = await user('friend@seerr.dev');
    assert.equal((await subscribe(friend, 300)).fromSeason, 3);

    renew(3, date(40));
    await futureSeasons.run(NOW);
    assert.deepEqual(requests, [], 'not before TheTVDB has it');
    assert.deepEqual(told(), [], 'nothing to tell yet');

    tvdbSeasons.push(3);
    await futureSeasons.run(NOW);
    assert.deepEqual(requests, [
      { mediaId: 300, seasons: [3], userId: friend.id },
    ]);
    assert.equal(told().length, 1);
    assert.match(
      told()[0],
      /^friend@seerr\.dev: Season 3 of Glasswing was announced\. It’s been requested for you\. It starts \w+ \d+, \d{4}\.$/
    );
    const [subscription] = await subscriptions();
    assert.equal(subscription.fromSeason, 4);
    assert.equal(subscription.premieredSeason, 2);

    notices = [];
    await futureSeasons.run(NOW + DAY);
    assert.equal(requests.length, 1, 'requested once');
    assert.deepEqual(told(), [], 'told once');

    premiere(300, 3, 0);
    await futureSeasons.run(NOW);
    assert.equal(requests.length, 1, 'not again at the premiere');
    assert.deepEqual(told(), [
      'friend@seerr.dev: Glasswing season 3 starts today. It was requested when it was announced.',
    ]);
    assert.equal((await subscriptions())[0].premieredSeason, 3);

    notices = [];
    await futureSeasons.run(NOW + DAY / 2);
    assert.deepEqual(told(), [], 'the premiere is told once');
  });

  it('waits for Sonarr’s own copy of a series it already has', async () => {
    const friend = await user('friend@seerr.dev');
    await subscribe(friend, 300);
    renew(3, date(40));
    tvdbSeasons.push(3);
    librarySeasons = [1, 2];

    await futureSeasons.run(NOW);
    assert.deepEqual(requests, [], 'Sonarr has not refreshed it yet');

    librarySeasons.push(3);
    await futureSeasons.run(NOW);
    assert.deepEqual(requests, [
      { mediaId: 300, seasons: [3], userId: friend.id },
    ]);
  });

  it('requests a season with no date or episodes yet', async () => {
    const friend = await user('friend@seerr.dev');
    await subscribe(friend, 300);
    renew(3, null);
    tvdbSeasons.push(3);

    await futureSeasons.run(NOW);
    assert.deepEqual(requests, [
      { mediaId: 300, seasons: [3], userId: friend.id },
    ]);
    assert.deepEqual(told(), [
      'friend@seerr.dev: Season 3 of Glasswing was announced. It’s been requested for you.',
    ]);
  });

  it('falls back to the premiere when Sonarr cannot be reached', async () => {
    const friend = await user('friend@seerr.dev');
    await subscribe(friend, 300);
    renew(3, date(10));
    tvdbSeasons.push(3);
    sonarrDown = true;

    await futureSeasons.run(NOW);
    assert.deepEqual(requests, []);

    premiere(300, 3, 0);
    await futureSeasons.run(NOW);
    assert.deepEqual(requests, [
      { mediaId: 300, seasons: [3], userId: friend.id },
    ]);
    assert.deepEqual(told(), [
      'friend@seerr.dev: Glasswing season 3 starts today. It’s been requested for you.',
    ]);
  });

  it('says so when someone else already asked for it', async () => {
    await subscribe(await user('friend@seerr.dev'), 300);
    renew(3, null);
    tvdbSeasons.push(3);
    requestError = new DuplicateMediaRequestError('Request already exists.');

    await futureSeasons.run(NOW);
    assert.deepEqual(told(), [
      'friend@seerr.dev: Season 3 of Glasswing was announced. It’s already been requested.',
    ]);
    assert.equal((await subscriptions())[0].fromSeason, 4);
  });

  it('tells nobody while over quota, and asks again later', async () => {
    await subscribe(await user('friend@seerr.dev'), 300);
    renew(3, null);
    tvdbSeasons.push(3);
    requestError = new QuotaRestrictedError('Series Quota exceeded.');

    await futureSeasons.run(NOW);
    assert.deepEqual(told(), []);
    assert.equal((await subscriptions())[0].fromSeason, 3);

    requestError = null;
    await futureSeasons.run(NOW);
    assert.equal(requests.length, 2);
    assert.equal(told().length, 1);
  });

  it('stops without a word for someone who can no longer request series', async () => {
    await subscribe(await user('friend@seerr.dev'), 300);
    renew(3, null);
    tvdbSeasons.push(3);
    requestError = new RequestPermissionError('No permission.');

    await futureSeasons.run(NOW);
    assert.deepEqual(told(), []);
    assert.equal((await subscriptions()).length, 0);
  });

  it('tells each follower apart, and asks Sonarr once', async () => {
    const friend = await user('friend@seerr.dev');
    const admin = await user('admin@seerr.dev');
    await subscribe(friend, 300);
    await subscribe(admin, 300);
    renew(3, null);
    tvdbSeasons.push(3);

    await futureSeasons.run(NOW);
    assert.equal(sonarrLookups, 1);
    assert.deepEqual(told().sort(), [
      'admin@seerr.dev: Season 3 of Glasswing was announced. It’s been requested for you.',
      'friend@seerr.dev: Season 3 of Glasswing was announced. It’s been requested for you.',
    ]);
    assert.deepEqual(
      notices.map((n) => n.payload.notifyUser?.id).sort(),
      [admin.id, friend.id].sort()
    );
  });

  it('announces a season once, however often TMDB takes it down and puts it back', async () => {
    const friend = await user('friend@seerr.dev');
    await subscribe(friend, 300);
    renew(3, null);
    tvdbSeasons.push(3);
    await futureSeasons.run(NOW);
    assert.equal(requests.length, 1);
    assert.equal(told().length, 1);

    for (let flap = 0; flap < 3; flap++) {
      shows.get(300)!.seasons.pop();
      await futureSeasons.run(NOW);
      renew(3, date(90));
      await futureSeasons.run(NOW);
    }
    assert.equal(requests.length, 1, 'not asked for again');
    assert.equal(told().length, 1, 'not announced again');
    assert.equal((await subscriptions())[0].fromSeason, 4);

    // Its premiere is still told.
    premiere(300, 3, 0);
    notices = [];
    await futureSeasons.run(NOW);
    assert.deepEqual(told(), [
      'friend@seerr.dev: Glasswing season 3 starts today. It was requested when it was announced.',
    ]);
  });

  it('requests a season that starts without skipping an earlier one still waiting', async () => {
    const friend = await user('friend@seerr.dev');
    await subscribe(friend, 300);
    // Season 3 is listed with no date and unknown to Sonarr; 4 starts today.
    renew(3, null);
    renew(4, date(0));

    await futureSeasons.run(NOW);
    assert.deepEqual(requests, [
      { mediaId: 300, seasons: [4], userId: friend.id },
    ]);
    assert.deepEqual(told(), [
      'friend@seerr.dev: Glasswing season 4 starts today. It’s been requested for you.',
    ]);
    const [waiting] = await subscriptions();
    assert.equal(waiting.fromSeason, 3, 'season 3 is still to come');
    assert.equal(waiting.premieredSeason, 4);

    // Asked again for 4 while 3 waits: already there, and nothing said.
    requestError = new DuplicateMediaRequestError('Request already exists.');
    notices = [];
    await futureSeasons.run(NOW + DAY / 4);
    assert.deepEqual(told(), []);
    assert.equal((await subscriptions())[0].fromSeason, 3);

    // Sonarr learns of season 3: it's requested and announced.
    requestError = null;
    tvdbSeasons.push(3);
    await futureSeasons.run(NOW + DAY / 2);
    assert.deepEqual(requests.at(-1), {
      mediaId: 300,
      seasons: [3, 4],
      userId: friend.id,
    });
    assert.deepEqual(told(), [
      'friend@seerr.dev: Season 3 of Glasswing was announced. It’s been requested for you.',
    ]);
    assert.equal((await subscriptions())[0].fromSeason, 5);
  });

  it('keeps following a finished series while its waiting season gets a date', async () => {
    const friend = await user('friend@seerr.dev');
    await subscribe(friend, 300);
    renew(3, null);
    renew(4, date(0));
    await futureSeasons.run(NOW);
    assert.equal((await subscriptions())[0].fromSeason, 3);

    shows.get(300)!.status = 'Ended';
    premiere(300, 3, 20);
    requestError = new DuplicateMediaRequestError('Request already exists.');
    notices = [];
    await futureSeasons.run(NOW + DAY / 2);
    assert.deepEqual(told(), [], 'season 3 is still to come');
    assert.equal((await subscriptions()).length, 1);

    requestError = null;
    await futureSeasons.run(NOW + 20 * DAY);
    assert.deepEqual(requests.at(-1)?.seasons, [3, 4]);
    assert.match(told().at(-1)!, /Glasswing has ended/);
    assert.equal((await subscriptions()).length, 0);
  });

  it('requests nothing early for a finished series and says it has ended', async () => {
    const friend = await user('friend@seerr.dev');
    await subscribe(friend, 300);
    // Ended with a season TMDB still lists but never dated.
    renew(3, null);
    tvdbSeasons.push(3);
    shows.get(300)!.status = 'Ended';

    await futureSeasons.run(NOW);
    assert.deepEqual(requests, []);
    assert.equal(sonarrLookups, 0);
    assert.deepEqual(told(), [
      'friend@seerr.dev: Glasswing has ended. No more seasons are coming, so you’re no longer following it.',
    ]);
    assert.equal((await subscriptions()).length, 0);

    notices = [];
    await futureSeasons.run(NOW);
    assert.deepEqual(told(), [], 'told once');
  });

  it('waits for a requested last season to start before saying it was cancelled', async () => {
    const friend = await user('friend@seerr.dev');
    await subscribe(friend, 300);
    renew(3, date(20));
    tvdbSeasons.push(3);
    await futureSeasons.run(NOW);
    assert.equal(requests.length, 1);

    shows.get(300)!.status = 'Canceled';
    notices = [];
    await futureSeasons.run(NOW);
    assert.deepEqual(told(), [], 'its last season is still to come');
    assert.equal((await subscriptions()).length, 1);

    premiere(300, 3, 0);
    await futureSeasons.run(NOW);
    assert.deepEqual(told(), [
      'friend@seerr.dev: Glasswing season 3 starts today. It was requested when it was announced.',
      'friend@seerr.dev: Glasswing was cancelled. No more seasons are coming, so you’re no longer following it.',
    ]);
    assert.equal((await subscriptions()).length, 0);
    assert.equal(requests.length, 1);
  });

  it('is quiet while the feature is off', async () => {
    const friend = await user('friend@seerr.dev');
    await subscribe(friend, 300);
    renew(3, null);
    tvdbSeasons.push(3);
    shows.get(300)!.status = 'Ended';
    const main = getSettings().main;
    const disabled = main.disabledFeatures;
    main.disabledFeatures = ['newSeasons'];
    try {
      await futureSeasons.run(NOW);
    } finally {
      main.disabledFeatures = disabled;
    }
    assert.deepEqual(told(), []);
    assert.equal((await subscriptions()).length, 1);
  });
});
