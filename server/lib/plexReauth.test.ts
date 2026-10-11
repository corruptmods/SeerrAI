import PlexTvAPI from '@server/api/plextv';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import notificationManager, { Notification } from '@server/lib/notifications';
import { wantsWebPush } from '@server/lib/notifications/agents/webpush';
import { Permission } from '@server/lib/permissions';
import { NotificationAgentKey } from '@server/lib/settings';
import watchlistSync from '@server/lib/watchlistsync';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/**
 * A user whose Plex token is rejected stops syncing their watchlist, and
 * nothing told them. On the live instance one user had been silently offline
 * for days. They should be told once, and the flag should clear as soon as
 * Plex accepts them again.
 */

let rejected = false;
/** Plex down (a 503, a timeout): neither accepted nor rejected. */
let unavailable = false;

Object.defineProperty(PlexTvAPI.prototype, 'getWatchlist', {
  get() {
    return async () => ({
      offset: 0,
      size: 20,
      totalSize: 0,
      items: [],
      authFailed: rejected,
      failed: unavailable,
    });
  },
  set() {},
  configurable: true,
});

let requestCalls = 0;

Object.defineProperty(MediaRequest, 'request', {
  value: async () => {
    requestCalls++;
    return {} as MediaRequest;
  },
  writable: true,
  configurable: true,
});

let sent: Notification[] = [];

Object.defineProperty(notificationManager, 'sendNotification', {
  value: (type: Notification) => {
    sent.push(type);
  },
  writable: true,
  configurable: true,
});

const reauthNotices = () =>
  sent.filter((type) => type === Notification.PLEX_REAUTH);

setupTestDb();

async function configureSyncUser(): Promise<User> {
  const userRepository = getRepository(User);
  const admin = await userRepository.findOneOrFail({ where: { id: 1 } });

  admin.plexToken = 'test-plex-token';
  admin.permissions = Permission.AUTO_REQUEST;
  await userRepository.save(admin);

  await getRepository(UserSettings).save(
    new UserSettings({
      user: admin,
      watchlistSyncMovies: true,
      watchlistSyncTv: true,
    })
  );

  return admin;
}

const flagOf = async (id: number) =>
  (await getRepository(User).findOneOrFail({ where: { id } }))
    .plexTokenExpiredAt;

describe('expired Plex sign-in', () => {
  beforeEach(() => {
    rejected = false;
    unavailable = false;
    requestCalls = 0;
    sent = [];
  });

  it('flags the user and notifies them once, however many syncs follow', async () => {
    const user = await configureSyncUser();
    rejected = true;

    await watchlistSync.syncWatchlist();
    await watchlistSync.syncWatchlist();
    await watchlistSync.syncWatchlist();

    assert.ok(await flagOf(user.id), 'the rejection is recorded');
    assert.equal(
      reauthNotices().length,
      1,
      'one notice, not one every three minutes'
    );
    assert.equal(requestCalls, 0, 'nothing is requested on a broken token');
  });

  it('clears the flag once Plex accepts the token again', async () => {
    const user = await configureSyncUser();

    rejected = true;
    await watchlistSync.syncWatchlist();
    rejected = false;
    await watchlistSync.syncWatchlist();

    assert.equal(await flagOf(user.id), null);
  });

  it('notifies again if the token breaks a second time', async () => {
    await configureSyncUser();

    rejected = true;
    await watchlistSync.syncWatchlist();
    rejected = false;
    await watchlistSync.syncWatchlist();
    rejected = true;
    await watchlistSync.syncWatchlist();

    assert.equal(reauthNotices().length, 2);
  });

  it('does not notify again because Plex was down between two rejections', async () => {
    const user = await configureSyncUser();

    rejected = true;
    await watchlistSync.syncWatchlist();
    rejected = false;
    unavailable = true;
    await watchlistSync.syncWatchlist();
    assert.ok(await flagOf(user.id), 'an outage says nothing about the token');
    unavailable = false;
    rejected = true;
    await watchlistSync.syncWatchlist();

    assert.equal(reauthNotices().length, 1);
  });

  it('never flags a user whose token Plex accepts', async () => {
    const user = await configureSyncUser();

    await watchlistSync.syncWatchlist();

    assert.equal(await flagOf(user.id), null);
    assert.deepEqual(reauthNotices(), []);
  });
});

describe('the sign-in notice cannot be switched off', () => {
  it('is sent even to a user who turned every push type off', () => {
    const user = new User({ id: 7 } as never);
    user.settings = new UserSettings({
      notificationTypes: { [NotificationAgentKey.WEBPUSH]: 0 },
    } as never);

    // A deliberate empty mask would otherwise block everything.
    const onlyAvailable = new User({ id: 8 } as never);
    onlyAvailable.settings = new UserSettings({
      notificationTypes: {
        [NotificationAgentKey.WEBPUSH]: Notification.MEDIA_AVAILABLE,
      },
    } as never);

    assert.equal(wantsWebPush(user, Notification.PLEX_REAUTH), true);
    assert.equal(wantsWebPush(onlyAvailable, Notification.PLEX_REAUTH), true);
    assert.equal(
      wantsWebPush(onlyAvailable, Notification.LIST_ACTIVITY),
      false,
      'other types still respect the user’s choice'
    );
  });
});
