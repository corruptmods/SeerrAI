import { getRepository } from '@server/datasource';
import OidcLink from '@server/entity/OidcLink';
import { User } from '@server/entity/User';
import { forgetDiscovery } from '@server/lib/oidc';
import { getSettings } from '@server/lib/settings';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import { createFakeOidcProvider } from '@server/test/fakeOidcProvider';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

/*
 * Settings → Users → Single Sign-On, behind the real OpenAPI validator,
 * against a provider on localhost.
 */

setupTestDb();

const fake = createFakeOidcProvider();
let app: express.Express;

before(async () => {
  await fake.start();
  app = express();
  app.use(express.json());
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  app.use('/api/v1/settings', settingsRoutes);
  app.use(
    (
      err: { status?: number; message: string },
      _req: express.Request,
      res: express.Response,
      // Express tells an error handler by its four parameters.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );
});

after(async () => {
  await fake.stop();
});

beforeEach(() => {
  fake.reset();
  forgetDiscovery();
  getSettings().oidc = { providers: [] };
  getSettings().main.applicationUrl = 'https://seerr.example/';
});

const body = (overrides: Record<string, unknown> = {}) => ({
  name: 'Authentik',
  issuerUrl: fake.issuer,
  clientId: fake.clientId,
  clientSecret: fake.clientSecret,
  ...overrides,
});

const add = (overrides: Record<string, unknown> = {}) =>
  request(app).post('/api/v1/settings/oidc').send(body(overrides));

describe('single sign-on settings', () => {
  it('adds a provider with safe defaults, and shows where it sends people back to', async () => {
    const res = await add();

    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.id, 'authentik');
    assert.equal(
      res.body.callbackUrl,
      'https://seerr.example/api/v1/auth/oidc/authentik/callback'
    );
    assert.equal(res.body.scopes, 'openid profile email');
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.newUserSignUp, false, 'sign-up is off by default');
    const [saved] = getSettings().oidc.providers;
    assert.equal(saved.clientSecret, fake.clientSecret);
  });

  it('never sends the client secret back', async () => {
    await add();

    const responses = [
      await request(app).get('/api/v1/settings/oidc'),
      await request(app)
        .put('/api/v1/settings/oidc/authentik')
        .send(body({ clientSecret: '' })),
      await request(app).delete('/api/v1/settings/oidc/authentik'),
    ];

    for (const res of responses) {
      assert.equal(res.status, 200, res.text);
      assert.ok(!res.text.includes(fake.clientSecret));
    }
    assert.equal(responses[0].body.providers[0].hasClientSecret, true);
    assert.equal(responses[0].body.providers[0].clientSecret, '');

    getSettings().oidc = {
      providers: [
        {
          id: 'authentik',
          name: 'Authentik',
          issuerUrl: fake.issuer,
          clientId: fake.clientId,
          clientSecret: fake.clientSecret,
          logoUrl: '',
          scopes: 'openid',
          enabled: true,
          newUserSignUp: false,
        },
      ],
    };
    const shownToAll = JSON.stringify(getSettings().fullPublicSettings);
    assert.ok(!shownToAll.includes(fake.clientSecret));
    assert.ok(!shownToAll.includes(fake.clientId));
  });

  it('keeps the saved secret when left blank, only for the same issuer', async () => {
    await add();

    const kept = await request(app)
      .put('/api/v1/settings/oidc/authentik')
      .send(body({ clientSecret: '', name: 'Our Authentik' }));
    assert.equal(kept.status, 200, kept.text);
    assert.equal(kept.body.id, 'authentik', 'the id never changes');
    assert.equal(
      getSettings().oidc.providers[0].clientSecret,
      fake.clientSecret
    );
    assert.equal(getSettings().oidc.providers[0].name, 'Our Authentik');

    const moved = await request(app)
      .put('/api/v1/settings/oidc/authentik')
      .send(body({ clientSecret: '', issuerUrl: `${fake.issuer}-other` }));
    assert.equal(moved.status, 400);
    assert.equal(moved.body.message, 'Enter the client secret.');

    const tested = await request(app)
      .post('/api/v1/settings/oidc/test')
      .send({
        id: 'authentik',
        issuerUrl: `${fake.issuer}-other`,
        clientId: fake.clientId,
      });
    assert.equal(tested.status, 400);
    assert.equal(tested.body.message, 'Enter the client secret.');
  });

  it('tests a provider and says plainly what is wrong', async () => {
    const ok = await request(app)
      .post('/api/v1/settings/oidc/test')
      .send(body());
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.issuer, fake.issuer);

    const slash = await request(app)
      .post('/api/v1/settings/oidc/test')
      .send(body({ issuerUrl: `${fake.issuer}/` }));
    assert.equal(slash.status, 400);
    assert.equal(
      slash.body.message,
      `The provider gives its issuer URL as ${fake.issuer}. Enter exactly that (a slash at the end counts).`
    );

    const wrong = await request(app)
      .post('/api/v1/settings/oidc/test')
      .send(body({ issuerUrl: `${fake.issuer}/nothing-here` }));
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.message, /No sign-in details were found/);
    assert.match(wrong.body.message, /404/);

    fake.down = true;
    const down = await request(app)
      .post('/api/v1/settings/oidc/test')
      .send(body());
    assert.equal(down.status, 400);
    assert.match(down.body.message, /it answered 500/);
    fake.down = false;

    const nobody = await request(app)
      .post('/api/v1/settings/oidc/test')
      .send(body({ issuerUrl: 'http://127.0.0.1:1/realms/x' }));
    assert.equal(nobody.status, 400);
    assert.match(nobody.body.message, /127\.0\.0\.1:1/);
  });

  it('only takes an issuer over https, but for one on this machine', async () => {
    const res = await request(app)
      .post('/api/v1/settings/oidc/test')
      .send(body({ issuerUrl: 'http://auth.example.com/realms/x' }));

    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'The issuer URL must start with https://.');
    assert.equal(fake.discoveryCalls, 0);
  });

  it('refuses to save a provider that does not answer', async () => {
    fake.down = true;

    const res = await add();

    assert.equal(res.status, 400);
    assert.equal(getSettings().oidc.providers.length, 0);
  });

  it('always asks for openid, and takes a logo only over https', async () => {
    const scoped = await add({ scopes: 'email profile groups' });
    assert.equal(scoped.body.scopes, 'openid email profile groups');

    const logo = await add({
      name: 'Google',
      logoUrl: 'javascript:alert(1)',
    });
    assert.equal(logo.status, 400);
    const plain = await add({
      name: 'Google',
      logoUrl: 'http://example.com/g.svg',
    });
    assert.equal(plain.status, 400);
    const fine = await add({
      name: 'Google',
      logoUrl: 'https://example.com/g.svg',
    });
    assert.equal(fine.status, 201, fine.text);
  });

  it('never gives an id twice, not even a removed provider’s whose links remain', async () => {
    const first = await add();
    const second = await add();
    assert.deepEqual(
      [first.body.id, second.body.id],
      ['authentik', 'authentik-2']
    );

    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    await getRepository(OidcLink).save(
      new OidcLink({ user, provider: 'authentik', sub: 's' })
    );
    await request(app).delete('/api/v1/settings/oidc/authentik');
    const third = await add();
    assert.equal(third.body.id, 'authentik-3');

    const listed = await request(app).get('/api/v1/settings/oidc');
    assert.deepEqual(listed.body.takenIds.sort(), [
      'authentik',
      'authentik-2',
      'authentik-3',
    ]);
  });

  it('shows no callback address until the Application URL is set', async () => {
    getSettings().main.applicationUrl = '';
    await add();

    const listed = await request(app).get('/api/v1/settings/oidc');

    assert.equal(listed.body.applicationUrl, '');
    assert.equal(listed.body.providers[0].callbackUrl, null);
    assert.deepEqual(getSettings().fullPublicSettings.oidcProviders, []);
  });

  it('offers the switched-on providers on the sign-in page', async () => {
    await add({ logoUrl: '/images/authentik.svg' });
    await add({ name: 'Google', enabled: false });

    assert.deepEqual(getSettings().fullPublicSettings.oidcProviders, [
      { id: 'authentik', name: 'Authentik', logoUrl: '/images/authentik.svg' },
    ]);
  });
});
