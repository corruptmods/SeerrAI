import JellyfinAPI from '@server/api/jellyfin';
import type { PlexLibraryItem, PlexMusicItem } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import LidarrAPI from '@server/api/servarr/lidarr';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import dataSource, { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import { MatchProblem, MatchWatch } from '@server/entity/MatchWatch';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type { ImportedDownload } from '@server/lib/downloadtracker';
import downloadTracker from '@server/lib/downloadtracker';
import matchWatch, {
  DAILY_MESSAGES,
  GATHER_MS,
  LOOKS_AT_MS,
} from '@server/lib/matchWatch';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import plexMatchCheck, { REPORT_PATH } from '@server/lib/plexMatchCheck';
import type {
  LidarrSettings,
  RadarrSettings,
  SonarrSettings,
} from '@server/lib/settings';
import { getSettings, jellyfinDefaults } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * A title just requested and imported is looked for on each media server a
 * couple of minutes later, by its folder, and its ids compared with
 * Radarr's, Sonarr's or Lidarr's. A wrong match is told to admins once,
 * gathered with others found close by, within a few messages a day; one
 * put right is cleared without a word.
 */

setupTestDb();

const MIN = 60_000;
const T0 = new Date('2026-10-19T12:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

/** Replaces a method an API client sets on each instance, for one test. */
const stub = (
  target: { prototype: object },
  name: string,
  fn: (...args: never[]) => unknown
) => {
  Object.defineProperty(target.prototype, name, {
    configurable: true,
    set() {
      // The constructor's own assignment is swallowed.
    },
    get() {
      return fn;
    },
  });
  stubbed.push([target.prototype, name]);
};
let stubbed: [object, string][] = [];

let sent: NotificationPayload[] = [];

beforeEach(() => {
  sent = [];
  mock.method(
    notificationManager,
    'sendNotification',
    (type: Notification, payload: NotificationPayload) => {
      assert.equal(type, Notification.WRONG_MATCH);
      sent.push(payload);
    }
  );
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.main.matchCheckOnImport = true;
  settings.main.applicationUrl = 'https://seerr.example';
  settings.plex.libraries = [
    { id: '1', name: 'Movies', enabled: true, type: 'movie' },
    { id: '2', name: 'TV', enabled: true, type: 'show' },
  ];
  settings.plex.musicLibraries = [
    { id: '3', name: 'Music', enabled: true, type: 'artist' },
  ];
  settings.jellyfin = jellyfinDefaults();
  settings.radarr = [
    { id: 0, name: 'Radarr', hostname: 'r', port: 1, apiKey: 'k' },
  ] as unknown as RadarrSettings[];
  settings.sonarr = [
    { id: 0, name: 'Sonarr', hostname: 's', port: 1, apiKey: 'k' },
  ] as unknown as SonarrSettings[];
  settings.lidarr = [
    {
      id: 0,
      name: 'Lidarr',
      hostname: 'l',
      port: 1,
      apiKey: 'k',
      isDefault: true,
    },
  ] as unknown as LidarrSettings[];
  downloadTracker.setMatchWaits([]);
});

afterEach(async () => {
  mock.restoreAll();
  for (const [proto, name] of stubbed) {
    delete (proto as Record<string, unknown>)[name];
  }
  stubbed = [];
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.NOT_CONFIGURED;
  settings.main.applicationUrl = '';
  settings.jellyfin = jellyfinDefaults();
  settings.radarr = [];
  settings.sonarr = [];
  settings.lidarr = [];
});

const requester = () => getRepository(User).findOneByOrFail({ id: 2 });

/** A film someone requested, that Radarr has as `radarrId`. */
const requestedMovie = async (tmdbId: number, radarrId: number) => {
  const media = await dataSource.manager.save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId,
      status: MediaStatus.PROCESSING,
      serviceId: 0,
      externalServiceId: radarrId,
    }),
    { listeners: false }
  );
  await dataSource.manager.save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
      media,
      requestedBy: await requester(),
      is4k: false,
    }),
    { listeners: false }
  );
  return media;
};

const imported = (
  kind: ImportedDownload['kind'],
  externalId: number,
  album?: { id: number; title: string; foreignAlbumId: string }
): Pick<ImportedDownload, 'kind' | 'serverId' | 'item'> => ({
  kind,
  serverId: 0,
  item: {
    mediaType:
      kind === 'movie'
        ? MediaType.MOVIE
        : kind === 'music'
          ? MediaType.MUSIC
          : MediaType.TV,
    externalId,
    size: 100,
    sizeLeft: 0,
    status: 'completed',
    stage: 'imported',
    timeLeft: '',
    title: 'release',
    downloadId: `d${externalId}`,
    album,
  },
});

/** Radarr's films, by Radarr's id. */
const radarrHas = (
  movies: Record<
    number,
    {
      title: string;
      year: number;
      tmdbId: number;
      imdbId?: string;
      folder: string;
      runtime?: number;
      file?: string;
      fileRuntime?: string;
    }
  >
) =>
  stub(RadarrAPI, 'getMovie', (async ({ id }: { id: number }) => {
    const m = movies[id];
    if (!m)
      throw Object.assign(new Error('gone'), { response: { status: 404 } });
    return {
      id,
      title: m.title,
      year: m.year,
      tmdbId: m.tmdbId,
      imdbId: m.imdbId ?? '',
      path: `/movies/${m.folder}`,
      runtime: m.runtime,
      movieFile: m.file
        ? { relativePath: m.file, mediaInfo: { runTime: m.fileRuntime } }
        : undefined,
    };
  }) as never);

/** A film as Plex lists it, in its folder, matched to these ids. */
const plexMovie = (
  ratingKey: string,
  title: string,
  year: number | undefined,
  folder: string,
  guids: string[]
): PlexLibraryItem =>
  ({
    ratingKey,
    title,
    year,
    guid: 'plex://movie/x',
    type: 'movie',
    Guid: guids.map((id) => ({ id })),
    Media: [
      { duration: 109 * MIN, Part: [{ file: `/data/movies/${folder}/f.mkv` }] },
    ],
  }) as unknown as PlexLibraryItem;

/** What Plex lists as newly added, and its items by key. */
const plexHas = (
  movies: () => PlexLibraryItem[],
  shows: PlexLibraryItem[] = []
) => {
  const asked: string[] = [];
  mock.method(
    PlexAPI.prototype,
    'getRecentlyAdded',
    async (id: string, _o: unknown, type: string) => {
      asked.push(id);
      if (type === 'movie') return movies();
      return shows.map((show) => ({
        ratingKey: `e-${show.ratingKey}`,
        grandparentRatingKey: show.ratingKey,
        type: 'episode',
      }));
    }
  );
  mock.method(PlexAPI.prototype, 'getMatchItem', async (key: string) =>
    [...movies(), ...shows].find((item) => item.ratingKey === key)
  );
  return asked;
};

const civilWar = {
  title: 'Civil War',
  year: 2024,
  tmdbId: 929590,
  imdbId: 'tt17279496',
  folder: 'Civil War (2024)',
  runtime: 109,
  file: 'Guerra.Civil.2024.1080p.mkv',
  fileRuntime: '1:49:01',
};
const guerraCivil = () =>
  plexMovie('70', 'Guerra Civil', 2024, 'Civil War (2024)', ['tmdb://1310753']);

const pending = () =>
  getRepository(MatchWatch).find({ order: { mediaServer: 'ASC' } });
const problems = () =>
  getRepository(MatchProblem).find({ order: { id: 'ASC' } });

describe('looking at new requests as they are imported', () => {
  it('looks only at requested titles, once a series, on each server that should have them', async () => {
    getSettings().jellyfin = {
      ...jellyfinDefaults(),
      connected: true,
      ip: 'jf.invalid',
      apiKey: 'jk',
      libraries: [{ id: 'jm', name: 'Films', enabled: true, type: 'movie' }],
    };
    const film = await requestedMovie(929590, 10);
    await dataSource.manager.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 5,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 11,
      }),
      { listeners: false }
    );
    const show = await dataSource.manager.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 1,
        tvdbId: 455755,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 20,
      }),
      { listeners: false }
    );
    await dataSource.manager.save(
      new MediaRequest({
        type: MediaType.TV,
        status: MediaRequestStatus.APPROVED,
        media: show,
        requestedBy: await requester(),
        is4k: false,
      }),
      { listeners: false }
    );

    await matchWatch.noteImports(
      [
        imported('movie', 10),
        imported('movie', 11),
        imported('series', 20),
        imported('series', 20),
      ],
      T0
    );
    // A later episode of the same series, while it waits: still one.
    await matchWatch.noteImports([imported('series', 20)], at(1));

    const rows = await pending();
    assert.deepEqual(
      rows.map((r) => [r.kind, r.mediaId, r.mediaServer]).sort(),
      [
        ['movie', film.id, 'Jellyfin'],
        ['movie', film.id, 'Plex'],
        ['series', show.id, 'Plex'],
      ]
    );
    assert.ok(
      rows.every(
        (r) => r.nextCheckAt.getTime() === T0.getTime() + LOOKS_AT_MS[0]
      ),
      'first looked at a couple of minutes after the import'
    );

    // Switched off: nothing new is looked at.
    await getRepository(MatchWatch).clear();
    getSettings().main.matchCheckOnImport = false;
    await matchWatch.noteImports([imported('movie', 10)], T0);
    assert.equal((await pending()).length, 0);
  });

  it('backs off, and gives up quietly on a title the server never lists', async () => {
    await requestedMovie(929590, 10);
    radarrHas({ 10: civilWar });
    const asked = plexHas(() => []);
    await matchWatch.noteImports([imported('movie', 10)], T0);

    await matchWatch.run(at(1));
    assert.equal(asked.length, 0, 'not looked at before the first look');
    const looks = LOOKS_AT_MS.map((ms) => ms / MIN);
    assert.deepEqual(looks, [2, 7, 22, 52, 112]);
    for (const [i, minute] of looks.entries()) {
      await matchWatch.run(at(minute));
      assert.equal(asked.length, i + 1);
      const [row] = await pending();
      if (i < looks.length - 1) {
        assert.equal(row.nextCheckAt.getTime(), at(looks[i + 1]).getTime());
      } else {
        assert.equal(row, undefined, 'given up after about two hours');
      }
    }
    assert.equal((await problems()).length, 0);
    assert.equal(sent.length, 0);
  });

  it('tells a match to another title once, gathered, with the fix and a link', async () => {
    const film = await requestedMovie(929590, 10);
    radarrHas({ 10: civilWar });
    plexHas(() => [guerraCivil()]);
    await matchWatch.noteImports([imported('movie', 10)], T0);

    await matchWatch.run(at(2));
    const [problem] = await problems();
    assert.equal(problem.notice, 'waiting', 'told as soon as it is certain');
    assert.equal(sent.length, 0, 'but others found soon after join it');

    // The requester's request keeps waiting for the server, saying so.
    const [waiting] = downloadTracker.getMovieProgress(0, 10);
    assert.equal(waiting.stage, 'imported');
    assert.equal(waiting.matching, 'Plex');

    await matchWatch.run(at(2 + GATHER_MS / MIN));
    assert.equal(sent.length, 1);
    const [message] = sent;
    assert.equal(message.notifyAdmin, true);
    assert.equal(message.notifyUser, undefined, 'never the requester');
    assert.equal(message.event, 'Wrong match');
    assert.match(message.subject, /^Civil War \(2024\): Plex matched/);
    assert.match(message.subject, /Guerra Civil \(2024\)/);
    assert.match(
      message.message ?? '',
      /Fix Match in Plex, searching tmdb-929590/
    );
    assert.match(message.message ?? '', /rename the file in Radarr/);
    assert.equal(message.actionUrl, `/movie/${film.tmdbId}`);

    // Looked at again in its window, and imported again later: never again.
    for (const minute of [22, 52, 112]) await matchWatch.run(at(minute));
    await matchWatch.noteImports([imported('movie', 10)], at(300));
    for (const minute of [302, 307, 330]) await matchWatch.run(at(minute));
    assert.equal(sent.length, 1);
    assert.equal((await problems()).length, 1);
  });

  it('says "not matched" only once the server has had its time', async () => {
    await requestedMovie(929590, 10);
    radarrHas({ 10: civilWar });
    plexHas(() => [
      plexMovie('70', 'Civil War', undefined, 'Civil War (2024)', []),
    ]);
    await matchWatch.noteImports([imported('movie', 10)], T0);

    for (const minute of [2, 7, 22, 52]) {
      await matchWatch.run(at(minute));
      assert.equal((await problems()).length, 0, `not yet at ${minute}`);
    }
    await matchWatch.run(at(112));
    const [problem] = await problems();
    assert.equal(JSON.parse(problem.problem).reason, 'unmatched');
    await matchWatch.run(at(122));
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /Plex has not matched "Civil War \(2024\)"/);
  });

  it('puts problems found close together into one message', async () => {
    await requestedMovie(929590, 10);
    await requestedMovie(1000, 12);
    radarrHas({
      10: civilWar,
      12: { title: 'Eden', year: 2025, tmdbId: 1000, folder: 'Eden (2025)' },
    });
    plexHas(() => [
      guerraCivil(),
      plexMovie('71', 'Eden', 2025, 'Eden (2025)', ['tmdb://1455674']),
    ]);
    await matchWatch.noteImports([imported('movie', 10)], T0);
    await matchWatch.noteImports([imported('movie', 12)], at(5));

    await matchWatch.run(at(2));
    await matchWatch.run(at(7));
    assert.equal((await problems()).length, 2);
    await matchWatch.run(at(11));
    assert.equal(sent.length, 0);
    await matchWatch.run(at(12));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, '2 wrong matches');
    assert.match(sent[0].message ?? '', /Civil War/);
    assert.match(sent[0].message ?? '', /Eden/);
    assert.match(
      sent[0].message ?? '',
      /https:\/\/seerr\.example\/movie\/1000/,
      'each with a link to its page'
    );
    assert.equal(sent[0].actionUrl, '/settings/health');
  });

  it(`sends at most ${DAILY_MESSAGES} messages a day, then counts the rest in the next`, async () => {
    const media = await requestedMovie(1, 1);
    const found = async (n: number, minute: number) =>
      getRepository(MatchProblem).insert({
        key: `Plex|movie|tmdb:${n}|tmdb:9${n}`,
        mediaId: media.id,
        mediaServer: 'Plex',
        kind: 'movie',
        problem: JSON.stringify({
          kind: 'movie',
          folder: `Film ${n}`,
          expected: { title: `Film ${n}`, tmdbId: n, server: 'Radarr' },
          mediaServer: 'Plex',
          matched: { title: `Other ${n}`, key: `${n}`, tmdbId: 900 + n },
          reason: 'other',
        }),
        notice: 'waiting',
        foundAt: at(minute),
      });
    for (let n = 1; n <= 7; n++) {
      await found(n, n * 60);
      await matchWatch.run(at(n * 60 + 10));
    }
    assert.equal(sent.length, DAILY_MESSAGES);
    assert.deepEqual(
      (await problems()).map((p) => p.notice),
      ['sent', 'sent', 'sent', 'sent', 'sent', 'held', 'held']
    );

    // A day after the first message, the next one says how many more.
    await found(8, 24 * 60 + 61);
    await matchWatch.run(at(24 * 60 + 71));
    assert.equal(sent.length, DAILY_MESSAGES + 1);
    assert.match(sent.at(-1)?.message ?? '', /Plus 2 more/);
    assert.deepEqual(
      (await problems()).slice(5).map((p) => p.notice),
      ['counted', 'counted', 'sent']
    );
  });

  it('clears a problem put right without a word', async () => {
    await requestedMovie(929590, 10);
    radarrHas({ 10: civilWar });
    let fixed = false;
    plexHas(() => [
      fixed
        ? plexMovie('70', 'Civil War', 2024, 'Civil War (2024)', [
            'tmdb://929590',
          ])
        : guerraCivil(),
    ]);
    await matchWatch.noteImports([imported('movie', 10)], T0);
    await matchWatch.run(at(2));
    assert.equal(downloadTracker.getMovieProgress(0, 10).length, 1);

    fixed = true;
    await matchWatch.run(at(7));
    const [problem] = await problems();
    assert.ok(problem.resolvedAt);
    assert.equal(problem.notice, 'none');
    assert.equal((await pending()).length, 0, 'stops looking once it is right');
    await matchWatch.run(at(30));
    assert.equal(sent.length, 0);
    assert.equal(downloadTracker.getMovieProgress(0, 10).length, 0);
  });

  it('carries on after a restart from what it kept', async () => {
    await requestedMovie(929590, 10);
    radarrHas({ 10: civilWar });
    plexHas(() => [guerraCivil()]);
    await matchWatch.noteImports([imported('movie', 10)], T0);
    await matchWatch.run(at(2));

    // A restart: nothing is held in memory but the waiting lines, which
    // start empty.
    downloadTracker.setMatchWaits([]);
    assert.equal(downloadTracker.getMovieProgress(0, 10).length, 0);
    await matchWatch.run(at(12));
    assert.equal(sent.length, 1, 'the problem found before is still told');
    assert.equal(downloadTracker.getMovieProgress(0, 10).length, 1);
    assert.equal((await pending()).length, 1, 'and is still looked at');
  });

  it('checks each connected server on its own', async () => {
    getSettings().jellyfin = {
      ...jellyfinDefaults(),
      connected: true,
      ip: 'jf.invalid',
      apiKey: 'jk',
      libraries: [{ id: 'jm', name: 'Films', enabled: true, type: 'movie' }],
    };
    await requestedMovie(929590, 10);
    radarrHas({ 10: civilWar });
    plexHas(() => [
      plexMovie('70', 'Civil War', 2024, 'Civil War (2024)', ['tmdb://929590']),
    ]);
    mock.method(JellyfinAPI.prototype, 'getMatchItems', async () => [
      {
        Id: 'jf-1',
        Name: 'Guerra Civil',
        Type: 'Movie',
        ProductionYear: 2024,
        Path: '/media/films/Civil War (2024)/f.mkv',
        ProviderIds: { Tmdb: '1310753' },
      },
    ]);
    await matchWatch.noteImports([imported('movie', 10)], T0);
    await matchWatch.run(at(2));
    const rows = await problems();
    assert.deepEqual(
      rows.map((r) => r.mediaServer),
      ['Jellyfin']
    );
    assert.deepEqual(
      (await pending()).map((r) => r.mediaServer),
      ['Jellyfin'],
      'Plex is right, so is no longer looked at'
    );
    await matchWatch.run(at(12));
    assert.match(
      sent[0].message ?? '',
      /Identify in Jellyfin, entering TMDB id 929590/
    );
  });

  it('finds a series by its folder, once for the series', async () => {
    const show = await dataSource.manager.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 288673,
        tvdbId: 455755,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 20,
      }),
      { listeners: false }
    );
    await dataSource.manager.save(
      new MediaRequest({
        type: MediaType.TV,
        status: MediaRequestStatus.APPROVED,
        media: show,
        requestedBy: await requester(),
        is4k: false,
      }),
      { listeners: false }
    );
    mock.method(SonarrAPI.prototype, 'getSeriesById', async () => ({
      id: 20,
      title: 'Carrie',
      year: 2026,
      tvdbId: 455755,
      tmdbId: 288673,
      path: '/tv/Carrie',
    }));
    plexHas(
      () => [],
      [
        {
          ratingKey: '126741',
          title: 'The Carrie Diaries',
          year: 2013,
          guid: 'plex://show/x',
          type: 'show',
          Guid: [{ id: 'tvdb://257454' }],
          Location: [{ path: '/data/tv/Carrie' }],
          Media: [],
        } as unknown as PlexLibraryItem,
      ]
    );
    await matchWatch.noteImports(
      [imported('series', 20), imported('series', 20)],
      T0
    );
    assert.equal((await pending()).length, 1);
    await matchWatch.run(at(2));
    await matchWatch.run(at(12));
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /The Carrie Diaries/);
    assert.match(sent[0].message ?? '', /searching tvdb-455755/);
  });

  it('compares albums by their MusicBrainz ids, or clearly different names', async () => {
    const ARTIST = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
    const KID_A = 'b8a7c51f-362c-4dcb-a259-bc6e0095f0a6';
    const OK = '0b6b4ba0-d36f-47bd-b4ea-6a5b91842d29';
    const media = await dataSource.manager.save(
      new Media({
        mediaType: MediaType.MUSIC,
        tmdbId: 0,
        foreignId: ARTIST,
        foreignTitle: 'Radiohead',
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 30,
      }),
      { listeners: false }
    );
    await dataSource.manager.save(
      new MediaRequest({
        type: MediaType.MUSIC,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: await requester(),
        is4k: false,
        albums: [
          new AlbumRequest({ albumMbid: KID_A, title: 'Kid A', status: 2 }),
          new AlbumRequest({ albumMbid: OK, title: 'OK Computer', status: 2 }),
        ],
      }),
      { listeners: false }
    );
    const albums: Record<
      number,
      { title: string; mbid: string; date: string }
    > = {
      40: { title: 'Kid A', mbid: KID_A, date: '2000-10-02' },
      41: { title: 'OK Computer', mbid: OK, date: '1997-05-21' },
    };
    stub(LidarrAPI, 'getAlbum', (async (id: number) => ({
      id,
      title: albums[id].title,
      foreignAlbumId: albums[id].mbid,
      releaseDate: albums[id].date,
      releases: [{ foreignReleaseId: `${albums[id].mbid}-r` }],
      artist: { artistName: 'Radiohead', foreignArtistId: ARTIST },
    })) as never);
    stub(LidarrAPI, 'getTrackFiles', (async (id: number) => [
      { id: 1, path: `/music/Radiohead/${albums[id].title}/01.flac` },
    ]) as never);
    const plexAlbums: PlexMusicItem[] = [
      // Kid A's folder, matched to another album entirely.
      {
        ratingKey: 'p40',
        type: 'album',
        title: 'Pablo Honey',
        year: 1993,
        parentTitle: 'Radiohead',
        Guid: [{ id: 'mbid://11111111-1111-1111-1111-111111111111' }],
      },
      // OK Computer's, with no MusicBrainz id and its own names: fine.
      {
        ratingKey: 'p41',
        type: 'album',
        title: 'OK Computer (Remastered)',
        year: 1997,
        parentTitle: 'Radiohead',
      },
    ];
    mock.method(
      PlexAPI.prototype,
      'getRecentlyAddedAlbums',
      async () => plexAlbums
    );
    mock.method(PlexAPI.prototype, 'getAlbumTracks', async (key: string) => [
      {
        Media: [
          {
            Part: [
              {
                file: `/data/music/Radiohead/${key === 'p40' ? 'Kid A' : 'OK Computer'}/01.flac`,
              },
            ],
          },
        ],
      },
    ]);
    const album = (id: number) => ({
      id,
      title: albums[id].title,
      foreignAlbumId: albums[id].mbid,
    });
    await matchWatch.noteImports(
      [imported('music', 30, album(40)), imported('music', 30, album(41))],
      T0
    );
    assert.equal((await pending()).length, 2);
    await matchWatch.run(at(2));
    const rows = await problems();
    assert.equal(rows.length, 1);
    const problem = JSON.parse(rows[0].problem);
    assert.equal(problem.kind, 'music');
    assert.equal(problem.expected.mbid, KID_A);
    assert.equal(rows[0].arrAlbumId, 40);
    assert.deepEqual(
      (await pending()).map((r) => r.arrItemId),
      [40],
      'OK Computer is right'
    );
    // The requester's album waits for the server; the other does not.
    assert.deepEqual(
      downloadTracker.getMusicProgress(0, 30).map((i) => i.album?.id),
      [40]
    );
    await matchWatch.run(at(12));
    assert.match(sent[0].subject, /Pablo Honey/);
    assert.match(sent[0].message ?? '', /Fix Match in Plex and pick Kid A/);
    assert.equal(sent[0].actionUrl, `/music/album/${KID_A}`);
  });
});

describe('sharing what is found with the nightly Match Check', () => {
  afterEach(async () => {
    // The nightly report is kept in memory too: an empty run clears it.
    mock.method(SonarrAPI.prototype, 'getSeries', async () => []);
    stub(RadarrAPI, 'getMovies', (async () => []) as never);
    mock.method(PlexAPI.prototype, 'getLibraryContents', async () => ({
      totalSize: 0,
      items: [],
    }));
    await plexMatchCheck.run();
    await fs.rm(REPORT_PATH, { force: true });
  });

  const nightlyFinds = async (items: PlexLibraryItem[]) => {
    mock.method(SonarrAPI.prototype, 'getSeries', async () => []);
    stub(RadarrAPI, 'getMovies', (async () => [
      {
        title: civilWar.title,
        year: civilWar.year,
        tmdbId: civilWar.tmdbId,
        imdbId: civilWar.imdbId,
        path: `/movies/${civilWar.folder}`,
      },
    ]) as never);
    mock.method(
      PlexAPI.prototype,
      'getLibraryContents',
      async (id: string) => ({
        totalSize: id === '1' ? items.length : 0,
        items: id === '1' ? items : [],
      })
    );
    await plexMatchCheck.run();
  };

  it('does not tell what the nightly check listed already', async () => {
    await nightlyFinds([guerraCivil()]);
    await requestedMovie(929590, 10);
    radarrHas({ 10: civilWar });
    plexHas(() => [guerraCivil()]);
    await matchWatch.noteImports([imported('movie', 10)], T0);
    await matchWatch.run(at(2));
    await matchWatch.run(at(12));
    const [problem] = await problems();
    assert.equal(problem.notice, 'none');
    assert.equal(sent.length, 0);
  });

  it('is not told again when the nightly check finds it, and is cleared when it finds it right', async () => {
    await requestedMovie(929590, 10);
    radarrHas({ 10: civilWar });
    plexHas(() => [guerraCivil()]);
    await matchWatch.noteImports([imported('movie', 10)], T0);
    await matchWatch.run(at(2));
    await matchWatch.run(at(12));
    assert.equal(sent.length, 1);

    await nightlyFinds([guerraCivil()]);
    assert.equal(sent.length, 1);
    const [still] = await problems();
    assert.equal(still.resolvedAt, null);

    await nightlyFinds([
      plexMovie('70', 'Civil War', 2024, 'Civil War (2024)', ['tmdb://929590']),
    ]);
    const [cleared] = await problems();
    assert.ok(cleared.resolvedAt, 'the nightly check found it right');
    assert.equal(sent.length, 1, 'without a word');
    assert.equal(downloadTracker.getMovieProgress(0, 10).length, 0);
  });
});
