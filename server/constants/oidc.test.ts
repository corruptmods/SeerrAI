import {
  isStandInEmail,
  issuerFromEntered,
  normalizeIssuer,
  shownEmail,
  standInEmail,
} from '@server/constants/oidc';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * An issuer URL as an admin enters it in Settings → Users → Single Sign-On:
 * the issuer itself, or the provider's whole configuration address, which
 * Authentik and others show beside it.
 */

describe('an issuer URL as entered', () => {
  it('takes a configuration address back to the issuer it is under', () => {
    assert.equal(
      issuerFromEntered(
        'https://auth.example.com/application/o/seerr/.well-known/openid-configuration'
      ),
      'https://auth.example.com/application/o/seerr/'
    );
    assert.equal(
      issuerFromEntered(
        'https://sso.example.com/realms/home/.well-known/openid-configuration/'
      ),
      'https://sso.example.com/realms/home/',
      'with a slash at the end too'
    );
    assert.equal(
      issuerFromEntered(
        '  https://accounts.google.com/.well-known/openid-configuration  '
      ),
      'https://accounts.google.com/'
    );
    assert.equal(
      issuerFromEntered(
        'https://auth.example.com/.WELL-KNOWN/OpenID-Configuration'
      ),
      'https://auth.example.com/',
      'however it is capitalised'
    );
  });

  it('leaves an issuer as it is, but for spaces around it', () => {
    for (const issuer of [
      'https://auth.example.com/application/o/seerr/',
      'https://sso.example.com/realms/home',
      'https://auth.example.com',
      'http://localhost:9000/application/o/seerr/',
    ]) {
      assert.equal(issuerFromEntered(issuer), issuer);
      assert.equal(issuerFromEntered(` ${issuer} `), issuer);
    }
  });

  it('only takes off the configuration address at the very end', () => {
    assert.equal(
      issuerFromEntered(
        'https://auth.example.com/.well-known/openid-configuration/realms/x'
      ),
      'https://auth.example.com/.well-known/openid-configuration/realms/x'
    );
    assert.equal(
      issuerFromEntered(
        'https://auth.example.com/my.well-known/openid-configuration'
      ),
      'https://auth.example.com/my.well-known/openid-configuration',
      'only as a whole part of the path'
    );
    assert.equal(
      issuerFromEntered(
        'https://auth.example.com/.well-known/oauth-authorization-server'
      ),
      'https://auth.example.com/.well-known/oauth-authorization-server'
    );
  });
});

describe('an issuer as links remember it', () => {
  it('is the same with or without a slash at the end, as before', () => {
    assert.equal(
      normalizeIssuer('https://auth.example.com/application/o/seerr/'),
      'https://auth.example.com/application/o/seerr'
    );
    assert.equal(
      normalizeIssuer('https://sso.example.com/realms/home'),
      'https://sso.example.com/realms/home'
    );
    assert.equal(
      normalizeIssuer(' https://auth.example.com// '),
      'https://auth.example.com'
    );
  });

  it('is the same for the configuration address as for its issuer', () => {
    assert.equal(
      normalizeIssuer(
        'https://auth.example.com/application/o/seerr/.well-known/openid-configuration'
      ),
      normalizeIssuer('https://auth.example.com/application/o/seerr/')
    );
    assert.equal(
      normalizeIssuer(
        'https://sso.example.com/realms/home/.well-known/openid-configuration/'
      ),
      'https://sso.example.com/realms/home'
    );
  });
});

describe('stand-in emails', () => {
  const standIn = standInEmail(
    'authentik',
    '6ac47894-de62-42c9-91f8-1fc5f085da26'
  );

  it('knows its own stand-ins, and nothing else', () => {
    assert.equal(isStandInEmail(standIn), true);
    for (const other of [
      'robin@example.com',
      'robin',
      'authentik:robin',
      '',
      null,
      undefined,
    ]) {
      assert.equal(isStandInEmail(other), false, String(other));
    }
  });

  it('shows an email beside a name only when it is one, and not the name', () => {
    assert.equal(shownEmail('test', standIn), undefined);
    assert.equal(shownEmail('Robin', 'robin@example.com'), 'robin@example.com');
    assert.equal(
      shownEmail('robin@example.com', 'Robin@example.com'),
      undefined
    );
    assert.equal(shownEmail('Robin', undefined), undefined);
  });
});
