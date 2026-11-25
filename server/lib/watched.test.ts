import type { TraktWatched } from '@server/api/trakt';
import TraktAPI, { TraktError } from '@server/api/trakt';
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
import type { UserSettings } from '@server/entity/UserSettings';
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
import { SiloWatchSource } from '@server/lib/watchHistory/silo';
import { TautulliWatchSource } from '@server/lib/watchHistory/tautulli';
import type { Play } from '@server/lib/watchHistory/types';
import logger from '@server/logger';
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
  settings.silo = { ...settings.silo, ip: 'silo.invalid', apiKey: 'sk' };
  mock.method(SiloWatchSource.prototype, 'history', answer('silo'));
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
      siloUserId: 'silo-viewer',
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
      siloMediaId: 's-glass',
    }),
    new Media({
      tmdbId: 7102,
      mediaType: MediaType.MOVIE,
      ratingKey: 'p-static',
      jellyfinMediaId: 'j-static',
      embyMediaId: 'e-static',
      siloMediaId: 's-static',
    }),
    new Media({
      tmdbId: 7103,
      mediaType: MediaType.TV,
      ratingKey: 'p-harbour',
      jellyfinMediaId: 'j-harbour',
      embyMediaId: 'e-harbour',
      siloMediaId: 's-harbour',
    }),
  ]);
});

afterEach(() => {
  const settings = getSettings();
  settings.trakt = {};
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
      const id = (name: string) => `${kind[0]}-${name}`;
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

  it('forgets one person without dropping what another is reading', async () => {
    connect('plex');
    plays.plex = [play({ titleId: 'p-glass', finished: true })];
    const other = new User({ id: 9001, plexId: 7002 });
    const reading = watchedFor(other);
    forgetWatched(viewer.id);
    await reading;
    assert.ok(watchedCached(other), 'their read was kept');

    await watchedFor(viewer);
    assert.ok(watchedCached(viewer));
    forgetWatched(viewer.id);
    assert.ok(watchedCached(other), 'their copy was kept');
    forgetWatched();
    const again = watchedFor(other);
    forgetWatched();
    await again;
    assert.equal(watchedCached(other), undefined, 'everyone is dropped');
  });

  it('forgets the person whose read was in flight', async () => {
    connect('plex');
    plays.plex = [play({ titleId: 'p-glass', finished: true })];
    const reading = watchedFor(viewer);
    forgetWatched(viewer.id);
    await reading;
    assert.equal(watchedCached(viewer), undefined);
  });

  it('keeps the entry read most recently', async () => {
    connect('plex');
    plays.plex = [play({ titleId: 'p-glass', finished: true })];
    const first = new User({ id: 9101, plexId: 7101 });
    await watchedFor(first);
    for (let i = 0; i < 600; i++) {
      await watchedFor(new User({ id: 9200 + i, plexId: 7200 + i }));
      // Read all along, so it is never the oldest.
      watchedCached(first);
    }
    assert.ok(watchedCached(first));
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

describe('what they watched on Trakt', () => {
  const NAME = 'lantern-fan';
  let trakt: { movies: TraktWatched[] | Error; shows: TraktWatched[] | Error };
  let traktAsks: string[] = [];
  /** Moves the clock this many minutes on from now; mocked once a test. */
  let offset = 0;
  const later = (minutes: number) => {
    if (!offset) {
      mock.method(Date, 'now', () => (now + offset * 60) * 1000);
    }
    offset = minutes;
  };

  beforeEach(() => {
    offset = 0;
    getSettings().trakt = { clientId: 'c'.repeat(64), watchHistory: true };
    viewer.settings = { traktUsername: NAME } as UserSettings;
    traktAsks = [];
    trakt = {
      movies: [
        {
          type: 'movie',
          title: 'Lantern Song',
          year: 2004,
          tmdbId: 7104,
          lastWatchedAt: now - 3600,
        },
        // No TMDB id: their taste, but no key.
        { type: 'movie', title: 'Glasswing Live', lastWatchedAt: now - 60 },
      ],
      shows: [
        {
          type: 'show',
          title: 'Harbour Lights',
          year: 1999,
          tmdbId: 7103,
          lastWatchedAt: now - 7200,
        },
      ],
    };
    for (const kind of ['movies', 'shows'] as const) {
      mock.method(
        TraktAPI.prototype,
        kind === 'movies' ? 'watchedMovies' : 'watchedShows',
        async (name: string) => {
          traktAsks.push(`${kind}:${name}`);
          const answer = trakt[kind];
          if (answer instanceof Error) throw answer;
          return answer;
        }
      );
    }
    connect('plex');
    plays.plex = [play({ titleId: 'p-glass', finished: true })];
  });

  it('counts alongside the media server, once an admin turns it on', async () => {
    const watched = await watchedFor(viewer);
    assert.deepEqual([...watched.keys].sort(), [
      'movie:7101',
      'movie:7104',
      'tv:7103',
    ]);
    assert.deepEqual(
      watched.traktRecent.map((t) => [t.title, t.kind, t.key]),
      [
        ['Glasswing Live', 'movie', undefined],
        ['Lantern Song', 'movie', 'movie:7104'],
        ['Harbour Lights', 'tv', 'tv:7103'],
      ]
    );
    assert.deepEqual(traktAsks.sort(), [`movies:${NAME}`, `shows:${NAME}`]);
  });

  it('asks Trakt nothing while the admin switch is off, or with no name', async () => {
    getSettings().trakt = { clientId: 'c'.repeat(64) };
    assert.deepEqual(await keys(), ['movie:7101']);
    getSettings().trakt = { clientId: 'c'.repeat(64), watchHistory: true };
    viewer.settings = { traktUsername: null } as UserSettings;
    assert.deepEqual(await keys(), ['movie:7101']);
    assert.deepEqual(traktAsks, []);
  });

  it('stops asking about a private profile for hours, warning once', async () => {
    const warn = mock.method(logger, 'warn', () => logger);
    trakt.movies = new TraktError('private', `${NAME} is private.`);
    assert.deepEqual(await keys(), ['movie:7101']);
    assert.equal(traktAsks.length, 2);

    // Due again within the hour: the server is read, Trakt is not.
    later(31);
    assert.deepEqual(await keys(), ['movie:7101']);
    assert.equal(traktAsks.length, 2);
    assert.equal(asked.length, 2);

    // Hours later, asked again.
    later(7 * 60);
    trakt.movies = [];
    assert.deepEqual(await keys(), ['movie:7101', 'tv:7103']);
    assert.equal(traktAsks.length, 4);

    assert.equal(warn.mock.callCount(), 1);
    assert.doesNotMatch(
      JSON.stringify(warn.mock.calls[0].arguments),
      new RegExp(NAME),
      'the Trakt name is not logged'
    );
  });

  it('keeps the last Trakt answer while Trakt is busy, and the server’s while it is down', async () => {
    await watchedFor(viewer);
    later(31);
    trakt.shows = new TraktError('rateLimited', 'Busy.');
    plays.plex = [play({ titleId: 'p-static', finished: true })];
    assert.deepEqual(await keys(), ['movie:7102', 'movie:7104', 'tv:7103']);

    later(62);
    trakt.shows = [];
    plays.plex = new Error('Tautulli is down');
    assert.deepEqual(await keys(), ['movie:7102', 'movie:7104']);
  });

  it('starts afresh under a new Trakt name', async () => {
    await watchedFor(viewer);
    viewer.settings = { traktUsername: 'harbour-fan' } as UserSettings;
    trakt.movies = [];
    trakt.shows = [];
    assert.deepEqual(await keys(), ['movie:7101']);
    assert.ok(traktAsks.includes('movies:harbour-fan'));
  });
});
