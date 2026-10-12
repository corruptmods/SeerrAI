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
    const names = (text: string) =>
      new Set([...text.matchAll(/\{(\w+)/g)].map((m) => m[1]));
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
