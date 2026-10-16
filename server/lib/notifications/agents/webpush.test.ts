import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { UserPushSubscription } from '@server/entity/UserPushSubscription';
import { initI18n } from '@server/i18n';
import { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import WebPushAgent from '@server/lib/notifications/agents/webpush';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import webpush from 'web-push';

setupTestDb();

describe('web push', () => {
  before(() => initI18n());

  it('does not read every pending request to send a notification', async (t) => {
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    const requests = getRepository(MediaRequest);
    const find = t.mock.method(requests, 'find');

    const sent = await new WebPushAgent().send(Notification.MEDIA_AVAILABLE, {
      subject: 'Film (2020)',
      notifyUser: user,
      notifySystem: false,
      notifyAdmin: false,
    });

    assert.equal(sent, true);
    // Counted rather than compared: each recorded call holds the repository,
    // and printing that in a failure message runs out of memory.
    assert.equal(
      find.mock.calls.filter(
        (call) =>
          (call.arguments[0]?.where as { status?: MediaRequestStatus })
            ?.status === MediaRequestStatus.PENDING
      ).length,
      0,
      'pending requests read'
    );
  });

  it('posts only to browser push services, and forgets any other address', async (t) => {
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    const subs = getRepository(UserPushSubscription);
    // One saved before addresses were checked when a device signed up.
    await subs.save([
      new UserPushSubscription({
        user,
        endpoint: 'https://fcm.googleapis.com/fcm/send/phone',
        p256dh: 'key',
        auth: 'auth',
      }),
      new UserPushSubscription({
        user,
        endpoint: 'http://192.168.1.10:8123/api/hook',
        p256dh: 'key',
        auth: 'auth',
      }),
    ]);
    t.mock.method(webpush, 'setVapidDetails', () => undefined);
    const posted = t.mock.method(webpush, 'sendNotification', async () => ({
      statusCode: 201,
      body: '',
      headers: {},
    }));

    await new WebPushAgent().send(Notification.MEDIA_AVAILABLE, {
      subject: 'Film (2020)',
      notifyUser: user,
      notifySystem: false,
      notifyAdmin: false,
    });

    assert.deepEqual(
      posted.mock.calls.map(
        (call) => (call.arguments[0] as { endpoint: string }).endpoint
      ),
      ['https://fcm.googleapis.com/fcm/send/phone']
    );
    assert.deepEqual(
      (await subs.find()).map((sub) => sub.endpoint),
      ['https://fcm.googleapis.com/fcm/send/phone']
    );
  });
});

/** The payload a device is sent, as the agent builds it. */
const payloadFor = (type: Notification, subject: string) =>
  new WebPushAgent()['getNotificationPayload'](type, {
    subject,
    notifySystem: true,
    notifyAdmin: true,
  } as NotificationPayload);

describe('web push payload', () => {
  before(() => initI18n());

  it('carries the words for approving and declining from the notification', () => {
    const appName = getSettings().main.applicationTitle;

    assert.deepEqual(
      payloadFor(Notification.MEDIA_PENDING, 'Dune').actionLabels,
      {
        approve: 'Approve',
        decline: 'Decline',
        approveFailed: 'Could not approve',
        declineFailed: 'Could not decline',
        failedBody: `Dune — open ${appName} to try again.`,
      }
    );
  });

  it('carries none where there is nothing to approve', () => {
    assert.equal(
      payloadFor(Notification.MEDIA_AVAILABLE, 'Dune').actionLabels,
      undefined
    );
  });
});
