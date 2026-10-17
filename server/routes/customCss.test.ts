import { SERVER_CSS_MAX_BYTES } from '@server/constants/customCss';
import { SERVER_THEME_DEFAULTS } from '@server/constants/theme';
import { getRepository } from '@server/datasource';
import { UserSettings } from '@server/entity/UserSettings';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import settingsRoutes from '@server/routes/settings';
import styleRoutes from '@server/routes/style';
import userRoutes from '@server/routes/user';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import request from 'supertest';

/*
 * Custom CSS and theme files on the server: the admin's Server CSS and
 * whether people may add their own (Settings → Appearance), a person's own
 * CSS (Profile → Settings → Appearance), the stylesheets pages load, and a
 * theme file as the server's default.
 */

setupTestDb();

const app = express();
app.use(express.json());
app.use(
  session({ secret: 'test-secret', resave: false, saveUninitialized: false })
);
app.use(
  OpenApiValidator.middleware({
    apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
    validateRequests: true,
    validateSecurity: false,
  })
);
app.use(checkUser);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/user', isAuthenticated(), userRoutes);
app.use('/api/v1/settings', isAuthenticated(Permission.ADMIN), settingsRoutes);
app.use('/api/v1/style', styleRoutes);
app.use(
  (
    err: { status?: number; message: string },
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction
  ) => {
    res.status(err.status ?? 500).json({ message: err.message });
  }
);

const signIn = async (email: string) => {
  getSettings().main.localLogin = true;
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/local')
    .send({ email, password: 'test1234' });
  assert.equal(res.status, 200);
  return { agent, userId: res.body.id as number };
};

beforeEach(() => {
  const appearance = getSettings().appearance;
  appearance.default = { ...SERVER_THEME_DEFAULTS };
  appearance.serverCss = '';
  appearance.personalCss = false;
});

const nord =
  '@import url("https://theme-park.dev/css/base/overseerr/nord.css");\n[data-seerr="button"] { border-radius: 999px; }';

describe('Server CSS', () => {
  it('is empty on a new server, with people’s own CSS off', async () => {
    const { agent } = await signIn('admin@seerr.dev');
    const res = await agent.get('/api/v1/settings/appearance/css');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { css: '', personalCss: false });
    assert.deepEqual(getSettings().fullPublicSettings.customCss, {
      server: null,
      personal: false,
    });
  });

  it('is kept, and every page then loads it, the sign-in page included', async () => {
    const { agent } = await signIn('admin@seerr.dev');
    const saved = await agent
      .post('/api/v1/settings/appearance/css')
      .send({ css: `  ${nord}\n`, personalCss: true });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { css: nord, personalCss: true });

    const { server, personal } = getSettings().fullPublicSettings.customCss;
    assert.match(server ?? '', /^[0-9a-f]{12}$/);
    assert.equal(personal, true);

    // No one needs to be signed in to fetch it.
    const sheet = await request(app).get(
      `/api/v1/style/server.css?v=${server}`
    );
    assert.equal(sheet.status, 200);
    assert.match(sheet.headers['content-type'], /^text\/css/);
    assert.equal(sheet.headers['x-content-type-options'], 'nosniff');
    assert.equal(sheet.text, nord);
    assert.match(sheet.headers['cache-control'], /immutable/);

    // An old version's address is never kept.
    const old = await request(app).get('/api/v1/style/server.css?v=0ld');
    assert.equal(old.text, nord);
    assert.equal(old.headers['cache-control'], 'no-store');
  });

  it('is only for admins, and has a size limit', async () => {
    const { agent } = await signIn('friend@seerr.dev');
    assert.equal(
      (
        await agent
          .post('/api/v1/settings/appearance/css')
          .send({ css: 'a{}', personalCss: true })
      ).status,
      403
    );
    const admin = await signIn('admin@seerr.dev');
    for (const body of [
      { css: 'a{}'.padEnd(SERVER_CSS_MAX_BYTES + 1), personalCss: false },
      { css: 12, personalCss: false },
      { css: 'a{}', personalCss: 'yes' },
      { css: 'a{}', personalCss: false, extra: 1 },
    ]) {
      const res = await admin.agent
        .post('/api/v1/settings/appearance/css')
        .send(body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    }
    assert.equal(getSettings().appearance.serverCss, '');
  });
});

describe('a person’s own CSS', () => {
  const mine = '[data-seerr="title-card"] { border-radius: 4px; }';

  it('can only be added when an admin lets people', async () => {
    const { agent, userId } = await signIn('friend@seerr.dev');
    const before = await agent.get(`/api/v1/user/${userId}/settings/css`);
    assert.deepEqual(before.body, { css: '', allowed: false });
    const refused = await agent
      .post(`/api/v1/user/${userId}/settings/css`)
      .send({ css: mine });
    assert.equal(refused.status, 403);
  });

  it('is kept, and loaded on their pages only', async () => {
    getSettings().appearance.personalCss = true;
    const { agent, userId } = await signIn('friend@seerr.dev');
    const saved = await agent
      .post(`/api/v1/user/${userId}/settings/css`)
      .send({ css: `${mine}\n\n` });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { css: mine, allowed: true });

    const version = (await agent.get('/api/v1/auth/me')).body.settings
      .personalCssVersion;
    assert.match(version, /^[0-9a-f]{12}$/);
    const sheet = await agent.get(`/api/v1/style/personal.css?v=${version}`);
    assert.equal(sheet.text, mine);
    assert.match(sheet.headers['content-type'], /^text\/css/);
    assert.match(sheet.headers['cache-control'], /^private/);

    // Not someone else's, nor anyone's before they sign in.
    const admin = await signIn('admin@seerr.dev');
    assert.equal(
      (await admin.agent.get('/api/v1/style/personal.css')).text,
      ''
    );
    assert.equal(
      (await admin.agent.get('/api/v1/auth/me')).body.settings
        ?.personalCssVersion ?? null,
      null
    );
    assert.equal(
      (await request(app).get('/api/v1/style/personal.css')).text,
      ''
    );

    // Switched off, it stops at once, though it is kept for them.
    getSettings().appearance.personalCss = false;
    assert.equal((await agent.get('/api/v1/style/personal.css')).text, '');
    assert.equal(
      (await agent.get('/api/v1/auth/me')).body.settings.personalCssVersion,
      null
    );
    assert.equal(
      (await agent.get(`/api/v1/user/${userId}/settings/css`)).body.css,
      mine
    );
  });

  it('is cleared by saving nothing', async () => {
    getSettings().appearance.personalCss = true;
    const { agent, userId } = await signIn('friend@seerr.dev');
    await agent.post(`/api/v1/user/${userId}/settings/css`).send({ css: mine });
    const cleared = await agent
      .post(`/api/v1/user/${userId}/settings/css`)
      .send({ css: '  ' });
    assert.deepEqual(cleared.body, { css: '', allowed: true });
    const stored = await getRepository(UserSettings).findOneOrFail({
      where: { user: { id: userId } },
    });
    assert.equal(stored.customCss, null);
  });

  it('says what is wrong with a style that would reach elsewhere', async () => {
    getSettings().appearance.personalCss = true;
    const { agent, userId } = await signIn('friend@seerr.dev');
    const res = await agent
      .post(`/api/v1/user/${userId}/settings/css`)
      .send({ css: 'a { background: url(https://evil.example/?k=1) }' });
    assert.equal(res.status, 400);
    assert.equal(res.body.problem, 'url');
    assert.equal(res.body.detail, 'https://evil.example/?k=1');
    for (const css of ['@import "x.css";', 'a{b:expression(1)}', 12]) {
      assert.equal(
        (await agent.post(`/api/v1/user/${userId}/settings/css`).send({ css }))
          .status,
        400,
        String(css)
      );
    }
  });

  it('is checked again when served, in case it was kept by an older check', async () => {
    getSettings().appearance.personalCss = true;
    const { agent, userId } = await signIn('friend@seerr.dev');
    await agent.post(`/api/v1/user/${userId}/settings/css`).send({ css: mine });
    const stored = await getRepository(UserSettings).findOneOrFail({
      where: { user: { id: userId } },
    });
    await getRepository(UserSettings).update(stored.id, {
      customCss: '@import "https://evil.example/x.css";',
    });
    assert.equal((await agent.get('/api/v1/style/personal.css')).text, '');
  });

  it('is theirs: others need to manage users, and no one but the owner edits the owner’s', async () => {
    getSettings().appearance.personalCss = true;
    const { agent } = await signIn('friend@seerr.dev');
    assert.equal((await agent.get('/api/v1/user/1/settings/css')).status, 403);
    assert.equal(
      (await agent.post('/api/v1/user/1/settings/css').send({ css: mine }))
        .status,
      403
    );
  });
});

describe('a theme file as the server’s default', () => {
  it('is kept with the default and given to every page', async () => {
    const { agent } = await signIn('admin@seerr.dev');
    const theme = {
      seerrTheme: 1,
      name: 'Ember',
      dark: { page: '#1C1917' },
      accent: { fill: '#be123c' },
    };
    const look = {
      mode: 'dark',
      accent: 'custom',
      customAccent: '#be123c',
      background: 'warm',
    };
    const res = await agent
      .post('/api/v1/settings/appearance')
      .send({ default: { ...look, theme } });
    assert.equal(res.status, 200);
    const kept = { ...look, theme: { ...theme, dark: { page: '#1c1917' } } };
    assert.deepEqual(res.body.default, kept);
    assert.deepEqual(getSettings().fullPublicSettings.themeDefault, kept);

    const refused = await agent.post('/api/v1/settings/appearance').send({
      default: { ...look, theme: { ...theme, dark: { page: 'url(x)' } } },
    });
    assert.equal(refused.status, 400);
  });
});
