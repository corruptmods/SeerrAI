import DeezerAPI from '@server/api/deezer';
import { MusicBrainz } from '@server/api/musicbrainz';
import { getRepository } from '@server/datasource';
import {
  MediaList,
  MediaListMember,
  MediaListSong,
} from '@server/entity/MediaList';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import playlists from '@server/lib/playlists';
import type { LidarrSettings } from '@server/lib/settings';
import { getSettings, musicDefaults } from '@server/lib/settings';
import playlistRoutes, {
  MOST_SONGS_MATCHING,
} from '@server/routes/list/playlists';
import { setupTestDb } from '@server/test/db';
import axios from 'axios';
import express from 'express';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
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
 * Linking a playlist reads a Spotify page and queues songs for MusicBrainz,
 * so links are rate limited and refused while many of the user's songs are
 * still being matched. Names are invented.
 */

setupTestDb();

const PLAYLIST = 'https://open.spotify.com/playlist/0aB1cD2eF3gH4iJ5kL6mN7';

const spotifyPage = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
  {
    props: {
      pageProps: {
        state: {
          data: {
            entity: {
              name: 'Late Drives',
              trackList: [
                {
                  uri: 'spotify:track:trk1',
                  title: 'Lantern Song',
                  subtitle: 'Glasswing',
                  duration: 214_000,
                },
              ],
            },
          },
        },
      },
    },
  }
)}</script></body></html>`;

let app: Server;
let port = 0;
let actingAs: User | undefined;
let user: User;
let pageReads: { mock: { callCount(): number } };

const link = async (listId: number) =>
  fetch(`http://127.0.0.1:${port}/api/v1/list/${listId}/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: PLAYLIST }),
  });

const makePlaylist = async () =>
  getRepository(MediaList).save(
    new MediaList({ name: 'Drives', kind: 'music', ownerId: user.id })
  );

before(async () => {
  const ex = express();
  ex.use(express.json());
  ex.use((req, _res, next) => {
    (req as unknown as { user?: User }).user = actingAs;
    next();
  });
  ex.use('/api/v1/list', playlistRoutes);
  ex.use(
    (
      err: { status?: number; message: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );
  app = await new Promise<Server>((resolve) => {
    const s = ex.listen(0, () => resolve(s));
  });
  port = (app.address() as { port: number }).port;
});

after(() => app?.close());

beforeEach(async () => {
  const settings = getSettings();
  settings.music = musicDefaults();
  settings.main.disabledFeatures = [];
  settings.lidarr = [{ id: 0, isDefault: true } as LidarrSettings];
  user = await getRepository(User).save(
    new User({
      email: `link-${Math.random()}@test.local`,
      avatar: '',
      permissions: Permission.REQUEST,
    })
  );
  actingAs = user;
  pageReads = mock.method(axios, 'get', async () => ({ data: spotifyPage }));
  // MusicBrainz and Deezer find nothing, so every song stays unmatched.
  mock.method(MusicBrainz.prototype, 'searchArtists', async () => ({
    count: 0,
    offset: 0,
    artists: [],
  }));
  mock.method(DeezerAPI.prototype, 'searchTracks', async () => []);
});

afterEach(async () => {
  await playlists.settled();
  mock.restoreAll();
  getSettings().lidarr = [];
});

describe('linking a playlist', () => {
  it('reads its songs', async () => {
    const list = await makePlaylist();
    const res = await link(list.id);
    assert.equal(res.status, 200);
    const view = (await res.json()) as { songs: { title: string }[] };
    assert.deepEqual(
      view.songs.map((s) => s.title),
      ['Lantern Song']
    );
  });

  it('waits while many of the person’s songs are still being looked for', async () => {
    const list = await makePlaylist();
    const waiting = await makePlaylist();
    await getRepository(MediaListSong).save(
      Array.from(
        { length: MOST_SONGS_MATCHING },
        (_, i) =>
          new MediaListSong({
            listId: waiting.id,
            sourceId: `spotify:track:waiting${i}`,
            position: i,
            title: `Waiting ${i}`,
            artistName: 'Glasswing',
            state: 'matching',
            requestForId: user.id,
          })
      ),
      { chunk: 100 }
    );
    const res = await link(list.id);
    assert.equal(res.status, 429);
    assert.equal(pageReads.mock.callCount(), 0, 'Spotify is not asked');
    assert.equal(
      await getRepository(MediaListSong).count({ where: { listId: list.id } }),
      0
    );

    // Another user's waiting songs don't count.
    await getRepository(MediaListSong).update(
      { listId: waiting.id },
      { requestForId: null }
    );
    assert.equal((await link(list.id)).status, 200);
  });

  it('is refused past so many tries in a while', async () => {
    // Users no other test has counted.
    const someone = (id: number) => Object.assign(new User(), { id });
    actingAs = someone(777_001);
    // A missing list still counts as a try.
    for (let i = 0; i < 20; i++) {
      assert.equal((await link(999_999)).status, 404);
    }
    assert.equal((await link(999_999)).status, 429);
    // Tries are counted per user.
    actingAs = someone(777_002);
    assert.equal((await link(999_999)).status, 404);
  });
});

describe('a playlist shared with someone', () => {
  it('is only tried again, or searched again, by its owner', async () => {
    const list = await makePlaylist();
    const song = await getRepository(MediaListSong).save(
      new MediaListSong({
        listId: list.id,
        sourceId: 'trk1',
        position: 1,
        title: 'Lantern Song',
        artistName: 'Glasswing',
        state: 'failed',
        requestForId: user.id,
      })
    );
    const member = await getRepository(User).save(
      new User({
        email: `member-${Math.random()}@test.local`,
        avatar: '',
        permissions: Permission.REQUEST,
      })
    );
    await getRepository(MediaListMember).save(
      Object.assign(new MediaListMember(), {
        listId: list.id,
        userId: member.id,
      })
    );
    actingAs = member;
    const post = (path: string) =>
      fetch(`http://127.0.0.1:${port}/api/v1/list/${list.id}/${path}`, {
        method: 'POST',
      });
    assert.equal((await post(`song/${song.id}/retry`)).status, 403);
    assert.equal((await post('search-again')).status, 403);
    assert.equal(
      (await getRepository(MediaListSong).findOneByOrFail({ id: song.id }))
        .state,
      'failed'
    );
  });
});

describe('a playlist song tried again', () => {
  it('says why a failed request it follows is not retried', async () => {
    const list = await makePlaylist();
    const song = await getRepository(MediaListSong).save(
      new MediaListSong({
        listId: list.id,
        sourceId: 'trk1',
        position: 1,
        title: 'Lantern Song',
        artistName: 'Glasswing',
        state: 'requested',
        requestForId: user.id,
      })
    );
    mock.method(
      playlists,
      'retry',
      async () =>
        'Its request failed after it was approved, so an admin retries it.'
    );
    const res = await fetch(
      `http://127.0.0.1:${port}/api/v1/list/${list.id}/song/${song.id}/retry`,
      { method: 'POST' }
    );
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), {
      message:
        'Its request failed after it was approved, so an admin retries it.',
    });
  });

  it('is refused while Music is turned off', async () => {
    const list = await makePlaylist();
    const song = await getRepository(MediaListSong).save(
      new MediaListSong({
        listId: list.id,
        sourceId: 'trk1',
        position: 1,
        title: 'Lantern Song',
        artistName: 'Glasswing',
        state: 'failed',
        requestForId: user.id,
      })
    );
    getSettings().main.disabledFeatures = ['music'];
    const res = await fetch(
      `http://127.0.0.1:${port}/api/v1/list/${list.id}/song/${song.id}/retry`,
      { method: 'POST' }
    );
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { message: 'Music is turned off.' });
    assert.equal(
      (await getRepository(MediaListSong).findOneByOrFail({ id: song.id }))
        .state,
      'failed'
    );
  });
});

describe('a song added to a playlist', () => {
  const add = async (listId: number, body: unknown) =>
    fetch(`http://127.0.0.1:${port}/api/v1/list/${listId}/song`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const SONG = { title: 'Lantern Song', artistName: 'Glasswing' };

  const makeMember = async (listId: number, accepted: boolean) => {
    const member = await getRepository(User).save(
      new User({
        email: `member-${Math.random()}@test.local`,
        avatar: '',
        permissions: Permission.REQUEST,
      })
    );
    await getRepository(MediaListMember).save(
      Object.assign(new MediaListMember(), {
        listId,
        userId: member.id,
        acceptedAt: accepted ? new Date() : null,
      })
    );
    return member;
  };

  it('is added once, then found', async () => {
    const list = await makePlaylist();
    // A blank album is fine.
    assert.equal(
      (await add(list.id, { ...SONG, title: 'Night Swim', albumTitle: '' }))
        .status,
      201
    );
    const res = await add(list.id, {
      ...SONG,
      albumTitle: 'Harbour Lights',
      length: 214_000,
      mbids: [],
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      added: boolean;
      song: { id: number; title: string; artistName: string };
    };
    assert.equal(body.added, true);
    assert.equal(body.song.title, 'Lantern Song');
    assert.equal(body.song.artistName, 'Glasswing');

    const again = await add(list.id, SONG);
    assert.equal(again.status, 200);
    const second = (await again.json()) as {
      added: boolean;
      song: { id: number };
    };
    assert.equal(second.added, false);
    assert.equal(second.song.id, body.song.id);
  });

  it('may be added by members who accepted, for the owner', async () => {
    const list = await makePlaylist();
    actingAs = await makeMember(list.id, false);
    const res = await add(list.id, SONG);
    assert.equal(res.status, 403);
    assert.equal(
      await getRepository(MediaListSong).count({ where: { listId: list.id } }),
      0
    );

    actingAs = await makeMember(list.id, true);
    assert.equal((await add(list.id, SONG)).status, 201);
    const [song] = await getRepository(MediaListSong).find({
      where: { listId: list.id },
    });
    assert.equal(song.requestForId, user.id);
  });

  it('is not added to a list that isn’t a playlist, or can’t be seen', async () => {
    const movies = await getRepository(MediaList).save(
      new MediaList({ name: 'Films', kind: 'watch', ownerId: user.id })
    );
    assert.equal((await add(movies.id, SONG)).status, 404);
    const list = await makePlaylist();
    actingAs = await getRepository(User).save(
      new User({
        email: `stranger-${Math.random()}@test.local`,
        avatar: '',
        permissions: Permission.REQUEST,
      })
    );
    assert.equal((await add(list.id, SONG)).status, 404);
  });

  it('needs a title and artist, and fields that make sense', async () => {
    const list = await makePlaylist();
    for (const body of [
      {},
      { title: 'Lantern Song' },
      { title: '  ', artistName: 'Glasswing' },
      { ...SONG, title: 'x'.repeat(251) },
      { ...SONG, albumTitle: 7 },
      { ...SONG, length: -1 },
      { ...SONG, length: 1.5 },
      { ...SONG, length: '214000' },
      { ...SONG, mbids: 'a1b2c3d4-0002-4000-8000-000000000002' },
      { ...SONG, mbids: [3] },
    ]) {
      assert.equal(
        (await add(list.id, body)).status,
        400,
        JSON.stringify(body)
      );
    }
    assert.equal(
      await getRepository(MediaListSong).count({ where: { listId: list.id } }),
      0
    );
  });

  it('is refused while Music is turned off', async () => {
    const list = await makePlaylist();
    getSettings().main.disabledFeatures = ['music'];
    const res = await add(list.id, SONG);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { message: 'Music is turned off.' });
  });

  it('waits while many of the owner’s songs are still being looked for', async () => {
    const list = await makePlaylist();
    const waiting = await makePlaylist();
    await getRepository(MediaListSong).save(
      Array.from(
        { length: MOST_SONGS_MATCHING },
        (_, i) =>
          new MediaListSong({
            listId: waiting.id,
            sourceId: `spotify:track:waiting${i}`,
            position: i,
            title: `Waiting ${i}`,
            artistName: 'Glasswing',
            state: 'matching',
            requestForId: user.id,
          })
      ),
      { chunk: 100 }
    );
    assert.equal((await add(list.id, SONG)).status, 429);
    assert.equal(
      await getRepository(MediaListSong).count({ where: { listId: list.id } }),
      0
    );
  });

  it('is refused past so many in a while', async () => {
    actingAs = Object.assign(new User(), { id: 777_101 });
    for (let i = 0; i < 120; i++) {
      assert.equal((await add(999_999, SONG)).status, 404);
    }
    assert.equal((await add(999_999, SONG)).status, 429);
  });
});
