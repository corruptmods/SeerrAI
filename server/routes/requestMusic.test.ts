import { MusicBrainz } from '@server/api/musicbrainz';
import type {
  MbArtist,
  MbRecording,
  MbRecordingRelease,
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
import SongRequest from '@server/entity/SongRequest';
import { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import { completeMusicRequests } from '@server/lib/music/completion';
import notificationManager, { Notification } from '@server/lib/notifications';
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

const ARTIST = '3c9e5f21-8d47-4b6a-a1e3-5f7d2c90b844';
const OTHER_ARTIST = '5c72e1b9-4f3d-4a86-b917-d2a8f60c3e51';
const STATIC_GARDEN = '4f6a2d93-c1e8-3a57-9b02-6d3e8f1c7a40';
const FOG_B = '7e41c0d8-5b29-3f6c-b8a4-91d6e2f07a35';
const IN_LANTERNS = '1d84b6f2-9e07-3c5a-a4d8-e3f2b7091c6d';
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
  group(STATIC_GARDEN, 'Static Garden', '1997-05-21'),
  group(FOG_B, 'Fog B', '2000-10-02'),
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
    async (id: string) => ({ id, name: 'Glasswing' }) as MbArtist
  );
  mock.method(
    MusicBrainz.prototype,
    'keptArtistReleaseGroups',
    async (id: string) => (id === ARTIST ? DISCOGRAPHY : [])
  );
  mock.method(MusicBrainz.prototype, 'getReleaseGroup', async (id: string) =>
    id === IN_LANTERNS
      ? group(IN_LANTERNS, 'In Lanterns', '2007-10-10')
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
    const res = await requestMusic({ albums: [STATIC_GARDEN, FOG_B] });

    assert.equal(res.status, 201);
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id: (res.body as { id: number }).id },
    });
    assert.equal(request.type, MediaType.MUSIC);
    assert.equal(request.status, MediaRequestStatus.PENDING);
    assert.deepEqual(
      request.albums.map((album) => [album.albumMbid, album.title]).sort(),
      [
        [STATIC_GARDEN, 'Static Garden'],
        [FOG_B, 'Fog B'],
      ]
    );

    const media = await artistMedia();
    assert.equal(media.tmdbId, 0);
    assert.equal(media.foreignTitle, 'Glasswing');
    assert.equal(media.status, MediaStatus.PENDING);
    const ok = await albumRow(STATIC_GARDEN);
    assert.equal(ok.status, MediaStatus.PENDING);
    assert.equal(ok.primaryType, 'Album');
    assert.equal(ok.releaseDate, '1997-05-21');
    assert.equal(lidarr.calls.length, 0, 'nothing goes to Lidarr yet');
  });

  it('looks up an album MusicBrainz has not listed under the artist yet', async () => {
    const res = await requestMusic({ albums: [IN_LANTERNS] });
    assert.equal(res.status, 201);
    assert.equal((await albumRow(IN_LANTERNS)).title, 'In Lanterns');
  });

  it("refuses someone else's album, Various Artists, and too many albums", async () => {
    let res = await requestMusic({ albums: [SOMEONE_ELSES] });
    assert.equal(res.status, 400);

    res = await call('POST', '/request/music', {
      artistMbid: VARIOUS_ARTISTS_MBID,
      albums: [STATIC_GARDEN],
    });
    assert.equal(res.status, 400);

    getSettings().music.maxAlbumsPerRequest = 1;
    res = await requestMusic({ albums: [STATIC_GARDEN, FOG_B] });
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
    assert.equal((await requestMusic({ albums: [STATIC_GARDEN] })).status, 201);

    await actAs(Permission.REQUEST_MOVIE + Permission.REQUEST_TV, 'films@x');
    assert.equal((await requestMusic({ albums: [FOG_B] })).status, 403);
  });

  it('is approved at once with Auto-Approve Music, past 32 bits, and sent to Lidarr', async () => {
    await actAs(Permission.REQUEST + Permission.AUTO_APPROVE_MUSIC);
    lidarr.lookupAlbums.set(STATIC_GARDEN, {
      id: 0,
      title: 'Static Garden',
      foreignAlbumId: STATIC_GARDEN,
      artistId: 0,
      monitored: false,
      artist: {
        id: 0,
        artistName: 'Glasswing',
        foreignArtistId: ARTIST,
        monitored: false,
        qualityProfileId: 0,
        metadataProfileId: 0,
        tags: [],
      },
    });

    const res = await requestMusic({ albums: [STATIC_GARDEN] });

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
    assert.equal(
      (await albumRow(STATIC_GARDEN)).status,
      MediaStatus.PROCESSING
    );
    const [album] = await getRepository(AlbumRequest).find();
    assert.equal(album.status, MediaRequestStatus.APPROVED);
  });

  it('waits for approval with only Auto-Approve for another kind', async () => {
    await actAs(Permission.REQUEST + Permission.AUTO_APPROVE_MOVIE);
    const res = await requestMusic({ albums: [STATIC_GARDEN] });
    assert.equal(
      (res.body as { status: number }).status,
      MediaRequestStatus.PENDING
    );
  });

  it('leaves out albums already asked for or already here', async () => {
    assert.equal((await requestMusic({ albums: [STATIC_GARDEN] })).status, 201);

    await actAs(Permission.REQUEST, 'second@x');
    assert.equal((await requestMusic({ albums: [STATIC_GARDEN] })).status, 409);

    const media = await artistMedia();
    await dataSource.manager.save(
      new MusicAlbum({
        mediaId: media.id,
        mbId: IN_LANTERNS,
        title: 'In Lanterns',
        secondaryTypes: [],
        status: MediaStatus.AVAILABLE,
      }),
      { listeners: false }
    );

    const res = await requestMusic({
      albums: [STATIC_GARDEN, FOG_B, IN_LANTERNS],
    });
    assert.equal(res.status, 201);
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id: (res.body as { id: number }).id },
    });
    assert.deepEqual(
      request.albums.map((album) => album.albumMbid),
      [FOG_B]
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
      albums: [STATIC_GARDEN, FOG_B, IN_LANTERNS],
    });
    assert.equal(res.status, 403);
    assert.equal(
      (res.body as { message: string }).message,
      'You can request 2 more albums.'
    );

    res = await requestMusic({ albums: [STATIC_GARDEN, FOG_B] });
    assert.equal(res.status, 201);

    const quota = await call('GET', `/user/${user.id}/quota`);
    assert.deepEqual((quota.body as { music: unknown }).music, {
      days: 7,
      limit: 2,
      used: 2,
      remaining: 0,
      restricted: true,
    });

    res = await requestMusic({ albums: [IN_LANTERNS] });
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
    res = await requestMusic({ albums: [IN_LANTERNS] });
    assert.equal(res.status, 201);
  });

  it('follows the default music quota, which managers may bypass', async () => {
    getSettings().main.defaultQuotas.music = { quotaLimit: 1, quotaDays: 7 };
    const listener = await actAs(Permission.REQUEST);
    assert.equal((await requestMusic({ albums: [STATIC_GARDEN] })).status, 201);
    assert.equal((await requestMusic({ albums: [FOG_B] })).status, 403);

    await actAs(
      Permission.MANAGE_REQUESTS + Permission.MANAGE_USERS,
      'manager@x'
    );
    const res = await requestMusic({
      albums: [FOG_B],
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
      albums: [STATIC_GARDEN],
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
      albums: [FOG_B],
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
    assert.equal((await requestMusic({ albums: [STATIC_GARDEN] })).status, 403);

    getSettings().main.disabledFeatures = [];
    getSettings().lidarr = [];
    assert.equal((await requestMusic({ albums: [STATIC_GARDEN] })).status, 404);
  });
});

describe('music requests in the lists', () => {
  it('are listed by default for someone with music, with their albums', async () => {
    const res = await requestMusic({ albums: [STATIC_GARDEN] });
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
    assert.equal(listed[0].albums[0].albumMbid, STATIC_GARDEN);
    assert.equal(listed[0].albums[0].albumStatus, MediaStatus.PENDING);

    list = await call('GET', '/request?mediaType=movie%2Ctv');
    assert.equal((list.body as { results: unknown[] }).results.length, 0);

    getSettings().main.disabledFeatures = ['music'];
    list = await call('GET', '/request?mediaType=music');
    assert.equal((list.body as { results: unknown[] }).results.length, 0);
  });

  it("are on someone's own requests page, and the count", async () => {
    const listener = actingAs;
    await requestMusic({ albums: [STATIC_GARDEN] });

    let mine = await call('GET', `/user/${listener.id}/requests`);
    const results = (
      mine.body as {
        results: { type: string; albums: { title: string }[] }[];
      }
    ).results;
    assert.equal(results.length, 1);
    assert.equal(results[0].type, 'music');
    assert.equal(results[0].albums[0].title, 'Static Garden');
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
    const res = await requestMusic({ albums: [STATIC_GARDEN] });
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
    const res = await requestMusic({ albums: [STATIC_GARDEN, FOG_B] });
    const id = (res.body as { id: number }).id;

    const edit = await call('PUT', `/request/${id}`, {
      mediaType: 'music',
      albums: [FOG_B, IN_LANTERNS],
    });

    assert.equal(edit.status, 200);
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id },
    });
    assert.deepEqual(
      request.albums.map((album) => album.albumMbid).sort(),
      [IN_LANTERNS, FOG_B].sort()
    );
    assert.equal(request.status, MediaRequestStatus.PENDING);
    assert.equal((await albumRow(STATIC_GARDEN)).status, MediaStatus.UNKNOWN);
    assert.equal((await albumRow(IN_LANTERNS)).status, MediaStatus.PENDING);
    assert.equal(
      await getRepository(AlbumRequest).count(),
      2,
      'no album is left behind without its request'
    );
    assert.equal(lidarr.calls.length, 0);
  });

  it('cannot take every album off, or change someone else’s', async () => {
    const res = await requestMusic({ albums: [STATIC_GARDEN] });
    const id = (res.body as { id: number }).id;

    let edit = await call('PUT', `/request/${id}`, {
      mediaType: 'music',
      albums: [],
    });
    assert.equal(edit.status, 400);

    await actAs(Permission.REQUEST, 'other@x');
    edit = await call('PUT', `/request/${id}`, {
      mediaType: 'music',
      albums: [FOG_B],
    });
    assert.equal(edit.status, 403);
  });

  it('when declined, frees its albums and keeps the reason', async () => {
    const res = await requestMusic({ albums: [STATIC_GARDEN] });
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
    assert.equal((await albumRow(STATIC_GARDEN)).status, MediaStatus.UNKNOWN);
    assert.equal((await artistMedia()).status, MediaStatus.UNKNOWN);
    assert.equal(lidarr.calls.length, 0);
  });

  it('when deleted, frees its albums to be asked for again', async () => {
    const res = await requestMusic({ albums: [STATIC_GARDEN] });
    const id = (res.body as { id: number }).id;

    const deleted = await call('DELETE', `/request/${id}`);

    assert.equal(deleted.status, 204);
    assert.equal((await albumRow(STATIC_GARDEN)).status, MediaStatus.UNKNOWN);
    assert.equal((await artistMedia()).status, MediaStatus.UNKNOWN);
    assert.equal(await getRepository(AlbumRequest).count(), 0);
    assert.equal((await requestMusic({ albums: [STATIC_GARDEN] })).status, 201);
  });

  it('when approved, is sent to Lidarr', async () => {
    lidarr.lookupArtists.set(ARTIST, {
      id: 0,
      artistName: 'Glasswing',
      foreignArtistId: ARTIST,
      monitored: false,
      qualityProfileId: 0,
      metadataProfileId: 0,
      tags: [],
    });
    const res = await requestMusic({ albums: [STATIC_GARDEN, FOG_B] });
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
      [STATIC_GARDEN, FOG_B]
    );
    assert.equal((await albumRow(FOG_B)).status, MediaStatus.PROCESSING);
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
      artistName: 'Glasswing',
      foreignArtistId: ARTIST,
      monitored: false,
      qualityProfileId: 0,
      metadataProfileId: 0,
      tags: [],
    });
  });

  it('is kept by the artist: asked for, approved, on its way', async () => {
    await actAs(Permission.REQUEST);
    const res = await requestMusic({ albums: [STATIC_GARDEN, FOG_B] });
    const id = (res.body as { id: number }).id;

    await actAs(Permission.MANAGE_REQUESTS, 'manager@x');
    await call('POST', `/request/${id}/approve`);
    await lidarr.waitFor(
      (c) => c.method === 'POST' && c.path === '/api/v1/artist'
    );

    assert.deepEqual(await history(), [
      ['requested', '2 albums: Static Garden, Fog B', 'listener@test.local'],
      ['approved', null, 'manager@x'],
      ['processing', null, null],
    ]);
  });

  it('says why Lidarr could not take it', async () => {
    const res = await requestMusic({ albums: [STATIC_GARDEN] });
    const id = (res.body as { id: number }).id;
    lidarr.down = true;

    await actAs(Permission.MANAGE_REQUESTS, 'manager@x');
    await call('POST', `/request/${id}/approve`);
    await lidarr.waitFor(() => false);

    const failed = (await history()).find(([type]) => type === 'failed');
    assert.match(String(failed?.[1]), /^Lidarr could not take the request/);
  });

  it('is for request managers and admins only', async () => {
    await requestMusic({ albums: [STATIC_GARDEN] });
    const res = await call('GET', `/music/artist/${ARTIST}/history`);
    assert.equal(res.status, 403);
  });
});

describe('requesting songs', () => {
  const SINGLE = '6b2e9c41-7d38-3f05-a6e1-0c4d8b7f2a93';
  const HITS = '2f8c1e7a-4b6d-3c92-8e05-d7a3f19b6c40';
  const ALBUM_TAKE = 'a1b2c3d4-0001-4000-8000-000000000001';
  const RADIO_EDIT = 'a1b2c3d4-0002-4000-8000-000000000002';
  const CLUB_MIX = 'a1b2c3d4-0003-4000-8000-000000000003';
  const BOOTLEG = 'a1b2c3d4-0004-4000-8000-000000000004';
  const NOT_THEIRS = 'a1b2c3d4-0005-4000-8000-000000000005';
  const ACOUSTIC = 'a1b2c3d4-0006-4000-8000-000000000006';
  const ACOUSTIC_EP = '8d3f2a61-5c47-4e19-b0a2-3f6e9d1c7b58';
  const NIGHT_SWIM = 'a1b2c3d4-0007-4000-8000-000000000007';
  const NIGHT_SWIM_SINGLE = '3e9a7c15-2d84-4f60-a1b3-c5d7e9f02468';

  const onRelease = (
    groupId: string,
    title: string,
    type = 'Album',
    { secondary = [] as string[], status = 'Official' } = {}
  ): MbRecordingRelease => ({
    id: `${groupId.slice(0, 30)}r1`,
    title,
    status,
    date: '2001-03-04',
    'release-group': {
      id: groupId,
      title,
      'primary-type': type,
      'secondary-types': secondary,
    },
  });

  const recordings: Record<string, MbRecording> = {
    [ALBUM_TAKE]: {
      id: ALBUM_TAKE,
      title: 'Lantern Song',
      length: 301_000,
      'artist-credit': [
        { name: 'Glasswing', artist: { id: ARTIST, name: 'Glasswing' } },
      ],
      releases: [onRelease(STATIC_GARDEN, 'Static Garden')],
    },
    [RADIO_EDIT]: {
      id: RADIO_EDIT,
      title: 'Lantern Song',
      disambiguation: 'radio edit',
      length: 214_000,
      'artist-credit': [
        { name: 'Glasswing', artist: { id: ARTIST, name: 'Glasswing' } },
      ],
      releases: [
        onRelease(HITS, 'Hits', 'Album', { secondary: ['Compilation'] }),
        onRelease(SINGLE, 'Lantern Song', 'Single'),
      ],
    },
    [CLUB_MIX]: {
      id: CLUB_MIX,
      title: 'Lantern Song (Club Mix)',
      'artist-credit': [
        { name: 'Glasswing', artist: { id: ARTIST, name: 'Glasswing' } },
      ],
      releases: [onRelease(SINGLE, 'Lantern Song', 'Single')],
    },
    [BOOTLEG]: {
      id: BOOTLEG,
      title: 'Lantern Song',
      disambiguation: 'live',
      'artist-credit': [
        { name: 'Glasswing', artist: { id: ARTIST, name: 'Glasswing' } },
      ],
      releases: [onRelease(HITS, 'Tape', 'Album', { status: 'Bootleg' })],
    },
    [ACOUSTIC]: {
      id: ACOUSTIC,
      title: 'Harbour Song (acoustic)',
      'artist-credit': [
        { name: 'Glasswing', artist: { id: ARTIST, name: 'Glasswing' } },
      ],
      releases: [onRelease(ACOUSTIC_EP, 'Harbour Sessions', 'EP')],
    },
    [NIGHT_SWIM]: {
      id: NIGHT_SWIM,
      title: 'Night Swim',
      'artist-credit': [
        { name: 'Glasswing', artist: { id: ARTIST, name: 'Glasswing' } },
      ],
      releases: [onRelease(NIGHT_SWIM_SINGLE, 'Night Swim', 'Single')],
    },
    [NOT_THEIRS]: {
      id: NOT_THEIRS,
      title: 'Other Song',
      'artist-credit': [
        { name: 'Someone', artist: { id: OTHER_ARTIST, name: 'Someone' } },
      ],
      releases: [onRelease(HITS, 'Hits')],
    },
  };

  const requestSongs = (songs: string[], body: Record<string, unknown> = {}) =>
    requestMusic({ songs, ...body });

  const message = (res: { body: never }) =>
    (res.body as { message: string }).message;

  beforeEach(() => {
    getSettings().music.songRequests = true;
    mock.method(
      MusicBrainz.prototype,
      'getRecording',
      async (id: string) => recordings[id] ?? null
    );
  });

  it('is refused until Settings → Music allows it', async () => {
    getSettings().music.songRequests = false;
    const res = await requestSongs([RADIO_EDIT]);
    assert.equal(res.status, 400);
    assert.equal(await getRepository(SongRequest).count(), 0);
  });

  it('asks for one version of a song, kept with what names it', async () => {
    const res = await requestSongs([RADIO_EDIT]);

    assert.equal(res.status, 201);
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id: (res.body as { id: number }).id },
    });
    assert.equal(request.status, MediaRequestStatus.PENDING);
    assert.deepEqual(request.albums, []);
    assert.equal(request.songs.length, 1);
    const [song] = request.songs;
    assert.equal(song.recordingMbid, RADIO_EDIT);
    assert.equal(song.title, 'Lantern Song');
    assert.equal(song.version, 'radio edit');
    assert.equal(song.length, 214_000);
    // Best known from its single, ahead of a compilation.
    assert.equal(song.albumMbid, SINGLE);
    assert.equal(song.albumTitle, 'Lantern Song');
    assert.deepEqual(song.releaseGroups, [SINGLE, HITS]);
    assert.equal((await artistMedia()).status, MediaStatus.PENDING);
  });

  it('is fetched through its single, which waits like an album', async () => {
    const res = await requestSongs([RADIO_EDIT]);
    assert.equal(res.status, 201);
    const [song] = await getRepository(SongRequest).find();
    assert.equal(song.singleMbid, SINGLE);
    assert.equal(song.singleTitle, 'Lantern Song');
    const single = await albumRow(SINGLE);
    assert.equal(single.status, MediaStatus.PENDING);
    assert.equal(single.primaryType, 'Single');

    // The rest of that single comes with it.
    await actAs(Permission.REQUEST, 'second@x');
    const club = await requestSongs([CLUB_MIX]);
    assert.equal(club.status, 409);
    assert.equal(
      message(club),
      'Lantern Song is on Lantern Song, which is already here or on its way.'
    );
  });

  it('is approved with Auto-Approve Music, and Lidarr fetches its single', async () => {
    await actAs(Permission.REQUEST + Permission.AUTO_APPROVE_MUSIC);
    lidarr.lookupAlbums.set(SINGLE, {
      id: 0,
      title: 'Lantern Song',
      foreignAlbumId: SINGLE,
      artistId: 0,
      monitored: false,
      artist: {
        id: 0,
        artistName: 'Glasswing',
        foreignArtistId: ARTIST,
        monitored: false,
        qualityProfileId: 0,
        metadataProfileId: 0,
        tags: [],
      },
    });
    const res = await requestSongs([CLUB_MIX]);

    assert.equal(res.status, 201);
    assert.equal(
      (res.body as { status: number }).status,
      MediaRequestStatus.APPROVED
    );
    await lidarr.waitFor(
      (c) => c.method === 'POST' && c.path === '/api/v1/album'
    );
    const sent = lidarr.calls.filter(
      (c) => c.method === 'POST' && c.path === '/api/v1/album'
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body?.foreignAlbumId, SINGLE);
    const [song] = await getRepository(SongRequest).find();
    assert.equal(song.status, MediaRequestStatus.APPROVED);
    assert.equal((await albumRow(SINGLE)).status, MediaStatus.PROCESSING);
    assert.ok((await albumRow(SINGLE)).lidarrAlbumId);
  });

  it('refuses a song only on albums, naming the album to ask for', async () => {
    const res = await requestSongs([ALBUM_TAKE]);

    assert.equal(res.status, 400);
    assert.equal(
      message(res),
      "Lantern Song is only on albums, so it can't be requested on its own. Request Static Garden instead."
    );
    assert.equal(await getRepository(SongRequest).count(), 0);
    assert.equal(lidarr.calls.length, 0);
  });

  it('refuses a song already asked for, or on an album that is', async () => {
    assert.equal((await requestSongs([RADIO_EDIT])).status, 201);

    await actAs(Permission.REQUEST, 'second@x');
    let res = await requestSongs([RADIO_EDIT]);
    assert.equal(res.status, 409);
    assert.equal(message(res), 'Lantern Song is already requested.');

    assert.equal((await requestMusic({ albums: [STATIC_GARDEN] })).status, 201);
    res = await requestSongs([ALBUM_TAKE]);
    assert.equal(res.status, 409);
    assert.equal(
      message(res),
      'Lantern Song is on Static Garden, which is already here or on its way.'
    );
  });

  it('leaves out a song an album in the same request brings', async () => {
    const res = await requestMusic({
      albums: [STATIC_GARDEN],
      songs: [ALBUM_TAKE, RADIO_EDIT],
    });

    assert.equal(res.status, 201);
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id: (res.body as { id: number }).id },
    });
    assert.deepEqual(
      request.albums.map((album) => album.albumMbid),
      [STATIC_GARDEN]
    );
    assert.deepEqual(
      request.songs.map((song) => song.recordingMbid),
      [RADIO_EDIT]
    );
  });

  it("refuses someone else's song, and one only on bootlegs", async () => {
    let res = await requestSongs([NOT_THEIRS]);
    assert.equal(res.status, 400);
    res = await requestSongs([BOOTLEG]);
    assert.equal(res.status, 400);
    assert.equal(await getRepository(SongRequest).count(), 0);
  });

  it('counts songs as music, or against a song limit of their own', async () => {
    const user = await actAs(Permission.REQUEST);
    await getRepository(User).update(user.id, {
      musicQuotaLimit: 2,
      musicQuotaDays: 7,
    });
    actingAs = await getRepository(User).findOneByOrFail({ id: user.id });

    let res = await requestMusic({
      albums: [STATIC_GARDEN],
      songs: [RADIO_EDIT, ACOUSTIC],
    });
    assert.equal(res.status, 403);
    assert.equal(message(res), 'You can request 2 more albums or songs.');

    assert.equal((await requestSongs([RADIO_EDIT])).status, 201);
    assert.equal((await requestSongs([ACOUSTIC])).status, 201);
    let quota = await call('GET', `/user/${user.id}/quota`);
    assert.equal((quota.body as { music: { used: number } }).music.used, 2);
    assert.equal((quota.body as { song?: unknown }).song, undefined);
    assert.equal((await requestMusic({ albums: [FOG_B] })).status, 403);

    // A limit of their own: albums and songs each count apart.
    getSettings().music.songQuota = { quotaLimit: 3, quotaDays: 7 };
    quota = await call('GET', `/user/${user.id}/quota`);
    assert.deepEqual((quota.body as { song: unknown }).song, {
      days: 7,
      limit: 3,
      used: 2,
      remaining: 1,
      restricted: false,
    });
    assert.equal((quota.body as { music: { used: number } }).music.used, 0);
    assert.equal((await requestMusic({ albums: [FOG_B] })).status, 201);
    res = await requestSongs([NIGHT_SWIM]);
    assert.equal(res.status, 201);
    res = await requestMusic({
      albums: [IN_LANTERNS],
      songs: [],
    });
    assert.equal(res.status, 201);
    quota = await call('GET', `/user/${user.id}/quota`);
    assert.equal(
      (quota.body as { song: { restricted: boolean } }).song.restricted,
      true
    );
  });

  it('when declined, takes its songs with it, and they can be asked again', async () => {
    const res = await requestSongs([RADIO_EDIT]);
    const id = (res.body as { id: number }).id;

    await actAs(Permission.MANAGE_REQUESTS, 'manager@x');
    assert.equal((await call('POST', `/request/${id}/decline`)).status, 200);
    const [song] = await getRepository(SongRequest).find();
    assert.equal(song.status, MediaRequestStatus.DECLINED);
    assert.equal((await artistMedia()).status, MediaStatus.UNKNOWN);
    assert.equal((await albumRow(SINGLE)).status, MediaStatus.UNKNOWN);

    await actAs(Permission.REQUEST, 'again@x');
    assert.equal((await requestSongs([RADIO_EDIT])).status, 201);
  });

  it('when approved, sends its single, and its options can still change', async () => {
    lidarr.lookupArtists.set(ARTIST, {
      id: 0,
      artistName: 'Glasswing',
      foreignArtistId: ARTIST,
      monitored: false,
      qualityProfileId: 0,
      metadataProfileId: 0,
      tags: [],
    });
    const res = await requestMusic({
      albums: [STATIC_GARDEN],
      songs: [RADIO_EDIT],
    });
    const id = (res.body as { id: number }).id;

    await actAs(Permission.MANAGE_REQUESTS, 'manager@x');
    const edit = await call('PUT', `/request/${id}`, {
      mediaType: 'music',
      rootFolder: '/music',
    });
    assert.equal(edit.status, 200);
    assert.equal((await call('POST', `/request/${id}/approve`)).status, 200);
    await lidarr.waitFor(
      (c) => c.method === 'POST' && c.path === '/api/v1/artist'
    );

    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id },
    });
    assert.equal(request.rootFolder, '/music');
    assert.equal(request.songs[0].status, MediaRequestStatus.APPROVED);
    const sent = lidarr.calls.find(
      (c) => c.method === 'POST' && c.path === '/api/v1/artist'
    );
    assert.equal(sent?.body?.rootFolderPath, '/music');
    assert.deepEqual(
      (sent?.body?.addOptions as { albumsToMonitor: string[] }).albumsToMonitor,
      [STATIC_GARDEN, SINGLE]
    );
  });

  it('when deleted, frees its single to be asked for again', async () => {
    const res = await requestSongs([RADIO_EDIT]);
    const id = (res.body as { id: number }).id;

    assert.equal((await call('DELETE', `/request/${id}`)).status, 204);
    assert.equal((await albumRow(SINGLE)).status, MediaStatus.UNKNOWN);
    assert.equal((await requestSongs([CLUB_MIX])).status, 201);
  });

  it('keeps a request open while its songs are not here', async () => {
    const res = await requestMusic({
      albums: [STATIC_GARDEN],
      songs: [RADIO_EDIT],
    });
    const id = (res.body as { id: number }).id;
    // On its way, as a send to Lidarr leaves it, and its album now here.
    await getRepository(MediaRequest).update(id, {
      status: MediaRequestStatus.APPROVED,
    });
    await getRepository(AlbumRequest).update(
      { request: { id } },
      { status: MediaRequestStatus.APPROVED }
    );
    await getRepository(SongRequest).update(
      { request: { id } },
      { status: MediaRequestStatus.APPROVED }
    );
    await getRepository(MusicAlbum).update(
      { mbId: STATIC_GARDEN },
      { status: MediaStatus.AVAILABLE }
    );

    await completeMusicRequests([(await artistMedia()).id]);

    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id },
    });
    assert.equal(request.albums[0].status, MediaRequestStatus.COMPLETED);
    assert.equal(request.songs[0].status, MediaRequestStatus.APPROVED);
    assert.equal(request.status, MediaRequestStatus.APPROVED);
  });

  /** A song request on its way, as a send to Lidarr leaves it. */
  const songOnItsWay = async (songs: string[]) => {
    const res = await requestSongs(songs);
    const id = (res.body as { id: number }).id;
    await getRepository(MediaRequest).update(id, {
      status: MediaRequestStatus.APPROVED,
    });
    await getRepository(SongRequest).update(
      { request: { id } },
      { status: MediaRequestStatus.APPROVED }
    );
    // Lidarr has the artist, and the single as its album 7.
    await getRepository(Media).update((await artistMedia()).id, {
      serviceId: 0,
      externalServiceId: 1,
    });
    await getRepository(MusicAlbum).update(
      { mbId: SINGLE },
      { status: MediaStatus.PROCESSING, lidarrAlbumId: 7 }
    );
    return id;
  };

  const availableSent = () =>
    (
      MediaRequest.sendNotification as unknown as {
        mock: { calls: { arguments: [MediaRequest, Media, Notification] }[] };
      }
    ).mock.calls.filter(
      (call) => call.arguments[2] === Notification.MEDIA_AVAILABLE
    );

  it('is done, and says so once, when its single is here', async () => {
    const id = await songOnItsWay([RADIO_EDIT]);
    await getRepository(MusicAlbum).update(
      { mbId: SINGLE },
      { status: MediaStatus.AVAILABLE }
    );

    await completeMusicRequests([(await artistMedia()).id]);
    await completeMusicRequests([(await artistMedia()).id]);

    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id },
    });
    assert.equal(request.songs[0].status, MediaRequestStatus.COMPLETED);
    assert.equal(request.status, MediaRequestStatus.COMPLETED);
    assert.equal(availableSent().length, 1);

    // Here now, through its single: not asked for again.
    await actAs(Permission.REQUEST, 'second@x');
    const again = await requestSongs([RADIO_EDIT]);
    assert.equal(again.status, 409);
    assert.equal(
      message(again),
      'Lantern Song is on Lantern Song, which is already here or on its way.'
    );
  });

  it('with its single partly here, is done once Lidarr has this very song', async () => {
    const id = await songOnItsWay([RADIO_EDIT]);
    await getRepository(MusicAlbum).update(
      { mbId: SINGLE },
      { status: MediaStatus.PARTIALLY_AVAILABLE }
    );
    lidarr.tracks.set(7, [
      {
        id: 1,
        albumId: 7,
        title: 'Lantern Song (radio edit)',
        foreignRecordingId: RADIO_EDIT,
        hasFile: false,
      },
      {
        id: 2,
        albumId: 7,
        title: 'Lantern Song (Club Mix)',
        foreignRecordingId: CLUB_MIX,
        hasFile: true,
      },
    ]);
    const done = async () => {
      await completeMusicRequests([(await artistMedia()).id]);
      return (
        await getRepository(MediaRequest).findOneOrFail({ where: { id } })
      ).status;
    };

    assert.equal(await done(), MediaRequestStatus.APPROVED);

    lidarr.tracks.get(7)![0].hasFile = true;
    assert.equal(await done(), MediaRequestStatus.COMPLETED);
    assert.equal(availableSent().length, 1);
  });

  it('is done without a word when its single is deleted', async () => {
    const id = await songOnItsWay([RADIO_EDIT]);
    await getRepository(MusicAlbum).update(
      { mbId: SINGLE },
      { status: MediaStatus.DELETED }
    );

    await completeMusicRequests([(await artistMedia()).id]);

    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id },
    });
    assert.equal(request.status, MediaRequestStatus.COMPLETED);
    assert.equal(availableSent().length, 0);
  });

  it('are named in the request’s notification', async () => {
    await requestMusic({ albums: [STATIC_GARDEN], songs: [RADIO_EDIT] });
    await requestSongs([ACOUSTIC]);
    const sent = (
      MediaRequest.sendNotification as unknown as {
        mock: { calls: { arguments: [MediaRequest, Media] }[] };
      }
    ).mock.calls;
    assert.equal(sent.length, 2);
    // The real notification text, from the requests the hook was given.
    mock.restoreAll();
    const notified: { subject: string; message: string }[] = [];
    mock.method(
      notificationManager,
      'sendNotification',
      (_type: Notification, payload: { subject: string; message: string }) =>
        notified.push(payload)
    );
    for (const call of sent) {
      await MediaRequest.sendNotification(
        call.arguments[0],
        call.arguments[1],
        Notification.MEDIA_PENDING
      );
    }
    assert.deepEqual(
      notified.map((payload) => [payload.subject, payload.message]),
      [
        [
          'Glasswing — 1 album, 1 song',
          'Static Garden, Lantern Song (radio edit)',
        ],
        ['Harbour Song (acoustic) — Glasswing', 'Harbour Song (acoustic)'],
      ]
    );
  });
});

describe('songs in search and on album pages', () => {
  const RADIO_EDIT = 'a1b2c3d4-0002-4000-8000-000000000002';
  const ALBUM_TAKE = 'a1b2c3d4-0001-4000-8000-000000000001';
  const SINGLE = '6b2e9c41-7d38-3f05-a6e1-0c4d8b7f2a93';

  const credit = [
    { name: 'Glasswing', artist: { id: ARTIST, name: 'Glasswing' } },
  ];
  const found: MbRecording[] = [
    {
      id: ALBUM_TAKE,
      title: 'Lantern Song',
      'artist-credit': credit,
      releases: [
        {
          id: 'r-1',
          title: 'Static Garden',
          status: 'Official',
          'release-group': {
            id: STATIC_GARDEN,
            title: 'Static Garden',
            'primary-type': 'Album',
          },
        },
      ],
    },
    {
      id: RADIO_EDIT,
      title: 'Lantern Song (radio edit)',
      'artist-credit': credit,
      releases: [
        {
          id: 'r-2',
          title: 'Lantern Song',
          status: 'Official',
          'release-group': {
            id: SINGLE,
            title: 'Lantern Song',
            'primary-type': 'Single',
          },
        },
      ],
    },
  ];

  beforeEach(() => {
    getSettings().music.songRequests = true;
    mock.method(MusicBrainz.prototype, 'searchArtists', async () => ({
      count: 1,
      offset: 0,
      artists: [{ id: ARTIST, name: 'Glasswing', score: 100 }],
    }));
    mock.method(MusicBrainz.prototype, 'searchReleaseGroups', async () => ({
      count: 1,
      offset: 0,
      'release-groups': [
        { ...group(SINGLE, 'Lantern Song', '2001'), score: 100 },
      ],
    }));
    mock.method(
      MusicBrainz.prototype,
      'getRecording',
      async (id: string) =>
        found.find((recording) => recording.id === id) ?? null
    );
  });

  it('finds a song’s versions among the artists the search finds', async () => {
    const searchRecordings = mock.method(
      MusicBrainz.prototype,
      'searchRecordings',
      async () => ({ count: 2, offset: 0, recordings: found })
    );
    assert.equal((await requestMusic({ albums: [STATIC_GARDEN] })).status, 201);
    await actAs(Permission.REQUEST, 'second@x');
    assert.equal((await requestMusic({ songs: [RADIO_EDIT] })).status, 201);

    const res = await call('GET', '/music/search/songs?query=lantern%20song');

    assert.equal(res.status, 200);
    assert.deepEqual(searchRecordings.mock.calls[0].arguments.slice(0, 2), [
      'lantern song',
      [ARTIST],
    ]);
    const { songs } = res.body as {
      songs: {
        title: string;
        versions: {
          id: string;
          version?: string;
          status?: number;
          onAlbum?: { id: string; title: string };
          from?: { title: string };
          onlyOnAlbums?: boolean;
        }[];
      }[];
    };
    assert.equal(songs.length, 1);
    assert.equal(songs[0].title, 'Lantern Song');
    const take = songs[0].versions.find((v) => v.id === ALBUM_TAKE);
    const edit = songs[0].versions.find((v) => v.id === RADIO_EDIT);
    assert.equal(take?.version, undefined);
    assert.equal(take?.from?.title, 'Static Garden');
    assert.deepEqual(take?.onAlbum, {
      id: STATIC_GARDEN,
      title: 'Static Garden',
    });
    assert.equal(take?.status, MediaStatus.PENDING);
    assert.equal(edit?.version, 'radio edit');
    // Only on an album: not asked for alone. The radio edit has its single.
    assert.equal(take?.onlyOnAlbums, true);
    assert.equal(edit?.onlyOnAlbums, undefined);
    assert.equal(edit?.status, MediaStatus.PENDING);
    assert.equal(edit?.onAlbum, undefined);
  });

  it('finds none until songs can be asked for', async () => {
    getSettings().music.songRequests = false;
    const searchRecordings = mock.method(
      MusicBrainz.prototype,
      'searchRecordings',
      async () => ({ count: 2, offset: 0, recordings: found })
    );
    const res = await call('GET', '/music/search/songs?query=lantern%20song');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { songs: [] });
    assert.equal(searchRecordings.mock.callCount(), 0);
  });

  it('says on an album page which tracks are asked for', async () => {
    mock.method(MusicBrainz.prototype, 'getTracks', async () => [
      {
        position: 1,
        tracks: [
          {
            id: 't1',
            position: 1,
            number: '1',
            title: 'Lantern Song',
            recording: { id: RADIO_EDIT, title: 'Lantern Song' },
          },
          {
            id: 't2',
            position: 2,
            number: '2',
            title: 'B-Side',
            recording: { id: ALBUM_TAKE, title: 'B-Side' },
          },
        ],
      },
    ]);
    assert.equal((await requestMusic({ songs: [RADIO_EDIT] })).status, 201);

    const res = await call('GET', `/music/album/${SINGLE}/tracks`);

    assert.equal(res.status, 200);
    const { tracks } = res.body as {
      tracks: { recordingId?: string; status?: number }[];
    };
    assert.deepEqual(
      tracks.map((track) => [track.recordingId, track.status]),
      [
        [RADIO_EDIT, MediaStatus.PENDING],
        [ALBUM_TAKE, undefined],
      ]
    );
  });
});
