import QBittorrentAPI from '@server/api/downloadclients/qbittorrent';
import type { ProwlarrRelease } from '@server/api/prowlarr';
import ProwlarrAPI from '@server/api/prowlarr';
import type { LidarrAlbum, LidarrArtist } from '@server/api/servarr/lidarr';
import { getRepository } from '@server/datasource';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import BackfillJob from '@server/entity/BackfillJob';
import BackfillSeries from '@server/entity/BackfillSeries';
import type { AlbumContext } from '@server/lib/backfill/albums';
import { judgeAlbumPack } from '@server/lib/backfill/albums';
import backfill from '@server/lib/backfill/engine';
import type {
  AlbumImportFile,
  AlbumTrack,
  AlbumTrackFile,
  LidarrParseResult,
} from '@server/lib/backfill/lidarr';
import BackfillLidarr from '@server/lib/backfill/lidarr';
import type { PlanEntry } from '@server/lib/backfill/plan';
import type { SonarrQualityProfile } from '@server/lib/backfill/sonarr';
import notificationManager from '@server/lib/notifications';
import type { LidarrSettings } from '@server/lib/settings';
import { BACKFILL_DEFAULTS, getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

setupTestDb();

/*
 * Backfill for albums: a release's files judged against the album's tracks
 * in the edition Lidarr imports into, and an album followed from Lidarr's
 * wanted list to its import. Lidarr, Prowlarr and qBittorrent are stubbed
 * at their API clients; Lidarr's answers have the shapes it gives.
 */

const MB = 1024 ** 2;
const MP3 = { quality: { id: 2, name: 'MP3-320' } };
const FLAC = { quality: { id: 6, name: 'FLAC' } };

const PROFILE: SonarrQualityProfile = {
  id: 1,
  name: 'Lossless',
  upgradeAllowed: true,
  cutoff: 6,
  items: [
    { quality: { id: 2, name: 'MP3-320' }, allowed: true },
    { quality: { id: 6, name: 'FLAC' }, allowed: true },
  ],
  minFormatScore: 0,
  cutoffFormatScore: 0,
};

const ARTIST = {
  id: 7,
  artistName: 'Glasswing',
  foreignArtistId: '3c9e5f21-8d47-4b6a-a1e3-5f7d2c90b844',
  monitored: true,
  qualityProfileId: 1,
  metadataProfileId: 1,
  path: '/music/Glasswing',
  tags: [],
  added: '2020-01-01T00:00:00Z',
} as LidarrArtist;

const ALBUM_MBID = '4f6a2d93-c1e8-3a57-9b02-6d3e8f1c7a40';

const ALBUM: LidarrAlbum = {
  id: 70,
  title: 'Static Garden',
  foreignAlbumId: ALBUM_MBID,
  artistId: 7,
  monitored: true,
  releaseDate: '2001-05-01T00:00:00Z',
  releases: [
    {
      id: 9,
      albumId: 70,
      foreignReleaseId: 'standard',
      title: 'Static Garden',
      status: 'Official',
      trackCount: 3,
      format: 'Digital Media',
      monitored: true,
    },
    {
      id: 10,
      albumId: 70,
      foreignReleaseId: 'deluxe',
      title: 'Static Garden',
      status: 'Official',
      trackCount: 5,
      format: 'Digital Media',
      monitored: false,
    },
  ],
  images: [{ coverType: 'cover', remoteUrl: 'http://covers/static.jpg' }],
  statistics: {
    trackCount: 3,
    trackFileCount: 0,
    totalTrackCount: 3,
    sizeOnDisk: 0,
    percentOfTracks: 0,
  },
  artist: ARTIST,
};

const track = (
  id: number,
  number: number,
  title: string,
  releaseId: number,
  fileId = 0
): AlbumTrack => ({
  id,
  albumId: 70,
  title,
  absoluteTrackNumber: number,
  albumReleaseId: releaseId,
  hasFile: fileId > 0,
  trackFileId: fileId,
});

const STANDARD = [
  track(501, 1, 'Opening', 9),
  track(502, 2, 'Lantern Song', 9),
  track(503, 3, 'Tide Pool', 9),
];
const DELUXE = [
  track(601, 1, 'Opening', 10),
  track(602, 2, 'Lantern Song', 10),
  track(603, 3, 'Tide Pool', 10),
  track(604, 4, 'Lantern Song (Demo)', 10),
  track(605, 5, 'Outro', 10),
];

/** Lidarr's parser: this album by name, another of the artist's, or none. */
const parse = (title: string): LidarrParseResult => {
  const quality = /flac/i.test(title)
    ? FLAC
    : /320|mp3/i.test(title)
      ? MP3
      : { quality: { id: 0, name: 'Unknown' } };
  const albums = /Static Garden/i.test(title)
    ? [{ id: 70, title: 'Static Garden' }]
    : /Fog B/i.test(title)
      ? [{ id: 71, title: 'Fog B' }]
      : [];
  return {
    title,
    parsedAlbumInfo: { quality },
    ...(albums.length && { artist: { id: 7, artistName: 'Glasswing' } }),
    albums,
    customFormatScore: 0,
  };
};

const context = (
  tracks = STANDARD,
  files: AlbumTrackFile[] = []
): AlbumContext => ({
  album: ALBUM,
  artist: ARTIST,
  tracks,
  files,
  profile: PROFILE,
  names: ['Glasswing Static Garden', 'Static Garden'],
  lidarr: { parse: async (t: string) => parse(t) } as unknown as BackfillLidarr,
  editionTracks: async (id) => (id === 10 ? DELUXE : STANDARD),
});

const files = (folder: string, ...names: string[]) =>
  names.map((name, index) => ({
    index,
    path: `${folder}/${name}`,
    size: 30 * MB,
  }));

const used = (plan: PlanEntry[]) =>
  plan.filter((e) => e.action === 'fill' || e.action === 'upgrade');

describe('Backfill for albums: judging a release', () => {
  it('takes each track by its title, into the edition Lidarr has', async () => {
    const folder = 'Glasswing - Static Garden (2001) [FLAC]';
    const { plan, summary } = await judgeAlbumPack(
      [
        ...files(
          folder,
          '01 - Opening.flac',
          '02 - Lantern Song.flac',
          '03 - Tide Pool.flac'
        ),
        { index: 3, path: `${folder}/cover.jpg`, size: MB },
      ],
      folder,
      context()
    );
    assert.deepEqual(
      used(plan).map((e) => [
        e.episodeIds,
        e.releaseId,
        e.quality?.quality.name,
      ]),
      [
        [[501], 9, 'FLAC'],
        [[502], 9, 'FLAC'],
        [[503], 9, 'FLAC'],
      ]
    );
    assert.equal(summary.fill, 3);
    assert.equal(plan.length, 3, 'the cover is not a track');
  });

  it('places untitled files by number, one for each track', async () => {
    const folder = 'Glasswing - Static Garden [MP3 320]';
    const { plan } = await judgeAlbumPack(
      files(folder, '03 - Audio.mp3', '01 - Audio.mp3', '02 - Audio.mp3'),
      folder,
      context()
    );
    assert.deepEqual(
      used(plan).map((e) => [e.index, e.episodeIds]),
      [
        [1, [501]],
        [2, [502]],
        [0, [503]],
      ]
    );
  });

  it('turns down another album of the artist’s', async () => {
    const folder = 'Glasswing - Fog B (2004) [FLAC]';
    const { plan, summary } = await judgeAlbumPack(
      files(folder, '01 - Opening.flac'),
      folder,
      context()
    );
    assert.equal(summary.fill, 0);
    assert.deepEqual(
      plan.map((e) => [e.action, e.reason]),
      [['reject', 'Not this album']]
    );
  });

  it('chooses the edition the release is, when nothing is on disk yet', async () => {
    const folder = 'Glasswing - Static Garden (Deluxe) [FLAC]';
    const { plan } = await judgeAlbumPack(
      files(
        folder,
        '01 - Opening.flac',
        '02 - Lantern Song.flac',
        '03 - Tide Pool.flac',
        '04 - Lantern Song (Demo).flac',
        '05 - Outro.flac'
      ),
      folder,
      context()
    );
    assert.deepEqual(
      used(plan).map((e) => [e.episodeIds[0], e.releaseId]),
      [
        [601, 10],
        [602, 10],
        [603, 10],
        [604, 10],
        [605, 10],
      ]
    );
  });

  it('keeps the edition on disk, and upgrades only as the profile allows', async () => {
    const tracks = [
      track(501, 1, 'Opening', 9, 900),
      track(502, 2, 'Lantern Song', 9),
      track(503, 3, 'Tide Pool', 9),
    ];
    const onDisk: AlbumTrackFile[] = [
      { id: 900, albumId: 70, size: 10 * MB, quality: MP3 },
    ];
    const folder = 'Glasswing - Static Garden (Deluxe) [FLAC]';
    const { plan, summary } = await judgeAlbumPack(
      files(
        folder,
        '01 - Opening.flac',
        '02 - Lantern Song.flac',
        '03 - Tide Pool.flac',
        '04 - Lantern Song (Demo).flac',
        '05 - Outro.flac'
      ),
      folder,
      context(tracks, onDisk)
    );
    assert.deepEqual(
      [summary.fill, summary.upgrade],
      [2, 1],
      'its two missing tracks, and the MP3 bettered'
    );
    assert.ok(
      used(plan).every((e) => e.releaseId === 9),
      'the edition the album has'
    );
    assert.deepEqual(
      plan.filter((e) => e.action === 'reject').map((e) => e.reason),
      ['Not a track of this album', 'Not a track of this album']
    );
  });
});

// ---- from Lidarr's wanted list to the library ------------------------------

const ben = (value: unknown): Buffer => {
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const b = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return Buffer.concat([Buffer.from(`${b.length}:`), b]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([
      Buffer.from('l'),
      ...value.map(ben),
      Buffer.from('e'),
    ]);
  }
  const dict = value as Record<string, unknown>;
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.keys(dict)
      .sort()
      .flatMap((k) => [ben(k), ben(dict[k])]),
    Buffer.from('e'),
  ]);
};

const INFO = {
  name: 'Glasswing - Static Garden (2001) [FLAC]',
  'piece length': 4194304,
  pieces: Buffer.alloc(20),
  files: [
    { length: 30 * MB, path: ['01 - Opening.flac'] },
    { length: 30 * MB, path: ['02 - Lantern Song.flac'] },
    { length: 30 * MB, path: ['03 - Tide Pool.flac'] },
    { length: MB, path: ['cover.jpg'] },
  ],
};
const TORRENT = ben({ announce: 'udp://tracker', info: INFO });
const HASH = createHash('sha1').update(ben(INFO)).digest('hex');

const RELEASE: ProwlarrRelease = {
  guid: 'https://indexer/sg',
  title: 'Glasswing - Static Garden (2001) [FLAC]',
  size: 91 * MB,
  indexerId: 3,
  indexer: 'Knaben',
  protocol: 'torrent',
  seeders: 30,
  downloadUrl: 'http://prowlarr/3/download',
};

const forServer = BackfillLidarr.forServer;

let tracks: AlbumTrack[];
let wanted: LidarrAlbum[];
let imports: AlbumImportFile[][] = [];
let priorities: { indexes: number[]; priority: number }[] = [];
let removed: string[] = [];
let searchedWith: number[] | undefined;
let searchedFor: string[] = [];
let done = false;
let inClient = false;

beforeEach(() => {
  // Two of three tracks on disk as MP3s: only the third is missing.
  tracks = [
    track(501, 1, 'Opening', 9, 900),
    track(502, 2, 'Lantern Song', 9),
    track(503, 3, 'Tide Pool', 9, 901),
  ];
  wanted = [
    {
      ...ALBUM,
      statistics: { ...ALBUM.statistics!, trackFileCount: 2 },
    },
  ];
  imports = [];
  priorities = [];
  removed = [];
  searchedWith = undefined;
  searchedFor = [];
  done = false;
  inClient = false;

  const settings = getSettings();
  settings.backfill = {
    ...BACKFILL_DEFAULTS,
    enabled: true,
    prowlarr: {
      ...BACKFILL_DEFAULTS.prowlarr,
      hostname: 'prowlarr',
      apiKey: 'k',
    },
    torrentClientId: 1,
    includeMusic: true,
  };
  settings.sonarr = [];
  settings.radarr = [];
  settings.lidarr = [
    {
      id: 0,
      name: 'Lidarr',
      hostname: 'lidarr',
      port: 8686,
      apiKey: 'x',
      useSsl: false,
      isDefault: true,
    } as unknown as LidarrSettings,
  ];
  settings.main.disabledFeatures = [];
  settings.downloadClients = [
    {
      id: 1,
      name: 'qBittorrent',
      type: 'qbittorrent',
      hostname: 'qbittorrent',
      port: 8080,
      useSsl: false,
      urlBase: '',
      apiKey: '',
      username: '',
      password: '',
    },
  ];

  mock.method(notificationManager, 'sendNotification', () => undefined);
  const lidarr = BackfillLidarr.prototype;
  mock.method(lidarr, 'getWanted', async (kind: string) => ({
    records: kind === 'missing' ? wanted : [],
    complete: true,
  }));
  mock.method(lidarr, 'getAlbumQueueCount', async () => 0);
  mock.method(lidarr, 'getAlbumDetail', async () => ALBUM);
  mock.method(lidarr, 'getArtistDetail', async () => ARTIST);
  mock.method(lidarr, 'getAlbumTracks', async () => tracks);
  mock.method(lidarr, 'getEditionTracks', async () => DELUXE);
  mock.method(lidarr, 'getAlbumTrackFiles', async () => [
    { id: 900, albumId: 70, size: 10 * MB, quality: MP3 },
    { id: 901, albumId: 70, size: 10 * MB, quality: MP3 },
  ]);
  mock.method(lidarr, 'getQualityProfile', async () => PROFILE);
  mock.method(lidarr, 'parse', async (title: string) => parse(title));
  mock.method(lidarr, 'getRootFoldersNow', async () => [
    { path: '/music', freeSpace: 500 * 1024 * MB },
  ]);
  mock.method(lidarr, 'importAlbumFiles', async (list: AlbumImportFile[]) => {
    imports.push(list);
    return 41;
  });
  // These two are each client's own, not the class's.
  mock.method(BackfillLidarr, 'forServer', (server: LidarrSettings) =>
    Object.assign(forServer.call(BackfillLidarr, server), {
      getRemotePathMappings: async () => [
        { host: 'qbittorrent', remotePath: '/downloads/', localPath: '/data/' },
      ],
      getCommand: async () => ({ id: 41, status: 'completed' }),
    })
  );

  mock.method(
    ProwlarrAPI.prototype,
    'search',
    async (query: string, options: { categories?: number[] }) => {
      searchedWith = options.categories;
      searchedFor.push(query);
      return [RELEASE];
    }
  );
  mock.method(ProwlarrAPI.prototype, 'fetchRelease', async () => ({
    kind: 'torrent',
    data: TORRENT,
  }));

  const qbit = QBittorrentAPI.prototype;
  mock.method(qbit, 'ensureCategory', async () => undefined);
  mock.method(qbit, 'addTorrent', async () => {
    inClient = true;
  });
  mock.method(qbit, 'getTorrent', async () =>
    inClient
      ? {
          hash: HASH,
          name: INFO.name,
          state: done ? 'stoppedUP' : 'downloading',
          progress: done ? 1 : 0.5,
          size: 30 * MB,
          amount_left: done ? 0 : 15 * MB,
          eta: 60,
          dlspeed: 1000,
          save_path: '/downloads/backfill',
          content_path: `/downloads/backfill/${INFO.name}`,
        }
      : undefined
  );
  mock.method(qbit, 'getFiles', async () =>
    INFO.files.map((f, index) => ({
      index,
      name: [INFO.name, ...f.path].join('/'),
      size: f.length,
      progress: done && index === 1 ? 1 : 0,
      priority: index === 1 ? 1 : 0,
    }))
  );
  mock.method(
    qbit,
    'setFilePriority',
    async (_hash: string, indexes: number[], priority: number) => {
      priorities.push({ indexes: [...indexes].sort(), priority });
    }
  );
  mock.method(qbit, 'startTorrent', async () => undefined);
  mock.method(qbit, 'getCategoryTorrents', async () => []);
  mock.method(qbit, 'stopTorrent', async () => undefined);
  mock.method(qbit, 'deleteTorrent', async (hash: string) => {
    removed.push(hash);
    inClient = false;
  });
});

afterEach(() => {
  mock.restoreAll();
});

describe('Backfill for albums: from Lidarr’s wanted list to the library', () => {
  it('finds a stuck album, downloads only its missing track, and has Lidarr import it', async () => {
    await backfill.scan();
    const row = await getRepository(BackfillSeries).findOneOrFail({
      where: { kind: 'album', arrId: 70 },
    });
    assert.deepEqual(
      [row.status, row.missing, row.artistName, row.foreignId, row.poster],
      ['found', 1, 'Glasswing', ALBUM_MBID, 'http://covers/static.jpg']
    );
    assert.deepEqual(searchedWith, [3000], 'audio categories');
    assert.deepEqual(searchedFor, ['Glasswing Static Garden', 'Static Garden']);

    const candidate = await getRepository(BackfillCandidate).findOneOrFail({
      where: { seriesId: row.id },
    });
    assert.equal(candidate.status, 'ready');
    assert.deepEqual(
      [candidate.summary?.fill, candidate.summary?.upgrade],
      [1, 2]
    );

    // Missing only: the one track, not the upgrades.
    const job = await backfill.approve(candidate.id, { mode: 'missing' });
    assert.deepEqual(priorities, [
      { indexes: [0, 2, 3], priority: 0 },
      { indexes: [1], priority: 1 },
    ]);

    done = true;
    await backfill.tick();
    assert.deepEqual(imports, [
      [
        {
          path: `/data/backfill/${INFO.name}/02 - Lantern Song.flac`,
          artistId: 7,
          albumId: 70,
          albumReleaseId: 9,
          trackIds: [502],
          quality: { ...FLAC, revision: { version: 1, real: 0 } },
        },
      ],
    ]);

    tracks = tracks.map((t) =>
      t.id === 502 ? { ...t, hasFile: true, trackFileId: 902 } : t
    );
    await backfill.tick();
    const finished = await getRepository(BackfillJob).findOneOrFail({
      where: { id: job.id },
    });
    assert.deepEqual([finished.status, finished.imported], ['done', 1]);
    assert.deepEqual(removed, [HASH]);
  });

  it('leaves an album Lidarr has not had its chance at yet', async () => {
    // Released last week.
    wanted = [
      {
        ...ALBUM,
        releaseDate: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        statistics: { ...ALBUM.statistics!, trackFileCount: 2 },
      },
    ];
    await backfill.scan();
    assert.equal(
      await getRepository(BackfillSeries).count({ where: { kind: 'album' } }),
      1,
      'out a week: Lidarr has had a day'
    );

    // Out an hour.
    await getRepository(BackfillSeries).clear();
    wanted = [
      { ...ALBUM, releaseDate: new Date(Date.now() - 3_600_000).toISOString() },
    ];
    await backfill.scan();
    assert.equal(
      await getRepository(BackfillSeries).count({ where: { kind: 'album' } }),
      0
    );
  });

  it('leaves albums alone with music turned off for Backfill', async () => {
    getSettings().backfill = {
      ...getSettings().backfill,
      includeMusic: false,
    };
    await backfill.scan();
    assert.equal(
      await getRepository(BackfillSeries).count({ where: { kind: 'album' } }),
      0
    );
  });
});
