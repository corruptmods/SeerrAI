import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import { KeyMap } from '@server/lib/notifications/agents/webhook';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The webhook's media server variables. The Jellyfin ones carried an Emby
 * server's ids before Emby had columns of its own, and still do.
 */

const value = (key: string, payload: Partial<NotificationPayload>) => {
  const entry = KeyMap[key];
  assert.equal(typeof entry, 'function', key);
  return (entry as (p: NotificationPayload, t: Notification) => string)(
    payload as NotificationPayload,
    Notification.MEDIA_AVAILABLE
  );
};

const withMedia = (media: Partial<Media>) => ({ media: media as Media });
const requestedBy = (user: Record<string, string | null>) => ({
  request: { requestedBy: user } as unknown as MediaRequest,
});

describe('webhook media server variables', () => {
  it("give a Jellyfin server's ids as before", () => {
    assert.equal(
      value('media_jellyfinMediaId', withMedia({ jellyfinMediaId: 'jf-1' })),
      'jf-1'
    );
    assert.equal(
      value(
        'media_jellyfinMediaId',
        withMedia({ jellyfinMediaId: null, jellyfinMediaId4k: 'jf-4k' })
      ),
      'jf-4k'
    );
    assert.equal(
      value('requestedBy_jellyfinUserId', requestedBy({ jellyfinUserId: 'u' })),
      'u'
    );
    assert.equal(value('media_embyMediaId', withMedia({})), '');
  });

  it("give an Emby server's ids in the Jellyfin variables too", () => {
    const media = withMedia({
      jellyfinMediaId: null,
      jellyfinMediaId4k: null,
      embyMediaId: 'em-1',
    });
    assert.equal(value('media_jellyfinMediaId', media), 'em-1');
    assert.equal(value('media_embyMediaId', media), 'em-1');
    assert.equal(
      value('media_embyMediaId', withMedia({ embyMediaId4k: 'em-4k' })),
      'em-4k'
    );

    const user = requestedBy({ jellyfinUserId: null, embyUserId: 'emby-user' });
    assert.equal(value('requestedBy_jellyfinUserId', user), 'emby-user');
    assert.equal(value('requestedBy_embyUserId', user), 'emby-user');
  });

  it('are empty without a title or a requester', () => {
    for (const key of [
      'media_jellyfinMediaId',
      'media_embyMediaId',
      'requestedBy_jellyfinUserId',
      'requestedBy_embyUserId',
    ]) {
      assert.equal(value(key, {}), '', key);
    }
  });
});
