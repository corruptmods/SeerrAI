import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import nowPlaying, { RECENT_MS } from '@server/lib/nowPlaying';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

/*
 * What someone is watching, from a stand-in Plex and Jellyfin answering
 * /status/sessions and /Sessions as the real ones do: Plex lists only what
 * is playing, with its owner as user "1"; Jellyfin and Emby list every
 * device, NowPlayingItem only on those playing, and Seerr's own devices
 * with no user at all (as an Emby 4.10 did when tried by hand).
 */

setupTestDb();

const JELLYFIN_KEY = 'jf-key';
let plexSessions: unknown[] = [];
let jellyfinSessions: unknown[] = [];
let asked: string[] = [];
let jellyfinDown = false;

const fake = http.createServer((req, res) => {
  const url = new URL(req.url ?? '', 'http://x');
  asked.push(url.pathname);
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/status/sessions') {
    if (req.headers['x-plex-token'] !== 'owner-token') return send(401, {});
    return send(200, {
      MediaContainer: { size: plexSessions.length, Metadata: plexSessions },
    });
  }
  if (url.pathname === '/Sessions') {
    if (jellyfinDown) return send(500, {});
    if (!String(req.headers.authorization).includes(`Token="${JELLYFIN_KEY}"`))
      return send(401, {});
    return send(200, jellyfinSessions);
  }
  send(404, {});
});

let port = 0;
before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  port = (fake.address() as { port: number }).port;
});
after(() => fake.close());

let viewer: User;
let bear: Media;
let film: Media;

beforeEach(async () => {
  plexSessions = [];
  jellyfinSessions = [];
  asked = [];
  jellyfinDown = false;
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.plex = {
    ...settings.plex,
    ip: '127.0.0.1',
    port,
    useSsl: false,
    connected: true,
  };
  settings.jellyfin = {
    ...settings.jellyfin,
    ip: '127.0.0.1',
    port,
    useSsl: false,
    urlBase: '',
    apiKey: JELLYFIN_KEY,
    connected: true,
  };
  settings.tautulli = {};
  const users = getRepository(User);
  await users.update(1, { plexToken: 'owner-token' });
  viewer = await users.save(
    new User({
      email: 'np-viewer@test.local',
      plexUsername: 'viewer',
      plexId: 555,
      jellyfinUserId: '6f1e2d3c4b5a69788796a5b4c3d2e1f0',
      permissions: Permission.CREATE_ISSUES,
      avatar: '',
    })
  );
  const media = getRepository(Media);
  bear = await media.save(
    new Media({
      tmdbId: 247426,
      mediaType: MediaType.TV,
      status: MediaStatus.AVAILABLE,
      ratingKey: '9001',
      jellyfinMediaId: 'b3a4c5d6e7f8091a2b3c4d5e6f708192',
    })
  );
  film = await media.save(
    new Media({
      tmdbId: 137,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.AVAILABLE,
      ratingKey: '777',
      ratingKey4k: '778',
    })
  );
});

afterEach(() => {
  getSettings().plex.connected = false;
  getSettings().jellyfin.connected = false;
});

const plexEpisode = (userId: string, state = 'playing') => ({
  type: 'episode',
  ratingKey: '9123',
  grandparentRatingKey: '9001',
  grandparentTitle: 'The Otterkin',
  title: 'Gelato Hour',
  parentIndex: 2,
  index: 3,
  User: { id: userId, title: 'someone' },
  Player: { state, title: 'Apple TV' },
});

describe('Now playing', () => {
  it('finds what Plex is playing for someone, by their plex.tv id', async () => {
    plexSessions = [plexEpisode('555'), plexEpisode('999')];
    const found = await nowPlaying.playingFor(viewer);
    assert.equal(found.length, 1);
    assert.equal(found[0].media.id, bear.id);
    assert.equal(found[0].title, 'The Otterkin');
    assert.equal(found[0].season, 2);
    assert.equal(found[0].episode, 3);
    assert.equal(found[0].seen, 'now');
    assert.equal(found[0].server, 'plex');
  });

  it('knows the owner as Plex’s user "1"', async () => {
    plexSessions = [
      {
        type: 'movie',
        ratingKey: '778',
        title: 'Hedgehog Morning',
        User: { id: '1', title: 'owner' },
        Player: { state: 'paused' },
      },
    ];
    const owner = await getRepository(User).findOneByOrFail({ id: 1 });
    const found = await nowPlaying.playingFor(owner);
    assert.equal(found.length, 1, 'the 4K copy is the same film');
    assert.equal(found[0].media.id, film.id);
    assert.equal(found[0].paused, true);
    assert.deepEqual(await nowPlaying.playingFor(viewer), []);
  });

  it('reads Jellyfin’s sessions, matching ids with or without dashes', async () => {
    jellyfinSessions = [
      // Seerr's own device, as a real server listed it: no user, nothing on.
      { Id: 'x', Client: 'Seerr', DeviceName: 'Seerr', PlayState: {} },
      {
        UserId: '6f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
        NowPlayingItem: {
          Type: 'Episode',
          Id: 'ep1',
          SeriesId: 'B3A4C5D6E7F8091A2B3C4D5E6F708192',
          SeriesName: 'The Otterkin',
          ParentIndexNumber: 1,
          IndexNumber: 7,
        },
        PlayState: { IsPaused: false },
      },
    ];
    const found = await nowPlaying.playingFor(viewer);
    assert.equal(found.length, 1);
    assert.equal(found[0].media.id, bear.id);
    assert.equal(found[0].season, 1);
    assert.equal(found[0].episode, 7);
    assert.equal(found[0].server, 'jellyfin');
  });

  it('puts what is playing before what is paused, and keeps one entry a title', async () => {
    plexSessions = [
      {
        type: 'movie',
        ratingKey: '777',
        title: 'Hedgehog Morning',
        User: { id: '555' },
        Player: { state: 'paused' },
      },
      plexEpisode('555', 'playing'),
      plexEpisode('555', 'buffering'),
    ];
    const found = await nowPlaying.playingFor(viewer);
    assert.deepEqual(
      found.map((f) => f.media.id),
      [bear.id, film.id]
    );
  });

  it('keeps to films when asked, unless no film is playing', async () => {
    plexSessions = [
      plexEpisode('555'),
      {
        type: 'movie',
        ratingKey: '777',
        title: 'Hedgehog Morning',
        User: { id: '555' },
        Player: { state: 'paused' },
      },
    ];
    const films = await nowPlaying.playingFor(viewer, MediaType.MOVIE);
    assert.deepEqual(
      films.map((f) => f.media.id),
      [film.id]
    );
    plexSessions = [plexEpisode('555')];
    const any = await nowPlaying.playingFor(viewer, MediaType.MOVIE);
    assert.deepEqual(
      any.map((f) => f.media.id),
      [bear.id]
    );
  });

  it('leaves out what is not in the library, and music', async () => {
    plexSessions = [
      { ...plexEpisode('555'), grandparentRatingKey: '4040' },
      { type: 'track', ratingKey: '1', User: { id: '555' } },
    ];
    assert.deepEqual(await nowPlaying.playingFor(viewer), []);
  });

  it('asks the servers each time, as what plays changes by the second', async () => {
    plexSessions = [plexEpisode('555')];
    assert.equal((await nowPlaying.playingFor(viewer)).length, 1);
    plexSessions = [];
    assert.equal((await nowPlaying.playingFor(viewer)).length, 0);
    assert.equal(asked.filter((p) => p === '/status/sessions').length, 2);
  });

  it('still reads one server when another is down', async () => {
    jellyfinDown = true;
    plexSessions = [plexEpisode('555')];
    const found = await nowPlaying.playingFor(viewer);
    assert.equal(found.length, 1);
  });

  it('falls back to what they stopped in the last half hour', async () => {
    const now = Date.now() / 1000;
    const plays = [
      {
        at: now - 60,
        kind: 'episode',
        itemId: 'e',
        titleId: '9001',
        title: 'The Otterkin',
        season: 2,
        episode: 4,
        finished: false,
        percent: 40,
        viewerId: '555',
        viewerName: 'viewer',
      },
      {
        at: now - RECENT_MS / 1000 - 60,
        kind: 'movie',
        itemId: '777',
        titleId: '777',
        title: 'Hedgehog Morning',
        finished: true,
        percent: 100,
        viewerId: '555',
        viewerName: 'viewer',
      },
    ];
    const history = await import('@server/lib/watchHistory');
    const { mock } = await import('node:test');
    mock.method(history, 'watchSource', () => ({
      history: async () => plays,
      mediaFor: async (ids: string[]) =>
        new Map(
          ids.flatMap((id) =>
            id === '9001' ? [[id, bear]] : id === '777' ? [[id, film]] : []
          ) as [string, Media][]
        ),
    }));
    try {
      const found = await nowPlaying.playingFor(viewer);
      assert.equal(found.length, 1, 'the film was over half an hour ago');
      assert.equal(found[0].seen, 'recent');
      assert.equal(found[0].episode, 4);
    } finally {
      mock.restoreAll();
    }
  });
});
