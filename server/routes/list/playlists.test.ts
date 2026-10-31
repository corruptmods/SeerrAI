import { MusicBrainz } from '@server/api/musicbrainz';
import { getRepository } from '@server/datasource';
import { MediaList, MediaListSong } from '@server/entity/MediaList';
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
 * Linking a playlist: each link reads a page from Spotify and brings in
 * songs to look for on MusicBrainz, so a person links only so many in a
 * while, and not while many of theirs are still being looked for. Names
 * are invented.
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
  // MusicBrainz knows no one: each song is left unmatched.
  mock.method(MusicBrainz.prototype, 'searchArtists', async () => ({
    count: 0,
    offset: 0,
    artists: [],
  }));
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

    // Someone else's waiting songs are not theirs.
    await getRepository(MediaListSong).update(
      { listId: waiting.id },
      { requestForId: null }
    );
    assert.equal((await link(list.id)).status, 200);
  });

  it('is refused past so many tries in a while', async () => {
    // People of their own, whom no other test has counted.
    const someone = (id: number) => Object.assign(new User(), { id });
    actingAs = someone(777_001);
    // A list that isn't there still counts as a try.
    for (let i = 0; i < 20; i++) {
      assert.equal((await link(999_999)).status, 404);
    }
    assert.equal((await link(999_999)).status, 429);
    // Someone else has tries of their own.
    actingAs = someone(777_002);
    assert.equal((await link(999_999)).status, 404);
  });
});
