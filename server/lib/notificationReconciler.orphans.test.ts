import TheMovieDb from '@server/api/themoviedb';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import NotificationDelivery from '@server/entity/NotificationDelivery';
import { User } from '@server/entity/User';
import notificationReconciler from '@server/lib/notificationReconciler';
import notificationManager, { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/*
 * A failed request whose title is gone — as the live health page found — must
 * be passed over, not retried on every reconcile pass. It used to be claimed,
 * fail to send for want of a title, be released, and log two errors, every
 * few minutes, for as long as it existed.
 */

setupTestDb();

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async () => ({ id: 1, title: 'M', overview: '' });
  },
});

let sent: number[] = [];
Object.defineProperty(notificationManager, 'sendNotification', {
  configurable: true,
  value: (type: number) => sent.push(type),
});

const logged: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = logger[level].bind(logger);
  (logger as unknown as Record<string, unknown>)[level] = (
    message: string,
    ...rest: unknown[]
  ) => {
    logged.push(message);
    return original(message, ...rest);
  };
}

let user: User;

beforeEach(async () => {
  sent = [];
  logged.length = 0;
  user = await getRepository(User).save(
    new User({
      email: 'orphan@test.local',
      plexUsername: 'orphan',
      permissions: Permission.REQUEST,
      avatar: '',
    })
  );
});

describe('a failed request with no title', () => {
  it('is passed over, pass after pass, without churn or errors', async () => {
    const inserted = await getRepository(MediaRequest)
      .createQueryBuilder()
      .insert()
      .values({
        status: MediaRequestStatus.FAILED,
        type: MediaType.MOVIE,
        is4k: false,
        requestedBy: user,
      })
      .execute();
    const id = inserted.identifiers[0].id as number;

    for (let pass = 0; pass < 3; pass++) {
      await notificationReconciler.run();
    }

    assert.deepEqual(
      sent.filter((type) => type === Notification.MEDIA_FAILED),
      [],
      'nothing to send without a title'
    );
    assert.deepEqual(
      logged.filter((m) => /notification|claim/i.test(m)),
      [],
      'no error or claim churn logged'
    );
    assert.equal(
      await getRepository(NotificationDelivery).countBy({ requestId: id }),
      0
    );
  });
});
