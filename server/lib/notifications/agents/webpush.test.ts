import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Notification } from '@server/lib/notifications';
import WebPushAgent from '@server/lib/notifications/agents/webpush';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

describe('web push', () => {
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
});
