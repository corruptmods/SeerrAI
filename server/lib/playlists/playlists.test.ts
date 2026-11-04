import type { DeezerTrack } from '@server/api/deezer';
import DeezerAPI from '@server/api/deezer';
import { MusicBrainz } from '@server/api/musicbrainz';
import type {
  MbArtist,
  MbRecording,
  MbRecordingRelease,
} from '@server/api/musicbrainz/interfaces';
import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaList, MediaListSong } from '@server/entity/MediaList';
import {
  InvalidMusicRequestError,
  MediaRequest,
} from '@server/entity/MediaRequest';
import SongRequest from '@server/entity/SongRequest';
import { User } from '@server/entity/User';
import notificationManager from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import playlists, { versionFor } from '@server/lib/playlists';
import {
  LONGEST_MS,
  QUIET_MS,
  notifyPlaylistFailures,
  playlistOfRequests,
} from '@server/lib/playlists/failureNotices';
import {
  playlistRequestGroups,
  withoutPlaylistRequests,
} from '@server/lib/playlists/requestGroups';
import {
  parsePlaylistLink,
  readApplePage,
  readSpotifyPage,
} from '@server/lib/playlists/sources';
import { playlistView } from '@server/lib/playlists/view';
import { getSettings, musicDefaults } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import axios from 'axios';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * Playlists linked to Spotify or Apple Music: read from their public pages,
 * matched on MusicBrainz, and requested as songs within their person's
 * limit, or as one batch for an admin to approve. Names are invented.
 */

setupTestDb();

const ARTIST = '3c9e5f21-8d47-4b6a-a1e3-5f7d2c90b844';
const LANTERN = 'a1b2c3d4-0002-4000-8000-000000000002';
const LANTERN_ALBUM = 'a1b2c3d4-0009-4000-8000-000000000009';
const NIGHT_SWIM = 'a1b2c3d4-0007-4000-8000-000000000007';
const WRONG_TAKE = 'a1b2c3d4-0008-4000-8000-000000000008';
const LANTERN_SINGLE = '6b2e9c41-7d38-3f05-a6e1-0c4d8b7f2a93';
const NIGHT_SWIM_SINGLE = '3e9a7c15-2d84-4f60-a1b3-c5d7e9f02468';
const PLAYLIST_ID = '0aB1cD2eF3gH4iJ5kL6mN7';

const onRelease = (
  groupId: string,
  title: string,
  type = 'Single'
): MbRecordingRelease => ({
  id: `${groupId.slice(0, 30)}r1`,
  title,
  status: 'Official',
  date: '2001-03-04',
  'release-group': {
    id: groupId,
    title,
    'primary-type': type,
    'secondary-types': [],
  },
});

const credit = [
  { name: 'Glasswing', artist: { id: ARTIST, name: 'Glasswing' } },
];
const RECORDINGS: MbRecording[] = [
  {
    id: LANTERN,
    title: 'Lantern Song',
    disambiguation: 'radio edit',
    length: 214_000,
    'artist-credit': credit,
    releases: [onRelease(LANTERN_SINGLE, 'Lantern Song')],
  },
  {
    id: LANTERN_ALBUM,
    title: 'Lantern Song',
    length: 301_000,
    'artist-credit': credit,
    releases: [onRelease(LANTERN_SINGLE, 'Lantern Song')],
  },
  {
    id: NIGHT_SWIM,
    title: 'Night Swim',
    length: 190_000,
    'artist-credit': credit,
    releases: [onRelease(NIGHT_SWIM_SINGLE, 'Night Swim')],
  },
];

/** Spotify's embedded player page, holding these tracks. */
const spotifyPage = (
  tracks: { id: string; title: string; artists: string; ms?: number }[]
) =>
  `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    {
      props: {
        pageProps: {
          state: {
            data: {
              entity: {
                name: 'Late Drives',
                trackList: tracks.map((t) => ({
                  uri: `spotify:track:${t.id}`,
                  title: t.title,
                  subtitle: t.artists,
                  duration: t.ms,
                })),
              },
            },
          },
        },
      },
    }
  )}</script></body></html>`;

const TRACKS = [
  { id: 'trk1', title: 'Lantern Song', artists: 'Glasswing', ms: 214_500 },
  {
    id: 'trk2',
    title: 'Night Swim',
    artists: 'Glasswing, Someone',
    ms: 190_200,
  },
  { id: 'trk3', title: 'Unheard Tune', artists: 'Glasswing', ms: 100_000 },
];

let page = spotifyPage(TRACKS);
let user: User;

const songsOf = async (list: MediaList) =>
  Object.fromEntries(
    (await playlistView(list)).songs.map((s) => [s.title, s.state])
  );

const makePlaylist = async () =>
  getRepository(MediaList).save(
    new MediaList({ name: 'Drives', kind: 'music', ownerId: user.id })
  );

const linked = async () => {
  const list = await makePlaylist();
  await playlists.link(
    list,
    `https://open.spotify.com/playlist/${PLAYLIST_ID}?si=abc`,
    user
  );
  await playlists.settled();
  return getRepository(MediaList).findOneByOrFail({ id: list.id });
};

beforeEach(async () => {
  page = spotifyPage(TRACKS);
  const settings = getSettings();
  settings.music = musicDefaults();
  settings.lidarr = [];
  settings.main.defaultQuotas.music = {};
  user = await getRepository(User).save(
    new User({
      email: `pl-${Math.random()}@test.local`,
      avatar: '',
      permissions: Permission.REQUEST,
    })
  );
  mock.method(MediaRequest, 'sendNotification', async () => true);
  mock.method(axios, 'get', async () => ({ data: page }));
  mock.method(MusicBrainz.prototype, 'searchArtists', async () => ({
    count: 1,
    offset: 0,
    artists: [{ id: ARTIST, name: 'Glasswing', score: 100 }],
  }));
  mock.method(
    MusicBrainz.prototype,
    'searchRecordings',
    async (title: string) => {
      const found = RECORDINGS.filter(
        (r) => r.title.toLowerCase() === title.toLowerCase()
      );
      return { count: found.length, offset: 0, recordings: found };
    }
  );
  mock.method(
    MusicBrainz.prototype,
    'getRecording',
    async (id: string) => RECORDINGS.find((r) => r.id === id) ?? null
  );
  mock.method(
    MusicBrainz.prototype,
    'getArtist',
    async (id: string) => ({ id, name: 'Glasswing' }) as MbArtist
  );
  mock.method(MusicBrainz.prototype, 'keptArtistReleaseGroups', async () => []);
  // Deezer lists none of them, unless a test says it does.
  mock.method(DeezerAPI.prototype, 'searchTracks', async () => []);
});

afterEach(() => mock.restoreAll());

describe('a playlist link', () => {
  it('is read from Spotify and Apple Music links, and nothing else', () => {
    assert.deepEqual(
      parsePlaylistLink(
        `https://open.spotify.com/intl-de/playlist/${PLAYLIST_ID}?si=x`
      ),
      {
        service: 'spotify',
        id: PLAYLIST_ID,
        url: `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
      }
    );
    assert.equal(
      parsePlaylistLink(`spotify:playlist:${PLAYLIST_ID}`)?.service,
      'spotify'
    );
    assert.deepEqual(
      parsePlaylistLink(
        'music.apple.com/gb/playlist/late-drives/pl.u-AbCdEf123?l=en'
      ),
      {
        service: 'apple',
        id: 'pl.u-AbCdEf123',
        url: 'https://music.apple.com/gb/playlist/late-drives/pl.u-AbCdEf123',
      }
    );
    assert.equal(parsePlaylistLink('https://open.spotify.com/album/x'), null);
    assert.equal(parsePlaylistLink('https://example.com/playlist/1'), null);
    assert.equal(parsePlaylistLink('not a link'), null);
  });

  it('reads the songs Spotify’s and Apple Music’s pages hold', () => {
    const spotify = readSpotifyPage(page);
    assert.equal(spotify.name, 'Late Drives');
    assert.deepEqual(spotify.songs[1], {
      sourceId: 'spotify:track:trk2',
      title: 'Night Swim',
      artistName: 'Glasswing',
      length: 190_200,
    });

    const apple = readApplePage(
      `<script type="application/json" id="serialized-server-data">${JSON.stringify(
        {
          data: [
            {
              data: {
                sections: [
                  {
                    itemKind: 'containerDetailHeaderLockup',
                    items: [{ title: 'Harbour Mix' }],
                  },
                  {
                    itemKind: 'trackLockup',
                    items: [
                      {
                        title: 'Night Swim',
                        artistName: 'Glasswing & Someone',
                        duration: 190_000,
                        subtitleLinks: [{ title: 'Glasswing' }],
                        contentDescriptor: {
                          identifiers: { storeAdamID: '111' },
                        },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        }
      )}</script>`
    );
    assert.deepEqual(apple, {
      name: 'Harbour Mix',
      songs: [
        {
          sourceId: 'apple:song:111',
          title: 'Night Swim',
          artistName: 'Glasswing',
          length: 190_000,
        },
      ],
    });
    assert.throws(() => readSpotifyPage('<html></html>'), /has changed/);
  });

  it('picks the version nearest the playlist’s length', () => {
    const song = {
      key: 'k',
      title: 'Lantern Song',
      artistMbid: ARTIST,
      artistName: 'Glasswing',
      versions: [
        { mbId: LANTERN_ALBUM, length: 301_000 },
        { mbId: LANTERN, length: 214_000 },
      ],
    } as Parameters<typeof versionFor>[0];
    assert.equal(versionFor(song, 214_500, 'Lantern Song')?.mbId, LANTERN);
    assert.equal(
      versionFor(song, 300_000, 'Lantern Song')?.mbId,
      LANTERN_ALBUM
    );
    assert.equal(versionFor(song, null, 'Lantern Song')?.mbId, LANTERN_ALBUM);
  });

  it('never picks a take the playlist’s title doesn’t name', () => {
    const version = (
      mbId: string,
      title: string,
      length: number,
      label?: string
    ) => ({
      mbId,
      title,
      version: label ?? null,
      length,
    });
    const song = {
      key: 'k',
      title: 'Lantern Song',
      artistMbid: ARTIST,
      artistName: 'Glasswing',
      versions: [
        // Nearest the playlist's length, but acoustic or live.
        version(LANTERN, 'Lantern Song (acoustic)', 193_234, 'acoustic'),
        version(NIGHT_SWIM, 'Lantern Song', 193_400, 'live, 2019: Pier Hall'),
        version(LANTERN_ALBUM, 'Lantern Song', 193_000),
      ],
    } as unknown as Parameters<typeof versionFor>[0];
    assert.equal(
      versionFor(song, 193_467, 'Lantern Song')?.mbId,
      LANTERN_ALBUM
    );
    // Named by the title, it is the one.
    assert.equal(
      versionFor(song, 193_467, 'Lantern Song (Acoustic)')?.mbId,
      LANTERN
    );
    // Only other takes: none, rather than one the playlist doesn't hold.
    const onlyLive = { ...song, versions: song.versions.slice(1, 2) };
    assert.equal(versionFor(onlyLive, 193_467, 'Lantern Song'), undefined);
  });

  it('picks a version that can be requested over one only on others’ compilations', () => {
    const group = (
      type: string,
      byArtist: boolean,
      secondary: string[] = []
    ) => ({
      mbId: `g-${type}-${byArtist}`,
      title: type,
      primaryType: type,
      secondaryTypes: secondary,
      date: '2017-06-02',
      byArtist,
    });
    const song = {
      key: 'k',
      title: 'Lantern Song',
      artistMbid: ARTIST,
      artistName: 'Glasswing',
      versions: [
        // Nearest the length, but only on someone else's compilation.
        {
          mbId: LANTERN,
          length: 223_000,
          releaseGroups: [group('Album', false, ['Compilation'])],
        },
        {
          mbId: LANTERN_ALBUM,
          length: 224_500,
          releaseGroups: [group('Single', true)],
        },
      ],
    } as unknown as Parameters<typeof versionFor>[0];
    assert.equal(
      versionFor(song, 223_000, 'Lantern Song')?.mbId,
      LANTERN_ALBUM
    );
  });
});

describe('a linked playlist', () => {
  it('matches its songs and requests them for whoever linked it', async () => {
    const list = await linked();
    assert.equal(list.sourceService, 'spotify');
    assert.equal(list.sourceName, 'Late Drives');
    assert.equal(
      list.sourceUrl,
      `https://open.spotify.com/playlist/${PLAYLIST_ID}`
    );
    // Not allowed to approve their own: their requests wait for an admin.
    assert.deepEqual(await songsOf(list), {
      'Lantern Song': 'approval',
      'Night Swim': 'approval',
      'Unheard Tune': 'unmatched',
    });
    const songs = await getRepository(MediaListSong).find({
      where: { listId: list.id },
      order: { position: 'ASC' },
    });
    assert.equal(songs[0].recordingMbid, LANTERN, 'the radio edit, by length');
    const requests = await getRepository(MediaRequest).find({
      relations: { requestedBy: true },
    });
    assert.equal(requests.length, 1, 'one request for the artist');
    assert.equal(requests[0].requestedBy.id, user.id);
    assert.deepEqual(
      requests[0].songs.map((s) => s.recordingMbid).sort(),
      [LANTERN, NIGHT_SWIM].sort()
    );
  });

  it('requests what their song limit allows, and the rest as it frees up', async () => {
    getSettings().music.songQuota = { quotaLimit: 1, quotaDays: 7 };
    const list = await linked();
    assert.deepEqual(await songsOf(list), {
      'Lantern Song': 'approval',
      'Night Swim': 'limit',
      'Unheard Tune': 'unmatched',
    });

    // The limit frees up (the first request declined): the next pass
    // requests the rest.
    const asked = await getRepository(MediaRequest).find();
    await getRepository(MediaRequest).update(
      asked.map((r) => r.id),
      { status: MediaRequestStatus.DECLINED }
    );
    await playlists.sync();
    await playlists.settled();
    const after = await songsOf(list);
    assert.equal(after['Night Swim'], 'approval');
  });

  it('sends a big import to an admin as one batch, outside the limit, when chosen', async () => {
    const settings = getSettings();
    settings.music.songQuota = { quotaLimit: 1, quotaDays: 7 };
    settings.music.playlists = { overLimit: 'approve', approveOver: 1 };
    await getRepository(User).update(user.id, {
      permissions: Permission.REQUEST | Permission.AUTO_APPROVE,
    });
    user = await getRepository(User).findOneByOrFail({ id: user.id });
    const list = await linked();
    assert.deepEqual(await songsOf(list), {
      'Lantern Song': 'approval',
      'Night Swim': 'approval',
      'Unheard Tune': 'unmatched',
    });
    const [request] = await getRepository(MediaRequest).find();
    assert.equal(request.status, MediaRequestStatus.PENDING);
    assert.equal(request.songs.length, 2, 'not held back by the limit');
  });

  it('asks for none of a big import while some of it is still being found', async () => {
    const settings = getSettings();
    settings.music.playlists = { overLimit: 'approve', approveOver: 1 };
    await getRepository(User).update(user.id, {
      permissions: Permission.REQUEST | Permission.AUTO_APPROVE,
    });
    user = await getRepository(User).findOneByOrFail({ id: user.id });
    // MusicBrainz stops answering partway through the import.
    let answering = false;
    const search = MusicBrainz.prototype.searchRecordings;
    mock.method(
      MusicBrainz.prototype,
      'searchRecordings',
      async function (this: MusicBrainz, ...args: unknown[]) {
        if (!answering && args[0] === 'Night Swim') {
          throw new Error('MusicBrainz is busy');
        }
        return (search as (...a: unknown[]) => unknown).apply(this, args);
      }
    );
    const list = await linked();
    assert.equal(await getRepository(MediaRequest).count(), 0, 'none yet');
    assert.equal((await songsOf(list))['Lantern Song'], 'queued');

    answering = true;
    playlists.kick();
    await playlists.settled();
    const requests = await getRepository(MediaRequest).find();
    assert.equal(requests.length, 1, 'one batch');
    assert.equal(requests[0].status, MediaRequestStatus.PENDING);
    assert.equal(requests[0].songs.length, 2);
  });

  it('keeps a song taken off while it was being found off', async () => {
    const list = await makePlaylist();
    mock.method(
      MusicBrainz.prototype,
      'searchRecordings',
      async (title: string) => {
        // Taken off the playlist while MusicBrainz is being asked.
        await getRepository(MediaListSong).update(
          { listId: list.id, title },
          { state: 'removed' }
        );
        const found = RECORDINGS.filter(
          (r) => r.title.toLowerCase() === title.toLowerCase()
        );
        return { count: found.length, offset: 0, recordings: found };
      }
    );
    await playlists.link(
      list,
      `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
      user
    );
    await playlists.settled();
    const states = await getRepository(MediaListSong).find({
      where: { listId: list.id },
    });
    assert.ok(states.every((s) => s.state === 'removed'));
    assert.equal(await getRepository(MediaRequest).count(), 0);
  });

  it('asks again for a song whose request was deleted, when tried again', async () => {
    const list = await linked();
    const lantern = await getRepository(MediaListSong).findOneByOrFail({
      listId: list.id,
      title: 'Lantern Song',
    });
    // As an admin deleting it does, it being of the wrong take.
    await getRepository(MediaRequest).remove(
      await getRepository(MediaRequest).findOneByOrFail({
        id: lantern.requestId!,
      })
    );
    await getRepository(MediaListSong).update(lantern.id, {
      recordingMbid: WRONG_TAKE,
    });
    assert.equal((await songsOf(list))['Lantern Song'], 'notGot');

    await playlists.retry(
      await getRepository(MediaListSong).findOneByOrFail({ id: lantern.id })
    );
    await playlists.settled();
    const now = await getRepository(MediaListSong).findOneByOrFail({
      id: lantern.id,
    });
    assert.notEqual(now.requestId, lantern.requestId);
    // Looked up again, not asked for as it was.
    assert.equal(now.recordingMbid, LANTERN);
    assert.equal((await songsOf(list))['Lantern Song'], 'approval');
  });

  it('asks for the rest together when one song of an artist can’t be', async () => {
    const list = await makePlaylist();
    const ids = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
    await getRepository(MediaListSong).save(
      ids.map(
        (id, position) =>
          new MediaListSong({
            listId: list.id,
            sourceId: id,
            position,
            title: id,
            artistName: 'Glasswing',
            state: 'matched',
            recordingMbid: `a1b2c3d4-0000-4000-8000-0000000000${position}0`,
            artistMbid: ARTIST,
            requestForId: user.id,
          })
      )
    );
    const bad = `a1b2c3d4-0000-4000-8000-000000000030`;
    const asked: string[][] = [];
    mock.method(
      MediaRequest,
      'requestMusic',
      async (body: { songs: string[] }) => {
        if (body.songs.includes(bad)) {
          throw new InvalidMusicRequestError('only on compilations');
        }
        asked.push(body.songs);
        return Object.assign(new MediaRequest(), {
          id: asked.length,
          songs: body.songs.map((recordingMbid) => ({ recordingMbid })),
        });
      }
    );
    playlists.kick();
    await playlists.settled();
    assert.ok(asked.length <= 3, `${asked.length} requests`);
    assert.equal(asked.flat().length, 7);
    const states = await getRepository(MediaListSong).find({
      where: { listId: list.id },
    });
    assert.equal(states.filter((s) => s.state === 'failed').length, 1);
  });

  it('follows someone else’s request for a song, and asks afresh if it’s declined', async () => {
    const other = await getRepository(User).save(
      new User({
        email: `other-${Math.random()}@test.local`,
        avatar: '',
        permissions: Permission.REQUEST,
      })
    );
    const theirs = await MediaRequest.requestMusic(
      { artistMbid: ARTIST, songs: [NIGHT_SWIM] },
      other
    );
    const list = await linked();
    assert.equal((await songsOf(list))['Night Swim'], 'approval');
    const swim = await getRepository(MediaListSong).findOneByOrFail({
      listId: list.id,
      title: 'Night Swim',
    });
    assert.equal(swim.requestId, theirs.id);
    // Theirs, not this playlist's, to be told about.
    assert.equal((await playlistOfRequests([theirs.id])).has(theirs.id), false);

    // Declined, as an admin declining it does: its songs with it.
    const declined = await getRepository(MediaRequest).findOneByOrFail({
      id: theirs.id,
    });
    declined.status = MediaRequestStatus.DECLINED;
    await getRepository(MediaRequest).save(declined);
    assert.equal((await songsOf(list))['Night Swim'], 'notGot');
    await playlists.retry(
      await getRepository(MediaListSong).findOneByOrFail({ id: swim.id })
    );
    await playlists.settled();
    const now = await getRepository(MediaListSong).findOneByOrFail({
      id: swim.id,
    });
    assert.notEqual(now.requestId, theirs.id);
    assert.equal((await songsOf(list))['Night Swim'], 'approval');
  });

  it('says why when songs can’t be asked for one at a time', async () => {
    getSettings().music.songRequests = false;
    const list = await linked();
    const view = await playlistView(list);
    const lantern = view.songs.find((s) => s.title === 'Lantern Song')!;
    assert.equal(lantern.state, 'failed');
    assert.match(lantern.problem ?? '', /one at a time/);
  });

  it('brings in only new songs when read again, and not ones taken off', async () => {
    const list = await linked();
    const taken = await getRepository(MediaListSong).findOneByOrFail({
      listId: list.id,
      title: 'Unheard Tune',
    });
    await getRepository(MediaListSong).update(taken.id, { state: 'removed' });
    page = spotifyPage([
      ...TRACKS,
      { id: 'trk4', title: 'Fresh Song', artists: 'Glasswing' },
    ]);
    await getRepository(MediaList).update(list.id, {
      sourceReadAt: new Date(Date.now() - 24 * 60 * 60_000),
    });
    await playlists.sync();
    await playlists.settled();
    const titles = (await playlistView(list)).songs.map((s) => s.title);
    assert.deepEqual(titles, ['Lantern Song', 'Night Swim', 'Fresh Song']);
    assert.equal(
      await getRepository(MediaListSong).count({ where: { listId: list.id } }),
      4
    );
  });

  it('looks again for a song MusicBrainz didn’t know, each week and when asked', async () => {
    const list = await linked();
    const unheard = await getRepository(MediaListSong).findOneByOrFail({
      listId: list.id,
      title: 'Unheard Tune',
    });
    // MusicBrainz has it now.
    RECORDINGS.push({
      id: 'a1b2c3d4-0010-4000-8000-000000000010',
      title: 'Unheard Tune',
      length: 100_000,
      'artist-credit': credit,
      releases: [onRelease('5d1c7b20-3e4f-4a8b-9c0d-1e2f3a4b5c6d', 'Unheard')],
    });
    try {
      // Not a week yet: left as it is.
      await playlists.sync();
      await playlists.settled();
      assert.equal((await songsOf(list))['Unheard Tune'], 'unmatched');

      await playlists.retry(unheard);
      await playlists.settled();
      assert.equal((await songsOf(list))['Unheard Tune'], 'approval');
    } finally {
      RECORDINGS.pop();
    }
  });

  it('says plainly when the page can’t be read', async () => {
    const list = await makePlaylist();
    page = '<html>nothing here</html>';
    await assert.rejects(
      playlists.link(list, `spotify:playlist:${PLAYLIST_ID}`, user),
      /Spotify’s page for that playlist has changed/
    );
    await assert.rejects(
      playlists.link(list, 'https://example.com/x', user),
      /isn’t a link to a Spotify or Apple Music playlist/
    );
  });
});

describe('a playlist’s songs as they are got', () => {
  it('each follow their own part of the request', async () => {
    const list = await linked();
    const [request] = await getRepository(MediaRequest).find();
    // Lidarr couldn't get one song: the request fails, the other goes on.
    await getRepository(MediaRequest).update(request.id, {
      status: MediaRequestStatus.FAILED,
    });
    await getRepository(SongRequest).update(
      { recordingMbid: LANTERN },
      { status: MediaRequestStatus.FAILED }
    );
    await getRepository(SongRequest).update(
      { recordingMbid: NIGHT_SWIM },
      { status: MediaRequestStatus.APPROVED }
    );
    assert.deepEqual(await songsOf(list), {
      'Lantern Song': 'notGot',
      'Night Swim': 'requested',
      'Unheard Tune': 'unmatched',
    });

    // Try again: its request is tried again, the song with it.
    const song = await getRepository(MediaListSong).findOneByOrFail({
      listId: list.id,
      recordingMbid: LANTERN,
    });
    await playlists.retry(song);
    const again = await getRepository(MediaRequest).findOneByOrFail({
      id: request.id,
    });
    assert.equal(again.status, MediaRequestStatus.APPROVED);
    assert.equal(
      again.songs.find((s) => s.recordingMbid === LANTERN)?.status,
      MediaRequestStatus.APPROVED
    );
  });
});

describe('a playlist’s songs that couldn’t be got', () => {
  it('are told as one, once they have settled', async () => {
    const list = await linked();
    const [request] = await getRepository(MediaRequest).find();
    await getRepository(MediaRequest).update(request.id, {
      status: MediaRequestStatus.FAILED,
    });
    await getRepository(SongRequest).update(
      { recordingMbid: LANTERN },
      { status: MediaRequestStatus.FAILED }
    );
    const failed = await getRepository(MediaRequest).find({
      relations: { media: true, requestedBy: true },
    });
    const listOf = await playlistOfRequests(failed.map((r) => r.id));
    assert.equal(listOf.get(request.id), list.id);
    const told: { subject: string; actionUrl?: string; message?: string }[] =
      [];
    mock.method(
      notificationManager,
      'sendNotification',
      (_type: unknown, payload: (typeof told)[number]) => {
        told.push(payload);
      }
    );
    const failedAt = new Date(failed[0].updatedAt).getTime();

    // Still failing one after another: held.
    await notifyPlaylistFailures(failed, listOf, failedAt + 60_000);
    assert.equal(told.length, 0);

    // Settled: one, for the playlist, naming the song that failed.
    await notifyPlaylistFailures(failed, listOf, failedAt + QUIET_MS);
    assert.equal(told.length, 1);
    assert.equal(told[0].subject, 'Playlist import — 1 song');
    assert.equal(told[0].message, 'Lantern Song (radio edit) — Glasswing');
    assert.equal(told[0].actionUrl, `/lists/${list.id}`);

    // Told once.
    await notifyPlaylistFailures(failed, listOf, failedAt + LONGEST_MS);
    assert.equal(told.length, 1);
  });
});

describe('a playlist’s requests in a row of requests', () => {
  const requests = () =>
    getRepository(MediaRequest).createQueryBuilder('request');

  it('are shown once, for their playlist', async () => {
    const list = await linked();
    assert.equal(await withoutPlaylistRequests(requests()).getCount(), 0);

    const [group, ...rest] = await playlistRequestGroups(requests(), user, 10);
    assert.deepEqual(rest, []);
    assert.equal(group.listId, list.id);
    assert.equal(group.canOpen, true);
    assert.equal(group.requestedBy.id, user.id);
    assert.equal(group.songs, 3);
    assert.equal(group.approval, 2);
    assert.equal(group.waiting, 0);
    assert.deepEqual(group.albums, [LANTERN_SINGLE, NIGHT_SWIM_SINGLE]);

    // Someone who can't open the list isn't sent there.
    const other = await getRepository(User).save(
      new User({
        email: `pl-other-${Math.random()}@test.local`,
        avatar: '',
        permissions: Permission.ADMIN,
      })
    );
    const [seen] = await playlistRequestGroups(requests(), other, 10);
    assert.equal(seen.listId, list.id);
    assert.equal(seen.canOpen, false);
  });
});

describe('a song Deezer lists', () => {
  const ISRC_TAKE = 'a1b2c3d4-0010-4000-8000-000000000010';
  const HARBOUR = '7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5';
  const ISRC = 'QZABC2600001';
  const listing = (
    id: number,
    title: string,
    seconds: number,
    albumId: number
  ): DeezerTrack => ({
    id,
    title,
    title_short: title,
    title_version: '',
    duration: seconds,
    artist: { id: 9, name: 'Glasswing' },
    album: { id: albumId, title: 'Harbour Lights' },
  });
  const deezerLists = (tracks: Record<string, DeezerTrack>, isrc = ISRC) => {
    mock.method(DeezerAPI.prototype, 'searchTracks', async (title: string) =>
      tracks[title] ? [tracks[title]] : []
    );
    mock.method(DeezerAPI.prototype, 'getTrack', async (id: number) => {
      const track = Object.values(tracks).find((t) => t.id === id);
      return track ? { ...track, isrc, track_position: 3 } : null;
    });
  };
  const songNamed = async (list: MediaList, title: string) =>
    getRepository(MediaListSong).findOneByOrFail({ listId: list.id, title });

  it('is matched to the recording its ISRC names, over one its name and length would pick', async () => {
    deezerLists({ 'Lantern Song': listing(11, 'Lantern Song', 215, 501) });
    // The radio edit is nearer the playlist's length; the code names the
    // album's take, the one the store lists.
    mock.method(
      MusicBrainz.prototype,
      'searchRecordingsByIsrc',
      async (code: string) => ({
        count: 1,
        offset: 0,
        recordings:
          code === ISRC
            ? [
                {
                  id: ISRC_TAKE,
                  title: 'Lantern Song',
                  length: 216_000,
                  'artist-credit': credit,
                  releases: [onRelease(HARBOUR, 'Harbour Lights', 'Album')],
                },
              ]
            : [],
      })
    );
    const list = await linked();
    const lantern = await songNamed(list, 'Lantern Song');
    assert.equal(lantern.recordingMbid, ISRC_TAKE);
    assert.equal(lantern.isrc, ISRC);
    assert.equal(lantern.catalog?.albumId, 501);
    assert.equal(lantern.catalog?.trackNumber, 3);
    // Deezer lists no other: those are matched by name, as before.
    assert.equal(
      (await songNamed(list, 'Night Swim')).recordingMbid,
      NIGHT_SWIM
    );
  });

  it('is matched by name when MusicBrainz has no recording with its ISRC, or Deezer can’t be asked', async () => {
    deezerLists({ 'Lantern Song': listing(11, 'Lantern Song', 215, 501) });
    mock.method(MusicBrainz.prototype, 'searchRecordingsByIsrc', async () => ({
      count: 0,
      offset: 0,
      recordings: [],
    }));
    let list = await linked();
    assert.equal(
      (await songNamed(list, 'Lantern Song')).recordingMbid,
      LANTERN
    );

    mock.method(DeezerAPI.prototype, 'searchTracks', async () => {
      throw new Error('connect ECONNREFUSED');
    });
    list = await linked();
    const lantern = await songNamed(list, 'Lantern Song');
    assert.equal(lantern.recordingMbid, LANTERN);
    assert.equal(lantern.isrc, null);
  });

  it('is matched to the artist’s own recording when its ISRC is only on others’ compilations', async () => {
    deezerLists({ 'Lantern Song': listing(11, 'Lantern Song', 215, 501) });
    const various = [
      {
        name: 'Various Artists',
        artist: {
          id: '89ad4ac3-39f7-470e-963a-56509c546377',
          name: 'Various Artists',
        },
      },
    ];
    // The code is on a recording MusicBrainz has only on a compilation of
    // others' songs, which can't be requested.
    mock.method(MusicBrainz.prototype, 'searchRecordingsByIsrc', async () => ({
      count: 1,
      offset: 0,
      recordings: [
        {
          id: ISRC_TAKE,
          title: 'Lantern Song',
          length: 214_000,
          'artist-credit': credit,
          releases: [
            {
              ...onRelease(HARBOUR, 'Harbour Lights Hits', 'Album'),
              'artist-credit': various,
              'release-group': {
                id: HARBOUR,
                title: 'Harbour Lights Hits',
                'primary-type': 'Album',
                'secondary-types': ['Compilation'],
              },
            },
          ],
        },
      ],
    }));
    let list = await linked();
    // The artist's own, on their single, as long as the playlist's.
    assert.equal(
      (await songNamed(list, 'Lantern Song')).recordingMbid,
      LANTERN
    );

    // Their own is another length, so not this take: the code's stays.
    mock.method(
      MusicBrainz.prototype,
      'searchRecordings',
      async (title: string) => {
        const found = RECORDINGS.filter(
          (r) =>
            r.id !== LANTERN && r.title.toLowerCase() === title.toLowerCase()
        );
        return { count: found.length, offset: 0, recordings: found };
      }
    );
    list = await linked();
    assert.equal(
      (await songNamed(list, 'Lantern Song')).recordingMbid,
      ISRC_TAKE
    );
  });

  it('offers adding to MusicBrainz a song it doesn’t have', async () => {
    deezerLists({ 'Unheard Tune': listing(12, 'Unheard Tune', 100, 777) });
    mock.method(MusicBrainz.prototype, 'searchRecordingsByIsrc', async () => ({
      count: 0,
      offset: 0,
      recordings: [],
    }));
    const list = await linked();
    const shown = (await playlistView(list)).songs;
    const unheard = shown.find((s) => s.title === 'Unheard Tune');
    assert.equal(unheard?.state, 'unmatched');
    assert.equal(
      unheard?.addToMusicBrainz,
      'https://harmony.pulsewidth.org.uk/release?deezer=777'
    );
    // Found, or not on Deezer either: nothing to add.
    assert.ok(
      shown
        .filter((s) => s.title !== 'Unheard Tune')
        .every((s) => s.addToMusicBrainz === null)
    );
  });

  it('is not looked up with Deezer turned off', async () => {
    getSettings().music.deezer = false;
    const asked = mock.method(
      DeezerAPI.prototype,
      'searchTracks',
      async () => []
    );
    const list = await linked();
    assert.equal(asked.mock.callCount(), 0);
    assert.equal(
      (await songNamed(list, 'Lantern Song')).recordingMbid,
      LANTERN
    );
  });
});
