import type { PlexWatchlistItem } from '@server/api/plextv';
import PlexTvAPI from '@server/api/plextv';
import TheMovieDb from '@server/api/themoviedb';
import type { TraktTitle } from '@server/api/trakt';
import TraktAPI, { TraktError } from '@server/api/trakt';
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { WatchlistSyncEntry } from '@server/entity/WatchlistSyncEntry';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

/*
 * Requests from a Trakt watchlist, alone or beside a Plex one. The Plex
 * watchlist's own behaviour is in watchlistsync.test.ts.
 */

const ADDED = 1_760_000_000;

let trakt: TraktTitle[] | TraktError = [];
let traktCalls: string[] = [];
let plexItems: PlexWatchlistItem[] = [];
let plexAuthFailed = false;
let plexDateCalls: string[] = [];
let requests: { mediaId: number; mediaType: MediaType }[] = [];

Object.defineProperty(TraktAPI.prototype, 'recentWatchlist', {
  value: async (user: string) => {
    traktCalls.push(user);
    if (trakt instanceof TraktError) throw trakt;
    return trakt;
  },
  writable: true,
  configurable: true,
});

Object.defineProperty(PlexTvAPI.prototype, 'getWatchlist', {
  get() {
    return async () =>
      plexAuthFailed
        ? { offset: 0, size: 20, totalSize: 0, items: [], authFailed: true }
        : {
            offset: 0,
            size: 20,
            totalSize: plexItems.length,
            items: plexItems,
          };
  },
  set() {},
  configurable: true,
});

Object.defineProperty(PlexTvAPI.prototype, 'getWatchlistedAt', {
  get() {
    return async (ratingKey: string) => {
      plexDateCalls.push(ratingKey);
      return ADDED - 50_000;
    };
  },
  set() {},
  configurable: true,
});

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get() {
    return async ({ tvId }: { tvId: number }) => ({
      id: tvId,
      seasons: [{ season_number: 1, air_date: null }],
    });
  },
  set() {},
  configurable: true,
});

Object.defineProperty(MediaRequest, 'request', {
  value: async (body: { mediaId: number; mediaType: MediaType }) => {
    requests.push({ mediaId: body.mediaId, mediaType: body.mediaType });
    return {} as MediaRequest;
  },
  writable: true,
  configurable: true,
});

import watchlistSync from '@server/lib/watchlistsync';

setupTestDb();

const movie = (tmdbId: number, listedAt = ADDED): TraktTitle => ({
  type: 'movie',
  title: `Film ${tmdbId}`,
  tmdbId,
  listedAt,
});

const syncUser = async ({ plex = false } = {}): Promise<User> => {
  const users = getRepository(User);
  const user = await users.findOneOrFail({ where: { id: 1 } });
  user.plexToken = plex ? 'plex-token' : '';
  user.permissions = Permission.AUTO_REQUEST;
  await users.save(user);
  await getRepository(UserSettings).save(
    new UserSettings({
      user,
      watchlistSyncMovies: true,
      watchlistSyncTv: true,
      traktUsername: 'someone',
    })
  );
  return user;
};

/** The title as it is after someone deleted it from the library. */
const deleteTitle = (tmdbId: number) =>
  getRepository(Media).save(
    new Media({
      tmdbId,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.DELETED,
      status4k: MediaStatus.UNKNOWN,
    })
  );

const entryStamp = async (tmdbId: number) =>
  (
    await getRepository(WatchlistSyncEntry).findOne({
      where: { requestedBy: { id: 1 }, tmdbId, mediaType: MediaType.MOVIE },
    })
  )?.watchlistedAt;

beforeEach(() => {
  getSettings().trakt = { clientId: 'client-id' };
  trakt = [];
  traktCalls = [];
  plexItems = [];
  plexAuthFailed = false;
  plexDateCalls = [];
  requests = [];
});

afterEach(() => {
  getSettings().trakt = {};
});

describe('watchlist sync from Trakt', () => {
  it('requests what someone with no Plex puts on their Trakt watchlist, once', async () => {
    await syncUser();
    trakt = [movie(603)];

    await watchlistSync.syncWatchlist();
    assert.deepEqual(requests, [{ mediaId: 603, mediaType: MediaType.MOVIE }]);
    assert.deepEqual(traktCalls, ['someone']);
    assert.equal(await entryStamp(603), ADDED);

    await watchlistSync.syncWatchlist();
    assert.equal(requests.length, 1, 'already acted on');
  });

  it('requests again when it is taken off and put back', async () => {
    await syncUser();
    trakt = [movie(603)];
    await watchlistSync.syncWatchlist();

    trakt = [movie(603, ADDED + 86_400)];
    await watchlistSync.syncWatchlist();
    assert.equal(requests.length, 2);
    assert.equal(await entryStamp(603), ADDED + 86_400);
  });

  it('acts once on a title on both watchlists, by Trakt’s time', async () => {
    await syncUser({ plex: true });
    plexItems = [
      { ratingKey: 'rk-603', tmdbId: 603, title: 'Film 603', type: 'movie' },
      { ratingKey: 'rk-604', tmdbId: 604, title: 'Film 604', type: 'movie' },
    ];
    trakt = [movie(603)];

    await watchlistSync.syncWatchlist();
    assert.deepEqual(requests.map((r) => r.mediaId).sort(), [603, 604]);
    assert.equal(await entryStamp(603), ADDED);
    assert.deepEqual(
      plexDateCalls,
      ['rk-604'],
      'Plex is asked only for its own'
    );

    // Plex's sign-in expiring leaves the title on both as it was.
    plexAuthFailed = true;
    await watchlistSync.syncWatchlist();
    assert.equal(requests.length, 2);
  });

  it('still syncs Trakt when Plex turns the sign-in down', async () => {
    await syncUser({ plex: true });
    plexAuthFailed = true;
    trakt = [movie(605)];

    await watchlistSync.syncWatchlist();
    assert.deepEqual(requests, [{ mediaId: 605, mediaType: MediaType.MOVIE }]);
  });

  it('waits for Trakt when it cannot be reached, rather than sync half', async () => {
    await syncUser({ plex: true });
    plexItems = [
      { ratingKey: 'rk-606', tmdbId: 606, title: 'Film 606', type: 'movie' },
    ];
    trakt = new TraktError('unreachable', 'down');

    await watchlistSync.syncWatchlist();
    assert.deepEqual(requests, []);
  });

  it('syncs Plex alone when the Trakt watchlist is private', async () => {
    await syncUser({ plex: true });
    plexItems = [
      { ratingKey: 'rk-607', tmdbId: 607, title: 'Film 607', type: 'movie' },
    ];
    trakt = new TraktError('private', 'private');

    await watchlistSync.syncWatchlist();
    assert.deepEqual(requests, [{ mediaId: 607, mediaType: MediaType.MOVIE }]);
  });

  it('leaves out a series with no TVDB id, and anything without Trakt set up', async () => {
    await syncUser();
    trakt = [{ type: 'show', title: 'No TVDB', tmdbId: 700, listedAt: ADDED }];
    await watchlistSync.syncWatchlist();
    assert.deepEqual(requests, []);

    getSettings().trakt = {};
    trakt = [movie(608)];
    traktCalls = [];
    await watchlistSync.syncWatchlist();
    assert.deepEqual(requests, []);
    assert.deepEqual(traktCalls, [], 'Trakt is not asked without a Client ID');
  });

  it('reads only Trakt on a Jellyfin or Emby server', async () => {
    await syncUser({ plex: true });
    getSettings().main.mediaServerType = MediaServerType.JELLYFIN;
    try {
      plexItems = [
        { ratingKey: 'rk-609', tmdbId: 609, title: 'Film 609', type: 'movie' },
      ];
      trakt = [movie(610)];
      await watchlistSync.syncWatchlist();
      assert.deepEqual(requests, [
        { mediaId: 610, mediaType: MediaType.MOVIE },
      ]);
    } finally {
      getSettings().main.mediaServerType = MediaServerType.NOT_CONFIGURED;
    }
  });

  it('does not request a deleted title again when its time moves between watchlists', async () => {
    await syncUser({ plex: true });
    plexItems = [
      { ratingKey: 'rk-611', tmdbId: 611, title: 'Film 611', type: 'movie' },
    ];
    trakt = [movie(611)];
    await watchlistSync.syncWatchlist();
    assert.equal(requests.length, 1);
    await deleteTitle(611);

    // Trakt cannot be read: the title now goes by Plex's time.
    trakt = new TraktError('private', 'private');
    await watchlistSync.syncWatchlist();
    // And back.
    trakt = [movie(611)];
    await watchlistSync.syncWatchlist();
    assert.equal(requests.length, 1, 'never requested again');
  });

  it('does not request deleted titles again when a Trakt username is added', async () => {
    const user = await syncUser({ plex: true });
    // Synced from Plex alone before Trakt was set up.
    await getRepository(UserSettings).update(
      { user: { id: user.id } },
      { traktUsername: null }
    );
    plexItems = [
      { ratingKey: 'rk-612', tmdbId: 612, title: 'Film 612', type: 'movie' },
    ];
    await watchlistSync.syncWatchlist();
    assert.equal(requests.length, 1);
    await deleteTitle(612);

    await getRepository(UserSettings).update(
      { user: { id: user.id } },
      { traktUsername: 'someone' }
    );
    trakt = [movie(612)];
    await watchlistSync.syncWatchlist();
    assert.equal(requests.length, 1, 'the same entry, now by Trakt’s time');
    assert.equal(await entryStamp(612), ADDED);
  });

  it('requests a series by its TVDB id from Trakt', async () => {
    await syncUser();
    trakt = [
      {
        type: 'show',
        title: 'A Series',
        tmdbId: 1396,
        tvdbId: 81189,
        listedAt: ADDED,
      },
    ];
    await watchlistSync.syncWatchlist();
    assert.deepEqual(requests, [{ mediaId: 1396, mediaType: MediaType.TV }]);
  });
});
