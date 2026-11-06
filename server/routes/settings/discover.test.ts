import { DiscoverSliderType } from '@server/constants/discover';
import { getRepository } from '@server/datasource';
import DiscoverSlider from '@server/entity/DiscoverSlider';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import request from 'supertest';

/*
 * Resetting Discover (Settings → Discover → Reset): built-in rows only, and
 * no one's hidden rows, behind the real OpenAPI validator.
 */

setupTestDb();

const app = express();
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction
  ) => {
    res.status(err.status ?? 500).json({ message: err.message });
  }
);

let userId = 0;

beforeEach(async () => {
  await DiscoverSlider.bootstrapSliders();
  await getRepository(DiscoverSlider).save(
    new DiscoverSlider({
      type: DiscoverSliderType.TMDB_SEARCH,
      title: 'Lantern Song picks',
      data: 'Lantern Song',
      isBuiltIn: false,
      enabled: true,
      order: 99,
    })
  );
  const user = await getRepository(User).save(
    new User({ email: `discover-${Math.random()}@example.invalid`, avatar: '' })
  );
  await getRepository(UserSettings).save(
    new UserSettings({ user, hiddenSliders: [1, 2] })
  );
  userId = user.id;
});

const custom = () =>
  getRepository(DiscoverSlider).findOne({
    where: { title: 'Lantern Song picks' },
  });

const hidden = async () =>
  (
    await getRepository(UserSettings).findOneOrFail({
      where: { user: { id: userId } },
    })
  ).hiddenSliders;

describe('resetting Discover', () => {
  it('is not done by a GET', async () => {
    const res = await request(app).get('/api/v1/settings/discover/reset');
    assert.equal(res.status, 405);
    assert.ok(await custom());
    assert.deepEqual(await hidden(), [1, 2]);
  });

  it('keeps only the built-in rows and clears hidden rows', async () => {
    const res = await request(app).post('/api/v1/settings/discover/reset');
    assert.equal(res.status, 204);
    assert.equal(await custom(), null);
    assert.ok(
      (await getRepository(DiscoverSlider).find()).every((s) => s.isBuiltIn)
    );
    assert.deepEqual(await hidden(), []);
  });
});
