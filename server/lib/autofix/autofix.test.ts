import BazarrAPI from '@server/api/bazarr';
import TheMovieDb from '@server/api/themoviedb';
import { IssueType } from '@server/constants/issue';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type BackfillSeries from '@server/entity/BackfillSeries';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import agent from '@server/lib/agent';
import { clearAiCache } from '@server/lib/ai';
import autofix, {
  classify,
  minutesOf,
  pickReplacement,
  wrongLength,
} from '@server/lib/autofix';
import type { ArrEpisode, ArrRelease } from '@server/lib/autofix/arr';
import { FixRadarr, FixSonarr } from '@server/lib/autofix/arr';
import backfill from '@server/lib/backfill/engine';
import { Permission } from '@server/lib/permissions';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
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
    title: '[Erai-raws] Naruto - 002 [480p]',
    group: 'Erai-raws',
  };

  it('takes one Sonarr only turns down for the file already there, from another group', () => {
    const picked = pickReplacement(
      [
        release({
          guid: 'same',
          title: '[Erai-raws] Naruto - 002 [480p]',
          releaseGroup: 'Erai-raws',
          rejected: true,
          rejections: [EXISTING],
          qualityWeight: 900,
        }),
        release({
          guid: 'pack',
          title: '[Judas] Naruto S01',
          fullSeason: true,
          rejected: true,
          rejections: ['Full season pack'],
        }),
        release({
          guid: 'low-score',
          title: '[X] Naruto 002',
          rejected: true,
          rejections: [
            'Custom Formats Original Language , Required Size have score 0 below Series profile minimum 100',
          ],
        }),
        release({
          guid: 'other-episode',
          title: '[Judas] Naruto - 003',
          mappedEpisodeInfo: [{ id: 3 }],
        }),
        release({
          guid: 'good',
          title: '[Judas] Naruto - 002 [BD 1080p]',
          releaseGroup: 'Judas',
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
            title: '[Erai-raws] Naruto - 002 [480p].mkv',
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
    releaseGroup: 'Erai-raws',
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
  });
  mock.method(FixSonarr.prototype, 'grab', async (r: { guid: string }) => {
    grabbed.push(r.guid);
  });
  mock.method(FixSonarr.prototype, 'searchEpisodes', async (ids: number[]) => {
    searched.push(ids);
  });
  mock.method(FixRadarr.prototype, 'movieDetail', async () => ({
    id: 9,
    title: 'Groundhog Day',
    hasFile: true,
    movieFile: {
      id: 900,
      sceneName: 'Groundhog.Day.1993.1080p.BluRay.x264-OLD',
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
    title: 'Groundhog Day',
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
          title: 'Groundhog Day',
          release_date: '1993-02-11',
          media_type: 'movie',
          genre_ids: [],
          overview: '',
          popularity: 1,
          vote_average: 8,
          vote_count: 1,
          adult: false,
          original_language: 'en',
          original_title: 'Groundhog Day',
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
      tmdbId: 46260,
      tvdbId: 78857,
      mediaType: MediaType.TV,
      status: MediaStatus.AVAILABLE,
      serviceId: 0,
      externalServiceId: 77,
    })
  );
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
        guid: 'judas-2',
        title: '[Judas] Show - S01E02 [BD 1080p]',
        releaseGroup: 'Judas',
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
      /grabbed \[Judas\] Show - S01E02 \[BD 1080p\] from Nyaa/
    );
    assert.deepEqual(deleted, [502]);
    assert.deepEqual(grabbed, ['judas-2']);
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
      r: 'Getting Spanish subtitles for Groundhog Day.',
      titles: [{ t: 'Groundhog Day', y: 1993, k: 'movie' }],
      do: 'fix',
      fx: 'subtitles',
      lang: 'es',
    });
    const res = await call('POST', '/api/v1/ai/chat', {
      message: 'get spanish subtitles for groundhog day',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.reply, /Downloaded es subtitles from subdl/);
    assert.equal(res.body.fix.ok, true);
    assert.deepEqual(downloads, ['subdl-es']);
  });

  it('files a broken movie as an issue and fixes it in the background', async () => {
    releases = [
      release({
        guid: 'new',
        title: 'Groundhog.Day.1993.1080p.BluRay.x264-NEW',
        releaseGroup: 'NEW',
      }),
    ];
    modelAnswer = JSON.stringify({
      r: 'Replacing it.',
      titles: [{ t: 'Groundhog Day', y: 1993, k: 'movie' }],
      do: 'fix',
      fx: 'broken',
    });
    const res = await call('POST', '/api/v1/ai/chat', {
      message: 'groundhog day has no sound',
    });
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
      /Replacing it: removed Groundhog\.Day\.1993\.1080p\.BluRay\.x264-OLD/
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
      titles: [{ t: 'Groundhog Day', y: 1993, k: 'movie' }],
      do: 'fix',
      fx: 'broken',
    });
    const res = await call('POST', '/api/v1/ai/chat', {
      message: 'groundhog day is broken',
    });
    assert.match(res.body.reply, /needs permission to report problems/);
    assert.equal(await getRepository(Issue).count(), 0);
    assert.deepEqual(deleted, []);
  });

  it('points at the open report when the same problem is asked about again', async () => {
    modelAnswer = JSON.stringify({
      r: '',
      titles: [{ t: 'Groundhog Day', y: 1993, k: 'movie' }],
      do: 'fix',
      fx: 'broken',
    });
    const first = await call('POST', '/api/v1/ai/chat', {
      message: 'groundhog day has no sound',
    });
    await commentOn(Number(first.body.fix.link.split('/').pop()));
    const again = await call('POST', '/api/v1/ai/chat', {
      message: 'groundhog day still has no sound',
    });
    assert.match(again.body.reply, /reported this already today/);
    assert.equal(again.body.fix.link, first.body.fix.link);
    assert.equal(await getRepository(Issue).count(), 1);
  });

  it('says so when the title is not on the server', async () => {
    await getRepository(Media).delete({ id: movie.id });
    modelAnswer = JSON.stringify({
      r: '',
      titles: [{ t: 'Groundhog Day', y: 1993, k: 'movie' }],
      do: 'fix',
      fx: 'subtitles',
    });
    const res = await call('POST', '/api/v1/ai/chat', {
      message: 'subtitles for groundhog day',
    });
    assert.match(res.body.reply, /not on the server yet/);
  });
});
