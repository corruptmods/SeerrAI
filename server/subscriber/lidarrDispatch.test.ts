import type { LidarrAlbum, LidarrArtist } from '@server/api/servarr/lidarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import { Notification } from '@server/lib/notifications';
import { getSettings } from '@server/lib/settings';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import type { LidarrCall } from '@server/test/fakeLidarr';
import { createFakeLidarr } from '@server/test/fakeLidarr';
import assert from 'node:assert/strict';
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
 * Sending a music request to Lidarr, against a Lidarr on localhost that
 * writes down every call: which calls, in which order, and that nothing is
 * ever unmonitored or an existing artist's setup changed.
 */

setupTestDb();

const ARTIST = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const OK_COMPUTER = '1b022e01-4da6-387b-8658-8678046e4cef';
const KID_A = 'b1392450-e666-3926-a536-22c65f834433';

const lidarr = createFakeLidarr();
const subscriber = new MediaRequestSubscriber();

const lookedUpArtist = (): LidarrArtist => ({
  id: 0,
  artistName: 'Radiohead',
  foreignArtistId: ARTIST,
  monitored: false,
  qualityProfileId: 0,
  metadataProfileId: 0,
  tags: [],
});

const lookedUpAlbum = (mbId: string, title: string): LidarrAlbum => ({
  id: 0,
  title,
  foreignAlbumId: mbId,
  artistId: 0,
  monitored: false,
  artist: lookedUpArtist(),
});

/** An approved request for these albums, saved as if already there. */
const approvedRequest = async (
  albums: { mbId: string; title: string }[],
  overrides: Partial<MediaRequest> = {}
): Promise<MediaRequest> => {
  const manager = dataSource.manager;
  const status = overrides.status ?? MediaRequestStatus.APPROVED;
  const media = await manager.save(
    new Media({
      mediaType: MediaType.MUSIC,
      tmdbId: 0,
      foreignId: ARTIST,
      foreignTitle: 'Radiohead',
      status: MediaStatus.PROCESSING,
    }),
    { listeners: false }
  );
  for (const album of albums) {
    await manager.save(
      new MusicAlbum({
        mediaId: media.id,
        mbId: album.mbId,
        title: album.title,
        secondaryTypes: [],
        status: MediaStatus.PROCESSING,
      }),
      { listeners: false }
    );
  }
  const saved = await manager.save(
    new MediaRequest({
      type: MediaType.MUSIC,
      status: MediaRequestStatus.APPROVED,
      media,
      requestedBy: await getRepository(User).findOneByOrFail({ id: 2 }),
      is4k: false,
      albums: albums.map(
        (album) =>
          new AlbumRequest({
            albumMbid: album.mbId,
            title: album.title,
            status,
          })
      ),
      ...overrides,
    }),
    { listeners: false }
  );
  return getRepository(MediaRequest).findOneOrFail({
    where: { id: saved.id },
  });
};

const calls = (method: string, path: string) =>
  lidarr.calls.filter((call) => call.method === method && call.path === path);

/** Nothing anywhere asked Lidarr to stop monitoring something. */
const assertNothingUnmonitored = () => {
  for (const call of lidarr.calls) {
    assert.notEqual(call.body?.monitored, false, `${call.method} ${call.path}`);
  }
};

const statusOf = async (id: number) =>
  (await getRepository(MediaRequest).findOneByOrFail({ id })).status;

before(async () => {
  await lidarr.start();
});

after(() => {
  lidarr.stop();
});

beforeEach(() => {
  lidarr.reset();
  cacheManager.getCache('lidarr').flush();
  getSettings().lidarr = [lidarr.settings()];
  // Notifications are not what these tests are about.
  mock.method(MediaRequest, 'sendNotification', async () => true);
});

afterEach(() => {
  mock.restoreAll();
  getSettings().lidarr = [];
});

describe('sending a music request to Lidarr', () => {
  it('adds one album of a new artist with nothing else of theirs monitored', async () => {
    lidarr.lookupAlbums.set(OK_COMPUTER, lookedUpAlbum(OK_COMPUTER, 'OK'));
    const request = await approvedRequest(
      [{ mbId: OK_COMPUTER, title: 'OK Computer' }],
      { profileId: 4, rootFolder: '/flac', metadataProfileId: 9, tags: [3] }
    );

    await subscriber.dispatchToLidarr(request, lidarr.settings());

    assert.deepEqual(
      lidarr.calls.map((call) => `${call.method} ${call.path}`),
      ['GET /api/v1/artist', 'GET /api/v1/album/lookup', 'POST /api/v1/album']
    );
    const body = calls('POST', '/api/v1/album')[0].body as Record<
      string,
      never
    >;
    assert.equal(body.monitored, true);
    assert.equal(body.anyReleaseOk, true);
    assert.deepEqual(body.addOptions, { searchForNewAlbum: true });
    const artist = body.artist as Record<string, unknown>;
    assert.equal(artist.foreignArtistId, ARTIST);
    assert.equal(artist.qualityProfileId, 4);
    assert.equal(artist.metadataProfileId, 9);
    assert.equal(artist.rootFolderPath, '/flac');
    assert.deepEqual(artist.tags, [3]);
    assert.equal(artist.monitored, true);
    assert.equal(artist.monitorNewItems, 'none');
    assert.deepEqual(artist.addOptions, {
      monitor: 'none',
      searchForMissingAlbums: false,
    });

    const media = await getRepository(Media).findOneByOrFail({
      id: request.media.id,
    });
    const added = lidarr.artists[0];
    assert.equal(media.serviceId, 0);
    assert.equal(media.externalServiceId, added.id);
    assert.equal(media.externalServiceSlug, ARTIST);
    const album = await getRepository(MusicAlbum).findOneByOrFail({
      mbId: OK_COMPUTER,
    });
    assert.equal(album.lidarrAlbumId, lidarr.albums[0].id);
    assert.equal(await statusOf(request.id), MediaRequestStatus.APPROVED);
  });

  it('adds a new artist with exactly the albums asked for to monitor', async () => {
    lidarr.lookupArtists.set(ARTIST, lookedUpArtist());
    const request = await approvedRequest([
      { mbId: OK_COMPUTER, title: 'OK Computer' },
      { mbId: KID_A, title: 'Kid A' },
    ]);

    await subscriber.dispatchToLidarr(request, lidarr.settings());

    assert.deepEqual(
      lidarr.calls.map((call) => `${call.method} ${call.path}`),
      ['GET /api/v1/artist', 'GET /api/v1/artist/lookup', 'POST /api/v1/artist']
    );
    const body = calls('POST', '/api/v1/artist')[0].body as Record<
      string,
      never
    >;
    // The server's own setup where the request chose none.
    assert.equal(body.qualityProfileId, 1);
    assert.equal(body.metadataProfileId, 2);
    assert.equal(body.rootFolderPath, '/music');
    assert.equal(body.monitorNewItems, 'none');
    assert.deepEqual(body.addOptions, {
      monitor: 'none',
      albumsToMonitor: [OK_COMPUTER, KID_A],
      searchForMissingAlbums: true,
    });
    const media = await getRepository(Media).findOneByOrFail({
      id: request.media.id,
    });
    assert.equal(media.externalServiceId, lidarr.artists[0].id);
  });

  it('monitors and searches what an existing artist has, adds the rest, and changes nothing else', async () => {
    lidarr.artists = [
      {
        id: 7,
        artistName: 'Radiohead',
        foreignArtistId: ARTIST,
        monitored: false,
        monitorNewItems: 'all',
        qualityProfileId: 5,
        metadataProfileId: 3,
        rootFolderPath: '/elsewhere',
        path: '/elsewhere/Radiohead',
        tags: [8],
      },
    ];
    lidarr.albums = [
      {
        id: 70,
        title: 'OK Computer',
        foreignAlbumId: OK_COMPUTER,
        artistId: 7,
        monitored: false,
      },
      {
        id: 71,
        title: 'Pablo Honey',
        foreignAlbumId: '9a3b1f2c-0000-4000-8000-000000000001',
        artistId: 7,
        monitored: true,
      },
    ];
    lidarr.lookupAlbums.set(KID_A, lookedUpAlbum(KID_A, 'Kid A'));
    const request = await approvedRequest(
      [
        { mbId: OK_COMPUTER, title: 'OK Computer' },
        { mbId: KID_A, title: 'Kid A' },
      ],
      // Chosen for the request, but an artist Lidarr has keeps its own.
      { profileId: 4, rootFolder: '/flac', metadataProfileId: 9 }
    );

    await subscriber.dispatchToLidarr(request, lidarr.settings());

    assert.deepEqual(
      lidarr.calls.map((call) => `${call.method} ${call.path}`),
      [
        'GET /api/v1/artist',
        'GET /api/v1/album',
        'PUT /api/v1/album/monitor',
        'GET /api/v1/album/lookup',
        'POST /api/v1/album',
        'PUT /api/v1/artist/7',
        'POST /api/v1/command',
      ]
    );
    assert.deepEqual(calls('PUT', '/api/v1/album/monitor')[0].body, {
      albumIds: [70],
      monitored: true,
    });
    const added = calls('POST', '/api/v1/album')[0].body as Record<
      string,
      never
    >;
    assert.deepEqual(added.artist, { id: 7 });
    assert.deepEqual(added.addOptions, { searchForNewAlbum: true });
    const artist = calls('PUT', '/api/v1/artist/7')[0].body as Record<
      string,
      never
    >;
    assert.equal(artist.monitored, true);
    assert.equal(artist.rootFolderPath, '/elsewhere');
    assert.equal(artist.qualityProfileId, 5);
    assert.equal(artist.metadataProfileId, 3);
    assert.equal(artist.monitorNewItems, 'all');
    assert.deepEqual(artist.tags, [8]);
    assert.deepEqual(calls('POST', '/api/v1/command')[0].body, {
      name: 'AlbumSearch',
      albumIds: [70],
    });
    assert.equal(calls('POST', '/api/v1/artist').length, 0);
    assert.ok(
      lidarr.calls.every((call) => !('albumsToMonitor' in (call.body ?? {})))
    );
    assertNothingUnmonitored();

    const media = await getRepository(Media).findOneByOrFail({
      id: request.media.id,
    });
    assert.equal(media.externalServiceId, 7);
    const okComputer = await getRepository(MusicAlbum).findOneByOrFail({
      mbId: OK_COMPUTER,
    });
    assert.equal(okComputer.lidarrAlbumId, 70);
  });

  it('leaves a monitored artist alone when it has the albums already', async () => {
    lidarr.artists = [
      {
        id: 7,
        artistName: 'Radiohead',
        foreignArtistId: ARTIST,
        monitored: true,
        qualityProfileId: 5,
        metadataProfileId: 3,
        tags: [],
      },
    ];
    lidarr.albums = [
      {
        id: 70,
        title: 'OK Computer',
        foreignAlbumId: OK_COMPUTER,
        artistId: 7,
        monitored: true,
      },
    ];
    const request = await approvedRequest([
      { mbId: OK_COMPUTER, title: 'OK Computer' },
    ]);

    await subscriber.dispatchToLidarr(request, lidarr.settings());

    assert.equal(
      lidarr.calls.filter((c) => c.path === '/api/v1/artist/7').length,
      0
    );
    assert.equal(calls('GET', '/api/v1/album/lookup').length, 0);
    assert.equal(calls('POST', '/api/v1/command').length, 1);
    assertNothingUnmonitored();
  });

  it('never searches when the server is set not to', async () => {
    const quiet = lidarr.settings({ preventSearch: true });
    lidarr.lookupAlbums.set(OK_COMPUTER, lookedUpAlbum(OK_COMPUTER, 'OK'));
    lidarr.lookupArtists.set(ARTIST, lookedUpArtist());

    const one = await approvedRequest([
      { mbId: OK_COMPUTER, title: 'OK Computer' },
    ]);
    await subscriber.dispatchToLidarr(one, quiet);
    assert.deepEqual(
      (calls('POST', '/api/v1/album')[0].body as Record<string, never>)
        .addOptions,
      { searchForNewAlbum: false }
    );

    // Lidarr now has the artist and the album: asked again, it monitors
    // the album but does not search for it.
    lidarr.calls = [];
    const again = await getRepository(MediaRequest).findOneOrFail({
      where: { id: one.id },
    });
    await subscriber.dispatchToLidarr(again, quiet);
    assert.equal(calls('PUT', '/api/v1/album/monitor').length, 1);
    assert.equal(calls('POST', '/api/v1/command').length, 0);
  });

  it('asks a new artist for no search of missing albums when set not to', async () => {
    lidarr.lookupArtists.set(ARTIST, lookedUpArtist());
    const request = await approvedRequest([
      { mbId: OK_COMPUTER, title: 'OK Computer' },
      { mbId: KID_A, title: 'Kid A' },
    ]);
    await subscriber.dispatchToLidarr(
      request,
      lidarr.settings({ preventSearch: true })
    );
    const body = calls('POST', '/api/v1/artist')[0].body as Record<
      string,
      { searchForMissingAlbums: boolean }
    >;
    assert.equal(body.addOptions.searchForMissingAlbums, false);
  });

  it('tags the artist with whoever asked, when the server tags requests', async () => {
    const tagging = lidarr.settings({ tagRequests: true, tags: [3] });
    lidarr.lookupAlbums.set(OK_COMPUTER, lookedUpAlbum(OK_COMPUTER, 'OK'));
    const request = await approvedRequest([
      { mbId: OK_COMPUTER, title: 'OK Computer' },
    ]);

    await subscriber.dispatchToLidarr(request, tagging);

    const created = calls('POST', '/api/v1/tag');
    assert.equal(created.length, 1);
    assert.match(String(created[0].body?.label), /^2-/);
    const tag = lidarr.tags[0].id;
    const artist = (
      calls('POST', '/api/v1/album')[0].body as Record<
        string,
        { tags: number[] }
      >
    ).artist;
    assert.deepEqual(artist.tags, [3, tag]);

    // An artist Lidarr has gets the tag added to its own, nothing else.
    lidarr.calls = [];
    lidarr.artists[0].monitored = true;
    lidarr.artists[0].tags = [8];
    const again = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
    });
    await subscriber.dispatchToLidarr(again, tagging);
    assert.equal(calls('POST', '/api/v1/tag').length, 0, 'the tag is reused');
    const updated = calls('PUT', `/api/v1/artist/${lidarr.artists[0].id}`);
    assert.equal(updated.length, 1);
    assert.deepEqual((updated[0].body as Record<string, number[]>).tags, [
      8,
      tag,
    ]);
  });

  it('marks the request failed when Lidarr cannot look the album up yet', async () => {
    const request = await approvedRequest([
      { mbId: OK_COMPUTER, title: 'OK Computer' },
    ]);

    await subscriber.dispatchToLidarr(request, lidarr.settings());

    assert.equal(await statusOf(request.id), MediaRequestStatus.FAILED);
    assert.equal(calls('POST', '/api/v1/album').length, 0);
  });

  it('marks the request failed when Lidarr cannot look the artist up yet', async () => {
    const request = await approvedRequest([
      { mbId: OK_COMPUTER, title: 'OK Computer' },
      { mbId: KID_A, title: 'Kid A' },
    ]);

    await subscriber.dispatchToLidarr(request, lidarr.settings());

    assert.equal(await statusOf(request.id), MediaRequestStatus.FAILED);
    assert.equal(calls('POST', '/api/v1/artist').length, 0);
  });

  it('marks the request failed when Lidarr does not answer', async () => {
    lidarr.down = true;
    const request = await approvedRequest([
      { mbId: OK_COMPUTER, title: 'OK Computer' },
    ]);

    await subscriber.dispatchToLidarr(request, lidarr.settings());

    assert.equal(await statusOf(request.id), MediaRequestStatus.FAILED);
  });

  it('lets an album Lidarr cannot find yet wait, when it has the rest', async () => {
    lidarr.artists = [
      {
        id: 7,
        artistName: 'Radiohead',
        foreignArtistId: ARTIST,
        monitored: true,
        qualityProfileId: 5,
        metadataProfileId: 3,
        tags: [],
      },
    ];
    lidarr.albums = [
      {
        id: 70,
        title: 'OK Computer',
        foreignAlbumId: OK_COMPUTER,
        artistId: 7,
        monitored: false,
      },
    ];
    const request = await approvedRequest([
      { mbId: OK_COMPUTER, title: 'OK Computer' },
      { mbId: KID_A, title: 'Kid A' },
    ]);

    await subscriber.dispatchToLidarr(request, lidarr.settings());

    assert.equal(await statusOf(request.id), MediaRequestStatus.APPROVED);
    assert.equal(calls('PUT', '/api/v1/album/monitor').length, 1);
  });
});

describe('when a music request is approved', () => {
  it('is sent to Lidarr once, and its albums are on their way', async () => {
    lidarr.lookupAlbums.set(OK_COMPUTER, lookedUpAlbum(OK_COMPUTER, 'OK'));
    const request = await approvedRequest(
      [{ mbId: OK_COMPUTER, title: 'OK Computer' }],
      { status: MediaRequestStatus.PENDING }
    );

    request.status = MediaRequestStatus.APPROVED;
    await getRepository(MediaRequest).save(request);
    await lidarr.waitFor(
      (call: LidarrCall) =>
        call.method === 'POST' && call.path === '/api/v1/album'
    );

    assert.equal(calls('POST', '/api/v1/album').length, 1);
    const asked = await getRepository(AlbumRequest).find();
    assert.ok(
      asked.every((album) => album.status === MediaRequestStatus.APPROVED)
    );

    // Saving it again without a change of status sends nothing more.
    lidarr.calls = [];
    const again = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
    });
    again.rootFolder = '/other';
    await getRepository(MediaRequest).save(again);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(lidarr.calls.length, 0);
  });

  it('is sent again when a failed one is retried', async () => {
    const request = await approvedRequest(
      [{ mbId: OK_COMPUTER, title: 'OK Computer' }],
      { status: MediaRequestStatus.FAILED }
    );
    lidarr.lookupAlbums.set(OK_COMPUTER, lookedUpAlbum(OK_COMPUTER, 'OK'));

    request.status = MediaRequestStatus.APPROVED;
    await getRepository(MediaRequest).save(request);
    await lidarr.waitFor(
      (call: LidarrCall) =>
        call.method === 'POST' && call.path === '/api/v1/album'
    );

    assert.equal(calls('POST', '/api/v1/album').length, 1);
  });

  it('fails, and stays failed, when approved as it is made and Lidarr cannot take it', async () => {
    // On Postgres, sending began inside the request's own save, so a quick
    // failure was written on another connection that could not yet see the
    // new request: it stayed approved while "failed" went out.
    const notified: Notification[] = [];
    mock.method(
      MediaRequest,
      'sendNotification',
      async (_request: MediaRequest, _media: Media, type: Notification) => {
        notified.push(type);
        return true;
      }
    );
    const media = await dataSource.manager.save(
      new Media({
        mediaType: MediaType.MUSIC,
        tmdbId: 0,
        foreignId: ARTIST,
        foreignTitle: 'Radiohead',
        status: MediaStatus.UNKNOWN,
      }),
      { listeners: false }
    );
    await dataSource.manager.save(
      new MusicAlbum({
        mediaId: media.id,
        mbId: OK_COMPUTER,
        title: 'OK Computer',
        secondaryTypes: [],
        status: MediaStatus.UNKNOWN,
      }),
      { listeners: false }
    );

    // Lidarr cannot look the album up, so it fails straight away.
    const request = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MUSIC,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: await getRepository(User).findOneByOrFail({ id: 2 }),
        is4k: false,
        albums: [
          new AlbumRequest({
            albumMbid: OK_COMPUTER,
            title: 'OK Computer',
            status: MediaRequestStatus.APPROVED,
          }),
        ],
      })
    );
    for (
      let i = 0;
      i < 100 && !notified.includes(Notification.MEDIA_FAILED);
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.ok(notified.includes(Notification.MEDIA_FAILED));
    assert.equal(await statusOf(request.id), MediaRequestStatus.FAILED);
    assert.equal(
      await getRepository(MediaRequest).countBy({ type: MediaType.MUSIC }),
      1
    );
  });

  it('fails at once when its Lidarr was removed and there is no default', async () => {
    // With no Lidarr at all it stays approved instead, as music fulfilled by
    // hand would (routes/requestRecover.test.ts).
    getSettings().lidarr = [lidarr.settings({ id: 3, isDefault: false })];
    const request = await approvedRequest(
      [{ mbId: OK_COMPUTER, title: 'OK Computer' }],
      { status: MediaRequestStatus.PENDING, serverId: 9 }
    );

    request.status = MediaRequestStatus.APPROVED;
    await getRepository(MediaRequest).save(request);

    assert.equal(await statusOf(request.id), MediaRequestStatus.FAILED);
    assert.equal(lidarr.calls.length, 0);
  });
});
