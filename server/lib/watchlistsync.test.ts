import type { PlexWatchlistItem } from '@server/api/plextv';
import PlexTvAPI from '@server/api/plextv';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaDeletion from '@server/entity/MediaDeletion';
import {
  DuplicateMediaRequestError,
  MediaRequest,
  NoSeasonsAvailableError,
  QuotaRestrictedError,
} from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { WatchlistSyncEntry } from '@server/entity/WatchlistSyncEntry';
import { WatchlistSyncEntrySeason } from '@server/entity/WatchlistSyncEntrySeason';
import { Permission } from '@server/lib/permissions';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

const WATCHLISTED_AT = 1700000000;

let watchlistItems: PlexWatchlistItem[] = [];
let watchlistedAt = new Map<string, number | null>();
let userStateCalls: string[] = [];
/** How long each watchlist date lookup takes, and the most at once. */
let userStateDelayMs = 0;
let userStateInFlight = 0;
let userStateMostAtOnce = 0;
let tmdbSeasons: number[] = [];
/** Plex turning the user's token down, and how often it was asked. */
let watchlistAuthFailed = false;
let watchlistCalls = 0;
let tmdbAirDates = new Map<number, string>();

Object.defineProperty(PlexTvAPI.prototype, 'getWatchlist', {
  get() {
    return async () => {
      watchlistCalls += 1;
      return watchlistAuthFailed
        ? { offset: 0, size: 20, totalSize: 0, items: [], authFailed: true }
        : {
            offset: 0,
            size: 20,
            totalSize: watchlistItems.length,
            items: watchlistItems,
          };
    };
  },
  set() {},
  configurable: true,
});

Object.defineProperty(PlexTvAPI.prototype, 'getWatchlistedAt', {
  get() {
    return async (ratingKey: string) => {
      userStateCalls.push(ratingKey);
      userStateInFlight += 1;
      userStateMostAtOnce = Math.max(userStateMostAtOnce, userStateInFlight);
      await new Promise((resolve) => setTimeout(resolve, userStateDelayMs));
      userStateInFlight -= 1;
      return watchlistedAt.has(ratingKey)
        ? watchlistedAt.get(ratingKey)
        : WATCHLISTED_AT;
    };
  },
  set() {},
  configurable: true,
});

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get() {
    return async ({ tvId }: { tvId: number }) => ({
      id: tvId,
      seasons: tmdbSeasons.map((season_number) => ({
        season_number,
        air_date: tmdbAirDates.get(season_number) ?? null,
      })),
    });
  },
  set() {},
  configurable: true,
});

type RequestCall = {
  mediaId: number;
  mediaType: MediaType;
  seasons?: number[] | 'all';
};

let requestCalls: RequestCall[] = [];
let requestError: Error | null = null;

Object.defineProperty(MediaRequest, 'request', {
  value: async (body: RequestCall) => {
    requestCalls.push({
      mediaId: body.mediaId,
      mediaType: body.mediaType,
      seasons: body.seasons,
    });

    if (requestError) {
      throw requestError;
    }

    return {} as MediaRequest;
  },
  writable: true,
  configurable: true,
});

import watchlistSync, { EXPIRED_RETRY_MS } from '@server/lib/watchlistsync';

setupTestDb();

async function configureSyncUser(userId = 1): Promise<User> {
  const userRepository = getRepository(User);
  const user = await userRepository.findOneOrFail({ where: { id: userId } });

  user.plexToken = 'test-plex-token';
  user.permissions = Permission.AUTO_REQUEST;
  await userRepository.save(user);

  await getRepository(UserSettings).save(
    new UserSettings({
      user,
      watchlistSyncMovies: true,
      watchlistSyncTv: true,
    })
  );

  return user;
}

async function seedMedia(
  tmdbId: number,
  mediaType: MediaType,
  status: MediaStatus
): Promise<Media> {
  return getRepository(Media).save(
    new Media({
      tmdbId,
      mediaType,
      status,
      status4k: MediaStatus.UNKNOWN,
    })
  );
}

async function seedEntry(
  user: User,
  tmdbId: number,
  mediaType: MediaType,
  stamp: number,
  seasons: number[] = []
): Promise<void> {
  await getRepository(WatchlistSyncEntry).save(
    new WatchlistSyncEntry({
      requestedBy: user,
      tmdbId,
      mediaType,
      watchlistedAt: stamp,
      seasons: seasons.map(
        (seasonNumber) => new WatchlistSyncEntrySeason({ seasonNumber })
      ),
    })
  );
}

async function seedRequest({
  user,
  tmdbId,
  mediaType,
  createdAt,
  seasons = [],
  isAutoRequest = true,
}: {
  user: User;
  tmdbId: number;
  mediaType: MediaType;
  createdAt: number;
  seasons?: number[];
  isAutoRequest?: boolean;
}): Promise<void> {
  const media =
    (await getRepository(Media).findOne({ where: { tmdbId, mediaType } })) ??
    (await seedMedia(tmdbId, mediaType, MediaStatus.DELETED));

  await getRepository(MediaRequest).save(
    new MediaRequest({
      type: mediaType,
      status: MediaRequestStatus.COMPLETED,
      media,
      requestedBy: user,
      is4k: false,
      isAutoRequest,
      createdAt: new Date(createdAt * 1000),
      seasons: seasons.map(
        (seasonNumber) => new SeasonRequest({ seasonNumber })
      ),
    })
  );
}

function getEntry(
  tmdbId: number,
  mediaType: MediaType,
  userId = 1
): Promise<WatchlistSyncEntry | null> {
  return getRepository(WatchlistSyncEntry).findOne({
    where: { requestedBy: { id: userId }, tmdbId, mediaType },
  });
}

function movieItem(
  tmdbId: number,
  title: string,
  addedAt?: Date
): PlexWatchlistItem {
  return { ratingKey: `rk-${tmdbId}`, tmdbId, title, type: 'movie', addedAt };
}

function showItem(
  tmdbId: number,
  title: string,
  addedAt?: Date
): PlexWatchlistItem {
  return {
    ratingKey: `rk-${tmdbId}`,
    tmdbId,
    tvdbId: tmdbId * 1000,
    title,
    type: 'show',
    addedAt,
  };
}

const recordDeletion = (tmdbId: number, mediaType: MediaType, at: Date) =>
  getRepository(MediaDeletion).save(
    new MediaDeletion({ tmdbId, mediaType, deletedAt: at })
  );

function requestedIds(): string[] {
  return requestCalls.map((c) => `${c.mediaType}:${c.mediaId}`);
}

beforeEach(() => {
  requestCalls = [];
  watchlistItems = [];
  watchlistedAt = new Map();
  userStateCalls = [];
  userStateDelayMs = 0;
  userStateInFlight = 0;
  userStateMostAtOnce = 0;
  tmdbSeasons = [0, 1, 2, 3];
  tmdbAirDates = new Map();
  requestError = null;
});

describe('WatchlistSync status gating', () => {
  it('requests what is missing, and settles what was deleted rather than re-requesting it', async () => {
    await configureSyncUser();

    await seedMedia(100, MediaType.MOVIE, MediaStatus.DELETED);
    await seedMedia(101, MediaType.MOVIE, MediaStatus.UNKNOWN);
    await seedMedia(102, MediaType.MOVIE, MediaStatus.AVAILABLE);
    await seedMedia(103, MediaType.MOVIE, MediaStatus.BLOCKLISTED);
    await seedMedia(200, MediaType.TV, MediaStatus.DELETED);
    await seedMedia(201, MediaType.TV, MediaStatus.AVAILABLE);

    watchlistItems = [
      movieItem(100, 'Deleted Movie'),
      movieItem(101, 'Unknown Movie'),
      movieItem(102, 'Available Movie'),
      movieItem(103, 'Blocklisted Movie'),
      showItem(200, 'Deleted Show'),
      showItem(201, 'Available Show'),
    ];

    await watchlistSync.syncWatchlist();

    const requested = new Set(requestedIds());

    assert.strictEqual(
      requestedIds().length,
      requested.size,
      'Each item should be requested exactly once'
    );
    // Upstream requests deleted titles again here. This fork does not: a
    // deletion with no entry behind it is the loop a cleanup causes.
    assert.ok(!requested.has(`${MediaType.MOVIE}:100`));
    assert.ok(requested.has(`${MediaType.MOVIE}:101`));
    assert.ok(!requested.has(`${MediaType.MOVIE}:102`));
    assert.ok(!requested.has(`${MediaType.MOVIE}:103`));
    assert.ok(!requested.has(`${MediaType.TV}:200`));
    assert.ok(!requested.has(`${MediaType.TV}:201`));
    assert.ok(await getEntry(100, MediaType.MOVIE), 'settled as an entry');
    assert.ok(await getEntry(200, MediaType.TV), 'settled as an entry');
  });

  it('does not look up watchlist state for items the status filter drops', async () => {
    await configureSyncUser();

    await seedMedia(102, MediaType.MOVIE, MediaStatus.AVAILABLE);

    watchlistItems = [movieItem(101, 'New Movie'), movieItem(102, 'Available')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(userStateCalls, ['rk-101']);
  });
});

describe('WatchlistSync when the database cannot be read', () => {
  it('requests nothing rather than the whole watchlist again', async () => {
    await configureSyncUser();
    await seedMedia(102, MediaType.MOVIE, MediaStatus.AVAILABLE);
    watchlistItems = [movieItem(102, 'Available')];

    const find = Media.findRelatedMedia;
    Media.findRelatedMedia = async () => {
      throw new Error('sorry, too many clients already');
    };
    try {
      await watchlistSync.syncWatchlist();
    } finally {
      Media.findRelatedMedia = find;
    }
    assert.deepStrictEqual(requestedIds(), []);

    // Readable again: still nothing, as it is here.
    await watchlistSync.syncWatchlist();
    assert.deepStrictEqual(requestedIds(), []);
  });
});

describe('WatchlistSync with a slow Plex', () => {
  it('looks up when titles were watchlisted several at a time, once each', async () => {
    await configureSyncUser();
    userStateDelayMs = 30;
    watchlistItems = Array.from({ length: 8 }, (_, i) =>
      movieItem(500 + i, `Movie ${i}`)
    );

    await watchlistSync.syncWatchlist();

    assert.equal(userStateMostAtOnce, 5, 'five in flight, not one');
    assert.equal(userStateCalls.length, 8, 'and each looked up once');
    assert.equal(new Set(requestedIds()).size, 8);
  });
});

describe('WatchlistSync movie entries', () => {
  it('requests a new entry and records it', async () => {
    await configureSyncUser();
    watchlistItems = [movieItem(100, 'New Movie')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestedIds(), [`${MediaType.MOVIE}:100`]);

    const entry = await getEntry(100, MediaType.MOVIE);
    assert.strictEqual(entry?.watchlistedAt, WATCHLISTED_AT);
  });

  it('skips an entry that has already been acted on', async () => {
    const user = await configureSyncUser();
    await seedEntry(user, 100, MediaType.MOVIE, WATCHLISTED_AT);

    watchlistItems = [movieItem(100, 'Tracked Movie')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls, []);
  });

  it('requests again when the title is re-added', async () => {
    const user = await configureSyncUser();
    await seedEntry(user, 100, MediaType.MOVIE, WATCHLISTED_AT - 5000);

    watchlistItems = [movieItem(100, 'Re-added Movie')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestedIds(), [`${MediaType.MOVIE}:100`]);

    const entry = await getEntry(100, MediaType.MOVIE);
    assert.strictEqual(entry?.watchlistedAt, WATCHLISTED_AT);
  });

  it('ignores request history when the title was re-added', async () => {
    const user = await configureSyncUser();
    await seedEntry(user, 100, MediaType.MOVIE, WATCHLISTED_AT - 5000);
    await seedRequest({
      user,
      tmdbId: 100,
      mediaType: MediaType.MOVIE,
      createdAt: WATCHLISTED_AT + 60,
    });

    watchlistItems = [movieItem(100, 'Re-added Movie')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestedIds(), [`${MediaType.MOVIE}:100`]);

    const entry = await getEntry(100, MediaType.MOVIE);
    assert.strictEqual(entry?.watchlistedAt, WATCHLISTED_AT);
  });

  it('records the entry when a request already exists', async () => {
    await configureSyncUser();
    requestError = new DuplicateMediaRequestError('duplicate');

    watchlistItems = [movieItem(100, 'Duplicate Movie')];

    await watchlistSync.syncWatchlist();

    const entry = await getEntry(100, MediaType.MOVIE);
    assert.strictEqual(entry?.watchlistedAt, WATCHLISTED_AT);
  });

  it('retries on the next sync when the quota is exceeded', async () => {
    await configureSyncUser();
    requestError = new QuotaRestrictedError('quota');

    watchlistItems = [movieItem(100, 'Quota Movie')];

    await watchlistSync.syncWatchlist();

    assert.strictEqual(await getEntry(100, MediaType.MOVIE), null);

    requestError = null;
    await watchlistSync.syncWatchlist();

    assert.strictEqual(requestCalls.length, 2);
  });

  it('requests an undated title the way it did before entries were tracked', async () => {
    await configureSyncUser();
    watchlistedAt.set('rk-100', null);

    watchlistItems = [movieItem(100, 'Undated Movie')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestedIds(), ['movie:100']);
    assert.strictEqual(
      await getEntry(100, MediaType.MOVIE),
      null,
      'an entry is useless without the time it was added'
    );
  });
});

describe('WatchlistSync show entries', () => {
  it('requests every season except specials and records them', async () => {
    await configureSyncUser();
    watchlistItems = [showItem(200, 'New Show')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls[0]?.seasons, [1, 2, 3]);

    const entry = await getEntry(200, MediaType.TV);
    assert.deepStrictEqual(
      entry?.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2, 3]
    );
  });

  it('requests only seasons added since the entry was acted on', async () => {
    const user = await configureSyncUser();
    await seedEntry(user, 200, MediaType.TV, WATCHLISTED_AT, [1, 2, 3]);
    tmdbSeasons = [0, 1, 2, 3, 4];

    watchlistItems = [showItem(200, 'Ongoing Show')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls[0]?.seasons, [4]);

    const entry = await getEntry(200, MediaType.TV);
    assert.deepStrictEqual(
      entry?.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2, 3, 4]
    );
  });

  it('does not request when every season has been acted on', async () => {
    const user = await configureSyncUser();
    await seedEntry(user, 200, MediaType.TV, WATCHLISTED_AT, [1, 2, 3]);

    watchlistItems = [showItem(200, 'Handled Show')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls, []);
  });

  it('requests all seasons again when the show is re-added', async () => {
    const user = await configureSyncUser();
    await seedEntry(user, 200, MediaType.TV, WATCHLISTED_AT - 5000, [1, 2, 3]);

    watchlistItems = [showItem(200, 'Re-added Show')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls[0]?.seasons, [1, 2, 3]);

    const entry = await getEntry(200, MediaType.TV);
    assert.strictEqual(entry?.watchlistedAt, WATCHLISTED_AT);
    assert.deepStrictEqual(
      entry?.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2, 3]
    );
  });

  it('ignores request history when the show was re-added', async () => {
    const user = await configureSyncUser();
    await seedEntry(user, 200, MediaType.TV, WATCHLISTED_AT - 5000, [1, 2, 3]);
    await seedRequest({
      user,
      tmdbId: 200,
      mediaType: MediaType.TV,
      createdAt: WATCHLISTED_AT + 60,
      seasons: [1, 2, 3],
    });

    watchlistItems = [showItem(200, 'Re-added Show')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls[0]?.seasons, [1, 2, 3]);

    const entry = await getEntry(200, MediaType.TV);
    assert.strictEqual(entry?.watchlistedAt, WATCHLISTED_AT);
  });

  it('drops recorded seasons that no longer exist on the show', async () => {
    const user = await configureSyncUser();
    await seedEntry(user, 200, MediaType.TV, WATCHLISTED_AT - 5000, [1, 2, 3]);
    tmdbSeasons = [0, 1];

    watchlistItems = [showItem(200, 'Shrunk Show')];

    await watchlistSync.syncWatchlist();

    const entry = await getEntry(200, MediaType.TV);
    assert.deepStrictEqual(
      entry?.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1]
    );
  });

  it('records seasons that were already covered elsewhere', async () => {
    await configureSyncUser();
    requestError = new NoSeasonsAvailableError('none');

    watchlistItems = [showItem(200, 'Covered Show')];

    await watchlistSync.syncWatchlist();

    const entry = await getEntry(200, MediaType.TV);
    assert.deepStrictEqual(
      entry?.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2, 3]
    );
  });
});

describe('WatchlistSync seeding from request history', () => {
  it('records an entry instead of requesting when sync already handled it', async () => {
    const user = await configureSyncUser();
    await seedRequest({
      user,
      tmdbId: 100,
      mediaType: MediaType.MOVIE,
      createdAt: WATCHLISTED_AT + 60,
    });

    watchlistItems = [movieItem(100, 'Previously Handled')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls, []);

    const entry = await getEntry(100, MediaType.MOVIE);
    assert.strictEqual(entry?.watchlistedAt, WATCHLISTED_AT);
  });

  it('leaves a deleted title alone even when its old request predates the watchlist date', async () => {
    // Taken off the watchlist and put back while still in the library, then
    // deleted — before deletions were recorded, so no time is known.
    const user = await configureSyncUser();
    await seedRequest({
      user,
      tmdbId: 100,
      mediaType: MediaType.MOVIE,
      createdAt: WATCHLISTED_AT - 5000,
    });

    watchlistItems = [movieItem(100, 'Deleted Since')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls, []);
    assert.strictEqual(
      (await getEntry(100, MediaType.MOVIE))?.watchlistedAt,
      WATCHLISTED_AT
    );

    // Taking it off the watchlist and adding it back does bring it back.
    watchlistedAt.set('rk-100', WATCHLISTED_AT + 1000);
    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestedIds(), [`${MediaType.MOVIE}:100`]);
  });

  it('ignores manual requests when seeding', async () => {
    const user = await configureSyncUser();
    await seedRequest({
      user,
      tmdbId: 100,
      mediaType: MediaType.MOVIE,
      createdAt: WATCHLISTED_AT + 60,
      isAutoRequest: false,
    });

    watchlistItems = [movieItem(100, 'Manually Requested')];

    await watchlistSync.syncWatchlist();

    // Not settled by the manual request — by the title having been deleted.
    assert.deepStrictEqual(requestCalls, []);
    assert.ok(await getEntry(100, MediaType.MOVIE));
  });

  it('seeds handled seasons from the earlier request', async () => {
    const user = await configureSyncUser();
    await seedRequest({
      user,
      tmdbId: 200,
      mediaType: MediaType.TV,
      createdAt: WATCHLISTED_AT + 60,
      seasons: [1, 2],
    });
    // Seasons 1 and 2 have aired; season 3 is announced.
    tmdbSeasons = [0, 1, 2, 3];
    tmdbAirDates = new Map([
      [1, '2020-01-01'],
      [2, '2021-01-01'],
    ]);

    watchlistItems = [showItem(200, 'Partly Handled Show')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls[0]?.seasons, [3]);
  });
});

describe('WatchlistSync users', () => {
  it('tracks the same title separately for each user', async () => {
    const admin = await configureSyncUser(1);
    await configureSyncUser(2);
    await seedEntry(admin, 100, MediaType.MOVIE, WATCHLISTED_AT);

    watchlistItems = [movieItem(100, 'Shared Movie')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestedIds(), [`${MediaType.MOVIE}:100`]);
    assert.ok(await getEntry(100, MediaType.MOVIE, 2));
  });
});

/*
 * This fork recorded deletions before entries were tracked. The first sync
 * after upgrading finds no entries at all, so those records are what stop it
 * bringing back everything a cleanup removed.
 */
describe('WatchlistSync deletions recorded before entries', () => {
  const ADDED = WATCHLISTED_AT;
  const DELETED_AFTER = new Date((WATCHLISTED_AT + 86400) * 1000);
  const DELETED_BEFORE = new Date((WATCHLISTED_AT - 86400) * 1000);

  it('leaves a deleted film alone when it was on the watchlist before the deletion', async () => {
    const user = await configureSyncUser();
    await seedMedia(300, MediaType.MOVIE, MediaStatus.DELETED);
    await recordDeletion(300, MediaType.MOVIE, DELETED_AFTER);
    watchlistItems = [movieItem(300, 'Cleaned Up')];

    await watchlistSync.syncWatchlist();
    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls, []);
    const entry = await getEntry(300, MediaType.MOVIE, user.id);
    assert.strictEqual(entry?.watchlistedAt, ADDED, 'settled as an entry');
  });

  it('requests a film added to the watchlist after it was deleted', async () => {
    await configureSyncUser();
    await seedMedia(301, MediaType.MOVIE, MediaStatus.DELETED);
    await recordDeletion(301, MediaType.MOVIE, DELETED_BEFORE);
    watchlistItems = [movieItem(301, 'Wanted Again')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestedIds(), ['movie:301']);
  });

  it('requests a deleted film once it is re-added to the watchlist', async () => {
    await configureSyncUser();
    await seedMedia(302, MediaType.MOVIE, MediaStatus.DELETED);
    await recordDeletion(302, MediaType.MOVIE, DELETED_AFTER);
    watchlistItems = [movieItem(302, 'Re-added')];

    await watchlistSync.syncWatchlist();
    assert.deepStrictEqual(requestCalls, []);

    watchlistedAt.set('rk-302', WATCHLISTED_AT + 2 * 86400);
    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestedIds(), ['movie:302']);
  });

  it('requests only the seasons of a deleted show that aired after the deletion', async () => {
    const user = await configureSyncUser();
    await seedMedia(310, MediaType.TV, MediaStatus.DELETED);
    await recordDeletion(310, MediaType.TV, DELETED_AFTER);
    tmdbSeasons = [0, 1, 2, 3];
    tmdbAirDates = new Map([
      [1, '2020-01-01'],
      [2, '2021-01-01'],
      // Season 3 is newer than the deletion: what the requester still wants.
      [
        3,
        new Date(DELETED_AFTER.getTime() + 30 * 86400000)
          .toISOString()
          .slice(0, 10),
      ],
    ]);
    watchlistItems = [showItem(310, 'Still Airing')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls, [
      { mediaId: 310, mediaType: MediaType.TV, seasons: [3] },
    ]);
    const entry = await getEntry(310, MediaType.TV, user.id);
    assert.deepStrictEqual(
      entry?.seasons.map((s) => s.seasonNumber).sort(),
      [1, 2, 3]
    );
  });

  it('requests nothing for a deleted show with no season since, then the next new one', async () => {
    await configureSyncUser();
    await seedMedia(311, MediaType.TV, MediaStatus.DELETED);
    await recordDeletion(311, MediaType.TV, DELETED_AFTER);
    tmdbSeasons = [1, 2];
    tmdbAirDates = new Map([
      [1, '2020-01-01'],
      [2, '2021-01-01'],
    ]);
    watchlistItems = [showItem(311, 'Between Seasons')];

    await watchlistSync.syncWatchlist();
    assert.deepStrictEqual(requestCalls, []);

    // A third season is announced.
    tmdbSeasons = [1, 2, 3];
    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls, [
      { mediaId: 311, mediaType: MediaType.TV, seasons: [3] },
    ]);
  });
});

describe('WatchlistSync without a watchlisted date', () => {
  const DELETED_AT = new Date('2026-06-01T00:00:00Z');

  it('leaves a title alone once it has an entry', async () => {
    const user = await configureSyncUser();
    await seedMedia(400, MediaType.MOVIE, MediaStatus.DELETED);
    await seedEntry(user, 400, MediaType.MOVIE, WATCHLISTED_AT);
    watchlistedAt.set('rk-400', null);
    watchlistItems = [movieItem(400, 'Handled')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls, []);
  });

  it('leaves a deleted title alone when the watchlist gives no date either', async () => {
    await configureSyncUser();
    await seedMedia(401, MediaType.MOVIE, MediaStatus.DELETED);
    await recordDeletion(401, MediaType.MOVIE, DELETED_AT);
    watchlistedAt.set('rk-401', null);
    watchlistItems = [movieItem(401, 'Unknown When')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls, []);
  });

  it('falls back to the watchlist date when it is after the deletion', async () => {
    await configureSyncUser();
    await seedMedia(402, MediaType.MOVIE, MediaStatus.DELETED);
    await recordDeletion(402, MediaType.MOVIE, DELETED_AT);
    watchlistedAt.set('rk-402', null);
    watchlistItems = [
      movieItem(402, 'Added Later', new Date('2026-07-01T00:00:00Z')),
    ];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestedIds(), ['movie:402']);
  });
});

/*
 * Titles deleted before this fork recorded deletions: Seerr marks them
 * deleted, but there is no time. Each case here re-downloaded something in
 * an earlier version of this change.
 */
describe('WatchlistSync deletions with no recorded time', () => {
  const PAST = (daysAgo: number) =>
    new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

  it('does not re-request a deleted film when Plex will not say when it was added', async () => {
    const user = await configureSyncUser();
    await seedRequest({
      user,
      tmdbId: 500,
      mediaType: MediaType.MOVIE,
      createdAt: WATCHLISTED_AT - 5000,
    });
    watchlistedAt.set('rk-500', null);
    watchlistItems = [movieItem(500, 'Plex Unreachable')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls, []);
  });

  it('does not re-request a deleted show when Plex will not say when it was added', async () => {
    const user = await configureSyncUser();
    await seedRequest({
      user,
      tmdbId: 501,
      mediaType: MediaType.TV,
      createdAt: WATCHLISTED_AT - 5000,
      seasons: [1],
    });
    watchlistedAt.set('rk-501', null);
    watchlistItems = [showItem(501, 'Plex Unreachable Show')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls, []);
  });

  it('does not re-request a deleted title with only a manual request behind it', async () => {
    await configureSyncUser();
    await seedMedia(502, MediaType.MOVIE, MediaStatus.DELETED);
    watchlistedAt.set('rk-502', null);
    watchlistItems = [movieItem(502, 'Manual Only')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls, []);
  });

  it('does not re-request seasons of a deleted show that aired after its first request', async () => {
    // Requested at seasons 1–2; season 3 aired and downloaded later; then
    // the whole show was deleted.
    const user = await configureSyncUser();
    await seedRequest({
      user,
      tmdbId: 510,
      mediaType: MediaType.TV,
      createdAt: WATCHLISTED_AT + 60,
      seasons: [1, 2],
    });
    tmdbSeasons = [1, 2, 3];
    tmdbAirDates = new Map([
      [1, PAST(900)],
      [2, PAST(500)],
      [3, PAST(100)],
    ]);
    watchlistItems = [showItem(510, 'Grew After Request')];

    await watchlistSync.syncWatchlist();
    assert.deepStrictEqual(requestCalls, []);

    // Its next season is announced: that one is new, and is requested.
    tmdbSeasons = [1, 2, 3, 4];
    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls, [
      { mediaId: 510, mediaType: MediaType.TV, seasons: [4] },
    ]);
  });

  it('counts an old season TMDB lists without a date as aired', async () => {
    await configureSyncUser();
    await seedMedia(511, MediaType.TV, MediaStatus.DELETED);
    tmdbSeasons = [1, 2, 3];
    tmdbAirDates = new Map([
      [1, PAST(900)],
      // Season 2 has no date on TMDB, but season 3 after it has aired.
      [3, PAST(100)],
    ]);
    watchlistItems = [showItem(511, 'Patchy Dates')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls, []);
  });
});

describe('WatchlistSync deletions dated by the title record', () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 86400000);
  const secondsAgo = (days: number) =>
    Math.floor(daysAgo(days).getTime() / 1000);

  // When Seerr last changed the row: for a deleted title, at or after its
  // deletion.
  const deletedAgo = async (media: Media, days: number) =>
    getRepository(Media)
      .createQueryBuilder()
      .update()
      .set({ updatedAt: daysAgo(days) })
      .where('id = :id', { id: media.id })
      .execute();

  it('requests a season that premiered after an unrecorded deletion', async () => {
    const media = await seedMedia(520, MediaType.TV, MediaStatus.DELETED);
    await deletedAgo(media, 200);
    await configureSyncUser();
    watchlistedAt.set('rk-520', secondsAgo(400));
    tmdbSeasons = [1, 2, 3];
    tmdbAirDates = new Map([
      [1, daysAgo(900).toISOString().slice(0, 10)],
      [2, daysAgo(500).toISOString().slice(0, 10)],
      [3, daysAgo(100).toISOString().slice(0, 10)],
    ]);
    watchlistItems = [showItem(520, 'Came Back Since')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls, [
      { mediaId: 520, mediaType: MediaType.TV, seasons: [3] },
    ]);
  });

  it('requests a title first added to a watchlist after an unrecorded deletion', async () => {
    const media = await seedMedia(521, MediaType.MOVIE, MediaStatus.DELETED);
    await deletedAgo(media, 200);
    await configureSyncUser();
    watchlistedAt.set('rk-521', secondsAgo(10));
    watchlistItems = [movieItem(521, 'Wanted Now')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestedIds(), [`${MediaType.MOVIE}:521`]);
  });

  it('leaves it alone when it was on the watchlist before that', async () => {
    const media = await seedMedia(522, MediaType.MOVIE, MediaStatus.DELETED);
    await deletedAgo(media, 200);
    await configureSyncUser();
    watchlistedAt.set('rk-522', secondsAgo(300));
    watchlistItems = [movieItem(522, 'Stale Entry')];

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(requestCalls, []);
  });
});

describe('WatchlistSync with an expired Plex sign-in', () => {
  it('asks Plex once an hour, not on every sync, until they sign in again', async (t) => {
    t.after(() => {
      watchlistAuthFailed = false;
      mock.timers.reset();
    });
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const user = await configureSyncUser();
    await getRepository(User).update(user.id, {
      plexTokenExpiredAt: new Date(),
    });
    watchlistAuthFailed = true;
    watchlistCalls = 0;

    await watchlistSync.syncWatchlist();
    await watchlistSync.syncWatchlist();
    await watchlistSync.syncWatchlist();
    assert.equal(watchlistCalls, 1);

    mock.timers.tick(EXPIRED_RETRY_MS);
    await watchlistSync.syncWatchlist();
    assert.equal(watchlistCalls, 2);

    // Signed in again: synced every time.
    await getRepository(User).update(user.id, { plexTokenExpiredAt: null });
    watchlistAuthFailed = false;
    await watchlistSync.syncWatchlist();
    await watchlistSync.syncWatchlist();
    assert.equal(watchlistCalls, 4);
  });
});
