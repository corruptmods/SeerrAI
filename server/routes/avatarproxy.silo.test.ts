import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import ImageProxy from '@server/lib/imageproxy';
import { getSettings } from '@server/lib/settings';
import avatarproxy, { checkAvatarChanged } from '@server/routes/avatarproxy';
import { setupTestDb } from '@server/test/db';
import { createFakeSilo } from '@server/test/fakeSilo';
import express from 'express';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';

/*
 * Silo account pictures: the chosen (else primary) profile's, fetched with
 * the key from Silo itself and without it from anywhere else, cached by the
 * picture rather than by a signed address that changes.
 */

setupTestDb();

const silo = createFakeSilo();
const app = express();
app.use('/avatarproxy', avatarproxy);

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'
);

// The stand-in comes from Gravatar; never fetched in tests.
const realGetImage = ImageProxy.prototype.getImage;
const standIns: string[] = [];
mock.method(
  ImageProxy.prototype,
  'getImage',
  async function (
    this: ImageProxy,
    ...args: Parameters<ImageProxy['getImage']>
  ) {
    if (/gravatar/.test(args[0])) {
      standIns.push(args[0]);
      return {
        imageBuffer: PNG,
        meta: {
          revalidateAfter: 0,
          curRevalidate: 60,
          isStale: false,
          etag: 'stand-in',
          extension: 'png',
          contentType: 'image/png',
          cacheKey: 'stand-in',
          cacheMiss: false,
        },
      };
    }
    return realGetImage.apply(this, args);
  }
);

before(() => silo.start());
after(() => silo.stop());

let accountId = '';
let n = 0;

beforeEach(async () => {
  silo.reset();
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.plex.connected = true;
  settings.silo = silo.settings();
  // A fresh account each test, so cached pictures don't carry over.
  accountId = `acct-${++n}-${Date.now()}`;
  silo.accounts = [
    {
      id: accountId,
      username: 'lantern',
      password: 'song',
      role: 'user',
      profiles: [
        {
          id: 'p-1',
          name: 'Lantern',
          is_primary: true,
          avatar: 'preset:fox',
          avatar_url: '/profile-avatars/fox.svg',
        },
        {
          id: 'p-2',
          name: 'Garden',
          is_primary: false,
          avatar: 'upload:abc',
          avatar_url: `http://localhost:${silo.port()}/signed/abc.png?sig=1`,
        },
      ],
    },
  ];
  silo.pictures.set('/profile-avatars/fox.svg', {
    contentType: 'image/svg+xml',
    body: SVG,
    needsKey: true,
  });
  for (const sig of ['1', '2']) {
    silo.pictures.set(`/signed/abc.png?sig=${sig}`, {
      contentType: 'image/png',
      body: PNG,
    });
  }
  await getRepository(User).update(2, {
    siloUserId: accountId,
    siloUsername: 'lantern',
    siloProfileId: null,
    userType: UserType.SILO,
  });
});

const pictureCalls = () =>
  silo.calls.filter((c) => !c.path.startsWith('/admin/'));

describe('Silo account pictures', () => {
  it('serves the primary profile’s picture, fetched from Silo with the key', async () => {
    const res = await request(app).get(`/avatarproxy/silo/${accountId}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/svg+xml');
    const fetched = pictureCalls();
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0].path, '/profile-avatars/fox.svg');
    assert.equal(fetched[0].auth, 'sa_test');
  });

  it('serves the chosen profile’s, from a signed address without the key, read again each time', async () => {
    await getRepository(User).update(2, { siloProfileId: 'p-2' });
    let res = await request(app).get(`/avatarproxy/silo/${accountId}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(pictureCalls().length, 1);
    assert.equal(pictureCalls()[0].auth, undefined, 'no key to other hosts');

    // The signed address changed; the picture didn't.
    silo.accounts[0].profiles![1].avatar_url = `http://localhost:${silo.port()}/signed/abc.png?sig=2`;
    res = await request(app).get(`/avatarproxy/silo/${accountId}`);
    assert.equal(res.status, 200);
    assert.equal(pictureCalls().length, 1, 'served from the cache');
    assert.equal(
      silo.calls.filter((c) => c.path.endsWith('/profiles')).length,
      2,
      'profiles read each time'
    );
  });

  it('notices a new picture, not a new signed address', async () => {
    const user = await getRepository(User).findOneByOrFail({ id: 2 });
    assert.equal((await checkAvatarChanged(user, 'silo')).changed, true);
    const version = user.avatarVersion;
    assert.ok(version);
    assert.equal((await checkAvatarChanged(user, 'silo')).changed, false);
    silo.accounts[0].profiles![0].avatar = 'preset:owl';
    assert.equal((await checkAvatarChanged(user, 'silo')).changed, true);
    assert.notEqual(user.avatarVersion, version);
  });

  it('gives a stand-in for an account nobody here has', async () => {
    const res = await request(app).get('/avatarproxy/silo/acct-nobody');
    assert.equal(pictureCalls().length, 0);
    assert.equal(res.status, 200);
    assert.equal(standIns.length > 0, true);
    assert.equal(
      (await request(app).get('/avatarproxy/silo/..%2Fadmin')).status,
      400
    );
  });
});
