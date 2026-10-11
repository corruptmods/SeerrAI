import type { User } from '@server/entity/User';
import notificationManager, { Notification } from '@server/lib/notifications';
import type {
  NotificationAgent,
  NotificationPayload,
} from '@server/lib/notifications/agents/agent';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/*
 * A burst of notifications to one person goes out as one: what was sent,
 * to whom, and when.
 */

let sent: { type: Notification; payload: NotificationPayload }[] = [];
const agent: NotificationAgent = {
  shouldSend: () => true,
  send: async (type, payload) => {
    sent.push({ type, payload });
    return true;
  },
};
notificationManager.registerAgents([agent]);

const person = (id: number) => ({ id, displayName: `P${id}` }) as User;
const available = (title: string, who = person(1)): NotificationPayload => ({
  subject: title,
  notifyUser: who,
  notifySystem: true,
  notifyAdmin: true,
  image: `https://img/${title}.jpg`,
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const toUser = () =>
  sent.filter((s) => !s.payload.holdUser && s.payload.notifyUser);

beforeEach(() => {
  sent = [];
  notificationManager.gathering = { quietMs: 60, longestMs: 400 };
});

describe('notifications sent close together', () => {
  it('tells the person once about a burst, and admins and channels at once', async () => {
    for (const title of ['Dune (2021)', 'Up (2009)', 'Heat (1995)']) {
      notificationManager.sendNotification(
        Notification.MEDIA_AVAILABLE,
        available(title)
      );
    }
    assert.equal(sent.length, 3, 'the admin and channel copies, straight away');
    assert.ok(sent.every((s) => s.payload.holdUser && s.payload.notifySystem));
    assert.deepEqual(toUser(), []);

    await wait(120);
    const [digest] = toUser();
    assert.equal(toUser().length, 1);
    assert.equal(digest.type, Notification.MEDIA_AVAILABLE);
    assert.deepEqual(
      {
        subject: digest.payload.subject,
        message: digest.payload.message,
        digest: digest.payload.digest,
        system: digest.payload.notifySystem,
        admin: digest.payload.notifyAdmin,
        image: digest.payload.image,
        actionUrl: digest.payload.actionUrl,
      },
      {
        subject: '3 titles are ready to watch',
        message: 'Dune (2021), Up (2009), Heat (1995).',
        digest: true,
        system: false,
        admin: false,
        image: 'https://img/Dune (2021).jpg',
        actionUrl: '/requests',
      }
    );
  });

  it('sends one on its own as it was, only a moment later', async () => {
    notificationManager.sendNotification(
      Notification.MEDIA_AVAILABLE,
      available('Dune (2021)')
    );
    await wait(120);
    const [own] = toUser();
    assert.equal(toUser().length, 1);
    assert.equal(own.payload.subject, 'Dune (2021)');
    assert.equal(own.payload.digest, undefined);
    assert.equal(own.payload.notifyAdmin, false, 'admins were told already');
  });

  it('keeps people, and kinds of notification, apart', async () => {
    notificationManager.sendNotification(
      Notification.MEDIA_AVAILABLE,
      available('A (2001)', person(1))
    );
    notificationManager.sendNotification(
      Notification.MEDIA_AVAILABLE,
      available('B (2002)', person(2))
    );
    notificationManager.sendNotification(
      Notification.MEDIA_APPROVED,
      available('C (2003)', person(1))
    );
    await wait(120);
    assert.deepEqual(
      toUser()
        .map(
          (s) => `${s.type}:${s.payload.notifyUser?.id}:${s.payload.subject}`
        )
        .sort(),
      [
        `${Notification.MEDIA_APPROVED}:1:C (2003)`,
        `${Notification.MEDIA_AVAILABLE}:1:A (2001)`,
        `${Notification.MEDIA_AVAILABLE}:2:B (2002)`,
      ]
    );
  });

  it('never holds a steady trickle back longer than the limit', async () => {
    notificationManager.gathering = { quietMs: 80, longestMs: 200 };
    const started = Date.now();
    for (let i = 0; i < 8; i++) {
      notificationManager.sendNotification(
        Notification.MEDIA_AVAILABLE,
        available(`T${i}`)
      );
      await wait(50);
    }
    const first = toUser()[0];
    assert.ok(first, 'sent before the trickle ended');
    assert.ok(Date.now() - started < 600);
    await wait(150);
    const total = toUser().reduce(
      (n, s) =>
        n + (s.payload.digest ? Number(s.payload.subject.split(' ')[0]) : 1),
      0
    );
    assert.equal(total, 8, 'every title told, once');
  });

  it('tells about the same title once, however often it came up', async () => {
    for (const title of [
      'Dune (2021)',
      'Dune (2021)',
      'Up (2009)',
      'Up (2009)',
    ]) {
      notificationManager.sendNotification(
        Notification.MEDIA_AVAILABLE,
        available(title)
      );
    }
    await wait(120);
    assert.equal(toUser()[0].payload.subject, '2 titles are ready to watch');

    sent = [];
    notificationManager.sendNotification(
      Notification.MEDIA_AVAILABLE,
      available('Heat (1995)')
    );
    notificationManager.sendNotification(
      Notification.MEDIA_AVAILABLE,
      available('Heat (1995)')
    );
    await wait(120);
    assert.equal(toUser().length, 1);
    assert.equal(toUser()[0].payload.subject, 'Heat (1995)');
  });

  it('names a few and counts the rest', async () => {
    for (let i = 1; i <= 9; i++) {
      notificationManager.sendNotification(
        Notification.MEDIA_AVAILABLE,
        available(`T${i}`)
      );
    }
    await wait(120);
    assert.equal(
      toUser()[0].payload.message,
      'T1, T2, T3, T4, T5, T6, and 3 more.'
    );
  });

  it('sends issue notifications and the like at once, as before', () => {
    notificationManager.sendNotification(Notification.ISSUE_CREATED, {
      subject: 'Broken',
      notifyUser: person(1),
      notifySystem: true,
      notifyAdmin: true,
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.holdUser, undefined);
  });

  it('sends what it is holding at once when the server stops', () => {
    notificationManager.gathering = { quietMs: 60_000, longestMs: 60_000 };
    notificationManager.sendNotification(
      Notification.MEDIA_AVAILABLE,
      available('Dune (2021)')
    );
    notificationManager.flush();
    assert.equal(toUser().length, 1);
  });
});
