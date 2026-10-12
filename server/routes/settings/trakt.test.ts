import TraktAPI, { TraktError } from '@server/api/trakt';
import { getSettings } from '@server/lib/settings';
import traktSettingsRoutes from '@server/routes/settings/trakt';
import express from 'express';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

const app = express();
app.use(express.json());
app.use('/settings/trakt', traktSettingsRoutes);

const ID = 'a'.repeat(64);
let checked: string[] = [];
let refuse: TraktError | undefined;

beforeEach(() => {
  checked = [];
  refuse = undefined;
  getSettings().trakt = {};
  Object.defineProperty(TraktAPI.prototype, 'check', {
    configurable: true,
    writable: true,
    value: async function (this: {
      axios: { defaults: { headers: Record<string, string> } };
    }) {
      checked.push(this.axios.defaults.headers['trakt-api-key']);
      if (refuse) throw refuse;
    },
  });
});

afterEach(() => {
  getSettings().trakt = {};
});

describe('Trakt in Settings', () => {
  it('tests a Client ID with Trakt before saving it, and never shows it', async () => {
    const saved = await request(app)
      .post('/settings/trakt')
      .send({ clientId: ` ${ID} ` });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { hasClientId: true });
    assert.deepEqual(checked, [ID]);
    assert.equal(getSettings().trakt.clientId, ID);
    assert.deepEqual((await request(app).get('/settings/trakt')).body, {
      hasClientId: true,
    });
  });

  it('keeps nothing Trakt turns down, and says why', async () => {
    refuse = new TraktError('badKey', 'Trakt did not accept the Client ID.');
    const refused = await request(app)
      .post('/settings/trakt')
      .send({ clientId: ID });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.problem, 'badKey');
    assert.equal(getSettings().trakt.clientId, undefined);

    const malformed = await request(app)
      .post('/settings/trakt/test')
      .send({ clientId: 'not an id' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.problem, 'format');
    assert.equal(checked.length, 1, 'a malformed one is not sent to Trakt');
  });

  it('removes it', async () => {
    getSettings().trakt = { clientId: ID };
    const removed = await request(app).delete('/settings/trakt');
    assert.deepEqual(removed.body, { hasClientId: false });
    assert.deepEqual(getSettings().trakt, {});
  });
});
