import type { LidarrAlbum } from '@server/api/servarr/lidarr';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import Media from '@server/entity/Media';
import MediaEvent, { MediaEventType } from '@server/entity/MediaEvent';
import { MediaRequest } from '@server/entity/MediaRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import { claimDelivery, hasDelivery } from '@server/lib/notificationDelivery';
import notificationReconciler from '@server/lib/notificationReconciler';
import { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings, musicDefaults } from '@server/lib/settings';
import requestRoutes from '@server/routes/request';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import type { LidarrCall } from '@server/test/fakeLidarr';
import { createFakeLidarr } from '@server/test/fakeLidarr';
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
import type { EntityManager } from 'typeorm';

/*
 * A request whose Radarr, Sonarr or Lidarr server was removed from Settings,
 * Services: it is marked failed rather than left approved, a request
 * manager can point it at another server, and Retry sends it to the default
 * server of its kind or says plainly that one has to be chosen. Through the
 * real OpenAPI validator, with a Lidarr on localhost for music.
 */

setupTestDb();

const ARTIST = '3c9e5f21-8d47-4b6a-a1e3-5f7d2c90b844';
const STATIC_GARDEN = '4f6a2d93-c1e8-3a57-9b02-6d3e8f1c7a40';

const lidarr = createFakeLidarr();

let app: Server;
let port = 0;
let actingAs: User;

const call = async (
  method: string,
  pathname: string,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${pathname}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
};

/** Someone with exactly these permissions, acting from now on. */
const actAs = async (permissions: number, email = 'manager@test.local') => {
  const repository = getRepository(User);
  const existing = await repository.findOneBy({ email });
  const user = existing ?? new User({ email, username: email, avatar: '' });
  user.permissions = permissions;
  actingAs = await repository.save(user);
  return actingAs;
};

const radarr = (id: number, overrides: Partial<RadarrSettings> = {}) =>
  ({
    id,
    name: `Radarr ${id}`,
    hostname: '127.0.0.1',
    port: 1,
    apiKey: 'k',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeProfileName: 'Any',
    activeDirectory: '/movies',
    is4k: false,
    minimumAvailability: 'released',
    tags: [],
    isDefault: false,
    syncEnabled: false,
    preventSearch: false,
    externalUrl: '',
    ...overrides,
  }) as RadarrSettings;

const sonarr = (id: number, overrides: Partial<SonarrSettings> = {}) =>
  ({
    id,
    name: `Sonarr ${id}`,
    hostname: '127.0.0.1',
    port: 1,
    apiKey: 'k',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeProfileName: 'Any',
    activeDirectory: '/tv',
    activeLanguageProfileId: 1,
    animeTags: [],
    is4k: false,
    enableSeasonFolders: true,
    tags: [],
    isDefault: false,
    syncEnabled: false,
    preventSearch: false,
    externalUrl: '',
    ...overrides,
  }) as SonarrSettings;

const requester = () =>
  getRepository(User).findOneByOrFail({ email: 'friend@seerr.dev' });

let nextTmdbId = 9000;

/** A film request, saved as it stands (an approved one is sent on). */
const movieRequest = async (
  overrides: Partial<MediaRequest> = {},
  status = MediaStatus.PROCESSING
) => {
  const media = await getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: nextTmdbId++,
      status,
      status4k: MediaStatus.UNKNOWN,
    })
  );
  const saved = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status: MediaRequestStatus.FAILED,
      media,
      requestedBy: await requester(),
      is4k: false,
      ...overrides,
    })
  );
  return getRepository(MediaRequest).findOneByOrFail({ id: saved.id });
};

/** A request for the first season of a series. */
const seriesRequest = async (
  overrides: Partial<MediaRequest> = {},
  status = MediaStatus.PROCESSING
) => {
  const media = await getRepository(Media).save(
    new Media({
      mediaType: MediaType.TV,
      tmdbId: nextTmdbId++,
      tvdbId: 1234,
      status,
      status4k: MediaStatus.UNKNOWN,
    })
  );
  const saved = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.TV,
      status: MediaRequestStatus.FAILED,
      media,
      requestedBy: await requester(),
      is4k: false,
      seasons: [
        new SeasonRequest({
          seasonNumber: 1,
          status: MediaRequestStatus.PENDING,
        }),
      ],
      ...overrides,
    })
  );
  return getRepository(MediaRequest).findOneByOrFail({ id: saved.id });
};

/** A music request for one album, saved without being sent anywhere. */
const musicRequest = async (overrides: Partial<MediaRequest> = {}) => {
  const manager = dataSource.manager;
  const media = await manager.save(
    new Media({
      mediaType: MediaType.MUSIC,
      tmdbId: 0,
      foreignId: ARTIST,
      foreignTitle: 'Glasswing',
      status: MediaStatus.PROCESSING,
    }),
    { listeners: false }
  );
  await manager.save(
    new MusicAlbum({
      mediaId: media.id,
      mbId: STATIC_GARDEN,
      title: 'Static Garden',
      secondaryTypes: [],
      status: MediaStatus.PROCESSING,
    }),
    { listeners: false }
  );
  const saved = await manager.save(
    new MediaRequest({
      type: MediaType.MUSIC,
      status: MediaRequestStatus.FAILED,
      media,
      requestedBy: await requester(),
      is4k: false,
      albums: [
        new AlbumRequest({
          albumMbid: STATIC_GARDEN,
          title: 'Static Garden',
          status: MediaRequestStatus.APPROVED,
        }),
      ],
      ...overrides,
    }),
    { listeners: false }
  );
  return getRepository(MediaRequest).findOneByOrFail({ id: saved.id });
};

const lookedUpAlbum = (): LidarrAlbum => ({
  id: 0,
  title: 'Static Garden',
  foreignAlbumId: STATIC_GARDEN,
  artistId: 0,
  monitored: false,
  artist: {
    id: 0,
    artistName: 'Glasswing',
    foreignArtistId: ARTIST,
    monitored: false,
    qualityProfileId: 0,
    metadataProfileId: 0,
    tags: [],
  },
});

// A film already there is completed and announced: TMDB answered here.
Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async ({ movieId }: { movieId: number }) => ({
      id: movieId,
      title: 'Film',
      overview: '',
      release_date: '2020-01-01',
    });
  },
});

const stored = (id: number) =>
  getRepository(MediaRequest).findOneByOrFail({ id });

/** What the title's history says, of one kind, newest last. */
const history = async (type: MediaEventType) =>
  (
    await getRepository(MediaEvent).find({
      where: { type },
      order: { id: 'ASC' },
    })
  ).map((event) => event.detail ?? '');

/** Sending to Radarr or Sonarr stubbed: which server each went to. */
const sentTo = (method: 'sendToRadarr' | 'sendToSonarr') => {
  const servers: (number | null)[] = [];
  mock.method(
    MediaRequestSubscriber.prototype,
    method,
    async (entity: MediaRequest) => {
      if (entity.status === MediaRequestStatus.APPROVED) {
        servers.push(entity.serverId);
      }
    }
  );
  return servers;
};

before(async () => {
  await lidarr.start();
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
    (req as unknown as { user?: User }).user = actingAs;
    next();
  });
  ex.use('/api/v1/request', requestRoutes);
  ex.use(
    (
      err: { status?: number; message: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );
  app = await new Promise<Server>((resolve) => {
    const s = ex.listen(0, () => resolve(s));
  });
  port = (app.address() as { port: number }).port;
});

after(() => {
  app?.close();
  lidarr.stop();
});

beforeEach(async () => {
  const settings = getSettings();
  lidarr.reset();
  cacheManager.getCache('lidarr').flush();
  settings.radarr = [];
  settings.sonarr = [];
  settings.lidarr = [];
  settings.music = musicDefaults();
  settings.main.disabledFeatures = [];
  mock.method(MediaRequest, 'sendNotification', async () => true);
  await actAs(Permission.MANAGE_REQUESTS);
});

afterEach(() => {
  mock.restoreAll();
  const settings = getSettings();
  settings.radarr = [];
  settings.sonarr = [];
  settings.lidarr = [];
});

describe('a request whose server is gone', () => {
  it('is marked failed when its Radarr server was removed, saying so', async () => {
    getSettings().radarr = [radarr(0, { isDefault: true })];

    const request = await movieRequest({
      status: MediaRequestStatus.APPROVED,
      serverId: 5,
    });

    assert.equal((await stored(request.id)).status, MediaRequestStatus.FAILED);
    assert.match(
      (await history(MediaEventType.FAILED)).join('\n'),
      /Radarr server chosen for this request no longer exists/
    );
  });

  it('is announced as failed once', async () => {
    const notified: Notification[] = [];
    mock.method(
      MediaRequest,
      'sendNotification',
      async (_request: MediaRequest, _media: Media, type: Notification) => {
        notified.push(type);
        return true;
      }
    );
    getSettings().radarr = [radarr(0, { isDefault: true })];
    await movieRequest({ status: MediaRequestStatus.APPROVED, serverId: 5 });

    await notificationReconciler.run();
    await notificationReconciler.run();

    assert.deepEqual(
      notified.filter((type) => type === Notification.MEDIA_FAILED),
      [Notification.MEDIA_FAILED]
    );
  });

  it('is marked failed when its Sonarr server was removed, saying so', async () => {
    getSettings().sonarr = [sonarr(0, { isDefault: true })];

    const request = await seriesRequest({
      status: MediaRequestStatus.APPROVED,
      serverId: 3,
    });

    assert.equal((await stored(request.id)).status, MediaRequestStatus.FAILED);
    assert.match(
      (await history(MediaEventType.FAILED)).join('\n'),
      /Sonarr server chosen for this request no longer exists/
    );
  });

  it('is completed, not failed, when the film is already there', async () => {
    getSettings().radarr = [radarr(0, { isDefault: true })];

    const request = await movieRequest(
      { status: MediaRequestStatus.APPROVED, serverId: 5 },
      MediaStatus.AVAILABLE
    );

    assert.equal(
      (await stored(request.id)).status,
      MediaRequestStatus.COMPLETED
    );
    assert.deepEqual(await history(MediaEventType.FAILED), []);
  });

  it('is completed, not failed, when the series is already there', async () => {
    getSettings().sonarr = [sonarr(0, { isDefault: true })];

    const request = await seriesRequest(
      { status: MediaRequestStatus.APPROVED, serverId: 3 },
      MediaStatus.AVAILABLE
    );

    assert.equal(
      (await stored(request.id)).status,
      MediaRequestStatus.COMPLETED
    );
    assert.deepEqual(await history(MediaEventType.FAILED), []);
  });

  it('is marked failed when its 4K server was removed and only others are left', async () => {
    getSettings().radarr = [radarr(0, { isDefault: true })];

    const request = await movieRequest({
      status: MediaRequestStatus.APPROVED,
      is4k: true,
    });

    assert.equal((await stored(request.id)).status, MediaRequestStatus.FAILED);
    assert.match(
      (await history(MediaEventType.FAILED)).join('\n'),
      /No 4K Radarr server is set up/
    );
  });

  it('is marked failed when its Lidarr server was removed, saying so', async () => {
    getSettings().lidarr = [lidarr.settings({ id: 0 })];
    const request = await musicRequest({
      status: MediaRequestStatus.PENDING,
      serverId: 4,
    });

    request.status = MediaRequestStatus.APPROVED;
    await getRepository(MediaRequest).save(request);

    assert.equal((await stored(request.id)).status, MediaRequestStatus.FAILED);
    assert.match(
      (await history(MediaEventType.FAILED)).join('\n'),
      /Lidarr server chosen for this request no longer exists/
    );
    assert.equal(lidarr.calls.length, 0);
  });

  it('says why when it is looked at', async () => {
    getSettings().radarr = [radarr(0, { isDefault: true })];
    const request = await movieRequest({ serverId: 5 });

    const res = await call('GET', `/request/${request.id}`);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.serverIssue, {
      reason: 'removed',
      service: 'radarr',
      usesDefault: true,
    });
  });

  it('says nothing of a server for a request that went through', async () => {
    getSettings().radarr = [radarr(0, { isDefault: true })];
    const request = await movieRequest({
      status: MediaRequestStatus.COMPLETED,
      serverId: 5,
    });

    const res = await call('GET', `/request/${request.id}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.serverIssue, undefined);
  });
});

describe('editing a failed request', () => {
  it('lets a request manager send a film to another server', async () => {
    getSettings().radarr = [radarr(0, { isDefault: true }), radarr(1)];
    const request = await movieRequest({ serverId: 5 });

    const res = await call('PUT', `/request/${request.id}`, {
      mediaType: 'movie',
      serverId: 1,
      profileId: 4,
      rootFolder: '/films',
      tags: [],
    });

    assert.equal(res.status, 200);
    const saved = await stored(request.id);
    assert.equal(saved.serverId, 1);
    assert.equal(saved.profileId, 4);
    assert.equal(saved.rootFolder, '/films');
    // Changing it sends nothing; Retry does.
    assert.equal(saved.status, MediaRequestStatus.FAILED);
  });

  it('then sends it there on retry', async () => {
    getSettings().radarr = [radarr(0, { isDefault: true }), radarr(1)];
    const servers = sentTo('sendToRadarr');
    const request = await movieRequest({ serverId: 5 });

    await call('PUT', `/request/${request.id}`, {
      mediaType: 'movie',
      serverId: 1,
    });
    const res = await call('POST', `/request/${request.id}/retry`);

    assert.equal(res.status, 200);
    assert.deepEqual(servers, [1]);
  });

  it('lets a request manager change a failed series request', async () => {
    getSettings().sonarr = [sonarr(0, { isDefault: true }), sonarr(1)];
    const request = await seriesRequest({ serverId: 3 });

    const res = await call('PUT', `/request/${request.id}`, {
      mediaType: 'tv',
      serverId: 1,
      languageProfileId: 2,
      seasons: [1, 2],
    });

    assert.equal(res.status, 200);
    const saved = await stored(request.id);
    assert.equal(saved.serverId, 1);
    assert.equal(saved.languageProfileId, 2);
    assert.deepEqual(
      saved.seasons.map((season) => season.seasonNumber),
      [1, 2]
    );
    assert.equal(saved.status, MediaRequestStatus.FAILED);
  });

  it('lets a request manager send failed music to another Lidarr', async () => {
    getSettings().lidarr = [lidarr.settings({ id: 3 })];
    const request = await musicRequest({ serverId: 1 });

    const res = await call('PUT', `/request/${request.id}`, {
      mediaType: 'music',
      serverId: 3,
      albums: [STATIC_GARDEN],
    });

    assert.equal(res.status, 200);
    const saved = await stored(request.id);
    assert.equal(saved.serverId, 3);
    assert.equal(saved.status, MediaRequestStatus.FAILED);
    assert.equal(lidarr.calls.length, 0);
  });

  it('is for request managers only', async () => {
    getSettings().radarr = [radarr(0, { isDefault: true }), radarr(1)];
    const request = await movieRequest({ serverId: 5 });
    actingAs = await requester();
    await getRepository(User).update(actingAs.id, {
      permissions: Permission.REQUEST + Permission.REQUEST_ADVANCED,
    });
    actingAs = await requester();

    const res = await call('PUT', `/request/${request.id}`, {
      mediaType: 'movie',
      serverId: 1,
    });

    assert.equal(res.status, 409);
    assert.equal((await stored(request.id)).serverId, 5);
  });

  it('refuses a server that does not exist', async () => {
    getSettings().radarr = [radarr(0, { isDefault: true })];
    const request = await movieRequest();

    const res = await call('PUT', `/request/${request.id}`, {
      mediaType: 'movie',
      serverId: 8,
    });

    assert.equal(res.status, 400);
    assert.equal((await stored(request.id)).serverId, null);
  });

  it('keeps to the quota of whoever it is moved to', async () => {
    getSettings().radarr = [radarr(0, { isDefault: true })];
    const request = await movieRequest({ serverId: 5 });
    const limited = await getRepository(User).save(
      new User({
        email: 'limited@test.local',
        username: 'limited',
        avatar: '',
        permissions: Permission.REQUEST,
        movieQuotaLimit: 1,
        movieQuotaDays: 7,
      })
    );
    await movieRequest({
      requestedBy: limited,
      status: MediaRequestStatus.COMPLETED,
    });

    const res = await call('PUT', `/request/${request.id}`, {
      mediaType: 'movie',
      serverId: 0,
      userId: limited.id,
    });

    assert.equal(res.status, 403);
    assert.equal((await stored(request.id)).serverId, 5);
  });
});

describe('retrying a request whose server is gone', () => {
  it('sends a film to the default Radarr server, starting from its settings', async () => {
    getSettings().radarr = [
      radarr(0, { isDefault: true }),
      radarr(1, { isDefault: true, is4k: true }),
    ];
    const servers = sentTo('sendToRadarr');
    const request = await movieRequest({
      serverId: 5,
      profileId: 9,
      rootFolder: '/gone',
      tags: [3],
    });

    const res = await call('POST', `/request/${request.id}/retry`);

    assert.equal(res.status, 200);
    assert.deepEqual(servers, [0]);
    const saved = await stored(request.id);
    assert.equal(saved.serverId, 0);
    assert.equal(saved.profileId, null);
    assert.equal(saved.rootFolder, null);
    assert.equal(saved.tags, null);
    assert.match(
      (await history(MediaEventType.APPROVED)).join('\n'),
      /default Radarr server, Radarr 0/
    );
  });

  it('says where it went on the approval only, when sending it fails again', async () => {
    getSettings().radarr = [radarr(0, { isDefault: true })];
    // Radarr refuses it, as sendToRadarr does: failed, in the same save.
    mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async (entity: MediaRequest, manager: EntityManager) => {
        if (entity.status === MediaRequestStatus.APPROVED) {
          entity.status = MediaRequestStatus.FAILED;
          await manager.getRepository(MediaRequest).save(entity);
        }
      }
    );
    const request = await movieRequest({ serverId: 5 });

    const res = await call('POST', `/request/${request.id}/retry`);

    assert.equal(res.status, 200);
    assert.equal((await stored(request.id)).status, MediaRequestStatus.FAILED);
    assert.match(
      (await history(MediaEventType.APPROVED)).join('\n'),
      /default Radarr server, Radarr 0/
    );
    assert.doesNotMatch(
      (await history(MediaEventType.FAILED)).join('\n'),
      /default Radarr server/
    );
  });

  it('sends a 4K film to the default 4K server', async () => {
    getSettings().radarr = [
      radarr(0, { isDefault: true }),
      radarr(1, { isDefault: true, is4k: true }),
    ];
    const servers = sentTo('sendToRadarr');
    const request = await movieRequest({ serverId: 5, is4k: true });

    const res = await call('POST', `/request/${request.id}/retry`);

    assert.equal(res.status, 200);
    assert.deepEqual(servers, [1]);
  });

  it('sends a series to the default Sonarr server', async () => {
    getSettings().sonarr = [sonarr(0, { isDefault: true })];
    const servers = sentTo('sendToSonarr');
    const request = await seriesRequest({
      serverId: 3,
      languageProfileId: 7,
    });

    const res = await call('POST', `/request/${request.id}/retry`);

    assert.equal(res.status, 200);
    assert.deepEqual(servers, [0]);
    assert.equal((await stored(request.id)).languageProfileId, null);
  });

  it('sends music to the default Lidarr server', async () => {
    getSettings().lidarr = [lidarr.settings({ id: 3 })];
    lidarr.lookupAlbums.set(STATIC_GARDEN, lookedUpAlbum());
    const request = await musicRequest({ serverId: 1, metadataProfileId: 9 });

    const res = await call('POST', `/request/${request.id}/retry`);
    await lidarr.waitFor(
      (sent: LidarrCall) =>
        sent.method === 'POST' && sent.path === '/api/v1/album'
    );

    assert.equal(res.status, 200);
    const saved = await stored(request.id);
    assert.equal(saved.serverId, 3);
    assert.equal(saved.metadataProfileId, null);
    assert.equal(saved.status, MediaRequestStatus.APPROVED);
    assert.equal(
      lidarr.calls.filter(
        (sent) => sent.method === 'POST' && sent.path === '/api/v1/album'
      ).length,
      1
    );
  });

  it('asks for a server to be chosen when there is no default to send it to', async () => {
    getSettings().radarr = [radarr(0)];
    const servers = sentTo('sendToRadarr');
    const request = await movieRequest({ serverId: 5 });
    assert.ok(await claimDelivery(request.id, Notification.MEDIA_FAILED));

    const res = await call('POST', `/request/${request.id}/retry`);

    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'chooseServer');
    assert.match(String(res.body.message), /Edit it to choose/);
    assert.deepEqual(res.body.serverIssue, {
      reason: 'removed',
      service: 'radarr',
      usesDefault: false,
    });
    assert.deepEqual(servers, []);
    const saved = await stored(request.id);
    assert.equal(saved.status, MediaRequestStatus.FAILED);
    assert.equal(saved.serverId, 5);
    // Nothing was tried, so the failure stays reported.
    assert.equal(
      await hasDelivery(request.id, Notification.MEDIA_FAILED),
      true
    );
  });

  it('asks for a 4K server to be set up when there are only others', async () => {
    getSettings().sonarr = [sonarr(0, { isDefault: true })];
    const request = await seriesRequest({ is4k: true, serverId: 1 });

    const res = await call('POST', `/request/${request.id}/retry`);

    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'noServer');
    assert.match(String(res.body.message), /No 4K Sonarr server is set up/);
    assert.equal((await stored(request.id)).status, MediaRequestStatus.FAILED);
  });

  it('re-approves as before when there is no server of its kind at all', async () => {
    const servers = sentTo('sendToSonarr');
    const request = await seriesRequest({ serverId: 3 });

    const res = await call('POST', `/request/${request.id}/retry`);

    assert.equal(res.status, 200);
    assert.deepEqual(servers, [3]);
    assert.equal(
      (await stored(request.id)).status,
      MediaRequestStatus.APPROVED
    );
  });
});

/*
 * Some servers run without Radarr, Sonarr or Lidarr on purpose and fulfil
 * those requests by hand. That is a choice, not a problem: nothing changes
 * for them.
 */
describe('with no server of its kind at all', () => {
  /** Everything said to anyone about the request. */
  const notifications = () => {
    const sent: Notification[] = [];
    mock.method(
      MediaRequest,
      'sendNotification',
      async (_request: MediaRequest, _media: Media, type: Notification) => {
        sent.push(type);
        return true;
      }
    );
    return sent;
  };

  /** Anything added to Radarr or Sonarr. */
  const added = () => {
    const calls: string[] = [];
    for (const [api, method] of [
      [RadarrAPI, 'addMovie'],
      [SonarrAPI, 'addSeries'],
    ] as const) {
      Object.defineProperty(api.prototype, method, {
        configurable: true,
        set() {},
        get() {
          return async () => {
            calls.push(method);
            return {};
          };
        },
      });
    }
    return calls;
  };

  const looksFine = async (id: number) => {
    const res = await call('GET', `/request/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.serverIssue, undefined);
  };

  it('leaves an approved film approved, sends nothing and tells nobody', async () => {
    const sent = notifications();
    const calls = added();

    const request = await movieRequest({
      status: MediaRequestStatus.APPROVED,
      serverId: 5,
    });
    await notificationReconciler.run();

    assert.equal(
      (await stored(request.id)).status,
      MediaRequestStatus.APPROVED
    );
    assert.deepEqual(calls, []);
    assert.equal(sent.includes(Notification.MEDIA_FAILED), false);
    assert.deepEqual(await history(MediaEventType.FAILED), []);
    await looksFine(request.id);
  });

  it('leaves an approved series approved, sends nothing and tells nobody', async () => {
    const sent = notifications();
    const calls = added();

    const request = await seriesRequest({
      status: MediaRequestStatus.APPROVED,
    });
    await notificationReconciler.run();

    assert.equal(
      (await stored(request.id)).status,
      MediaRequestStatus.APPROVED
    );
    assert.deepEqual(calls, []);
    assert.equal(sent.includes(Notification.MEDIA_FAILED), false);
    assert.deepEqual(await history(MediaEventType.FAILED), []);
    await looksFine(request.id);
  });

  it('leaves approved music approved, sends nothing and tells nobody', async () => {
    const sent = notifications();
    const request = await musicRequest({ status: MediaRequestStatus.PENDING });

    request.status = MediaRequestStatus.APPROVED;
    await getRepository(MediaRequest).save(request);
    await notificationReconciler.run();

    assert.equal(
      (await stored(request.id)).status,
      MediaRequestStatus.APPROVED
    );
    assert.equal(lidarr.calls.length, 0);
    assert.equal(sent.includes(Notification.MEDIA_FAILED), false);
    assert.deepEqual(await history(MediaEventType.FAILED), []);
    await looksFine(request.id);
  });

  it('says nothing of a server on a pending or failed request', async () => {
    const pending = await movieRequest({
      status: MediaRequestStatus.PENDING,
      serverId: 5,
    });
    // Failed for some other reason, before its Radarr went away.
    const failed = await seriesRequest({ serverId: 2 });

    await looksFine(pending.id);
    await looksFine(failed.id);
  });

  it('lets a request be changed to any server id, as before', async () => {
    const request = await movieRequest({ status: MediaRequestStatus.PENDING });

    const res = await call('PUT', `/request/${request.id}`, {
      mediaType: 'movie',
      serverId: 3,
    });

    assert.equal(res.status, 200);
    assert.equal((await stored(request.id)).serverId, 3);
  });
});
