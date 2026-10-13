import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { MediaRequestWatcher } from '@server/entity/MediaRequestWatcher';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import notificationReconciler from '@server/lib/notificationReconciler';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import { Permission } from '@server/lib/permissions';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/*
 * What the reconciler sends when it is the path that catches a missed
 * notification: the requester's own copy with their own settings, and each
 * watcher a copy of their own that leaves the request as it is.
 */

setupTestDb();

let sent: { type: Notification; payload: NotificationPayload }[] = [];
Object.defineProperty(notificationManager, 'sendNotification', {
  configurable: true,
  value: (type: Notification, payload: NotificationPayload) => {
    sent.push({ type, payload });
  },
});
Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async ({ movieId }: { movieId: number }) => ({
      id: movieId,
      title: 'Film',
      overview: '',
      release_date: '2020-01-01',
    });
  },
});

const makeUser = async (name: string) => {
  const user = new User({
    email: `${name}@test.local`,
    plexUsername: name,
    permissions: Permission.REQUEST,
    avatar: '',
  });
  user.settings = new UserSettings({ pgpKey: `${name}-key` });
  await getRepository(User).save(user);
  return getRepository(User).findOneOrFail({ where: { plexUsername: name } });
};

let requester: User;
let watcher: User;

/** A movie request moved to the given status without the save hooks. */
const requestIn = async (
  tmdbId: number,
  status: MediaRequestStatus,
  mediaStatus: MediaStatus
) => {
  const media = await getRepository(Media).save(
    new Media({ tmdbId, mediaType: MediaType.MOVIE, status: mediaStatus })
  );
  const request = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MOVIE,
      media,
      requestedBy: requester,
      status: MediaRequestStatus.PENDING,
      is4k: false,
    })
  );
  await getRepository(MediaRequest).update(request.id, { status });
  return request;
};

const ofType = (type: Notification) =>
  sent.filter((s) => s.type === type).map((s) => s.payload);

beforeEach(async () => {
  requester = await makeUser('reconcile-requester');
  watcher = await makeUser('reconcile-watcher');
  sent = [];
});

describe('notifications the reconciler catches up on', () => {
  it('reach the requester with their own settings, so email keeps to their PGP key', async () => {
    await requestIn(9301, MediaRequestStatus.FAILED, MediaStatus.PROCESSING);
    sent = [];

    await notificationReconciler.run();

    const failed = ofType(Notification.MEDIA_FAILED);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].notifyUser?.id, requester.id);
    assert.equal(
      failed[0].notifyUser?.settings?.pgpKey,
      'reconcile-requester-key'
    );
  });

  it('give each watcher one copy of their own, even when the requester muted it', async () => {
    const request = await requestIn(
      9302,
      MediaRequestStatus.COMPLETED,
      MediaStatus.AVAILABLE
    );
    await getRepository(MediaRequest).update(request.id, {
      requesterMuted: true,
    });
    await getRepository(MediaRequestWatcher).save(
      new MediaRequestWatcher({ requestId: request.id, userId: watcher.id })
    );
    sent = [];

    await notificationReconciler.run();

    const available = ofType(Notification.MEDIA_AVAILABLE);
    assert.equal(
      available.filter((p) => p.notifySystem).length,
      1,
      'the channels hear once'
    );
    const forWatcher = available.filter((p) => p.notifyUser?.id === watcher.id);
    assert.equal(forWatcher.length, 1, 'the watcher hears once');
    assert.equal(forWatcher[0].notifySystem, false);
    assert.equal(forWatcher[0].notifyAdmin, false);
    assert.equal(
      forWatcher[0].request?.requestedBy.id,
      requester.id,
      'still requested by the requester'
    );
    assert.equal(
      available.filter((p) => p.notifyUser?.id === requester.id).length,
      0,
      'the requester muted it'
    );
  });
});
