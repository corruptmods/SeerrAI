import { initI18n } from '@server/i18n';
import { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import TelegramAgent from '@server/lib/notifications/agents/telegram';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

/**
 * Reads a message the way Telegram reads MarkdownV2, returning the words a
 * person sees and the links in it, and throwing where Telegram would refuse
 * the message: a reserved character left unescaped outside the bold and link
 * markup, or a link address with an unescaped ")" or "\".
 */
const readMarkdownV2 = (text: string) => {
  const reserved = '_*[]()~`>#+-=|{}.!\\';
  const links: { label: string; url: string }[] = [];
  let shown = '';
  let label: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[++i];
      assert.ok(next !== undefined, 'message ends in a lone backslash');
      if (label !== null) label += next;
      else shown += next;
    } else if (ch === '*') {
      // Bold on or off: markup, not words.
    } else if (ch === '[' && label === null) {
      label = '';
    } else if (ch === ']' && label !== null) {
      assert.equal(text[++i], '(', 'link text not followed by an address');
      let url = '';
      for (i++; i < text.length && text[i] !== ')'; i++) {
        if (text[i] === '\\') {
          i++;
          assert.ok(
            text[i] === ')' || text[i] === '\\',
            `needless escape in link address at ${i}`
          );
        }
        url += text[i];
      }
      assert.equal(text[i], ')', 'link address not closed');
      links.push({ label, url });
      shown += label;
      label = null;
    } else {
      assert.ok(
        !reserved.includes(ch),
        `unescaped "${ch}" at ${i} in: ${text}`
      );
      if (label !== null) label += ch;
      else shown += ch;
    }
  }

  return { shown, links };
};

const textOf = (
  payload: NotificationPayload,
  type = Notification.ISSUE_COMMENT
) => {
  const built = new TelegramAgent()['getNotificationPayload'](
    type,
    payload
  ) as {
    text?: string;
    caption?: string;
  };
  return (built.text ?? built.caption)!;
};

describe('Telegram messages', () => {
  const main = getSettings().main;
  const saved = { ...main };

  before(() => {
    initI18n();
    main.applicationUrl = 'https://seerr.example';
    main.applicationTitle = 'Seerr `AI` \\ (home)';
  });

  after(() => {
    Object.assign(main, saved);
  });

  it('escapes backticks and backslashes in the title and message', () => {
    const subject = 'Back`slash\\ Movie (2020)';
    const message = 'A `quoted` path: C:\\films\\ and a lone \\';
    const { shown } = readMarkdownV2(
      textOf({
        event: 'New Issue Reported',
        subject,
        message,
        notifySystem: true,
        notifyAdmin: false,
      })
    );

    assert.ok(shown.includes(`New Issue Reported - ${subject}`), shown);
    assert.ok(shown.includes(message), shown);
  });

  it('does not escape twice: an already escaped-looking title comes out as written', () => {
    const subject = 'Already \\* escaped \\\\ text';
    const { shown } = readMarkdownV2(
      textOf({ subject, notifySystem: true, notifyAdmin: false })
    );

    assert.equal(shown, subject);
  });

  it('escapes the extra fields, which used to go out as written', () => {
    const { shown } = readMarkdownV2(
      textOf({
        subject: 'Show',
        notifySystem: true,
        notifyAdmin: false,
        extra: [
          { name: 'Episodes (new)', value: 'S01E01-S01E03.' },
          { name: 'Note_`x`', value: 'C:\\path #1 {a} = b!' },
        ],
      })
    );

    assert.ok(shown.includes('Episodes (new): S01E01-S01E03.'), shown);
    assert.ok(shown.includes('Note_`x`: C:\\path #1 {a} = b!'), shown);
  });

  it('escapes the link text and the link address', () => {
    const { links } = readMarkdownV2(
      textOf({
        subject: 'Something',
        notifySystem: true,
        notifyAdmin: false,
        actionUrl: '/backfill/agent/(7)\\x',
        actionUrlTitle: 'Review `this`',
      })
    );

    assert.deepEqual(links, [
      {
        label: `Review \`this\` in ${main.applicationTitle}`,
        url: 'https://seerr.example/backfill/agent/(7)\\x',
      },
    ]);
  });

  it('escapes the caption sent with a poster the same way', () => {
    const built = new TelegramAgent()['getNotificationPayload'](
      Notification.MEDIA_AVAILABLE,
      {
        subject: 'Poster `Film`\\',
        image: 'https://image.tmdb.org/t/p/w600_and_h900_bestv2/x.jpg',
        notifySystem: true,
        notifyAdmin: false,
      }
    ) as { caption?: string };

    assert.ok(built.caption, 'sent as a photo with a caption');
    assert.equal(readMarkdownV2(built.caption!).shown, 'Poster `Film`\\');
  });
});
