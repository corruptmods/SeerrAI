import { IssueStatus, IssueType } from '@server/constants/issue';
import { MediaType } from '@server/constants/media';
import type Issue from '@server/entity/Issue';
import type IssueComment from '@server/entity/IssueComment';
import type Media from '@server/entity/Media';
import { initI18n } from '@server/i18n';
import { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import DiscordAgent from '@server/lib/notifications/agents/discord';
import GotifyAgent from '@server/lib/notifications/agents/gotify';
import NtfyAgent from '@server/lib/notifications/agents/ntfy';
import PushoverAgent from '@server/lib/notifications/agents/pushover';
import SlackAgent from '@server/lib/notifications/agents/slack';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

// Issue and comment text, and people's names, on each markup channel: shown
// as written, never as markup of their own.

const TEXT =
  'No sound <a href="https://example.invalid/a">here</a> [Open](https://example.invalid/b) ![](https://example.invalid/c.png) <https://example.invalid/d|link> <!channel> & *Glasswing*';
const NAME = 'Lantern <b>Song</b> [x](https://example.invalid/e)';

const media = { id: 1, mediaType: MediaType.MOVIE, tmdbId: 1 } as Media;
const issue = {
  id: 3,
  issueType: IssueType.AUDIO,
  status: IssueStatus.OPEN,
  createdBy: { displayName: NAME },
} as unknown as Issue;

const reported: NotificationPayload = {
  event: 'New Audio Issue Reported',
  subject: 'Harbour Lights (2020)',
  message: TEXT,
  notifySystem: true,
  notifyAdmin: true,
  media,
  issue,
};

const commented: NotificationPayload = {
  ...reported,
  event: 'New Comment on Audio Issue',
  message: 'Static Garden',
  comment: {
    message: TEXT,
    user: { displayName: NAME },
  } as unknown as IssueComment,
};

/** Undoes markdown backslash escapes, as a reader would. */
const unescapeMarkdown = (text: string) => text.replace(/\\(.)/g, '$1');

/** True when every ASCII punctuation mark in the text is escaped. */
const markdownEscaped = (text: string) => {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
    } else if (/[!-/:-@[-`{-~]/.test(text[i])) {
      return false;
    }
  }
  return true;
};

describe('issue text in a notification', () => {
  const main = getSettings().main;
  const saved = { ...main };

  before(() => {
    initI18n();
    main.applicationUrl = 'https://seerr.example.invalid';
    main.applicationTitle = 'Seerr AI';
  });

  after(() => {
    Object.assign(main, saved);
  });

  it('is escaped HTML on Pushover', async () => {
    for (const payload of [reported, commented]) {
      const built = await new PushoverAgent()['getNotificationPayload'](
        Notification.ISSUE_CREATED,
        payload
      );
      assert.equal(built.html, 1);
      assert.ok(
        built.message?.includes(
          'No sound &lt;a href=&quot;https://example.invalid/a&quot;&gt;here&lt;/a&gt;'
        ),
        built.message
      );
      assert.ok(
        built.message?.includes('Lantern &lt;b&gt;Song&lt;/b&gt;'),
        built.message
      );
      assert.ok(!built.message?.includes('<a '), built.message);
      assert.ok(!built.message?.includes('<b>Song'), built.message);
    }
  });

  it('is escaped markdown on Gotify and ntfy', () => {
    for (const payload of [reported, commented]) {
      const gotify = new GotifyAgent()['getNotificationPayload'](
        Notification.ISSUE_CREATED,
        payload
      );
      const ntfy = new NtfyAgent()['buildPayload'](
        Notification.ISSUE_CREATED,
        payload
      ) as { message: string };

      for (const message of [gotify.message, ntfy.message]) {
        const line = message
          .split('\n')
          .map((l) => l.trimEnd())
          .find((l) => unescapeMarkdown(l) === TEXT);
        assert.ok(line, message);
        assert.ok(markdownEscaped(line), line);
        assert.ok(!message.includes('](https://example.invalid'), message);
      }
    }
  });

  it('is shown as text on Discord', () => {
    const issueEmbed = new DiscordAgent().buildEmbed(
      Notification.ISSUE_CREATED,
      reported
    );
    const commentEmbed = new DiscordAgent().buildEmbed(
      Notification.ISSUE_COMMENT,
      commented
    );
    const values = [
      issueEmbed.description ?? '',
      ...(issueEmbed.fields ?? []).map((f) => f.value),
      ...(commentEmbed.fields ?? []).map((f) => f.value),
    ].filter(
      (v) => unescapeMarkdown(v) === TEXT || unescapeMarkdown(v) === NAME
    );

    assert.equal(values.length, 3, JSON.stringify(values));
    for (const value of values) {
      assert.ok(markdownEscaped(value), value);
    }
    assert.equal(commentEmbed.description, 'Static Garden');
  });

  it('can’t link or mention anyone on Slack', () => {
    for (const payload of [reported, commented]) {
      const embed = new SlackAgent().buildEmbed(
        Notification.ISSUE_CREATED,
        payload
      );
      const texts = embed.blocks.flatMap((b) => [
        ...(b.text ? [b.text] : []),
        ...(b.fields ?? []),
      ]);
      const own = texts.filter(
        (t) => t.text.includes('No sound') || t.text.includes('Lantern')
      );
      assert.ok(own.length > 0, JSON.stringify(embed.blocks));
      for (const item of own) {
        assert.ok(!/[<>]/.test(item.text), item.text);
        assert.equal(item.verbatim, true);
      }
      assert.ok(
        own.some((t) =>
          t.text.includes(
            '&lt;https://example.invalid/d|link&gt; &lt;!channel&gt; &amp; *Glasswing*'
          )
        ),
        JSON.stringify(own)
      );
    }
  });
});
