import { MediaType } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import { getIntl, initI18n } from '@server/i18n';
import globalMessages from '@server/i18n/globalMessages';
import { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import DiscordAgent from '@server/lib/notifications/agents/discord';
import EmailAgent from '@server/lib/notifications/agents/email';
import GotifyAgent from '@server/lib/notifications/agents/gotify';
import NtfyAgent from '@server/lib/notifications/agents/ntfy';
import PushbulletAgent from '@server/lib/notifications/agents/pushbullet';
import PushoverAgent from '@server/lib/notifications/agents/pushover';
import SlackAgent from '@server/lib/notifications/agents/slack';
import WebhookAgent from '@server/lib/notifications/agents/webhook';
import WebPushAgent from '@server/lib/notifications/agents/webpush';
import type { NotificationAgentWebhook } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import Email from 'email-templates';
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/*
 * The reason a request was declined, in the "declined" notification on each
 * channel: labelled in the channel's language, and shown as the words typed,
 * never as markup, whatever characters they hold.
 */

const REASON =
  'Already on *Netflix* & <b>Prime</b> [here](https://e.vil) @everyone _a_ \\ #1 > `x` ~y~ |z|';

const label = (locale?: 'de') =>
  getIntl(locale).formatMessage(globalMessages.declineReason);

const declined = (
  declineReason: string | null = REASON,
  overrides: Partial<NotificationPayload> = {}
): NotificationPayload => ({
  event: 'Request Declined',
  subject: 'Film (2020)',
  message: 'A film.',
  notifySystem: true,
  notifyAdmin: false,
  media: {
    id: 1,
    mediaType: MediaType.MOVIE,
    tmdbId: 603,
  } as Media,
  request: {
    id: 7,
    is4k: false,
    requestedBy: { displayName: 'Friend' },
    declineReason,
  } as unknown as MediaRequest,
  ...overrides,
});

/** Undoes markdown's backslash escapes, as a markdown reader does. */
const unescapeMarkdown = (text: string) => text.replace(/\\(.)/g, '$1');

/** Every ASCII punctuation mark in the text is escaped. */
const assertMarkdownEscaped = (text: string) => {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    assert.ok(
      !/[!-/:-@[-`{-~]/.test(text[i]),
      `unescaped "${text[i]}" at ${i} in: ${text}`
    );
  }
};

describe('the reason in a declined notification', () => {
  const main = getSettings().main;
  const saved = { ...main };

  before(() => {
    initI18n();
    main.applicationUrl = 'https://seerr.example';
    main.applicationTitle = 'Seerr AI';
  });

  after(() => {
    Object.assign(main, saved);
  });

  it('is a field of its own on Discord, escaped, in the language used', () => {
    const embed = new DiscordAgent().buildEmbed(
      Notification.MEDIA_DECLINED,
      declined(),
      'de'
    );
    const field = embed.fields?.find((f) => f.name === label('de'));

    assert.ok(field, JSON.stringify(embed.fields));
    assert.ok(
      embed.fields?.some((f) => f.name === 'Anfragestatus'),
      'the rest of the embed is in German'
    );
    assertMarkdownEscaped(field.value);
    assert.equal(unescapeMarkdown(field.value), REASON);
    assert.equal(field.inline, false);
  });

  it('is plain text on Slack, so nothing in it is formatted', () => {
    const embed = new SlackAgent().buildEmbed(
      Notification.MEDIA_DECLINED,
      declined()
    );
    const block = embed.blocks.find(
      (b) => b.text?.type === 'plain_text' && b.text.text.includes('Netflix')
    );

    assert.ok(block, JSON.stringify(embed.blocks));
    assert.equal(block.text?.text, `${label()}\n${REASON}`);
    assert.equal(block.text?.emoji, false);
  });

  it('is escaped markdown on Gotify and ntfy', () => {
    const gotify = new GotifyAgent()['getNotificationPayload'](
      Notification.MEDIA_DECLINED,
      declined()
    );
    const ntfy = new NtfyAgent()['buildPayload'](
      Notification.MEDIA_DECLINED,
      declined()
    ) as { message: string };

    for (const message of [gotify.message, ntfy.message]) {
      const line = message
        .split('\n')
        .find((l) => l.startsWith(`**${label()}:** `));
      assert.ok(line, message);
      const value = line.slice(`**${label()}:** `.length).trimEnd();
      assertMarkdownEscaped(value);
      assert.equal(unescapeMarkdown(value), REASON);
    }
  });

  it('is escaped HTML on Pushover', async () => {
    const built = await new PushoverAgent()['getNotificationPayload'](
      Notification.MEDIA_DECLINED,
      declined()
    );

    assert.ok(
      built.message?.includes(
        `<b>${label()}:</b> Already on *Netflix* &amp; &lt;b&gt;Prime&lt;/b&gt;`
      ),
      built.message
    );
    assert.ok(!built.message?.includes('<b>Prime'), built.message);
  });

  it('keeps a Pushover message within its 1024 characters, the reason before the summary', async () => {
    const reason = 'r'.repeat(500);
    const built = await new PushoverAgent()['getNotificationPayload'](
      Notification.MEDIA_DECLINED,
      declined(reason, { message: 'o'.repeat(500) })
    );

    assert.ok(built.message!.length <= 1024, `${built.message!.length}`);
    assert.ok(built.message!.includes(reason));
    assert.ok(!built.message!.includes('o'.repeat(500)));

    const short = await new PushoverAgent()['getNotificationPayload'](
      Notification.MEDIA_DECLINED,
      declined('Short', { message: 'A film.' })
    );
    assert.ok(short.message!.includes('A film.'), 'kept when it fits');
  });

  it('is a plain line on Pushbullet', () => {
    const built = new PushbulletAgent()['getNotificationPayload'](
      Notification.MEDIA_DECLINED,
      declined()
    );

    assert.ok(built.body.includes(`\n${label()}: ${REASON}`), built.body);
  });

  it('is shown escaped in the email', async () => {
    const built = new EmailAgent()['buildMessage'](
      Notification.MEDIA_DECLINED,
      declined(),
      'friend@seerr.dev',
      'Friend'
    );

    assert.ok(built);
    const locals = built.locals as Record<string, unknown>;
    assert.equal(locals.declineReason, REASON);
    assert.equal(locals.declineReasonLabel, label());

    const html = await new Email().render(
      path.join(built.template as string, 'html'),
      locals
    );
    assert.ok(html.includes('&lt;b&gt;Prime&lt;/b&gt;'), 'escaped');
    assert.ok(!html.includes('<b>Prime</b>'), 'never as markup');
    assert.ok(html.includes('Already on *Netflix* &amp;'));
  });

  it('is in the push notification, as text', () => {
    const built = new WebPushAgent()['getNotificationPayload'](
      Notification.MEDIA_DECLINED,
      declined()
    );

    assert.ok(
      built.message?.endsWith(`\n${label()}: ${REASON}`),
      built.message
    );
  });

  it('is {{decline_reason}} for webhooks, and nothing when there is none', () => {
    const template = JSON.stringify({
      reason: '{{decline_reason}}',
      subject: '{{subject}}',
    });
    const agent = new WebhookAgent({
      enabled: true,
      types: Notification.MEDIA_DECLINED,
      options: {
        webhookUrl: 'https://hooks.example',
        jsonPayload: Buffer.from(JSON.stringify(template)).toString('base64'),
      },
    } as NotificationAgentWebhook);

    assert.deepEqual(
      agent['buildPayload'](Notification.MEDIA_DECLINED, declined()),
      { reason: REASON, subject: 'Film (2020)' }
    );
    assert.deepEqual(
      agent['buildPayload'](Notification.MEDIA_DECLINED, declined(null)),
      { reason: '', subject: 'Film (2020)' }
    );
  });

  it('adds nothing when no reason was given', async () => {
    const none = declined(null);
    const discord = new DiscordAgent().buildEmbed(
      Notification.MEDIA_DECLINED,
      none
    );
    const slack = new SlackAgent().buildEmbed(
      Notification.MEDIA_DECLINED,
      none
    );
    const pushover = await new PushoverAgent()['getNotificationPayload'](
      Notification.MEDIA_DECLINED,
      none
    );
    const email = new EmailAgent()['buildMessage'](
      Notification.MEDIA_DECLINED,
      none,
      'friend@seerr.dev'
    );

    assert.ok(!discord.fields?.some((f) => f.name === label()));
    assert.ok(!JSON.stringify(slack.blocks).includes(`${label()}\\n`));
    assert.ok(!pushover.message?.includes(`${label()}:`));
    assert.equal(
      (email?.locals as Record<string, unknown>).declineReason,
      undefined
    );
  });

  it('only ever belongs to the declined notification', () => {
    const embed = new DiscordAgent().buildEmbed(
      Notification.MEDIA_APPROVED,
      declined()
    );

    assert.ok(!embed.fields?.some((f) => f.name === label()));
  });
});
