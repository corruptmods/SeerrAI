import apiPathCase from '@server/middleware/apiPathCase';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import request from 'supertest';

describe('the API base path', () => {
  const app = express();
  app.use(apiPathCase);
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  // A route the spec doesn't document.
  app.get('/api/v1/static-garden', (_req, res) => res.json({ reached: true }));
  app.get('/api/v1/status', (req, res) =>
    res.json({ url: req.url, originalUrl: req.originalUrl })
  );
  app.use(
    (
      err: { status?: number },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({})
  );

  it('keeps routes the spec does not document out, in any case', async () => {
    for (const prefix of ['/api/v1', '/API/V1', '/Api/v1']) {
      const res = await request(app).get(`${prefix}/static-garden`);
      assert.equal(res.status, 404, prefix);
      assert.equal(res.body.reached, undefined, prefix);
    }
  });

  it('reaches documented routes in any case, as written in the spec', async () => {
    const res = await request(app).get(
      '/API/V1/status?checkUpdateAvailable=false'
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      url: '/api/v1/status?checkUpdateAvailable=false',
      originalUrl: '/api/v1/status?checkUpdateAvailable=false',
    });
  });

  it('leaves other paths alone', async () => {
    const res = await request(app).get('/API/v10/status');
    assert.equal(res.status, 404);
  });
});
