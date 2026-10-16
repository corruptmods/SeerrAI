import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createIntl } from 'react-intl';

/*
 * What the sign-in page and Linked Accounts say for `?sso=not-allowed`, the
 * outcome the server ends on when a provider's rules turn someone away.
 * Read from the extracted messages: the module itself loads through the
 * app's path aliases, which tests don't have.
 */
const en: Record<string, string> = JSON.parse(
  readFileSync(path.join(process.cwd(), 'src/i18n/locale/en.json'), 'utf8')
);
const source = readFileSync(
  path.join(process.cwd(), 'src/components/Login/singleSignOnMessages.ts'),
  'utf8'
);

describe('coming back turned away by a provider', () => {
  it('names the provider and says to ask an admin', () => {
    const intl = createIntl({ locale: 'en', messages: en });

    assert.equal(
      intl.formatMessage(
        { id: 'components.Login.SingleSignOn.notAllowed' },
        { provider: 'Our Authentik' }
      ),
      "Your Our Authentik account isn't allowed to use this server. Ask an admin if you think it should be."
    );
  });

  it('is the message for the not-allowed outcome', () => {
    assert.match(source, /'not-allowed': 'notAllowed',/);
  });
});
