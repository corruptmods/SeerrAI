import { User } from '@server/entity/User';
import PreparedEmail from '@server/lib/email';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * The password emails are sent from the account rather than through the
 * email notification agent, and never had the logo: they showed the
 * application's name in its place.
 */

const sent: { template: string; locals: Record<string, unknown> }[] = [];

describe('password emails', () => {
  beforeEach(() => {
    sent.length = 0;
    mock.method(
      PreparedEmail.prototype,
      'send',
      async (options: {
        template: string;
        locals: Record<string, unknown>;
      }) => {
        sent.push(options);
      }
    );
    getSettings().main.applicationUrl = 'https://seerr.example.com';
    getSettings().notifications.agents.email.options.usePublicLogo = false;
  });

  afterEach(() => {
    mock.restoreAll();
    getSettings().main.applicationUrl = '';
  });

  const user = () =>
    Object.assign(new User(), {
      email: 'sam@example.com',
      username: 'sam',
      resetPasswordGuid: 'guid',
    });

  it('shows the logo in the reset password email', async () => {
    await user().sendResetPasswordEmail();
    assert.equal(sent.length, 1);
    assert.equal(
      sent[0].locals.logoUrl,
      'https://seerr.example.com/logo_ai_dark.svg'
    );
  });

  it('shows the logo in the generated password email', async () => {
    await user().generatePassword();
    assert.equal(sent.length, 1);
    assert.equal(
      sent[0].locals.logoUrl,
      'https://seerr.example.com/logo_ai_dark.svg'
    );
  });

  it('uses the public logo when the email settings ask for it', async () => {
    getSettings().notifications.agents.email.options.usePublicLogo = true;
    await user().sendResetPasswordEmail();
    assert.match(String(sent[0].locals.logoUrl), /^https:\/\/raw\.github/);
  });
});
