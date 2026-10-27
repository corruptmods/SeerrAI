import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import path from 'node:path';
import request from 'supertest';
import userRoutes from '.';

/*
 * A watchlist in a new order for each seed, through the API's validator as
 * the app runs it: the validator hands the seed over as a number.
 */

setupTestDb();

let app: Express;
let user: User;

before(() => {
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: User }).user = user;
    next();
  });
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  app.use('/api/v1/user', userRoutes);
});

beforeEach(async () => {
  user = await getRepository(User).findOneByOrFail({ id: 1 });
  for (let tmdbId = 1; tmdbId <= 12; tmdbId++) {
    const media = await getRepository(Media).save(
      new Media({ tmdbId, mediaType: MediaType.MOVIE })
    );
    await getRepository(Watchlist).save(
      Object.assign(new Watchlist(), {
        tmdbId,
        mediaType: MediaType.MOVIE,
        title: `Film ${tmdbId}`,
        requestedBy: user,
        media,
      })
    );
  }
});

const order = async (query: string) => {
  const res = await request(app).get(`/api/v1/user/1/watchlist${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body.results as { tmdbId: number }[]).map((r) => r.tmdbId);
};

describe('a watchlist’s order', () => {
  it('is the order added without a seed, and mixed by one', async () => {
    const added = await order('');
    assert.deepEqual(added, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const seeds = [1, 2, 3, 4, 5, 6].map((seed) => `?shuffle=${seed}`);
    const orders = await Promise.all(seeds.map(order));
    assert.ok(
      orders.some((o) => o.join() !== added.join()),
      'mixed by the seed'
    );
    assert.ok(
      new Set(orders.map((o) => o[0])).size > 1,
      'not every visit starts with the same title'
    );
    assert.deepEqual(
      await order('?shuffle=3'),
      orders[2],
      'same seed, same order'
    );
  });
});
