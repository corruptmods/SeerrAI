import { getSettings } from '@server/lib/settings';
import { csrfProtection } from '@server/middleware/csrf';
import secureCookies from '@server/middleware/secureCookies';
import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

/*
 * Cookies over https are Secure, as the session's secure: 'auto' alone can't
 * tell behind a proxy Seerr doesn't trust; plain http by another host keeps
 * working.
 */

const app = express();
app.use(secureCookies);
app.use(cookieParser());
app.use(express.json());
app.use(csrfProtection());
app.use(
  session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'strict', secure: 'auto' },
  })
);
app.get('/api/v1/status', (_req, res) => res.json({ ok: true }));
app.post('/api/v1/auth/local', (req, res) => {
  req.session.userId = 1;
  res.json({ id: 1 });
});

const applicationUrl = getSettings().main.applicationUrl;
beforeEach(() => {
  getSettings().main.applicationUrl = 'https://harbour-lights.example.invalid';
});
afterEach(() => {
  getSettings().main.applicationUrl = applicationUrl;
});

/** Each cookie set, by name, with whether it is Secure. */
const secureByName = (res: request.Response): Record<string, boolean> =>
  Object.fromEntries(
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .map((line) => [line.split('=')[0], /;\s*Secure(;|$)/i.test(line)])
  );

/**
 * Signs in from `host`, as a browser would: token first, then the form. The
 * cookies are sent back by hand: the test client keeps no Secure cookie over
 * its plain http.
 */
const signInFrom = async (
  host: string,
  headers: Record<string, string> = {}
) => {
  const first = await request(app)
    .get('/api/v1/status')
    .set('Host', host)
    .set(headers);
  const cookies = ([] as string[])
    .concat(first.headers['set-cookie'] ?? [])
    .map((line) => line.split(';')[0]);
  const token = cookies
    .find((pair) => pair.startsWith('XSRF-TOKEN='))
    ?.slice('XSRF-TOKEN='.length);
  assert.ok(token);
  const signedIn = await request(app)
    .post('/api/v1/auth/local')
    .set('Host', host)
    .set(headers)
    .set('Cookie', cookies.join('; '))
    .set('X-XSRF-TOKEN', decodeURIComponent(token));
  assert.equal(signedIn.status, 200);
  return { first, signedIn };
};

describe('cookies', () => {
  it('are Secure on the host of an https Application URL', async () => {
    const { first, signedIn } = await signInFrom(
      'harbour-lights.example.invalid'
    );
    assert.deepEqual(secureByName(first), { _csrf: true, 'XSRF-TOKEN': true });
    assert.equal(secureByName(signedIn)['connect.sid'], true);
  });

  it('are Secure when a proxy says the browser is on https', async () => {
    const { signedIn } = await signInFrom('192.0.2.5:5055', {
      'X-Forwarded-Proto': 'https',
    });
    assert.equal(secureByName(signedIn)['connect.sid'], true);
  });

  it('keep working over plain http by another host, CSRF protection on', async () => {
    const { first, signedIn } = await signInFrom('192.0.2.5:5055');
    assert.deepEqual(secureByName(first), {
      _csrf: false,
      'XSRF-TOKEN': false,
    });
    assert.equal(secureByName(signedIn)['connect.sid'], false);
  });

  it('keep working over plain http by the Application URL’s name on another port', async () => {
    const { first, signedIn } = await signInFrom(
      'harbour-lights.example.invalid:5055'
    );
    assert.deepEqual(secureByName(first), {
      _csrf: false,
      'XSRF-TOKEN': false,
    });
    assert.equal(secureByName(signedIn)['connect.sid'], false);
  });

  it('follow only an https Application URL', async () => {
    getSettings().main.applicationUrl = 'http://harbour-lights.example.invalid';
    const { signedIn } = await signInFrom('harbour-lights.example.invalid');
    assert.equal(secureByName(signedIn)['connect.sid'], false);
  });
});
