import PlexTvAPI from '@server/api/plextv';
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import type {
  EpisodeSubtitles,
  MovieSubtitles,
  SeriesSubtitles,
  SubtitleSearchResponse,
  TranscriptionStatus,
} from '@server/interfaces/api/subtitlesInterfaces';
import { Permission } from '@server/lib/permissions';
import { pickStream } from '@server/lib/plexSubtitles';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import {
  forgetWhisper,
  gapsOf,
  originsOf,
  queueMovieTranscription,
  transcribedPaths,
} from '@server/lib/subtitles';
import transcriber, { Transcriber } from '@server/lib/transcriber';
import subtitleRoutes, { episodesToTranscribe } from '@server/routes/subtitles';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * Subtitles, against a stand-in Bazarr answering with what a real one
 * (1.6.3) sends, and a stand-in Plex server, behind the real OpenAPI
 * validator.
 */

setupTestDb();

const KEY = 'bazarr-key';
const RADARR_ID = 3745;
const SONARR_ID = 844;

const movie = {
  radarrId: RADARR_ID,
  title: '10 Cloverfield Lane',
  profileId: 2,
  sceneName: '10.Cloverfield.Lane.2016.1080p.BDRip.DDP7.1.Atmos.x265-Vialle',
  subtitles: [
    {
      name: 'English',
      code2: 'en',
      code3: 'eng',
      path: null,
      forced: false,
      hi: false,
      file_size: null,
      embedded_track_id: 2,
      id: 102498,
    },
    {
      name: 'English',
      code2: 'en',
      code3: 'eng',
      path: '/movies/10 Cloverfield Lane (2016)/10 Cloverfield Lane (2016) Bluray-1080p.eng.srt',
      forced: false,
      hi: false,
      file_size: 54358,
      embedded_track_id: null,
      id: 103755,
    },
  ],
  missing_subtitles: [],
};

const SEASON_4 = '/tv/LEGO Ninjago - Dragons Rising/Season 4/';
const episode = (n: number, subtitles: unknown[], missing = false) => ({
  sonarrSeriesId: SONARR_ID,
  sonarrEpisodeId: 139840 + n,
  season: 4,
  episode: n,
  title: `Episode ${n}`,
  subtitles,
  missing_subtitles: missing
    ? [{ name: 'English', code2: 'en', code3: 'eng', forced: false, hi: false }]
    : [],
});
const fileSub = (n: number) => ({
  name: 'English',
  code2: 'en',
  code3: 'eng',
  path: `${SEASON_4}E${n}.en.srt`,
  forced: false,
  hi: false,
  file_size: 20000,
  id: 900 + n,
});
const episodes = [
  episode(10, [
    {
      name: 'English',
      code2: 'en',
      path: null,
      forced: false,
      hi: false,
      embedded_track_id: 2,
      id: 810,
    },
  ]),
  episode(11, [], true),
  episode(18, [fileSub(18)]),
  episode(19, [fileSub(19)]),
];

/** Newest first, as Bazarr sends history. */
const historyFor: Record<number, unknown[]> = {
  [139840 + 18]: [
    { action: 5, provider: null, subtitles_path: `${SEASON_4}E18.en.srt` },
    {
      action: 1,
      provider: 'whisperai',
      subtitles_path: `${SEASON_4}E18.en.srt`,
    },
  ],
  [139840 + 19]: [
    {
      action: 1,
      provider: 'opensubtitlescom',
      subtitles_path: `${SEASON_4}E19.en.srt`,
    },
    {
      action: 1,
      provider: 'whisperai',
      subtitles_path: `${SEASON_4}E19.en.srt`,
    },
  ],
};

const searchResults = [
  {
    provider: 'opensubtitlescom',
    subtitle: 'f5039fa8',
    language: 'en',
    score: 90,
    hearing_impaired: 'False',
    forced: 'False',
    original_format: 'False',
    release_info: ['10 Cloverfield Lane (2016) Bluray-1080p tt1179933'],
    matches: ['hearing_impaired', 'resolution', 'year', 'source', 'title'],
    dont_matches: ['audio_codec', 'hash', 'video_codec', 'release_group'],
    uploader: 'someone',
    url: 'https://example.invalid',
  },
  {
    provider: 'whisperai',
    subtitle: '869461e4',
    language: 'en',
    score: 33,
    hearing_impaired: 'False',
    forced: 'False',
    original_format: 'False',
    release_info: ['transcribe English audio -> English SRT'],
    matches: ['hearing_impaired', 'title'],
    dont_matches: ['year', 'source'],
    uploader: null,
    url: null,
  },
];

/** What the stand-in Bazarr has now; each test starts from the above. */
let movieNow: Omit<typeof movie, 'missing_subtitles'> & {
  missing_subtitles: unknown[];
} = movie;
let resultsNow: typeof searchResults = searchResults;
let providersOn = ['opensubtitlescom', 'whisperai'];
/** A provider Bazarr has paused: its error and when it tries again. */
let pausedNow: Record<string, { status: string; retry: string }> = {};
/** Holds Bazarr's own search open until released. */
let searchGate: Promise<void> | undefined;
/** Holds Plex's answers about single episodes open until released. */
let plexGate: Promise<void> | undefined;

const movieHistory = [
  { action: 5, provider: null, subtitles_path: movie.subtitles[1].path },
  {
    action: 2,
    provider: 'subsource',
    subtitles_path: movie.subtitles[1].path,
  },
];

/** What the stand-ins were asked to change. */
let writes: { method: string; path: string; fields: Record<string, string> }[] =
  [];
let plexWrites: {
  path: string;
  query: Record<string, string>;
  token: string;
}[] = [];

let bazarrPort = 0;
let plexPort = 0;
let port = 0;
const servers: Server[] = [];
let actingAs: User;
let admin: User;
let manager: User;
let member: User;

const listen = (handler: http.RequestListener) =>
  new Promise<number>((resolve) => {
    const server = http.createServer(handler).listen(0, () => {
      resolve((server.address() as AddressInfo).port);
    });
    servers.push(server);
  });

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });

const plexEpisode = (ratingKey: string, partId: number, selected?: number) => ({
  ratingKey,
  Media: [
    {
      Part: [
        {
          id: partId,
          Stream: [
            { id: 1, streamType: 1 },
            { id: 2, streamType: 2, languageCode: 'eng' },
            {
              id: partId + 1,
              streamType: 3,
              languageCode: 'eng',
              language: 'English',
              forced: true,
              displayTitle: 'English (Forced)',
              ...(selected === partId + 1 ? { selected: true } : {}),
            },
            {
              id: partId + 2,
              streamType: 3,
              languageCode: 'eng',
              language: 'English',
              displayTitle: 'English (SRT External)',
              key: `/library/streams/${partId + 2}`,
              ...(selected === partId + 2 ? { selected: true } : {}),
            },
            {
              id: partId + 3,
              streamType: 3,
              languageCode: 'spa',
              language: 'Spanish',
              displayTitle: 'Spanish (SRT External)',
              ...(selected === partId + 3 ? { selected: true } : {}),
            },
          ],
        },
      ],
    },
  ],
});

before(async () => {
  bazarrPort = await listen(async (req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    const send = (body: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (req.headers['x-api-key'] !== KEY) {
      return send('Unauthorized', 401);
    }
    const p = url.pathname.replace(/^\/api/, '');
    if (req.method === 'GET') {
      if (p === '/system/status') {
        return send({ data: { bazarr_version: '1.6.3-beta.5' } });
      }
      if (p === '/system/languages/profiles') {
        return send([
          {
            profileId: 2,
            name: 'English',
            items: [{ id: 1, language: 'en', hi: 'False', forced: 'False' }],
          },
        ]);
      }
      if (p === '/movies') {
        const id = Number(url.searchParams.get('radarrid[]'));
        return send({ data: id === RADARR_ID ? [movieNow] : [], total: 1 });
      }
      if (p === '/series') {
        const id = Number(url.searchParams.get('seriesid[]'));
        return send({
          data:
            id === SONARR_ID
              ? [
                  {
                    sonarrSeriesId: SONARR_ID,
                    title: 'LEGO Ninjago: Dragons Rising',
                    profileId: 2,
                  },
                ]
              : [],
        });
      }
      if (p === '/episodes') {
        return send({ data: episodes });
      }
      if (p === '/movies/history') {
        return send({ data: movieHistory, total: 7535 });
      }
      if (p === '/providers') {
        return send({
          data: providersOn.map((name) => ({
            name,
            status: pausedNow[name]?.status ?? 'Good',
            retry: pausedNow[name]?.retry ?? '-',
          })),
        });
      }
      if (p === '/episodes/history') {
        const id = Number(url.searchParams.get('episodeid'));
        return send({ data: historyFor[id] ?? [], total: 122492 });
      }
      if (p === '/providers/movies' || p === '/providers/episodes') {
        return send({ data: resultsNow });
      }
    }
    if (req.method === 'POST' || req.method === 'PATCH') {
      const fields = Object.fromEntries(
        new URLSearchParams(await readBody(req))
      );
      writes.push({ method: req.method, path: p, fields });
      if (req.method === 'PATCH' && searchGate) {
        await searchGate;
      }
      res.statusCode = 204;
      return res.end();
    }
    if (req.method === 'DELETE') {
      writes.push({
        method: 'DELETE',
        path: p,
        fields: Object.fromEntries(url.searchParams),
      });
      res.statusCode = 204;
      return res.end();
    }
    // Bazarr answers anything else with its web page.
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Bazarr</title>');
  });

  plexPort = await listen(async (req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    const token = String(req.headers['x-plex-token'] ?? '');
    res.setHeader('Content-Type', 'application/json');
    if (token !== 'server-token') {
      res.statusCode = 401;
      return res.end('{}');
    }
    if (req.method === 'PUT') {
      plexWrites.push({
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        token,
      });
      return res.end('');
    }
    if (url.pathname === '/library/metadata/121141') {
      return res.end(
        JSON.stringify({
          MediaContainer: { Metadata: [plexEpisode('121141', 500, 502)] },
        })
      );
    }
    if (url.pathname === '/library/metadata/900/allLeaves') {
      return res.end(
        JSON.stringify({
          MediaContainer: {
            Metadata: [
              { ratingKey: '902', parentIndex: 1, index: 2 },
              { ratingKey: '901', parentIndex: 1, index: 1 },
            ],
          },
        })
      );
    }
    const episodeKey = url.pathname.match(/^\/library\/metadata\/(90\d)$/);
    if (episodeKey) {
      if (plexGate) {
        await plexGate;
      }
      const n = Number(episodeKey[1]) - 900;
      return res.end(
        JSON.stringify({
          MediaContainer: {
            Metadata: [
              plexEpisode(episodeKey[1], 600 + n * 10, 600 + n * 10 + 3),
            ],
          },
        })
      );
    }
    res.statusCode = 404;
    res.end('{}');
  });

  const app = express();
  app.use(express.json());
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  app.use((req, _res, next) => {
    (req as unknown as { user: User }).user = actingAs;
    next();
  });
  app.use('/api/v1/subtitles', subtitleRoutes);
  app.use(
    (
      err: { status?: number; message: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );
  port = await listen(app);

  // plex.tv lists the servers someone can use, each with their own token.
  Object.defineProperty(PlexTvAPI.prototype, 'getDevices', {
    configurable: true,
    value: async () => [
      { clientIdentifier: 'other', accessToken: 'wrong' },
      { clientIdentifier: 'machine-1', accessToken: 'server-token' },
    ],
  });
});

after(() => servers.forEach((server) => server.close()));

beforeEach(async () => {
  writes = [];
  plexWrites = [];
  movieNow = movie;
  resultsNow = searchResults;
  providersOn = ['opensubtitlescom', 'whisperai'];
  pausedNow = {};
  searchGate = undefined;
  plexGate = undefined;
  forgetWhisper();
  const settings = getSettings();
  settings.bazarr = {
    hostname: '127.0.0.1',
    port: bazarrPort,
    useSsl: false,
    urlBase: '',
    apiKey: KEY,
  };
  settings.main.disabledFeatures = [];
  settings.main.mediaServerType = MediaServerType.PLEX;
  // Bazarr follows the main servers; the second ones number their titles
  // on their own, so the same ids name other titles there.
  settings.radarr = [
    { id: 0, name: 'Radarr', is4k: false, isDefault: true },
    { id: 1, name: 'Radarr Anime', is4k: false, isDefault: false },
  ] as RadarrSettings[];
  settings.sonarr = [
    { id: 0, name: 'Sonarr', is4k: false, isDefault: true },
    { id: 1, name: 'Sonarr Anime', is4k: false, isDefault: false },
  ] as SonarrSettings[];
  settings.plex = {
    ...settings.plex,
    machineId: 'machine-1',
    ip: '127.0.0.1',
    port: plexPort,
    useSsl: false,
  };

  const users = getRepository(User);
  admin = await users.save(
    new User({
      email: 'subs-admin@test.local',
      permissions: Permission.ADMIN,
      avatar: '',
    })
  );
  manager = await users.save(
    new User({
      email: 'subs-manager@test.local',
      permissions: Permission.MANAGE_REQUESTS,
      avatar: '',
    })
  );
  member = await users.save(
    new User({
      email: 'subs-member@test.local',
      permissions: Permission.REQUEST,
      avatar: '',
      plexToken: 'member-plex-tv-token',
    })
  );
  actingAs = member;

  await getRepository(Media).save([
    new Media({
      tmdbId: 333371,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.AVAILABLE,
      serviceId: 0,
      externalServiceId: RADARR_ID,
      ratingKey: '121141',
    }),
    new Media({
      tmdbId: 212989,
      mediaType: MediaType.TV,
      status: MediaStatus.AVAILABLE,
      serviceId: 0,
      externalServiceId: SONARR_ID,
      ratingKey: '900',
    }),
    // On the second servers, under ids the main ones gave other titles.
    new Media({
      tmdbId: 990001,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.AVAILABLE,
      serviceId: 1,
      externalServiceId: RADARR_ID,
    }),
    new Media({
      tmdbId: 990002,
      mediaType: MediaType.TV,
      status: MediaStatus.AVAILABLE,
      serviceId: 1,
      externalServiceId: SONARR_ID,
    }),
  ]);
});

const call = <T = Record<string, unknown>>(
  method: string,
  route: string,
  body?: unknown
) =>
  new Promise<{ status: number; body: T }>((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/v1/subtitles${route}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data ? JSON.parse(data) : ({} as T),
          })
        );
      }
    );
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(check(), 'it happened');
};

describe('reading a title’s subtitles', () => {
  it('lists a movie’s subtitles, without the folders on the server', async () => {
    const { status, body } = await call<MovieSubtitles>('GET', '/movie/333371');
    assert.equal(status, 200);
    assert.deepEqual([body.profile, body.wanted], ['English', ['en']]);
    assert.deepEqual(
      body.tracks.map((t) => [t.id, t.kind, t.fileName, t.ai]),
      [
        [102498, 'embedded', undefined, false],
        [
          103755,
          'file',
          '10 Cloverfield Lane (2016) Bluray-1080p.eng.srt',
          false,
        ],
      ]
    );
    assert.ok(!JSON.stringify(body).includes('/movies/'));
    assert.deepEqual(
      [body.tracks[1].origin, body.tracks[1].provider],
      ['downloaded', 'subsource'],
      'downloaded by hand, then synced'
    );
    assert.equal(body.tracks[0].origin, undefined, 'inside the video');
  });

  it('marks the episodes whose subtitle Whisper made, by its latest download', async () => {
    const { status, body } = await call<SeriesSubtitles>('GET', '/tv/212989');
    assert.equal(status, 200);
    const byNumber = new Map(body.episodes.map((e) => [e.episodeNumber, e]));
    assert.equal(byNumber.get(18)?.tracks[0].ai, true, 'synced afterwards');
    assert.equal(byNumber.get(18)?.tracks[0].origin, 'transcribed');
    assert.equal(byNumber.get(19)?.tracks[0].ai, false, 'replaced since');
    assert.deepEqual(
      [
        byNumber.get(19)?.tracks[0].origin,
        byNumber.get(19)?.tracks[0].provider,
      ],
      ['downloaded', 'opensubtitlescom']
    );
    assert.equal(byNumber.get(10)?.tracks[0].kind, 'embedded');
    assert.equal(byNumber.get(11)?.missing[0].language, 'en');
  });

  it('is not found when Bazarr is not set up, or the switch is off', async () => {
    getSettings().bazarr = { ...getSettings().bazarr, apiKey: '' };
    assert.equal((await call('GET', '/movie/333371')).status, 404);
    getSettings().bazarr = { ...getSettings().bazarr, apiKey: KEY };
    getSettings().main.disabledFeatures = ['subtitles'];
    assert.equal((await call('GET', '/movie/333371')).status, 404);
  });

  it('leaves alone a title on a Radarr or Sonarr Bazarr does not follow', async () => {
    actingAs = admin;
    for (const route of [
      'GET /movie/990001',
      'GET /tv/990002',
      'GET /movie/990001/search',
      'DELETE /movie/990001/subtitle/103755',
      'POST /movie/990001/transcription',
      'POST /tv/990002/search-missing',
    ]) {
      const [method, url] = route.split(' ');
      const { status, body } = await call<{ code?: string }>(method, url);
      assert.deepEqual([status, body.code], [404, 'notInBazarr'], route);
    }
    assert.deepEqual(writes, [], 'nothing was asked of Bazarr');
    assert.equal(transcriber.status('movie:990001').queued, 0);
    assert.equal(transcriber.status('movie:990001').running, false);
  });

  it('says so for a title Radarr does not have', async () => {
    const { status, body } = await call('GET', '/movie/1');
    assert.deepEqual(
      [status, body.message, body.code],
      [404, 'This movie is not in Radarr.', 'notInArr']
    );
  });
});

describe('searching, downloading and deleting', () => {
  it('leaves searching to people who manage requests', async () => {
    assert.equal((await call('GET', '/movie/333371/search')).status, 403);
    actingAs = manager;
    const { status, body: answer } = await call<SubtitleSearchResponse>(
      'GET',
      '/movie/333371/search'
    );
    const body = answer.results;
    assert.equal(status, 200);
    assert.equal(answer.noneFound, undefined);
    assert.deepEqual(body[0].matched, [
      'title',
      'year',
      'source',
      'resolution',
    ]);
    assert.deepEqual(body[0].missed, [
      'release_group',
      'video_codec',
      'audio_codec',
    ]);
    assert.deepEqual([body[1].ai, body[1].score], [true, 33]);
  });

  it('downloads the chosen result for an episode, by Sonarr’s ids', async () => {
    actingAs = manager;
    const { status } = await call(
      'POST',
      '/tv/212989/season/4/episode/11/download',
      {
        provider: 'opensubtitlescom',
        subtitle: 'abc',
        hi: false,
        forced: false,
        originalFormat: false,
      }
    );
    assert.equal(status, 204);
    assert.deepEqual(writes, [
      {
        method: 'POST',
        path: '/providers/episodes',
        fields: {
          seriesid: String(SONARR_ID),
          episodeid: '139851',
          hi: 'False',
          forced: 'False',
          original_format: 'False',
          provider: 'opensubtitlescom',
          subtitle: 'abc',
        },
      },
    ]);
  });

  it('deletes only files, and only for admins', async () => {
    actingAs = manager;
    assert.equal(
      (await call('DELETE', '/movie/333371/subtitle/103755')).status,
      403
    );
    actingAs = admin;
    assert.equal(
      (await call('DELETE', '/movie/333371/subtitle/102498')).status,
      404,
      'a track inside the video'
    );
    assert.equal(
      (await call('DELETE', '/movie/333371/subtitle/103755')).status,
      204
    );
    assert.deepEqual(writes[0], {
      method: 'DELETE',
      path: '/movies/subtitles',
      fields: {
        radarrid: String(RADARR_ID),
        language: 'en',
        forced: 'False',
        hi: 'False',
        path: movie.subtitles[1].path ?? '',
      },
    });
  });

  it('starts Bazarr’s own search, then transcribes what it could not find', async () => {
    actingAs = manager;
    let release: () => void = () => undefined;
    searchGate = new Promise<void>((resolve) => (release = resolve));
    const started = await call<
      TranscriptionStatus & { transcribeAfter: boolean }
    >('POST', '/tv/212989/search-missing');
    assert.equal(started.status, 202);
    assert.deepEqual(
      [started.body.searching, started.body.transcribeAfter],
      [true, true]
    );
    await waitFor(() => writes.length === 1);
    assert.deepEqual(writes[0], {
      method: 'PATCH',
      path: '/series',
      fields: { seriesid: String(SONARR_ID), action: 'search-missing' },
    });
    const during = await call<TranscriptionStatus>(
      'GET',
      '/tv/212989/transcription'
    );
    assert.equal(during.body.searching, true, 'followed while it searches');

    release();
    // Episode 11 still has no English: Whisper's, from a fresh search.
    await waitFor(() => writes.length === 2);
    assert.deepEqual(
      [writes[1].path, writes[1].fields.episodeid, writes[1].fields.provider],
      ['/providers/episodes', '139851', 'whisperai']
    );
    await waitFor(() => !transcriber.status('tv:212989').running);
    const after = transcriber.status('tv:212989');
    assert.deepEqual(
      [after.searching, after.queued, after.auto],
      [false, 0, 0]
    );
  });

  it('transcribes nothing after a search when Bazarr has no Whisper', async () => {
    actingAs = manager;
    providersOn = ['opensubtitlescom'];
    const started = await call<{ transcribeAfter: boolean }>(
      'POST',
      '/tv/212989/search-missing'
    );
    assert.equal(started.body.transcribeAfter, false);
    await waitFor(() => !transcriber.status('tv:212989').searching);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      writes.map((w) => w.path),
      ['/series']
    );
  });
});

describe('a search that finds nothing', () => {
  const noEnglish = {
    ...movie,
    subtitles: [movie.subtitles[0]],
    missing_subtitles: [
      { name: 'English', code2: 'en', code3: 'eng', forced: false, hi: false },
    ],
  };

  it('transcribes the missing subtitle with the Whisper result it offered', async () => {
    actingAs = manager;
    movieNow = noEnglish;
    resultsNow = [searchResults[1]];
    const { status, body } = await call<SubtitleSearchResponse>(
      'GET',
      '/movie/333371/search?transcribeIfNone=true'
    );
    assert.equal(status, 200);
    assert.equal(body.noneFound, 'started');
    assert.deepEqual(
      body.results.map((r) => r.provider),
      ['whisperai']
    );
    await waitFor(() => writes.length === 1);
    assert.deepEqual(writes[0], {
      method: 'POST',
      path: '/providers/movies',
      fields: {
        radarrid: String(RADARR_ID),
        hi: 'False',
        forced: 'False',
        original_format: 'False',
        provider: 'whisperai',
        subtitle: '869461e4',
      },
    });
    await waitFor(() => !transcriber.status('movie:333371').running);
  });

  it('only when asked to', async () => {
    actingAs = manager;
    movieNow = noEnglish;
    resultsNow = [searchResults[1]];
    const { body } = await call<SubtitleSearchResponse>(
      'GET',
      '/movie/333371/search'
    );
    assert.equal(body.noneFound, undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(writes, []);
  });

  it('never replaces a subtitle already there', async () => {
    actingAs = manager;
    resultsNow = [searchResults[1]];
    const { body } = await call<SubtitleSearchResponse>(
      'GET',
      '/movie/333371/search?transcribeIfNone=true'
    );
    assert.equal(body.noneFound, 'notMissing');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(writes, []);
  });

  it('leaves it to the person when a provider has the missing language', async () => {
    actingAs = manager;
    movieNow = noEnglish;
    const { body } = await call<SubtitleSearchResponse>(
      'GET',
      '/movie/333371/search?transcribeIfNone=true'
    );
    assert.equal(body.noneFound, undefined);
    assert.deepEqual(writes, []);
  });

  it('says so when there is no Whisper to transcribe with', async () => {
    actingAs = manager;
    movieNow = noEnglish;
    resultsNow = [];
    const { body } = await call<SubtitleSearchResponse>(
      'GET',
      '/movie/333371/search?transcribeIfNone=true'
    );
    assert.deepEqual([body.noneFound, body.results], ['unavailable', []]);
  });

  it('does the same for an episode', async () => {
    actingAs = manager;
    resultsNow = [searchResults[1]];
    const missing = await call<SubtitleSearchResponse>(
      'GET',
      '/tv/212989/season/4/episode/11/search?transcribeIfNone=true'
    );
    assert.equal(missing.body.noneFound, 'started');
    await waitFor(() => writes.length === 1);
    assert.deepEqual(
      [writes[0].path, writes[0].fields.episodeid, writes[0].fields.subtitle],
      ['/providers/episodes', '139851', '869461e4']
    );
    await waitFor(() => !transcriber.status('tv:212989').running);
    const covered = await call<SubtitleSearchResponse>(
      'GET',
      '/tv/212989/season/4/episode/19/search?transcribeIfNone=true'
    );
    assert.equal(covered.body.noneFound, 'notMissing');
  });

  it('skips a transcription whose gap was filled while it waited', async () => {
    // Queued when English was missing; by its turn, Bazarr has found one.
    queueMovieTranscription('movie:333371', RADARR_ID, {
      auto: true,
      known: searchResults[1],
    });
    await waitFor(() => !transcriber.isQueued(`movie:${RADARR_ID}`));
    assert.deepEqual(writes, []);
    const { done, failed } = transcriber.status('movie:333371');
    assert.deepEqual([done, failed], [1, 0], 'skipped, not failed');
  });
});

describe('transcribing', () => {
  it('transcribes the episodes asked for, leaving out ones already done', async () => {
    actingAs = manager;
    const { status, body } = await call<
      TranscriptionStatus & { added: number }
    >('POST', '/tv/212989/transcription', { scope: 'notTranscribed' });
    assert.equal(status, 202);
    // 10, 11 and 19; 18 is Whisper's already.
    assert.equal(body.added, 3);
    await waitFor(
      () => writes.filter((w) => w.path === '/providers/episodes').length === 3
    );
    assert.deepEqual(
      writes.map((w) => [w.fields.episodeid, w.fields.provider]),
      [
        ['139850', 'whisperai'],
        ['139851', 'whisperai'],
        ['139859', 'whisperai'],
      ]
    );
    const after = await call<TranscriptionStatus>(
      'GET',
      '/tv/212989/transcription'
    );
    assert.deepEqual(
      [
        after.body.queued,
        after.body.running,
        after.body.done,
        after.body.failed,
      ],
      [0, false, 3, 0]
    );
  });

  it('wants a season for a season', async () => {
    actingAs = manager;
    assert.equal(
      (await call('POST', '/tv/212989/transcription', { scope: 'season' }))
        .status,
      400
    );
  });

  it('is for people who manage requests', async () => {
    assert.equal(
      (await call('POST', '/movie/333371/transcription')).status,
      403
    );
  });

  it('says why it cannot start while Bazarr has Whisper paused', async () => {
    actingAs = manager;
    pausedNow = {
      whisperai: { status: 'ReadTimeout', retry: 'in 41 minutes' },
    };
    const movie = await call<{
      message: string;
      code?: string;
      error?: string;
      retry?: string;
    }>('POST', '/movie/333371/transcription');
    assert.equal(movie.status, 409);
    assert.equal(
      movie.body.message,
      'Bazarr paused WhisperAI after an error (ReadTimeout); it tries again in 41 minutes. Whisper may be busy with another job.'
    );
    assert.deepEqual(
      [movie.body.code, movie.body.error, movie.body.retry],
      ['whisperPaused', 'ReadTimeout', 'in 41 minutes'],
      'for the page to say in the viewer’s language'
    );
    const series = await call('POST', '/tv/212989/transcription', {
      scope: 'notTranscribed',
    });
    assert.equal(series.status, 409);
    assert.deepEqual(writes, [], 'nothing was asked of Bazarr');
  });

  it('keeps why one did not finish, for the title page', async () => {
    actingAs = manager;
    resultsNow = [];
    const started = await call('POST', '/movie/333371/transcription');
    assert.equal(started.status, 202);
    // Paused between the click and the search: the search offers nothing.
    pausedNow = {
      whisperai: { status: 'ReadTimeout', retry: 'in 41 minutes' },
    };
    await waitFor(() => !transcriber.status('movie:333371').running);
    const status = transcriber.status('movie:333371');
    assert.equal(status.failed, 1);
    assert.deepEqual(status.error, {
      code: 'whisperPaused',
      error: 'ReadTimeout',
      retry: 'in 41 minutes',
    });
  });

  it('tells anyone who looks only that Bazarr failed, not how', async () => {
    const queue = new Transcriber();
    queue.enqueue([
      {
        key: 'movie:1',
        owner: 'movie:1',
        run: async () => {
          throw new Error('connect ECONNREFUSED 10.0.0.5:6767');
        },
      },
    ]);
    await waitFor(() => queue.status('movie:1').failed === 1);
    assert.deepEqual(queue.status('movie:1').error, { code: 'bazarrFailed' });
  });
});

describe('the subtitle your own Plex player starts with', () => {
  it('reads and sets it for a movie with your own server token', async () => {
    const read = await call<{
      available: boolean;
      selected: number;
      options: { id: number }[];
    }>('GET', '/movie/333371/plex-default');
    assert.equal(read.status, 200);
    assert.deepEqual(
      [
        read.body.available,
        read.body.selected,
        read.body.options.map((o) => o.id),
      ],
      [true, 502, [501, 502, 503]]
    );
    assert.equal(
      (await call('PUT', '/movie/333371/plex-default', { streamId: 503 }))
        .status,
      204
    );
    assert.deepEqual(plexWrites, [
      {
        path: '/library/parts/500',
        query: { subtitleStreamID: '503', allParts: '1' },
        token: 'server-token',
      },
    ]);
    assert.equal(
      (await call('PUT', '/movie/333371/plex-default', { streamId: 999 }))
        .status,
      409,
      'not one of its subtitles'
    );
  });

  it('sets a series by language on every episode, plain over forced', async () => {
    const read = await call<{
      selected: string;
      languages: { code: string }[];
    }>('GET', '/tv/212989/plex-default');
    assert.deepEqual(
      [read.body.selected, read.body.languages.map((l) => l.code)],
      ['spa', ['eng', 'spa']]
    );
    assert.equal(
      (await call('PUT', '/tv/212989/plex-default', { language: 'eng' }))
        .status,
      202
    );
    await waitFor(() => plexWrites.length === 2);
    assert.deepEqual(
      plexWrites.map((w) => [w.path, w.query.subtitleStreamID]).sort(),
      [
        ['/library/parts/610', '612'],
        ['/library/parts/620', '622'],
      ]
    );
  });

  it('lets a newer choice for a series win over one still being set', async () => {
    let release: () => void = () => undefined;
    plexGate = new Promise<void>((resolve) => (release = resolve));
    for (const language of ['eng', 'spa']) {
      assert.equal(
        (await call('PUT', '/tv/212989/plex-default', { language })).status,
        202
      );
    }
    release();
    await waitFor(() => plexWrites.length >= 2);
    // Long enough for a pass still going to have written too.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(
      plexWrites.map((w) => [w.path, w.query.subtitleStreamID]).sort(),
      [
        ['/library/parts/610', '613'],
        ['/library/parts/620', '623'],
      ],
      'only Spanish, the later choice'
    );
  });

  it('is unavailable to someone without a Plex sign-in', async () => {
    actingAs = admin;
    const { body } = await call<{ available: boolean }>(
      'GET',
      '/movie/333371/plex-default'
    );
    assert.equal(body.available, false);
  });
});

describe('the pieces', () => {
  it('lets the newest download decide where a subtitle came from', () => {
    const paths = transcribedPaths([
      { action: 5, provider: null, subtitles_path: '/a.srt' },
      { action: 1, provider: 'whisperai', subtitles_path: '/a.srt' },
      { action: 0, provider: null, subtitles_path: '/b.srt' },
      { action: 1, provider: 'whisperai', subtitles_path: '/b.srt' },
      { action: 3, provider: 'whisperai', subtitles_path: '/c.srt' },
    ]);
    assert.deepEqual([...paths].sort(), ['/a.srt', '/c.srt']);
  });

  it('tells where each file came from', () => {
    const origins = originsOf([
      { action: 4, provider: null, subtitles_path: '/up.srt' },
      { action: 6, provider: null, subtitles_path: '/tr.srt' },
      { action: 5, provider: null, subtitles_path: '/dl.srt' },
      { action: 3, provider: 'subsource', subtitles_path: '/dl.srt' },
      { action: 0, provider: null, subtitles_path: '/gone.srt' },
      { action: 1, provider: 'subsource', subtitles_path: '/gone.srt' },
    ]);
    assert.deepEqual(Object.fromEntries(origins), {
      '/up.srt': { origin: 'uploaded' },
      '/tr.srt': { origin: 'translated' },
      '/dl.srt': { origin: 'downloaded', provider: 'subsource' },
    });
  });

  it('only counts a gap a transcription can fill without replacing anything', () => {
    const sub = (code2: string, extra: object = {}) => ({
      name: code2,
      code2,
      path: `/${code2}.srt`,
      forced: false,
      hi: false,
      ...extra,
    });
    const miss = (code2: string, extra: object = {}) => ({
      name: code2,
      code2,
      forced: false,
      hi: false,
      ...extra,
    });
    assert.deepEqual(
      gapsOf({
        subtitles: [
          sub('en'),
          sub('fr', { forced: true }),
          sub('de', { path: null }),
        ],
        missing_subtitles: [
          miss('en', { hi: true }),
          miss('es', { forced: true }),
          miss('fr'),
          miss('de'),
        ],
      }),
      ['fr', 'de']
    );
    assert.deepEqual(gapsOf(undefined), []);
  });

  it('picks the episodes each choice covers', () => {
    const ep = (s: number, e: number, ai = false, missing = false) =>
      ({
        seasonNumber: s,
        episodeNumber: e,
        title: '',
        tracks: ai ? [{ ai: true }] : [],
        missing: missing ? [{}] : [],
      }) as unknown as EpisodeSubtitles;
    const all = [
      ep(1, 1),
      ep(1, 2, true),
      ep(2, 1, false, true),
      ep(2, 2, true, true),
    ];
    const numbers = (list: EpisodeSubtitles[]) =>
      list.map((e) => `${e.seasonNumber}x${e.episodeNumber}`);
    assert.deepEqual(numbers(episodesToTranscribe(all, 'missing')), ['2x1']);
    assert.deepEqual(numbers(episodesToTranscribe(all, 'season', 1)), ['1x1']);
    assert.deepEqual(numbers(episodesToTranscribe(all, 'notTranscribed')), [
      '1x1',
      '2x1',
    ]);
    assert.deepEqual(numbers(episodesToTranscribe(all, 'episode', 1, 2)), []);
  });

  it('runs transcriptions one at a time, each once', async () => {
    const queue = new Transcriber();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const first = new Promise<void>((resolve) => (release = resolve));
    const task = (key: string, wait?: Promise<void>) => ({
      key,
      owner: 'tv:1',
      run: async () => {
        order.push(`start ${key}`);
        await wait;
        order.push(`end ${key}`);
      },
    });
    assert.equal(queue.enqueue([task('a', first), task('b')]), 2);
    assert.equal(queue.enqueue([task('a'), task('b')]), 0, 'already asked');
    assert.deepEqual(queue.status('tv:1'), {
      queued: 1,
      running: true,
      done: 0,
      failed: 0,
      searching: false,
      auto: 0,
    });
    release();
    await waitFor(() => order.length === 4);
    assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b']);
  });

  it('starts a series in the plainest subtitle of the language', () => {
    const streams = [
      { id: 1, streamType: 3, languageCode: 'eng', forced: '1' },
      { id: 2, streamType: 3, languageCode: 'eng', hearingImpaired: true },
      { id: 3, streamType: 3, languageCode: 'eng' },
    ];
    assert.equal(pickStream(streams, 'eng')?.id, 3);
    assert.equal(pickStream(streams.slice(0, 2), 'eng')?.id, 2);
    assert.equal(pickStream(streams, 'spa'), undefined);
  });
});
