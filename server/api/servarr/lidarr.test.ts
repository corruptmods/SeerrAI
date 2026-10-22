import type { LidarrAlbum, LidarrArtist } from '@server/api/servarr/lidarr';
import LidarrAPI from '@server/api/servarr/lidarr';
import cacheManager from '@server/lib/cache';
import type { AxiosInstance } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

/*
 * Lidarr's client: the requests Seerr makes to add artists and albums and
 * to monitor exactly what was asked for.
 */

const ARTIST_MBID = '3c9e5f21-8d47-4b6a-a1e3-5f7d2c90b844';
const ALBUM_MBID = '7e41c0d8-5b29-3f6c-b8a4-91d6e2f07a35';

const buildLidarr = () =>
  new LidarrAPI({ url: 'http://localhost:8686/api/v1', apiKey: 'test' });

const getAxios = (lidarr: LidarrAPI): AxiosInstance =>
  (lidarr as unknown as { axios: AxiosInstance }).axios;

const artist: LidarrArtist = {
  id: 0,
  artistName: 'Glasswing',
  foreignArtistId: ARTIST_MBID,
  monitored: false,
  qualityProfileId: 0,
  metadataProfileId: 0,
  tags: [],
};

const album: LidarrAlbum = {
  id: 0,
  title: 'Static Garden',
  foreignAlbumId: ALBUM_MBID,
  artistId: 0,
  monitored: false,
};

describe('LidarrAPI', () => {
  afterEach(() => {
    mock.restoreAll();
    cacheManager.getCache('lidarr').flush();
  });

  it('is reached at the address and key it was given', () => {
    const lidarr = buildLidarr();
    assert.equal(
      getAxios(lidarr).defaults.baseURL,
      'http://localhost:8686/api/v1'
    );
    assert.deepEqual(getAxios(lidarr).defaults.params, { apikey: 'test' });
  });

  it('looks artists and albums up by MusicBrainz id', async () => {
    const lidarr = buildLidarr();
    const get = mock.method(getAxios(lidarr), 'get', async (path: string) => ({
      data:
        path === '/artist/lookup'
          ? [{ ...artist, foreignArtistId: 'someone-else' }, artist]
          : [album],
    }));

    assert.equal(
      (await lidarr.lookupArtist(ARTIST_MBID))?.artistName,
      'Glasswing'
    );
    assert.equal(
      (await lidarr.lookupAlbum(ALBUM_MBID))?.title,
      'Static Garden'
    );
    assert.deepEqual(get.mock.calls[0].arguments, [
      '/artist/lookup',
      { params: { term: `lidarr:${ARTIST_MBID}` } },
    ]);
    assert.deepEqual(get.mock.calls[1].arguments, [
      '/album/lookup',
      { params: { term: `lidarr:${ALBUM_MBID}` } },
    ]);
  });

  it('finds an artist it has, and none it does not', async () => {
    const lidarr = buildLidarr();
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      data: [{ ...artist, id: 4 }],
    }));
    assert.equal((await lidarr.getArtistByMbid(ARTIST_MBID))?.id, 4);
    assert.deepEqual(get.mock.calls[0].arguments, [
      '/artist',
      { params: { mbId: ARTIST_MBID } },
    ]);
    assert.equal(await lidarr.getArtistByMbid('another-id'), undefined);
  });

  it('lists one artist’s albums, or every album', async () => {
    const lidarr = buildLidarr();
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      data: [album],
    }));
    await lidarr.getAlbums({ artistId: 4 });
    await lidarr.getAlbums();
    assert.deepEqual(get.mock.calls[0].arguments, [
      '/album',
      { params: { artistId: 4 } },
    ]);
    assert.deepEqual(get.mock.calls[1].arguments, ['/album', { params: {} }]);
  });

  it('adds a new artist with only the requested albums monitored', async () => {
    const lidarr = buildLidarr();
    const post = mock.method(getAxios(lidarr), 'post', async () => ({
      data: { ...artist, id: 9 },
    }));
    const added = await lidarr.addArtist(artist, {
      qualityProfileId: 1,
      metadataProfileId: 2,
      rootFolderPath: '/music',
      tags: [3],
      monitored: true,
      monitorNewItems: 'none',
      addOptions: {
        monitor: 'none',
        albumsToMonitor: [ALBUM_MBID],
        searchForMissingAlbums: true,
      },
    });
    assert.equal(added.id, 9);
    const [path, body] = post.mock.calls[0].arguments as [
      string,
      Record<string, unknown>,
    ];
    assert.equal(path, '/artist');
    assert.equal(body.foreignArtistId, ARTIST_MBID);
    assert.equal(body.monitorNewItems, 'none');
    assert.deepEqual(body.addOptions, {
      monitor: 'none',
      albumsToMonitor: [ALBUM_MBID],
      searchForMissingAlbums: true,
    });
  });

  it('adds one album, monitored, to an artist it already has', async () => {
    const lidarr = buildLidarr();
    const post = mock.method(getAxios(lidarr), 'post', async () => ({
      data: { ...album, id: 12 },
    }));
    await lidarr.addAlbum(album, {
      artist: { id: 4 },
      searchForNewAlbum: false,
    });
    const [path, body] = post.mock.calls[0].arguments as [
      string,
      Record<string, unknown>,
    ];
    assert.equal(path, '/album');
    assert.equal(body.monitored, true);
    assert.equal(body.anyReleaseOk, true);
    assert.deepEqual(body.artist, { id: 4 });
    assert.deepEqual(body.addOptions, { searchForNewAlbum: false });
  });

  it('monitors exactly the albums given, and searches for them', async () => {
    const lidarr = buildLidarr();
    const put = mock.method(getAxios(lidarr), 'put', async () => ({}));
    const post = mock.method(getAxios(lidarr), 'post', async () => ({}));

    await lidarr.monitorAlbums([1, 2]);
    await lidarr.monitorAlbums([]);
    await lidarr.searchAlbums([1, 2]);
    await lidarr.searchAlbums([]);

    assert.equal(put.mock.callCount(), 1);
    assert.deepEqual(put.mock.calls[0].arguments, [
      '/album/monitor',
      { albumIds: [1, 2], monitored: true },
    ]);
    assert.equal(post.mock.callCount(), 1);
    assert.deepEqual(post.mock.calls[0].arguments, [
      '/command',
      { name: 'AlbumSearch', albumIds: [1, 2] },
    ]);
  });

  it('reads the queue with each item’s album and artist', async () => {
    const lidarr = buildLidarr();
    const get = mock.method(getAxios(lidarr), 'get', async () => ({
      data: { totalRecords: 1, records: [{ id: 1, albumId: 12 }] },
    }));
    const queue = await lidarr.getMusicQueue();
    assert.equal(queue[0].albumId, 12);
    const [path, config] = get.mock.calls[0].arguments as [
      string,
      { params: Record<string, unknown> },
    ];
    assert.equal(path, '/queue');
    assert.equal(config.params.includeAlbum, true);
    assert.equal(config.params.includeArtist, true);
    assert.equal(config.params.includeEpisode, undefined);
  });

  it('says which request failed', async () => {
    const lidarr = buildLidarr();
    mock.method(getAxios(lidarr), 'get', async () => {
      throw new Error('connect ECONNREFUSED');
    });
    await assert.rejects(
      lidarr.getArtists(),
      /\[Lidarr\] Failed to retrieve artists: connect ECONNREFUSED/
    );
  });
});
