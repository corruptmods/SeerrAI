import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import WebhookAgent, { KeyMap } from '@server/lib/notifications/agents/webhook';
import notificationHttp from '@server/lib/notifications/http';
import type { NotificationAgentWebhook } from '@server/lib/settings';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
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

describe('webhook templates', () => {
  /** Sends one notification and returns the address and body posted. */
  const send = async (
    t: TestContext,
    {
      url = 'https://hook.test/',
      template = {},
      payload = {},
      type = Notification.MEDIA_AVAILABLE,
    }: {
      url?: string;
      template?: Record<string, unknown>;
      payload?: Partial<NotificationPayload>;
      type?: Notification;
    }
  ) => {
    const posted: { url: string; body: unknown }[] = [];
    t.mock.method(
      notificationHttp,
      'post',
      async (postedUrl: string, body: unknown) => {
        posted.push({ url: postedUrl, body });
        return { data: {} };
      }
    );
    const agent = new WebhookAgent({
      enabled: true,
      types: Notification.MEDIA_AVAILABLE | Notification.TEST_NOTIFICATION,
      options: {
        webhookUrl: url,
        jsonPayload: Buffer.from(
          JSON.stringify(JSON.stringify(template))
        ).toString('base64'),
        supportVariables: true,
      },
    } as NotificationAgentWebhook);
    assert.equal(
      await agent.send(type, {
        notifySystem: true,
        subject: '',
        ...payload,
      } as NotificationPayload),
      true
    );
    assert.equal(posted.length, 1);
    return posted[0];
  };

  it('puts values in as they are, however they are written', async (t) => {
    const { body } = await send(t, {
      template: {
        subject: '{{subject}}',
        message: '{{message}}',
      },
      payload: {
        subject: "Costs $5 $& $$ $` $' less",
        message: 'Typed in an issue: {{subject}} {{media_tmdbid}}',
        media: { tmdbId: 42 } as Media,
      },
    });
    assert.deepEqual(body, {
      subject: "Costs $5 $& $$ $` $' less",
      message: 'Typed in an issue: {{subject}} {{media_tmdbid}}',
    });
  });

  it('fills every copy of a variable', async (t) => {
    const { body } = await send(t, {
      template: { text: '{{subject}} and {{subject}}, {{unknown_key}}' },
      payload: { subject: 'Dune' },
    });
    assert.deepEqual(body, { text: 'Dune and Dune, {{unknown_key}}' });
  });

  it("fills the address with a value of 0, and nothing for one it hasn't", async (t) => {
    const { url } = await send(t, {
      url: 'https://hook.test/{{media_tmdbid}}/{{media_type}}?tvdb={{media_tvdbid}}&s={{subject}}',
      payload: {
        subject: 'a/b {{media_type}}',
        media: { tmdbId: 0, mediaType: 'music' } as unknown as Media,
      },
    });
    assert.equal(
      url,
      'https://hook.test/0/music?tvdb=&s=a%2Fb%20%7B%7Bmedia_type%7D%7D'
    );
  });

  it('fills the address with "test" for the test notification', async (t) => {
    const { url } = await send(t, {
      url: 'https://hook.test/{{media_tmdbid}}',
      type: Notification.TEST_NOTIFICATION,
    });
    assert.equal(url, 'https://hook.test/test');
  });
});
