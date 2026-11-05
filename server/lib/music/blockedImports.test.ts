import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import SongRequest from '@server/entity/SongRequest';
import blockedImports, {
  heldBack,
  heldBackReason,
} from '@server/lib/music/blockedImports';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { createFakeLidarr } from '@server/test/fakeLidarr';
import { seedMusicFixtures } from '@server/utils/seedTestDb';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

/*
 * Lidarr blocks a single's download that has only the song (the edition
 * also has an instrumental); the requested song is imported into its track.
 */

setupTestDb();

const lidarr = createFakeLidarr();
const SINGLE = '9b1f0c55-2d0e-4a8c-9f4e-3e1c7b2a5d10';
const LANTERN = 'a1b2c3d4-0001-4000-8000-000000000001';
const FOLDER = '/data/torrents/music/Glasswing - Lantern Song (Single)';
const MB = 1024 ** 2;

const held = (over: Record<string, unknown> = {}) => ({
  id: 1,
  title: 'Glasswing - Lantern Song (Single) [MP3]',
  downloadId: 'HASH1',
  status: 'completed',
  trackedDownloadStatus: 'warning',
  trackedDownloadState: 'importBlocked',
  outputPath: FOLDER,
  artistId: 7,
  albumId: 40,
  artist: { id: 7, artistName: 'Glasswing', foreignArtistId: 'x' },
  album: { id: 40, title: 'Lantern Song', foreignAlbumId: SINGLE },
  statusMessages: [
    {
      title: 'Lantern Song.mp3',
      messages: ['Has missing tracks'],
    },
  ],
  ...over,
});

const requestSong = async () => {
  const { requests } = await seedMusicFixtures();
  return getRepository(SongRequest).save(
    new SongRequest({
      request: requests[MediaRequestStatus.APPROVED],
      recordingMbid: LANTERN,
      title: 'Lantern Song',
      version: null,
      length: 200_000,
      albumMbid: SINGLE,
      albumTitle: 'Lantern Song',
      singleMbid: SINGLE,
      singleTitle: 'Lantern Song',
      sourceAlbumMbid: null,
      sourceAlbumTitle: null,
      releaseGroups: [SINGLE],
      status: MediaRequestStatus.APPROVED,
    })
  );
};

const imports = () =>
  lidarr.calls
    .filter(
      (c) =>
        c.method === 'POST' &&
        c.path === '/api/v1/command' &&
        c.body?.name === 'ManualImport'
    )
    .flatMap(
      (c) =>
        c.body?.files as {
          path: string;
          trackIds: number[];
          albumReleaseId: number;
          downloadId?: string;
        }[]
    );

before(async () => {
  await lidarr.start();
});

after(() => {
  lidarr.stop();
});

beforeEach(() => {
  lidarr.reset();
  getSettings().lidarr = [lidarr.settings()];
  lidarr.albums.push({
    id: 40,
    title: 'Lantern Song',
    foreignAlbumId: SINGLE,
    artistId: 7,
    monitored: true,
    releases: [
      {
        id: 90,
        albumId: 40,
        foreignReleaseId: 'r-single',
        title: 'Lantern Song',
        monitored: true,
      },
    ],
  });
  lidarr.tracks.set(40, [
    { id: 601, albumId: 40, title: 'Lantern Song', hasFile: false },
    {
      id: 602,
      albumId: 40,
      title: 'Lantern Song (instrumental)',
      hasFile: false,
    },
  ]);
  lidarr.folders.set(FOLDER, [
    { path: `${FOLDER}/01 Lantern Song.mp3`, size: 8 * MB },
  ]);
});

afterEach(() => {
  getSettings().lidarr = [];
});

describe('a download Lidarr held back', () => {
  it('is told apart, with Lidarr’s reason', () => {
    const item = held() as never;
    assert.equal(heldBack(item), true);
    assert.equal(heldBackReason(item), 'Has missing tracks');
    assert.equal(
      heldBack(held({ trackedDownloadState: 'downloading' }) as never),
      false
    );
  });

  it('has its requested song imported on its own, into its track', async () => {
    await requestSong();
    lidarr.queue = [held()];
    await blockedImports.run();
    assert.deepEqual(
      imports().map((f) => [
        f.path,
        f.trackIds,
        f.albumReleaseId,
        f.downloadId,
      ]),
      [[`${FOLDER}/01 Lantern Song.mp3`, [601], 90, 'HASH1']]
    );

    // Not retried straight away.
    await blockedImports.run();
    assert.equal(imports().length, 1);
  });

  it('is left alone without a requested song, or without its file', async () => {
    lidarr.queue = [held()];
    await blockedImports.run();
    assert.equal(imports().length, 0, 'nobody asked for it');

    await requestSong();
    lidarr.queue = [held({ downloadId: 'HASH2' })];
    lidarr.folders.set(FOLDER, [
      { path: `${FOLDER}/02 Something Else.mp3`, size: 8 * MB },
    ]);
    await blockedImports.run();
    assert.equal(imports().length, 0, 'the song isn’t in it');
  });

  it('is imported when only its tags are too far, the file being the song by its own tags', async () => {
    await requestSong();
    lidarr.tracks.set(40, [
      {
        id: 601,
        albumId: 40,
        title: 'Lantern Song',
        duration: 200_000,
        hasFile: false,
      },
    ]);
    const tooFar = (downloadId: string) =>
      held({
        downloadId,
        statusMessages: [
          {
            title: 'Lantern Song.mp3',
            messages: [
              'Album match is not close enough: 77.7 % vs 80 % [artist, country, label]',
            ],
          },
        ],
      });
    const file = (title: string, duration: string) => [
      {
        path: `${FOLDER}/01 Lantern Song.mp3`,
        size: 8 * MB,
        audioTags: { title, duration },
      },
    ];

    // Another take, or far longer: not the song.
    lidarr.folders.set(FOLDER, file('Lantern Song (Live)', '00:03:21.0'));
    lidarr.queue = [tooFar('HASH5')];
    await blockedImports.run();
    lidarr.folders.set(FOLDER, file('Lantern Song', '00:05:02.0'));
    lidarr.queue = [tooFar('HASH6')];
    await blockedImports.run();
    // A bootleg remix is another take, however long.
    lidarr.folders.set(
      FOLDER,
      file('Lantern Song (Harbour Lights Bootleg)', '00:03:22.0')
    );
    lidarr.queue = [tooFar('HASH8')];
    await blockedImports.run();
    assert.equal(imports().length, 0);

    // Same take and length: the song.
    lidarr.folders.set(FOLDER, file('Lantern Song', '00:03:21.4'));
    lidarr.queue = [tooFar('HASH7')];
    await blockedImports.run();
    assert.deepEqual(
      imports().map((f) => [f.trackIds, f.downloadId]),
      [[[601], 'HASH7']]
    );
  });

  it('is left alone when it isn’t named as the single, or for another reason', async () => {
    await requestSong();
    lidarr.queue = [
      held({
        downloadId: 'HASH3',
        statusMessages: [
          { title: 'Lantern Song.mp3', messages: ['Not an upgrade'] },
        ],
      }),
      held({
        downloadId: 'HASH4',
        title: 'Various Artists - Road Hits (2011) [MP3]',
      }),
    ];
    await blockedImports.run();
    assert.equal(imports().length, 0);
  });
});
