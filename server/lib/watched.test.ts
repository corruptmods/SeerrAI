import { MediaType } from '@server/constants/media';
import type { MediaServerKind } from '@server/constants/server';
import {
  MEDIA_SERVER_KINDS,
  MediaServerType,
  typeOfKind,
} from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import {
  dropWatched,
  forgetWatched,
  watchedCached,
  watchedFor,
  watchedWithin,
} from '@server/lib/watched';
import { JellyfinWatchSource } from '@server/lib/watchHistory/jellyfin';
import { TautulliWatchSource } from '@server/lib/watchHistory/tautulli';
import type { Play } from '@server/lib/watchHistory/types';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * What someone has watched, from each media server's history: what counts,
 * what happens when a server cannot be read, and the in-memory copy.
 */

setupTestDb();

const now = Math.floor(Date.now() / 1000);

const connect = (...kinds: MediaServerKind[]) => {
  const settings = getSettings();
  settings.main.mediaServerType = typeOfKind(kinds[0]);
  for (const kind of MEDIA_SERVER_KINDS) {
    settings[kind].connected = kinds.includes(kind);
  }
};

const play = (fields: Partial<Play>): Play => ({
  at: now,
  kind: 'movie',
  itemId: 'i',
  titleId: 't',
  title: 'A title',
  finished: false,
  percent: 0,
  viewerId: 'v',
  viewerName: 'Someone',
  ...fields,
});

/** Each server's history for whoever asks. */
let plays: Partial<Record<MediaServerKind, Play[] | Error>> = {};
let asked: string[] = [];

const answer = (kind: MediaServerKind) => async () => {
  asked.push(kind);
  const found = plays[kind] ?? [];
  if (found instanceof Error) throw found;
  return found;
};

let viewer: User;

beforeEach(async () => {
  forgetWatched();
  plays = {};
  asked = [];
  const settings = getSettings();
  settings.tautulli = {
    ...settings.tautulli,
    hostname: 'tautulli.invalid',
    port: 8181,
    apiKey: 'k',
  };
  settings.jellyfin = { ...settings.jellyfin, ip: 'jf.invalid', apiKey: 'jk' };
  settings.emby = { ...settings.emby, ip: 'emby.invalid', apiKey: 'ek' };
  mock.method(TautulliWatchSource.prototype, 'history', answer('plex'));
  mock.method(
    JellyfinWatchSource.prototype,
    'history',
    async function (this: JellyfinWatchSource) {
      return answer(this.kind)();
    }
  );
  viewer = await getRepository(User).save(
    new User({
      email: 'watched@test.local',
      plexUsername: 'Viewer',
      plexId: 7001,
      jellyfinUserId: 'jf-viewer',
      embyUserId: 'emby-viewer',
      permissions: Permission.REQUEST,
      avatar: '',
    })
  );
  // Glasswing and Static Garden are films, Harbour Lights a series, on
  // every server.
  await getRepository(Media).save([
    new Media({
      tmdbId: 7101,
      mediaType: MediaType.MOVIE,
      ratingKey: 'p-glass',
      jellyfinMediaId: 'j-glass',
      embyMediaId: 'e-glass',
    }),
    new Media({
      tmdbId: 7102,
      mediaType: MediaType.MOVIE,
      ratingKey: 'p-static',
      jellyfinMediaId: 'j-static',
      embyMediaId: 'e-static',
    }),
    new Media({
      tmdbId: 7103,
      mediaType: MediaType.TV,
      ratingKey: 'p-harbour',
      jellyfinMediaId: 'j-harbour',
      embyMediaId: 'e-harbour',
    }),
  ]);
});

afterEach(() => {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.NOT_CONFIGURED;
  for (const kind of MEDIA_SERVER_KINDS) settings[kind].connected = false;
  mock.restoreAll();
  forgetWatched();
});

const keys = async () => [...(await watchedFor(viewer)).keys].sort();

describe('what counts as watched', () => {
  for (const kind of MEDIA_SERVER_KINDS) {
    it(`reads ${kind}: finished, or played past a fifth`, async () => {
      connect(kind);
      const id = (name: string) =>
        `${kind === 'plex' ? 'p' : kind === 'jellyfin' ? 'j' : 'e'}-${name}`;
      plays[kind] = [
        play({ titleId: id('glass'), finished: true, percent: 100 }),
        // Sampled: not watched.
        play({ titleId: id('static'), percent: 10 }),
        // One episode a quarter of the way through: the series counts.
        play({ kind: 'episode', titleId: id('harbour'), percent: 25 }),
      ];
      assert.deepEqual(await keys(), ['movie:7101', 'tv:7103']);
    });
  }

  it('counts a title marked watched by hand, with no date (Emby)', async () => {
    connect('emby');
    plays.emby = [play({ titleId: 'e-static', at: 0, finished: true })];
    assert.deepEqual(await keys(), ['movie:7102']);
  });

  it('counts plays at 85% or more as finished, as Tautulli records some', async () => {
    connect('plex');
    plays.plex = [play({ titleId: 'p-static', percent: 90 })];
    assert.deepEqual(await keys(), ['movie:7102']);
  });

  it('joins every connected server', async () => {
    connect('plex', 'jellyfin', 'emby');
    plays.plex = [play({ titleId: 'p-glass', finished: true })];
    plays.jellyfin = [play({ titleId: 'j-static', percent: 50 })];
    plays.emby = [play({ kind: 'episode', titleId: 'e-harbour', percent: 30 })];
    assert.deepEqual(await keys(), ['movie:7101', 'movie:7102', 'tv:7103']);
  });

  it('is nothing for someone with no media server account', async () => {
    connect('plex');
    viewer.plexId = undefined as unknown as number;
    plays.plex = [play({ titleId: 'p-glass', finished: true })];
    assert.deepEqual(await keys(), []);
    assert.deepEqual(asked, []);
  });
});

describe('when a server cannot be read', () => {
  it('never throws, and goes by the servers that answered', async () => {
    connect('plex', 'jellyfin');
    plays.plex = new Error('Tautulli is down');
    plays.jellyfin = [play({ titleId: 'j-glass', finished: true })];
    assert.deepEqual(await keys(), ['movie:7101']);

    forgetWatched();
    plays.jellyfin = new Error('Jellyfin is down');
    assert.deepEqual(await keys(), []);
  });

  it('keeps what it knew rather than forget everything', async () => {
    connect('plex');
    plays.plex = [play({ titleId: 'p-glass', finished: true })];
    assert.deepEqual(await keys(), ['movie:7101']);

    // Due again, and the server is down.
    mock.method(Date, 'now', () => (now + 31 * 60) * 1000);
    plays.plex = new Error('Tautulli is down');
    assert.deepEqual(await keys(), ['movie:7101']);
    assert.equal(asked.length, 2);
  });
});

describe('the copy in memory', () => {
  it('reads the server once per half hour', async () => {
    connect('plex');
    plays.plex = [play({ titleId: 'p-glass', finished: true })];
    await Promise.all([watchedFor(viewer), watchedFor(viewer)]);
    await watchedFor(viewer);
    assert.equal(asked.length, 1, 'one read, shared');
  });

  it('serves what it has without waiting, and reads afresh behind it', async () => {
    connect('plex');
    plays.plex = [play({ titleId: 'p-glass', finished: true })];
    assert.equal(watchedCached(viewer), undefined, 'nothing read yet');
    await watchedFor(viewer);

    mock.method(Date, 'now', () => (now + 31 * 60) * 1000);
    plays.plex = [
      play({ titleId: 'p-static', finished: true }),
      play({ titleId: 'p-glass', finished: true }),
    ];
    // Stale, still served at once.
    assert.deepEqual([...(watchedCached(viewer)?.keys ?? [])], ['movie:7101']);
    // The fresh copy follows.
    assert.deepEqual(await keys(), ['movie:7101', 'movie:7102']);
    assert.equal(asked.length, 2);
  });

  it('gives up waiting after the time allowed', async () => {
    connect('plex');
    mock.method(
      TautulliWatchSource.prototype,
      'history',
      () => new Promise(() => undefined)
    );
    assert.equal(await watchedWithin(viewer, 20), undefined);
  });

  it('starts afresh once their media server account changes', async () => {
    connect('plex');
    plays.plex = [play({ titleId: 'p-glass', finished: true })];
    await watchedFor(viewer);
    viewer.plexId = 7002;
    plays.plex = [play({ titleId: 'p-static', finished: true })];
    assert.deepEqual(await keys(), ['movie:7102']);
  });
});

describe('leaving watched titles out', () => {
  it('takes app and TMDB results alike', () => {
    const watched = new Set(['movie:1', 'tv:2']);
    assert.deepEqual(
      dropWatched(watched, [
        { id: 1, mediaType: 'movie' },
        { id: 1, mediaType: 'tv' },
        { id: 2, media_type: 'tv' },
        { id: 3, media_type: 'movie' },
      ]),
      [
        { id: 1, mediaType: 'tv' },
        { id: 3, media_type: 'movie' },
      ]
    );
    assert.deepEqual(dropWatched(undefined, [{ id: 1, mediaType: 'movie' }]), [
      { id: 1, mediaType: 'movie' },
    ]);
  });
});
