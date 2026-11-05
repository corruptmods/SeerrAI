import QBittorrentAPI from '@server/api/downloadclients/qbittorrent';
import SabnzbdAPI from '@server/api/downloadclients/sabnzbd';
import { MusicBrainz } from '@server/api/musicbrainz';
import type { MbArtist, MbRecording } from '@server/api/musicbrainz/interfaces';
import type { ProwlarrRelease } from '@server/api/prowlarr';
import ProwlarrAPI from '@server/api/prowlarr';
import type { SlskdResponse, SlskdTransfer } from '@server/api/slskd';
import SlskdAPI, { SlskdRefused } from '@server/api/slskd';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  InvalidMusicRequestError,
  MediaRequest,
} from '@server/entity/MediaRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import SongFetch from '@server/entity/SongFetch';
import SongRequest from '@server/entity/SongRequest';
import { User } from '@server/entity/User';
import { clearAiCache } from '@server/lib/ai';
import backfill from '@server/lib/backfill/engine';
import { IndexerLimitReached } from '@server/lib/backfill/indexerLimit';
import { readNzb } from '@server/lib/backfill/nzb';
import cacheManager from '@server/lib/cache';
import downloadTracker from '@server/lib/downloadtracker';
import {
  fileForTrack,
  fileInCatalog,
  namesAlbum,
  namesCatalog,
  songsOfFile,
} from '@server/lib/music/albumRelease';
import { completeMusicRequests } from '@server/lib/music/completion';
import { songStandings } from '@server/lib/music/requestSongs';
import songFetcher, {
  delayProfileFor,
  holdsSlot,
  quickestFirst,
  rankReleases,
} from '@server/lib/music/songFetch';
import {
  albumsWaitingToSearch,
  searchAgainNow,
} from '@server/lib/music/songFetchWaits';
import { Permission } from '@server/lib/permissions';
import {
  BACKFILL_DEFAULTS,
  getSettings,
  musicDefaults,
} from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { createFakeLidarr } from '@server/test/fakeLidarr';
import axios from 'axios';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
 * Taking a song from its album: Prowlarr finds a release, only the song's
 * file downloads, Lidarr imports that track into the unmonitored album, and
 * the download is removed. Prowlarr and qBittorrent are mocked; Lidarr is
 * the local fake.
 */

setupTestDb();

const ARTIST = '3c9e5f21-8d47-4b6a-a1e3-5f7d2c90b844';
const STATIC_GARDEN = '4f6a2d93-c1e8-3a57-9b02-6d3e8f1c7a40';
const LANTERN = 'a1b2c3d4-0001-4000-8000-000000000001';
const OPENING = 'a1b2c3d4-0008-4000-8000-000000000008';
const MB = 1024 ** 2;

const lidarr = createFakeLidarr();

const recording = (id: string, title: string): MbRecording => ({
  id,
  title,
  length: 200_000,
  'artist-credit': [
    { name: 'Glasswing', artist: { id: ARTIST, name: 'Glasswing' } },
  ],
  releases: [
    {
      id: 'r-static',
      title: 'Static Garden',
      status: 'Official',
      date: '1997-05-21',
      'artist-credit': [
        { name: 'Glasswing', artist: { id: ARTIST, name: 'Glasswing' } },
      ],
      'release-group': {
        id: STATIC_GARDEN,
        title: 'Static Garden',
        'primary-type': 'Album',
        'secondary-types': [],
      },
    },
  ],
});
const RECORDINGS: Record<string, MbRecording> = {
  [LANTERN]: recording(LANTERN, 'Lantern Song'),
  [OPENING]: recording(OPENING, 'Opening'),
};

// Minimal bencode encoder for the test torrent.
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
  name: 'Glasswing - Static Garden (1997) [FLAC]',
  'piece length': 262144,
  pieces: Buffer.alloc(20),
  files: [
    { length: 30 * MB, path: ['01 - Opening.flac'] },
    { length: 40 * MB, path: ['02 - Lantern Song.flac'] },
    { length: 1 * MB, path: ['cover.jpg'] },
  ],
};
// A torrent of the album: two songs and a cover.
const TORRENT = ben({ announce: 'udp://tracker', info: INFO });
const HASH = createHash('sha1').update(ben(INFO)).digest('hex');
const RELEASE: ProwlarrRelease = {
  guid: 'https://indexer/sg',
  title: 'Glasswing - Static Garden (1997) [FLAC]',
  size: 71 * MB,
  indexerId: 3,
  indexer: 'Knaben',
  protocol: 'torrent',
  seeders: 12,
  downloadUrl: 'http://prowlarr/3/download',
};

let actingAs: User;
let found: ProwlarrRelease[];
let priorities: { indexes: number[]; priority: number }[];
let removed: string[];
let done: boolean;
let inClient: boolean;

const actAs = async (permissions: number, email = 'listener@test.local') => {
  const repository = getRepository(User);
  const user =
    (await repository.findOneBy({ email })) ??
    new User({ email, username: email, avatar: '' });
  user.permissions = permissions;
  actingAs = await repository.save(user);
  return actingAs;
};

const requestSongs = (songs: string[]) =>
  MediaRequest.requestMusic({ artistMbid: ARTIST, songs }, actingAs);

/** Two ticks: adds the artist, then the album, and starts. */
const startFetching = async () => {
  await songFetcher.tick();
  await songFetcher.tick();
};

const searches = () =>
  (
    ProwlarrAPI.prototype.search as unknown as {
      mock: { callCount: () => number };
    }
  ).mock.callCount();

const fetchOf = () =>
  getRepository(SongFetch).findOneOrFail({ where: {}, order: { id: 'DESC' } });

before(async () => {
  await lidarr.start();
});

after(() => {
  lidarr.stop();
});

beforeEach(async () => {
  lidarr.reset();
  cacheManager.getCache('lidarr').flush();
  found = [RELEASE];
  priorities = [];
  removed = [];
  done = false;
  inClient = false;

  const settings = getSettings();
  settings.lidarr = [lidarr.settings()];
  settings.music = {
    ...musicDefaults(),
    songRequests: true,
    songsFromAlbums: true,
  };
  settings.main.disabledFeatures = [];
  settings.backfill = {
    ...BACKFILL_DEFAULTS,
    enabled: true,
    prowlarr: {
      ...BACKFILL_DEFAULTS.prowlarr,
      hostname: 'prowlarr',
      apiKey: 'k',
    },
    torrentClientId: 1,
  };
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

  lidarr.lookupArtists.set(ARTIST, {
    id: 0,
    artistName: 'Glasswing',
    foreignArtistId: ARTIST,
    monitored: false,
    qualityProfileId: 0,
    metadataProfileId: 0,
    tags: [],
  });
  lidarr.lookupAlbums.set(STATIC_GARDEN, {
    id: 0,
    title: 'Static Garden',
    foreignAlbumId: STATIC_GARDEN,
    artistId: 0,
    monitored: false,
    releases: [
      {
        id: 9,
        albumId: 0,
        foreignReleaseId: 'r-static',
        title: 'Static Garden',
        monitored: true,
      },
    ],
  });
  lidarr.tracksOnAdd.set(STATIC_GARDEN, [
    { id: 501, title: 'Opening', foreignRecordingId: OPENING, hasFile: false },
    {
      id: 502,
      title: 'Lantern Song',
      foreignRecordingId: LANTERN,
      hasFile: false,
    },
  ]);
  lidarr.remotePathMappings = [
    { host: 'qbittorrent', remotePath: '/downloads/', localPath: '/data/' },
  ];

  mock.method(MediaRequest, 'sendNotification', async () => true);
  mock.method(
    MusicBrainz.prototype,
    'getArtist',
    async (id: string) => ({ id, name: 'Glasswing' }) as MbArtist
  );
  mock.method(
    MusicBrainz.prototype,
    'getRecording',
    async (id: string) => RECORDINGS[id] ?? null
  );
  mock.method(ProwlarrAPI.prototype, 'search', async () => found);
  mock.method(ProwlarrAPI.prototype, 'musicIndexerIds', async () => [3, 12]);
  mock.method(ProwlarrAPI.prototype, 'fetchRelease', async () => ({
    kind: 'torrent',
    data: TORRENT,
  }));
  mock.method(backfill, 'filesOf', async () => ({
    files: INFO.files.map((f, index) => ({
      index,
      path: [INFO.name, ...f.path].join('/'),
      size: f.length,
    })),
    infoHash: HASH,
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
          progress: done ? 1 : 0.2,
          size: 40 * MB,
          amount_left: done ? 0 : 30 * MB,
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
  mock.method(qbit, 'stopTorrent', async () => undefined);
  mock.method(qbit, 'deleteTorrent', async (hash: string) => {
    removed.push(hash);
    inClient = false;
  });

  await actAs(Permission.REQUEST + Permission.AUTO_APPROVE_MUSIC);
});

afterEach(() => {
  mock.restoreAll();
  getSettings().lidarr = [];
  getSettings().downloadClients = [];
});

describe('taking a song from its album', () => {
  it('downloads only the song, has Lidarr import it, and removes the rest', async () => {
    const request = await requestSongs([LANTERN]);
    const [song] = request.songs;
    assert.equal(song.singleMbid, null);
    assert.equal(song.sourceAlbumMbid, STATIC_GARDEN);
    assert.equal(request.status, MediaRequestStatus.APPROVED);

    // The artist is added first; Lidarr lists its albums itself.
    await songFetcher.tick();
    let fetch = await fetchOf();
    assert.equal(fetch.status, 'queued');
    assert.equal(
      lidarr.calls
        .filter((c) => c.method === 'POST')
        .map((c) => c.path)
        .join(),
      '/api/v1/artist'
    );

    await songFetcher.tick();
    fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');
    assert.deepEqual(fetch.recordings, [LANTERN]);
    // Album added unmonitored and unsearched.
    const added = lidarr.calls.find(
      (c) => c.method === 'POST' && c.path === '/api/v1/album'
    );
    assert.equal(added?.body?.monitored, false);
    assert.deepEqual(added?.body?.addOptions, { searchForNewAlbum: false });
    const artist = lidarr.calls.find(
      (c) => c.method === 'POST' && c.path === '/api/v1/artist'
    );
    assert.deepEqual(
      (artist?.body?.addOptions as { monitor: string }).monitor,
      'none'
    );
    // Only the song's file is downloaded.
    assert.deepEqual(priorities, [
      { indexes: [0, 2], priority: 0 },
      { indexes: [1], priority: 1 },
    ]);
    const row = await getRepository(MusicAlbum).findOneByOrFail({
      mbId: STATIC_GARDEN,
    });
    assert.equal(row.status, MediaStatus.UNKNOWN);
    assert.ok(row.lidarrAlbumId);

    done = true;
    await songFetcher.tick();
    fetch = await fetchOf();
    assert.equal(fetch.status, 'importing');
    const imported = lidarr.calls.find(
      (c) =>
        c.method === 'POST' &&
        c.path === '/api/v1/command' &&
        c.body?.name === 'ManualImport'
    );
    const files = imported?.body?.files as {
      path: string;
      trackIds: number[];
      albumReleaseId: number;
    }[];
    assert.deepEqual(
      files.map((f) => [f.path, f.trackIds, f.albumReleaseId]),
      [
        [
          '/data/backfill/Glasswing - Static Garden (1997) [FLAC]/02 - Lantern Song.flac',
          [502],
          9,
        ],
      ]
    );

    await songFetcher.tick();
    fetch = await fetchOf();
    assert.equal(fetch.status, 'done');
    assert.deepEqual(removed, [HASH]);

    // Scans mark the album partly available; the song completes.
    await getRepository(MusicAlbum).update(row.id, {
      status: MediaStatus.PARTIALLY_AVAILABLE,
    });
    // The artist is linked to Lidarr so the music scans follow the album.
    const media = await getRepository(Media).findOneByOrFail({
      mediaType: MediaType.MUSIC,
      foreignId: ARTIST,
    });
    assert.deepEqual(
      [media.serviceId, media.externalServiceId],
      [0, lidarr.artists[0].id]
    );
    await completeMusicRequests([media.id]);
    const after = await getRepository(MediaRequest).findOneByOrFail({
      id: request.id,
    });
    assert.equal(after.songs[0].status, MediaRequestStatus.COMPLETED);
    assert.equal(after.status, MediaRequestStatus.COMPLETED);

    // The song shows available though the album is only partly.
    const standing = await songStandings([
      {
        mbId: LANTERN,
        releaseGroups: [{ mbId: STATIC_GARDEN, title: 'Static Garden' }],
      },
    ]);
    assert.equal(standing.get(LANTERN)?.status, MediaStatus.AVAILABLE);
  });

  it('takes the song into the album Lidarr keeps under another of its artists', async () => {
    // A duet: Lidarr files the album under the first-credited artist and
    // refuses to add it again ("This album has already been added").
    lidarr.artists.push({
      id: 900,
      artistName: 'Harbour Lights',
      foreignArtistId: 'b1a2c3d4-0900-4000-8000-000000000900',
      monitored: true,
      qualityProfileId: 1,
      metadataProfileId: 1,
      tags: [],
    });
    lidarr.albums.push({
      id: 901,
      title: 'Static Garden',
      foreignAlbumId: STATIC_GARDEN,
      artistId: 900,
      monitored: true,
      releases: [
        {
          id: 9,
          albumId: 901,
          foreignReleaseId: 'r-static',
          title: 'Static Garden',
          monitored: true,
        },
      ],
    });
    lidarr.tracks.set(901, [
      {
        id: 501,
        albumId: 901,
        title: 'Opening',
        foreignRecordingId: OPENING,
        hasFile: false,
      },
      {
        id: 502,
        albumId: 901,
        title: 'Lantern Song',
        foreignRecordingId: LANTERN,
        hasFile: false,
      },
    ]);
    await requestSongs([LANTERN]);
    await startFetching();
    const fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');
    assert.equal(fetch.lidarrAlbumId, 901);
    assert.equal(
      lidarr.calls.some(
        (c) => c.method === 'POST' && c.path === '/api/v1/album'
      ),
      false
    );

    done = true;
    await songFetcher.tick();
    const imported = lidarr.calls.find(
      (c) =>
        c.method === 'POST' &&
        c.path === '/api/v1/command' &&
        c.body?.name === 'ManualImport'
    );
    // Imported under the album's artist, as Lidarr files it.
    assert.deepEqual(
      (imported?.body?.files as { artistId: number; albumId: number }[]).map(
        (f) => [f.artistId, f.albumId]
      ),
      [[900, 901]]
    );
  });

  it('shows its download on the album and the song, as Lidarr’s are', async () => {
    await requestSongs([LANTERN]);
    await startFetching();
    await songFetcher.tick();
    const fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');

    const shown = downloadTracker.getMusicProgress(
      fetch.lidarrId,
      fetch.lidarrArtistId!
    );
    assert.deepEqual(
      shown.map((item) => [
        item.stage,
        item.album?.foreignAlbumId,
        item.songs,
        item.downloadId,
      ]),
      [['downloading', STATIC_GARDEN, [LANTERN], HASH]]
    );
    // Size counts only the song's file, none downloaded yet.
    const song = fetch.files.reduce((n, file) => n + file.size, 0);
    assert.deepEqual([shown[0].size, shown[0].sizeLeft], [song, song]);

    done = true;
    await songFetcher.tick();
    await songFetcher.tick();
    assert.equal((await fetchOf()).status, 'done');
    assert.deepEqual(
      downloadTracker.getMusicProgress(fetch.lidarrId, fetch.lidarrArtistId!),
      []
    );
  });

  it('links the artist of a song taken before artists were linked', async () => {
    const request = await requestSongs([LANTERN]);
    await startFetching();
    done = true;
    await songFetcher.tick();
    await songFetcher.tick();
    assert.equal((await fetchOf()).status, 'done');
    // Legacy state: song on file, artist unlinked.
    await getRepository(Media).update(request.media.id, {
      serviceId: null,
      externalServiceId: null,
      externalServiceSlug: null,
    });

    await songFetcher.tick();

    const media = await getRepository(Media).findOneByOrFail({
      id: request.media.id,
    });
    assert.deepEqual(
      [media.serviceId, media.externalServiceId, media.externalServiceSlug],
      [0, lidarr.artists[0].id, ARTIST]
    );
  });

  it('corrects an album songs were taken from that was marked available', async () => {
    await requestSongs([LANTERN]);
    await startFetching();
    done = true;
    await songFetcher.tick();
    await songFetcher.tick();
    assert.equal((await fetchOf()).status, 'done');
    // Legacy state: whole album marked available.
    await getRepository(MusicAlbum).update(
      { mbId: STATIC_GARDEN },
      { status: MediaStatus.AVAILABLE }
    );
    const album = lidarr.albums.find((a) => a.foreignAlbumId === STATIC_GARDEN);
    assert.ok(album);
    // Lidarr reports only the song's file, as for an unmonitored album.
    album.statistics = {
      trackCount: 1,
      trackFileCount: 1,
      totalTrackCount: 3,
      sizeOnDisk: 30_000_000,
      percentOfTracks: 33,
    };

    await songFetcher.tick();

    const row = await getRepository(MusicAlbum).findOneByOrFail({
      mbId: STATIC_GARDEN,
    });
    assert.equal(row.status, MediaStatus.PARTIALLY_AVAILABLE);
    const artist = await getRepository(Media).findOneByOrFail({
      id: row.mediaId,
    });
    assert.equal(artist.status, MediaStatus.PARTIALLY_AVAILABLE);
  });

  it('leaves an album songs were taken from available once Lidarr has all of it', async () => {
    await requestSongs([LANTERN]);
    await startFetching();
    done = true;
    await songFetcher.tick();
    await songFetcher.tick();
    await getRepository(MusicAlbum).update(
      { mbId: STATIC_GARDEN },
      { status: MediaStatus.AVAILABLE }
    );
    const album = lidarr.albums.find((a) => a.foreignAlbumId === STATIC_GARDEN);
    assert.ok(album);
    album.monitored = true;
    album.statistics = {
      trackCount: 3,
      trackFileCount: 3,
      totalTrackCount: 3,
      sizeOnDisk: 90_000_000,
      percentOfTracks: 100,
    };

    await songFetcher.tick();

    assert.equal(
      (await getRepository(MusicAlbum).findOneByOrFail({ mbId: STATIC_GARDEN }))
        .status,
      MediaStatus.AVAILABLE
    );
  });

  it('takes another song from an album one was already taken from', async () => {
    await requestSongs([LANTERN]);
    await startFetching();
    done = true;
    await songFetcher.tick();
    await songFetcher.tick();
    assert.equal((await fetchOf()).status, 'done');
    const first = await fetchOf();
    // Scans mark the album partly available.
    await getRepository(MusicAlbum).update(
      { mbId: STATIC_GARDEN },
      { status: MediaStatus.PARTIALLY_AVAILABLE }
    );

    // Then the album's other song is requested.
    done = false;
    priorities = [];
    const second = await requestSongs([OPENING]);
    assert.equal(second.status, MediaRequestStatus.APPROVED, 'not refused');
    await songFetcher.tick();

    const fetch = await fetchOf();
    assert.notEqual(fetch.id, first.id, 'a fetch of its own');
    assert.deepEqual(fetch.recordings, [OPENING]);
    assert.equal(fetch.status, 'downloading');
    // Same edition as the first, only its own file.
    assert.equal(fetch.lidarrReleaseId, first.lidarrReleaseId);
    assert.deepEqual(
      fetch.files.map((f) => f.trackId),
      [501]
    );
    assert.deepEqual(priorities, [
      { indexes: [1, 2], priority: 0 },
      { indexes: [0], priority: 1 },
    ]);
    // Artist and album aren't added again.
    assert.equal(
      lidarr.calls.filter(
        (c) => c.method === 'POST' && c.path !== '/api/v1/command'
      ).length,
      2
    );
  });

  it('takes a song asked for while its album downloads once that is done', async () => {
    await requestSongs([LANTERN]);
    await startFetching();
    const first = await fetchOf();
    assert.equal(first.status, 'downloading');

    // Requested mid-download: no second fetch for the album.
    await requestSongs([OPENING]);
    await songFetcher.tick();
    assert.equal(await getRepository(SongFetch).count(), 1);
    assert.equal((await fetchOf()).id, first.id);

    done = true;
    await songFetcher.tick();
    await songFetcher.tick();
    await songFetcher.tick();
    const fetches = await getRepository(SongFetch).find({
      order: { id: 'ASC' },
    });
    assert.equal(fetches.length, 2);
    assert.deepEqual(fetches[1].recordings, [OPENING]);
  });

  it('takes two songs of one album in one download', async () => {
    await requestSongs([LANTERN]);
    await requestSongs([OPENING]);

    await startFetching();

    assert.equal(await getRepository(SongFetch).count(), 1);
    assert.deepEqual(
      (await fetchOf()).recordings.sort(),
      [LANTERN, OPENING].sort()
    );
    assert.deepEqual(priorities, [
      { indexes: [2], priority: 0 },
      { indexes: [0, 1], priority: 1 },
    ]);
  });

  it('looks again later when no release has it, then fails the song', async () => {
    found = [{ ...RELEASE, title: 'Someone Else - Other Album [MP3]' }];
    const request = await requestSongs([LANTERN]);

    await startFetching();

    // Nothing found: searched again later.
    let fetch = await fetchOf();
    assert.equal(fetch.status, 'searching');
    assert.equal(fetch.searches, 1);
    assert.ok(fetch.searchAgainAt!.getTime() > Date.now());
    assert.equal(
      (await getRepository(MediaRequest).findOneByOrFail({ id: request.id }))
        .status,
      MediaRequestStatus.APPROVED
    );
    const searched = searches();
    await songFetcher.tick();
    assert.equal(searches(), searched, 'not before its time');

    // Last search still empty: the song fails with a reason.
    await getRepository(SongFetch).update(fetch.id, {
      searches: 5,
      searchAgainAt: new Date(Date.now() - 1000),
    });
    await songFetcher.tick();
    fetch = await fetchOf();
    assert.equal(fetch.status, 'failed');
    const after = await getRepository(MediaRequest).findOneByOrFail({
      id: request.id,
    });
    assert.equal(after.status, MediaRequestStatus.FAILED);
    assert.equal(after.songs[0].status, MediaRequestStatus.FAILED);
    assert.equal(
      lidarr.calls.filter((c) => c.path === '/api/v1/command').length,
      0
    );
  });

  it('takes the song into an edition with it, not the one Lidarr picked', async () => {
    // Lidarr monitors a bootleg box without the song; the usual official
    // edition has it.
    const artist = {
      id: 7,
      artistName: 'Glasswing',
      foreignArtistId: ARTIST,
      monitored: false,
      qualityProfileId: 1,
      metadataProfileId: 1,
      rootFolderPath: '/music',
      path: '/music/Glasswing',
      tags: [],
    };
    lidarr.artists.push(artist);
    lidarr.albums.push({
      id: 30,
      title: 'Static Garden',
      foreignAlbumId: STATIC_GARDEN,
      artistId: 7,
      monitored: false,
      releases: [
        {
          id: 31,
          albumId: 30,
          foreignReleaseId: 'r-box',
          title: 'Static Garden',
          status: 'Bootleg',
          trackCount: 40,
          monitored: true,
        },
        {
          id: 32,
          albumId: 30,
          foreignReleaseId: 'r-static',
          title: 'Static Garden',
          status: 'Official',
          trackCount: 2,
          format: 'Digital Media',
          monitored: false,
        },
      ],
    });
    lidarr.tracks.set(30, [
      { id: 601, albumId: 30, title: 'Opening', hasFile: false },
    ]);
    lidarr.releaseTracks.set(32, [
      {
        id: 701,
        albumId: 30,
        title: 'Opening',
        foreignRecordingId: OPENING,
        hasFile: false,
      },
      {
        id: 702,
        albumId: 30,
        title: 'Lantern Song',
        foreignRecordingId: LANTERN,
        hasFile: false,
      },
    ]);

    await requestSongs([LANTERN]);
    await songFetcher.tick();
    let fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');
    assert.equal(fetch.lidarrReleaseId, 32);
    assert.deepEqual(
      fetch.files.map((f) => f.trackId),
      [702]
    );

    done = true;
    await songFetcher.tick();
    const files = lidarr.calls.find(
      (c) => c.method === 'POST' && c.path === '/api/v1/command'
    )?.body?.files as { trackIds: number[]; albumReleaseId: number }[];
    assert.deepEqual(
      files.map((f) => [f.trackIds, f.albumReleaseId]),
      [[[702], 32]]
    );
    // Neither album nor artist was saved to switch editions.
    assert.equal(
      lidarr.calls.filter(
        (c) =>
          c.method === 'PUT' ||
          (c.method === 'POST' && c.path.endsWith('/album'))
      ).length,
      0
    );
    await songFetcher.tick();
    fetch = await fetchOf();
    assert.equal(fetch.status, 'done');
  });

  it('uses the album Lidarr listed for the new artist, not a second one', async () => {
    await requestSongs([LANTERN]);
    await songFetcher.tick();
    // Lidarr's artist refresh lists the album in the meantime.
    const artist = lidarr.artists[0];
    lidarr.albums.push({
      ...lidarr.lookupAlbums.get(STATIC_GARDEN)!,
      id: 40,
      artistId: artist.id,
    });
    lidarr.tracks.set(40, [
      {
        id: 801,
        albumId: 40,
        title: 'Lantern Song',
        foreignRecordingId: LANTERN,
        hasFile: false,
      },
    ]);

    await songFetcher.tick();
    const fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');
    assert.equal(fetch.lidarrAlbumId, 40);
    assert.equal(
      lidarr.calls.filter(
        (c) => c.method === 'POST' && c.path === '/api/v1/album'
      ).length,
      0
    );
  });

  it('stops, and removes the download, once the request is declined', async () => {
    const request = await requestSongs([LANTERN]);
    await startFetching();
    assert.equal((await fetchOf()).status, 'downloading');

    await getRepository(MediaRequest).update(request.id, {
      status: MediaRequestStatus.DECLINED,
    });
    await songFetcher.tick();

    assert.equal((await fetchOf()).status, 'failed');
    assert.deepEqual(removed, [HASH]);
  });

  it('carries on with a request’s other songs when one of them fails', async () => {
    // Lidarr's album lacks one of two songs requested together.
    lidarr.tracksOnAdd.set(STATIC_GARDEN, [
      {
        id: 502,
        title: 'Lantern Song',
        foreignRecordingId: LANTERN,
        hasFile: false,
      },
    ]);
    const request = await requestSongs([LANTERN, OPENING]);
    await startFetching();

    let fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');
    assert.deepEqual(fetch.recordings, [LANTERN], 'the failed song taken off');
    const failed = await getRepository(MediaRequest).findOneByOrFail({
      id: request.id,
    });
    assert.equal(failed.status, MediaRequestStatus.FAILED);
    assert.deepEqual(
      failed.songs
        .map((song) => [song.recordingMbid, song.status])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [
        [LANTERN, MediaRequestStatus.APPROVED],
        [OPENING, MediaRequestStatus.FAILED],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    );

    // The other song is still imported.
    done = true;
    await songFetcher.tick();
    fetch = await fetchOf();
    assert.equal(fetch.status, 'importing');
    await songFetcher.tick();
    fetch = await fetchOf();
    assert.equal(fetch.status, 'done');

    // Once Lidarr lists it, a retry fetches the failed song afresh.
    const albumId = fetch.lidarrAlbumId!;
    const listed = [
      ...(lidarr.tracks.get(albumId) ?? []),
      {
        id: 501,
        albumId,
        title: 'Opening',
        foreignRecordingId: OPENING,
        hasFile: false,
      },
    ];
    lidarr.tracks.set(albumId, listed);
    lidarr.releaseTracks.set(fetch.lidarrReleaseId!, listed);
    const opening = failed.songs.find(
      (song) => song.recordingMbid === OPENING
    )!;
    await getRepository(SongRequest).update(opening.id, {
      status: MediaRequestStatus.APPROVED,
    });
    await getRepository(MediaRequest).update(request.id, {
      status: MediaRequestStatus.APPROVED,
    });
    await songFetcher.tick();
    const again = await fetchOf();
    assert.notEqual(again.id, fetch.id);
    assert.deepEqual(again.recordings, [OPENING]);
  });

  it('takes a song Lidarr’s edition lacks from the artist’s next album with it', async () => {
    const LATER = '9d1f3a27-6b84-4c05-8e2a-3f7c1b9d4e61';
    mock.method(MusicBrainz.prototype, 'getRecording', async (id: string) => {
      const base = RECORDINGS[id];
      if (id !== OPENING || !base) return base ?? null;
      return {
        ...base,
        releases: [
          ...(base.releases ?? []),
          {
            id: 'r-later',
            title: 'Harbour Lights',
            status: 'Official',
            date: '2003-01-01',
            'artist-credit': base['artist-credit'],
            'release-group': {
              id: LATER,
              title: 'Harbour Lights',
              'primary-type': 'Album',
              'secondary-types': [],
            },
          },
        ],
      } as MbRecording;
    });
    lidarr.tracksOnAdd.set(STATIC_GARDEN, [
      {
        id: 502,
        title: 'Lantern Song',
        foreignRecordingId: LANTERN,
        hasFile: false,
      },
    ]);
    await requestSongs([LANTERN, OPENING]);
    await startFetching();

    const opening = await getRepository(SongRequest).findOneByOrFail({
      recordingMbid: OPENING,
    });
    assert.equal(opening.status, MediaRequestStatus.APPROVED, 'not failed');
    assert.equal(opening.sourceAlbumMbid, LATER);
    assert.equal(opening.sourceAlbumTitle, 'Harbour Lights');
    const first = await getRepository(SongFetch).findOneByOrFail({
      albumMbid: STATIC_GARDEN,
    });
    assert.deepEqual(first.recordings, [LANTERN]);
  });

  it('takes a song no edition of its albums has from its single', async () => {
    const OWN_SINGLE = '4e8b2d61-9a37-4c15-b0f4-7d2e6a9c1b38';
    // Requested from the album; the single becomes known later.
    let singleKnown = false;
    mock.method(MusicBrainz.prototype, 'getRecording', async (id: string) => {
      const base = RECORDINGS[id];
      if (id !== OPENING || !base || !singleKnown) return base ?? null;
      return {
        ...base,
        releases: [
          ...(base.releases ?? []),
          {
            id: 'r-single',
            title: 'Opening',
            status: 'Official',
            date: '1996-05-01',
            'artist-credit': base['artist-credit'],
            'release-group': {
              id: OWN_SINGLE,
              title: 'Opening',
              'primary-type': 'Single',
              'secondary-types': [],
            },
          },
        ],
      } as MbRecording;
    });
    lidarr.tracksOnAdd.set(STATIC_GARDEN, [
      {
        id: 502,
        title: 'Lantern Song',
        foreignRecordingId: LANTERN,
        hasFile: false,
      },
    ]);
    await requestSongs([LANTERN, OPENING]);
    singleKnown = true;
    await startFetching();

    const opening = await getRepository(SongRequest).findOneByOrFail({
      recordingMbid: OPENING,
    });
    assert.equal(opening.status, MediaRequestStatus.APPROVED, 'not failed');
    assert.equal(opening.sourceAlbumMbid, OWN_SINGLE);
  });

  it('takes a song from a pack of the artist’s releases when nothing names the album', async () => {
    const PACK: ProwlarrRelease = {
      ...RELEASE,
      guid: 'https://indexer/pack',
      title: 'Glasswing - Discography 1995-2020 (4 Albums + 9 Singles) FLAC',
      size: 900 * MB,
    };
    const terms: string[] = [];
    mock.method(ProwlarrAPI.prototype, 'search', async (term: string) => {
      terms.push(term);
      return term === 'Glasswing' ? [PACK] : [];
    });
    mock.method(backfill, 'filesOf', async () => ({
      files: [
        {
          index: 0,
          path: 'Glasswing - Discography/2010 - Live at the Pier/02 - Lantern Song.flac',
          size: 30 * MB,
        },
        {
          index: 1,
          path: 'Glasswing - Discography/1997 - Static Garden/02 - Lantern Song.flac',
          size: 40 * MB,
        },
        { index: 2, path: 'Glasswing - Discography/cover.jpg', size: 1 * MB },
      ],
      infoHash: HASH,
    }));
    await requestSongs([LANTERN]);
    await startFetching();

    assert.ok(terms.includes('Glasswing'), 'the artist searched for');
    const fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');
    assert.equal(fetch.release?.guid, PACK.guid);
    // Only the song from the album's folder, not the live album's.
    assert.deepEqual(
      fetch.files.map((f) => f.index),
      [1]
    );
  });

  describe('with Backfill’s second opinion', () => {
    const ALBUM_RELEASE: ProwlarrRelease = {
      ...RELEASE,
      guid: 'https://indexer/hl',
      title: 'Glasswing - Harbour Lights (2003) FLAC',
      size: 300 * MB,
    };
    const LIVE_RELEASE: ProwlarrRelease = {
      ...RELEASE,
      guid: 'https://indexer/live',
      title: 'Glasswing - Live at the Pier (2010) FLAC',
      size: 400 * MB,
    };
    let prompts: string[];
    let answer: { d: number[]; w: string };

    beforeEach(() => {
      clearAiCache();
      prompts = [];
      answer = { d: [1], w: 'Lantern Song is on Harbour Lights' };
      mock.method(ProwlarrAPI.prototype, 'search', async (term: string) =>
        term === 'Glasswing' ? [ALBUM_RELEASE, LIVE_RELEASE] : []
      );
      mock.method(backfill, 'filesOf', async () => ({
        files: [
          {
            index: 0,
            path: 'Glasswing - Harbour Lights/01 - Opening.flac',
            size: 30 * MB,
          },
          {
            index: 1,
            path: 'Glasswing - Harbour Lights/02 - Lantern Song.flac',
            size: 40 * MB,
          },
        ],
        infoHash: HASH,
      }));
      // Stub the model's HTTP call.
      mock.method(
        axios,
        'post',
        async (_url: string, body: { messages: { content: string }[] }) => {
          prompts.push(body.messages[0].content);
          return {
            data: {
              content: [{ type: 'text', text: JSON.stringify(answer) }],
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          };
        }
      );
      getSettings().ai = {
        enabled: true,
        provider: 'anthropic',
        apiKey: 'test-key',
        baseUrl: '',
        model: 'claude-test',
        featureModels: {},
        dailyLimit: 0,
      };
    });

    afterEach(() => {
      getSettings().ai = { ...getSettings().ai, enabled: false };
    });

    it('takes a song from a release the model names as holding it', async () => {
      await requestSongs([LANTERN]);
      await startFetching();

      assert.equal(prompts.length, 1, 'asked once');
      assert.match(prompts[0], /Songs: "Lantern Song"/);
      assert.match(
        prompts[0],
        /^1\. Glasswing - Harbour Lights \(2003\) FLAC/m
      );
      // Live albums and Prowlarr links never reach the prompt.
      assert.ok(!prompts[0].includes('Live at the Pier'));
      assert.ok(!prompts[0].includes('download'));
      const fetch = await fetchOf();
      assert.equal(fetch.status, 'downloading');
      assert.equal(fetch.release?.guid, ALBUM_RELEASE.guid);
      assert.deepEqual(
        fetch.files.map((f) => f.index),
        [1]
      );
    });

    it('takes nothing the model names when no file is named as the song', async () => {
      mock.method(backfill, 'filesOf', async () => ({
        files: [
          { index: 0, path: 'HL/01 - Opening.flac', size: 30 * MB },
          { index: 1, path: 'HL/02 - Track 2.flac', size: 40 * MB },
        ],
        infoHash: HASH,
      }));
      await requestSongs([LANTERN]);
      await startFetching();
      const fetch = await fetchOf();
      assert.equal(fetch.status, 'searching');
      assert.equal(fetch.release, null);
      assert.equal(fetch.searches, 1);
    });

    it('is not asked while it is turned off', async () => {
      getSettings().ai = { ...getSettings().ai, enabled: false };
      await requestSongs([LANTERN]);
      await startFetching();
      assert.equal(prompts.length, 0);
      assert.equal((await fetchOf()).status, 'searching');
    });
  });

  it('opens no pack of the artist’s releases when a release names the album', async () => {
    const terms: string[] = [];
    mock.method(ProwlarrAPI.prototype, 'search', async (term: string) => {
      terms.push(term);
      return found;
    });
    await requestSongs([LANTERN]);
    await startFetching();
    assert.equal((await fetchOf()).status, 'downloading');
    assert.ok(!terms.includes('Glasswing'));
  });

  it('searches again on its own schedule for a song the chosen release lacks', async () => {
    // The opened release has only Lantern Song.
    mock.method(backfill, 'filesOf', async () => ({
      files: [{ index: 0, path: 'A/02 - Lantern Song.flac', size: 40 * MB }],
      infoHash: HASH,
    }));
    await requestSongs([LANTERN, OPENING]);
    await startFetching();
    const fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');
    assert.deepEqual(fetch.recordings, [LANTERN]);
    const opening = await getRepository(SongRequest).findOneByOrFail({
      recordingMbid: OPENING,
    });
    assert.equal(opening.status, MediaRequestStatus.APPROVED, 'not failed');
  });

  it('picks the songs’ files once the client answers again', async () => {
    const qbit = QBittorrentAPI.prototype;
    const getFiles = qbit.getFiles;
    let refused = false;
    mock.method(qbit, 'getFiles', async function (this: unknown, hash: string) {
      // The first file-list request fails.
      if (!refused) {
        refused = true;
        throw new Error('qBittorrent is restarting');
      }
      return getFiles.call(this, hash);
    });
    await requestSongs([LANTERN]);
    await startFetching();
    let fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');
    assert.equal(fetch.stage, 'Choosing the songs’ files', 'still to pick');
    assert.deepEqual(priorities, []);

    await songFetcher.tick();
    fetch = await fetchOf();
    assert.deepEqual(priorities, [
      { indexes: [0, 2], priority: 0 },
      { indexes: [1], priority: 1 },
    ]);
    assert.notEqual(fetch.stage, 'Choosing the songs’ files');
  });

  it('never has Lidarr import a file named outside the torrent’s folder', async () => {
    const qbit = QBittorrentAPI.prototype;
    const getFiles = qbit.getFiles;
    mock.method(qbit, 'getFiles', async function (this: unknown, hash: string) {
      const files = await getFiles.call(this, hash);
      // Once finished, the client reports a path escaping the folder.
      return done
        ? files.map((f) => ({ ...f, name: `${INFO.name}/../../${f.name}` }))
        : files;
    });
    await requestSongs([LANTERN]);
    await startFetching();
    assert.equal((await fetchOf()).status, 'downloading');

    done = true;
    await songFetcher.tick();
    assert.notEqual((await fetchOf()).status, 'importing');
    assert.equal(
      lidarr.calls.filter(
        (c) => c.path === '/api/v1/command' && c.body?.name === 'ManualImport'
      ).length,
      0
    );
  });

  /** Sets up a Backfill Usenet client and a Usenet post of the album. */
  const useUsenet = (packed: boolean) => {
    const settings = getSettings();
    settings.backfill = { ...settings.backfill, usenetClientId: 2 };
    settings.downloadClients = [
      ...settings.downloadClients,
      {
        id: 2,
        name: 'SABnzbd',
        type: 'sabnzbd',
        hostname: 'sabnzbd',
        port: 8080,
        useSsl: false,
        urlBase: '',
        apiKey: 'k',
        username: '',
        password: '',
      },
    ];
    lidarr.remotePathMappings.push({
      host: 'sabnzbd',
      remotePath: '/downloads/',
      localPath: '/data/',
    });
    const folder = '/data/complete/Glasswing - Static Garden';
    lidarr.folders.set(folder, [
      { path: `${folder}/01 - Opening.flac`, size: 30 * MB },
      { path: `${folder}/02 - Lantern Song.flac`, size: 40 * MB },
    ]);
    const usenet: ProwlarrRelease = {
      ...RELEASE,
      guid: 'https://nzb/sg',
      indexer: 'NZBgeek',
      indexerId: 12,
      protocol: 'usenet',
      seeders: undefined,
    };
    const opened: string[] = [];
    mock.method(backfill, 'filesOf', async (release: ProwlarrRelease) => {
      opened.push(release.guid);
      if (release.protocol === 'usenet' && packed) {
        return { files: [], infoHash: null, packed: 'archives' };
      }
      return {
        files: INFO.files.map((f, index) => ({
          index,
          path: [INFO.name, ...f.path].join('/'),
          size: f.length,
        })),
        infoHash: release.protocol === 'usenet' ? null : HASH,
      };
    });
    mock.method(
      ProwlarrAPI.prototype,
      'fetchRelease',
      async (release: ProwlarrRelease) =>
        release.protocol === 'usenet'
          ? { kind: 'nzb', data: Buffer.from('<nzb/>') }
          : { kind: 'torrent', data: TORRENT }
    );
    mock.method(SabnzbdAPI.prototype, 'addNzb', async () => 'nzo-1');
    mock.method(SabnzbdAPI.prototype, 'getJob', async () => ({
      place: 'history',
      status: done ? 'Completed' : 'Downloading',
      percentage: done ? 100 : 40,
      size: RELEASE.size,
      sizeLeft: 0,
      storage: '/downloads/complete/Glasswing - Static Garden',
    }));
    mock.method(SabnzbdAPI.prototype, 'deleteJob', async () => undefined);
    return { usenet, opened };
  };

  /** Paths sent to Lidarr's manual import. */
  const importedPaths = () =>
    (
      lidarr.calls.find(
        (c) =>
          c.method === 'POST' &&
          c.path === '/api/v1/command' &&
          c.body?.name === 'ManualImport'
      )?.body?.files as { path: string; trackIds: number[] }[]
    ).map((f) => [f.path, f.trackIds]);

  it('takes the song from Usenet rather than a torrent nobody shares', async () => {
    const { usenet, opened } = useUsenet(false);
    const unshared = {
      ...RELEASE,
      guid: 'https://indexer/dead',
      seeders: 0,
    };
    found = [unshared, usenet];
    await requestSongs([LANTERN]);
    await startFetching();

    let fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');
    assert.equal(fetch.release?.protocol, 'usenet');
    // The unseeded torrent's file list isn't requested.
    assert.deepEqual(opened, [usenet.guid]);

    done = true;
    await songFetcher.tick();
    fetch = await fetchOf();
    assert.equal(fetch.status, 'importing');
    assert.deepEqual(importedPaths(), [
      [
        '/data/complete/Glasswing - Static Garden/02 - Lantern Song.flac',
        [502],
      ],
    ]);
  });

  it('gives up a Usenet download the client keeps paused, as a stalled torrent', async () => {
    getSettings().backfill = { ...getSettings().backfill, stallHours: 1 };
    const { usenet } = useUsenet(false);
    found = [usenet];
    await requestSongs([LANTERN]);
    await startFetching();
    mock.method(SabnzbdAPI.prototype, 'getJob', async () => ({
      place: 'queue',
      status: 'Paused',
      percentage: 40,
      size: RELEASE.size,
      sizeLeft: RELEASE.size * 0.6,
    }));
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      await songFetcher.tick();
      assert.equal((await fetchOf()).status, 'downloading');
      mock.timers.tick(2 * 60 * 60_000);
      await songFetcher.tick();
      const fetch = await fetchOf();
      assert.equal(fetch.status, 'searching', 'another release is looked for');
      assert.deepEqual(fetch.tried, [usenet.guid]);
    } finally {
      mock.timers.reset();
    }
  });

  it('downloads only the song from a Usenet post, and moves it in', async () => {
    const { usenet } = useUsenet(false);
    const file = (subject: string, bytes: number) =>
      `<file poster="p" date="1" subject="${subject}"><segments><segment bytes="${bytes}" number="1">x@y</segment></segments></file>`;
    const nzb = `<?xml version="1.0"?><nzb>${[
      file('&quot;01 - Opening.flac&quot; yEnc', 30 * MB),
      file('&quot;02 - Lantern Song.flac&quot; yEnc', 40 * MB),
    ].join('')}</nzb>`;
    mock.method(ProwlarrAPI.prototype, 'fetchRelease', async () => ({
      kind: 'nzb',
      data: Buffer.from(nzb),
    }));
    mock.method(backfill, 'filesOf', async () => ({
      files: [
        { index: 0, path: '01 - Opening.flac', size: 30 * MB },
        { index: 1, path: '02 - Lantern Song.flac', size: 40 * MB },
      ],
      infoHash: null,
    }));
    const sent: string[] = [];
    mock.method(SabnzbdAPI.prototype, 'addNzb', async (data: Buffer) => {
      sent.push(data.toString('utf8'));
      return 'nzo-1';
    });
    found = [usenet];
    await requestSongs([LANTERN]);
    await startFetching();
    assert.deepEqual(
      readNzb(sent[0]).files.map((f) => f.name),
      ['02 - Lantern Song.flac']
    );

    done = true;
    await songFetcher.tick();
    const command = lidarr.calls.find(
      (c) => c.method === 'POST' && c.body?.name === 'ManualImport'
    );
    assert.equal(command?.body?.importMode, 'move');
  });

  it('prefers what Lidarr’s delay profile prefers', async () => {
    const { usenet } = useUsenet(false);
    found = [RELEASE, usenet];
    await requestSongs([LANTERN]);
    await startFetching();
    assert.equal((await fetchOf()).release?.protocol, 'usenet');
  });

  it('prefers a shared torrent when Lidarr prefers torrents', async () => {
    const { usenet } = useUsenet(false);
    lidarr.delayProfiles[0].preferredProtocol = 'torrent';
    found = [usenet, RELEASE];
    await requestSongs([LANTERN]);
    await startFetching();
    assert.equal((await fetchOf()).release?.protocol, 'torrent');
  });

  it('leaves out what Lidarr is told not to use', async () => {
    const { usenet } = useUsenet(false);
    lidarr.delayProfiles[0].enableUsenet = false;
    found = [usenet, { ...RELEASE, seeders: 0 }];
    await requestSongs([LANTERN]);
    await startFetching();
    assert.equal((await fetchOf()).release?.protocol, 'torrent');
  });

  it('takes the song from a packed Usenet post, finding it once unpacked', async () => {
    const { usenet } = useUsenet(true);
    found = [usenet];
    await requestSongs([LANTERN]);
    await startFetching();

    let fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');
    assert.equal(fetch.release?.guid, usenet.guid);

    done = true;
    await songFetcher.tick();
    fetch = await fetchOf();
    assert.equal(fetch.status, 'importing');
    assert.deepEqual(importedPaths(), [
      [
        '/data/complete/Glasswing - Static Garden/02 - Lantern Song.flac',
        [502],
      ],
    ]);
  });

  it('finds the song by its name when the download renamed its files', async () => {
    const { usenet } = useUsenet(false);
    // Post names differ from the downloaded file names.
    mock.method(backfill, 'filesOf', async () => ({
      files: [
        {
          index: 0,
          path: 'Glasswing - Static Garden - 01 - Opening.flac',
          size: 30 * MB,
        },
        {
          index: 1,
          path: 'Glasswing - Static Garden - 02 - Lantern Song.flac',
          size: 40 * MB,
        },
      ],
      infoHash: null,
    }));
    found = [usenet];
    await requestSongs([LANTERN]);
    await startFetching();
    assert.equal((await fetchOf()).status, 'downloading');

    done = true;
    await songFetcher.tick();
    const fetch = await fetchOf();
    assert.equal(fetch.status, 'importing');
    assert.deepEqual(importedPaths(), [
      [
        '/data/complete/Glasswing - Static Garden/02 - Lantern Song.flac',
        [502],
      ],
    ]);
  });

  it('tries another release when the download turns out not to have the song', async () => {
    const { usenet } = useUsenet(true);
    const other = { ...usenet, guid: 'https://nzb/sg-2' };
    found = [usenet, other];
    lidarr.folders.set('/data/complete/Glasswing - Static Garden', [
      {
        path: '/data/complete/Glasswing - Static Garden/01 - Opening.flac',
        size: 30 * MB,
      },
    ]);
    await requestSongs([LANTERN]);
    await startFetching();
    done = true;
    await songFetcher.tick();

    const fetch = await fetchOf();
    assert.equal(fetch.status, 'searching');
    assert.deepEqual(fetch.tried, [usenet.guid]);
    const song = await getRepository(SongRequest).findOneByOrFail({
      recordingMbid: LANTERN,
    });
    assert.equal(song.status, MediaRequestStatus.APPROVED, 'not failed');
  });

  it('still takes a torrent nobody seems to share when it is all there is', async () => {
    found = [{ ...RELEASE, seeders: 0 }];
    await requestSongs([LANTERN]);
    await startFetching();
    const fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');
    assert.equal(fetch.release?.protocol, 'torrent');
  });

  it('searches again soon when Prowlarr doesn’t answer, without counting it', async () => {
    let failing = 2;
    mock.method(ProwlarrAPI.prototype, 'search', async () => {
      if (failing > 0) {
        failing--;
        throw new Error('timeout of 90000ms exceeded');
      }
      return found;
    });
    await requestSongs([LANTERN]);
    await startFetching();

    let fetch = await fetchOf();
    assert.equal(fetch.status, 'searching');
    assert.equal(fetch.searches ?? 0, 0);
    // Minutes, not the next tick nor the empty-search hours.
    const wait = (fetch.searchAgainAt?.getTime() ?? 0) - Date.now();
    assert.ok(wait > 5 * 60_000 && wait <= 10 * 60_000, String(wait));
    const asked = searches();
    await songFetcher.tick();
    assert.equal(searches(), asked, 'not asked again straight away');

    // One search answering is enough.
    failing = 1;
    await getRepository(SongFetch).update(fetch.id, { searchAgainAt: null });
    await songFetcher.tick();
    fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');
  });

  it('passes over an indexer waiting out its limit, and waits minutes when that is all', async () => {
    const resting = {
      ...RELEASE,
      guid: 'https://resting/sg',
      indexer: 'Resting',
      indexerId: 9,
      infoHash: undefined,
      seeders: 500,
    };
    const opened: string[] = [];
    const filesOf = backfill.filesOf.bind(backfill);
    mock.method(backfill, 'filesOf', async (release: ProwlarrRelease) => {
      opened.push(release.guid);
      if (release.indexerId === 9) {
        throw new IndexerLimitReached(
          'Resting',
          'download',
          new Date(Date.now() + 3_600_000),
          1,
          false
        );
      }
      return filesOf(release);
    });
    found = [resting, RELEASE];
    await requestSongs([LANTERN]);
    await startFetching();
    let fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');
    assert.equal(fetch.release?.guid, RELEASE.guid);
    assert.deepEqual(opened.slice(0, 2), [resting.guid, RELEASE.guid]);

    // Only the resting indexer has it: retry in minutes, uncounted.
    await getRepository(SongFetch).clear();
    found = [resting];
    await songFetcher.tick();
    fetch = await fetchOf();
    assert.equal(fetch.status, 'searching');
    assert.equal(fetch.searches ?? 0, 0);
    const wait = (fetch.searchAgainAt?.getTime() ?? 0) - Date.now();
    assert.ok(wait > 5 * 60_000 && wait <= 10 * 60_000, String(wait));
  });

  it('asks only Prowlarr’s indexers with music that are answering', async () => {
    const asked: (number[] | undefined)[] = [];
    mock.method(
      ProwlarrAPI.prototype,
      'search',
      async (_term: string, options: { indexerIds?: number[] }) => {
        asked.push(options.indexerIds);
        return found;
      }
    );
    await requestSongs([LANTERN]);
    await startFetching();
    assert.deepEqual(asked[0], [3, 12]);
    assert.equal((await fetchOf()).status, 'downloading');
  });

  it('waits, without counting a search, while no indexer with music answers', async () => {
    mock.method(ProwlarrAPI.prototype, 'musicIndexerIds', async () => []);
    await requestSongs([LANTERN]);
    await startFetching();
    const fetch = await fetchOf();
    assert.equal(fetch.status, 'searching');
    assert.equal(searches(), 0);
    assert.equal(fetch.searches ?? 0, 0);
  });

  it('searches a waiting album again now, without counting the wait', async () => {
    found = [{ ...RELEASE, title: 'Someone Else - Other Album [MP3]' }];
    await requestSongs([LANTERN]);
    await startFetching();
    let fetch = await fetchOf();
    assert.equal(fetch.searches, 1);
    assert.equal(await albumsWaitingToSearch([LANTERN]), 1);
    assert.equal(await albumsWaitingToSearch([OPENING]), 0);

    assert.equal(await searchAgainNow([LANTERN]), 1);
    assert.equal(await albumsWaitingToSearch([LANTERN]), 0);
    const searched = searches();
    await songFetcher.tick();
    // Both album searches, plus the artist search for packs.
    assert.equal(searches(), searched + 3, 'its searches, now');
    fetch = await fetchOf();
    // Empty again: waits as long as the first time.
    assert.equal(fetch.searches, 1);
    assert.ok(fetch.searchAgainAt!.getTime() > Date.now());
  });

  it('waits for a download slot without searching again', async () => {
    getSettings().backfill = { ...getSettings().backfill, maxMusicJobs: 0 };
    await requestSongs([LANTERN]);
    await startFetching();
    let fetch = await fetchOf();
    assert.equal(fetch.status, 'searching');
    assert.equal(fetch.stage, 'Waiting for another song download to finish');
    const searched = searches();

    await songFetcher.tick();
    await songFetcher.tick();
    assert.equal(searches(), searched, 'the release chosen is kept');

    getSettings().backfill = { ...getSettings().backfill, maxMusicJobs: 1 };
    await songFetcher.tick();
    fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');
    assert.equal(searches(), searched);
  });

  it('is refused, naming the album, while taking songs from albums is off', async () => {
    getSettings().music.songsFromAlbums = false;
    await assert.rejects(
      requestSongs([LANTERN]),
      (e: Error) =>
        e instanceof InvalidMusicRequestError &&
        e.message ===
          "Lantern Song is only on albums, so it can't be requested on its own. Request Static Garden instead."
    );
    assert.equal(await getRepository(SongRequest).count(), 0);
  });

  it('is refused while Backfill is not set up to fetch it', async () => {
    const settings = getSettings();
    settings.backfill = { ...settings.backfill, enabled: false };
    await assert.rejects(requestSongs([LANTERN]), InvalidMusicRequestError);
    await songFetcher.tick();
    assert.equal(await getRepository(SongFetch).count(), 0);
  });
});

describe('choosing a release of an album', () => {
  it('opens shared torrents, then Usenet, then torrents nobody shares', () => {
    const release = (
      guid: string,
      protocol: 'torrent' | 'usenet',
      seeders?: number
    ): ProwlarrRelease => ({ ...RELEASE, guid, protocol, seeders });
    assert.deepEqual(
      rankReleases([
        release('dead', 'torrent', 0),
        release('nzb', 'usenet'),
        release('few', 'torrent', 2),
        release('many', 'torrent', 40),
        release('unknown', 'torrent'),
      ]).map((r) => r.guid),
      ['many', 'few', 'unknown', 'nzb', 'dead']
    );
    // Lidarr prefers Usenet: Usenet first, unseeded torrents still last.
    assert.deepEqual(
      rankReleases(
        [
          release('dead', 'torrent', 0),
          release('many', 'torrent', 40),
          release('nzb', 'usenet'),
        ],
        'usenet'
      ).map((r) => r.guid),
      ['nzb', 'many', 'dead']
    );
  });

  it('follows the delay profile Lidarr uses for the artist', () => {
    const profile = (id: number, order: number, tags: number[]) => ({
      id,
      enableUsenet: true,
      enableTorrent: true,
      preferredProtocol: 'torrent' as const,
      order,
      tags,
    });
    const profiles = [
      profile(1, 2147483647, []),
      profile(2, 2, [7]),
      profile(3, 1, [7, 8]),
    ];
    assert.equal(delayProfileFor(profiles, [7])?.id, 3);
    assert.equal(delayProfileFor(profiles, [9])?.id, 1);
    assert.equal(delayProfileFor([], [7]), undefined);
  });

  it('lets a download that brings nothing stop holding up the next song', () => {
    const now = Date.now();
    const minutes = (n: number) => n * 60_000;
    assert.equal(
      holdsSlot(
        { stage: 'Downloading, 40%', startedAt: null },
        minutes(2),
        now
      ),
      true
    );
    assert.equal(
      holdsSlot(
        { stage: 'Downloading, 40%', startedAt: null },
        minutes(20),
        now
      ),
      false
    );
    const choosing = 'Choosing the songs’ files';
    assert.equal(
      holdsSlot(
        { stage: choosing, startedAt: new Date(now - minutes(5)) },
        0,
        now
      ),
      true
    );
    assert.equal(
      holdsSlot(
        { stage: choosing, startedAt: new Date(now - minutes(20)) },
        0,
        now
      ),
      false
    );
  });
});

describe('the order fetches move along in', () => {
  it('takes quick steps before searches, oldest first', () => {
    const fetch = (id: number, status: string, chosen = false) => ({
      id,
      status,
      release: chosen ? { title: 'Static Garden' } : null,
      files: chosen ? [{ index: 0 }] : [],
    });
    const order = quickestFirst([
      fetch(1, 'searching'),
      fetch(2, 'searching', true),
      fetch(3, 'queued'),
      fetch(4, 'searching'),
      fetch(5, 'downloading'),
      fetch(6, 'importing'),
    ] as unknown as Parameters<typeof quickestFirst>[0]).map((f) => f.id);
    assert.deepEqual(order, [2, 3, 5, 6, 1, 4]);
  });
});

describe('reading a release of an album', () => {
  it('knows the album by its name and artist', () => {
    assert.equal(
      namesAlbum(
        'Glasswing - Static Garden (1997) [FLAC]',
        'Static Garden',
        'Glasswing'
      ),
      true
    );
    assert.equal(
      namesAlbum(
        'Glasswing - Static Garden Remixed [MP3]',
        'Static Garden Remixed Deluxe',
        'Glasswing'
      ),
      false
    );
    assert.equal(
      namesAlbum('Other Band - Static Garden', 'Static Garden', 'Glasswing'),
      false
    );
    // A music video under the single's name.
    for (const video of [
      'Glasswing - Lantern Song [1080p]',
      'Glasswing-Lantern_Song-720p-x264-2014',
      'Glasswing - Lantern Song (Official Music Video) HEVC',
    ]) {
      assert.equal(
        namesAlbum(video, 'Lantern Song', 'Glasswing'),
        false,
        video
      );
    }
  });

  it('is not fooled by a compilation, or by the file a post is of', () => {
    // A compilation track by another artist sharing a title word.
    assert.equal(
      namesAlbum(
        'Various Artists - 2011 - Road Hits "22-other_singer-thank_you_for_lantern_nights.mp3"',
        'Lantern',
        'Glasswing'
      ),
      false
    );
    assert.equal(
      namesAlbum('VA - Road Hits - Lantern Mix (2CD)', 'Lantern', 'Glasswing'),
      false
    );
    // A single-file post from another album, the file named for this one.
    assert.equal(
      namesAlbum(
        'Glasswing - 2010 - Live at the Pier (2CD) %22101-glasswing-static_garden.mp3%22',
        'Static Garden',
        'Glasswing'
      ),
      false
    );
    assert.equal(
      namesAlbum(
        'Glasswing - Static Garden (1997) "01 - Opening.flac"',
        'Static Garden',
        'Glasswing'
      ),
      true
    );
    // A Various Artists album may use VA.
    assert.equal(
      namesAlbum('VA - Road Hits (2011) MP3', 'Road Hits', 'Various Artists'),
      true
    );
  });

  it('finds the song’s file by its name, not a longer one holding it', () => {
    const files = [
      {
        index: 0,
        path: 'A/01 - Glasswing - Lantern Song (Remix).mp3',
        size: 9 * MB,
      },
      { index: 1, path: 'A/02 - Glasswing - Lantern Song.mp3', size: 9 * MB },
      { index: 2, path: 'A/03 - 99 Rooms.mp3', size: 9 * MB },
      { index: 3, path: 'A/Lantern Song.txt', size: 1 * MB },
    ];
    assert.equal(fileForTrack(files, 'Lantern Song', 'Glasswing')?.index, 1);
    assert.equal(fileForTrack(files, '99 Rooms', 'Glasswing')?.index, 2);
    assert.equal(fileForTrack(files, 'Missing', 'Glasswing'), undefined);
    assert.deepEqual(
      songsOfFile('CD1/1-03 Lantern Song.flac', 'Glasswing')[0],
      'lantern song'
    );
  });

  it('reads a name with its apostrophes dropped or spaced', () => {
    const files = [
      { index: 0, path: 'A/03-glasswing-dont_wait_up-grp.mp3', size: 9 * MB },
      {
        index: 1,
        path: 'A/04-glasswing-its_half_past_static-grp.mp3',
        size: 9 * MB,
      },
      {
        index: 2,
        path: 'A/05 - Glasswing - Ain t No Harbour.mp3',
        size: 9 * MB,
      },
    ];
    assert.equal(
      fileForTrack(files, 'It’s Half Past Static', 'Glasswing')?.index,
      1
    );
    assert.equal(fileForTrack(files, "Don't Wait Up", 'Glasswing')?.index, 0);
    assert.equal(
      fileForTrack(files, 'Ain’t No Harbour', 'Glasswing')?.index,
      2
    );
    for (const title of [
      'Glasswing - Aint No Harbour (2024) MP3',
      'Glasswing - Ain t No Harbour [FLAC]',
      'Glasswing - Ain’t No Harbour (2024)',
    ]) {
      assert.equal(
        namesAlbum(title, 'Ain’t No Harbour', 'Glasswing'),
        true,
        title
      );
    }
    assert.equal(
      namesAlbum(
        'Glasswing - Static Garden (Glasswings Version)',
        'Static Garden',
        'Glasswing'
      ),
      false
    );
  });

  it('knows a pack of the artist’s own releases', () => {
    for (const title of [
      'Glasswing - Discography 2011 - 2021 (1 Album + 20 Singles) MP3, 320 kbps',
      '(Country) Glasswing - Collection: 25 Releases (2012-2023), MP3',
      'Glasswing - 7 Albums (1995-2020) FLAC',
    ]) {
      assert.equal(namesCatalog(title, 'Glasswing'), true, title);
    }
    for (const title of [
      // Another artist's pack featuring them.
      'Other Band (with Glasswing) - Discography - 1991 - 2023',
      // An album, not a pack.
      'Glasswing - Static Garden (1997) [FLAC]',
      'VA - Road Hits Collection (2011)',
    ]) {
      assert.equal(namesCatalog(title, 'Glasswing'), false, title);
    }
    assert.equal(
      namesCatalog('VA - Road Hits Collection (2011)', 'Various Artists'),
      false
    );
  });

  it('takes a song from the album’s folder of a pack, never a live album’s', () => {
    const files = [
      {
        index: 0,
        path: 'P/2010 - Live at the Pier/02 - Lantern Song.mp3',
        size: 9 * MB,
      },
      {
        index: 1,
        path: 'P/Singles/2014 - Lantern Song/01 - Lantern Song.mp3',
        size: 9 * MB,
      },
      {
        index: 2,
        path: 'P/1997 - Static Garden/02 - Lantern Song.mp3',
        size: 9 * MB,
      },
    ];
    assert.equal(
      fileInCatalog(files, 'Lantern Song', 'Static Garden', 'Glasswing')?.index,
      2
    );
    // No album folder: any other folder except the live album's.
    const other = fileInCatalog(
      files.slice(0, 2),
      'Lantern Song',
      'Harbour Lights',
      'Glasswing'
    );
    assert.equal(other?.index, 1);
    assert.equal(
      fileInCatalog(
        files.slice(0, 1),
        'Lantern Song',
        'Static Garden',
        'Glasswing'
      ),
      undefined
    );
  });

  it('takes no other version of the album for it', () => {
    for (const title of [
      'Glasswing - Static Garden (Live at the Pier) [FLAC]',
      'Glasswing - Static Garden (Remixed) MP3',
      'Glasswing - Static Garden (Instrumentals)',
      'Sing Like Glasswing - Static Garden (Karaoke Version)',
      'Glasswing - Static Garden (Glasswing’s Version)',
      'Glasswing - Static Garden (2005) [Dolby Atmos]',
      'Glasswing - Static Garden (360 Reality Audio) FLAC',
      'Glasswing - Static Garden (Harbour Mix) (2020) FLAC',
      'Glasswing - Static Garden: The Piano Sessions',
    ]) {
      assert.equal(
        namesAlbum(title, 'Static Garden', 'Glasswing'),
        false,
        title
      );
    }
    // A remaster is the same take.
    assert.equal(
      namesAlbum(
        'Glasswing - Static Garden (Remastered 2015) [FLAC]',
        'Static Garden',
        'Glasswing'
      ),
      true
    );
    // A version word that is part of the album title.
    assert.equal(
      namesAlbum(
        'Glasswing - Live at the Pier (2010) FLAC',
        'Live at the Pier',
        'Glasswing'
      ),
      true
    );
    assert.equal(
      namesAlbum(
        'Glasswing - Static Garden (Harbour Mix) (2020) FLAC',
        'Static Garden (Harbour Mix)',
        'Glasswing'
      ),
      true
    );
    // A band named with a version word.
    assert.equal(
      namesAlbum(
        'Glasswing - Static Garden (1994)',
        'Static Garden',
        'Glasswing'
      ),
      true
    );
  });

  it('knows an album named with a sign', () => {
    assert.equal(
      namesAlbum('Glasswing - ÷ (2017) [FLAC]', '÷', 'Glasswing'),
      true
    );
    assert.equal(
      namesAlbum('Glasswing - Static Garden (2017)', '÷', 'Glasswing'),
      false
    );
    assert.equal(namesAlbum('Other - ÷ (2017)', '÷', 'Glasswing'), false);
  });

  it('knows a self-titled album from the artist’s other albums', () => {
    assert.equal(
      namesAlbum('Glasswing - Static Garden (1997)', 'Glasswing', 'Glasswing'),
      false
    );
    assert.equal(
      namesAlbum('Glasswing - Glasswing (1995) FLAC', 'Glasswing', 'Glasswing'),
      true
    );
  });

  it('takes no other version of the song, and the title track by its title', () => {
    const live = [
      { index: 0, path: 'A/02 - Lantern Song (Live).flac', size: 40 * MB },
      {
        index: 1,
        path: 'A/03 - Lantern Song (2011 Remaster).flac',
        size: 40 * MB,
      },
      { index: 2, path: 'A/04 - Lantern Song - Take 37.flac', size: 40 * MB },
    ];
    assert.equal(fileForTrack(live, 'Lantern Song', 'Glasswing')?.index, 1);
    assert.equal(
      fileForTrack(live.slice(0, 1), 'Lantern Song', 'Glasswing'),
      undefined
    );
    assert.equal(
      fileForTrack(live, 'Lantern Song (Live)', 'Glasswing')?.index,
      0
    );

    const named = [
      {
        index: 0,
        path: 'Glasswing - Static Garden - 01 - Opening.flac',
        size: 30 * MB,
      },
      {
        index: 1,
        path: 'Glasswing - Static Garden - 02 - Static Garden.flac',
        size: 40 * MB,
      },
    ];
    assert.equal(fileForTrack(named, 'Static Garden', 'Glasswing')?.index, 1);
    assert.equal(
      fileForTrack(named.slice(0, 1), 'Static Garden', 'Glasswing'),
      undefined
    );
  });

  it('passes over a whole album in one file', () => {
    const image = [
      { index: 0, path: 'A/Glasswing - Lantern Song.flac', size: 400 * MB },
      { index: 1, path: 'A/Glasswing - Lantern Song.cue', size: 1000 },
    ];
    assert.equal(fileForTrack(image, 'Lantern Song', 'Glasswing'), undefined);
  });
});

describe('taking a song from Soulseek', () => {
  const SHARED =
    'Music\\Glasswing\\1997 - Static Garden\\02 - Lantern Song.flac';
  const sharer = (
    username: string,
    files: string[],
    more: Partial<SlskdResponse> = {}
  ): SlskdResponse => ({
    username,
    files: files.map((filename) => ({ filename, size: 40 * MB, length: 200 })),
    hasFreeUploadSlot: true,
    queueLength: 0,
    uploadSpeed: 1_000_000,
    ...more,
  });
  let answers: SlskdResponse[];
  let searched: string[];
  let asked: { username: string; files: string[]; folder: string }[];
  let state: SlskdTransfer['state'];
  let removedTransfers: string[];
  let removedFolders: string[];

  beforeEach(() => {
    getSettings().music.soulseek = {
      url: 'http://slskd:5030',
      apiKey: 'k',
      downloadsPath: '/data/soulseek/complete',
    };
    // Prowlarr has no album or artist releases.
    found = [];
    answers = [
      sharer('lantern-fan', [
        'Music\\Glasswing\\2010 - Live at the Pier\\02 - Lantern Song.flac',
      ]),
      sharer('collector', [
        SHARED,
        'Music\\Glasswing\\1997 - Static Garden\\cover.jpg',
      ]),
    ];
    searched = [];
    asked = [];
    state = 'Queued, Remotely';
    removedTransfers = [];
    removedFolders = [];
    mock.method(SlskdAPI.prototype, 'search', async (text: string) => {
      searched.push(text);
      return answers;
    });
    mock.method(
      SlskdAPI.prototype,
      'download',
      async (
        username: string,
        files: { filename: string }[],
        folder: string
      ) => {
        if (username === 'offline-one') {
          throw new SlskdRefused('offline-one is offline on Soulseek.');
        }
        asked.push({ username, files: files.map((f) => f.filename), folder });
        return 'batch-1';
      }
    );
    mock.method(SlskdAPI.prototype, 'getBatch', async () => ({
      id: 'batch-1',
      username: asked.at(-1)?.username ?? '',
      transfers: [
        {
          id: 't-1',
          username: asked.at(-1)?.username ?? '',
          filename: SHARED,
          size: 40 * MB,
          state,
          bytesTransferred: state.startsWith('Completed') ? 40 * MB : 0,
          placeInQueue: state.startsWith('Queued') ? 3 : null,
        },
      ],
    }));
    mock.method(
      SlskdAPI.prototype,
      'removeTransfer',
      async (_user: string, id: string) => {
        removedTransfers.push(id);
      }
    );
    mock.method(
      SlskdAPI.prototype,
      'removeDownloadFolder',
      async (folder: string) => {
        removedFolders.push(folder);
      }
    );
  });

  it('asks a sharer for only the song’s file, and Lidarr moves it in', async () => {
    await requestSongs([LANTERN]);
    await startFetching();

    assert.deepEqual(searched, ['glasswing lantern song']);
    let fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');
    assert.equal(fetch.release?.protocol, 'soulseek');
    // The album take, not the live album's.
    assert.deepEqual(
      asked.map((a) => [a.username, a.files]),
      [['collector', [SHARED]]]
    );
    const folder = asked[0].folder;
    assert.match(folder, /^seerr-ai\/song-\d+-/);

    // Waiting in the sharer's queue.
    await songFetcher.tick();
    fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');
    assert.equal(fetch.stage, 'Waiting in a Soulseek queue, place 3');

    state = 'Completed, Succeeded';
    lidarr.folders.set(`/data/soulseek/complete/${folder}`, [
      { path: `/data/soulseek/complete/${folder}/02 - Lantern Song.flac` },
    ]);
    await songFetcher.tick();
    fetch = await fetchOf();
    assert.equal(fetch.status, 'importing');
    const imported = lidarr.calls.find(
      (c) =>
        c.method === 'POST' &&
        c.path === '/api/v1/command' &&
        c.body?.name === 'ManualImport'
    );
    assert.equal(imported?.body?.importMode, 'move');
    assert.deepEqual(
      (imported?.body?.files as { path: string; trackIds: number[] }[]).map(
        (f) => [f.path, f.trackIds]
      ),
      [[`/data/soulseek/complete/${folder}/02 - Lantern Song.flac`, [502]]]
    );

    await songFetcher.tick();
    fetch = await fetchOf();
    assert.equal(fetch.status, 'done');
    assert.deepEqual(removedTransfers, ['t-1']);
    assert.deepEqual(removedFolders, [folder]);
  });

  it('tries the next sharer when one is offline or a file fails', async () => {
    answers = [
      sharer('offline-one', [SHARED], { queueLength: 0 }),
      sharer('collector', [SHARED], { queueLength: 5 }),
    ];
    await requestSongs([LANTERN]);
    await startFetching();
    // The first sharer is offline and skipped next time.
    let fetch = await fetchOf();
    assert.ok(fetch.tried.includes('soulseek:offline-one'));
    await songFetcher.tick();
    fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');
    assert.equal(asked.at(-1)?.username, 'collector');

    state = 'Completed, Rejected';
    await songFetcher.tick();
    fetch = await fetchOf();
    assert.equal(fetch.status, 'searching');
    assert.match(fetch.stage ?? '', /Soulseek: Rejected/);
    assert.ok(fetch.tried.includes('soulseek:collector'));
    assert.deepEqual(removedTransfers, ['t-1']);
  });

  it('gives up on a sharer’s queue after two hours', async () => {
    await requestSongs([LANTERN]);
    await startFetching();
    const fetch = await fetchOf();
    await getRepository(SongFetch).update(fetch.id, {
      startedAt: new Date(Date.now() - 3 * 60 * 60_000),
    });
    await songFetcher.tick();
    const after = await fetchOf();
    assert.equal(after.status, 'searching');
    assert.match(after.stage ?? '', /two hours in the sharer’s queue/);
  });

  it('asks the sharer again into the same folder when slskd restarts', async () => {
    await requestSongs([LANTERN]);
    await startFetching();
    const folder = asked[0].folder;
    // slskd ended the transfer on shutdown and re-requested the file itself
    // outside the batch.
    const batches: Record<string, SlskdTransfer> = {
      'batch-1': {
        id: 't-1',
        username: 'collector',
        filename: SHARED,
        size: 40 * MB,
        state: 'Completed, Errored',
        bytesTransferred: 10 * MB,
        exception: 'Application shut down',
      },
    };
    mock.method(SlskdAPI.prototype, 'getBatch', async (id: string) =>
      batches[id]
        ? { id, username: 'collector', transfers: [batches[id]] }
        : null
    );
    mock.method(SlskdAPI.prototype, 'getDownloadsFrom', async () => [
      batches['batch-1'],
      {
        id: 't-own',
        username: 'collector',
        filename: SHARED,
        size: 40 * MB,
        state: 'Queued, Remotely',
        bytesTransferred: 0,
        batchId: null,
      },
    ]);
    mock.method(
      SlskdAPI.prototype,
      'download',
      async (username: string, files: { filename: string }[], to: string) => {
        asked.push({
          username,
          files: files.map((f) => f.filename),
          folder: to,
        });
        return 'batch-2';
      }
    );
    await songFetcher.tick();
    let fetch = await fetchOf();
    assert.equal(fetch.status, 'downloading');
    assert.equal(fetch.stage, 'Asked for on Soulseek again: slskd restarted');
    assert.equal(fetch.downloadId, 'batch-1,batch-2');
    assert.ok(!fetch.tried.includes('soulseek:collector'));
    // slskd's own retry, bound for the wrong folder, is removed.
    assert.deepEqual(removedTransfers, ['t-own']);
    assert.deepEqual(asked.at(-1), {
      username: 'collector',
      files: [SHARED],
      folder,
    });

    batches['batch-2'] = {
      id: 't-2',
      username: 'collector',
      filename: SHARED,
      size: 40 * MB,
      state: 'Completed, Succeeded',
      bytesTransferred: 40 * MB,
      batchId: 'batch-2',
    };
    lidarr.folders.set(`/data/soulseek/complete/${folder}`, [
      { path: `/data/soulseek/complete/${folder}/02 - Lantern Song.flac` },
    ]);
    await songFetcher.tick();
    fetch = await fetchOf();
    assert.equal(fetch.status, 'importing');
  });

  it('looks again soon, not counting a search, while slskd is down', async () => {
    mock.method(SlskdAPI.prototype, 'search', async () => {
      throw new Error('connect ECONNREFUSED');
    });
    await requestSongs([LANTERN]);
    await startFetching();
    const fetch = await fetchOf();
    assert.equal(fetch.status, 'searching');
    assert.equal(fetch.searches ?? 0, 0);
    assert.match(fetch.stage ?? '', /slskd isn’t answering/);
    const wait = (fetch.searchAgainAt?.getTime() ?? 0) - Date.now();
    assert.ok(wait > 20 * 60_000 && wait <= 30 * 60_000);
  });

  it('is not searched until it is set up', async () => {
    getSettings().music.soulseek = { url: '', apiKey: '', downloadsPath: '' };
    await requestSongs([LANTERN]);
    await startFetching();
    assert.deepEqual(searched, []);
    assert.equal((await fetchOf()).release, null);
  });
});
