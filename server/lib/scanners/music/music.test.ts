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
import SongRequest from '@server/entity/SongRequest';
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
const SING = mbid(101);
const SING_RELEASE = mbid(201);
const FOG_B = mbid(102);
const SOMNOLENT = mbid(103);
const STATIC_GARDEN = mbid(104);
const IN_LANTERNS = mbid(105);

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
          'artist-credit': [{ name: 'Glasswing', artist: { id: artist } }],
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
  artistName: 'Glasswing',
  foreignArtistId: ARTIST,
  monitored: true,
  qualityProfileId: 1,
  metadataProfileId: 1,
  tags: [],
  path: '/music/Glasswing',
  ...over,
});

const lidarrAlbum = (over: Partial<LidarrAlbum> = {}): LidarrAlbum => ({
  id: 70,
  title: 'Sing to the Ferryman',
  foreignAlbumId: SING,
  artistId: 7,
  monitored: false,
  albumType: 'Album',
  secondaryTypes: [],
  releaseDate: '2003-06-09T00:00:00Z',
  releases: [
    {
      id: 1,
      albumId: 70,
      foreignReleaseId: SING_RELEASE,
      title: 'Sing to the Ferryman',
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
    artistName = 'Glasswing',
    guid,
    year,
    addedAt = 1_700_000_000,
    leafCount,
  }: {
    artist?: string;
    artistName?: string;
    guid?: string;
    year?: number;
    addedAt?: number;
    leafCount?: number;
  } = {}
): PlexMusicItem => ({
  ratingKey,
  parentRatingKey: artist,
  parentTitle: artistName,
  type: 'album',
  title,
  year,
  addedAt,
  leafCount,
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
  AlbumArtists: [{ Name: 'Glasswing', Id: `${id}-artist` }],
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
    state.plex.albums = [plexAlbum('600', 'Sing to the Ferryman')];

    await musicFullScan.run();

    assert.deepEqual(state.plex.asked, []);
    assert.equal((await albums()).length, 0);
  });

  describe('Plex', () => {
    it('places an album whose id is a release Lidarr lists, asking MusicBrainz nothing', async () => {
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [lidarrAlbum({ monitored: true })];
      state.plex.artists = [plexArtist('500', 'Glasswing', ARTIST)];
      state.plex.albums = [plexAlbum('600', 'Sing', { guid: SING_RELEASE })];

      await musicFullScan.run();

      const album = await albumOf(SING);
      assert.equal(album.status, MediaStatus.AVAILABLE);
      assert.equal(album.ratingKey, '600');
      assert.equal(album.title, 'Sing to the Ferryman');
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
      state.plex.artists = [plexArtist('500', 'Glasswing', ARTIST)];
      state.plex.albums = [plexAlbum('600', 'Sing', { guid: SING })];

      await musicFullScan.run();

      assert.equal((await albumOf(SING)).status, MediaStatus.AVAILABLE);
      // Not monitored nor asked for: the artist is only partly here.
      assert.equal(
        (await artistOf(ARTIST)).status,
        MediaStatus.PARTIALLY_AVAILABLE
      );
      assert.equal(state.mb.calls, 0);
    });

    it('places an album songs were taken from as only partly here', async () => {
      state.lidarr.artists = [lidarrArtist()];
      // Unmonitored, with one of its 14 tracks on file: as real Lidarr
      // says, its track count is then only the one with a file.
      state.lidarr.albums = [
        lidarrAlbum({
          statistics: {
            trackCount: 1,
            trackFileCount: 1,
            totalTrackCount: 14,
            sizeOnDisk: 40_000_000,
            percentOfTracks: 7,
          },
        }),
      ];
      state.plex.artists = [plexArtist('500', 'Glasswing', ARTIST)];
      state.plex.albums = [plexAlbum('600', 'Sing', { guid: SING })];

      await musicFullScan.run();

      assert.equal(
        (await albumOf(SING)).status,
        MediaStatus.PARTIALLY_AVAILABLE
      );
    });

    it('corrects an album songs were taken from that was marked available', async () => {
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [
        lidarrAlbum({
          statistics: {
            trackCount: 1,
            trackFileCount: 1,
            totalTrackCount: 14,
            sizeOnDisk: 40_000_000,
            percentOfTracks: 7,
          },
        }),
      ];
      state.plex.artists = [plexArtist('500', 'Glasswing', ARTIST)];
      state.plex.albums = [
        plexAlbum('600', 'Sing', { guid: SING, leafCount: 1 }),
      ];
      await musicFullScan.run();
      // As an earlier version left it.
      await getRepository(MusicAlbum).update(
        { mbId: SING },
        { status: MediaStatus.AVAILABLE }
      );
      const history = await getRepository(MediaEvent).count();

      await musicFullScan.run();

      assert.equal(
        (await albumOf(SING)).status,
        MediaStatus.PARTIALLY_AVAILABLE
      );
      assert.equal(
        await getRepository(MediaEvent).count(),
        history,
        'nothing in the artist’s history'
      );

      // Plex listing every track of it: here after all.
      state.plex.albums = [
        plexAlbum('600', 'Sing', { guid: SING, leafCount: 14 }),
      ];
      await musicFullScan.run();
      assert.equal((await albumOf(SING)).status, MediaStatus.AVAILABLE);
    });

    it('asks MusicBrainz about an id Lidarr does not know, as a release then as an album', async () => {
      state.plex.artists = [plexArtist('500', 'Glasswing', ARTIST)];
      state.plex.albums = [
        plexAlbum('600', 'Fog B', { guid: mbid(301) }),
        plexAlbum('601', 'Somnolent', { guid: SOMNOLENT }),
      ];
      state.mb.releases[mbid(301)] = FOG_B;
      state.mb.groups[SOMNOLENT] = ARTIST;

      await musicFullScan.run();

      assert.equal((await albumOf(FOG_B)).ratingKey, '600');
      assert.equal((await albumOf(SOMNOLENT)).ratingKey, '601');
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
          foreignAlbumId: SOMNOLENT,
          title: 'Somnolent',
          releaseDate: '2001-06-04',
          releases: [],
        }),
      ];
      state.plex.artists = [plexArtist('500', 'Glasswing (tagged badly)')];
      state.plex.albums = [plexAlbum('600', 'Somnolent [Deluxe]')];
      state.plex.tracks['600'] = [
        {
          ratingKey: '6001',
          type: 'track',
          title: 'Stackt Like Herrings',
          Media: [
            { Part: [{ file: '/music/Glasswing/Somnolent (2001)/01.flac' }] },
          ],
        },
      ];

      await musicFullScan.run();

      const album = await albumOf(SOMNOLENT);
      assert.equal(album.status, MediaStatus.AVAILABLE);
      assert.equal(album.folder, 'Somnolent (2001)');
      assert.equal((await artistOf(ARTIST)).ratingKey, '500');
    });

    it('reads only what was added since the last scan', async () => {
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [lidarrAlbum()];
      state.plex.artists = [plexArtist('500', 'Glasswing', ARTIST)];
      const now = Math.floor(Date.now() / 1000);
      state.plex.albums = [
        plexAlbum('600', 'Sing', { guid: SING, addedAt: now }),
        plexAlbum('601', 'Old', { guid: FOG_B, addedAt: now - 86400 * 30 }),
      ];
      state.mb.groups[FOG_B] = ARTIST;

      await musicSync.run();

      assert.equal((await albums()).length, 1);
      assert.equal((await albumOf(SING)).ratingKey, '600');
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
    state.plex.artists = [plexArtist('500', 'Glasswing', ARTIST)];
    state.plex.albums = [plexAlbum('600', 'Sing', { guid: SING })];

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
        jellyfinAlbum('jf-sing', 'Sing to the Ferryman', {
          ProviderIds: {
            MusicBrainzReleaseGroup: SING,
            MusicBrainzAlbumArtist: ARTIST,
          },
        }),
      ];
      state.emby.items = [
        // A release Lidarr lists, and the artist only by name.
        jellyfinAlbum('emby-sing', 'Sing to the Ferryman', {
          ProviderIds: { MusicBrainzAlbum: SING_RELEASE },
        }),
      ];

      await musicFullScan.run();

      const album = await albumOf(SING);
      assert.equal(album.status, MediaStatus.AVAILABLE);
      assert.equal(album.jellyfinItemId, 'jf-sing');
      assert.equal(album.embyItemId, 'emby-sing');
      assert.equal(album.ratingKey, null);
      const artist = await artistOf(ARTIST);
      assert.equal(artist.jellyfinMediaId, 'jf-sing-artist');
      assert.equal(artist.embyMediaId, 'emby-sing-artist');
      assert.equal((await albums()).length, 1);
      assert.equal(state.mb.calls, 0);

      // Where to play it: each server that has it.
      assert.deepEqual(
        albumPlayLinks([album]).map((link) => [link.server, link.url]),
        [
          [
            'jellyfin',
            'https://jellyfin.example.com/web/index.html#!/details?id=jf-sing&context=home&serverId=jellyfin-server',
          ],
          [
            'emby',
            'https://emby.example.com/web/index.html#!/item?id=emby-sing&context=home&serverId=emby-server',
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
          foreignAlbumId: FOG_B,
          title: 'Fog B',
          releaseDate: '2000-10-02',
          releases: [],
        }),
      ];
      state.jellyfin.items = [
        jellyfinAlbum('jf-1', 'Sing To The Ferryman (Special Edition)', {
          Path: '/music/Glasswing/Sing to the Ferryman (2003)',
        }),
        jellyfinAlbum('jf-2', 'Fog B', {
          Path: '/music/Glasswing/fogb-rip',
          ProductionYear: 2000,
        }),
        jellyfinAlbum('jf-3', 'Live at the Larkfield', {
          Path: '/music/Glasswing/Live at the Larkfield',
          ProductionYear: 1994,
        }),
        // No ids, and a folder Lidarr does not know: skipped.
        jellyfinAlbum('jf-4', 'Somebody Else', {
          Path: '/music/Nobody/Somebody Else',
          AlbumArtists: [{ Name: 'Nobody', Id: 'nobody' }],
        }),
      ];

      await musicFullScan.run();

      assert.equal((await albumOf(SING)).jellyfinItemId, 'jf-1');
      assert.equal((await albumOf(FOG_B)).jellyfinItemId, 'jf-2');
      const rows = await albums();
      const unplaced = rows.find((row) => !row.mbId);
      assert.equal(unplaced?.title, 'Live at the Larkfield');
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
        jellyfinAlbum('jf-new', 'Sing to the Ferryman', {
          DateCreated: '2026-10-11T00:00:00Z',
          ProviderIds: {
            MusicBrainzReleaseGroup: SING,
            MusicBrainzAlbumArtist: ARTIST,
          },
        }),
        jellyfinAlbum('jf-old', 'Fog B', {
          DateCreated: '2026-01-01T00:00:00Z',
          ProviderIds: {
            MusicBrainzReleaseGroup: FOG_B,
            MusicBrainzAlbumArtist: ARTIST,
          },
        }),
      ];

      await musicSync.run();

      assert.deepEqual(
        (await albums()).map((row) => row.mbId),
        [SING]
      );
      assert.ok(state.jellyfin.asked[0].includes('SortOrder=Descending'));
    });
  });

  describe('going down', () => {
    const onBoth = async () => {
      const media = await seedArtist(
        [
          {
            mbId: SING,
            status: MediaStatus.AVAILABLE,
            ratingKey: '600',
            jellyfinItemId: 'jf-sing',
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
      state.plex.artists = [plexArtist('500', 'Glasswing', ARTIST)];
      state.plex.albums = [plexAlbum('600', 'Sing', { guid: SING })];

      await musicFullScan.run();

      const album = await albumOf(SING);
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
          mbId: FOG_B,
          title: 'Fog B',
          secondaryTypes: [],
          status: MediaStatus.AVAILABLE,
          ratingKey: '601',
        })
      );
      await seedRequest(
        media,
        [{ mbid: SING, title: 'Sing to the Ferryman' }],
        MediaRequestStatus.COMPLETED
      );

      await musicFullScan.run();

      const sing = await albumOf(SING);
      assert.equal(sing.status, MediaStatus.DELETED);
      assert.equal(sing.ratingKey, null);
      assert.equal(sing.jellyfinItemId, null);
      assert.equal((await albumOf(FOG_B)).status, MediaStatus.UNKNOWN);
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

      assert.equal((await albumOf(SING)).status, MediaStatus.AVAILABLE);
    });

    for (const silent of ['plex', 'jellyfin', 'lidarr'] as const) {
      it(`marks nothing gone when ${silent} does not answer`, async () => {
        await onBoth();
        state[silent].up = false;

        await musicFullScan.run();

        const album = await albumOf(SING);
        assert.equal(album.status, MediaStatus.AVAILABLE);
        assert.equal(album.ratingKey, '600');
        assert.equal(album.jellyfinItemId, 'jf-sing');
      });
    }

    it('never lowers anything on a recent scan', async () => {
      await onBoth();

      await musicSync.run();

      const album = await albumOf(SING);
      assert.equal(album.status, MediaStatus.AVAILABLE);
      assert.equal(album.ratingKey, '600');
    });

    it('keeps an album a server still lists when MusicBrainz cannot be asked', async () => {
      const group = mbid(301);
      state.mb.groups[group] = ARTIST;
      state.plex.artists = [plexArtist('500', 'Glasswing', ARTIST)];
      state.plex.albums = [plexAlbum('600', 'Some Album', { guid: group })];

      await musicFullScan.run();
      assert.equal((await albumOf(group)).status, MediaStatus.AVAILABLE);

      // The kept answer has been pruned, and MusicBrainz does not answer
      // during this full scan.
      await getRepository(MusicMetadata).clear();
      cacheManager.getCache('musicbrainz').flush();
      getSettings().music.musicbrainzUrl = 'http://127.0.0.1:1';

      await musicFullScan.run();

      const album = await albumOf(group);
      assert.equal(album.status, MediaStatus.AVAILABLE);
      assert.equal(album.ratingKey, '600');
      assert.equal((await artistOf(ARTIST)).ratingKey, '500');
    });

    it('keeps an album a server still lists whose artist it cannot tell this time', async () => {
      await seedArtist(
        [{ mbId: SING, status: MediaStatus.AVAILABLE, ratingKey: '600' }],
        { status: MediaStatus.AVAILABLE, ratingKey: '500' }
      );
      // Plex lists the same album, but with no ids and under a name
      // Lidarr does not know.
      state.plex.artists = [plexArtist('500', 'Someone Else')];
      state.plex.albums = [
        plexAlbum('600', 'Sing to the Ferryman', {
          artistName: 'Someone Else',
        }),
      ];

      await musicFullScan.run();

      const album = await albumOf(SING);
      assert.equal(album.status, MediaStatus.AVAILABLE);
      assert.equal(album.ratingKey, '600');
      assert.equal((await artistOf(ARTIST)).ratingKey, '500');
    });

    it('marks nothing gone while an album waits for MusicBrainz', async () => {
      await seedArtist(
        [{ mbId: SING, status: MediaStatus.AVAILABLE, ratingKey: '600' }],
        { status: MediaStatus.AVAILABLE, ratingKey: '500' }
      );
      // The server lists the album under a new id, which only MusicBrainz
      // could place, and MusicBrainz does not answer.
      getSettings().music.musicbrainzUrl = 'http://127.0.0.1:1';
      state.plex.artists = [plexArtist('500', 'Glasswing', ARTIST)];
      state.plex.albums = [
        plexAlbum('700', 'Sing to the Ferryman', { guid: SING_RELEASE }),
      ];

      await musicFullScan.run();

      const album = await albumOf(SING);
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
        { mbId: SING, title: 'Sing to the Ferryman' },
        { mbId: FOG_B, title: 'Fog B' },
      ]);
      await seedRequest(media, [
        { mbid: SING, title: 'Sing to the Ferryman' },
        { mbid: FOG_B, title: 'Fog B' },
      ]);
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [
        lidarrAlbum({ monitored: true, statistics: stats(10) }),
        lidarrAlbum({
          id: 72,
          foreignAlbumId: FOG_B,
          title: 'Fog B',
          monitored: true,
          releases: [],
          statistics: stats(4),
        }),
      ];

      await musicSync.run();

      assert.deepEqual(state.plex.asked, []);
      const sing = await albumOf(SING);
      assert.equal(sing.status, MediaStatus.AVAILABLE);
      assert.equal(sing.trackFileCount, 10);
      assert.equal(
        (await albumOf(FOG_B)).status,
        MediaStatus.PARTIALLY_AVAILABLE
      );
      assert.equal(
        (await artistOf(ARTIST)).status,
        MediaStatus.PARTIALLY_AVAILABLE
      );

      // Lidarr loses the files: the full scan takes the album down.
      state.lidarr.albums[0].statistics = stats(0);
      await musicFullScan.run();
      assert.equal((await albumOf(SING)).status, MediaStatus.DELETED);
    });

    it('counts one song taken from an album as only part of it, with no music library', async () => {
      const media = await seedArtist([
        { mbId: SING, title: 'Sing to the Ferryman' },
      ]);
      await seedRequest(media, [{ mbid: SING, title: 'Sing to the Ferryman' }]);
      state.lidarr.artists = [lidarrArtist()];
      // Unmonitored, one of its ten on file: Lidarr says 1 track, 1 file.
      state.lidarr.albums = [
        lidarrAlbum({
          monitored: false,
          statistics: {
            trackCount: 1,
            trackFileCount: 1,
            totalTrackCount: 10,
            sizeOnDisk: 1,
            percentOfTracks: 100,
          },
        }),
      ];

      await musicSync.run();

      assert.equal(
        (await albumOf(SING)).status,
        MediaStatus.PARTIALLY_AVAILABLE
      );
    });

    it('leaves an album Lidarr has files for processing while a server has music on', async () => {
      getSettings().plex.musicLibraries[0].enabled = true;
      const media = await seedArtist([{ mbId: SING }]);
      await seedRequest(media, [{ mbid: SING, title: 'Sing to the Ferryman' }]);
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [
        lidarrAlbum({ monitored: true, statistics: stats(10) }),
      ];

      await musicSync.run();

      const sing = await albumOf(SING);
      assert.equal(sing.status, MediaStatus.PROCESSING);
      assert.equal(sing.trackFileCount, 10);
    });
  });

  it(`asks MusicBrainz at most ${MB_CALL_CAP} times a run, and leaves the rest for the next`, async () => {
    const extra = 5;
    state.plex.artists = [plexArtist('500', 'Glasswing', ARTIST)];
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
        { mbId: SING },
        { mbId: FOG_B },
        { mbId: STATIC_GARDEN },
      ]);
      await seedRequest(media, [
        { mbid: SING, title: 'Sing to the Ferryman' },
        { mbid: FOG_B, title: 'Fog B' },
        { mbid: STATIC_GARDEN, title: 'Static Garden' },
      ]);
      // Someone else asked for two of them too: each is sent once.
      await seedRequest(media, [
        { mbid: SING, title: 'Sing to the Ferryman' },
        { mbid: FOG_B, title: 'Fog B' },
      ]);
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [
        lidarrAlbum({ monitored: false }),
        lidarrAlbum({
          id: 74,
          foreignAlbumId: STATIC_GARDEN,
          monitored: true,
          releases: [],
        }),
      ];
      state.lidarr.lookups[FOG_B] = lidarrAlbum({
        id: 0,
        foreignAlbumId: FOG_B,
        title: 'Fog B',
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
        FOG_B
      );
      // The artist as Lidarr has it: Lidarr refuses an album without.
      assert.deepEqual(state.lidarr.added[0].artist, state.lidarr.artists[0]);
      assert.deepEqual(state.lidarr.added[0].addOptions, {
        searchForNewAlbum: true,
      });
      // Lidarr's ids are kept on the albums.
      assert.equal((await albumOf(SING)).lidarrAlbumId, 70);
      assert.equal((await albumOf(FOG_B)).lidarrAlbumId, 901);
    });

    it('adds the single a song asked for is fetched through', async () => {
      const SINGLE = '6b2e9c41-7d38-3f05-a6e1-0c4d8b7f2a93';
      const media = await seedArtist([{ mbId: SINGLE }]);
      const request = await seedRequest(media, []);
      await getRepository(SongRequest).save(
        new SongRequest({
          request,
          recordingMbid: 'a1b2c3d4-0002-4000-8000-000000000002',
          title: 'Lantern Song',
          version: 'radio edit',
          length: null,
          albumMbid: SINGLE,
          albumTitle: 'Lantern Song',
          singleMbid: SINGLE,
          singleTitle: 'Lantern Song',
          releaseGroups: [SINGLE],
          status: MediaRequestStatus.APPROVED,
        })
      );
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [];
      state.lidarr.lookups[SINGLE] = lidarrAlbum({
        id: 0,
        foreignAlbumId: SINGLE,
        title: 'Lantern Song',
        releases: [],
      });

      await musicSync.run();

      assert.equal(state.lidarr.added.length, 1);
      assert.equal(
        (state.lidarr.added[0] as { foreignAlbumId: string }).foreignAlbumId,
        SINGLE
      );
      // The artist as Lidarr has it: Lidarr refuses an album without.
      assert.deepEqual(state.lidarr.added[0].artist, state.lidarr.artists[0]);
    });

    it('fails a request after a week of Lidarr not knowing an album', async () => {
      const media = await seedArtist([{ mbId: IN_LANTERNS }]);
      const recent = await seedRequest(media, [
        { mbid: IN_LANTERNS, title: 'In Lanterns' },
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
        [{ mbid: IN_LANTERNS, title: 'In Lanterns' }],
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
        foreignAlbumId: FOG_B,
        title: 'Fog B',
        releases: [],
      }),
      lidarrAlbum({
        id: 80,
        artistId: 8,
        foreignAlbumId: STATIC_GARDEN,
        releases: [],
      }),
    ];

    await musicFullScan.run();

    // Only what Lidarr monitors or has files for.
    assert.deepEqual(
      (await albums()).map((row) => [row.mbId, row.status]),
      [[SING, MediaStatus.PROCESSING]]
    );
    const artist = await artistOf(ARTIST);
    assert.equal(artist.status, MediaStatus.PROCESSING);
    assert.equal(artist.foreignTitle, 'Glasswing');
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
      state.plex.artists = [plexArtist('500', 'Glasswing', ARTIST)];
      state.plex.albums = [
        plexAlbum('601', 'Somnolent', {
          guid: SOMNOLENT,
          artistName: 'Glasswing (tagged)',
        }),
      ];
      state.mb.groups[SOMNOLENT] = ARTIST;

      await musicFullScan.run();
      assert.equal((await artistOf(ARTIST)).foreignTitle, 'Glasswing (tagged)');

      // A server's name never replaces one known.
      state.plex.albums[0].parentTitle = 'Someone Else';
      await musicFullScan.run();
      assert.equal((await artistOf(ARTIST)).foreignTitle, 'Glasswing (tagged)');

      // Lidarr's, MusicBrainz's own, does.
      state.lidarr.artists = [lidarrArtist()];
      await musicFullScan.run();
      assert.equal((await artistOf(ARTIST)).foreignTitle, 'Glasswing');
    });

    it('completes a request once its albums are here, says so once, and writes it down', async () => {
      const media = await seedArtist([
        { mbId: SING, title: 'Sing to the Ferryman' },
      ]);
      const request = await seedRequest(media, [
        { mbid: SING, title: 'Sing to the Ferryman' },
      ]);
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [lidarrAlbum({ monitored: true })];
      state.plex.artists = [plexArtist('500', 'Glasswing', ARTIST)];
      state.plex.albums = [plexAlbum('600', 'Sing', { guid: SING_RELEASE })];

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
        'Sing to the Ferryman — Glasswing'
      );
      assert.deepEqual(await history(), [
        ['available', 'Sing to the Ferryman'],
      ]);
    });

    it('writes an album leaving into its artist’s history', async () => {
      await seedArtist(
        [
          {
            mbId: SING,
            title: 'Sing to the Ferryman',
            status: MediaStatus.AVAILABLE,
          },
        ],
        { status: MediaStatus.AVAILABLE }
      );
      state.lidarr.artists = [lidarrArtist()];
      state.lidarr.albums = [lidarrAlbum()];

      await musicFullScan.run();

      assert.equal((await albumOf(SING)).status, MediaStatus.UNKNOWN);
      assert.deepEqual(await history(), [['removed', 'Sing to the Ferryman']]);
    });

    it('stops showing an import as being added once the album is here', async () => {
      const media = await seedArtist([
        { mbId: SING, title: 'Sing to the Ferryman', lidarrAlbumId: 70 },
      ]);
      await seedRequest(media, [{ mbid: SING, title: 'Sing to the Ferryman' }]);
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
          downloadId: 'sing',
          album: {
            id: 70,
            title: 'Sing to the Ferryman',
            foreignAlbumId: SING,
          },
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

      state.plex.artists = [plexArtist('500', 'Glasswing', ARTIST)];
      state.plex.albums = [plexAlbum('600', 'Sing', { guid: SING_RELEASE })];
      await musicFullScan.run();
      assert.deepEqual(downloadTracker.getMusicProgress(0, 7), []);
    });
  });
});
