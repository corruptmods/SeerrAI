import ListenBrainzAPI from '@server/api/listenbrainz';
import { MusicBrainz } from '@server/api/musicbrainz';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import MusicMetadata from '@server/entity/MusicMetadata';
import SongRequest from '@server/entity/SongRequest';
import { User } from '@server/entity/User';
import {
  artistsLikeYours,
  moreFromYourArtists,
  yourMusicRequests,
} from '@server/lib/music/personalRows';
import { getSettings, musicDefaults } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * The Music page's rows of each person's own: from their music requests
 * only, never anyone else's.
 */

setupTestDb();

const GLASSWING = '3c9e5f21-8d47-4b6a-a1e3-5f7d2c90b844';
const MOONLURKER = '7f3e9a20-b51c-4d86-92ad-c4e1d08b6f73';
const STATIC_GARDEN = '4f6a2d93-c1e8-3a57-9b02-6d3e8f1c7a40';
const VELVET_CLAY = '9a3b1f2c-0000-4000-8000-000000000001';
const FOG_B = '9a3b1f2c-0000-4000-8000-000000000002';
const LIVE_ONE = '9a3b1f2c-0000-4000-8000-000000000003';
const SINGLE = '9a3b1f2c-0000-4000-8000-000000000004';
const TIDE = '9a3b1f2c-0000-4000-8000-000000000005';
const LIKE_A = 'a1b2c3d4-0000-4000-8000-00000000000a';
const LIKE_B = 'a1b2c3d4-0000-4000-8000-00000000000b';

let listener: User;
let other: User;

const user = (email: string) =>
  getRepository(User).save(
    new User({ email, username: email, avatar: '', permissions: 2 })
  );

const artist = (foreignId: string, foreignTitle: string) =>
  getRepository(Media).save(
    new Media({
      mediaType: MediaType.MUSIC,
      tmdbId: 0,
      foreignId,
      foreignTitle,
      status: MediaStatus.PROCESSING,
    })
  );

const ask = async (
  by: User,
  media: Media,
  {
    albums = [],
    songs = [],
    status = MediaRequestStatus.APPROVED,
  }: {
    albums?: { mbid: string; title: string }[];
    songs?: { album: string; title: string }[];
    status?: MediaRequestStatus;
  }
) =>
  dataSource.manager.save(
    new MediaRequest({
      type: MediaType.MUSIC,
      status,
      media,
      requestedBy: by,
      is4k: false,
      albums: albums.map(
        (album) =>
          new AlbumRequest({
            albumMbid: album.mbid,
            title: album.title,
            status,
          })
      ),
      songs: songs.map(
        (song, i) =>
          new SongRequest({
            recordingMbid: `b1b2c3d4-0000-4000-8000-00000000000${i}`,
            title: 'A song',
            albumMbid: song.album,
            albumTitle: song.title,
            releaseGroups: [song.album],
            status,
          })
      ),
    }),
    { listeners: false }
  );

/** Albums MusicBrainz already listed for an artist, as its page leaves. */
const listed = (
  artistId: string,
  groups: {
    id: string;
    title: string;
    type: string;
    secondary?: string[];
    date: string;
  }[]
) =>
  getRepository(MusicMetadata).save(
    new MusicMetadata({
      key: `rg-list:${artistId}:all:0`,
      data: JSON.stringify({
        'release-group-count': groups.length,
        'release-groups': groups.map((g) => ({
          id: g.id,
          title: g.title,
          'primary-type': g.type,
          'secondary-types': g.secondary ?? [],
          'first-release-date': g.date,
        })),
      }),
    })
  );

beforeEach(async () => {
  getSettings().music = { ...musicDefaults() };
  listener = await user('listener@test.local');
  other = await user('other@test.local');
});

afterEach(() => mock.restoreAll());

describe('a person’s own music rows', () => {
  it('list what they asked for, newest first, and nothing of anyone else’s', async () => {
    const glasswing = await artist(GLASSWING, 'Glasswing');
    const moonlurker = await artist(MOONLURKER, 'Moonlurker');
    await ask(listener, glasswing, {
      albums: [{ mbid: STATIC_GARDEN, title: 'Static Garden' }],
    });
    await ask(listener, moonlurker, {
      songs: [{ album: TIDE, title: 'Tide' }],
    });
    await ask(listener, glasswing, {
      albums: [{ mbid: FOG_B, title: 'Fog B' }],
      status: MediaRequestStatus.DECLINED,
    });
    await ask(other, glasswing, {
      albums: [{ mbid: VELVET_CLAY, title: 'Velvet Clay' }],
    });
    await getRepository(MusicAlbum).insert(
      new MusicAlbum({
        mediaId: glasswing.id,
        mbId: STATIC_GARDEN,
        title: 'Static Garden',
        secondaryTypes: [],
        status: MediaStatus.AVAILABLE,
      })
    );

    const rows = await yourMusicRequests(listener.id);
    assert.deepEqual(
      rows.map((album) => [album.id, album.artistName, album.status]),
      [
        // A song's album, as the song is on it.
        [TIDE, 'Moonlurker', undefined],
        [STATIC_GARDEN, 'Glasswing', MediaStatus.AVAILABLE],
      ]
    );
    assert.deepEqual(await yourMusicRequests(9999), []);
  });

  it('show their artists’ other studio albums, newest first', async () => {
    const glasswing = await artist(GLASSWING, 'Glasswing');
    await ask(listener, glasswing, {
      albums: [{ mbid: STATIC_GARDEN, title: 'Static Garden' }],
    });
    await listed(GLASSWING, [
      {
        id: STATIC_GARDEN,
        title: 'Static Garden',
        type: 'Album',
        date: '1997',
      },
      { id: VELVET_CLAY, title: 'Velvet Clay', type: 'Album', date: '2003' },
      { id: FOG_B, title: 'Fog B', type: 'EP', date: '2010-04-02' },
      {
        id: LIVE_ONE,
        title: 'Live',
        type: 'Album',
        secondary: ['Live'],
        date: '2012',
      },
      { id: SINGLE, title: 'A Single', type: 'Single', date: '2015' },
    ]);

    const rows = await moreFromYourArtists(listener.id);
    assert.deepEqual(
      rows.map((album) => [album.id, album.artistId]),
      [
        [FOG_B, GLASSWING],
        [VELVET_CLAY, GLASSWING],
      ],
      'what they asked for, live albums and singles left out'
    );
  });

  it('ask MusicBrainz in the background for an artist not listed yet', async () => {
    const moonlurker = await artist(MOONLURKER, 'Moonlurker');
    await ask(listener, moonlurker, {
      albums: [{ mbid: TIDE, title: 'Tide' }],
    });
    const browse = mock.method(
      MusicBrainz.prototype,
      'getArtistReleaseGroups',
      async () => ({ 'release-group-count': 0, 'release-groups': [] })
    );

    assert.deepEqual(await moreFromYourArtists(listener.id), []);
    assert.equal(browse.mock.callCount(), 1);
    assert.deepEqual(browse.mock.calls[0].arguments, [
      MOONLURKER,
      {},
      'background',
    ]);
  });

  it('find artists like theirs, weighing each artist’s list alike', async () => {
    const glasswing = await artist(GLASSWING, 'Glasswing');
    const moonlurker = await artist(MOONLURKER, 'Moonlurker');
    await ask(listener, glasswing, {
      albums: [{ mbid: STATIC_GARDEN, title: 'Static Garden' }],
    });
    await ask(listener, moonlurker, {
      albums: [{ mbid: TIDE, title: 'Tide' }],
    });
    const asked: string[] = [];
    mock.method(
      ListenBrainzAPI.prototype,
      'getSimilarArtists',
      async (id: string) => {
        asked.push(id);
        return id === GLASSWING
          ? [
              {
                artist_mbid: LIKE_A,
                name: 'Like A',
                score: 9000,
                reference_mbid: id,
              },
              {
                artist_mbid: LIKE_B,
                name: 'Like B',
                score: 4500,
                reference_mbid: id,
              },
              // One they asked for themselves is left out.
              {
                artist_mbid: MOONLURKER,
                name: 'Moonlurker',
                score: 8000,
                reference_mbid: id,
              },
            ]
          : [
              {
                artist_mbid: LIKE_B,
                name: 'Like B',
                score: 30,
                reference_mbid: id,
              },
            ];
      }
    );

    const rows = await artistsLikeYours(listener.id);
    assert.deepEqual(asked.sort(), [GLASSWING, MOONLURKER].sort());
    // Like B is near the top of both lists: ahead of Like A, top of one.
    assert.deepEqual(
      rows.map((a) => a.id),
      [LIKE_B, LIKE_A]
    );

    getSettings().music.listenBrainz = false;
    assert.deepEqual(await artistsLikeYours(listener.id), []);
  });
});
