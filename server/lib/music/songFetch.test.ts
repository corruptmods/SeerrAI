import QBittorrentAPI from '@server/api/downloadclients/qbittorrent';
import { MusicBrainz } from '@server/api/musicbrainz';
import type { MbArtist, MbRecording } from '@server/api/musicbrainz/interfaces';
import type { ProwlarrRelease } from '@server/api/prowlarr';
import ProwlarrAPI from '@server/api/prowlarr';
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
import backfill from '@server/lib/backfill/engine';
import cacheManager from '@server/lib/cache';
import {
  fileForTrack,
  namesAlbum,
  songsOfFile,
} from '@server/lib/music/albumRelease';
import { completeMusicRequests } from '@server/lib/music/completion';
import { songStandings } from '@server/lib/music/requestSongs';
import songFetcher from '@server/lib/music/songFetch';
import { Permission } from '@server/lib/permissions';
import {
  BACKFILL_DEFAULTS,
  getSettings,
  musicDefaults,
} from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { createFakeLidarr } from '@server/test/fakeLidarr';
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
 * Taking a song from its album: a release found through Prowlarr, only the
 * song's file downloaded, Lidarr's manual import of that one track into
 * the album (unmonitored), and the download removed. Prowlarr and
 * qBittorrent are stood in for; Lidarr is the fake one on localhost.
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

// A torrent of the album: two songs and a cover.
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

/** Adds the artist, then (next minute) the album, and starts. */
const startFetching = async () => {
  await songFetcher.tick();
  await songFetcher.tick();
};

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

    // The artist is added first; Lidarr lists their albums itself.
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
    // The artist and album are added, the album unmonitored and unsearched.
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
      (c) => c.method === 'POST' && c.path === '/api/v1/command'
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

    // The scans see the album partly here; the song is done.
    await getRepository(MusicAlbum).update(row.id, {
      status: MediaStatus.PARTIALLY_AVAILABLE,
    });
    // The fetch told Seerr which Lidarr has the artist, so the music
    // scans follow the album.
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

    // On the album's page, the song itself is here, though the album is
    // only partly.
    const standing = await songStandings([
      {
        mbId: LANTERN,
        releaseGroups: [
          {
            mbId: STATIC_GARDEN,
            title: 'Static Garden',
            primaryType: 'Album',
            secondaryTypes: [],
            date: '1997-05-21',
            byArtist: true,
          },
        ],
      },
    ]);
    assert.equal(standing.get(LANTERN)?.status, MediaStatus.AVAILABLE);
  });

  it('links the artist of a song taken before artists were linked', async () => {
    const request = await requestSongs([LANTERN]);
    await startFetching();
    done = true;
    await songFetcher.tick();
    await songFetcher.tick();
    assert.equal((await fetchOf()).status, 'done');
    // As an older Seerr AI left it: the song on file, the artist unlinked.
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

  it('takes another song from an album one was already taken from', async () => {
    await requestSongs([LANTERN]);
    await startFetching();
    done = true;
    await songFetcher.tick();
    await songFetcher.tick();
    assert.equal((await fetchOf()).status, 'done');
    const first = await fetchOf();
    // The scans see the album partly here: one song of it.
    await getRepository(MusicAlbum).update(
      { mbId: STATIC_GARDEN },
      { status: MediaStatus.PARTIALLY_AVAILABLE }
    );

    // The album's other song, asked for afterwards.
    done = false;
    priorities = [];
    const second = await requestSongs([OPENING]);
    assert.equal(second.status, MediaRequestStatus.APPROVED, 'not refused');
    await songFetcher.tick();

    const fetch = await fetchOf();
    assert.notEqual(fetch.id, first.id, 'a fetch of its own');
    assert.deepEqual(fetch.recordings, [OPENING]);
    assert.equal(fetch.status, 'downloading');
    // Into the same edition the first went into, only its own file.
    assert.equal(fetch.lidarrReleaseId, first.lidarrReleaseId);
    assert.deepEqual(
      fetch.files.map((f) => f.trackId),
      [501]
    );
    assert.deepEqual(priorities, [
      { indexes: [1, 2], priority: 0 },
      { indexes: [0], priority: 1 },
    ]);
    // Lidarr already had the artist and album: neither added again.
    assert.equal(
      lidarr.calls.filter(
        (c) => c.method === 'POST' && c.path !== '/api/v1/command'
      ).length,
      2
    );
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

  it('fails the song, saying why, when no release has it', async () => {
    found = [{ ...RELEASE, title: 'Someone Else - Other Album [MP3]' }];
    const request = await requestSongs([LANTERN]);

    await startFetching();

    assert.equal((await fetchOf()).status, 'failed');
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
    // Lidarr already has the artist and album, monitoring a bootleg box
    // without the song; the usual official edition has it.
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
    // Neither the album nor the artist was changed to get there.
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
    // Lidarr's refresh of the new artist lists the album meanwhile.
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
});
