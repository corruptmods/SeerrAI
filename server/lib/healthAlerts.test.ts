import type { HealthCheck } from '@server/lib/health';
import healthAlerts, {
  problemsIn,
  RUNS_BEFORE_TELLING,
} from '@server/lib/healthAlerts';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * Admins hear when a connected service newly has a problem: once it has
 * been seen twice in a row, once only, and again only after it has cleared.
 */

const service = (over: Partial<HealthCheck>): HealthCheck => ({
  id: 'bazarr',
  group: 'services',
  name: 'Bazarr',
  reachable: true,
  status: 'ok',
  count: 0,
  items: [],
  ...over,
});

const whisperPaused = service({
  status: 'warning',
  count: 1,
  items: [
    {
      title: 'whisperai is paused',
      detail: 'after an error (ReadTimeout) · tries again in 41 minutes',
    },
  ],
});
const prowlarrDown: HealthCheck = {
  id: 'prowlarr',
  group: 'services',
  name: 'Prowlarr',
  status: 'error',
  count: 1,
  detail: 'connect ECONNREFUSED',
  items: [],
};

let sent: [Notification, NotificationPayload][] = [];

beforeEach(() => {
  healthAlerts.reset();
  sent = [];
  mock.method(
    notificationManager,
    'sendNotification',
    (type: Notification, payload: NotificationPayload) => {
      sent.push([type, payload]);
    }
  );
});
afterEach(() => mock.restoreAll());

describe('health alerts', () => {
  it('reads each thing wrong as a problem, and a service down as one', () => {
    assert.deepEqual(
      problemsIn([service({}), whisperPaused, prowlarrDown]).map((p) => [
        p.key,
        p.service,
        p.title,
      ]),
      [
        ['bazarr:whisperai is paused', 'Bazarr', 'whisperai is paused'],
        ['prowlarr:down', 'Prowlarr', 'Not answering'],
      ]
    );
  });

  it('tells admins once a problem has stayed, and only once', () => {
    const problems = problemsIn([whisperPaused]);
    for (let run = 1; run < RUNS_BEFORE_TELLING; run++) {
      assert.deepEqual(healthAlerts.consider(problems), []);
    }
    assert.equal(healthAlerts.consider(problems).length, 1);
    assert.equal(sent.length, 1);
    const [type, payload] = sent[0];
    assert.equal(type, Notification.HEALTH);
    assert.equal(payload.subject, 'Bazarr: whisperai is paused');
    assert.match(payload.message!, /ReadTimeout/);
    assert.equal(payload.actionUrl, '/settings/health');
    assert.equal(payload.notifyAdmin, true);

    healthAlerts.consider(problems);
    healthAlerts.consider(problems);
    assert.equal(sent.length, 1, 'not told again while it lasts');
  });

  it('says nothing of a moment’s blip, and tells again after it clears', () => {
    const problems = problemsIn([prowlarrDown]);
    healthAlerts.consider(problems);
    healthAlerts.consider([]);
    healthAlerts.consider(problems);
    assert.equal(sent.length, 0, 'seen once, then gone: a blip');

    healthAlerts.consider(problems);
    assert.equal(sent.length, 1);
    healthAlerts.consider([]);
    healthAlerts.consider(problems);
    healthAlerts.consider(problems);
    assert.equal(sent.length, 2, 'back after clearing: told again');
  });

  it('gathers what went wrong together into one', () => {
    const problems = problemsIn([whisperPaused, prowlarrDown]);
    healthAlerts.consider(problems);
    healthAlerts.consider(problems);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][1].subject, '2 new problems');
    assert.deepEqual(sent[0][1].message!.split('\n'), [
      'Bazarr: whisperai is paused (after an error (ReadTimeout) · tries again in 41 minutes)',
      'Prowlarr: Not answering (connect ECONNREFUSED)',
    ]);
  });
});
