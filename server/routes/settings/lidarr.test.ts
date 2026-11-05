import SlskdAPI from '@server/api/slskd';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import type { LidarrSettings } from '@server/lib/settings';
import { getSettings, musicDefaults } from '@server/lib/settings';
import serviceRoutes from '@server/routes/service';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import { MUSIC_FIXTURE_IDS } from '@server/utils/seedTestDb';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
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
 * Lidarr settings (Settings → Services), music settings (Settings → Music)
 * and what the request window reads about a Lidarr, against a fake Lidarr
 * API.
 */

setupTestDb();

const ARTIST = MUSIC_FIXTURE_IDS.artist;

const lidarr = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.searchParams.get('apikey') !== 'the-key') {
    res.writeHead(401);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  const answers: Record<string, unknown> = {
    '/api/v1/system/status': { version: '2.9.6', urlBase: '/lidarr' },
    '/api/v1/qualityprofile': [{ id: 1, name: 'Lossless' }],
    '/api/v1/metadataprofile': [
      {
        id: 3,
        name: 'Standard',
        primaryAlbumTypes: [
          { albumType: { id: 0, name: 'Album' }, allowed: true },
          { albumType: { id: 1, name: 'EP' }, allowed: true },
          { albumType: { id: 2, name: 'Single' }, allowed: false },
        ],
        secondaryAlbumTypes: [
          { albumType: { id: 0, name: 'Studio' }, allowed: true },
          { albumType: { id: 3, name: 'Live' }, allowed: false },
        ],
      },
    ],
    '/api/v1/rootfolder': [
      { id: 5, path: '/music', freeSpace: 10, totalSpace: 20 },
    ],
    '/api/v1/tag': [{ id: 7, label: 'music' }],
    // Folders Lidarr sees: of the data folders, only slskd's downloads.
    '/api/v1/filesystem': {
      directories:
        url.searchParams.get('path') === '/data/soulseek/'
          ? [{ path: '/data/soulseek/complete/' }]
          : [],
    },
    '/api/v1/artist':
      url.searchParams.get('mbId') === ARTIST
        ? [
            {
              id: 42,
              artistName: 'Glasswing',
              foreignArtistId: ARTIST,
              monitored: false,
              qualityProfileId: 1,
              metadataProfileId: 3,
              path: '/music/Glasswing',
              rootFolderPath: '/music',
              tags: [7],
            },
          ]
        : [],
  };
  // Lidarr's paths are not case sensitive.
  res.end(JSON.stringify(answers[url.pathname.toLowerCase()] ?? []));
});
let lidarrPort = 0;

let app: Server;
let port = 0;
let actingAs: User | undefined;

const call = async (
  method: string,
  pathname: string,
  body?: unknown
): Promise<{ status: number; body: never }> => {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${pathname}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as never };
};

const server = (
  overrides: Partial<LidarrSettings> = {}
): Omit<LidarrSettings, 'id'> =>
  ({
    name: 'Lidarr',
    hostname: '127.0.0.1',
    port: lidarrPort,
    apiKey: 'the-key',
    useSsl: false,
    baseUrl: '',
    activeProfileId: 1,
    activeProfileName: 'Lossless',
    activeDirectory: '/music',
    activeMetadataProfileId: 3,
    activeMetadataProfileName: 'Standard',
    isDefault: true,
    tags: [],
    syncEnabled: false,
    preventSearch: false,
    tagRequests: false,
    ...overrides,
  }) as Omit<LidarrSettings, 'id'>;

before(async () => {
  await new Promise<void>((r) => lidarr.listen(0, '127.0.0.1', () => r()));
  lidarrPort = (lidarr.address() as { port: number }).port;
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
  ex.use('/api/v1/settings', settingsRoutes);
  ex.use('/api/v1/service', serviceRoutes);
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
  lidarr.close();
});

beforeEach(async () => {
  cacheManager.getCache('lidarr').flush();
  const settings = getSettings();
  settings.lidarr = [];
  settings.music = musicDefaults();
  settings.main.disabledFeatures = [];
  actingAs = await getRepository(User).findOneByOrFail({ id: 1 });
});

afterEach(() => {
  getSettings().lidarr = [];
  getSettings().main.disabledFeatures = [];
});

describe('Lidarr servers', () => {
  it('are tested, returning what the dialog chooses from', async () => {
    const { status, body } = await call('POST', '/settings/lidarr/test', {
      hostname: '127.0.0.1',
      port: lidarrPort,
      apiKey: 'the-key',
      useSsl: false,
    });
    assert.equal(status, 200);
    const found = body as {
      profiles: unknown[];
      metadataProfiles: unknown[];
      rootFolders: unknown[];
      tags: unknown[];
      urlBase: string;
    };
    assert.deepEqual(found.profiles, [{ id: 1, name: 'Lossless' }]);
    assert.deepEqual(found.metadataProfiles, [{ id: 3, name: 'Standard' }]);
    assert.deepEqual(found.rootFolders, [{ id: 5, path: '/music' }]);
    assert.deepEqual(found.tags, [{ id: 7, label: 'music' }]);
    assert.equal(found.urlBase, '/lidarr');

    const refused = await call('POST', '/settings/lidarr/test', {
      hostname: '127.0.0.1',
      port: lidarrPort,
      apiKey: 'wrong',
      useSsl: false,
    });
    assert.equal(refused.status, 500);
  });

  it('are added, changed and removed; one default; never 4K', async () => {
    assert.equal(getSettings().fullPublicSettings.musicReady, false);

    const first = await call('POST', '/settings/lidarr', {
      ...server(),
      is4k: true,
    });
    assert.equal(first.status, 201);
    const added = first.body as LidarrSettings;
    assert.equal(added.is4k, false);
    assert.equal(getSettings().fullPublicSettings.musicReady, true);

    const second = (
      await call('POST', '/settings/lidarr', server({ name: 'Other' }))
    ).body as LidarrSettings;
    assert.notEqual(second.id, added.id);
    assert.deepEqual(
      getSettings().lidarr.map((s) => [s.name, s.isDefault]),
      [
        ['Lidarr', false],
        ['Other', true],
      ]
    );

    const changed = await call(
      'PUT',
      `/settings/lidarr/${added.id}`,
      server({ name: 'Renamed' })
    );
    assert.equal(changed.status, 200);
    assert.deepEqual(
      getSettings().lidarr.map((s) => [s.id, s.name, s.isDefault]),
      [
        [added.id, 'Renamed', true],
        [second.id, 'Other', false],
      ]
    );

    assert.equal(
      (await call('DELETE', `/settings/lidarr/${added.id}`)).status,
      200
    );
    assert.equal(
      (await call('DELETE', `/settings/lidarr/${added.id}`)).status,
      404
    );
    // Without a default, music is off.
    assert.equal(getSettings().fullPublicSettings.musicReady, false);

    // A removed server's id is never reused.
    const third = (await call('POST', '/settings/lidarr', server()))
      .body as LidarrSettings;
    assert.ok(third.id > second.id);
  });

  it('are gone while music is turned off for everyone', async () => {
    getSettings().lidarr = [{ ...server(), id: 0 } as LidarrSettings];
    getSettings().main.disabledFeatures = ['music'];
    assert.equal((await call('GET', '/settings/lidarr')).status, 403);
    assert.equal(
      (await call('POST', '/settings/lidarr', server())).status,
      403
    );
    assert.equal((await call('GET', '/settings/music')).status, 403);
    assert.equal(getSettings().fullPublicSettings.musicReady, false);
  });
});

describe('music settings', () => {
  it('keep TheAudioDB’s key to themselves', async () => {
    const saved = await call('POST', '/settings/music', {
      musicbrainzUrl: 'http://192.168.1.5:5000/',
      contactEmail: 'admin@example.com',
      listenBrainz: false,
      theAudioDbApiKey: 'secret',
      maxAlbumsPerRequest: 50,
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, {
      musicbrainzUrl: 'http://192.168.1.5:5000',
      contactEmail: 'admin@example.com',
      listenBrainz: false,
      deezer: true,
      maxAlbumsPerRequest: 50,
      songRequests: true,
      songsFromAlbums: true,
      songQuota: { quotaLimit: 0, quotaDays: 7 },
      playlists: { overLimit: 'wait', approveOver: 25 },
      hasTheAudioDbApiKey: true,
      search: { inAll: false },
    });
    assert.equal(getSettings().music.theAudioDbApiKey, 'secret');

    // Resaving without a key keeps it; a blank address means the public one.
    await call('POST', '/settings/music', { musicbrainzUrl: '' });
    assert.equal(getSettings().music.theAudioDbApiKey, 'secret');
    assert.equal(getSettings().music.musicbrainzUrl, 'https://musicbrainz.org');

    // Deezer changes only when sent.
    await call('POST', '/settings/music', { deezer: false });
    assert.equal(getSettings().music.deezer, false);
    await call('POST', '/settings/music', { musicbrainzUrl: '' });
    assert.equal(getSettings().music.deezer, false);

    await call('POST', '/settings/music', { removeTheAudioDbApiKey: true });
    assert.equal(getSettings().music.theAudioDbApiKey, '');
    assert.equal(
      (await call('GET', '/settings/music')).body[
        'hasTheAudioDbApiKey' as never
      ],
      false
    );
  });

  it('start with songs on, even where music was set up before them', () => {
    const settings = getSettings();
    const { songRequests, songsFromAlbums, ...older } = settings.music;
    assert.deepEqual([songRequests, songsFromAlbums], [true, true]);
    settings.music = older as typeof settings.music;
    assert.equal(settings.music.songRequests, true);
    assert.equal(settings.music.songsFromAlbums, true);
    assert.equal(settings.fullPublicSettings.musicSongs, true);
  });

  it('turn song requests off and on, with a limit of their own, and keep them', async () => {
    const off = await call('POST', '/settings/music', {
      songRequests: false,
      songsFromAlbums: false,
    });
    assert.equal(off.status, 200);
    // A save without them keeps them off.
    await call('POST', '/settings/music', { listenBrainz: true });
    assert.deepEqual(
      [getSettings().music.songRequests, getSettings().music.songsFromAlbums],
      [false, false]
    );
    assert.equal(getSettings().fullPublicSettings.musicSongs, false);

    const saved = await call('POST', '/settings/music', {
      songRequests: true,
      songQuota: { quotaLimit: 5, quotaDays: 30 },
    });
    assert.equal(saved.status, 200);
    assert.equal(getSettings().music.songRequests, true);
    assert.deepEqual(getSettings().music.songQuota, {
      quotaLimit: 5,
      quotaDays: 30,
    });
    assert.equal(getSettings().fullPublicSettings.musicSongs, true);

    // A save without them keeps them.
    await call('POST', '/settings/music', { listenBrainz: true });
    assert.equal(getSettings().music.songRequests, true);
    assert.equal(getSettings().music.songQuota.quotaLimit, 5);

    assert.equal(
      (
        await call('POST', '/settings/music', {
          songQuota: { quotaLimit: -1, quotaDays: 7 },
        })
      ).status,
      400
    );
  });

  it('refuse an address or email that is not one', async () => {
    assert.equal(
      (await call('POST', '/settings/music', { musicbrainzUrl: 'ftp://x' }))
        .status,
      400
    );
    assert.equal(
      (await call('POST', '/settings/music', { contactEmail: 'not an email' }))
        .status,
      400
    );
  });
});

describe('how music is searched', () => {
  it('is saved with the rest of Settings → Music', async () => {
    const first = await call('GET', '/settings/music');
    assert.equal(first.status, 200);
    assert.deepEqual((first.body as { search: unknown }).search, {
      inAll: false,
    });

    const saved = await call('POST', '/settings/music', {
      listenBrainz: false,
      search: { inAll: true },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual((saved.body as { search: unknown }).search, {
      inAll: true,
    });
    assert.deepEqual(getSettings().music.search, { inAll: true });
    assert.equal(getSettings().music.listenBrainz, false);
    assert.deepEqual(
      ((await call('GET', '/settings/music')).body as { search: unknown })
        .search,
      { inAll: true }
    );

    // A save without it keeps it.
    await call('POST', '/settings/music', { listenBrainz: true });
    assert.deepEqual(getSettings().music.search, { inAll: true });
  });

  it('is on to start once Lidarr is set up, unless an admin chose', async () => {
    const search = async () =>
      ((await call('GET', '/settings/music')).body as { search: unknown })
        .search;
    // Unset: off without Lidarr, on with one.
    assert.deepEqual(getSettings().music.search, {});
    assert.deepEqual(await search(), { inAll: false });
    assert.equal(getSettings().fullPublicSettings.musicSearch.inAll, false);
    getSettings().lidarr = [{ ...server(), id: 0 }];
    assert.deepEqual(await search(), { inAll: true });
    assert.equal(getSettings().fullPublicSettings.musicSearch.inAll, true);

    // Saving other settings leaves it following Lidarr.
    await call('POST', '/settings/music', { listenBrainz: true });
    assert.deepEqual(getSettings().music.search, {});

    // Turned off by an admin, it stays off even with Lidarr.
    await call('POST', '/settings/music', { search: { inAll: false } });
    assert.deepEqual(await search(), { inAll: false });
    assert.equal(getSettings().fullPublicSettings.musicSearch.inAll, false);
  });

  it('keeps nothing but whether music is in All', async () => {
    // An older page may still send removed settings.
    const saved = await call('POST', '/settings/music', {
      search: {
        inAll: true,
        musicPage: false,
        chip: false,
        artists: 3,
        albums: 20,
      },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(getSettings().music.search, { inAll: true });
  });

  it('refuses a choice that is not yes or no, changing nothing', async () => {
    assert.equal(
      (await call('POST', '/settings/music', { search: { inAll: 'yes' } }))
        .status,
      400
    );
    assert.deepEqual(getSettings().music.search, {});
  });

  it('tells everyone only whether music is in All', async () => {
    await call('POST', '/settings/music', { search: { inAll: true } });
    assert.deepEqual(getSettings().fullPublicSettings.musicSearch, {
      inAll: true,
    });
  });

  it('is gone while music is turned off for everyone', async () => {
    getSettings().main.disabledFeatures = ['music'];
    assert.equal(
      (await call('POST', '/settings/music', { search: { inAll: true } }))
        .status,
      403
    );
    assert.equal(getSettings().music.search.inAll, undefined);
  });

  it('is there before a Lidarr is added, since music starts here', async () => {
    assert.equal(getSettings().lidarr.length, 0);
    assert.equal((await call('GET', '/settings/music')).status, 200);
  });
});

describe('the request window’s Lidarr', () => {
  beforeEach(() => {
    getSettings().lidarr = [
      { ...server(), id: 0, apiKey: 'the-key' } as LidarrSettings,
    ];
    actingAs = Object.assign(new User(), { id: 2, permissions: 32 });
  });

  it('lists servers without their keys', async () => {
    const { status, body } = await call('GET', '/service/lidarr');
    assert.equal(status, 200);
    assert.deepEqual(body, [
      {
        id: 0,
        name: 'Lidarr',
        is4k: false,
        isDefault: true,
        activeDirectory: '/music',
        activeProfileId: 1,
        activeMetadataProfileId: 3,
        activeTags: [],
      },
    ]);
  });

  it('gives a server’s profiles, the kinds each lists, and an artist it has', async () => {
    const { status, body } = await call(
      'GET',
      `/service/lidarr/0?artist=${ARTIST}`
    );
    assert.equal(status, 200);
    const details = body as {
      metadataProfiles: unknown[];
      rootFolders: unknown[];
      artist: unknown;
    };
    assert.deepEqual(details.metadataProfiles, [
      {
        id: 3,
        name: 'Standard',
        primaryTypes: ['Album', 'EP'],
        secondaryTypes: ['Studio'],
      },
    ]);
    assert.deepEqual(details.artist, {
      id: 42,
      path: '/music/Glasswing',
      rootFolderPath: '/music',
      qualityProfileId: 1,
      metadataProfileId: 3,
      tags: [7],
      monitored: false,
    });

    const without = await call('GET', '/service/lidarr/0');
    assert.equal((without.body as { artist: unknown }).artist, null);
    assert.equal((await call('GET', '/service/lidarr/9')).status, 404);
  });

  it('is refused to someone with music off', async () => {
    actingAs = Object.assign(new User(), {
      id: 2,
      permissions: 32,
      settings: { disabledFeatures: ['music'] },
    });
    assert.equal((await call('GET', '/service/lidarr')).status, 403);
    assert.equal((await call('GET', '/service/lidarr/0')).status, 403);
  });
});

describe('Soulseek', () => {
  let answer: () => Promise<unknown>;

  beforeEach(() => {
    answer = async () => ({
      version: { current: '0.26.2' },
      server: { isLoggedIn: true },
    });
    mock.method(SlskdAPI.prototype, 'getApplication', () => answer());
  });

  afterEach(() => mock.restoreAll());

  const slskd = {
    url: 'http://192.168.1.5:5030/',
    apiKey: 'a-key-long-enough-for-slskd',
    downloadsPath: '/data/soulseek/complete/',
  };

  it('is saved once slskd answers and Lidarr sees its downloads, keeping its key', async () => {
    await call('POST', '/settings/lidarr', server());
    const saved = await call('PUT', '/settings/music/soulseek', slskd);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, {
      url: 'http://192.168.1.5:5030',
      downloadsPath: '/data/soulseek/complete',
      hasApiKey: true,
    });
    assert.equal(
      getSettings().music.soulseek?.apiKey,
      'a-key-long-enough-for-slskd'
    );
    // Resaving without the key keeps it; saving Settings → Music keeps
    // Soulseek.
    await call('PUT', '/settings/music/soulseek', { ...slskd, apiKey: '' });
    await call('POST', '/settings/music', { listenBrainz: true });
    assert.equal(
      getSettings().music.soulseek?.apiKey,
      'a-key-long-enough-for-slskd'
    );
    assert.equal(
      (await call('GET', '/settings/music/soulseek')).body['hasApiKey'],
      true
    );

    // A blank address removes it.
    await call('PUT', '/settings/music/soulseek', { url: '' });
    assert.deepEqual(getSettings().music.soulseek, {
      url: '',
      apiKey: '',
      downloadsPath: '',
    });
  });

  it('is refused when slskd doesn’t answer, is too old, or Lidarr can’t see the folder', async () => {
    const refused = async (body: object, why: RegExp) => {
      const res = await call('PUT', '/settings/music/soulseek', body);
      assert.equal(res.status, 400);
      assert.match(res.body['message'], why);
      assert.equal(getSettings().music.soulseek?.url, '');
    };
    answer = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    await refused(slskd, /didn’t answer/);
    answer = async () => ({
      version: { current: '0.25.1' },
      server: { isLoggedIn: true },
    });
    await refused(slskd, /0\.26 or newer/);
    answer = async () => ({
      version: { current: '0.26.2' },
      server: { isLoggedIn: true },
    });
    await call('POST', '/settings/lidarr', server());
    await refused(
      { ...slskd, downloadsPath: '/downloads/soulseek' },
      /Lidarr doesn’t see \/downloads\/soulseek/
    );
    await refused({ ...slskd, apiKey: '' }, /API key/);
    await refused({ ...slskd, downloadsPath: 'soulseek' }, /full path/);
  });

  it('is tested: its version, and whether it is signed in', async () => {
    answer = async () => ({
      version: { current: '0.26.2' },
      server: { isLoggedIn: false },
    });
    const tested = await call('POST', '/settings/music/soulseek/test', slskd);
    assert.equal(tested.status, 200);
    assert.deepEqual(tested.body, { version: '0.26.2', signedIn: false });
  });
});
