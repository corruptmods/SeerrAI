import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import { User } from '@server/entity/User';
import { getIntl, initI18n } from '@server/i18n';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import DiscordAgent from '@server/lib/notifications/agents/discord';
import EmailAgent from '@server/lib/notifications/agents/email';
import { KeyMap } from '@server/lib/notifications/agents/webhook';
import WebPushAgent from '@server/lib/notifications/agents/webpush';
import {
  eventText,
  mediaEvent,
  requestAvailableEvent,
} from '@server/lib/notifications/eventTitles';
import { mediaPagePath } from '@server/lib/notifications/mediaPage';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

/*
 * Music in notifications: their own event lines, what they say about the
 * albums, and links to the album or artist rather than a TMDB address.
 */

setupTestDb();

const ARTIST = '3c9e5f21-8d47-4b6a-a1e3-5f7d2c90b844';
const STATIC_GARDEN = '4f6a2d93-c1e8-3a57-9b02-6d3e8f1c7a40';
const FOG_B = '7e41c0d8-5b29-3f6c-b8a4-91d6e2f07a35';

const sent: { type: Notification; payload: NotificationPayload }[] = [];

/** The artist, its albums, and a request for some of them. */
const musicRequest = async (
  albums: { mbId: string; title: string; date: string }[]
): Promise<{ media: Media; request: MediaRequest }> => {
  const manager = dataSource.manager;
  const media = await manager.save(
    new Media({
      mediaType: MediaType.MUSIC,
      tmdbId: 0,
      foreignId: ARTIST,
      foreignTitle: 'Glasswing',
      status: MediaStatus.PENDING,
    }),
    { listeners: false }
  );
  for (const album of albums) {
    await manager.save(
      new MusicAlbum({
        mediaId: media.id,
        mbId: album.mbId,
        title: album.title,
        releaseDate: album.date,
        secondaryTypes: [],
        status: MediaStatus.PENDING,
      }),
      { listeners: false }
    );
  }
  const request = await manager.save(
    new MediaRequest({
      type: MediaType.MUSIC,
      status: MediaRequestStatus.PENDING,
      media,
      requestedBy: await manager.findOneByOrFail(User, { id: 2 }),
      is4k: false,
      albums: albums.map(
        (album) =>
          new AlbumRequest({ albumMbid: album.mbId, title: album.title })
      ),
    }),
    { listeners: false }
  );
  return { media, request };
};

before(() => initI18n());

beforeEach(() => {
  sent.length = 0;
  mock.method(
    notificationManager,
    'sendNotification',
    (type: Notification, payload: NotificationPayload) => {
      sent.push({ type, payload });
    }
  );
});

afterEach(() => {
  mock.restoreAll();
});

describe('a music request’s notification', () => {
  it('names one album, its artist and year, with its cover and page', async () => {
    const { media, request } = await musicRequest([
      { mbId: STATIC_GARDEN, title: 'Static Garden', date: '1997-05-21' },
    ]);

    const ok = await MediaRequest.sendNotification(
      request,
      media,
      Notification.MEDIA_APPROVED
    );

    assert.equal(ok, true);
    const { payload } = sent[0];
    assert.equal(payload.subject, 'Static Garden — Glasswing (1997)');
    assert.equal(payload.message, 'Static Garden');
    assert.equal(
      payload.image,
      `https://coverartarchive.org/release-group/${STATIC_GARDEN}/front-500`
    );
    assert.deepEqual(payload.extra, [{ name: 'Requested Albums', value: '1' }]);
    assert.equal(payload.event, 'Music Request Approved');
    assert.equal(
      mediaPagePath(payload.media!, payload.request),
      `/music/album/${STATIC_GARDEN}`
    );
  });

  it('counts several albums and links to the artist', async () => {
    const { media, request } = await musicRequest([
      { mbId: STATIC_GARDEN, title: 'Static Garden', date: '1997' },
      { mbId: FOG_B, title: 'Fog B', date: '2000' },
    ]);

    await MediaRequest.sendNotification(
      request,
      media,
      Notification.MEDIA_PENDING
    );

    const { payload } = sent[0];
    assert.equal(payload.subject, 'Glasswing — 2 albums');
    assert.equal(payload.message, 'Static Garden, Fog B');
    assert.equal(payload.event, 'New Music Request');
    assert.equal(
      mediaPagePath(payload.media!, payload.request),
      `/music/artist/${ARTIST}`
    );
  });

  it('carries the decline reason like any other', async () => {
    const { media, request } = await musicRequest([
      { mbId: STATIC_GARDEN, title: 'Static Garden', date: '1997' },
    ]);
    request.status = MediaRequestStatus.DECLINED;
    request.declineReason = 'Already in the library as FLAC';

    await MediaRequest.sendNotification(
      request,
      media,
      Notification.MEDIA_DECLINED
    );

    const { payload } = sent[0];
    assert.equal(payload.event, 'Music Request Declined');
    assert.equal(
      payload.request?.declineReason,
      'Already in the library as FLAC'
    );
  });
});

describe('music event lines', () => {
  it('are music’s own, in English and through the channel’s language', () => {
    for (const [type, english] of [
      [Notification.MEDIA_PENDING, 'New Music Request'],
      [
        Notification.MEDIA_AUTO_APPROVED,
        'Music Request Automatically Approved',
      ],
      [Notification.MEDIA_FAILED, 'Music Request Failed'],
      [Notification.MEDIA_AVAILABLE, 'Music Now Available'],
    ] as const) {
      const event = mediaEvent(type, MediaType.MUSIC, false);
      assert.equal(event?.event, english);
      assert.match(
        event?.eventTitle?.message.id ?? '',
        /^notifications\.events\.music/
      );
      assert.equal(eventText(event ?? {}, getIntl()), english);
    }
    assert.equal(
      requestAvailableEvent(MediaType.MUSIC, false).event,
      'Music Request Now Available'
    );
    // Films and series keep theirs.
    assert.equal(
      mediaEvent(Notification.MEDIA_PENDING, MediaType.TV, false)?.event,
      'New Series Request'
    );
  });
});

describe('music in each channel', () => {
  const payloadOf = async (type: Notification) => {
    const { media, request } = await musicRequest([
      { mbId: STATIC_GARDEN, title: 'Static Garden', date: '1997' },
    ]);
    await MediaRequest.sendNotification(request, media, type);
    return sent[0].payload;
  };

  it('links Discord to the album, never to a TMDB address', async () => {
    getSettings().main.applicationUrl = 'https://seerr.example';
    const payload = await payloadOf(Notification.MEDIA_APPROVED);

    const embed = new DiscordAgent().buildEmbed(
      Notification.MEDIA_APPROVED,
      payload
    );

    assert.equal(
      embed.url,
      `https://seerr.example/music/album/${STATIC_GARDEN}`
    );
    getSettings().main.applicationUrl = '';
  });

  it('says "music" in email, with Lidarr as the service that failed', async () => {
    getSettings().main.applicationUrl = 'https://seerr.example';
    const payload = await payloadOf(Notification.MEDIA_FAILED);

    const message = new EmailAgent()['buildMessage'](
      Notification.MEDIA_FAILED,
      payload,
      'friend@seerr.dev'
    );

    assert.equal(
      message?.locals?.body,
      'A request for the following music failed to be added to Lidarr:'
    );
    assert.equal(
      message?.locals?.actionUrl,
      `https://seerr.example/music/album/${STATIC_GARDEN}`
    );
    getSettings().main.applicationUrl = '';
  });

  it('says "music" in web push, and opens the album', async () => {
    const payload = await payloadOf(Notification.MEDIA_APPROVED);
    const approved = new WebPushAgent()['getNotificationPayload'](
      Notification.MEDIA_APPROVED,
      payload
    );
    assert.equal(approved.message, 'Your music request has been approved.');
    assert.equal(approved.actionUrl, `/music/album/${STATIC_GARDEN}`);

    const failed = new WebPushAgent()['getNotificationPayload'](
      Notification.MEDIA_FAILED,
      payload
    );
    assert.equal(failed.subject, 'Music Request Failed');
  });

  it('gives webhooks the artist’s MusicBrainz id and the albums', async () => {
    const payload = await payloadOf(Notification.MEDIA_PENDING);
    const value = (key: string) => {
      const entry = KeyMap[key];
      return typeof entry === 'function'
        ? entry(payload, Notification.MEDIA_PENDING)
        : entry;
    };

    assert.equal(value('media_mbid'), ARTIST);
    assert.equal(value('music_albums'), 'Static Garden');
    assert.equal(payload.media?.mediaType, 'music');
    assert.equal(payload.media?.tmdbId, 0);

    // Empty for films and series.
    const film = {
      ...payload,
      media: { mediaType: MediaType.MOVIE, tmdbId: 1 } as Media,
    };
    assert.equal(
      (KeyMap.media_mbid as (p: NotificationPayload) => string)(film),
      ''
    );
  });
});
