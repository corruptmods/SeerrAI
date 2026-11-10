import type { PushoverPriority } from '@server/constants/pushover';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import { initI18n } from '@server/i18n';
import { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import PushoverAgent from '@server/lib/notifications/agents/pushover';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

const request: NotificationPayload = {
  subject: 'Static Garden (2024)',
  notifySystem: true,
  request: {
    id: 7,
    requestedBy: { displayName: 'Someone' } as User,
  } as MediaRequest,
};

const priorityOf = async (
  type: Notification,
  priority?: PushoverPriority
): Promise<number> => {
  const agent = new PushoverAgent({
    enabled: true,
    embedPoster: false,
    types: type,
    options: { accessToken: 'a', userToken: 'u', sound: '', priority },
  });
  const payload = await (
    agent as unknown as {
      getNotificationPayload: (
        type: Notification,
        payload: NotificationPayload
      ) => Promise<{ priority: number }>;
    }
  ).getNotificationPayload(type, request);
  return payload.priority;
};

before(() => {
  initI18n();
});

describe('Pushover priority', () => {
  it('is high for problems and normal otherwise, unless set', async () => {
    assert.equal(await priorityOf(Notification.MEDIA_DECLINED), 1);
    assert.equal(await priorityOf(Notification.MEDIA_PENDING), 0);
  });

  it('applies the one chosen to everything', async () => {
    assert.equal(await priorityOf(Notification.MEDIA_DECLINED, 'normal'), 0);
    assert.equal(await priorityOf(Notification.MEDIA_FAILED, 'low'), -1);
    assert.equal(await priorityOf(Notification.MEDIA_AVAILABLE, 'high'), 1);
  });
});
