import PreparedEmail, { emailLogoUrl } from '@server/lib/email';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

/*
 * The logo at the top of every email. Gmail and Outlook don't show SVG
 * pictures, so it is a PNG, wherever it comes from, and says what it is for
 * anyone who can't see it.
 */

const TEMPLATES = path.join(__dirname, '../../templates/email');

describe('the email logo', () => {
  beforeEach(() => {
    getSettings().main.applicationUrl = 'https://seerr.example.com';
    getSettings().notifications.agents.email.options.usePublicLogo = false;
  });

  afterEach(() => {
    getSettings().main.applicationUrl = '';
    getSettings().notifications.agents.email.options.usePublicLogo = false;
  });

  it("is this server's PNG", () => {
    assert.equal(emailLogoUrl(), 'https://seerr.example.com/logo_ai_dark.png');
  });

  it("is the repository's PNG when the public logo is chosen", () => {
    getSettings().notifications.agents.email.options.usePublicLogo = true;
    assert.equal(
      emailLogoUrl(),
      'https://raw.githubusercontent.com/corruptmods/SeerrAI/main/public/logo_ai_dark.png'
    );
  });

  it('follows the settings it is given over the saved ones', () => {
    assert.match(
      String(emailLogoUrl({ usePublicLogo: true })),
      /^https:\/\/raw\./
    );
    getSettings().notifications.agents.email.options.usePublicLogo = true;
    assert.equal(
      emailLogoUrl({ usePublicLogo: false }),
      'https://seerr.example.com/logo_ai_dark.png'
    );
  });

  it('is left out without an Application URL or the public logo', () => {
    getSettings().main.applicationUrl = '';
    assert.equal(emailLogoUrl(), undefined);
  });

  const templates = readdirSync(TEMPLATES);

  it('finds every email', () => {
    assert.deepEqual(templates.sort(), [
      'backfill',
      'generatedpassword',
      'media-issue',
      'media-request',
      'resetpassword',
      'test-email',
    ]);
  });

  for (const template of templates) {
    for (const applicationUrl of ['https://seerr.example.com', '']) {
      it(`${template}: shows the logo named for the application${applicationUrl ? '' : ', without a link'}`, async () => {
        const email = new PreparedEmail(
          getSettings().notifications.agents.email
        );
        const html = await email.render(
          path.join(TEMPLATES, template, 'html'),
          {
            applicationTitle: 'Family Films',
            applicationUrl,
            logoUrl: 'https://seerr.example.com/logo_ai_dark.png',
            recipientName: 'Sam',
            recipientEmail: 'sam@example.com',
            requestedBy: 'Sam',
            body: 'Hello',
            subject: 'Hello',
            mediaName: 'Film',
            mediaExtra: [],
            extra: [],
            password: 'secret',
            resetPasswordLink: 'https://seerr.example.com/resetpassword/x',
            actionUrlTitle: 'Open',
          }
        );
        const images = [...html.matchAll(/<img[^>]*>/g)].map((m) => m[0]);
        const logo = images.find((img) => img.includes('logo_ai_dark'));
        assert.ok(logo, 'no logo in the email');
        assert.match(
          logo,
          /src="https:\/\/seerr\.example\.com\/logo_ai_dark\.png"/
        );
        assert.match(logo, /alt="Family Films"/);
      });
    }
  }
});
