import TheMovieDb from '@server/api/themoviedb';
import { IssueType } from '@server/constants/issue';
import { MediaType } from '@server/constants/media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import { initI18n } from '@server/i18n';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import DiscordAgent from '@server/lib/notifications/agents/discord';
import EmailAgent from '@server/lib/notifications/agents/email';
import GotifyAgent from '@server/lib/notifications/agents/gotify';
import NtfyAgent from '@server/lib/notifications/agents/ntfy';
import PushbulletAgent from '@server/lib/notifications/agents/pushbullet';
import PushoverAgent from '@server/lib/notifications/agents/pushover';
import SlackAgent from '@server/lib/notifications/agents/slack';
import TelegramAgent from '@server/lib/notifications/agents/telegram';
import WebhookAgent from '@server/lib/notifications/agents/webhook';
import {
  issueEvent,
  mediaEvent,
  requestAvailableEvent,
  seriesReadyToWatchEvent,
} from '@server/lib/notifications/eventTitles';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';

describe('notification event lines in English', () => {
  // What webhooks have always been sent, and still are.
  it('are word for word what they were', () => {
    const cases: [Notification, MediaType, boolean, string][] = [
      [Notification.MEDIA_PENDING, MediaType.MOVIE, false, 'New Movie Request'],
      [Notification.MEDIA_PENDING, MediaType.TV, true, 'New 4K Series Request'],
      [
        Notification.MEDIA_APPROVED,
        MediaType.MOVIE,
        true,
        '4K Movie Request Approved',
      ],
      [
        Notification.MEDIA_AUTO_APPROVED,
        MediaType.TV,
        false,
        'Series Request Automatically Approved',
      ],
      [
        Notification.MEDIA_AUTO_REQUESTED,
        MediaType.MOVIE,
        false,
        'Movie Request Automatically Submitted',
      ],
      [
        Notification.MEDIA_DECLINED,
        MediaType.TV,
        false,
        'Series Request Declined',
      ],
      [
        Notification.MEDIA_FAILED,
        MediaType.MOVIE,
        true,
        '4K Movie Request Failed',
      ],
      [
        Notification.MEDIA_AVAILABLE,
        MediaType.TV,
        false,
        'Series Now Available',
      ],
    ];
    for (const [type, mediaType, is4k, english] of cases) {
      assert.equal(mediaEvent(type, mediaType, is4k)?.event, english);
    }

    assert.equal(
      requestAvailableEvent(MediaType.MOVIE, true).event,
      '4K Movie Request Now Available'
    );
    assert.equal(seriesReadyToWatchEvent().event, 'Series Ready to Watch');
    assert.equal(
      issueEvent(Notification.ISSUE_CREATED, IssueType.SUBTITLES)?.event,
      'New Subtitle Issue Reported'
    );
    assert.equal(
      issueEvent(Notification.ISSUE_RESOLVED, IssueType.OTHER)?.event,
      'Issue Resolved'
    );
    assert.equal(
      issueEvent(Notification.ISSUE_COMMENT, IssueType.VIDEO)?.event,
      'New Comment on Video Issue'
    );
  });
});

/*
 * The new lines are only in English until they are translated, so the
 * channels are checked with a line that already is: "Available".
 */
const translated = {
  message: {
    id: 'notifications.common.available',
    defaultMessage: 'Available',
  },
};

const payload = (): NotificationPayload => ({
  event: 'Available',
  eventTitle: translated,
  subject: 'Zelvara (2021)',
  notifySystem: true,
  notifyAdmin: false,
  media: { mediaType: MediaType.MOVIE, tmdbId: 549172 } as never,
  request: {
    is4k: false,
    requestedBy: { displayName: 'Jordan' },
  } as never,
});

describe('notification event lines in each channel', () => {
  const main = getSettings().main;
  const savedLocale = main.locale;

  before(() => initI18n());
  after(() => {
    main.locale = savedLocale;
  });

  it('are in the language of the person they go to', async () => {
    const type = Notification.MEDIA_AVAILABLE;

    assert.match(
      new DiscordAgent().buildEmbed(type, payload(), 'fr').title ?? '',
      /^Disponible: Zelvara/
    );
    const telegram = new TelegramAgent()['getNotificationPayload'](
      type,
      payload(),
      'fr'
    ) as { text?: string; caption?: string };
    assert.match(
      telegram.text ?? telegram.caption ?? '',
      /Disponible \\- Zelvara/
    );
    assert.equal(
      new PushbulletAgent()['getNotificationPayload'](type, payload(), 'fr')
        .title,
      'Disponible - Zelvara (2021)'
    );
    assert.equal(
      (
        await new PushoverAgent()['getNotificationPayload'](
          type,
          payload(),
          'fr'
        )
      ).title,
      'Disponible'
    );
    const email = new EmailAgent()['buildMessage'](
      type,
      payload(),
      'jordan@example.com',
      'Jordan',
      'fr'
    );
    assert.equal(
      (email?.locals as { event?: string } | undefined)?.event,
      'Disponible'
    );
  });

  it('are in the language a shared channel is set to', () => {
    const type = Notification.MEDIA_AVAILABLE;
    const options = { locale: 'de' };

    const slack = new SlackAgent({
      enabled: true,
      embedPoster: false,
      options: { webhookUrl: 'https://hooks.example', ...options },
    } as never).buildEmbed(type, payload());
    assert.equal(slack.text, 'Verfügbar');

    const gotify = new GotifyAgent({
      enabled: true,
      embedPoster: false,
      options: { url: 'https://gotify.example', token: 't', ...options },
    } as never)['getNotificationPayload'](type, payload());
    assert.equal(gotify.title, 'Verfügbar - Zelvara (2021)');

    const ntfy = new NtfyAgent({
      enabled: true,
      embedPoster: false,
      options: { url: 'https://ntfy.example', topic: 't', ...options },
    } as never)['buildPayload'](type, payload());
    assert.equal(ntfy.title, 'Verfügbar - Zelvara (2021)');
  });

  it('are in the server’s language for channels that pick none', () => {
    main.locale = 'de';
    const telegram = new TelegramAgent()['getNotificationPayload'](
      Notification.MEDIA_AVAILABLE,
      payload()
    ) as { text?: string; caption?: string };
    assert.match(
      telegram.text ?? telegram.caption ?? '',
      /Verfügbar \\- Zelvara/
    );
    main.locale = savedLocale;
  });

  it('stay in English for webhooks', () => {
    const webhook = new WebhookAgent({
      enabled: true,
      embedPoster: false,
      options: {
        webhookUrl: 'https://hook.example',
        jsonPayload:
          getSettings().notifications.agents.webhook.options.jsonPayload,
      },
    } as never)['buildPayload'](Notification.MEDIA_AVAILABLE, {
      ...payload(),
      ...mediaEvent(Notification.MEDIA_AVAILABLE, MediaType.MOVIE, false),
    }) as { event?: string };
    assert.equal(webhook.event, 'Movie Now Available');
  });

  it('show a line given as plain text as written', () => {
    const embed = new DiscordAgent().buildEmbed(
      Notification.MEDIA_AVAILABLE,
      { ...payload(), event: 'Season 2 Is Here', eventTitle: undefined },
      'fr'
    );
    assert.match(embed.title ?? '', /^Season 2 Is Here: Zelvara/);
  });
});

describe('a request’s notification', () => {
  it('carries its event line to be put in each channel’s language', async () => {
    // The client sets its methods on each instance, so the stub swallows
    // that write.
    Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
      configurable: true,
      set() {},
      get() {
        return async () => ({
          title: 'Zelvara',
          release_date: '2021-10-22',
          overview: 'Spice.',
          poster_path: null,
        });
      },
    });
    const sent: NotificationPayload[] = [];
    const send = mock.method(
      notificationManager,
      'sendNotification',
      (_type: Notification, p: NotificationPayload) => {
        sent.push(p);
      }
    );
    try {
      const request = Object.assign(Object.create(MediaRequest.prototype), {
        id: 1,
        type: MediaType.MOVIE,
        is4k: true,
        seasons: [],
        requestedBy: { id: 2, displayName: 'Jordan' } as User,
      }) as MediaRequest;
      await MediaRequest.sendNotification(
        request,
        { tmdbId: 549172 } as never,
        Notification.MEDIA_PENDING
      );
    } finally {
      delete (TheMovieDb.prototype as { getMovie?: unknown }).getMovie;
      send.mock.restore();
    }

    assert.equal(sent.length, 1);
    assert.equal(sent[0].event, 'New 4K Movie Request');
    assert.equal(
      sent[0].eventTitle?.message.id,
      'notifications.events.mediaPending'
    );
    assert.deepEqual(sent[0].eventTitle?.values, { kind: 'movie4k' });
  });
});
