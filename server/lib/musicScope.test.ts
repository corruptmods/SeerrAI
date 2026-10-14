import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import { NotificationDelivery } from '@server/entity/NotificationDelivery';
import { User } from '@server/entity/User';
import { forgetRecentActivity, recentActivity } from '@server/lib/ai/context';
import { NoArrServerError, removeFromArr } from '@server/lib/arrRemoval';
import availabilitySync from '@server/lib/availabilitySync';
import { runHealthCheck, searchableStuckTitles } from '@server/lib/health';
import notificationReconciler from '@server/lib/notificationReconciler';
import { NotInServiceError, searchMissing } from '@server/lib/searchMissing';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { JellyfinWatchSource } from '@server/lib/watchHistory/jellyfin';
import { TautulliWatchSource } from '@server/lib/watchHistory/tautulli';
import mediaRoutes from '@server/routes/media';
import requestRoutes from '@server/routes/request';
import { setupTestDb } from '@server/test/db';
import type { MusicFixtures } from '@server/utils/seedTestDb';
import { seedMusicFixtures } from '@server/utils/seedTestDb';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

/*
 * An artist is a Media row of type music with tmdbId 0. Everything that
 * goes through titles in bulk for films and series (TMDB, Radarr, Sonarr,
 * the media servers' video libraries) must never see one: looking it up as
 * series 0, or reading its Lidarr ids as Sonarr's, would be wrong at best.
 *
 * Each job and route below runs with music in the database. TMDB answers
 * but records what it was asked; Sonarr records too; the network is
 * blocked. Nothing may ask about a music title, and no music row may change.
 */

setupTestDb();

const tmdbAsked: { kind: string; id: number }[] = [];
const sonarrAsked: string[] = [];

const stubPrototype = (
  proto: object,
  name: string,
  impl: (...args: never[]) => unknown
) =>
  // The clients assign their methods in their constructors, so the stub
  // needs a setter that swallows that write.
  Object.defineProperty(proto, name, {
    configurable: true,
    set() {},
    get() {
      return impl;
    },
  });

stubPrototype(TheMovieDb.prototype, 'getMovie', async ({ movieId }) => {
  tmdbAsked.push({ kind: 'movie', id: movieId });
  return { id: movieId, title: 'A Film', release_date: '2020-01-01' };
});
stubPrototype(TheMovieDb.prototype, 'getTvShow', async ({ tvId }) => {
  tmdbAsked.push({ kind: 'tv', id: tvId });
  return { id: tvId, name: 'A Series', first_air_date: '2020-01-01' };
});
// What the request list asks every Sonarr, music or not.
stubPrototype(SonarrAPI.prototype, 'getProfiles', async () => []);
for (const name of ['getSeriesByTvdbId', 'getEpisodes', 'removeSeries']) {
  stubPrototype(SonarrAPI.prototype, name, async () => {
    sonarrAsked.push(name);
    throw new Error('Sonarr must not be asked about music');
  });
}

const app = express();
app.use(express.json());
app.use(
  OpenApiValidator.middleware({
    apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
    validateRequests: true,
    validateSecurity: false,
  })
);
let actor: User;
app.use((req, _res, next) => {
  (req as unknown as { user: User }).user = actor;
  next();
});
app.use('/api/v1/media', mediaRoutes);
app.use('/api/v1/request', requestRoutes);
app.use(
  (
    err: { status?: number; message: string },
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction
  ) => {
    res.status(err.status ?? 500).json({ message: err.message });
  }
);

/** Every music row, as it is stored. */
const musicRows = async () => ({
  media: await getRepository(Media).find({
    where: { mediaType: MediaType.MUSIC },
    order: { id: 'ASC' },
  }),
  albums: await getRepository(MusicAlbum).find({ order: { id: 'ASC' } }),
  requests: await getRepository(MediaRequest).find({
    where: { type: MediaType.MUSIC },
    order: { id: 'ASC' },
  }),
  albumRequests: await getRepository(AlbumRequest).find({
    order: { id: 'ASC' },
  }),
});

const SONARR: SonarrSettings = {
  id: 0,
  name: 'Sonarr',
  hostname: 'sonarr.local',
  port: 8989,
  apiKey: 'key',
  useSsl: false,
  activeProfileId: 1,
  activeProfileName: 'Any',
  activeDirectory: '/tv',
  tags: [],
  is4k: false,
  isDefault: true,
  syncEnabled: false,
  preventSearch: false,
  tagRequests: false,
  overrideRule: [],
  seriesType: 'standard',
  animeSeriesType: 'anime',
  enableSeasonFolders: true,
  monitorNewItems: 'all',
};

describe('music stays out of film and series code', () => {
  let music: MusicFixtures;
  let before: Awaited<ReturnType<typeof musicRows>>;
  let series: Media;
  let seriesRequest: MediaRequest;

  beforeEach(async () => {
    tmdbAsked.length = 0;
    sonarrAsked.length = 0;
    forgetRecentActivity();
    getSettings().sonarr = [SONARR];

    music = await seedMusicFixtures();
    // A series beside it, so the checks below are seen to still work.
    series = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 1399,
        tvdbId: 121361,
        status: MediaStatus.AVAILABLE,
      })
    );
    seriesRequest = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.TV,
        status: MediaRequestStatus.FAILED,
        media: series,
        requestedBy: await getRepository(User).findOneByOrFail({ id: 2 }),
        seasons: [],
      })
    );
    actor = await getRepository(User).findOneByOrFail({ id: 1 });
    tmdbAsked.length = 0;
    before = await musicRows();
  });

  afterEach(async () => {
    getSettings().sonarr = [];
    // Nothing asked TMDB or Sonarr about music, and no music row changed.
    assert.deepEqual(
      tmdbAsked.filter((asked) => asked.id === 0),
      []
    );
    assert.deepEqual(sonarrAsked, []);
    assert.deepEqual(await musicRows(), before);
  });

  it('has music in the database to keep out', () => {
    assert.equal(music.artist.mediaType, MediaType.MUSIC);
    assert.equal(music.artist.tmdbId, 0);
    assert.equal(before.media.length, 2);
    assert.equal(before.albums.length, 4);
    assert.equal(before.requests.length, 5);
    assert.deepEqual(
      before.requests.map((r) => r.albums.length),
      [1, 1, 1, 1, 1]
    );
  });

  it('availability sync only goes through films and series', async () => {
    const loader = (
      availabilitySync as unknown as {
        loadAvailableMediaPaginated(size: number): AsyncGenerator<Media>;
      }
    ).loadAvailableMediaPaginated(50);
    const seen: Media[] = [];
    for await (const media of loader) {
      seen.push(media);
    }
    assert.deepEqual(
      seen.map((m) => m.id),
      [series.id]
    );
  });

  it('Health lists only films’ and series’ requests and titles', async () => {
    const failed = await runHealthCheck('failedRequests', 1);
    assert.deepEqual(
      failed?.items.map((item) => item.href),
      [`/tv/${series.tmdbId}`]
    );
    for (const id of ['neverSent', 'awaitingApproval', 'stuckProcessing']) {
      const check = await runHealthCheck(id, 1);
      assert.equal(check?.count, 0, id);
    }
    assert.deepEqual(await searchableStuckTitles(), []);
  });

  it('notification catch-up leaves music requests alone', async () => {
    await notificationReconciler.run();
    const musicIds = before.requests.map((r) => r.id);
    const deliveries = await getRepository(NotificationDelivery).find();
    assert.deepEqual(
      deliveries.filter((d) => musicIds.includes(d.requestId)),
      []
    );
    assert.ok(deliveries.some((d) => d.requestId === seriesRequest.id));
  });

  it('AI context only names film and series requests', async () => {
    const user = await getRepository(User).findOneByOrFail({ id: 2 });
    const activity = await recentActivity(user);
    assert.equal(activity.source, 'requested');
    assert.deepEqual(
      activity.items.map((item) => item.name),
      ['A Series (series)']
    );
  });

  it('watch history never takes an artist’s server id for a title', async () => {
    const tautulli = new TautulliWatchSource({});
    assert.equal((await tautulli.mediaFor(['9001', '9002'])).size, 0);
    const jellyfin = new JellyfinWatchSource(
      'jellyfin',
      'key',
      'http://localhost:1'
    );
    assert.equal((await jellyfin.mediaFor(['jellyfin-artist'])).size, 0);
    const emby = new JellyfinWatchSource('emby', 'key', 'http://localhost:1');
    assert.equal((await emby.mediaFor(['emby-artist'])).size, 0);
  });

  it('Radarr and Sonarr are never asked to search or remove music', async () => {
    await assert.rejects(searchMissing(music.artist, false), NotInServiceError);
    await assert.rejects(removeFromArr(music.artist, false), NoArrServerError);
  });

  it('GET /media lists films and series unless music is asked for', async () => {
    const all = await request(app).get('/api/v1/media');
    assert.equal(all.status, 200);
    assert.deepEqual(
      all.body.results.map((m: Media) => m.id),
      [series.id]
    );

    const added = await request(app).get('/api/v1/media?sort=mediaAdded');
    assert.equal(added.status, 200);
    assert.ok(
      added.body.results.every((m: Media) => m.mediaType !== MediaType.MUSIC)
    );

    const onlyMusic = await request(app).get('/api/v1/media?mediaType=music');
    assert.equal(onlyMusic.status, 200);
    assert.equal(onlyMusic.body.results.length, 2);
  });

  it('GET /request lists films and series unless music is asked for', async () => {
    const all = await request(app).get('/api/v1/request');
    assert.equal(all.status, 200);
    assert.deepEqual(
      all.body.results.map((r: MediaRequest) => r.id),
      [seriesRequest.id]
    );

    const both = await request(app).get('/api/v1/request?mediaType=movie%2Ctv');
    assert.equal(both.body.results.length, 1);

    const onlyMusic = await request(app).get('/api/v1/request?mediaType=music');
    assert.equal(onlyMusic.status, 200);
    assert.equal(onlyMusic.body.results.length, 5);
  });

  it('GET /request/count counts music on its own', async () => {
    const res = await request(app).get('/api/v1/request/count');
    assert.equal(res.status, 200);
    assert.equal(res.body.music, 5);
    assert.equal(res.body.tv, 1);
    assert.equal(res.body.movie, 0);
  });
});
