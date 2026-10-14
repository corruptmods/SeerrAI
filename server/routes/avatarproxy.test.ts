import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import ImageProxy from '@server/lib/imageproxy';
import { getSettings, jellyfinDefaults } from '@server/lib/settings';
import avatarproxy, { checkAvatarChanged } from '@server/routes/avatarproxy';
import { setupTestDb } from '@server/test/db';
import axios from 'axios';
import express from 'express';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';

setupTestDb();

/*
 * People's avatars from Jellyfin and Emby. Their stored address carries
 * only the account's id (/avatarproxy/<id>?v=…); the server is the one
 * whose column holds it, so an Emby install's avatars keep working once
 * Emby's ids have their own column.
 */

const JELLYFIN_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EMBY_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const asked: string[] = [];
/** The picture the server's cache holds, and the ETag its host sent. */
const held = { bytes: 'avatar', etag: 'etag' };
mock.method(ImageProxy.prototype, 'getImage', async (path: string) => {
  asked.push(path);
  return {
    imageBuffer: Buffer.from(held.bytes),
    meta: {
      revalidateAfter: 3600,
      curRevalidate: 3600,
      isStale: false,
      etag: held.etag,
      contentType: 'image/jpeg',
      extension: 'jpg',
      cacheKey: 'key',
      cacheMiss: false,
    },
  };
});
mock.method(ImageProxy.prototype, 'clearCachedImage', async () => undefined);
const headMock = mock.method(axios, 'head', async () => ({
  status: 200,
  headers: {
    etag: '"emby-tag"',
    'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
  },
}));

const app = express();
app.use('/avatarproxy', avatarproxy);
app.use(
  (
    err: { status?: number; message?: string },
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction
  ) => res.status(err.status ?? 500).json({ message: err.message })
);

const person = (columns: Partial<User>) =>
  getRepository(User).save(
    new User({
      email: `${columns.embyUserId ?? columns.jellyfinUserId}@example.com`,
      avatar: '',
      avatarVersion: '1',
      permissions: 0,
      ...columns,
    })
  );

beforeEach(() => {
  asked.length = 0;
  held.bytes = 'avatar';
  held.etag = 'etag';
  headMock.mock.resetCalls();
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.EMBY;
  settings.jellyfin = {
    ...jellyfinDefaults(),
    ip: 'jellyfin.lan',
    port: 8096,
    connected: false,
  };
  settings.emby = { ...jellyfinDefaults(), ip: 'emby.lan', port: 8920 };
});

describe('avatars from Jellyfin and Emby', () => {
  it("finds an Emby account's id in Emby's column", async () => {
    await person({
      embyUserId: EMBY_ID,
      embyUsername: 'emby-person',
      userType: UserType.EMBY,
    });
    const res = await request(app).get(`/avatarproxy/${EMBY_ID}?v=1`);
    assert.equal(res.status, 200);
    assert.equal(
      asked[0],
      `http://emby.lan:8920/Users/${EMBY_ID}/Images/Primary?quality=90`
    );
  });

  it("finds a Jellyfin account's id in Jellyfin's column", async () => {
    getSettings().jellyfin.connected = true;
    await person({
      jellyfinUserId: JELLYFIN_ID,
      jellyfinUsername: 'jellyfin-person',
      userType: UserType.JELLYFIN,
    });
    const res = await request(app).get(`/avatarproxy/${JELLYFIN_ID}?v=1`);
    assert.equal(res.status, 200);
    assert.equal(
      asked[0],
      `http://jellyfin.lan:8096/UserImage?UserId=${JELLYFIN_ID}`
    );
  });

  it('shows the stand-in picture for an account no one has', async () => {
    const res = await request(app).get(`/avatarproxy/${JELLYFIN_ID}`);
    assert.equal(res.status, 200);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /gravatar/);
  });

  it('tells a changed picture from the old one when its host sends no ETag', async () => {
    held.etag = '';
    held.bytes = 'first picture';
    const first = await request(app).get(`/avatarproxy/${JELLYFIN_ID}`);
    assert.equal(first.status, 200);
    const etag = first.headers.etag;
    assert.match(etag, /^"[0-9a-f]{64}"$/);

    for (const tag of [etag, `W/${etag}`, `"other", ${etag}`]) {
      const again = await request(app)
        .get(`/avatarproxy/${JELLYFIN_ID}`)
        .set('If-None-Match', tag);
      assert.equal(again.status, 304, tag);
      assert.equal(again.headers.etag, etag);
      assert.match(again.headers['cache-control'], /max-age=3600/);
    }

    held.bytes = 'second picture';
    const changed = await request(app)
      .get(`/avatarproxy/${JELLYFIN_ID}`)
      .set('If-None-Match', etag);
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.etag, etag);
  });

  it('keeps a picture a picture when opened on its own', async () => {
    const res = await request(app).get(`/avatarproxy/${JELLYFIN_ID}`);
    assert.match(res.headers['content-security-policy'], /sandbox/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  it('names the server in what it refuses', async () => {
    const res = await request(app).get('/avatarproxy/not-an-id');
    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'Provided URL is not an Emby avatar.');
    const hinted = await request(app).get(
      '/avatarproxy/not-an-id?server=jellyfin'
    );
    assert.equal(hinted.body.message, 'Provided URL is not a Jellyfin avatar.');
  });

  it("checks an Emby account's picture on Emby, by its tag", async () => {
    const user = await person({
      embyUserId: EMBY_ID,
      userType: UserType.EMBY,
      avatarVersion: 'old-tag',
    });
    const { changed } = await checkAvatarChanged(user);
    assert.equal(changed, true);
    assert.equal(
      headMock.mock.calls[0].arguments[0],
      `http://emby.lan:8920/Users/${EMBY_ID}/Images/Primary?quality=90`
    );
    const saved = await getRepository(User).findOneByOrFail({ id: user.id });
    assert.equal(saved.avatarVersion, 'emby-tag');
  });
});
