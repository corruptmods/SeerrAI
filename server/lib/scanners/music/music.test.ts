import type { JellyfinMusicItem } from '@server/api/jellyfin';
import type { PlexMusicItem } from '@server/api/plexapi';
import type { LidarrAlbum, LidarrArtist } from '@server/api/servarr/lidarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import dataSource, { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import Media from '@server/entity/Media';
import MediaEvent from '@server/entity/MediaEvent';
import { MediaRequest } from '@server/entity/MediaRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import MusicMetadata from '@server/entity/MusicMetadata';
import { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import downloadTracker from '@server/lib/downloadtracker';
import { albumPlayLinks } from '@server/lib/mediaServers';
import { MB_CALL_CAP } from '@server/lib/music/matcher';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import { musicFullScan, musicSync } from '@server/lib/scanners/music';
import type { LidarrSettings } from '@server/lib/settings';
import {
  getSettings,
  jellyfinDefaults,
  musicDefaults,
} from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
 * The music scans against stand-ins that answer as Plex, Jellyfin, Emby,
 * Lidarr and a MusicBrainz mirror do: which albums are found, how they are
 * placed, and what is marked as here or gone.
 */

setupTestDb();

/** A MusicBrainz id made from a number. */
const mbid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ARTIST = mbid(1);
const OTHER_ARTIST = mbid(2);
const HAIL = mbid(101);
const HAIL_RELEASE = mbid(201);
const KID_A = mbid(102);
const AMNESIAC = mbid(103);
const OK_COMPUTER = mbid(104);
const IN_RAINBOWS = mbid(105);

interface State {
  plex: {
    up: boolean;
    artists: PlexMusicItem[];
    albums: PlexMusicItem[];
    tracks: Record<string, PlexMusicItem[]>;
    asked: string[];
  };
  jellyfin: { up: boolean; items: JellyfinMusicItem[]; asked: string[] };
  emby: { up: boolean; items: JellyfinMusicItem[]; asked: string[] };
  lidarr: {
    up: boolean;
    artists: LidarrArtist[];
    albums: LidarrAlbum[];
    lookups: Record<string, LidarrAlbum>;
    added: Record<string, unknown>[];
    monitored: number[][];
    commands: Record<string, unknown>[];
  };
  mb: {
    releases: Record<string, string>;
    groups: Record<string, string>;
    calls: number;
  };
}

let state: State;
const fresh = (): State => ({
  plex: { up: true, artists: [], albums: [], tracks: {}, asked: [] },
  jellyfin: { up: true, items: [], asked: [] },
  emby: { up: true, items: [], asked: [] },
  lidarr: {
    up: true,
    artists: [],
    albums: [],
    lookups: {},
    added: [],
    monitored: [],
    commands: [],
  },
  mb: { releases: {}, groups: {}, calls: 0 },
});

const send = (res: ServerResponse, body: unknown, status = 200) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });

const plexStandIn = (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  state.plex.asked.push(url.pathname + url.search);
  if (!state.plex.up) return send(res, {}, 500);
  const section = url.pathname.match(/^\/library\/sections\/(\w+)\/all$/);
  if (section) {
    let items =
      url.searchParams.get('type') === '8'
        ? state.plex.artists
        : state.plex.albums;
    const since = url.searchParams.get('addedAt>>');
    if (since) {
      items = items
        .filter((item) => (item.addedAt ?? 0) >= Number(since))
        .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
    }
    const start = Number(req.headers['x-plex-container-start'] ?? 0);
    const size = Number(req.headers['x-plex-container-size'] ?? 50);
    return send(res, {
      MediaContainer: {
        totalSize: items.length,
        Metadata: items.slice(start, start + size),
      },
    });
  }
  const children = url.pathname.match(/^\/library\/metadata\/(\w+)\/children$/);
  if (children) {
    return send(res, {
      MediaContainer: { Metadata: state.plex.tracks[children[1]] ?? [] },
    });
  }
  const item = url.pathname.match(/^\/library\/metadata\/(\w+)$/);
  if (item) {
    const found = [...state.plex.artists, ...state.plex.albums].find(
      (i) => i.ratingKey === item[1]
    );
    return found
      ? send(res, { MediaContainer: { Metadata: [found] } })
      : send(res, {}, 404);
  }
  send(res, {}, 404);
};

const jellyfinStandIn =
  (which: 'jellyfin' | 'emby') =>
  (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const server = state[which];
    server.asked.push(url.pathname + url.search);
    if (!server.up) return send(res, {}, 500);
    if (url.pathname === '/Items') {
      let items = [...server.items];
      if (url.searchParams.get('SortOrder') === 'Descending') {
        items.sort(
          (a, b) =>
            new Date(b.DateCreated ?? 0).getTime() -
            new Date(a.DateCreated ?? 0).getTime()
        );
      }
      const start = Number(url.searchParams.get('StartIndex') ?? 0);
      const limit = Number(url.searchParams.get('Limit') ?? 100);
      items = items.slice(start, start + limit);
      return send(res, { Items: items, TotalRecordCount: server.items.length });
    }
    send(res, {}, 404);
  };

const lidarrStandIn = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const path = url.pathname.replace(/^\/api\/v1/, '');
  const lidarr = state.lidarr;
  if (!lidarr.up) return send(res, {}, 500);
  if (req.method === 'GET' && path === '/artist') {
    return send(res, lidarr.artists);
  }
  if (req.method === 'GET' && path === '/album') {
    const artistId = url.searchParams.get('artistId');
    return send(
      res,
      artistId
        ? lidarr.albums.filter((a) => a.artistId === Number(artistId))
        : lidarr.albums
    );
  }
  if (req.method === 'GET' && path === '/album/lookup') {
    const term = (url.searchParams.get('term') ?? '').replace('lidarr:', '');
    return send(res, lidarr.lookups[term] ? [lidarr.lookups[term]] : []);
  }
  if (req.method === 'POST' && path === '/album') {
    const body = await readBody(req);
    lidarr.added.push(body);
    return send(res, { ...body, id: 900 + lidarr.added.length });
  }
  if (req.method === 'PUT' && path === '/album/monitor') {
    const body = await readBody(req);
    lidarr.monitored.push(body.albumIds as number[]);
    return send(res, {});
  }
  if (req.method === 'POST' && path === '/command') {
    lidarr.commands.push(await readBody(req));
    return send(res, {});
  }
  send(res, {}, 404);
};

const mbStandIn = (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  state.mb.calls++;
  const release = url.pathname.match(/^\/ws\/2\/release\/([0-9a-f-]+)$/);
  if (release) {
    const group = state.mb.releases[release[1]];
    return group
      ? send(res, { id: release[1], 'release-group': { id: group } })
      : send(res, { error: 'Not Found' }, 404);
  }
  const group = url.pathname.match(/^\/ws\/2\/release-group\/([0-9a-f-]+)$/);
  if (group) {
    const artist = state.mb.groups[group[1]];
    return artist
      ? send(res, {
          id: group[1],
          title: 'Found by MusicBrainz',
          'artist-credit': [{ name: 'Radiohead', artist: { id: artist } }],
        })
      : send(res, { error: 'Not Found' }, 404);
  }
  send(res, {}, 404);
};

const servers: Server[] = [];
const ports: Record<string, number> = {};

before(async () => {
  const listen = (name: string, app: http.RequestListener) =>
    new Promise<void>((resolve) => {
      const server = http.createServer(app).listen(0, () => {
        ports[name] = (server.address() as AddressInfo).port;
        resolve();
      });
      servers.push(server);
    });
  await listen('plex', plexStandIn);
  await listen('jellyfin', jellyfinStandIn('jellyfin'));
  await listen('emby', jellyfinStandIn('emby'));
  await listen('lidarr', (req, res) => void lidarrStandIn(req, res));
  await listen('mb', mbStandIn);
});

after(() => servers.forEach((server) => server.close()));

const lidarrServer = (over: Partial<LidarrSettings> = {}): LidarrSettings =>
  ({
    id: 0,
    name: 'Lidarr',
    hostname: '127.0.0.1',
    port: ports.lidarr,
    apiKey: 'lidarr-key',
    useSsl: false,
    baseUrl: '',
    activeProfileId: 1,
    activeProfileName: 'Any',
    activeDirectory: '/music',
    activeMetadataProfileId: 1,
    activeMetadataProfileName: 'Standard',
    tags: [],
    is4k: false,
    isDefault: true,
    externalUrl: 'https://lidarr.example.com',
    syncEnabled: false,
    preventSearch: false,
    tagRequests: false,
    overrideRule: [],
    ...over,
  }) as LidarrSettings;

/** Connects the servers given, the first as the primary one. */
const connect = (...kinds: ('plex' | 'jellyfin' | 'emby')[]) => {
  const settings = getSettings();
  settings.main.mediaServerType =
    kinds[0] === 'plex'
      ? MediaServerType.PLEX
      : kinds[0] === 'emby'
        ? MediaServerType.EMBY
        : MediaServerType.JELLYFIN;
  for (const kind of ['plex', 'jellyfin', 'emby'] as const) {
    settings[kind].connected = kinds.includes(kind);
  }
};

beforeEach(() => {
  state = fresh();
  cacheManager.getCache('musicbrainz').flush();
  const settings = getSettings();
  settings.main.disabledFeatures = [];
  Object.assign(settings.plex, {
    ip: '127.0.0.1',
    port: ports.plex,
    useSsl: false,
    machineId: 'plex-machine',
    webAppUrl: '',
    libraries: [],
    musicLibraries: [{ id: '7', name: 'Music', enabled: true, type: 'artist' }],
  });
  for (const kind of ['jellyfin', 'emby'] as const) {
    settings[kind] = {
      ...jellyfinDefaults(),
      name: kind,
      ip: '127.0.0.1',
      port: ports[kind],
      apiKey: `${kind}-key`,
      serverId: `${kind}-server`,
      externalHostname: `https://${kind}.example.com`,
      musicLibraries: [
        { id: `${kind}-music`, name: 'Music', enabled: true, type: 'music' },
      ],
    };
  }
  connect('plex');
  settings.lidarr = [lidarrServer()];
  settings.music = {
    ...musicDefaults(),
    musicbrainzUrl: `http://127.0.0.1:${ports.mb}`,
  };
});

const lidarrArtist = (over: Partial<LidarrArtist> = {}): LidarrArtist => ({
  id: 7,
  artistName: 'Radiohead',
  foreignArtistId: ARTIST,
  monitored: true,
  qualityProfileId: 1,
  metadataProfileId: 1,
  tags: [],
  path: '/music/Radiohead',
  ...over,
});

const lidarrAlbum = (over: Partial<LidarrAlbum> = {}): LidarrAlbum => ({
  id: 70,
  title: 'Hail to the Thief',
  foreignAlbumId: HAIL,
  artistId: 7,
  monitored: false,
  albumType: 'Album',
  secondaryTypes: [],
  releaseDate: '2003-06-09T00:00:00Z',
  releases: [
    {
      id: 1,
      albumId: 70,
      foreignReleaseId: HAIL_RELEASE,
      title: 'Hail to the Thief',
      monitored: true,
    },
  ],
  statistics: {
    trackCount: 14,
    trackFileCount: 0,
    totalTrackCount: 14,
    sizeOnDisk: 0,
    percentOfTracks: 0,
  },
  ...over,
});

const plexArtist = (
  ratingKey: string,
  title: string,
  artistMbid?: string
): PlexMusicItem => ({
  ratingKey,
  type: 'artist',
  title,
  Guid: artistMbid ? [{ id: `mbid://${artistMbid}` }] : [],
});

const plexAlbum = (
  ratingKey: string,
  title: string,
  {
    artist = '500',
    artistName = 'Radiohead',
    guid,
    year,
    addedAt = 1_700_000_000,
  }: {
    artist?: string;
    artistName?: string;
    guid?: string;
    year?: number;
    addedAt?: number;
  } = {}
): PlexMusicItem => ({
  ratingKey,
  parentRatingKey: artist,
  parentTitle: artistName,
  type: 'album',
  title,
  year,
  addedAt,
  Guid: guid ? [{ id: `mbid://${guid}` }] : [],
});

const jellyfinAlbum = (
  id: string,
  name: string,
  over: Partial<JellyfinMusicItem> = {}
): JellyfinMusicItem => ({
  Id: id,
  Name: name,
  Type: 'MusicAlbum',
  AlbumArtists: [{ Name: 'Radiohead', Id: `${id}-artist` }],
  DateCreated: '2026-10-01T00:00:00Z',
  ...over,
});

const albums = () => getRepository(MusicAlbum).find({ order: { id: 'ASC' } });
const albumOf = async (mbId: string) =>
  getRepository(MusicAlbum).findOneByOrFail({ mbId });
const artistOf = async (foreignId: string) =>
  getRepository(Media).findOneByOrFail({
    mediaType: MediaType.MUSIC,
    foreignId,
  });

/** An artist Seerr has, with albums, as a request would leave them. */
const seedArtist = async (
  albumRows: Partial<MusicAlbum>[],
  over: Partial<Media> = {}
): Promise<Media> => {
  const media = await getRepository(Media).save(
    new Media({
      mediaType: MediaType.MUSIC,
      tmdbId: 0,
      foreignId: ARTIST,
      status: MediaStatus.PROCESSING,
      serviceId: 0,
      externalServiceId: 7,
      externalServiceSlug: ARTIST,
      ...over,
    })
  );
  for (const row of albumRows) {
    await getRepository(MusicAlbum).insert(
      new MusicAlbum({
        mediaId: media.id,
        title: 'An album',
        secondaryTypes: [],
        status: MediaStatus.PROCESSING,
        ...row,
      })
    );
  }
  return media;
};

/** A music request for these albums, saved as it would be. */
const seedRequest = async (
  media: Media,
  albumList: { mbid: string; title: string }[],
  status = MediaRequestStatus.APPROVED,
  updatedAt = new Date()
): Promise<MediaRequest> => {
  const requester = await getRepository(User).findOneByOrFail({ id: 2 });
  const request = await dataSource.manager.save(
    new MediaRequest({
      type: MediaType.MUSIC,
      status,
      media,
      requestedBy: requester,
      is4k: false,
      serverId: 0,
      albums: albumList.map(
        (album) =>
          new AlbumRequest({
            albumMbid: album.mbid,
            title: album.title,
            status,
          })
      ),
    }),
    { listeners: false }
  );
  await dataSource
    .createQueryBuilder()
    .update(MediaRequest)
    .set({ updatedAt })
    .where({ id: request.id })
    .callListeners(false)
    .execute();
  return getRepository(MediaRequest).findOneByOrFail({ id: request.id });
};

describe('music scans', () => {
  it('does nothing until music is set up', async () => {
    getSettings().lidarr = [];
    state.plex.albums = [plexAlbum('600', 'Hail to the Thief')];

    await musicFullScan.run();

    assert.deepEqual(state.plex.asked, []);
    assert.equal((await albums()).length, 0);
  });

  describe('Plex', () => {
    it('places an album whose id is a release Lidarr lists, asking MusicBrainz nothing', async () => {
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [lidarrAlbum({ monitored: true })];
      state.plex.artists = [plexArtist('500', 'Radiohead', ARTIST)];
      state.plex.albums = [plexAlbum('600', 'Hail', { guid: HAIL_RELEASE })];

      await musicFullScan.run();

      const album = await albumOf(HAIL);
      assert.equal(album.status, MediaStatus.AVAILABLE);
      assert.equal(album.ratingKey, '600');
      assert.equal(album.title, 'Hail to the Thief');
      assert.equal(album.lidarrAlbumId, 70);
      const artist = await artistOf(ARTIST);
      assert.equal(artist.ratingKey, '500');
      // The one album Lidarr monitors is here: the artist is.
      assert.equal(artist.status, MediaStatus.AVAILABLE);
      assert.equal(state.mb.calls, 0);
    });

    it('places an album whose id is the album’s own', async () => {
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [lidarrAlbum()];
      state.plex.artists = [plexArtist('500', 'Radiohead', ARTIST)];
      state.plex.albums = [plexAlbum('600', 'Hail', { guid: HAIL })];

      await musicFullScan.run();

      assert.equal((await albumOf(HAIL)).status, MediaStatus.AVAILABLE);
      // Not monitored nor asked for: the artist is only partly here.
      assert.equal(
        (await artistOf(ARTIST)).status,
        MediaStatus.PARTIALLY_AVAILABLE
      );
      assert.equal(state.mb.calls, 0);
    });

    it('asks MusicBrainz about an id Lidarr does not know, as a release then as an album', async () => {
      state.plex.artists = [plexArtist('500', 'Radiohead', ARTIST)];
      state.plex.albums = [
        plexAlbum('600', 'Kid A', { guid: mbid(301) }),
        plexAlbum('601', 'Amnesiac', { guid: AMNESIAC }),
      ];
      state.mb.releases[mbid(301)] = KID_A;
      state.mb.groups[AMNESIAC] = ARTIST;

      await musicFullScan.run();

      assert.equal((await albumOf(KID_A)).ratingKey, '600');
      assert.equal((await albumOf(AMNESIAC)).ratingKey, '601');
      // One call for the release; two for the album (as a release first).
      assert.equal(state.mb.calls, 3);

      // What MusicBrainz said is kept: the next scan asks nothing.
      state.mb.calls = 0;
      cacheManager.getCache('musicbrainz').flush();
      await musicFullScan.run();
      assert.equal(state.mb.calls, 0);
      assert.equal((await albums()).length, 2);
    });

    it('finds folders from a track for an album no id places', async () => {
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [
        lidarrAlbum({
          id: 71,
          foreignAlbumId: AMNESIAC,
          title: 'Amnesiac',
          releaseDate: '2001-06-04',
          releases: [],
        }),
      ];
      state.plex.artists = [plexArtist('500', 'Radiohead (tagged badly)')];
      state.plex.albums = [plexAlbum('600', 'Amnesiac [Deluxe]')];
      state.plex.tracks['600'] = [
        {
          ratingKey: '6001',
          type: 'track',
          title: 'Packt Like Sardines',
          Media: [
            { Part: [{ file: '/music/Radiohead/Amnesiac (2001)/01.flac' }] },
          ],
        },
      ];

      await musicFullScan.run();

      const album = await albumOf(AMNESIAC);
      assert.equal(album.status, MediaStatus.AVAILABLE);
      assert.equal(album.folder, 'Amnesiac (2001)');
      assert.equal((await artistOf(ARTIST)).ratingKey, '500');
    });

    it('reads only what was added since the last scan', async () => {
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [lidarrAlbum()];
      state.plex.artists = [plexArtist('500', 'Radiohead', ARTIST)];
      const now = Math.floor(Date.now() / 1000);
      state.plex.albums = [
        plexAlbum('600', 'Hail', { guid: HAIL, addedAt: now }),
        plexAlbum('601', 'Old', { guid: KID_A, addedAt: now - 86400 * 30 }),
      ];
      state.mb.groups[KID_A] = ARTIST;

      await musicSync.run();

      assert.equal((await albums()).length, 1);
      assert.equal((await albumOf(HAIL)).ratingKey, '600');
      assert.ok(state.plex.asked.some((url) => url.includes('addedAt')));
      // The artist was read on its own, not the whole library.
      assert.ok(
        state.plex.asked.includes('/library/metadata/500?includeGuids=1')
      );
      assert.ok(getSettings().plex.musicLibraries[0].lastScan);
    });
  });

  it('runs one music scan at a time', async () => {
    state.lidarr.artists = [lidarrArtist()];
    state.lidarr.albums = [lidarrAlbum()];
    state.plex.artists = [plexArtist('500', 'Radiohead', ARTIST)];
    state.plex.albums = [plexAlbum('600', 'Hail', { guid: HAIL })];

    await Promise.all([musicFullScan.run(), musicSync.run()]);

    // The sync was left out: the full scan covered it.
    assert.ok(!state.plex.asked.some((url) => url.includes('addedAt')));
    assert.equal((await albums()).length, 1);
    assert.equal(musicSync.status().running, false);
    assert.equal(musicFullScan.status().running, false);
  });

  describe('Jellyfin and Emby', () => {
    it('reads the album’s ids from its tags, on both', async () => {
      connect('jellyfin', 'emby');
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [lidarrAlbum()];
      state.jellyfin.items = [
        jellyfinAlbum('jf-hail', 'Hail to the Thief', {
          ProviderIds: {
            MusicBrainzReleaseGroup: HAIL,
            MusicBrainzAlbumArtist: ARTIST,
          },
        }),
      ];
      state.emby.items = [
        // A release Lidarr lists, and the artist only by name.
        jellyfinAlbum('emby-hail', 'Hail to the Thief', {
          ProviderIds: { MusicBrainzAlbum: HAIL_RELEASE },
        }),
      ];

      await musicFullScan.run();

      const album = await albumOf(HAIL);
      assert.equal(album.status, MediaStatus.AVAILABLE);
      assert.equal(album.jellyfinItemId, 'jf-hail');
      assert.equal(album.embyItemId, 'emby-hail');
      assert.equal(album.ratingKey, null);
      const artist = await artistOf(ARTIST);
      assert.equal(artist.jellyfinMediaId, 'jf-hail-artist');
      assert.equal(artist.embyMediaId, 'emby-hail-artist');
      assert.equal((await albums()).length, 1);
      assert.equal(state.mb.calls, 0);

      // Where to play it: each server that has it.
      assert.deepEqual(
        albumPlayLinks([album]).map((link) => [link.server, link.url]),
        [
          [
            'jellyfin',
            'https://jellyfin.example.com/web/index.html#!/details?id=jf-hail&context=home&serverId=jellyfin-server',
          ],
          [
            'emby',
            'https://emby.example.com/web/index.html#!/item?id=emby-hail&context=home&serverId=emby-server',
          ],
        ]
      );
    });

    it('falls back to folders, then titles, and keeps what it cannot place', async () => {
      connect('jellyfin');
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [
        lidarrAlbum({ releases: [] }),
        lidarrAlbum({
          id: 72,
          foreignAlbumId: KID_A,
          title: 'Kid A',
          releaseDate: '2000-10-02',
          releases: [],
        }),
      ];
      state.jellyfin.items = [
        jellyfinAlbum('jf-1', 'Hail To The Thief (Special Edition)', {
          Path: '/music/Radiohead/Hail to the Thief (2003)',
        }),
        jellyfinAlbum('jf-2', 'Kid A', {
          Path: '/music/Radiohead/kida-rip',
          ProductionYear: 2000,
        }),
        jellyfinAlbum('jf-3', 'Live at the Astoria', {
          Path: '/music/Radiohead/Live at the Astoria',
          ProductionYear: 1994,
        }),
        // No ids, and a folder Lidarr does not know: skipped.
        jellyfinAlbum('jf-4', 'Somebody Else', {
          Path: '/music/Nobody/Somebody Else',
          AlbumArtists: [{ Name: 'Nobody', Id: 'nobody' }],
        }),
      ];

      await musicFullScan.run();

      assert.equal((await albumOf(HAIL)).jellyfinItemId, 'jf-1');
      assert.equal((await albumOf(KID_A)).jellyfinItemId, 'jf-2');
      const rows = await albums();
      const unplaced = rows.find((row) => !row.mbId);
      assert.equal(unplaced?.title, 'Live at the Astoria');
      assert.equal(unplaced?.status, MediaStatus.AVAILABLE);
      assert.equal(unplaced?.releaseDate, '1994');
      assert.equal(rows.length, 3);
    });

    it('reads only what was added since the last scan, newest first', async () => {
      connect('jellyfin');
      getSettings().jellyfin.musicLibraries[0].lastScan = Date.parse(
        '2026-10-10T00:00:00Z'
      );
      state.jellyfin.items = [
        jellyfinAlbum('jf-new', 'Hail to the Thief', {
          DateCreated: '2026-10-11T00:00:00Z',
          ProviderIds: {
            MusicBrainzReleaseGroup: HAIL,
            MusicBrainzAlbumArtist: ARTIST,
          },
        }),
        jellyfinAlbum('jf-old', 'Kid A', {
          DateCreated: '2026-01-01T00:00:00Z',
          ProviderIds: {
            MusicBrainzReleaseGroup: KID_A,
            MusicBrainzAlbumArtist: ARTIST,
          },
        }),
      ];

      await musicSync.run();

      assert.deepEqual(
        (await albums()).map((row) => row.mbId),
        [HAIL]
      );
      assert.ok(state.jellyfin.asked[0].includes('SortOrder=Descending'));
    });
  });

  describe('going down', () => {
    const onBoth = async () => {
      const media = await seedArtist(
        [
          {
            mbId: HAIL,
            status: MediaStatus.AVAILABLE,
            ratingKey: '600',
            jellyfinItemId: 'jf-hail',
          },
        ],
        {
          status: MediaStatus.AVAILABLE,
          ratingKey: '500',
          jellyfinMediaId: 'jf-artist',
        }
      );
      connect('plex', 'jellyfin');
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [lidarrAlbum()];
      return media;
    };

    it('keeps an album any server still has, and drops the others’ ids', async () => {
      await onBoth();
      state.plex.artists = [plexArtist('500', 'Radiohead', ARTIST)];
      state.plex.albums = [plexAlbum('600', 'Hail', { guid: HAIL })];

      await musicFullScan.run();

      const album = await albumOf(HAIL);
      assert.equal(album.status, MediaStatus.AVAILABLE);
      assert.equal(album.ratingKey, '600');
      assert.equal(album.jellyfinItemId, null);
      const artist = await artistOf(ARTIST);
      assert.equal(artist.ratingKey, '500');
      assert.equal(artist.jellyfinMediaId, null);
    });

    it('marks an album found nowhere deleted when it was asked for, else unknown', async () => {
      const media = await onBoth();
      await getRepository(MusicAlbum).insert(
        new MusicAlbum({
          mediaId: media.id,
          mbId: KID_A,
          title: 'Kid A',
          secondaryTypes: [],
          status: MediaStatus.AVAILABLE,
          ratingKey: '601',
        })
      );
      await seedRequest(
        media,
        [{ mbid: HAIL, title: 'Hail to the Thief' }],
        MediaRequestStatus.COMPLETED
      );

      await musicFullScan.run();

      const hail = await albumOf(HAIL);
      assert.equal(hail.status, MediaStatus.DELETED);
      assert.equal(hail.ratingKey, null);
      assert.equal(hail.jellyfinItemId, null);
      assert.equal((await albumOf(KID_A)).status, MediaStatus.UNKNOWN);
      const artist = await artistOf(ARTIST);
      assert.equal(artist.status, MediaStatus.DELETED);
      assert.equal(artist.ratingKey, null);
    });

    it('keeps an album Lidarr has files for', async () => {
      await onBoth();
      state.lidarr.albums = [
        lidarrAlbum({
          statistics: {
            trackCount: 14,
            trackFileCount: 14,
            totalTrackCount: 14,
            sizeOnDisk: 1,
            percentOfTracks: 100,
          },
        }),
      ];

      await musicFullScan.run();

      assert.equal((await albumOf(HAIL)).status, MediaStatus.AVAILABLE);
    });

    for (const silent of ['plex', 'jellyfin', 'lidarr'] as const) {
      it(`marks nothing gone when ${silent} does not answer`, async () => {
        await onBoth();
        state[silent].up = false;

        await musicFullScan.run();

        const album = await albumOf(HAIL);
        assert.equal(album.status, MediaStatus.AVAILABLE);
        assert.equal(album.ratingKey, '600');
        assert.equal(album.jellyfinItemId, 'jf-hail');
      });
    }

    it('never lowers anything on a recent scan', async () => {
      await onBoth();

      await musicSync.run();

      const album = await albumOf(HAIL);
      assert.equal(album.status, MediaStatus.AVAILABLE);
      assert.equal(album.ratingKey, '600');
    });
  });

  describe('Lidarr only', () => {
    beforeEach(() => {
      const settings = getSettings();
      settings.plex.musicLibraries[0].enabled = false;
      settings.jellyfin.musicLibraries[0].enabled = false;
    });

    const stats = (trackFileCount: number) => ({
      trackCount: 10,
      trackFileCount,
      totalTrackCount: 10,
      sizeOnDisk: trackFileCount,
      percentOfTracks: trackFileCount * 10,
    });

    it('lets Lidarr’s files decide while no music library is on', async () => {
      const media = await seedArtist([
        { mbId: HAIL, title: 'Hail to the Thief' },
        { mbId: KID_A, title: 'Kid A' },
      ]);
      await seedRequest(media, [
        { mbid: HAIL, title: 'Hail to the Thief' },
        { mbid: KID_A, title: 'Kid A' },
      ]);
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [
        lidarrAlbum({ monitored: true, statistics: stats(10) }),
        lidarrAlbum({
          id: 72,
          foreignAlbumId: KID_A,
          title: 'Kid A',
          monitored: true,
          releases: [],
          statistics: stats(4),
        }),
      ];

      await musicSync.run();

      assert.deepEqual(state.plex.asked, []);
      const hail = await albumOf(HAIL);
      assert.equal(hail.status, MediaStatus.AVAILABLE);
      assert.equal(hail.trackFileCount, 10);
      assert.equal(
        (await albumOf(KID_A)).status,
        MediaStatus.PARTIALLY_AVAILABLE
      );
      assert.equal(
        (await artistOf(ARTIST)).status,
        MediaStatus.PARTIALLY_AVAILABLE
      );

      // Lidarr loses the files: the full scan takes the album down.
      state.lidarr.albums[0].statistics = stats(0);
      await musicFullScan.run();
      assert.equal((await albumOf(HAIL)).status, MediaStatus.DELETED);
    });

    it('leaves an album Lidarr has files for processing while a server has music on', async () => {
      getSettings().plex.musicLibraries[0].enabled = true;
      const media = await seedArtist([{ mbId: HAIL }]);
      await seedRequest(media, [{ mbid: HAIL, title: 'Hail to the Thief' }]);
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [
        lidarrAlbum({ monitored: true, statistics: stats(10) }),
      ];

      await musicSync.run();

      const hail = await albumOf(HAIL);
      assert.equal(hail.status, MediaStatus.PROCESSING);
      assert.equal(hail.trackFileCount, 10);
    });
  });

  it(`asks MusicBrainz at most ${MB_CALL_CAP} times a run, and leaves the rest for the next`, async () => {
    const extra = 5;
    state.plex.artists = [plexArtist('500', 'Radiohead', ARTIST)];
    for (let i = 0; i < MB_CALL_CAP + extra; i++) {
      const release = mbid(10_000 + i);
      state.mb.releases[release] = mbid(20_000 + i);
      state.plex.albums.push(
        plexAlbum(String(1000 + i), `Album ${i}`, { guid: release })
      );
    }

    await musicFullScan.run();

    assert.equal(state.mb.calls, MB_CALL_CAP);
    // Nothing is kept unplaced for want of an answer.
    const rows = await albums();
    assert.equal(rows.length, MB_CALL_CAP);
    assert.ok(rows.every((row) => row.mbId));

    state.mb.calls = 0;
    await musicFullScan.run();
    assert.equal(state.mb.calls, extra);
    assert.equal((await albums()).length, MB_CALL_CAP + extra);
    assert.equal(
      await getRepository(MusicMetadata).countBy({}),
      MB_CALL_CAP + extra
    );
  });

  describe('Lidarr’s work on requests', () => {
    it('monitors and adds requested albums Lidarr did not take', async () => {
      const media = await seedArtist([
        { mbId: HAIL },
        { mbId: KID_A },
        { mbId: OK_COMPUTER },
      ]);
      await seedRequest(media, [
        { mbid: HAIL, title: 'Hail to the Thief' },
        { mbid: KID_A, title: 'Kid A' },
        { mbid: OK_COMPUTER, title: 'OK Computer' },
      ]);
      // Someone else asked for two of them too: each is sent once.
      await seedRequest(media, [
        { mbid: HAIL, title: 'Hail to the Thief' },
        { mbid: KID_A, title: 'Kid A' },
      ]);
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [
        lidarrAlbum({ monitored: false }),
        lidarrAlbum({
          id: 74,
          foreignAlbumId: OK_COMPUTER,
          monitored: true,
          releases: [],
        }),
      ];
      state.lidarr.lookups[KID_A] = lidarrAlbum({
        id: 0,
        foreignAlbumId: KID_A,
        title: 'Kid A',
        releases: [],
      });

      await musicSync.run();

      assert.deepEqual(state.lidarr.monitored, [[70]]);
      assert.deepEqual(state.lidarr.commands, [
        { name: 'AlbumSearch', albumIds: [70] },
      ]);
      assert.equal(state.lidarr.added.length, 1);
      assert.equal(
        (state.lidarr.added[0] as { foreignAlbumId: string }).foreignAlbumId,
        KID_A
      );
      assert.deepEqual(state.lidarr.added[0].artist, { id: 7 });
      assert.deepEqual(state.lidarr.added[0].addOptions, {
        searchForNewAlbum: true,
      });
      // Lidarr's ids are kept on the albums.
      assert.equal((await albumOf(HAIL)).lidarrAlbumId, 70);
      assert.equal((await albumOf(KID_A)).lidarrAlbumId, 901);
    });

    it('fails a request after a week of Lidarr not knowing an album', async () => {
      const media = await seedArtist([{ mbId: IN_RAINBOWS }]);
      const recent = await seedRequest(media, [
        { mbid: IN_RAINBOWS, title: 'In Rainbows' },
      ]);
      state.lidarr.artists = [lidarrArtist()];

      await musicSync.run();
      assert.equal(
        (await getRepository(MediaRequest).findOneByOrFail({ id: recent.id }))
          .status,
        MediaRequestStatus.APPROVED
      );

      const old = await seedRequest(
        media,
        [{ mbid: IN_RAINBOWS, title: 'In Rainbows' }],
        MediaRequestStatus.APPROVED,
        new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
      );
      await musicSync.run();
      assert.equal(
        (await getRepository(MediaRequest).findOneByOrFail({ id: old.id }))
          .status,
        MediaRequestStatus.FAILED
      );
      assert.deepEqual(state.lidarr.added, []);
    });
  });

  it('brings in the library of a Lidarr with Scan on', async () => {
    getSettings().lidarr = [lidarrServer({ syncEnabled: true })];
    getSettings().plex.musicLibraries[0].enabled = false;
    state.lidarr.artists = [
      lidarrArtist(),
      lidarrArtist({ id: 8, foreignArtistId: OTHER_ARTIST, artistName: 'X' }),
    ];
    state.lidarr.albums = [
      lidarrAlbum({ monitored: true }),
      lidarrAlbum({
        id: 72,
        foreignAlbumId: KID_A,
        title: 'Kid A',
        releases: [],
      }),
      lidarrAlbum({
        id: 80,
        artistId: 8,
        foreignAlbumId: OK_COMPUTER,
        releases: [],
      }),
    ];

    await musicFullScan.run();

    // Only what Lidarr monitors or has files for.
    assert.deepEqual(
      (await albums()).map((row) => [row.mbId, row.status]),
      [[HAIL, MediaStatus.PROCESSING]]
    );
    const artist = await artistOf(ARTIST);
    assert.equal(artist.status, MediaStatus.PROCESSING);
    assert.equal(artist.foreignTitle, 'Radiohead');
    assert.equal(artist.externalServiceId, 7);
    assert.equal(
      artist.serviceUrl,
      `https://lidarr.example.com/artist/${ARTIST}`
    );
    assert.equal(
      await getRepository(Media).countBy({ foreignId: OTHER_ARTIST }),
      0
    );
  });

  describe('closing the loop', () => {
    const sent: { type: Notification; payload: NotificationPayload }[] = [];

    beforeEach(() => {
      sent.length = 0;
      mock.method(
        notificationManager,
        'sendNotification',
        (type: Notification, payload: NotificationPayload) => {
          sent.push({ type, payload });
        }
      );
    });

    afterEach(() => {
      mock.restoreAll();
      for (const held of downloadTracker.heldMusicImports()) {
        downloadTracker.forgetImportedAlbum(held.serverId, held.albumId);
      }
    });

    const history = async () =>
      (
        await getRepository(MediaEvent).find({
          where: { foreignId: ARTIST },
          order: { id: 'ASC' },
        })
      ).map((event) => [event.type, event.detail]);

    it('keeps the artist’s name: Lidarr’s, or the server’s until Lidarr knows them', async () => {
      state.plex.artists = [plexArtist('500', 'Radiohead', ARTIST)];
      state.plex.albums = [
        plexAlbum('601', 'Amnesiac', {
          guid: AMNESIAC,
          artistName: 'Radiohead (tagged)',
        }),
      ];
      state.mb.groups[AMNESIAC] = ARTIST;

      await musicFullScan.run();
      assert.equal((await artistOf(ARTIST)).foreignTitle, 'Radiohead (tagged)');

      // A server's name never replaces one known.
      state.plex.albums[0].parentTitle = 'Someone Else';
      await musicFullScan.run();
      assert.equal((await artistOf(ARTIST)).foreignTitle, 'Radiohead (tagged)');

      // Lidarr's, MusicBrainz's own, does.
      state.lidarr.artists = [lidarrArtist()];
      await musicFullScan.run();
      assert.equal((await artistOf(ARTIST)).foreignTitle, 'Radiohead');
    });

    it('completes a request once its albums are here, says so once, and writes it down', async () => {
      const media = await seedArtist([
        { mbId: HAIL, title: 'Hail to the Thief' },
      ]);
      const request = await seedRequest(media, [
        { mbid: HAIL, title: 'Hail to the Thief' },
      ]);
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [lidarrAlbum({ monitored: true })];
      state.plex.artists = [plexArtist('500', 'Radiohead', ARTIST)];
      state.plex.albums = [plexAlbum('600', 'Hail', { guid: HAIL_RELEASE })];

      await musicFullScan.run();
      await musicSync.run();
      await musicFullScan.run();

      assert.equal(
        (await getRepository(MediaRequest).findOneByOrFail({ id: request.id }))
          .status,
        MediaRequestStatus.COMPLETED
      );
      const available = sent.filter(
        (s) => s.type === Notification.MEDIA_AVAILABLE
      );
      assert.equal(available.length, 1);
      // The artist's name, kept from Lidarr by the scan.
      assert.equal(
        available[0].payload.subject,
        'Hail to the Thief — Radiohead'
      );
      assert.deepEqual(await history(), [['available', 'Hail to the Thief']]);
    });

    it('writes an album leaving into its artist’s history', async () => {
      await seedArtist(
        [
          {
            mbId: HAIL,
            title: 'Hail to the Thief',
            status: MediaStatus.AVAILABLE,
          },
        ],
        { status: MediaStatus.AVAILABLE }
      );
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [lidarrAlbum()];

      await musicFullScan.run();

      assert.equal((await albumOf(HAIL)).status, MediaStatus.UNKNOWN);
      assert.deepEqual(await history(), [['removed', 'Hail to the Thief']]);
    });

    it('stops showing an import as being added once the album is here', async () => {
      const media = await seedArtist([
        { mbId: HAIL, title: 'Hail to the Thief', lidarrAlbumId: 70 },
      ]);
      await seedRequest(media, [{ mbid: HAIL, title: 'Hail to the Thief' }]);
      (
        downloadTracker as unknown as {
          hold: (
            kind: string,
            serverId: number,
            item: Record<string, unknown>,
            now: number
          ) => void;
        }
      ).hold(
        'music',
        0,
        {
          externalId: 7,
          downloadId: 'hail',
          album: { id: 70, title: 'Hail to the Thief', foreignAlbumId: HAIL },
          stage: 'importing',
          size: 1,
          sizeLeft: 0,
        },
        Date.now() - 1000
      );
      assert.equal(downloadTracker.getMusicProgress(0, 7).length, 1);

      // Not here yet: still shown.
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [lidarrAlbum({ monitored: true })];
      await musicSync.run();
      assert.equal(downloadTracker.getMusicProgress(0, 7).length, 1);

      state.plex.artists = [plexArtist('500', 'Radiohead', ARTIST)];
      state.plex.albums = [plexAlbum('600', 'Hail', { guid: HAIL_RELEASE })];
      await musicFullScan.run();
      assert.deepEqual(downloadTracker.getMusicProgress(0, 7), []);
    });
  });
});
