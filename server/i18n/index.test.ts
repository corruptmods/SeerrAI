import { getIntl, initI18n } from '@server/i18n';
import { availableLocales } from '@server/types/languages';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';

const approved = {
  id: 'notifications.agents.email.approvedRequest',
  defaultMessage:
    'Your request for the following {mediaType} has been approved',
};

describe('notification languages', () => {
  before(() => initI18n());

  it('sends notifications in Chinese, whose files are named by script', () => {
    const simplified = getIntl('zh-CN').formatMessage(approved, {
      mediaType: '电影',
    });
    const traditional = getIntl('zh-TW').formatMessage(approved, {
      mediaType: '電影',
    });
    assert.match(simplified, /批准/);
    assert.match(traditional, /核准/);
  });

  it('has a server translation for every language people can choose', () => {
    const english = getIntl('en').formatMessage(approved, { mediaType: 'x' });
    for (const locale of availableLocales) {
      if (locale === 'en') continue;
      assert.notEqual(
        getIntl(locale).formatMessage(approved, { mediaType: 'x' }),
        english,
        `${locale} falls back to English`
      );
    }
  });

  it('every server translation names every placeholder the English does', () => {
    const dir = path.join(__dirname, 'locale');
    const en = JSON.parse(
      fs.readFileSync(path.join(dir, 'en.json'), 'utf-8')
    ) as Record<string, string>;
    // The names of a message's arguments, at any depth. The text inside a
    // select or plural option ({kind, select, movie {Movie Approved} …}) is
    // wording, not a name, and differs in every language.
    const names = (text: string) => {
      const found = new Set<string>();
      let i = 0;
      const message = (): void => {
        while (i < text.length && text[i] !== '}') {
          if (text[i] === '{') {
            i += 1;
            argument();
          } else {
            i += 1;
          }
        }
      };
      const argument = (): void => {
        const head = /^\s*(\w+)\s*(?:,\s*(\w+)\s*)?/.exec(text.slice(i));
        if (!head) return;
        found.add(head[1]);
        i += head[0].length;
        const withOptions = ['select', 'plural', 'selectordinal'].includes(
          head[2]
        );
        if (text[i] === ',') i += 1;
        while (i < text.length && text[i] !== '}') {
          if (withOptions && text[i] === '{') {
            i += 1;
            message();
          }
          i += 1;
        }
        i += 1;
      };
      while (i < text.length) {
        message();
        i += 1;
      }
      return found;
    };
    for (const file of fs.readdirSync(dir)) {
      const messages = JSON.parse(
        fs.readFileSync(path.join(dir, file), 'utf-8')
      ) as Record<string, string>;
      for (const [key, english] of Object.entries(en)) {
        assert.ok(key in messages, `${file} has no ${key}`);
        for (const name of names(english)) {
          assert.ok(
            names(messages[key]).has(name),
            `${file} ${key} drops {${name}}`
          );
        }
      }
    }
  });
});
