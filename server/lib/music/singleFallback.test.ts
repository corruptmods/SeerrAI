import { MusicBrainz } from '@server/api/musicbrainz';
import type { MbRecording } from '@server/api/musicbrainz/interfaces';
import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import SongRequest from '@server/entity/SongRequest';
import singleFallback from '@server/lib/music/singleFallback';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { createFakeLidarr } from '@server/test/fakeLidarr';
import {
  MUSIC_FIXTURE_IDS as IDS,
  seedMusicFixtures,
} from '@server/utils/seedTestDb';
import assert from 'node:assert/strict';
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
 * A song asked for through its single, when Lidarr's search for the single
 * grabs nothing: it moves to the artist's album with the same recording, to
 * be taken from it, and Lidarr stops looking for the single.
 */

setupTestDb();

const lidarr = createFakeLidarr();
const SINGLE = '9b1f0c55-2d0e-4a8c-9f4e-3e1c7b2a5d10';
const ALBUM = '4f6a2d93-c1e8-3a57-9b02-6d3e8f1c7a40';
const LANTERN = 'a1b2c3d4-0001-4000-8000-000000000001';

const group = (id: string, title: string, type: string) => ({
  id,
  title,
  'primary-type': type,
  'secondary-types': [],
});

/** The recording, on the single and, unless `onAlbum` is false, an album. */
const recording = (onAlbum = true): MbRecording => {
  const credit = [
    { name: 'Glasswing', artist: { id: IDS.artist, name: 'Glasswing' } },
  ];
  return {
    id: LANTERN,
    title: 'Lantern Song',
    length: 200_000,
    'artist-credit': credit,
    releases: [
      {
        id: 'r-single',
        title: 'Lantern Song',
        status: 'Official',
        date: '2010-03-01',
        'artist-credit': credit,
        'release-group': group(SINGLE, 'Lantern Song', 'Single'),
      },
      ...(onAlbum
        ? [
            {
              id: 'r-album',
              title: 'Static Garden',
              status: 'Official',
              date: '2010-06-01',
              'artist-credit': credit,
              'release-group': group(ALBUM, 'Static Garden', 'Album'),
            },
          ]
        : []),
    ],
  } as MbRecording;
};

const requestSong = async () => {
  const { artist, requests } = await seedMusicFixtures();
  lidarr.artists.push({
    id: 7,
    artistName: 'Glasswing',
    foreignArtistId: artist.foreignId!,
    monitored: true,
    qualityProfileId: 1,
    metadataProfileId: 1,
    tags: [],
  } as never);
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
      releaseGroups: [SINGLE, ALBUM],
      status: MediaRequestStatus.APPROVED,
    })
  );
};

const searches = () =>
  lidarr.calls.filter(
    (c) =>
      c.method === 'POST' &&
      c.path === '/api/v1/command' &&
      c.body?.name === 'AlbumSearch'
  ).length;
const unmonitored = () =>
  lidarr.calls.some(
    (c) =>
      c.method === 'PUT' &&
      c.path === '/api/v1/album/monitor' &&
      c.body?.monitored === false
  );

before(async () => {
  await lidarr.start();
});

after(() => {
  lidarr.stop();
});

let onAlbum: boolean;

beforeEach(() => {
  lidarr.reset();
  onAlbum = true;
  getSettings().lidarr = [lidarr.settings()];
  lidarr.albums.push({
    id: 40,
    title: 'Lantern Song',
    foreignAlbumId: SINGLE,
    artistId: 7,
    monitored: true,
    statistics: { trackFileCount: 0, trackCount: 2 },
  } as never);
  mock.method(MusicBrainz.prototype, 'getRecording', async () =>
    recording(onAlbum)
  );
});

afterEach(() => {
  mock.restoreAll();
  getSettings().lidarr = [];
});

describe('a single Lidarr finds nothing for', () => {
  it('has its song taken from an album once Lidarr’s search grabs nothing', async () => {
    const song = await requestSong();
    await singleFallback.run();
    assert.equal(searches(), 1, 'Lidarr is asked to search for it');
    let now = await getRepository(SongRequest).findOneByOrFail({
      id: song.id,
    });
    assert.equal(now.singleMbid, SINGLE, 'not before the search is over');

    await singleFallback.run();
    now = await getRepository(SongRequest).findOneByOrFail({ id: song.id });
    assert.equal(now.singleMbid, null);
    assert.equal(now.sourceAlbumMbid, ALBUM);
    assert.equal(now.sourceAlbumTitle, 'Static Garden');
    assert.equal(unmonitored(), true, 'Lidarr stops looking for the single');
  });

  it('is left to Lidarr while a download for it is on its way', async () => {
    const song = await requestSong();
    lidarr.queue = [{ id: 1, albumId: 40, artistId: 7, title: 'x' }];
    await singleFallback.run();
    await singleFallback.run();
    assert.equal(searches(), 0);
    const now = await getRepository(SongRequest).findOneByOrFail({
      id: song.id,
    });
    assert.equal(now.singleMbid, SINGLE);
  });

  it('stays on its single when no album of the artist’s has the song', async () => {
    onAlbum = false;
    const song = await requestSong();
    await singleFallback.run();
    await singleFallback.run();
    const now = await getRepository(SongRequest).findOneByOrFail({
      id: song.id,
    });
    assert.equal(now.singleMbid, SINGLE);
    assert.equal(unmonitored(), false);
  });

  it('is left alone where Lidarr is told not to search', async () => {
    getSettings().lidarr = [lidarr.settings({ preventSearch: true })];
    const song = await requestSong();
    await singleFallback.run();
    await singleFallback.run();
    assert.equal(searches(), 0);
    const now = await getRepository(SongRequest).findOneByOrFail({
      id: song.id,
    });
    assert.equal(now.singleMbid, SINGLE);
  });
});
