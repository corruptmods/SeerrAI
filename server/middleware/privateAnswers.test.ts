import privateAnswers from '@server/middleware/privateAnswers';
import express from 'express';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';

describe('API answers', () => {
  const app = express();
  app.use('/api', privateAnswers);
  app.get('/api/v1/auth/me', (_req, res) => res.json({ id: 1 }));
  app.get('/api/v1/style/server.css', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('css').send('a{}');
  });

  it('are kept by no shared cache', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    assert.equal(res.headers['cache-control'], 'private, no-cache');
  });

  it('keep what a route says about caching itself', async () => {
    const res = await request(app).get('/api/v1/style/server.css');
    assert.equal(
      res.headers['cache-control'],
      'public, max-age=31536000, immutable'
    );
  });
});
