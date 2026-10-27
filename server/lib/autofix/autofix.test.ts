import BazarrAPI from '@server/api/bazarr';
import { MusicBrainz } from '@server/api/musicbrainz';
import LidarrAPI from '@server/api/servarr/lidarr';
import TheMovieDb from '@server/api/themoviedb';
import { IssueType } from '@server/constants/issue';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import AgentRun from '@server/entity/AgentRun';
import type BackfillSeries from '@server/entity/BackfillSeries';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import Media from '@server/entity/Media';
import MusicAlbum from '@server/entity/MusicAlbum';
import { User } from '@server/entity/User';
import agent from '@server/lib/agent';
import { clearAiCache } from '@server/lib/ai';
import autofix, {
  classify,
  minutesOf,
  pickReplacement,
  seasonEpisodeIn,
  wrongLength,
} from '@server/lib/autofix';
import type {
  ArrEpisode,
  ArrExtras,
  ArrHistoryRecord,
  ArrRelease,
} from '@server/lib/autofix/arr';
import { FixRadarr, FixSonarr } from '@server/lib/autofix/arr';
import { titleInTheirWords } from '@server/lib/autofix/chat';
import backfill from '@server/lib/backfill/engine';
import BackfillSonarr from '@server/lib/backfill/sonarr';
import notificationManager from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import transcriber from '@server/lib/transcriber';
import aiRoutes from '@server/routes/ai';
import issueRoutes from '@server/routes/issue';
import { IssueCommentSubscriber } from '@server/subscriber/IssueCommentSubscriber';
import { IssueSubscriber } from '@server/subscriber/IssueSubscriber';
import { setupTestDb } from '@server/test/db';
import axios from 'axios';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';

setupTestDb();

/*
 * Fixing what people report, with Sonarr, Radarr, Bazarr and the model
 * stubbed at their API clients. The rejection texts are ones Sonarr gave on
 * the live server.
 */

const EXISTING =
  'Existing file on disk is of equal or higher preference: Bluray-1080p v1';

const release = (over: Partial<ArrRelease>): ArrRelease => ({
  guid: 'g',
  indexerId: 1,
  title: 'x',
  downloadAllowed: true,
  rejected: false,
  rejections: [],
  qualityWeight: 100,
  customFormatScore: 0,
  seeders: 1,
  ...over,
});

describe('Auto-fix: reading a report', () => {
  it('tells a wrong episode from a broken one and from missing ones', () => {
    assert.equal(
      classify('This is the wrong episode, it plays episode 5')?.kind,
      'wrongEpisode'
    );
    assert.equal(
      classify('episodes are mixed up in season 2')?.kind,
      'wrongEpisode'
    );
    assert.equal(
      classify("it won't play, just a black screen")?.kind,
      'broken'
    );
    assert.equal(classify('no sound at all')?.kind, 'broken');
    assert.equal(
      classify('there are a few missing episodes in season 3')?.kind,
      'missing'
    );
    assert.equal(classify('anything', IssueType.AUDIO)?.kind, 'broken');
    assert.equal(classify('great show, thanks'), undefined);
  });

  it('does not read ordinary words as a problem', () => {
    assert.equal(classify('the wrong guy wins in the end'), undefined);
    assert.equal(classify('I skipped the intro'), undefined);
    assert.equal(classify('it was buffering a bit last night'), undefined);
    assert.equal(
      classify('the episode is missing subtitles')?.kind,
      'subtitles'
    );
    assert.equal(
      classify('the subtitles are for the wrong episode', IssueType.SUBTITLES)
        ?.kind,
      'subtitles'
    );
    assert.equal(
      classify('this is the wrong episode', IssueType.VIDEO)?.kind,
      'wrongEpisode'
    );
  });

  it('reads subtitle requests, their language, and when they are wrong', () => {
    assert.deepEqual(classify('can I get spanish subtitles?'), {
      kind: 'subtitles',
      language: 'es',
      replace: undefined,
    });
    assert.deepEqual(classify('the subs are out of sync'), {
      kind: 'subtitles',
      language: undefined,
      replace: true,
    });
    assert.equal(classify('missing subtitles')?.kind, 'subtitles');
    assert.equal(
      classify('please transcribe the subtitles with whisper')?.kind,
      'transcribe'
    );
    assert.equal(
      classify('English and Spanish subtitles please')?.language,
      'en'
    );
  });

  it('reads how long a file runs, and when that is far off', () => {
    assert.equal(minutesOf('22:55')?.toFixed(2), '22.92');
    assert.equal(minutesOf('1:02:00'), 62);
    assert.equal(wrongLength(23, 22.9), false);
    assert.equal(wrongLength(23, 45), true);
    assert.equal(wrongLength(45, 42), false);
    assert.equal(wrongLength(undefined, 45), false);
  });
});

describe('Auto-fix: choosing another release', () => {
  const current = {
    title: '[Kaze-raws] Kitsuraga - 002 [480p]',
    group: 'Kaze-raws',
  };

  it('takes one Sonarr only turns down for the file already there, from another group', () => {
    const picked = pickReplacement(
      [
        release({
          guid: 'same',
          title: '[Kaze-raws] Kitsuraga - 002 [480p]',
          releaseGroup: 'Kaze-raws',
          rejected: true,
          rejections: [EXISTING],
          qualityWeight: 900,
        }),
        release({
          guid: 'pack',
          title: '[Tengu] Kitsuraga S01',
          fullSeason: true,
          rejected: true,
          rejections: ['Full season pack'],
        }),
        release({
          guid: 'low-score',
          title: '[X] Kitsuraga 002',
          rejected: true,
          rejections: [
            'Custom Formats Original Language , Required Size have score 0 below Series profile minimum 100',
          ],
        }),
        release({
          guid: 'other-episode',
          title: '[Tengu] Kitsuraga - 003',
          mappedEpisodeInfo: [{ id: 3 }],
        }),
        release({
          guid: 'good',
          title: '[Tengu] Kitsuraga - 002 [BD 1080p]',
          releaseGroup: 'Tengu',
          rejected: true,
          rejections: [EXISTING],
          mappedEpisodeInfo: [{ id: 2 }],
          qualityWeight: 700,
        }),
      ],
      current,
      2
    );
    assert.equal(picked?.guid, 'good');
  });

  it('finds nothing rather than the release the broken file came from', () => {
    assert.equal(
      pickReplacement(
        [
          release({
            title: '[Kaze-raws] Kitsuraga - 002 [480p].mkv',
            episodeRequested: true,
          }),
        ],
        current,
        2
      ),
      undefined
    );
  });
});

// ---- through the issue and AI routes ------------------------------------------

const SONARR = {
  id: 0,
  name: 'Sonarr',
  hostname: 'sonarr',
  port: 8989,
  apiKey: 'x',
  useSsl: false,
  is4k: false,
} as unknown as SonarrSettings;
const RADARR = {
  id: 0,
  name: 'Radarr',
  hostname: 'radarr',
  port: 7878,
  apiKey: 'x',
  useSsl: false,
  is4k: false,
} as unknown as RadarrSettings;

const episode = (n: number, over: Partial<ArrEpisode> = {}): ArrEpisode => ({
  id: 100 + n,
  seriesId: 77,
  seasonNumber: 1,
  episodeNumber: n,
  absoluteEpisodeNumber: n,
  runtime: 23,
  hasFile: true,
  episodeFileId: 500 + n,
  monitored: true,
  airDateUtc: '2005-01-01T00:00:00Z',
  ...over,
});

let server: Server;
let port = 0;
let actingAs: User;
let admin: User;
let member: User;
let series: Media;
let movie: Media;
let deleted: number[] = [];
let grabbed: string[] = [];
let searched: number[][] = [];
let downloads: string[] = [];
let episodes: ArrEpisode[] = [];
/** Where each file came from, by episode id. */
let origins: Record<number, string> = {};
let releases: ArrRelease[] = [];
let modelAnswer = '{}';
/** Sonarr's answer to a search for a whole season. */
let seasonReleases: ArrRelease[] = [];
/** The season's history: what was grabbed, and which files it became. */
let seasonHistory: ArrHistoryRecord[] = [];
/** Grabs marked failed (and so blocklisted), by history id. */
let markedFailed: number[] = [];
let monitored: number[][] = [];
/** Everything done to Sonarr, in order. */
let done: string[] = [];
let quietRavens: Media;

const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

/** The automatic comment on an issue, once the background fix is done. */
const commentOn = async (issueId: number): Promise<string> => {
  for (let i = 0; i < 100; i++) {
    const comments = await getRepository(IssueComment).find({
      where: { issue: { id: issueId } },
      order: { id: 'ASC' },
    });
    const auto = comments.find((c) => c.message.startsWith('Automatic fix:'));
    if (auto) return auto.message;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('No automatic comment was written');
};

beforeEach(async () => {
  autofix.reset();
  clearAiCache();
  deleted = [];
  grabbed = [];
  searched = [];
  downloads = [];
  origins = {};
  releases = [];
  modelAnswer = '{}';
  seasonReleases = [];
  seasonHistory = [];
  markedFailed = [];
  monitored = [];
  done = [];
  episodes = [1, 2, 3, 4].map((n) => episode(n));

  const settings = getSettings();
  settings.main.disabledFeatures = [];
  settings.sonarr = [SONARR];
  settings.radarr = [RADARR];
  settings.backfill = { ...settings.backfill, enabled: false };
  settings.bazarr = {
    hostname: 'bazarr',
    port: 6767,
    useSsl: false,
    urlBase: '',
    apiKey: 'b',
  };
  settings.ai = {
    enabled: true,
    provider: 'anthropic',
    apiKey: 'test-key',
    baseUrl: '',
    model: 'claude-test',
    featureModels: {},
    dailyLimit: 0,
  };

  // Issues and comments tell people; not in these tests.
  mock.method(
    IssueSubscriber.prototype as unknown as {
      sendIssueNotification: () => Promise<void>;
    },
    'sendIssueNotification',
    async () => undefined
  );
  mock.method(
    IssueCommentSubscriber.prototype as unknown as {
      sendIssueCommentNotification: () => Promise<void>;
    },
    'sendIssueCommentNotification',
    async () => undefined
  );
  mock.method(FixSonarr.prototype, 'episodes', async () => episodes);
  mock.method(FixSonarr.prototype, 'getSeriesById', async () => ({
    id: 77,
    seriesType: 'standard',
  }));
  mock.method(FixSonarr.prototype, 'episodeFile', async (id: number) => ({
    id,
    releaseGroup: 'Kaze-raws',
    mediaInfo: {
      runTime:
        episodes.find((e) => e.episodeFileId === id)?.runtime === 45
          ? '22:30'
          : '22:50',
    },
  }));
  mock.method(FixSonarr.prototype, 'history', async (episodeId: number) => [
    {
      id: 1,
      eventType: 'downloadFolderImported',
      sourceTitle: origins[episodeId] ?? `Show S01E${episodeId - 100}`,
      date: '2026-01-01T00:00:00Z',
      data: {
        fileId: String(episodes.find((e) => e.id === episodeId)?.episodeFileId),
        droppedPath: `/downloads/${origins[episodeId] ?? `Show S01E0${episodeId - 100}`}.mkv`,
      },
    },
  ]);
  mock.method(FixSonarr.prototype, 'parse', async (title: string) => {
    const n = Number(title.match(/S01E0?(\d+)/)?.[1]);
    const ep = episodes.find((e) => e.episodeNumber === n);
    return ep ? { series: { id: 77 }, episodes: [{ id: ep.id }] } : {};
  });
  mock.method(FixSonarr.prototype, 'releases', async () => releases);
  mock.method(FixSonarr.prototype, 'deleteEpisodeFile', async (id: number) => {
    deleted.push(id);
    done.push(`delete:${id}`);
  });
  mock.method(FixSonarr.prototype, 'grab', async (r: { guid: string }) => {
    grabbed.push(r.guid);
    done.push(`grab:${r.guid}`);
  });
  mock.method(
    FixSonarr.prototype,
    'seasonReleases',
    async () => seasonReleases
  );
  mock.method(FixSonarr.prototype, 'seasonHistory', async () => seasonHistory);
  mock.method(FixSonarr.prototype, 'seriesFacts', async () => ({
    title: 'Quiet Ravens',
    originalLanguage: 'English',
  }));
  mock.method(FixSonarr.prototype, 'monitorEpisodes', async (ids: number[]) => {
    monitored.push(ids);
  });
  mock.getter(
    FixSonarr.prototype,
    'extras',
    () =>
      ({
        markFailed: async (id: number) => {
          markedFailed.push(id);
          done.push(`failed:${id}`);
        },
      }) as unknown as ArrExtras
  );
  mock.method(FixSonarr.prototype, 'searchEpisodes', async (ids: number[]) => {
    searched.push(ids);
  });
  mock.method(FixRadarr.prototype, 'movieDetail', async () => ({
    id: 9,
    title: 'Hedgehog Morning',
    hasFile: true,
    movieFile: {
      id: 900,
      sceneName: 'Hedgehog.Morning.1993.1080p.BluRay.x264-OLD',
      releaseGroup: 'OLD',
    },
  }));
  mock.method(FixRadarr.prototype, 'history', async () => []);
  mock.method(FixRadarr.prototype, 'releases', async () => releases);
  mock.method(FixRadarr.prototype, 'deleteMovieFile', async (id: number) => {
    deleted.push(id);
  });
  mock.method(FixRadarr.prototype, 'grab', async (r: { guid: string }) => {
    grabbed.push(r.guid);
  });

  mock.method(BazarrAPI.prototype, 'getMovie', async () => ({
    radarrId: 9,
    title: 'Hedgehog Morning',
    profileId: 1,
    subtitles: [
      {
        name: 'English',
        code2: 'en',
        path: '/m/en.srt',
        forced: false,
        hi: false,
      },
    ],
    missing_subtitles: [],
  }));
  mock.method(BazarrAPI.prototype, 'getMovieHistory', async () => [
    { action: 1, provider: 'opensubtitles', subtitles_path: '/m/en.srt' },
  ]);
  mock.method(BazarrAPI.prototype, 'searchMovie', async () => [
    {
      provider: 'opensubtitles',
      subtitle: 'os-1',
      language: 'en',
      score: 97,
      hearing_impaired: 'False',
      forced: 'False',
      original_format: 'False',
      release_info: [],
      matches: [],
      dont_matches: [],
    },
    {
      provider: 'subdl',
      subtitle: 'subdl-1',
      language: 'en',
      score: 90,
      hearing_impaired: 'False',
      forced: 'False',
      original_format: 'False',
      release_info: [],
      matches: [],
      dont_matches: [],
    },
    {
      provider: 'subdl',
      subtitle: 'subdl-es',
      language: 'es',
      score: 99,
      hearing_impaired: 'False',
      forced: 'False',
      original_format: 'False',
      release_info: [],
      matches: [],
      dont_matches: [],
    },
    {
      provider: 'whisperai',
      subtitle: 'w',
      language: 'en',
      score: 50,
      hearing_impaired: 'False',
      forced: 'False',
      original_format: 'False',
      release_info: [],
      matches: [],
      dont_matches: [],
    },
  ]);
  mock.method(
    BazarrAPI.prototype,
    'downloadMovie',
    async (_id: number, choice: { subtitle: string }) => {
      downloads.push(choice.subtitle);
    }
  );

  // The model, at its HTTP call; TMDB, for the title it names.
  mock.method(axios, 'post', async () => ({
    data: {
      content: [{ type: 'text', text: modelAnswer }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  // TMDB sets its methods on each instance: answered from the prototype.
  Object.defineProperty(TheMovieDb.prototype, 'searchMovies', {
    configurable: true,
    set() {},
    get: () => async () => ({
      page: 1,
      total_pages: 1,
      total_results: 1,
      results: [
        {
          id: 137,
          title: 'Hedgehog Morning',
          release_date: '1993-02-11',
          media_type: 'movie',
          genre_ids: [],
          overview: '',
          popularity: 1,
          vote_average: 8,
          vote_count: 1,
          adult: false,
          original_language: 'en',
          original_title: 'Hedgehog Morning',
          video: false,
        },
      ],
    }),
  });

  const users = getRepository(User);
  admin = await users.save(
    new User({
      email: 'fix-admin@test.local',
      plexUsername: 'fix-admin',
      permissions: Permission.ADMIN,
      avatar: '',
    })
  );
  member = await users.save(
    new User({
      email: 'fix-member@test.local',
      plexUsername: 'fix-member',
      permissions: Permission.REQUEST | Permission.CREATE_ISSUES,
      avatar: '',
    })
  );
  admin = await users.findOneOrFail({ where: { id: admin.id } });
  member = await users.findOneOrFail({ where: { id: member.id } });
  actingAs = member;
  series = await getRepository(Media).save(
    new Media({
      tmdbId: 58371,
      tvdbId: 63914,
      mediaType: MediaType.TV,
      status: MediaStatus.AVAILABLE,
      serviceId: 0,
      externalServiceId: 77,
    })
  );
  quietRavens = await getRepository(Media).save(
    new Media({
      tmdbId: 87316,
      tvdbId: 521387,
      mediaType: MediaType.TV,
      status: MediaStatus.AVAILABLE,
      serviceId: 0,
      externalServiceId: 77,
    })
  );
  Object.defineProperty(TheMovieDb.prototype, 'searchTvShows', {
    configurable: true,
    set() {},
    get: () => async () => ({
      page: 1,
      total_pages: 1,
      total_results: 1,
      results: [
        {
          id: 87316,
          name: 'Quiet Ravens',
          first_air_date: '2022-04-01',
          media_type: 'tv',
          genre_ids: [],
          overview: '',
          popularity: 1,
          vote_average: 8,
          vote_count: 1,
          origin_country: ['GB'],
          original_language: 'en',
          original_name: 'Quiet Ravens',
        },
      ],
    }),
  });
  movie = await getRepository(Media).save(
    new Media({
      tmdbId: 137,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.AVAILABLE,
      serviceId: 0,
      externalServiceId: 9,
    })
  );

  if (!server) {
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
    app.use('/api/v1/issue', issueRoutes);
    app.use('/api/v1/ai', aiRoutes);
    app.use(
      (
        err: { status?: number; message: string },
        _req: express.Request,
        res: express.Response,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: express.NextFunction
      ) => res.status(err.status ?? 500).json({ message: err.message })
    );
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    port = (server.address() as { port: number }).port;
  }
});

afterEach(async () => {
  // A fix from an issue runs on after the route answers.
  await autofix.idle();
  mock.restoreAll();
});
after(() => {
  server?.closeAllConnections();
  server?.close();
});

describe('Auto-fix: reported issues', () => {
  it('replaces a broken episode only once another release is found, and says so on the issue', async () => {
    releases = [
      release({
        guid: 'tengu-2',
        title: '[Tengu] Show - S01E02 [BD 1080p]',
        releaseGroup: 'Tengu',
        rejected: true,
        rejections: [EXISTING],
        mappedEpisodeInfo: [{ id: 102 }],
        indexer: 'Nyaa',
      }),
    ];
    const res = await call('POST', '/api/v1/issue', {
      issueType: IssueType.VIDEO,
      message: 'It freezes halfway through',
      mediaId: series.id,
      problemSeason: 1,
      problemEpisode: 2,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const comment = await commentOn(res.body.id);
    assert.match(comment, /^Automatic fix: Replacing S01E02/);
    assert.match(
      comment,
      /grabbed \[Tengu\] Show - S01E02 \[BD 1080p\] from Nyaa/
    );
    assert.deepEqual(deleted, [502]);
    assert.deepEqual(grabbed, ['tengu-2']);
  });

  it('leaves the file alone when there is nothing else to get', async () => {
    const res = await call('POST', '/api/v1/issue', {
      issueType: IssueType.VIDEO,
      message: 'broken',
      mediaId: series.id,
      problemSeason: 1,
      problemEpisode: 2,
    });
    const comment = await commentOn(res.body.id);
    assert.match(
      comment,
      /No other release of S01E02 was found, so the file was left in place/
    );
    assert.deepEqual(deleted, []);
  });

  it('checks the whole season for a wrong episode, and replaces the ones that are off', async () => {
    // Episode 3's file came from episode 4's release; episode 1 runs twice
    // as long as it should.
    origins = { 103: 'Show S01E04 1080p WEB-DL' };
    episodes[0] = { ...episodes[0], runtime: 45 };
    releases = [
      release({
        guid: 'r1',
        title: 'Other S01E01',
        mappedEpisodeInfo: [{ id: 101 }],
      }),
      release({
        guid: 'r3',
        title: 'Other S01E03',
        mappedEpisodeInfo: [{ id: 103 }],
      }),
    ];
    const res = await call('POST', '/api/v1/issue', {
      issueType: IssueType.OTHER,
      message: 'This is the wrong episode',
      mediaId: series.id,
      problemSeason: 1,
      problemEpisode: 3,
    });
    const comment = await commentOn(res.body.id);
    assert.match(comment, /Checked season 1; 2 files looked wrong/);
    assert.match(
      comment,
      /S01E03 came from “Show S01E04 1080p WEB-DL\.mkv”, which is S01E04/
    );
    assert.match(comment, /S01E01 runs 23 minutes where the episode is 45/);
    assert.deepEqual(deleted.sort(), [501, 503]);
    assert.deepEqual(grabbed.sort(), ['r1', 'r3']);
  });

  it('calls a season numbered off by one a numbering problem, and downloads nothing', async () => {
    origins = {
      101: 'Show S01E02',
      102: 'Show S01E03',
      103: 'Show S01E04',
    };
    episodes = [1, 2, 3, 4, 5].map((n) => episode(n));
    const res = await call('POST', '/api/v1/issue', {
      issueType: IssueType.OTHER,
      message: 'episodes are mixed up',
      mediaId: series.id,
      problemSeason: 1,
      problemEpisode: 1,
    });
    const comment = await commentOn(res.body.id);
    assert.match(
      comment,
      /off by 1: the files are fine but numbered differently/
    );
    assert.deepEqual(deleted, []);
    assert.deepEqual(grabbed, []);
  });

  it('finds other subtitles for a subtitle issue, from somewhere else first', async () => {
    const res = await call('POST', '/api/v1/issue', {
      issueType: IssueType.SUBTITLES,
      message: 'the subs are out of sync',
      mediaId: movie.id,
    });
    const comment = await commentOn(res.body.id);
    assert.match(comment, /Downloaded en subtitles from subdl/);
    assert.deepEqual(downloads, ['subdl-1']);
  });

  it('leaves the subtitles of a title on a Radarr Bazarr does not follow', async () => {
    // A second Radarr numbers its films on its own: its 9 is not Bazarr's 9.
    getSettings().radarr = [
      { ...RADARR, isDefault: true },
      { ...RADARR, id: 1, name: 'Radarr Anime', isDefault: false },
    ];
    const elsewhere = await getRepository(Media).save(
      new Media({
        tmdbId: 129,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        serviceId: 1,
        externalServiceId: 9,
      })
    );
    for (const kind of ['subtitles', 'transcribe'] as const) {
      const result = await autofix.run({ kind, media: elsewhere, user: admin });
      assert.equal(result.ok, false, kind);
      assert.match(result.message, /Bazarr/, kind);
    }
    assert.deepEqual(downloads, []);
    assert.equal(transcriber.status('movie:129').queued, 0);
    assert.equal(transcriber.status('movie:129').running, false);
  });

  it('lets one person have only ten files replaced a day; admins are not limited', async () => {
    episodes = Array.from({ length: 12 }, (_, i) => episode(i + 1));
    releases = [
      release({
        guid: 'other',
        title: 'Other release',
        episodeRequested: true,
      }),
    ];
    const fix = (user: User, n: number) =>
      autofix.run({
        kind: 'broken',
        media: series,
        seasonNumber: 1,
        episodeNumber: n,
        user,
      });
    for (let n = 1; n <= 10; n++) {
      assert.equal((await fix(member, n)).ok, true, `episode ${n}`);
    }
    const refused = await fix(member, 11);
    assert.equal(refused.ok, false);
    assert.match(refused.message, /as many files replaced today as allowed/);
    assert.equal(deleted.length, 10);
    assert.equal((await fix(admin, 11)).ok, true);
    assert.equal(deleted.length, 11);
  });

  it('has Radarr search again for a missing movie, and Backfill look beyond it', async () => {
    const searches: number[] = [];
    mock.method(FixRadarr.prototype, 'searchMovie', async (id: number) => {
      searches.push(id);
    });
    mock.method(backfill, 'readiness', () => ({ ready: true }));
    mock.method(
      backfill,
      'track',
      async (kind: string, serverId: number, arrId: number) =>
        ({
          id: 12,
          kind,
          serverId,
          arrId,
          status: 'stuck',
        }) as unknown as BackfillSeries
    );
    const started: number[] = [];
    mock.method(backfill, 'startSearch', (id: number) => {
      started.push(id);
    });
    const result = await autofix.run({
      kind: 'missing',
      media: movie,
      user: admin,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(searches, [9]);
    assert.deepEqual(started, [12]);
    assert.equal(result.link, '/backfill/series/12');
    assert.match(result.message, /Backfill is checking indexers/);
  });

  it('hands a missing report on to the admin agent, should the searches find nothing', async () => {
    mock.method(FixRadarr.prototype, 'searchMovie', async () => undefined);
    mock.method(backfill, 'readiness', () => ({ ready: true }));
    mock.method(
      backfill,
      'track',
      async (kind: string, serverId: number, arrId: number) =>
        ({
          id: 12,
          kind,
          serverId,
          arrId,
          title: 'Film',
          status: 'stuck',
        }) as unknown as BackfillSeries
    );
    mock.method(backfill, 'startSearch', () => undefined);
    const handed: Record<string, unknown>[] = [];
    mock.method(
      agent,
      'afterReport',
      async (report: Record<string, unknown>) => {
        handed.push(report);
        return { id: 1 };
      }
    );
    const result = await autofix.run({
      kind: 'missing',
      media: movie,
      user: admin,
      issueId: 44,
    });
    assert.equal(result.ok, true);
    assert.match(
      result.message,
      /If nothing turns up, the admin agent looks further and answers here\.$/
    );
    assert.deepEqual(
      handed.map((h) => [h.kind, h.arrId, h.title, h.issueId]),
      [['movie', 9, 'Film', 44]]
    );
  });

  it('asks the model about a report the rules can’t read, and fixes its subtitles', async () => {
    modelAnswer = JSON.stringify({
      kind: 'subtitles',
      language: 'en',
      wrongSubtitles: true,
    });
    const res = await call('POST', '/api/v1/issue', {
      issueType: IssueType.OTHER,
      message: 'people talk but the words at the bottom say something else',
      mediaId: movie.id,
    });
    const comment = await commentOn(res.body.id);
    assert.match(comment, /Downloaded en subtitles from subdl/);
    assert.deepEqual(downloads, ['subdl-1']);
  });

  it('leaves a file the model reads as bad for an admin', async () => {
    modelAnswer = JSON.stringify({ kind: 'broken' });
    const res = await call('POST', '/api/v1/issue', {
      issueType: IssueType.OTHER,
      message: 'something about this one is not right',
      mediaId: series.id,
      problemSeason: 1,
      problemEpisode: 2,
    });
    const comment = await commentOn(res.body.id);
    assert.equal(
      comment,
      'Automatic fix: this reads as a bad or broken file. That replaces files, so it is left for an admin.'
    );
    assert.deepEqual(deleted, []);
    assert.deepEqual(grabbed, []);
  });

  it('reads nothing into a report when Understand Reports is off', async () => {
    getSettings().main.disabledFeatures = ['aiReports'];
    modelAnswer = JSON.stringify({ kind: 'broken' });
    const res = await call('POST', '/api/v1/issue', {
      issueType: IssueType.OTHER,
      message: 'something about this one is not right',
      mediaId: series.id,
      problemSeason: 1,
      problemEpisode: 2,
    });
    await autofix.idle();
    const comments = await getRepository(IssueComment).find({
      where: { issue: { id: res.body.id } },
    });
    assert.equal(comments.length, 1, 'only the report itself');
  });

  it('does nothing when an admin turned it off', async () => {
    getSettings().main.disabledFeatures = ['autoFix'];
    const res = await call('POST', '/api/v1/issue', {
      issueType: IssueType.VIDEO,
      message: 'broken',
      mediaId: series.id,
      problemSeason: 1,
      problemEpisode: 2,
    });
    await new Promise((r) => setTimeout(r, 200));
    const comments = await getRepository(IssueComment).find({
      where: { issue: { id: res.body.id } },
    });
    assert.equal(comments.length, 1, 'only the report itself');
    assert.deepEqual(deleted, []);
  });
});

describe('Auto-fix: from AI Search', () => {
  it('fetches subtitles at once when asked in plain words', async () => {
    modelAnswer = JSON.stringify({
      r: 'Getting Spanish subtitles for Hedgehog Morning.',
      titles: [{ t: 'Hedgehog Morning', y: 1993, k: 'movie' }],
      do: 'fix',
      fx: 'subtitles',
      lang: 'es',
    });
    const res = await call('POST', '/api/v1/ai/chat', {
      message: 'get spanish subtitles for hedgehog morning',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.reply, /Downloaded es subtitles from subdl/);
    assert.equal(res.body.fix.ok, true);
    assert.deepEqual(downloads, ['subdl-es']);
  });

  it('asks before replacing a file, then files it as an issue and fixes it in the background', async () => {
    releases = [
      release({
        guid: 'new',
        title: 'Hedgehog.Morning.1993.1080p.BluRay.x264-NEW',
        releaseGroup: 'NEW',
      }),
    ];
    modelAnswer = JSON.stringify({
      r: 'Replacing it.',
      titles: [{ t: 'Hedgehog Morning', y: 1993, k: 'movie' }],
      do: 'fix',
      fx: 'broken',
    });
    const asked = await call('POST', '/api/v1/ai/chat', {
      message: 'hedgehog morning has no sound',
    });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    // Nothing is touched until they confirm, with the title it would act
    // on shown to them.
    assert.equal(await getRepository(Issue).count(), 0);
    assert.equal(asked.body.fix, undefined);
    assert.deepEqual(
      asked.body.results.map((r: { id: number }) => r.id),
      [137]
    );
    assert.deepEqual(asked.body.confirm, {
      kind: 'broken',
      mediaId: movie.id,
      message: 'hedgehog morning has no sound',
    });

    const res = await call('POST', '/api/v1/ai/fix', asked.body.confirm);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.reply, /^Reported it, and started fixing it/);
    const issueId = Number(res.body.fix.link.split('/').pop());
    const issue = await getRepository(Issue).findOneOrFail({
      where: { id: issueId },
      relations: { createdBy: true },
    });
    assert.equal(issue.createdBy.id, member.id);
    const comment = await commentOn(issueId);
    assert.match(
      comment,
      /Replacing it: removed Hedgehog\.Morning\.1993\.1080p\.BluRay\.x264-OLD/
    );
    assert.deepEqual(deleted, [900]);
    assert.deepEqual(grabbed, ['new']);
  });

  it('needs permission to report problems before replacing a file', async () => {
    actingAs = await getRepository(User).save(
      Object.assign(member, { permissions: Permission.REQUEST })
    );
    modelAnswer = JSON.stringify({
      r: '',
      titles: [{ t: 'Hedgehog Morning', y: 1993, k: 'movie' }],
      do: 'fix',
      fx: 'broken',
    });
    const res = await call('POST', '/api/v1/ai/chat', {
      message: 'hedgehog morning is broken',
    });
    assert.match(res.body.reply, /needs permission to report problems/);
    assert.equal(res.body.confirm, undefined);
    // Nor can it be confirmed by asking the server directly.
    const direct = await call('POST', '/api/v1/ai/fix', {
      kind: 'broken',
      mediaId: movie.id,
      message: 'hedgehog morning is broken',
    });
    assert.match(direct.body.reply, /needs permission to report problems/);
    assert.equal(await getRepository(Issue).count(), 0);
    assert.deepEqual(deleted, []);
  });

  it('acts on the title in the library, not the first TMDB has by that name', async () => {
    const found = (id: number, date: string) => ({
      id,
      title: 'Hedgehog Morning',
      release_date: date,
      media_type: 'movie',
      genre_ids: [],
      overview: '',
      popularity: 1,
      vote_average: 8,
      vote_count: 1,
      adult: false,
      original_language: 'en',
      original_title: 'Hedgehog Morning',
      video: false,
    });
    // A newer film by the same name comes first, and is not on the server.
    Object.defineProperty(TheMovieDb.prototype, 'searchMovies', {
      configurable: true,
      set() {},
      get: () => async () => ({
        page: 1,
        total_pages: 1,
        total_results: 2,
        results: [found(999001, '2031-01-01'), found(137, '1993-02-11')],
      }),
    });
    modelAnswer = JSON.stringify({
      r: '',
      titles: [{ t: 'Hedgehog Morning', k: 'movie' }],
      do: 'fix',
      fx: 'subtitles',
      lang: 'es',
    });
    const res = await call('POST', '/api/v1/ai/chat', {
      message: 'spanish subtitles for hedgehog morning',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.reply, /Downloaded es subtitles/);
    assert.deepEqual(
      res.body.results.map((r: { id: number }) => r.id),
      [137]
    );
  });

  it('points at the open report when the same problem is asked about again', async () => {
    modelAnswer = JSON.stringify({
      r: '',
      titles: [{ t: 'Hedgehog Morning', y: 1993, k: 'movie' }],
      do: 'fix',
      fx: 'broken',
    });
    const asked = await call('POST', '/api/v1/ai/chat', {
      message: 'hedgehog morning has no sound',
    });
    const first = await call('POST', '/api/v1/ai/fix', asked.body.confirm);
    await commentOn(Number(first.body.fix.link.split('/').pop()));
    const again = await call('POST', '/api/v1/ai/chat', {
      message: 'hedgehog morning still has no sound',
    });
    assert.match(again.body.reply, /reported this already today/);
    assert.equal(again.body.fix.link, first.body.fix.link);
    assert.equal(await getRepository(Issue).count(), 1);
  });

  describe('a title newer than the model', () => {
    // A sequel on the server, which TMDB finds by its own name only.
    const film = (id: number, title: string, date: string) => ({
      id,
      title,
      release_date: date,
      media_type: 'movie',
      genre_ids: [],
      overview: '',
      popularity: 1,
      vote_average: 8,
      vote_count: 1,
      adult: false,
      original_language: 'en',
      original_title: title,
      video: false,
    });
    beforeEach(async () => {
      await getRepository(Media).save(
        new Media({
          tmdbId: 4242,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.AVAILABLE,
          serviceId: 0,
          externalServiceId: 10,
        })
      );
      Object.defineProperty(TheMovieDb.prototype, 'searchMovies', {
        configurable: true,
        set() {},
        get:
          () =>
          async ({ query }: { query: string }) => {
            const results =
              /hedgehog/i.test(query) && !/:/.test(query)
                ? [
                    film(137, 'Hedgehog Morning', '1993-02-11'),
                    film(
                      4242,
                      'Hedgehog Morning: Beyond the Hedge',
                      '2031-05-02'
                    ),
                  ]
                : [];
            return {
              page: 1,
              total_pages: 1,
              total_results: results.length,
              results,
            };
          },
      });
    });

    it('finds it by their words when the model renames it', async () => {
      modelAnswer = JSON.stringify({
        r: '',
        titles: [{ t: 'Hedgehog Morning: The Hedge', k: 'movie' }],
        do: 'fix',
        fx: 'subtitles',
        lang: 'es',
      });
      const res = await call('POST', '/api/v1/ai/chat', {
        message: 'Fix spanish subtitles for hedgehog morning beyond the hedge',
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.match(res.body.reply, /Downloaded es subtitles/);
      assert.deepEqual(
        res.body.results.map((r: { id: number }) => r.id),
        [4242]
      );
    });

    it('finds it by their words when the model names no title', async () => {
      modelAnswer = JSON.stringify({
        r: '',
        titles: [],
        do: 'fix',
        fx: 'subtitles',
        lang: 'es',
      });
      const res = await call('POST', '/api/v1/ai/chat', {
        message: 'get spanish subtitles for Hedgehog Morning Beyond the Hedge',
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(
        res.body.results.map((r: { id: number }) => r.id),
        [4242]
      );
    });

    it('asks which one when their words could mean either', async () => {
      modelAnswer = JSON.stringify({
        r: '',
        titles: [],
        do: 'fix',
        fx: 'subtitles',
        lang: 'es',
      });
      const res = await call('POST', '/api/v1/ai/chat', {
        message: 'fix the subtitles on hedgehog',
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.match(res.body.reply, /^Which title is it/);
      assert.deepEqual(downloads, []);
    });
  });

  it('says so when the title is not on the server', async () => {
    await getRepository(Media).delete({ id: movie.id });
    modelAnswer = JSON.stringify({
      r: '',
      titles: [{ t: 'Hedgehog Morning', y: 1993, k: 'movie' }],
      do: 'fix',
      fx: 'subtitles',
    });
    const res = await call('POST', '/api/v1/ai/chat', {
      message: 'subtitles for hedgehog morning',
    });
    assert.match(res.body.reply, /not on the server yet/);
  });
});

// ---- a whole season --------------------------------------------------------------

/** The release Quiet Ravens' season 6 came from, on the fake Sonarr. */
const OLD_PACK = 'Quiet.Ravens.S06.1080p.ATVP.WEB-DL.DDP5.1.H.264-OLDGRP';

/**
 * Season 6 of Quiet Ravens: five episodes, every file from one season pack,
 * as Sonarr's history has it.
 */
const season6 = () => {
  episodes = [1, 2, 3, 4, 5].map((n) =>
    episode(n, {
      id: 600 + n,
      seasonNumber: 6,
      absoluteEpisodeNumber: 30 + n,
      episodeFileId: 1600 + n,
    })
  );
  seasonHistory = [
    ...episodes.map((ep) => ({
      id: 9100 + ep.episodeNumber,
      eventType: 'downloadFolderImported',
      sourceTitle: OLD_PACK,
      date: '2026-10-01T01:00:00Z',
      downloadId: 'old',
      episodeId: ep.id,
      data: {
        fileId: String(ep.episodeFileId),
        droppedPath: `/downloads/${OLD_PACK}/Quiet.Ravens.S06E0${ep.episodeNumber}.mkv`,
      },
    })),
    {
      id: 9001,
      eventType: 'grabbed',
      sourceTitle: OLD_PACK,
      date: '2026-10-01T00:00:00Z',
      downloadId: 'old',
      episodeId: 601,
      data: { guid: 'old-guid' },
    },
  ];
};

/** A season pack Sonarr only turns down for the files already there. */
const pack = (guid: string, title: string, over: Partial<ArrRelease> = {}) =>
  release({
    guid,
    title,
    fullSeason: true,
    rejected: true,
    rejections: [EXISTING],
    mappedEpisodeInfo: [601, 602, 603, 604, 605].map((id) => ({ id })),
    indexer: 'Torznab',
    ...over,
  });

/** One episode's release. */
const single = (n: number, over: Partial<ArrRelease> = {}) =>
  release({
    guid: `single-${n}`,
    title: `Quiet.Ravens.S06E0${n}.1080p.WEB.H.264-EPGRP`,
    rejected: true,
    rejections: [EXISTING],
    mappedEpisodeInfo: [{ id: 600 + n }],
    indexer: 'Torznab',
    ...over,
  });

const NEW_PACK = 'Quiet.Ravens.S06.1080p.WEB-DL-NEWGRP';

/** The admin agent, able to ask admins: what it sends them. */
const agentReady = () => {
  const sent: { subject?: string; message?: string }[] = [];
  mock.method(agent, 'problem', () => null);
  mock.method(
    notificationManager,
    'sendNotification',
    (_type: unknown, payload: { subject?: string; message?: string }) => {
      sent.push(payload);
    }
  );
  return sent;
};

/** A run, once the agent is done with it. */
const settled = async (id: number) => {
  for (let i = 0; i < 200; i++) {
    const run = await getRepository(AgentRun).findOneOrFail({ where: { id } });
    if (['done', 'failed'].includes(run.status) && !agent.isBusy()) return run;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('The run did not finish');
};

/** Every comment on an issue, oldest first, once there are `count`. */
const commentsOn = async (issueId: number, count: number) => {
  for (let i = 0; i < 100; i++) {
    const comments = await getRepository(IssueComment).find({
      where: { issue: { id: issueId } },
      order: { id: 'ASC' },
    });
    if (comments.length >= count) return comments.map((c) => c.message);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Fewer than ${count} comments were written`);
};

/** Sonarr, as the agent reads it, once the new files have imported. */
const filesBack = () =>
  mock.method(BackfillSonarr.prototype, 'getSeriesEpisodes', async () =>
    episodes.map((ep) => ({ ...ep, hasFile: true }))
  );

describe('Auto-fix: the title in their words', () => {
  it('takes the words of the report out', () => {
    for (const [said, title] of [
      [
        'Fix hedgehog morning beyond the hedge',
        'hedgehog morning beyond the hedge',
      ],
      ['Quiet Ravens S02E04 has no sound', 'Quiet Ravens'],
      [
        'the subtitles on Quiet Ravens season 2 are out of sync',
        'Quiet Ravens',
      ],
      [
        'can you replace episode 3 of Quiet Ravens, it is broken',
        'Quiet Ravens',
      ],
      [
        "Once Upon a Morning in the Hedge won't play",
        'Once Upon a Morning in the Hedge',
      ],
    ]) {
      assert.equal(titleInTheirWords(said), title, said);
    }
    assert.equal(titleInTheirWords('fix it'), undefined);
  });
});

describe('Auto-fix: reading which season and episode', () => {
  it('reads the season and episode however they are said', () => {
    assert.deepEqual(seasonEpisodeIn('Fix season 6 of quiet ravens'), {
      season: 6,
    });
    assert.deepEqual(
      seasonEpisodeIn('Whole season 6 is messed up of quiet ravens'),
      { season: 6 }
    );
    assert.deepEqual(seasonEpisodeIn('s6 of quiet ravens is broken'), {
      season: 6,
    });
    assert.deepEqual(seasonEpisodeIn('S06E03 has no sound'), {
      season: 6,
      episode: 3,
    });
    assert.deepEqual(
      seasonEpisodeIn('episode 3 of season 6 is the wrong one'),
      { season: 6, episode: 3 }
    );
    assert.deepEqual(seasonEpisodeIn('season six episode two'), {
      season: 6,
      episode: 2,
    });
    assert.deepEqual(seasonEpisodeIn('6x03 skips'), { season: 6, episode: 3 });
    assert.deepEqual(seasonEpisodeIn('episode 4 is wrong'), { episode: 4 });
    assert.deepEqual(seasonEpisodeIn('Starwake has no sound'), {});
    assert.deepEqual(seasonEpisodeIn('Chrome Courier 2049 is broken'), {});
  });

  it('tells a whole season to replace from mixed-up episodes', () => {
    assert.equal(
      classify('Whole season 6 is messed up of quiet ravens')?.kind,
      'replaceSeason'
    );
    assert.equal(classify('replace all of season 2')?.kind, 'replaceSeason');
    assert.equal(
      classify('season 3 needs redownloading')?.kind,
      'replaceSeason'
    );
    assert.equal(
      classify('the entire season is broken', IssueType.VIDEO)?.kind,
      'replaceSeason'
    );
    assert.equal(
      classify('episodes are mixed up in season 2')?.kind,
      'wrongEpisode'
    );
    assert.equal(classify('season 2 episode 5 is broken')?.kind, 'broken');
    assert.equal(
      classify('replace the subtitles for season 2')?.kind,
      'subtitles'
    );
    assert.equal(classify('Fix season 6 of quiet ravens'), undefined);
  });
});

describe('Auto-fix: replacing a whole season', () => {
  it('takes a season pack that is not the old release, and removes the old files only once it is grabbed', async () => {
    season6();
    // Episode 2 was unmonitored by someone: it is wanted again.
    episodes[1] = { ...episodes[1], monitored: false };
    seasonReleases = [
      // The release the files came from, of the best quality: never again.
      pack('old-again', OLD_PACK, { qualityWeight: 900 }),
      // Dubbed into a language the series is not in.
      pack('german', 'Quiet.Ravens.S06.GERMAN.1080p.WEB.x264-GERGRP', {
        qualityWeight: 800,
        languages: [{ id: 4, name: 'German' }],
      }),
      // A quality the profile does not want.
      pack('unwanted', 'Quiet.Ravens.S06.480p.WEB.x264-LOW', {
        rejections: ['WEBDL-480p is not wanted in profile'],
      }),
      // One episode, better than any pack: a pack is still preferred.
      single(1, { qualityWeight: 950 }),
      pack('good', 'Quiet.Ravens.S06.1080p.ATVP.WEB-DL.DDP5.1.H.264-NEWGRP', {
        qualityWeight: 700,
      }),
    ];
    const result = await autofix.run({
      kind: 'replaceSeason',
      media: quietRavens,
      seasonNumber: 6,
      user: admin,
    });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(grabbed, ['good']);
    // Grabbed first; then the old release blocklisted; then the files gone.
    assert.deepEqual(done, [
      'grab:good',
      'failed:9001',
      'delete:1601',
      'delete:1602',
      'delete:1603',
      'delete:1604',
      'delete:1605',
    ]);
    assert.deepEqual(markedFailed, [9001]);
    assert.deepEqual(monitored, [[602]]);
    assert.match(
      result.message,
      /grabbed the season pack Quiet\.Ravens\.S06\.1080p\.ATVP\.WEB-DL\.DDP5\.1\.H\.264-NEWGRP from Torznab/
    );
    assert.match(result.message, /the 5 old files were removed/);
    assert.match(result.message, /marked failed in Sonarr/);
  });

  it('takes a release per episode when there is no season pack, and keeps the files of episodes it found nothing for', async () => {
    season6();
    seasonReleases = [single(1), single(2), single(3)];
    // Episode 4 is found by its own search; episode 5 by none.
    mock.method(FixSonarr.prototype, 'releases', async (episodeId: number) =>
      episodeId === 604 ? [single(4)] : []
    );
    const result = await autofix.run({
      kind: 'replaceSeason',
      media: quietRavens,
      seasonNumber: 6,
      user: admin,
    });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(grabbed, ['single-1', 'single-2', 'single-3', 'single-4']);
    assert.deepEqual(deleted, [1601, 1602, 1603, 1604]);
    const firstDelete = done.findIndex((d) => d.startsWith('delete'));
    assert.equal(
      done.slice(0, firstDelete).filter((d) => d.startsWith('grab')).length,
      4,
      done.join(', ')
    );
    assert.match(
      result.message,
      /one per episode \(no season pack was found\)/
    );
    assert.match(
      result.message,
      /No other release was found for S06E05, so its file stays\./
    );
  });

  it('removes nothing when no other release is found, and hands it to the admin agent', async () => {
    season6();
    seasonReleases = [
      pack('old-again', OLD_PACK),
      pack('unwanted', 'Quiet.Ravens.S06.480p.WEB.x264-LOW', {
        rejections: ['WEBDL-480p is not wanted in profile'],
      }),
    ];
    mock.method(backfill, 'readiness', () => ({ ready: true }));
    mock.method(
      backfill,
      'track',
      async (kind: string, serverId: number, arrId: number) =>
        ({
          id: 12,
          kind,
          serverId,
          arrId,
          title: 'Quiet Ravens',
          status: 'stuck',
        }) as unknown as BackfillSeries
    );
    const handed: Record<string, unknown>[] = [];
    mock.method(
      agent,
      'afterReport',
      async (report: Record<string, unknown>) => {
        handed.push(report);
        return { id: 1 };
      }
    );
    const result = await autofix.run({
      kind: 'replaceSeason',
      media: quietRavens,
      seasonNumber: 6,
      user: admin,
      issueId: 7,
    });
    assert.equal(result.ok, false);
    assert.match(
      result.message,
      /^No other release of season 6 was found, so nothing was removed\./
    );
    assert.match(result.message, /The admin agent looks further/);
    assert.deepEqual(grabbed, []);
    assert.deepEqual(deleted, []);
    assert.deepEqual(markedFailed, []);
    assert.deepEqual(
      handed.map((h) => [h.seasonNumber, h.replace, h.issueId]),
      [[6, true, 7]]
    );
  });

  it('removes nothing when the replacement cannot be grabbed', async () => {
    season6();
    seasonReleases = [pack('good', NEW_PACK)];
    mock.method(FixSonarr.prototype, 'grab', async () => {
      throw new Error('Sonarr said no');
    });
    const result = await autofix.run({
      kind: 'replaceSeason',
      media: quietRavens,
      seasonNumber: 6,
      user: admin,
    });
    assert.equal(result.ok, false);
    assert.match(
      result.message,
      /could not be grabbed, so nothing was removed/
    );
    assert.deepEqual(deleted, []);
    assert.deepEqual(markedFailed, []);
  });

  it('lets an admin replace a season again the same day, and anyone else ask once a day', async () => {
    season6();
    seasonReleases = [pack('good', NEW_PACK)];
    agentReady();
    const replace = (user: User) =>
      autofix.run({
        kind: 'replaceSeason',
        media: quietRavens,
        seasonNumber: 6,
        user,
      });
    assert.equal((await replace(admin)).ok, true);
    assert.equal((await replace(admin)).ok, true);
    assert.deepEqual(grabbed, ['good', 'good']);

    const first = await replace(member);
    assert.equal(first.ok, true, first.message);
    const again = await replace(member);
    assert.equal(again.ok, false);
    assert.match(again.message, /already asked to be replaced today/);
    assert.equal(
      await getRepository(AgentRun).count({ where: { status: 'waiting' } }),
      1
    );
  });

  it("puts anyone else's request to an admin; approved, it is replaced and followed until it is back", async () => {
    season6();
    seasonReleases = [pack('good', NEW_PACK)];
    const sent = agentReady();
    actingAs = member;
    const res = await call('POST', '/api/v1/issue', {
      issueType: IssueType.OTHER,
      message: 'The whole season is messed up, please replace it',
      mediaId: quietRavens.id,
      problemSeason: 6,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const issueId = res.body.id;
    const waitingNote = await commentOn(issueId);
    assert.match(waitingNote, /waiting for an admin/);
    assert.match(waitingNote, /Nothing changes until then/);
    // Nothing has changed yet.
    assert.deepEqual(grabbed, []);
    assert.deepEqual(deleted, []);
    const run = await getRepository(AgentRun).findOneOrFail({
      where: { status: 'waiting' },
    });
    assert.equal(
      run.question,
      `Waiting for approval: Replace season 6 of Quiet Ravens: download ${NEW_PACK} and then remove the 5 current files.`
    );
    assert.equal(run.trigger, 'report');
    assert.equal(run.requestedByName, member.displayName);
    assert.match(sent[0]?.subject ?? '', /needs your approval/);

    const proposal = (run.memory as { proposal: { id: string } }).proposal;
    await agent.approve(run.id, proposal.id, admin);
    const finished = await settled(run.id);
    assert.equal(finished.status, 'done', finished.error ?? '');
    assert.deepEqual(done, [
      'grab:good',
      'failed:9001',
      'delete:1601',
      'delete:1602',
      'delete:1603',
      'delete:1604',
      'delete:1605',
    ]);
    const said = await commentsOn(issueId, 3);
    assert.match(said[2], /^Admin agent: Approved by fix-admin\./);
    assert.match(said[2], /grabbed the season pack/);

    // Followed until the new files are in, then the reporter is told.
    const follow = await getRepository(AgentRun).findOneOrFail({
      where: { status: 'held' },
    });
    filesBack();
    await agent.checkHeld();
    const back = await commentsOn(issueId, 4);
    assert.equal(
      back[3],
      'Automatic fix: Season 6 of Quiet Ravens is back: all 5 new files have been imported.'
    );
    assert.equal(
      (
        await getRepository(AgentRun).findOneOrFail({
          where: { id: follow.id },
        })
      ).status,
      'done'
    );
  });

  it('changes nothing when an admin declines, and tells the reporter', async () => {
    season6();
    seasonReleases = [pack('good', NEW_PACK)];
    agentReady();
    actingAs = member;
    const res = await call('POST', '/api/v1/issue', {
      issueType: IssueType.OTHER,
      message: 'Whole season 6 needs redownloading',
      mediaId: quietRavens.id,
      problemSeason: 6,
    });
    await commentOn(res.body.id);
    const run = await getRepository(AgentRun).findOneOrFail({
      where: { status: 'waiting' },
    });
    const proposal = (run.memory as { proposal: { id: string } }).proposal;
    await agent.decline(run.id, proposal.id, admin);
    const said = await commentsOn(res.body.id, 3);
    assert.match(
      said[2],
      /^Admin agent: An admin declined this: Replace season 6/
    );
    assert.match(said[2], /Nothing was changed\./);
    assert.deepEqual(grabbed, []);
    assert.deepEqual(deleted, []);
    assert.deepEqual(markedFailed, []);
  });

  it('says an admin is needed when no admin agent can ask for approval', async () => {
    season6();
    seasonReleases = [pack('good', NEW_PACK)];
    const result = await autofix.run({
      kind: 'replaceSeason',
      media: quietRavens,
      seasonNumber: 6,
      user: member,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /needs an admin’s approval/);
    assert.deepEqual(grabbed, []);
    assert.equal(await getRepository(AgentRun).count(), 0);
  });

  it('follows an admin’s replacement on its issue until it is back', async () => {
    season6();
    seasonReleases = [pack('good', NEW_PACK)];
    actingAs = admin;
    const res = await call('POST', '/api/v1/issue', {
      issueType: IssueType.OTHER,
      message: 'Replace all of season 6',
      mediaId: quietRavens.id,
      problemSeason: 6,
    });
    assert.match(await commentOn(res.body.id), /grabbed the season pack/);
    const follow = await getRepository(AgentRun).findOneOrFail({
      where: { status: 'held' },
    });
    assert.deepEqual(
      (follow.memory as { report: { follow: { episodeIds: number[] } } }).report
        .follow.episodeIds,
      [601, 602, 603, 604, 605]
    );
    // Not yet: still downloading.
    mock.method(BackfillSonarr.prototype, 'getSeriesEpisodes', async () =>
      episodes.map((ep) => ({ ...ep, hasFile: false }))
    );
    await agent.checkHeld();
    assert.equal((await commentsOn(res.body.id, 2)).length, 2);
    filesBack();
    await agent.checkHeld();
    assert.match(
      (await commentsOn(res.body.id, 3))[2],
      /^Automatic fix: Season 6 of Quiet Ravens is back/
    );
  });
});

describe('Auto-fix: a season from AI Search and issues', () => {
  it('“Fix season 6 of quiet ravens” with nothing missing asks what is wrong, and replacing it then works', async () => {
    season6();
    actingAs = admin;
    // As the model answered on the owner's server: missing episodes.
    modelAnswer = JSON.stringify({
      r: 'Looking for what is missing in season 6.',
      titles: [{ t: 'Quiet Ravens', y: 2022, k: 'tv' }],
      do: 'fix',
      fx: 'missing',
      se: 6,
    });
    const ask = 'Fix season 6 of quiet ravens';
    const res = await call('POST', '/api/v1/ai/chat', { message: ask });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(
      res.body.reply,
      /^Sonarr has every aired episode of season 6, so nothing is missing\./
    );
    assert.match(
      res.body.reply,
      /replace the whole season, check it for mixed-up episodes, or fix its subtitles\?$/
    );
    assert.doesNotMatch(res.body.reply, /report it as/);
    assert.equal(res.body.confirm, undefined);

    // The answer: the model names the title from before, but not the
    // season; it comes from the conversation.
    modelAnswer = JSON.stringify({
      r: 'Replacing season 6.',
      titles: [{ t: 'Quiet Ravens', y: 2022, k: 'tv' }],
      do: 'fix',
      fx: 'replaceSeason',
    });
    const chosen = await call('POST', '/api/v1/ai/chat', {
      message: 'Replace the whole season',
      turns: [{ ask, reply: res.body.reply, offered: [] }],
    });
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    assert.deepEqual(chosen.body.confirm, {
      kind: 'replaceSeason',
      mediaId: quietRavens.id,
      seasonNumber: 6,
      message: 'Replace the whole season',
    });
    assert.match(chosen.body.reply, /all of season 6 of Quiet Ravens/);

    seasonReleases = [pack('good', NEW_PACK)];
    const fixed = await call('POST', '/api/v1/ai/fix', chosen.body.confirm);
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    assert.match(
      fixed.body.reply,
      /^Reported it, and started replacing season 6/
    );
    const issueId = Number(fixed.body.fix.link.split('/').pop());
    const issue = await getRepository(Issue).findOneOrFail({
      where: { id: issueId },
    });
    assert.equal(issue.problemSeason, 6);
    assert.match(await commentOn(issueId), /grabbed the season pack/);
    assert.deepEqual(grabbed, ['good']);
  });

  it('“Whole season 6 is messed up of quiet ravens” is filed on season 6, not All Seasons, and replaced for an admin', async () => {
    season6();
    seasonReleases = [pack('good', NEW_PACK)];
    actingAs = admin;
    // As the model answered on the owner's server: the wrong episode, and
    // no season.
    modelAnswer = JSON.stringify({
      r: 'Checking season 6.',
      titles: [{ t: 'Quiet Ravens', y: 2022, k: 'tv' }],
      do: 'fix',
      fx: 'wrongEpisode',
    });
    const message = 'Whole season 6 is messed up of quiet ravens';
    const asked = await call('POST', '/api/v1/ai/chat', { message });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.deepEqual(asked.body.confirm, {
      kind: 'replaceSeason',
      mediaId: quietRavens.id,
      seasonNumber: 6,
      message,
    });
    assert.match(asked.body.reply, /This replaces all of season 6/);
    assert.match(asked.body.reply, /removed only once it is grabbed/);

    const res = await call('POST', '/api/v1/ai/fix', asked.body.confirm);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const issueId = Number(res.body.fix.link.split('/').pop());
    const issue = await getRepository(Issue).findOneOrFail({
      where: { id: issueId },
    });
    assert.equal(issue.problemSeason, 6, 'not All Seasons');
    assert.equal(issue.problemEpisode, 0);
    const comment = await commentOn(issueId);
    assert.doesNotMatch(comment, /Say which season/);
    assert.match(comment, /grabbed the season pack/);
    assert.deepEqual(grabbed, ['good']);
    assert.equal(deleted.length, 5);
  });

  it('“Whole season 6 is messed up of quiet ravens” from anyone else waits for an admin', async () => {
    season6();
    seasonReleases = [pack('good', NEW_PACK)];
    agentReady();
    modelAnswer = JSON.stringify({
      r: 'Checking season 6.',
      titles: [{ t: 'Quiet Ravens', y: 2022, k: 'tv' }],
      do: 'fix',
      fx: 'wrongEpisode',
    });
    const message = 'Whole season 6 is messed up of quiet ravens';
    const asked = await call('POST', '/api/v1/ai/chat', { message });
    assert.equal(asked.body.confirm.seasonNumber, 6);
    assert.match(asked.body.reply, /An admin approves it first/);
    const res = await call('POST', '/api/v1/ai/fix', asked.body.confirm);
    assert.match(res.body.reply, /needs an admin’s approval/);
    const issueId = Number(res.body.fix.link.split('/').pop());
    const issue = await getRepository(Issue).findOneOrFail({
      where: { id: issueId },
    });
    assert.equal(issue.problemSeason, 6);
    assert.match(await commentOn(issueId), /waiting for an admin/);
    assert.deepEqual(grabbed, []);
    assert.deepEqual(deleted, []);
  });

  it('carries the season and episode said into the issue, whatever the model gave', async () => {
    season6();
    modelAnswer = JSON.stringify({
      r: '',
      titles: [{ t: 'Quiet Ravens', y: 2022, k: 'tv' }],
      do: 'fix',
      fx: 'wrongEpisode',
      se: 1,
    });
    const asked = await call('POST', '/api/v1/ai/chat', {
      message: 'S06E03 of quiet ravens is the wrong episode',
    });
    assert.equal(asked.body.confirm.seasonNumber, 6);
    assert.equal(asked.body.confirm.episodeNumber, 3);
    const res = await call('POST', '/api/v1/ai/fix', asked.body.confirm);
    const issue = await getRepository(Issue).findOneOrFail({
      where: { id: Number(res.body.fix.link.split('/').pop()) },
    });
    assert.equal(issue.problemSeason, 6);
    assert.equal(issue.problemEpisode, 3);
  });

  it('reads the season from a report filed on All Seasons', async () => {
    season6();
    actingAs = admin;
    seasonReleases = [pack('good', NEW_PACK)];
    const res = await call('POST', '/api/v1/issue', {
      issueType: IssueType.OTHER,
      message: 'The whole season 6 is messed up',
      mediaId: quietRavens.id,
      problemSeason: 0,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(await commentOn(res.body.id), /grabbed the season pack/);
    const issue = await getRepository(Issue).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.equal(issue.problemSeason, 6);
    assert.deepEqual(grabbed, ['good']);
  });
});

// ---- music --------------------------------------------------------------------

describe('Auto-fix: music from AI Search', () => {
  const ARTIST = '3c9e5f21-8d47-4b6a-a1e3-5f7d2c90b844';
  const GROUP = '7e41c0d8-5b29-3f6c-b8a4-91d6e2f07a35';
  let commands: { name: string; options: Record<string, unknown> }[];

  beforeEach(async () => {
    commands = [];
    getSettings().lidarr = [
      {
        id: 0,
        name: 'Lidarr',
        hostname: '127.0.0.1',
        port: 1,
        apiKey: 'k',
        useSsl: false,
        baseUrl: '',
        isDefault: true,
      } as never,
    ];
    mock.method(
      LidarrAPI.prototype as unknown as {
        runCommand: (name: string, options: object) => Promise<void>;
      },
      'runCommand',
      async (name: string, options: Record<string, unknown>) => {
        commands.push({ name, options });
      }
    );
    const credit = [
      { name: 'Glasswing', artist: { id: ARTIST, name: 'Glasswing' } },
    ];
    mock.method(MusicBrainz.prototype, 'searchReleaseGroups', async () => ({
      count: 1,
      offset: 0,
      'release-groups': [
        {
          id: GROUP,
          title: 'Static Garden',
          'primary-type': 'Album',
          score: 100,
          'artist-credit': credit,
        },
      ],
    }));
    mock.method(MusicBrainz.prototype, 'searchArtists', async () => ({
      count: 1,
      offset: 0,
      artists: [{ id: ARTIST, name: 'Glasswing', score: 100 }],
    }));
    const artist = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MUSIC,
        tmdbId: 0,
        foreignId: ARTIST,
        foreignTitle: 'Glasswing',
        status: MediaStatus.PARTIALLY_AVAILABLE,
        serviceId: 0,
        externalServiceId: 31,
      })
    );
    await getRepository(MusicAlbum).save(
      Object.assign(new MusicAlbum(), {
        media: artist,
        mbId: GROUP,
        title: 'Static Garden',
        secondaryTypes: [],
        status: MediaStatus.PARTIALLY_AVAILABLE,
        lidarrAlbumId: 42,
        trackCount: 10,
        trackFileCount: 6,
      })
    );
  });

  afterEach(() => {
    getSettings().lidarr = [];
  });

  it('searches again for an album’s missing tracks', async () => {
    modelAnswer = JSON.stringify({
      r: 'Looking for the missing tracks.',
      titles: [],
      music: [{ t: 'Static Garden', a: 'Glasswing', k: 'album' }],
      do: 'fix',
      fx: 'missing',
    });
    const res = await call('POST', '/api/v1/ai/chat', {
      message: 'static garden by glasswing is missing songs',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.reply, /Static Garden/);
    assert.equal(res.body.fix.ok, true);
    assert.equal(res.body.fix.link, `/music/album/${GROUP}`);
    assert.deepEqual(
      res.body.music.albums.map((a: { id: string }) => a.id),
      [GROUP]
    );
    assert.deepEqual(commands, [
      { name: 'AlbumSearch', options: { albumIds: [42] } },
    ]);
  });

  it('searches for an artist’s missing albums', async () => {
    modelAnswer = JSON.stringify({
      r: '',
      titles: [],
      music: [{ t: 'Glasswing', k: 'artist' }],
      do: 'fix',
      fx: 'missing',
    });
    const res = await call('POST', '/api/v1/ai/chat', {
      message: 'glasswing albums are missing',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.reply, /every missing album of Glasswing/);
    assert.deepEqual(commands, [
      { name: 'ArtistSearch', options: { artistId: 31 } },
    ]);
  });

  it('fixes nothing else for music', async () => {
    modelAnswer = JSON.stringify({
      r: '',
      titles: [],
      music: [{ t: 'Static Garden', a: 'Glasswing', k: 'album' }],
      do: 'fix',
      fx: 'broken',
    });
    const res = await call('POST', '/api/v1/ai/chat', {
      message: 'static garden skips',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.reply, /missing tracks/);
    assert.equal(res.body.fix, undefined);
    assert.deepEqual(commands, []);
  });
});
