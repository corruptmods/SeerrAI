import { MusicBrainz } from '@server/api/musicbrainz';
import type {
  MbArtist,
  MbReleaseGroup,
} from '@server/api/musicbrainz/interfaces';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  VARIOUS_ARTISTS_MBID,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import { Permission } from '@server/lib/permissions';
import { getSettings, musicDefaults } from '@server/lib/settings';
import musicRoutes from '@server/routes/music';
import requestRoutes from '@server/routes/request';
import userRoutes from '@server/routes/user';
import { setupTestDb } from '@server/test/db';
import { createFakeLidarr } from '@server/test/fakeLidarr';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import path from 'node:path';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';

/*
 * Requesting music: the routes behind the real OpenAPI validator, with
 * MusicBrainz stubbed and a Lidarr on localhost for the requests that are
 * approved at once.
 */

setupTestDb();

const ARTIST = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const OTHER_ARTIST = '0383dadf-2a4e-4d10-a46a-e9e041da8eb3';
const OK_COMPUTER = '1b022e01-4da6-387b-8658-8678046e4cef';
const KID_A = 'b1392450-e666-3926-a536-22c65f834433';
const IN_RAINBOWS = '6e335887-60ba-38f0-95af-fae7774336bf';
const SOMEONE_ELSES = '9a3b1f2c-0000-4000-8000-000000000001';

const lidarr = createFakeLidarr();

let app: Server;
let port = 0;
let actingAs: User;

const group = (
  id: string,
  title: string,
  date: string,
  artistId = ARTIST
): MbReleaseGroup => ({
  id,
  title,
  'primary-type': 'Album',
  'secondary-types': [],
  'first-release-date': date,
  'artist-credit': [
    { name: 'X', joinphrase: '', artist: { id: artistId, name: 'X' } },
  ],
});

const DISCOGRAPHY = [
  group(OK_COMPUTER, 'OK Computer', '1997-05-21'),
  group(KID_A, 'Kid A', '2000-10-02'),
];

const call = async (
  method: string,
  pathname: string,
  body?: unknown
): Promise<{ status: number; body: never }> => {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${pathname}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : undefined) as never,
  };
};

const requestMusic = (body: Record<string, unknown>) =>
  call('POST', '/request/music', { artistMbid: ARTIST, ...body });

/** Someone with exactly these permissions, acting from now on. */
const actAs = async (permissions: number, email = 'listener@test.local') => {
  const repository = getRepository(User);
  const existing = await repository.findOneBy({ email });
  const user = existing ?? new User({ email, username: email, avatar: '' });
  user.permissions = permissions;
  actingAs = await repository.save(user);
  return actingAs;
};

const artistMedia = () =>
  getRepository(Media).findOneByOrFail({
    mediaType: MediaType.MUSIC,
    foreignId: ARTIST,
  });

const albumRow = (mbId: string) =>
  getRepository(MusicAlbum).findOneByOrFail({ mbId });

before(async () => {
  await lidarr.start();
  const ex = express();
  ex.use(express.json());
  ex.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  ex.use((req, _res, next) => {
    (req as unknown as { user?: User }).user = actingAs;
    next();
  });
  ex.use('/api/v1/request', requestRoutes);
  ex.use('/api/v1/user', userRoutes);
  ex.use('/api/v1/music', musicRoutes);
  ex.use(
    (
      err: { status?: number; message: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );
  app = await new Promise<Server>((resolve) => {
    const s = ex.listen(0, () => resolve(s));
  });
  port = (app.address() as { port: number }).port;
});

after(() => {
  app?.close();
  lidarr.stop();
});

beforeEach(async () => {
  const settings = getSettings();
  lidarr.reset();
  cacheManager.getCache('lidarr').flush();
  settings.lidarr = [lidarr.settings()];
  settings.music = musicDefaults();
  settings.main.disabledFeatures = [];
  settings.main.defaultQuotas.music = {};

  mock.method(MediaRequest, 'sendNotification', async () => true);
  mock.method(
    MusicBrainz.prototype,
    'getArtist',
    async (id: string) => ({ id, name: 'Radiohead' }) as MbArtist
  );
  mock.method(
    MusicBrainz.prototype,
    'keptArtistReleaseGroups',
    async (id: string) => (id === ARTIST ? DISCOGRAPHY : [])
  );
  mock.method(MusicBrainz.prototype, 'getReleaseGroup', async (id: string) =>
    id === IN_RAINBOWS
      ? group(IN_RAINBOWS, 'In Rainbows', '2007-10-10')
      : group(id, 'Not Theirs', '1990', OTHER_ARTIST)
  );

  await actAs(Permission.REQUEST);
});

afterEach(() => {
  mock.restoreAll();
  const settings = getSettings();
  settings.lidarr = [];
  settings.main.disabledFeatures = [];
  settings.main.defaultQuotas.music = {};
});

describe('POST /request/music', () => {
  it('asks for albums as one request, waiting for approval', async () => {
    const res = await requestMusic({ albums: [OK_COMPUTER, KID_A] });

    assert.equal(res.status, 201);
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id: (res.body as { id: number }).id },
    });
    assert.equal(request.type, MediaType.MUSIC);
    assert.equal(request.status, MediaRequestStatus.PENDING);
    assert.deepEqual(
      request.albums.map((album) => [album.albumMbid, album.title]).sort(),
      [
        [OK_COMPUTER, 'OK Computer'],
        [KID_A, 'Kid A'],
      ]
    );

    const media = await artistMedia();
    assert.equal(media.tmdbId, 0);
    assert.equal(media.foreignTitle, 'Radiohead');
    assert.equal(media.status, MediaStatus.PENDING);
    const ok = await albumRow(OK_COMPUTER);
    assert.equal(ok.status, MediaStatus.PENDING);
    assert.equal(ok.primaryType, 'Album');
    assert.equal(ok.releaseDate, '1997-05-21');
    assert.equal(lidarr.calls.length, 0, 'nothing goes to Lidarr yet');
  });

  it('looks up an album MusicBrainz has not listed under the artist yet', async () => {
    const res = await requestMusic({ albums: [IN_RAINBOWS] });
    assert.equal(res.status, 201);
    assert.equal((await albumRow(IN_RAINBOWS)).title, 'In Rainbows');
  });

  it("refuses someone else's album, Various Artists, and too many albums", async () => {
    let res = await requestMusic({ albums: [SOMEONE_ELSES] });
    assert.equal(res.status, 400);

    res = await call('POST', '/request/music', {
      artistMbid: VARIOUS_ARTISTS_MBID,
      albums: [OK_COMPUTER],
    });
    assert.equal(res.status, 400);

    getSettings().music.maxAlbumsPerRequest = 1;
    res = await requestMusic({ albums: [OK_COMPUTER, KID_A] });
    assert.equal(res.status, 400);
    assert.equal(
      await getRepository(MediaRequest).count({
        where: { type: MediaType.MUSIC },
      }),
      0
    );
  });

  it('is allowed by Request, or by Request Music alone, and nothing else', async () => {
    await actAs(Permission.REQUEST_MUSIC);
    assert.equal((await requestMusic({ albums: [OK_COMPUTER] })).status, 201);

    await actAs(Permission.REQUEST_MOVIE + Permission.REQUEST_TV, 'films@x');
    assert.equal((await requestMusic({ albums: [KID_A] })).status, 403);
  });

  it('is approved at once with Auto-Approve Music, past 32 bits, and sent to Lidarr', async () => {
    await actAs(Permission.REQUEST + Permission.AUTO_APPROVE_MUSIC);
    lidarr.lookupAlbums.set(OK_COMPUTER, {
      id: 0,
      title: 'OK Computer',
      foreignAlbumId: OK_COMPUTER,
      artistId: 0,
      monitored: false,
      artist: {
        id: 0,
        artistName: 'Radiohead',
        foreignArtistId: ARTIST,
        monitored: false,
        qualityProfileId: 0,
        metadataProfileId: 0,
        tags: [],
      },
    });

    const res = await requestMusic({ albums: [OK_COMPUTER] });

    assert.equal(res.status, 201);
    assert.equal(
      (res.body as { status: number }).status,
      MediaRequestStatus.APPROVED
    );
    await lidarr.waitFor(
      (c) => c.method === 'POST' && c.path === '/api/v1/album'
    );
    assert.equal(
      lidarr.calls.filter((c) => c.path === '/api/v1/album').length,
      1
    );
    assert.equal((await artistMedia()).status, MediaStatus.PROCESSING);
    assert.equal((await albumRow(OK_COMPUTER)).status, MediaStatus.PROCESSING);
    const [album] = await getRepository(AlbumRequest).find();
    assert.equal(album.status, MediaRequestStatus.APPROVED);
  });

  it('waits for approval with only Auto-Approve for another kind', async () => {
    await actAs(Permission.REQUEST + Permission.AUTO_APPROVE_MOVIE);
    const res = await requestMusic({ albums: [OK_COMPUTER] });
    assert.equal(
      (res.body as { status: number }).status,
      MediaRequestStatus.PENDING
    );
  });

  it('leaves out albums already asked for or already here', async () => {
    assert.equal((await requestMusic({ albums: [OK_COMPUTER] })).status, 201);

    await actAs(Permission.REQUEST, 'second@x');
    assert.equal((await requestMusic({ albums: [OK_COMPUTER] })).status, 409);

    const media = await artistMedia();
    await dataSource.manager.save(
      new MusicAlbum({
        mediaId: media.id,
        mbId: IN_RAINBOWS,
        title: 'In Rainbows',
        secondaryTypes: [],
        status: MediaStatus.AVAILABLE,
      }),
      { listeners: false }
    );

    const res = await requestMusic({
      albums: [OK_COMPUTER, KID_A, IN_RAINBOWS],
    });
    assert.equal(res.status, 201);
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id: (res.body as { id: number }).id },
    });
    assert.deepEqual(
      request.albums.map((album) => album.albumMbid),
      [KID_A]
    );
  });

  it('counts albums against the music quota', async () => {
    const user = await actAs(Permission.REQUEST);
    await getRepository(User).update(user.id, {
      musicQuotaLimit: 2,
      musicQuotaDays: 7,
    });
    actingAs = await getRepository(User).findOneByOrFail({ id: user.id });

    let res = await requestMusic({
      albums: [OK_COMPUTER, KID_A, IN_RAINBOWS],
    });
    assert.equal(res.status, 403);
    assert.equal(
      (res.body as { message: string }).message,
      'You can request 2 more albums.'
    );

    res = await requestMusic({ albums: [OK_COMPUTER, KID_A] });
    assert.equal(res.status, 201);

    const quota = await call('GET', `/user/${user.id}/quota`);
    assert.deepEqual((quota.body as { music: unknown }).music, {
      days: 7,
      limit: 2,
      used: 2,
      remaining: 0,
      restricted: true,
    });

    res = await requestMusic({ albums: [IN_RAINBOWS] });
    assert.equal(res.status, 403);
    assert.equal(
      (res.body as { message: string }).message,
      'Music Quota exceeded.'
    );

    // A declined request gives its albums back.
    await getRepository(MediaRequest).update(
      { type: MediaType.MUSIC },
      { status: MediaRequestStatus.DECLINED }
    );
    res = await requestMusic({ albums: [IN_RAINBOWS] });
    assert.equal(res.status, 201);
  });

  it('follows the default music quota, which managers may bypass', async () => {
    getSettings().main.defaultQuotas.music = { quotaLimit: 1, quotaDays: 7 };
    const listener = await actAs(Permission.REQUEST);
    assert.equal((await requestMusic({ albums: [OK_COMPUTER] })).status, 201);
    assert.equal((await requestMusic({ albums: [KID_A] })).status, 403);

    await actAs(
      Permission.MANAGE_REQUESTS + Permission.MANAGE_USERS,
      'manager@x'
    );
    const res = await requestMusic({
      albums: [KID_A],
      userId: listener.id,
      ignoreQuota: true,
    });
    assert.equal(res.status, 201);
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id: (res.body as { id: number }).id },
    });
    assert.equal(request.requestedBy.id, listener.id);
    assert.equal(request.ignoreQuota, true);
  });

  it('keeps the advanced options for those allowed them', async () => {
    let res = await requestMusic({
      albums: [OK_COMPUTER],
      profileId: 9,
      metadataProfileId: 9,
      rootFolder: '/secret',
    });
    let request = await getRepository(MediaRequest).findOneByOrFail({
      id: (res.body as { id: number }).id,
    });
    assert.equal(request.profileId, null);
    assert.equal(request.metadataProfileId, null);
    assert.equal(request.rootFolder, null);

    await actAs(Permission.REQUEST + Permission.REQUEST_ADVANCED, 'adv@x');
    res = await requestMusic({
      albums: [KID_A],
      profileId: 9,
      metadataProfileId: 4,
      rootFolder: '/flac',
    });
    request = await getRepository(MediaRequest).findOneByOrFail({
      id: (res.body as { id: number }).id,
    });
    assert.equal(request.profileId, 9);
    assert.equal(request.metadataProfileId, 4);
    assert.equal(request.rootFolder, '/flac');
  });

  it('is refused while music is off or not set up', async () => {
    getSettings().main.disabledFeatures = ['music'];
    assert.equal((await requestMusic({ albums: [OK_COMPUTER] })).status, 403);

    getSettings().main.disabledFeatures = [];
    getSettings().lidarr = [];
    assert.equal((await requestMusic({ albums: [OK_COMPUTER] })).status, 404);
  });
});

describe('music requests in the lists', () => {
  it('are listed by default for someone with music, with their albums', async () => {
    const res = await requestMusic({ albums: [OK_COMPUTER] });
    const id = (res.body as { id: number }).id;

    await actAs(Permission.MANAGE_REQUESTS, 'manager@x');
    let list = await call('GET', '/request?filter=all&take=10');
    const listed = (
      list.body as {
        results: {
          id: number;
          albums: { albumMbid: string; albumStatus: number }[];
        }[];
      }
    ).results;
    assert.deepEqual(
      listed.map((request) => request.id),
      [id]
    );
    assert.equal(listed[0].albums[0].albumMbid, OK_COMPUTER);
    assert.equal(listed[0].albums[0].albumStatus, MediaStatus.PENDING);

    list = await call('GET', '/request?mediaType=movie%2Ctv');
    assert.equal((list.body as { results: unknown[] }).results.length, 0);

    getSettings().main.disabledFeatures = ['music'];
    list = await call('GET', '/request?mediaType=music');
    assert.equal((list.body as { results: unknown[] }).results.length, 0);
  });

  it("are on someone's own requests page, and the count", async () => {
    const listener = actingAs;
    await requestMusic({ albums: [OK_COMPUTER] });

    let mine = await call('GET', `/user/${listener.id}/requests`);
    const results = (
      mine.body as {
        results: { type: string; albums: { title: string }[] }[];
      }
    ).results;
    assert.equal(results.length, 1);
    assert.equal(results[0].type, 'music');
    assert.equal(results[0].albums[0].title, 'OK Computer');
    let count = await call('GET', '/request/count');
    assert.equal((count.body as { music: number }).music, 1);

    // Without Lidarr, music leaves the counts as it leaves the lists.
    getSettings().lidarr = [];
    mine = await call('GET', `/user/${listener.id}/requests`);
    assert.equal((mine.body as { results: unknown[] }).results.length, 0);
    count = await call('GET', '/request/count');
    assert.equal((count.body as { music: number }).music, 0);
  });

  it('show one request with its albums', async () => {
    const res = await requestMusic({ albums: [OK_COMPUTER] });
    const one = await call(
      'GET',
      `/request/${(res.body as { id: number }).id}`
    );
    assert.equal(
      (one.body as { albums: { albumStatus: number }[] }).albums[0].albumStatus,
      MediaStatus.PENDING
    );
  });
});

describe('changing a music request', () => {
  it('takes albums off and puts others on, without sending anything', async () => {
    const res = await requestMusic({ albums: [OK_COMPUTER, KID_A] });
    const id = (res.body as { id: number }).id;

    const edit = await call('PUT', `/request/${id}`, {
      mediaType: 'music',
      albums: [KID_A, IN_RAINBOWS],
    });

    assert.equal(edit.status, 200);
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id },
    });
    assert.deepEqual(
      request.albums.map((album) => album.albumMbid).sort(),
      [IN_RAINBOWS, KID_A].sort()
    );
    assert.equal(request.status, MediaRequestStatus.PENDING);
    assert.equal((await albumRow(OK_COMPUTER)).status, MediaStatus.UNKNOWN);
    assert.equal((await albumRow(IN_RAINBOWS)).status, MediaStatus.PENDING);
    assert.equal(
      await getRepository(AlbumRequest).count(),
      2,
      'no album is left behind without its request'
    );
    assert.equal(lidarr.calls.length, 0);
  });

  it('cannot take every album off, or change someone else’s', async () => {
    const res = await requestMusic({ albums: [OK_COMPUTER] });
    const id = (res.body as { id: number }).id;

    let edit = await call('PUT', `/request/${id}`, {
      mediaType: 'music',
      albums: [],
    });
    assert.equal(edit.status, 400);

    await actAs(Permission.REQUEST, 'other@x');
    edit = await call('PUT', `/request/${id}`, {
      mediaType: 'music',
      albums: [KID_A],
    });
    assert.equal(edit.status, 403);
  });

  it('when declined, frees its albums and keeps the reason', async () => {
    const res = await requestMusic({ albums: [OK_COMPUTER] });
    const id = (res.body as { id: number }).id;

    await actAs(Permission.MANAGE_REQUESTS, 'manager@x');
    const declined = await call('POST', `/request/${id}/decline`, {
      declineReason: 'Not on Lidarr’s indexers',
    });

    assert.equal(declined.status, 200);
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id },
    });
    assert.equal(request.status, MediaRequestStatus.DECLINED);
    assert.equal(request.declineReason, 'Not on Lidarr’s indexers');
    assert.equal(request.albums[0].status, MediaRequestStatus.DECLINED);
    assert.equal((await albumRow(OK_COMPUTER)).status, MediaStatus.UNKNOWN);
    assert.equal((await artistMedia()).status, MediaStatus.UNKNOWN);
    assert.equal(lidarr.calls.length, 0);
  });

  it('when deleted, frees its albums to be asked for again', async () => {
    const res = await requestMusic({ albums: [OK_COMPUTER] });
    const id = (res.body as { id: number }).id;

    const deleted = await call('DELETE', `/request/${id}`);

    assert.equal(deleted.status, 204);
    assert.equal((await albumRow(OK_COMPUTER)).status, MediaStatus.UNKNOWN);
    assert.equal((await artistMedia()).status, MediaStatus.UNKNOWN);
    assert.equal(await getRepository(AlbumRequest).count(), 0);
    assert.equal((await requestMusic({ albums: [OK_COMPUTER] })).status, 201);
  });

  it('when approved, is sent to Lidarr', async () => {
    lidarr.lookupArtists.set(ARTIST, {
      id: 0,
      artistName: 'Radiohead',
      foreignArtistId: ARTIST,
      monitored: false,
      qualityProfileId: 0,
      metadataProfileId: 0,
      tags: [],
    });
    const res = await requestMusic({ albums: [OK_COMPUTER, KID_A] });
    const id = (res.body as { id: number }).id;

    await actAs(Permission.MANAGE_REQUESTS, 'manager@x');
    const approved = await call('POST', `/request/${id}/approve`);
    assert.equal(approved.status, 200);
    await lidarr.waitFor(
      (c) => c.method === 'POST' && c.path === '/api/v1/artist'
    );

    const sent = lidarr.calls.find(
      (c) => c.method === 'POST' && c.path === '/api/v1/artist'
    );
    assert.deepEqual(
      (sent?.body?.addOptions as { albumsToMonitor: string[] }).albumsToMonitor,
      [OK_COMPUTER, KID_A]
    );
    assert.equal((await albumRow(KID_A)).status, MediaStatus.PROCESSING);
    assert.equal((await artistMedia()).status, MediaStatus.PROCESSING);
  });
});

describe('a music request’s history', () => {
  type Entry = {
    type: string;
    detail: string | null;
    user: { displayName: string } | null;
  };
  const history = async () => {
    const res = await call('GET', `/music/artist/${ARTIST}/history`);
    assert.equal(res.status, 200);
    return (res.body as Entry[])
      .map((e) => [e.type, e.detail, e.user?.displayName ?? null])
      .reverse();
  };

  beforeEach(() => {
    lidarr.lookupArtists.set(ARTIST, {
      id: 0,
      artistName: 'Radiohead',
      foreignArtistId: ARTIST,
      monitored: false,
      qualityProfileId: 0,
      metadataProfileId: 0,
      tags: [],
    });
  });

  it('is kept by the artist: asked for, approved, on its way', async () => {
    await actAs(Permission.REQUEST);
    const res = await requestMusic({ albums: [OK_COMPUTER, KID_A] });
    const id = (res.body as { id: number }).id;

    await actAs(Permission.MANAGE_REQUESTS, 'manager@x');
    await call('POST', `/request/${id}/approve`);
    await lidarr.waitFor(
      (c) => c.method === 'POST' && c.path === '/api/v1/artist'
    );

    assert.deepEqual(await history(), [
      ['requested', '2 albums: OK Computer, Kid A', 'listener@test.local'],
      ['approved', null, 'manager@x'],
      ['processing', null, null],
    ]);
  });

  it('says why Lidarr could not take it', async () => {
    const res = await requestMusic({ albums: [OK_COMPUTER] });
    const id = (res.body as { id: number }).id;
    lidarr.down = true;

    await actAs(Permission.MANAGE_REQUESTS, 'manager@x');
    await call('POST', `/request/${id}/approve`);
    await lidarr.waitFor(() => false);

    const failed = (await history()).find(([type]) => type === 'failed');
    assert.match(String(failed?.[1]), /^Lidarr could not take the request/);
  });

  it('is for request managers and admins only', async () => {
    await requestMusic({ albums: [OK_COMPUTER] });
    const res = await call('GET', `/music/artist/${ARTIST}/history`);
    assert.equal(res.status, 403);
  });
});
