import {
  COVER_PATH,
  albumCoverPath,
  albumCoverUrl,
  releaseCoverPath,
} from '@server/api/coverartarchive';
import ListenBrainzAPI from '@server/api/listenbrainz';
import TheAudioDb from '@server/api/theaudiodb';
import cacheManager from '@server/lib/cache';
import type { AxiosInstance } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

/*
 * The smaller music services: ListenBrainz for Discover, the Cover Art
 * Archive for covers, and TheAudioDB for artist pictures.
 */

const ALBUM = '7e41c0d8-5b29-3f6c-b8a4-91d6e2f07a35';
const ARTIST = '3c9e5f21-8d47-4b6a-a1e3-5f7d2c90b844';

const getAxios = (client: unknown): AxiosInstance =>
  (client as { axios: AxiosInstance }).axios;

afterEach(() => {
  mock.restoreAll();
  cacheManager.getCache('listenbrainz').flush();
});

describe('ListenBrainz', () => {
  it('asks for new releases and keeps the answer', async () => {
    const lb = new ListenBrainzAPI();
    const get = mock.method(getAxios(lb), 'get', async () => ({
      data: { payload: { releases: [{ release_group_mbid: ALBUM }] } },
    }));
    const first = await lb.getFreshReleases({ days: 14 });
    await lb.getFreshReleases({ days: 14 });
    assert.equal(first.payload.releases[0].release_group_mbid, ALBUM);
    assert.equal(get.mock.callCount(), 1);
    const [path, config] = get.mock.calls[0].arguments as [
      string,
      { params: Record<string, unknown> },
    ];
    assert.equal(path, '/explore/fresh-releases');
    assert.equal(config.params.days, 14);
    assert.equal(
      getAxios(lb).defaults.baseURL,
      'https://api.listenbrainz.org/1'
    );
  });

  it('asks for the most listened albums and artists over a range', async () => {
    const lb = new ListenBrainzAPI();
    const get = mock.method(getAxios(lb), 'get', async (path: string) => ({
      data: {
        payload: path.endsWith('artists')
          ? { artists: [{ artist_mbid: ARTIST }] }
          : { release_groups: [{ release_group_mbid: ALBUM }] },
      },
    }));
    const albums = await lb.getTopReleaseGroups({ range: 'month' });
    const artists = await lb.getTopArtists();
    assert.equal(albums.payload.release_groups[0].release_group_mbid, ALBUM);
    assert.equal(artists.payload.artists[0].artist_mbid, ARTIST);
    assert.deepEqual(
      get.mock.calls.map((c) => [
        c.arguments[0],
        (c.arguments[1] as { params: { range: string } }).params.range,
      ]),
      [
        ['/stats/sitewide/release-groups', 'month'],
        ['/stats/sitewide/artists', 'week'],
      ]
    );
  });

  it('asks again after an empty answer, rather than keep it', async () => {
    const lb = new ListenBrainzAPI();
    let releases: { release_group_mbid: string }[] = [];
    const get = mock.method(getAxios(lb), 'get', async () => ({
      data: { payload: { releases } },
    }));
    assert.deepEqual((await lb.getFreshReleases()).payload.releases, []);
    releases = [{ release_group_mbid: ALBUM }];
    assert.equal((await lb.getFreshReleases()).payload.releases.length, 1);
    await lb.getFreshReleases();
    assert.equal(get.mock.callCount(), 2, 'kept once it had some');
  });
});

describe('the Cover Art Archive', () => {
  it('gives an album’s front cover at the sizes it makes', () => {
    assert.equal(albumCoverPath(ALBUM), `/release-group/${ALBUM}/front-500`);
    assert.equal(
      albumCoverPath(ALBUM, 1200),
      `/release-group/${ALBUM}/front-1200`
    );
    assert.equal(albumCoverPath(ALBUM, null), `/release-group/${ALBUM}/front`);
    assert.equal(releaseCoverPath(ARTIST, 250), `/release/${ARTIST}/front-250`);
    assert.equal(
      albumCoverUrl(ALBUM),
      `https://coverartarchive.org/release-group/${ALBUM}/front-500`
    );
  });

  it('lets only cover paths through', () => {
    assert.ok(COVER_PATH.test(albumCoverPath(ALBUM)));
    assert.ok(COVER_PATH.test(releaseCoverPath(ALBUM, 250)));
    assert.ok(!COVER_PATH.test(`/release-group/${ALBUM}/back`));
    assert.ok(!COVER_PATH.test(`/release-group/${ALBUM}/front-999`));
    assert.ok(!COVER_PATH.test('/release-group/../../etc/front'));
  });
});

describe('TheAudioDB', () => {
  it('asks nothing without a key', async () => {
    const tadb = new TheAudioDb('');
    const get = mock.method(getAxios(tadb), 'get', async () => ({ data: {} }));
    assert.deepEqual(await tadb.getArtistPictures(ARTIST), {
      thumb: null,
      fanart: null,
    });
    assert.equal(get.mock.callCount(), 0);
  });

  it('looks an artist up by MusicBrainz id', async () => {
    const tadb = new TheAudioDb('key');
    const get = mock.method(getAxios(tadb), 'get', async () => ({
      data: {
        artists: [
          {
            idArtist: '1',
            strArtist: 'Glasswing',
            strArtistThumb: 'https://r2.theaudiodb.com/thumb.jpg',
            strArtistFanart: 'https://r2.theaudiodb.com/fanart.jpg',
          },
        ],
      },
    }));
    assert.deepEqual(await tadb.getArtistPictures(ARTIST), {
      thumb: 'https://r2.theaudiodb.com/thumb.jpg',
      fanart: 'https://r2.theaudiodb.com/fanart.jpg',
    });
    assert.deepEqual(get.mock.calls[0].arguments.slice(0, 2), [
      '/key/artist-mb.php',
      { params: { i: ARTIST } },
    ]);
  });

  it('has no pictures for an artist it does not know, and cannot say when down', async () => {
    const tadb = new TheAudioDb('key');
    mock.method(getAxios(tadb), 'get', async () => ({
      data: { artists: null },
    }));
    assert.deepEqual(await tadb.getArtistPictures(ARTIST), {
      thumb: null,
      fanart: null,
    });
    mock.restoreAll();
    mock.method(getAxios(tadb), 'get', async () => {
      throw new Error('timeout');
    });
    assert.equal(await tadb.getArtistPictures(ARTIST), null);
  });
});
