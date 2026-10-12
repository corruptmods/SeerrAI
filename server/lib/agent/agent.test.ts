import QBittorrentAPI from '@server/api/downloadclients/qbittorrent';
import SabnzbdAPI from '@server/api/downloadclients/sabnzbd';
import type { ProwlarrRelease } from '@server/api/prowlarr';
import ProwlarrAPI from '@server/api/prowlarr';
import TheMovieDb from '@server/api/themoviedb';
import { IssueType } from '@server/constants/issue';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import AgentRun from '@server/entity/AgentRun';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import BackfillJob from '@server/entity/BackfillJob';
import BackfillSeries from '@server/entity/BackfillSeries';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import Media from '@server/entity/Media';
import { MediaEvent, MediaEventType } from '@server/entity/MediaEvent';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import agent, { compact } from '@server/lib/agent';
import {
  MIN_VIDEO_BYTES,
  checkMapping,
  fileNumbers,
  languageProblem,
} from '@server/lib/agent/rules';
import type { AgentState } from '@server/lib/agent/tools';
import {
  forgetSearches,
  lookups,
  runTool,
  searchTiming,
  titleMatches,
} from '@server/lib/agent/tools';
import { ANTHROPIC_URL } from '@server/lib/ai/providers';
import type {
  ArrCustomFormat,
  ArrExtras,
  ArrQualityProfile,
} from '@server/lib/autofix/arr';
import { FixSonarr } from '@server/lib/autofix/arr';
import backfill from '@server/lib/backfill/engine';
import { isVideo } from '@server/lib/backfill/naming';
import backfillNotices from '@server/lib/backfill/notices';
import type { RadarrMovieDetail } from '@server/lib/backfill/radarr';
import BackfillRadarr from '@server/lib/backfill/radarr';
import { relinkEpisodeFile } from '@server/lib/backfill/relink';
import type {
  ManualImportFile,
  SonarrEpisode,
  SonarrEpisodeFile,
  SonarrParseResult,
} from '@server/lib/backfill/sonarr';
import BackfillSonarr from '@server/lib/backfill/sonarr';
import notificationManager from '@server/lib/notifications';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { BACKFILL_DEFAULTS, getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import axios from 'axios';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

setupTestDb();

/*
 * The admin agent, run end to end with a scripted model: it finds the
 * title, reads what is missing, searches, opens a collection whose files
 * are numbered their own way, is turned down when it maps a file onto an
 * episode that already has one, then maps by title and starts a Backfill
 * download of just those files. Sonarr, Prowlarr, qBittorrent and the
 * model's API are stubbed at their clients.
 */

const ben = (value: unknown): Buffer => {
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const b = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return Buffer.concat([Buffer.from(`${b.length}:`), b]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([
      Buffer.from('l'),
      ...value.map(ben),
      Buffer.from('e'),
    ]);
  }
  const dict = value as Record<string, unknown>;
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.keys(dict)
      .sort()
      .flatMap((k) => [ben(k), ben(dict[k])]),
    Buffer.from('e'),
  ]);
};

const MB = 1024 * 1024;
const FOLDER = 'Casper the Friendly Ghost (Complete collection in MP4 format)';
const INFO = {
  name: FOLDER,
  'piece length': 1048576,
  pieces: Buffer.alloc(20),
  files: [
    'Film - E01 (The Friendly Ghost).mp4',
    "Film - E02 (Casper's Spree Under the Sea).mp4",
    'Film - E03 (Once Upon a Rhyme).mp4',
    'Film - E04 (Boo Hoo Baby).mp4',
  ].map((name) => ({ length: 150 * MB, path: ['Theatrical', name] })),
};
const TORRENT = ben({ announce: 'udp://tracker', info: INFO });
const HASH = createHash('sha1').update(ben(INFO)).digest('hex');

const SERIES_ID = 1283;
const ep = (
  id: number,
  episodeNumber: number,
  title: string,
  hasFile: boolean
): SonarrEpisode => ({
  id,
  seriesId: SERIES_ID,
  seasonNumber: 1,
  episodeNumber,
  title,
  hasFile,
  monitored: true,
  episodeFileId: hasFile ? id + 1000 : 0,
  airDateUtc: '1951-01-01T00:00:00Z',
});
const EPISODES = [
  ep(501, 1, "Casper's Spree Under The Sea", false),
  ep(502, 2, 'Once Upon a Rhyme', false),
  ep(503, 3, 'Boo Hoo Baby', true),
];

const COLLECTION: ProwlarrRelease = {
  guid: 'https://indexer/casper',
  title:
    'Casper the Friendly Ghost (Complete collection in MP4 format) [Lando18]',
  size: 600 * MB,
  indexerId: 30,
  indexer: 'LimeTorrents',
  protocol: 'torrent',
  seeders: 5,
  downloadUrl: 'http://prowlarr:9696/30/download?link=x',
};
const FRENCH: ProwlarrRelease = {
  ...COLLECTION,
  guid: 'https://indexer/french',
  title: 'Casper The Friendly Ghost.1950.S01.TRUEFRENCH.DVDRip.x264-FTMVHD',
};

type Reply = (body: Record<string, unknown>) => unknown;
let script: Reply[] = [];
let bodies: Record<string, unknown>[] = [];
let filePrio: { indexes: number[]; priority: number }[] = [];
let sent: { subject?: string; message?: string; actionUrl?: string }[] = [];

const toolUse = (name: string, input: Record<string, unknown>, id = name) => ({
  content: [{ type: 'tool_use', id, name, input }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 20 },
});
/** Several tools asked for in one turn. */
const toolUses = (...calls: [string, Record<string, unknown>][]) => ({
  content: calls.map(([name, input], i) => ({
    type: 'tool_use',
    id: `c${i}`,
    name,
    input,
  })),
  stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 20 },
});
const say = (text: string) => ({
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 100, output_tokens: 20 },
});

/** The last tool result the model was sent. */
const lastResult = (body: Record<string, unknown>) => {
  const messages = body.messages as { content: unknown }[];
  const content = messages[messages.length - 1].content as {
    content: string;
    is_error?: boolean;
  }[];
  return content[0];
};

const parse = (title: string): SonarrParseResult => {
  const match = /S(\d+)E(\d+)/.exec(title);
  const episode = match
    ? EPISODES.find(
        (e) =>
          e.seasonNumber === Number(match[1]) &&
          e.episodeNumber === Number(match[2])
      )
    : undefined;
  return {
    title,
    parsedEpisodeInfo: {
      quality: {
        quality: { id: 2, name: 'DVD' },
        revision: { version: 1, real: 0 },
      },
    },
    series: { id: SERIES_ID, title: 'Casper the Friendly Ghost' },
    episodes: episode ? [episode] : [],
    languages: /TRUEFRENCH/.test(title)
      ? [{ id: 2, name: 'French' }]
      : [{ id: 1, name: 'English' }],
  };
};

const waitForRun = async (id: number, until = ['done', 'failed']) => {
  for (let i = 0; i < 200; i++) {
    const run = await getRepository(AgentRun).findOneOrFail({ where: { id } });
    // SQLite shares one connection: a status can be read before its save
    // commits. The agent is idle once the save is done.
    if (until.includes(run.status) && !agent.isBusy()) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('The run did not finish');
};

const WAIT_MS = searchTiming.waitMs;

beforeEach(async () => {
  forgetSearches();
  searchTiming.waitMs = WAIT_MS;
  script = [];
  bodies = [];
  filePrio = [];
  backfillNotices.flush();
  sent = [];
  const settings = getSettings();
  settings.ai = {
    enabled: true,
    provider: 'anthropic',
    apiKey: 'test-key',
    baseUrl: '',
    model: 'claude-test',
    featureModels: {},
    dailyLimit: 0,
  };
  settings.main.disabledFeatures = [];
  settings.backfill = {
    ...BACKFILL_DEFAULTS,
    enabled: true,
    prowlarr: {
      ...BACKFILL_DEFAULTS.prowlarr,
      hostname: 'prowlarr',
      apiKey: 'k',
    },
    torrentClientId: 1,
    minFreeSpaceGb: 1,
  };
  settings.downloadClients = [
    {
      id: 1,
      name: 'qBittorrent',
      type: 'qbittorrent',
      hostname: 'qbittorrent',
      port: 8080,
      useSsl: false,
      urlBase: '',
      apiKey: '',
      username: '',
      password: '',
    },
  ];
  settings.sonarr = [
    {
      id: 0,
      name: 'Sonarr',
      hostname: 'sonarr',
      port: 8989,
      apiKey: 'x',
      useSsl: false,
      is4k: false,
      isDefault: true,
    } as unknown as SonarrSettings,
  ];
  settings.radarr = [];

  mock.method(
    axios,
    'post',
    async (url: string, body: Record<string, unknown>) => {
      assert.equal(url, `${ANTHROPIC_URL}/messages`);
      bodies.push(body);
      const next = script.shift();
      if (!next)
        throw new Error('The model was asked more than the script says');
      return { data: next(body) };
    }
  );
  mock.method(lookups, 'tmdb', async () => ({ results: [] }));
  mock.method(
    notificationManager,
    'sendNotification',
    (
      _t: unknown,
      payload: { subject?: string; message?: string; actionUrl?: string }
    ) => {
      sent.push(payload);
    }
  );

  const detail = {
    id: SERIES_ID,
    title: 'Casper the Friendly Ghost',
    year: 1950,
    tvdbId: 370935,
    seriesType: 'standard',
    qualityProfileId: 11,
    path: '/tv/Casper the Friendly Ghost',
    originalLanguage: { id: 1, name: 'English' },
    statistics: { episodeFileCount: 1, episodeCount: 3 },
  };
  mock.method(BackfillSonarr.prototype, 'getAllSeries', async () => [detail]);
  mock.method(BackfillSonarr.prototype, 'getSeriesDetail', async () => detail);
  mock.method(
    BackfillSonarr.prototype,
    'getSeriesEpisodes',
    async () => EPISODES
  );
  mock.method(BackfillSonarr.prototype, 'getEpisodeFiles', async () => [
    {
      id: 1503,
      seasonNumber: 1,
      size: 100 * MB,
      quality: {
        quality: { id: 8, name: 'WEBDL-480p' },
        revision: { version: 1, real: 0 },
      },
    },
  ]);
  mock.method(
    BackfillSonarr.prototype,
    'getSeriesQueueEpisodes',
    async () => []
  );
  mock.method(BackfillSonarr.prototype, 'getQualityProfile', async () => ({
    id: 11,
    name: 'HD',
    upgradeAllowed: true,
    cutoff: 3,
    items: [],
    minFormatScore: 0,
    cutoffFormatScore: 0,
  }));
  mock.method(BackfillSonarr.prototype, 'parse', async (title: string) =>
    parse(title)
  );
  mock.method(BackfillSonarr.prototype, 'getRootFoldersNow', async () => [
    { path: '/tv', freeSpace: 10 * 1024 ** 4 },
  ]);
  mock.method(ProwlarrAPI.prototype, 'search', async () => [
    COLLECTION,
    FRENCH,
  ]);
  mock.method(ProwlarrAPI.prototype, 'fetchRelease', async () => ({
    kind: 'torrent',
    data: TORRENT,
  }));
  let added = false;
  mock.method(
    QBittorrentAPI.prototype,
    'ensureCategory',
    async () => undefined
  );
  mock.method(QBittorrentAPI.prototype, 'addTorrent', async () => {
    added = true;
  });
  mock.method(QBittorrentAPI.prototype, 'getTorrent', async () =>
    added
      ? {
          hash: HASH,
          name: FOLDER,
          state: 'stoppedDL',
          progress: 0,
          size: 300 * MB,
          amount_left: 300 * MB,
          eta: 60,
          dlspeed: 0,
          save_path: '/downloads/backfill',
          content_path: `/downloads/backfill/${FOLDER}`,
        }
      : undefined
  );
  mock.method(QBittorrentAPI.prototype, 'getFiles', async () =>
    INFO.files.map((f, index) => ({
      index,
      name: [FOLDER, ...f.path].join('/'),
      size: f.length,
      progress: 0,
      priority: 1,
    }))
  );
  mock.method(
    QBittorrentAPI.prototype,
    'setFilePriority',
    async (_hash: string, indexes: number[], priority: number) => {
      filePrio.push({ indexes: [...indexes].sort(), priority });
    }
  );
  mock.method(QBittorrentAPI.prototype, 'startTorrent', async () => undefined);
  mock.method(QBittorrentAPI.prototype, 'getCategoryTorrents', async () => []);
  mock.method(QBittorrentAPI.prototype, 'stopTorrent', async () => undefined);
});

afterEach(() => mock.restoreAll());

const admin = () => getRepository(User).findOneOrFail({ where: { id: 1 } });

describe('the admin agent', () => {
  it('maps a collection by episode title and downloads only what is missing', async () => {
    script = [
      () => toolUse('find_title', { query: 'casper friendly ghost' }),
      (body) => {
        assert.match(
          lastResult(body).content,
          /series:0:1283 {2}Casper the Friendly Ghost \(1950\)/
        );
        return toolUse('title_status', { title: 'series:0:1283' });
      },
      (body) => {
        const status = lastResult(body).content;
        assert.match(status, /Missing, monitored and aired \(2\)/);
        assert.match(status, /S01E01 "Casper's Spree Under The Sea"/);
        return toolUse('search_indexers', {
          query: 'Casper the Friendly Ghost collection',
          kind: 'series',
        });
      },
      (body) => {
        const found = lastResult(body).content;
        assert.match(found, /^2 results/);
        assert.match(found, /r1 \| 600 MB \| 5 seeders \| LimeTorrents/);
        assert.ok(!found.includes('prowlarr:9696'), 'no links for the model');
        return toolUse('release_files', { release: 'r1' });
      },
      (body) => {
        const files = lastResult(body).content;
        assert.match(
          files,
          /#1 {2}.*Film - E02 \(Casper's Spree Under the Sea\)\.mp4 {2}\(150 MB\)/
        );
        // Taken by its number, E04 would be S01E04, which has no such
        // episode; E03 by number is S01E03, which has a file.
        return toolUse(
          'grab',
          {
            title: 'series:0:1283',
            release: 'r1',
            files: [{ index: 3, season: 1, episode: 3 }],
            reason: 'Boo Hoo Baby is S01E03',
          },
          'g1'
        );
      },
      (body) => {
        const refused = lastResult(body);
        assert.equal(refused.is_error, true);
        assert.match(refused.content, /S01E03 already has a file/);
        return toolUse(
          'grab',
          {
            title: 'series:0:1283',
            release: 'r2',
            files: [{ index: 1, season: 1, episode: 1 }],
            reason: 'trying the other one',
          },
          'g2'
        );
      },
      (body) => {
        const refused = lastResult(body);
        assert.equal(refused.is_error, true);
        assert.match(refused.content, /It is in French, not English/);
        return toolUse(
          'grab',
          {
            title: 'series:0:1283',
            release: 'r1',
            files: [
              { index: 1, season: 1, episode: 1 },
              { index: 2, season: 1, episode: 2 },
            ],
            reason:
              'File titles match the episode titles; the collection counts three earlier shorts first.',
          },
          'g3'
        );
      },
      (body) => {
        const started = lastResult(body);
        assert.equal(started.is_error, undefined);
        assert.match(
          started.content,
          /^Started Backfill job #\d+: 2 files, 300 MB, for S01E01, S01E02/
        );
        return say(
          'Grabbed S01E01 and S01E02 from the collection; S01E03 was already on disk.'
        );
      },
    ];

    const run = await agent.ask(
      'Get the missing Casper the Friendly Ghost episodes',
      await admin()
    );
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.equal(
      done.summary,
      'Grabbed S01E01 and S01E02 from the collection; S01E03 was already on disk.'
    );
    assert.deepEqual(
      [done.kind, done.serverId, done.arrId, done.title],
      ['series', 0, SERIES_ID, 'Casper the Friendly Ghost']
    );
    assert.equal(done.actions.length, 1);
    assert.deepEqual(done.actions[0].episodeIds, [501, 502]);
    assert.equal(done.inputTokens, 800);

    const job = await getRepository(BackfillJob).findOneOrFail({
      where: { id: done.actions[0].jobId },
    });
    assert.equal(job.approvedByName, 'AI agent');
    assert.deepEqual(
      job.files.map((f) => [
        f.index,
        f.episodeIds,
        f.matchedBy,
        f.quality?.quality.name,
      ]),
      [
        [1, [501], 'ai', 'DVD'],
        [2, [502], 'ai', 'DVD'],
      ]
    );
    assert.equal(job.status, 'downloading');
    // Only the two files are fetched.
    assert.deepEqual(filePrio, [
      { indexes: [0, 3], priority: 0 },
      { indexes: [1, 2], priority: 1 },
    ]);
    // Gathered with Backfill's other news; sent when that goes out.
    assert.equal(sent.length, 0);
    backfillNotices.flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].actionUrl, `/backfill/agent/${run.id}`);
    assert.match(
      sent[0].subject ?? '',
      /Casper the Friendly Ghost: change by the admin agent/
    );
    assert.equal(sent[0].message, '1 download started');

    // The model saw every tool, the request one included, as an admin asked.
    const names = (bodies[0].tools as { name: string }[]).map((t) => t.name);
    assert.ok(names.includes('request_title'));
  });

  // Packed in archives, or with scrambled names (only its PAR2 repair
  // files named): either way its files are unknown until it's downloaded.
  const archived = (name: string) =>
    `<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">${[
      'rar',
      'r00',
      'r01',
    ]
      .map(
        (ext, i) =>
          `<file poster="p" date="1" subject="[${i + 1}/3] - &quot;${name}.${ext}&quot; yEnc (1/1)"><segments><segment bytes="100000" number="1">${ext}@x</segment></segments></file>`
      )
      .join('')}</nzb>`;
  const scrambled = () =>
    `<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">${[
      ['9f3c1a7e5b2d', 100000],
      ['04d8e6b1c9a7', 100000],
      ['9f3c1a7e5b2d.par2', 1000],
    ]
      .map(
        ([name, bytes], i) =>
          `<file poster="p" date="1" subject="[${i + 1}/3] - &quot;${name}&quot; yEnc (1/1)"><segments><segment bytes="${bytes}" number="1">${i}@x</segment></segments></file>`
      )
      .join('')}</nzb>`;
  for (const [packing, nzbOf, says] of [
    ['in archives', archived, /packed in archives.*grab it whole/s],
    ['with scrambled names', scrambled, /scrambled file names.*grab it whole/s],
  ] as const) {
    it(`takes a Usenet post ${packing} whole when its name is one missing episode, and imports its one video`, async () => {
      getSettings().backfill = { ...getSettings().backfill, usenetClientId: 2 };
      getSettings().downloadClients = [
        ...getSettings().downloadClients,
        {
          id: 2,
          name: 'SABnzbd',
          type: 'sabnzbd',
          hostname: 'sabnzbd',
          port: 8080,
          useSsl: false,
          urlBase: '',
          apiKey: 'k',
          username: '',
          password: '',
        },
      ];
      const post = (name: string) => ({
        ...COLLECTION,
        guid: `https://usenet/${name}`,
        title: name,
        protocol: 'usenet' as const,
        size: 350 * MB,
        seeders: undefined,
      });
      const EPISODE = post('Casper.the.Friendly.Ghost.S01E02.DVDRip.x264-GRP');
      const SEASON = post('Casper.the.Friendly.Ghost.S01.DVDRip.x264-GRP');
      mock.method(ProwlarrAPI.prototype, 'search', async () => [
        EPISODE,
        SEASON,
      ]);
      mock.method(
        ProwlarrAPI.prototype,
        'fetchRelease',
        async (release: ProwlarrRelease) => ({
          kind: 'nzb',
          data: nzbOf(release.title),
        })
      );
      // Sonarr reads a season pack's name as the season, not one episode.
      mock.method(BackfillSonarr.prototype, 'parse', async (title: string) =>
        /S01\./.test(title)
          ? {
              ...parse(title),
              parsedEpisodeInfo: { seasonNumber: 1, fullSeason: true },
              episodes: EPISODES,
            }
          : parse(title)
      );
      let sabDone = false;
      mock.method(SabnzbdAPI.prototype, 'addNzb', async () => 'SABnzbd_nzo_1');
      mock.method(SabnzbdAPI.prototype, 'getJob', async () =>
        sabDone
          ? {
              place: 'history',
              status: 'Completed',
              percentage: 100,
              size: 350 * MB,
              sizeLeft: 0,
              storage: `/complete/backfill/${EPISODE.title}`,
            }
          : {
              place: 'queue',
              status: 'Downloading',
              percentage: 40,
              size: 350 * MB,
              sizeLeft: 210 * MB,
            }
      );
      mock.method(
        BackfillSonarr.prototype,
        'getRemotePathMappings',
        async () => []
      );
      mock.method(
        BackfillSonarr.prototype,
        'getFolderFiles',
        async (folder: string) => [
          {
            path: `${folder}/abc123def.mkv`,
            name: 'abc123def.mkv',
            size: 340 * MB,
          },
          {
            path: `${folder}/abc123def.sample.mkv`,
            name: 'abc123def.sample.mkv',
            size: 30 * MB,
          },
        ]
      );
      const imported: { path: string; episodeIds: number[] }[][] = [];
      mock.method(
        BackfillSonarr.prototype,
        'manualImport',
        async (files: { path: string; episodeIds: number[] }[]) => {
          imported.push(
            files.map((f) => ({ path: f.path, episodeIds: f.episodeIds }))
          );
          return 91;
        }
      );

      script = [
        () =>
          toolUse('search_indexers', {
            query: 'Casper the Friendly Ghost',
            kind: 'series',
          }),
        () => toolUse('release_files', { release: 'r1' }),
        (body) => {
          assert.match(lastResult(body).content, says);
          return toolUse('grab', {
            title: 'series:0:1283',
            release: 'r2',
            files: [{ index: 0, season: 1, episode: 1 }],
            reason: 'the season pack',
            whole: true,
          });
        },
        (body) => {
          const refused = lastResult(body);
          assert.equal(refused.is_error, true);
          assert.match(refused.content, /reads .* as a season pack/);
          return toolUse('grab', {
            title: 'series:0:1283',
            release: 'r1',
            files: [{ index: 0, season: 1, episode: 1 }],
            reason: 'its name is the episode',
            whole: true,
          });
        },
        (body) => {
          const refused = lastResult(body);
          assert.equal(refused.is_error, true);
          assert.match(refused.content, /as S01E02, not S01E01/);
          return toolUse('grab', {
            title: 'series:0:1283',
            release: 'r1',
            files: [{ index: 0, season: 1, episode: 2 }],
            reason: 'its name is the episode',
            whole: true,
          });
        },
        (body) => {
          const started = lastResult(body);
          assert.equal(started.is_error, undefined, started.content);
          assert.match(
            started.content,
            /^Started Backfill job #\d+: 1 files, 350 MB, for S01E02/
          );
          return say('Downloading S01E02 whole from Usenet.');
        },
      ];
      const run = await agent.ask('Get Casper S01E02', await admin());
      const done = await waitForRun(run.id);
      assert.equal(done.status, 'done', done.error ?? '');
      const job = await getRepository(BackfillJob).findOneOrFail({
        where: { id: done.actions[0].jobId },
      });
      assert.equal(job.protocol, 'usenet');
      assert.deepEqual(
        job.files.map((f) => [f.whole, f.episodeIds]),
        [[true, [502]]]
      );

      sabDone = true;
      await backfill.tick();
      assert.deepEqual(imported, [
        [
          {
            path: `/complete/backfill/${EPISODE.title}/abc123def.mkv`,
            episodeIds: [502],
          },
        ],
      ]);
    });
  }

  it('looks again before taking a file that names neither its episode nor its number', async () => {
    script = [
      () =>
        toolUse('search_indexers', {
          query: 'Casper the Friendly Ghost',
          kind: 'series',
        }),
      () => toolUse('release_files', { release: 'r1' }),
      () =>
        toolUse('grab', {
          title: 'series:0:1283',
          release: 'r1',
          // "Boo Hoo Baby" is not "Once Upon a Rhyme", and E04 is not E02.
          files: [{ index: 3, season: 1, episode: 2 }],
          reason: 'Fourth short is the second episode',
        }),
      (body) => {
        const held = lastResult(body);
        assert.equal(held.is_error, true);
        assert.match(
          held.content,
          /Not started\. Look again: File #3 "Film - E04 \(Boo Hoo Baby\)" names neither S01E02 "Once Upon a Rhyme" nor its number/
        );
        return toolUse('grab', {
          title: 'series:0:1283',
          release: 'r1',
          files: [{ index: 3, season: 1, episode: 2 }],
          reason: 'Checked: the uploader mislabelled it',
          certain: true,
        });
      },
      (body) => {
        assert.match(lastResult(body).content, /^Started Backfill job/);
        return say('Started it.');
      },
    ];
    const run = await agent.ask('Get Casper', await admin());
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.deepEqual(done.actions[0].episodeIds, [502]);
  });

  it('takes a pack used before again for other episodes, joining it while it downloads', async () => {
    const row = await backfill.track('series', 0, SERIES_ID);
    const used = await getRepository(BackfillCandidate).save(
      new BackfillCandidate({
        seriesId: row.id,
        guid: COLLECTION.guid,
        title: COLLECTION.title,
        indexer: COLLECTION.indexer,
        indexerId: COLLECTION.indexerId,
        protocol: 'torrent',
        size: COLLECTION.size,
        status: 'approved',
        plan: [],
      })
    );
    const file = (index: number, episodeId: number, state: string) => ({
      index,
      path: `${FOLDER}/Theatrical/${INFO.files[index].path[1]}`,
      size: 150 * MB,
      judgedAs: INFO.files[index].path[1],
      episodeIds: [episodeId],
      season: 1,
      episode: episodeId - 500,
      score: 0,
      action: 'fill' as const,
      replaces: 0,
      state: state as 'waiting',
    });
    const job = (
      status: BackfillJob['status'],
      files: ReturnType<typeof file>[]
    ) =>
      getRepository(BackfillJob).save(
        new BackfillJob({
          seriesId: row.id,
          candidateId: used.id,
          title: COLLECTION.title,
          status,
          stage: status === 'downloading' ? 'Downloading' : null,
          mode: 'missing',
          protocol: 'torrent',
          clientId: 1,
          downloadId: HASH,
          files,
          size: 150 * MB * files.length,
          sizeLeft: 0,
          commandIds: [],
          log: [],
        })
      );
    // Done before with S01E02 not imported; S01E01 never asked for.
    await job('done', [file(2, 502, 'failed')]);
    const running = await job('downloading', [file(3, 503, 'waiting')]);

    script = [
      () =>
        toolUse('search_indexers', {
          query: 'Casper the Friendly Ghost',
          kind: 'series',
        }),
      () => toolUse('release_files', { release: 'r1' }),
      () =>
        toolUse('grab', {
          title: 'series:0:1283',
          release: 'r1',
          files: [{ index: 2, season: 1, episode: 2 }],
          reason: 'Once Upon a Rhyme by title',
        }),
      (body) => {
        const refused = lastResult(body);
        assert.equal(refused.is_error, true);
        assert.match(
          refused.content,
          /S01E02 did not import from this release in Backfill job #\d+; take it from another release\./
        );
        return toolUse('grab', {
          title: 'series:0:1283',
          release: 'r1',
          files: [{ index: 1, season: 1, episode: 1 }],
          reason: "Casper's Spree Under the Sea by title",
        });
      },
      (body) => {
        const added = lastResult(body);
        assert.equal(added.is_error, undefined, added.content);
        assert.match(
          added.content,
          new RegExp(
            `^Added to Backfill job #${running.id}, which is already downloading this release: 1 files, 150 MB, for S01E01\\.`
          )
        );
        return say('Added S01E01 to the download already running.');
      },
    ];
    const run = await agent.ask('Get Casper', await admin());
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.equal(done.actions[0].jobId, running.id);
    const after = await getRepository(BackfillJob).findOneOrFail({
      where: { id: running.id },
    });
    assert.deepEqual(
      after.files.map((f) => [f.index, f.episodeIds, f.state]),
      [
        [3, [503], 'waiting'],
        [1, [501], 'waiting'],
      ]
    );
    assert.equal(after.size, 300 * MB);
    assert.match(
      after.log[after.log.length - 1].message,
      /AI agent added 1 file/
    );
    // The new file is fetched too.
    assert.deepEqual(filePrio, [{ indexes: [1], priority: 1 }]);
    assert.equal(
      await getRepository(BackfillJob).count({ where: { seriesId: row.id } }),
      2,
      'no new download for the same torrent'
    );
  });

  it('takes a pack again once its earlier download is over, but never one turned down', async () => {
    const row = await backfill.track('series', 0, SERIES_ID);
    const candidates = getRepository(BackfillCandidate);
    const earlier = await candidates.save(
      new BackfillCandidate({
        seriesId: row.id,
        guid: COLLECTION.guid,
        title: COLLECTION.title,
        indexer: COLLECTION.indexer,
        indexerId: COLLECTION.indexerId,
        protocol: 'torrent',
        size: COLLECTION.size,
        status: 'approved',
        plan: [],
      })
    );
    await getRepository(BackfillJob).save(
      new BackfillJob({
        seriesId: row.id,
        candidateId: earlier.id,
        title: COLLECTION.title,
        status: 'done',
        mode: 'missing',
        protocol: 'torrent',
        clientId: 1,
        downloadId: HASH,
        files: [],
        size: 0,
        sizeLeft: 0,
        commandIds: [],
        log: [],
      })
    );
    const grabOne = () =>
      toolUse('grab', {
        title: 'series:0:1283',
        release: 'r1',
        files: [{ index: 1, season: 1, episode: 1 }],
        reason: 'by title',
      });
    script = [
      () =>
        toolUse('search_indexers', {
          query: 'Casper the Friendly Ghost',
          kind: 'series',
        }),
      () => toolUse('release_files', { release: 'r1' }),
      grabOne,
      (body) => {
        assert.match(lastResult(body).content, /^Started Backfill job #\d+/);
        return say('Started it.');
      },
    ];
    const run = await agent.ask('Get Casper', await admin());
    assert.equal((await waitForRun(run.id)).status, 'done');

    // An admin turning it down is final.
    await candidates.update({ seriesId: row.id }, { status: 'skipped' });
    await getRepository(BackfillJob).update(
      { seriesId: row.id },
      { status: 'cancelled' }
    );
    script = [
      () =>
        toolUse('search_indexers', {
          query: 'Casper the Friendly Ghost',
          kind: 'series',
        }),
      () => toolUse('release_files', { release: 'r1' }),
      grabOne,
      (body) => {
        const refused = lastResult(body);
        assert.equal(refused.is_error, true);
        assert.equal(
          refused.content,
          'An admin turned this release down for this title. Choose another.'
        );
        return say('That release was turned down.');
      },
    ];
    const again = await agent.ask('Get Casper', await admin());
    assert.equal((await waitForRun(again.id)).status, 'done');
  });

  it('starts a second download beside one under way, for other episodes only', async () => {
    const row = await backfill.track('series', 0, SERIES_ID);
    const running = await getRepository(BackfillJob).save(
      new BackfillJob({
        seriesId: row.id,
        candidateId: null,
        title: 'Casper S01E01 WEB',
        status: 'downloading',
        mode: 'missing',
        protocol: 'torrent',
        clientId: 1,
        downloadId: 'feed',
        files: [
          {
            index: 0,
            path: 'Casper S01E01.mkv',
            size: 150 * MB,
            judgedAs: 'Casper S01E01',
            episodeIds: [501],
            season: 1,
            episode: 1,
            score: 0,
            action: 'fill',
            replaces: 0,
            state: 'waiting',
          },
        ],
        size: 150 * MB,
        sizeLeft: 150 * MB,
        commandIds: [],
        log: [],
      })
    );
    script = [
      () => toolUse('title_status', { title: 'series:0:1283' }),
      (body) => {
        const status = lastResult(body).content;
        assert.match(
          status,
          new RegExp(
            `S01E01 "Casper's Spree Under The Sea" 1951-01-01 \\[downloading in Backfill job #${running.id}\\]`
          )
        );
        assert.match(status, new RegExp(`job #${running.id} is downloading`));
        return toolUse('search_indexers', {
          query: 'Casper the Friendly Ghost',
          kind: 'series',
        });
      },
      () => toolUse('release_files', { release: 'r1' }),
      () =>
        toolUse('grab', {
          title: 'series:0:1283',
          release: 'r1',
          files: [
            { index: 1, season: 1, episode: 1 },
            { index: 2, season: 1, episode: 2 },
          ],
          reason: 'Both by title',
        }),
      (body) => {
        const refused = lastResult(body);
        assert.equal(refused.is_error, true);
        assert.match(
          refused.content,
          new RegExp(
            `S01E01 is already downloading in Backfill job #${running.id}\\.`
          )
        );
        return toolUse('grab', {
          title: 'series:0:1283',
          release: 'r1',
          files: [{ index: 2, season: 1, episode: 2 }],
          reason: 'Once Upon a Rhyme by title',
        });
      },
      (body) => {
        assert.match(lastResult(body).content, /^Started Backfill job #\d+/);
        return say('Started S01E02 beside the download already running.');
      },
    ];
    const run = await agent.ask('Get Casper', await admin());
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.deepEqual(done.actions[0].episodeIds, [502]);
    assert.notEqual(done.actions[0].jobId, running.id);
    assert.equal(
      await getRepository(BackfillJob).count({
        where: { seriesId: row.id, status: 'downloading' },
      }),
      2
    );
  });

  it('runs searches asked for together at the same time, each answer after its call', async () => {
    let searching = 0;
    let most = 0;
    const slow = async () => {
      searching += 1;
      most = Math.max(most, searching);
      await new Promise((resolve) => setTimeout(resolve, 40));
      searching -= 1;
      return [];
    };
    mock.method(BackfillSonarr.prototype, 'getReleases', slow);
    mock.method(ProwlarrAPI.prototype, 'search', slow);
    script = [
      () =>
        toolUses(
          ['search_releases', { title: 'series:0:1283', season: 1 }],
          ['search_indexers', { query: 'Casper complete', kind: 'series' }],
          ['search_releases', { title: 'series:0:1283', season: 0 }]
        ),
      (body) => {
        const messages = body.messages as { content: unknown }[];
        const answers = messages[messages.length - 1].content as {
          tool_use_id: string;
          content: string;
        }[];
        assert.deepEqual(
          answers.map((a) => [a.tool_use_id, a.content]),
          [
            ['c0', 'No results from any indexer.'],
            ['c1', 'Nothing for "Casper complete".'],
            ['c2', 'No results from any indexer.'],
          ]
        );
        return say('Nothing anywhere.');
      },
    ];
    const run = await agent.ask('Get Casper', await admin());
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.equal(most, 3, 'all three searched at once');
    assert.deepEqual(
      done.steps.map((s) => [s.kind, s.tool ?? null]),
      [
        ['tool', 'search_releases'],
        ['result', 'search_releases'],
        ['tool', 'search_indexers'],
        ['result', 'search_indexers'],
        ['tool', 'search_releases'],
        ['result', 'search_releases'],
        ['say', null],
      ]
    );
  });

  it('leaves a slow search running and picks up its results when asked again', async () => {
    searchTiming.waitMs = 30;
    let finish: (results: []) => void = () => undefined;
    const getReleases = mock.method(
      BackfillSonarr.prototype,
      'getReleases',
      () =>
        new Promise<[]>((resolve) => {
          finish = resolve;
        })
    );
    script = [
      () => toolUse('search_releases', { title: 'series:0:1283', season: 1 }),
      (body) => {
        const waiting = lastResult(body);
        assert.equal(waiting.is_error, undefined);
        assert.match(
          waiting.content,
          /^Sonarr is still searching season 1 \(1 min so far\)\. It keeps going: call search_releases again with the same title and season/
        );
        finish([]);
        return toolUse('search_releases', {
          title: 'series:0:1283',
          season: 1,
        });
      },
      (body) => {
        assert.equal(lastResult(body).content, 'No results from any indexer.');
        return say('Sonarr found nothing for season 1.');
      },
    ];
    const run = await agent.ask('Get Casper', await admin());
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.equal(getReleases.mock.callCount(), 1, 'searched once');
  });

  it('asks when it cannot decide, and goes on from where it was after the answer', async () => {
    script = [
      () => toolUse('search_indexers', { query: 'Casper', kind: 'series' }),
      () =>
        toolUse('ask_admin', {
          question: 'There is an English collection and a French one. Which?',
        }),
    ];
    const run = await agent.ask('Get Casper', await admin());
    const waiting = await waitForRun(run.id, ['waiting']);
    assert.equal(
      waiting.question,
      'There is an English collection and a French one. Which?'
    );
    assert.equal(sent.length, 1, 'admins are told it has a question');
    assert.match(sent[0].subject ?? '', /has a question/);

    script = [
      (body) => {
        const messages = body.messages as { role: string; content: unknown }[];
        assert.equal(messages[messages.length - 1].role, 'user');
        assert.match(
          String(messages[messages.length - 1].content),
          /says: The English one, and check it is English first/
        );
        // Its earlier work is still there: r1 needs no new search.
        return toolUse('check_language', {
          title: 'series:0:1283',
          release: 'r1',
        });
      },
      (body) => {
        const check = lastResult(body).content;
        assert.match(check, /Release name reads as: English/);
        assert.match(check, /Nothing here hears the audio/);
        return toolUse('grab', {
          title: 'series:0:1283',
          release: 'r1',
          files: [{ index: 1, season: 1, episode: 1 }],
          reason: 'English collection, as asked',
        });
      },
      () => say('Started the English one.'),
    ];
    await agent.reply(
      run.id,
      'The English one, and check it is English first',
      await admin()
    );
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.equal(done.question, null);
    assert.deepEqual(
      done.steps.filter((s) => s.kind === 'reply').map((s) => s.text),
      ['Admin: The English one, and check it is English first'].map((t) =>
        t.replace('Admin', done.requestedByName ?? 'Admin')
      )
    );
    const jobId = done.actions[0].jobId;

    // A correction: it stops what it started.
    mock.method(
      QBittorrentAPI.prototype,
      'deleteTorrent',
      async () => undefined
    );
    script = [
      () =>
        toolUse('stop_download', {
          job: jobId,
          reason: 'The admin says it is the wrong file',
        }),
      (body) => {
        assert.match(
          lastResult(body).content,
          new RegExp(`^Stopped job #${jobId}`)
        );
        return say('Stopped it.');
      },
    ];
    await agent.reply(run.id, 'That is the wrong file, stop it', await admin());
    const stopped = await waitForRun(run.id);
    assert.equal(stopped.status, 'done', stopped.error ?? '');
    assert.deepEqual(
      stopped.actions.map((a) => a.type),
      ['grab', 'stop']
    );
    const job = await getRepository(BackfillJob).findOneOrFail({
      where: { id: jobId },
    });
    assert.equal(job.status, 'cancelled');
  });

  it('follows the standing instructions', async () => {
    const settings = getSettings();
    settings.backfill = {
      ...settings.backfill,
      agent: {
        ...settings.backfill.agent,
        instructions: 'Always check the language first.',
      },
    };
    script = [
      (body) => {
        assert.match(
          String(body.system),
          /Standing instructions from the admin, always to be followed:\nAlways check the language first\./
        );
        return say('Noted.');
      },
    ];
    const run = await agent.ask('Hello', await admin());
    assert.equal((await waitForRun(run.id)).status, 'done');
  });

  it('carries on by itself once after its step limit, then stops when it gets nowhere', async () => {
    const settings = getSettings();
    settings.backfill = {
      ...settings.backfill,
      agent: { ...settings.backfill.agent, maxSteps: 3, autoContinue: 2 },
    };
    const lastText = (body: Record<string, unknown>) => {
      const messages = body.messages as { content: unknown }[];
      return JSON.stringify(messages[messages.length - 1].content);
    };
    script = [
      ...Array.from(
        { length: 3 },
        () => () => toolUse('find_title', { query: 'casper' })
      ),
      (body) => {
        assert.match(lastText(body), /Carry on with what is left/);
        return toolUse('find_title', { query: 'casper' });
      },
      () => toolUse('find_title', { query: 'casper' }),
      () => toolUse('find_title', { query: 'casper' }),
      (body) => {
        // That go started nothing: no third.
        assert.match(lastText(body), /limit of 3 steps/);
        return say('Nothing found.');
      },
    ];
    const run = await agent.ask('Find Casper', await admin());
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.equal(done.steps.filter((s) => s.kind === 'tool').length, 6);
    assert.ok(
      done.steps.some(
        (s) =>
          s.kind === 'say' && /carrying on by itself \(1 of 2\)/.test(s.text)
      )
    );
    assert.equal(
      done.summary,
      'Nothing found.\n\nIt stopped after 2 goes of 3 steps, as the last one started nothing. Reply to let it carry on.'
    );
  });

  it('stops at the step limit and still gives a summary', async () => {
    const settings = getSettings();
    settings.backfill = {
      ...settings.backfill,
      agent: { ...settings.backfill.agent, maxSteps: 5, autoContinue: 0 },
    };
    script = [
      ...Array.from(
        { length: 5 },
        () => () => toolUse('find_title', { query: 'casper' })
      ),
      (body) => {
        const messages = body.messages as { content: unknown }[];
        assert.match(
          String(messages[messages.length - 1].content),
          /limit of 5 steps/
        );
        return say('Ran out of steps.');
      },
    ];
    const run = await agent.ask('Find Casper', await admin());
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'done');
    assert.equal(
      done.summary,
      'Ran out of steps.\n\nIt stopped at its limit of 5 steps. Reply to let it carry on.'
    );
    assert.equal(done.steps.filter((s) => s.kind === 'tool').length, 5);
  });

  it('counts a round of searches at once as one step, and runs at most 12 at once', async () => {
    const settings = getSettings();
    settings.backfill = {
      ...settings.backfill,
      agent: { ...settings.backfill.agent, maxSteps: 5 },
    };
    const fourteen = () =>
      toolUses(
        ...Array.from(
          { length: 14 },
          (_, i) =>
            ['search_indexers', { query: `Casper ${i}`, kind: 'series' }] as [
              string,
              Record<string, unknown>,
            ]
        )
      );
    script = [
      fourteen,
      (body) => {
        const messages = body.messages as { content: unknown }[];
        const answers = messages[messages.length - 1].content as {
          content: string;
          is_error?: boolean;
        }[];
        assert.equal(answers.length, 14);
        assert.equal(answers.filter((a) => a.is_error).length, 2);
        assert.match(answers[13].content, /^Not run: at most 12 tools at once/);
        return fourteen();
      },
      () => say('Two rounds were enough.'),
    ];
    const run = await agent.ask('Find Casper', await admin());
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.equal(done.summary, 'Two rounds were enough.');
    assert.equal(done.steps.filter((s) => s.kind === 'tool').length, 24);
  });

  it("shows a season search only that season's releases", async () => {
    const release = (title: string, season?: number) => ({
      guid: title,
      title,
      indexerId: 1,
      indexer: 'NZBgeek',
      protocol: 'usenet',
      size: 300 * MB,
      approved: false,
      rejections: ["Episode wasn't requested"],
      ...(season !== undefined
        ? { mappedSeasonNumber: season, mappedEpisodeNumbers: [1] }
        : {}),
    });
    mock.method(BackfillSonarr.prototype, 'getReleases', async () => [
      release('Casper S57E01 1080p', 57),
      release('Casper S56E08 1080p', 56),
      release('Casper S01E01 DVDRip', 1),
      release('Casper Complete Collection'),
    ]);
    script = [
      () => toolUse('search_releases', { title: 'series:0:1283', season: 1 }),
      (body) => {
        const found = lastResult(body).content;
        assert.match(
          found,
          /^2 results \(2 more for other seasons left out\):/
        );
        assert.match(found, /Casper S01E01 DVDRip/);
        assert.match(found, /Casper Complete Collection/);
        assert.ok(!found.includes('S57E01'));
        return say('Only season 1 and a collection.');
      },
    ];
    const run = await agent.ask('Find Casper', await admin());
    assert.equal((await waitForRun(run.id)).status, 'done');
  });

  it('starts on its own only for requested titles, once in a while', async () => {
    const row = await getRepository(BackfillSeries).save(
      new BackfillSeries({
        kind: 'series',
        serverId: 0,
        arrId: SERIES_ID,
        tmdbId: 260376,
        title: 'Casper the Friendly Ghost',
        status: 'none',
        missing: 2,
        searchTerms: [],
      })
    );
    assert.equal(
      await agent.afterEmptySearch(row),
      null,
      'nobody asked for it'
    );

    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 260376,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
      })
    );
    await getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        type: MediaType.TV,
        status: MediaRequestStatus.APPROVED,
        requestedBy: await admin(),
      }),
      { listeners: false }
    );
    script = [
      (body) => {
        const names = (body.tools as { name: string }[]).map((t) => t.name);
        assert.ok(
          !names.includes('request_title'),
          'never requests on its own'
        );
        const first = (body.messages as { content: string }[])[0].content;
        assert.match(first, /Casper the Friendly Ghost \(series:0:1283\)/);
        return say('Nothing better than what Backfill saw.');
      },
    ];
    const run = await agent.afterEmptySearch(row);
    assert.ok(run);
    assert.equal(run.trigger, 'auto');
    assert.equal(await agent.afterEmptySearch(row), null, 'not again so soon');
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'done');
    backfillNotices.flush();
    assert.equal(sent.length, 0, 'nothing done, nobody told');

    // It looks on its own once per title: never again, even once the
    // conversation is cleared out, nor for a report of it.
    const marked = await getRepository(BackfillSeries).findOneOrFail({
      where: { id: row.id },
    });
    assert.ok(marked.agentAutoRunAt instanceof Date);
    await getRepository(AgentRun).delete({ id: run.id });
    assert.equal(await agent.afterEmptySearch(marked), null, 'only once');
    const member = await getRepository(User).save(
      new User({
        email: 'agent-reporter@test.local',
        permissions: 0,
        avatar: '',
      })
    );
    const report = (reporter: User) =>
      agent.afterReport({
        kind: 'series',
        serverId: 0,
        arrId: SERIES_ID,
        title: 'Casper the Friendly Ghost',
        reporter,
      });
    assert.equal(await report(member), null, 'nor for someone’s report');
    // An admin reporting it is asking for it.
    const asked = await report(await admin());
    assert.ok(asked);
    assert.equal(asked.status, 'held');
    await getRepository(AgentRun).delete({ id: asked.id });
    // The title's history says so.
    const events = await getRepository(MediaEvent).find({
      where: { tmdbId: 260376, type: MediaEventType.AGENT },
    });
    assert.deepEqual(
      events.map((e) => [e.mediaType, e.userId, e.detail]),
      [
        [
          MediaType.TV,
          null,
          'On its own (it does that once per title): it found nothing it could use.',
        ],
      ]
    );

    const settings = getSettings();
    settings.backfill = {
      ...settings.backfill,
      agent: { ...settings.backfill.agent, autoRun: false },
    };
    assert.equal(await agent.afterEmptySearch(marked), null, 'turned off');
  });

  it('clears out finished conversations older than the days kept', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const runs = getRepository(AgentRun);
    const make = (status: AgentRun['status'], daysAgo: number) =>
      new AgentRun({
        trigger: 'ask',
        status,
        ask: `${status} ${daysAgo}`,
        finishedAt: new Date(now - daysAgo * DAY),
        steps: [],
        actions: [],
      });
    await runs.save([
      make('done', 40),
      make('failed', 31),
      make('done', 10),
      make('waiting', 60),
    ]);
    getSettings().backfill = {
      ...getSettings().backfill,
      agent: { ...getSettings().backfill.agent, keepDays: 0 },
    };
    assert.equal(await agent.purge(now), 0, '0 keeps them all');
    getSettings().backfill = {
      ...getSettings().backfill,
      agent: { ...getSettings().backfill.agent, keepDays: 30 },
    };
    assert.equal(await agent.purge(now), 2);
    assert.deepEqual(
      (await runs.find({ order: { id: 'ASC' } })).map((r) => r.ask),
      ['done 10', 'waiting 60']
    );
  });

  it('looks into a title reported missing once the searches found nothing, and answers on the issue', async (t) => {
    // Issues and their comments tell people, with the title from TMDB.
    // (A field set per client: caught on the way in, as the issue tests do.)
    Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
      configurable: true,
      set() {},
      get() {
        return async () => ({
          name: 'Casper the Friendly Ghost',
          poster_path: null,
        });
      },
    });
    t.after(() => {
      delete (TheMovieDb.prototype as { getTvShow?: unknown }).getTvShow;
    });
    const reporter = await admin();
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 8888,
        tvdbId: 370935,
        mediaType: MediaType.TV,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        serviceId: 0,
        externalServiceId: SERIES_ID,
      })
    );
    const issue = await getRepository(Issue).save(
      new Issue({
        issueType: IssueType.OTHER,
        media,
        createdBy: reporter,
      })
    );
    let commands = [
      {
        id: 9,
        name: 'EpisodeSearch',
        status: 'started',
        body: { episodeIds: [501] },
      },
    ];
    mock.method(BackfillSonarr.prototype, 'getCommands', async () => commands);
    const report = {
      kind: 'series' as const,
      serverId: 0,
      arrId: SERIES_ID,
      title: 'Casper the Friendly Ghost',
      reporter,
      issueId: issue.id,
    };
    const held = await agent.afterReport(report);
    assert.equal(held?.status, 'held');
    assert.equal(await agent.afterReport(report), null, 'one at a time');

    // Sonarr is still searching: it waits.
    await agent.checkHeld();
    const still = await getRepository(AgentRun).findOneOrFail({
      where: { id: held!.id },
    });
    assert.equal(still.status, 'held');

    commands = [{ ...commands[0], status: 'completed' }];
    script = [
      (body) => {
        assert.match(
          JSON.stringify((body.messages as unknown[])[0]),
          /reported that Casper the Friendly Ghost \(series:0:1283\) is missing\. Sonarr searched again and found nothing usable/
        );
        return say('No release of the two missing shorts exists yet.');
      },
    ];
    await agent.checkHeld();
    const done = await waitForRun(held!.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.equal(done.trigger, 'report');
    const comments = await getRepository(IssueComment).find({
      where: { issue: { id: issue.id } },
    });
    assert.deepEqual(
      comments.map((c) => c.message),
      ['Admin agent: No release of the two missing shorts exists yet.']
    );
  });

  it('lets a report go when Sonarr found what was missing', async () => {
    mock.method(BackfillSonarr.prototype, 'getCommands', async () => []);
    mock.method(
      BackfillSonarr.prototype,
      'getSeriesQueueEpisodes',
      async () => [501, 502]
    );
    const held = await agent.afterReport({
      kind: 'series',
      serverId: 0,
      arrId: SERIES_ID,
      title: 'Casper the Friendly Ghost',
      reporter: await admin(),
    });
    await agent.checkHeld();
    const run = await getRepository(AgentRun).findOneOrFail({
      where: { id: held!.id },
    });
    assert.equal(run.status, 'done');
    assert.equal(
      run.summary,
      'Not needed: Sonarr found what was missing and is downloading it.'
    );
    assert.equal(bodies.length, 0, 'the model was never asked');
  });

  it('cannot run without AI set up for it', async () => {
    getSettings().main.disabledFeatures = ['aiAgent'];
    await assert.rejects(
      agent.ask('Find Casper', await admin()),
      /Admin Agent/
    );
  });
});

describe('the agent’s limits', () => {
  it('takes English or the original language, and names that say nothing', () => {
    assert.equal(languageProblem([{ name: 'English' }]), null);
    assert.equal(languageProblem([{ name: 'Unknown' }]), null);
    assert.equal(languageProblem([]), null);
    assert.equal(languageProblem([{ name: 'Japanese' }], 'Japanese'), null);
    assert.equal(
      languageProblem([{ name: 'French' }], 'English'),
      'It is in French, not English.'
    );
    assert.equal(
      languageProblem([{ name: 'German' }], 'Japanese'),
      'It is in German, not English or Japanese.'
    );
  });

  it('only fills monitored, aired episodes with no file, each once', () => {
    const files = [
      { index: 0, path: 'a/E01.mkv', size: MIN_VIDEO_BYTES + 1 },
      { index: 1, path: 'a/E02.mkv', size: MIN_VIDEO_BYTES + 1 },
      { index: 2, path: 'a/info.nfo', size: 100 },
      { index: 3, path: 'a/sample.mkv', size: 1000 },
      { index: 4, path: 'a/E01 again.mkv', size: MIN_VIDEO_BYTES + 1 },
    ];
    const episodes = [
      {
        id: 1,
        seasonNumber: 1,
        episodeNumber: 1,
        hasFile: false,
        monitored: true,
      },
      {
        id: 2,
        seasonNumber: 1,
        episodeNumber: 2,
        hasFile: true,
        monitored: true,
      },
      {
        id: 3,
        seasonNumber: 1,
        episodeNumber: 3,
        hasFile: false,
        monitored: false,
      },
      {
        id: 4,
        seasonNumber: 1,
        episodeNumber: 4,
        hasFile: false,
        monitored: true,
        airDateUtc: '2999-01-01T00:00:00Z',
      },
      {
        id: 5,
        seasonNumber: 1,
        episodeNumber: 5,
        hasFile: false,
        monitored: true,
      },
    ];
    const { ok, problems } = checkMapping(
      [
        { index: 0, season: 1, episode: 1 },
        { index: 0, season: 1, episode: 5 },
        { index: 1, season: 1, episode: 2 },
        { index: 1, season: 1, episode: 3 },
        { index: 1, season: 1, episode: 4 },
        { index: 1, season: 1, episode: 5 },
        { index: 4, season: 1, episode: 1 },
        { index: 2, season: 1, episode: 5 },
        { index: 3, season: 1, episode: 5 },
        { index: 9, season: 1, episode: 5 },
        { index: 1, season: 2, episode: 1 },
        { index: 1 },
      ],
      files,
      episodes,
      { queued: new Set(), isVideo }
    );
    assert.deepEqual(
      ok.map((o) => [o.file.index, o.episode.id]),
      [
        [0, 1],
        [1, 5],
      ]
    );
    assert.deepEqual(problems, [
      'File #0 is given twice.',
      'S01E02 already has a file; existing files are never replaced.',
      'S01E03 is not monitored, so it is not wanted.',
      'S01E04 has not aired yet.',
      'S01E01 is given two files.',
      'File #2 is not a video of any length.',
      'File #3 is not a video of any length.',
      'There is no file #9 in this release.',
      'S02E01 is not an episode of this series.',
      'File #1 needs a season and an episode.',
    ]);
    const queued = checkMapping(
      [{ index: 0, season: 1, episode: 1 }],
      files,
      episodes,
      { queued: new Set([1]), isVideo }
    );
    assert.deepEqual(queued.problems, [
      'S01E01 is already downloading in Sonarr.',
    ]);
  });

  it('cuts the oldest tool results short in a long conversation, nothing else', () => {
    const big = (n: number) => `line one of ${n}\n${'x'.repeat(50_000)}`;
    const messages = compact([
      { role: 'user', text: 'Get Casper' },
      { role: 'assistant', text: '', calls: [], raw: [] },
      { role: 'tool', results: [{ id: 'a', content: big(1) }] },
      { role: 'tool', results: [{ id: 'b', content: big(2) }] },
      { role: 'tool', results: [{ id: 'c', content: big(3) }] },
      { role: 'user', text: 'Also check the language' },
    ]);
    const contents = messages
      .filter((m) => m.role === 'tool')
      .map((m) => (m.role === 'tool' ? m.results[0].content : ''));
    assert.equal(
      contents[0],
      'line one of 1 … (shortened; run it again if needed)'
    );
    assert.equal(contents[1].length, big(2).length, 'small enough by then');
    assert.equal(messages.length, 6);
  });

  it('reads a fansub "S5 - 13" as the season’s episode, not the series’', () => {
    assert.deepEqual(
      fileNumbers('[HorribleSubs] Shokugeki no Soma S5 - 13 [1080p].mkv'),
      { season: 5, episode: 13 }
    );
    assert.deepEqual(
      fileNumbers('[SubsPlease] Food Wars Season 2 - 04v2 (720p).mkv'),
      { season: 2, episode: 4 }
    );
    assert.deepEqual(
      fileNumbers('[HorribleSubs] Shokugeki no Soma - 13 [1080p].mkv'),
      { absolute: 13 }
    );
    assert.deepEqual(fileNumbers('Food Wars! S05E13 The Last Dish 1080p.mkv'), {
      season: 5,
      episode: 13,
    });
  });

  it('finds titles by every word, in any order, ignoring "the" and punctuation', () => {
    assert.ok(titleMatches('casper ghost', 'Casper the Friendly Ghost'));
    assert.ok(
      titleMatches(
        'Spooktacular Casper',
        'The Spooktacular New Adventures of Casper'
      )
    );
    assert.ok(!titleMatches('casper school', 'Casper the Friendly Ghost'));
    assert.ok(titleMatches('Amelie', 'Amélie'));
  });
});

describe('the admin agent and files holding several episodes', () => {
  const DOUBLE_INFO = {
    name: 'Casper the Friendly Ghost S01 1080p',
    'piece length': 1048576,
    pieces: Buffer.alloc(20),
    files: [
      {
        length: 300 * MB,
        path: [
          "Casper the Friendly Ghost - S01E01-02 - Casper's Spree Under The Sea + Once Upon a Rhyme.mkv",
        ],
      },
    ],
  };

  it('gives a file named as two episodes both of them, and only as a last resort', async () => {
    mock.method(ProwlarrAPI.prototype, 'search', async () => [
      {
        ...COLLECTION,
        guid: 'https://indexer/doubles',
        title: 'Casper the Friendly Ghost S01 1080p',
      },
    ]);
    mock.method(ProwlarrAPI.prototype, 'fetchRelease', async () => ({
      kind: 'torrent',
      data: ben({ announce: 'udp://tracker', info: DOUBLE_INFO }),
    }));
    const grab = (file: Record<string, unknown>, certain?: boolean) =>
      toolUse('grab', {
        title: 'series:0:1283',
        release: 'r1',
        files: [{ index: 0, season: 1, ...file }],
        reason: 'The file is both episodes',
        ...(certain ? { certain } : {}),
      });
    script = [
      () =>
        toolUse('search_indexers', {
          query: 'Casper the Friendly Ghost',
          kind: 'series',
        }),
      () => toolUse('release_files', { release: 'r1' }),
      // Given only the first, as the agent once did: Sonarr would name it
      // S01E01 and the second would stay missing.
      () => grab({ episode: 1 }),
      (body) => {
        const refused = lastResult(body);
        assert.equal(refused.is_error, true);
        assert.match(
          refused.content,
          /is S01E01-E02 by its name, but it was given S01E01\. Give it every episode it holds: episodes: \[1, 2\]/
        );
        return grab({ episodes: [1, 2] });
      },
      (body) => {
        const held = lastResult(body);
        assert.equal(held.is_error, true);
        assert.match(
          held.content,
          /File #0 holds 2 episodes \(S01E01-E02\)\. One file per episode is preferred/
        );
        assert.doesNotMatch(held.content, /names neither/);
        return grab({ episodes: [1, 2] }, true);
      },
      (body) => {
        assert.match(
          lastResult(body).content,
          /^Started Backfill job .* for S01E01-E02/
        );
        return say('Started it.');
      },
    ];
    const run = await agent.ask('Get Casper', await admin());
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.deepEqual(done.actions[0].episodeIds, [501, 502]);
    const job = await getRepository(BackfillJob).findOneOrFail({
      where: { id: done.actions[0].jobId },
    });
    assert.deepEqual(
      job.files.map((f) => f.episodeIds),
      [[501, 502]]
    );
    assert.match(job.files[0].judgedAs, /S01E01-E02/);
  });

  it('relinks an imported file to every episode it holds when asked', async () => {
    const episodes = [
      { ...EPISODES[0], hasFile: true, episodeFileId: 900 },
      { ...EPISODES[1] },
    ];
    let files = [
      {
        id: 900,
        seasonNumber: 1,
        relativePath: 'Season 1/Casper - S01E01 - Spree.mkv',
        size: 300 * MB,
        mediaInfo: { runTime: '13:43' },
        quality: {
          quality: { id: 9, name: 'HDTV-1080p' },
          revision: { version: 1, real: 0 },
        },
      },
    ];
    const imported: ManualImportFile[][] = [];
    const detail = await new BackfillSonarr({
      apiKey: 'x',
      url: 'http://sonarr',
    }).getSeriesDetail(SERIES_ID);
    mock.method(BackfillSonarr.prototype, 'getSeriesDetail', async () => ({
      ...detail,
      runtime: 7,
    }));
    mock.method(
      BackfillSonarr.prototype,
      'getSeriesEpisodes',
      async () => episodes
    );
    mock.method(BackfillSonarr.prototype, 'getEpisodeFiles', async () => files);
    mock.method(
      BackfillSonarr.prototype,
      'manualImport',
      async (given: ManualImportFile[]) => {
        imported.push(given);
        files = [{ ...files[0], id: 901 }];
        for (const e of episodes) e.episodeFileId = 901;
        return 1;
      }
    );
    mock.method(BackfillSonarr.prototype, 'renameFiles', async () => {
      files = [
        {
          ...files[0],
          relativePath: 'Season 1/Casper - S01E01-E02 - Spree + Rhyme.mkv',
        },
      ];
      return 2;
    });
    mock.method(BackfillSonarr.prototype, 'getCommand', async () => ({
      id: 1,
      name: 'x',
      status: 'completed',
    }));
    script = [
      () => toolUse('title_status', { title: 'series:0:1283' }),
      (body) => {
        assert.match(
          lastResult(body).content,
          /Files about twice an episode's 7 minutes but linked to one episode, likely holding two: S01E01 \(13:43\)\./
        );
        return toolUse('relink_file', {
          title: 'series:0:1283',
          season: 1,
          episodes: [1, 2],
          reason: 'It runs 14 minutes and its name lists both titles',
        });
      },
      (body) => {
        assert.match(
          lastResult(body).content,
          /Linked to S01E01-E02 and renamed: "Casper - S01E01 - Spree" is now "Casper - S01E01-E02 - Spree \+ Rhyme"/
        );
        return say('Relinked it.');
      },
    ];
    const run = await agent.ask(
      'Casper S01E01 holds two episodes',
      await admin()
    );
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.equal(done.actions[0].type, 'relink');
    assert.deepEqual(imported[0][0].episodeIds, [501, 502]);
    assert.equal(
      imported[0][0].path,
      '/tv/Casper the Friendly Ghost/Season 1/Casper - S01E01 - Spree.mkv'
    );
  });

  it('turns down episodes that are not in a row', () => {
    const { ok, problems } = checkMapping(
      [{ index: 0, season: 1, episodes: [1, 3] }],
      [{ index: 0, path: 'a/x.mkv', size: MIN_VIDEO_BYTES + 1 }],
      [1, 2, 3].map((n) => ({
        id: n,
        seasonNumber: 1,
        episodeNumber: n,
        hasFile: false,
        monitored: true,
      })),
      { queued: new Set(), isVideo }
    );
    assert.deepEqual(ok, []);
    assert.match(problems[0], /a file holds episodes in a row, not 1, 3/);
  });
});

describe('relinking a file that holds several episodes', () => {
  const quality = {
    quality: { id: 9, name: 'HDTV-1080p' },
    revision: { version: 1, real: 0 },
  };
  const episode = (id: number, n: number, fileId: number) =>
    ({
      id,
      seriesId: 7,
      seasonNumber: 6,
      episodeNumber: n,
      hasFile: !!fileId,
      monitored: true,
      episodeFileId: fileId,
    }) as SonarrEpisode;

  /** A Sonarr whose manual import and rename change what it answers. */
  const fakeSonarr = (
    episodes: SonarrEpisode[],
    files: SonarrEpisodeFile[]
  ) => {
    const calls: { imported: ManualImportFile[][]; renamed: number[][] } = {
      imported: [],
      renamed: [],
    };
    const sonarr = {
      getSeriesDetail: async () => ({ id: 7, path: '/tv/Shaun the Sheep' }),
      getSeriesEpisodes: async () => episodes,
      getEpisodeFiles: async () => files,
      manualImport: async (given: ManualImportFile[]) => {
        calls.imported.push(given);
        // Sonarr replaces the file's record: a new id, every episode on it.
        const old = files.find((f) => given[0].path.endsWith(f.relativePath!))!;
        const now = { ...old, id: old.id + 100 };
        files.splice(files.indexOf(old), 1, now);
        for (const e of episodes) {
          if (given[0].episodeIds.includes(e.id)) {
            e.episodeFileId = now.id;
            e.hasFile = true;
          }
        }
        return 1;
      },
      renameFiles: async (_series: number, ids: number[]) => {
        calls.renamed.push(ids);
        const f = files.find((x) => x.id === ids[0])!;
        f.relativePath =
          'Season 6/Shaun the Sheep - S06E01-E02 - Baa-gherita! + Get Your Goat [HDTV-1080p].mkv';
        return 2;
      },
      getCommand: async () => ({ id: 1, name: 'x', status: 'completed' }),
    };
    return { sonarr: sonarr as unknown as BackfillSonarr, calls };
  };
  const noWait = async () => undefined;

  it('links the file to every episode it holds in place, and has Sonarr rename it', async () => {
    const files: SonarrEpisodeFile[] = [
      {
        id: 172086,
        seasonNumber: 6,
        relativePath:
          'Season 6/Shaun the Sheep - S06E01 - Baa-gherita! [HDTV-1080p].mkv',
        size: 375 * MB,
        quality,
        releaseGroup: undefined,
        languages: [{ id: 1, name: 'English' }],
      },
    ];
    const episodes = [episode(145799, 1, 172086), episode(145800, 2, 0)];
    const { sonarr, calls } = fakeSonarr(episodes, files);
    const result = await relinkEpisodeFile(sonarr, 7, 6, [2, 1], noWait);
    assert.equal(result.changed, true);
    assert.equal(result.episodes, 'S06E01-E02');
    assert.match(result.to, /S06E01-E02/);
    // The file Sonarr already has, where it is, with no download: Sonarr
    // then only replaces its record and moves nothing.
    assert.deepEqual(calls.imported, [
      [
        {
          path: '/tv/Shaun the Sheep/Season 6/Shaun the Sheep - S06E01 - Baa-gherita! [HDTV-1080p].mkv',
          seriesId: 7,
          episodeIds: [145799, 145800],
          quality,
          languages: [{ id: 1, name: 'English' }],
          releaseGroup: undefined,
        },
      ],
    ]);
    assert.ok(!('downloadId' in calls.imported[0][0]));
    assert.deepEqual(calls.renamed, [[172186]]);
  });

  it('never touches an episode with a file of its own, and says when it is already linked', async () => {
    const files: SonarrEpisodeFile[] = [
      {
        id: 1,
        seasonNumber: 6,
        relativePath: 'Season 6/a.mkv',
        size: 1,
        quality,
      },
      {
        id: 2,
        seasonNumber: 6,
        relativePath: 'Season 6/b.mkv',
        size: 1,
        quality,
      },
    ];
    const own = fakeSonarr([episode(11, 1, 1), episode(12, 2, 2)], files);
    await assert.rejects(
      relinkEpisodeFile(own.sonarr, 7, 6, [1, 2], noWait),
      /S06E02 already has a file of its own/
    );
    assert.deepEqual(own.calls.imported, []);

    const linked = fakeSonarr([episode(11, 1, 1), episode(12, 2, 1)], files);
    const result = await relinkEpisodeFile(linked.sonarr, 7, 6, [1, 2], noWait);
    assert.equal(result.changed, false);
    assert.deepEqual(linked.calls.imported, []);

    await assert.rejects(
      relinkEpisodeFile(linked.sonarr, 7, 6, [1, 3], noWait),
      /in a row/
    );
  });
});

describe('the admin agent and movies', () => {
  const MOVIE: RadarrMovieDetail = {
    id: 3831,
    title: 'Shaun the Sheep: Little Sheep of Horrors',
    year: 2025,
    tmdbId: 1698932,
    path: '/movies/Shaun the Sheep - Little Sheep of Horrors (2025)',
    qualityProfileId: 6,
    monitored: true,
    isAvailable: true,
    hasFile: false,
    movieFileId: 0,
    originalLanguage: { id: 1, name: 'English' },
  };
  const MOVIE_INFO = {
    name: 'Shaun.the.Sheep.Little.Sheep.of.Horrors.2025.1080p.WEB-DL',
    'piece length': 1048576,
    pieces: Buffer.alloc(20),
    files: [
      {
        length: 900 * MB,
        path: ['Shaun.the.Sheep.Little.Sheep.of.Horrors.2025.1080p.WEB-DL.mkv'],
      },
    ],
  };

  beforeEach(() => {
    getSettings().radarr = [
      {
        id: 0,
        name: 'Radarr',
        hostname: 'radarr',
        port: 7878,
        apiKey: 'x',
        useSsl: false,
        is4k: false,
        isDefault: true,
      } as unknown as RadarrSettings,
    ];
    getSettings().backfill.includeMovies = true;
    const radarr = BackfillRadarr.prototype;
    mock.method(radarr, 'getMovieDetail', async () => MOVIE);
    mock.method(radarr, 'getMovieFile', async () => null);
    mock.method(radarr, 'getMovieQueueCount', async () => 0);
    mock.method(radarr, 'getQualityProfile', async () => ({
      id: 6,
      name: 'HD',
      upgradeAllowed: true,
      cutoff: 3,
      items: [],
      minFormatScore: 0,
      cutoffFormatScore: 0,
    }));
    mock.method(radarr, 'parse', async (title: string) => ({
      title,
      movie: { id: MOVIE.id, title: MOVIE.title, year: 2025 },
      parsedMovieInfo: {
        quality: {
          quality: { id: 3, name: 'WEBDL-1080p' },
          revision: { version: 1, real: 0 },
        },
      },
      languages: [{ id: 1, name: 'English' }],
    }));
    mock.method(radarr, 'getRootFoldersNow', async () => [
      { path: '/movies', freeSpace: 10 * 1024 ** 4 },
    ]);
    mock.method(ProwlarrAPI.prototype, 'search', async () => [
      {
        ...COLLECTION,
        guid: 'https://indexer/horrors',
        title: 'Shaun.the.Sheep.Little.Sheep.of.Horrors.2025.1080p.WEB-DL',
        size: 900 * MB,
      },
    ]);
    mock.method(ProwlarrAPI.prototype, 'fetchRelease', async () => ({
      kind: 'torrent',
      data: ben({ announce: 'udp://tracker', info: MOVIE_INFO }),
    }));
  });

  it('downloads a missing movie it was asked for', async () => {
    script = [
      () =>
        toolUse('search_indexers', {
          query: 'Shaun the Sheep Little Sheep of Horrors',
          kind: 'movie',
        }),
      () => toolUse('release_files', { release: 'r1' }),
      () =>
        toolUse('grab', {
          title: 'movie:0:3831',
          release: 'r1',
          files: [{ index: 0 }],
          reason: 'The one file is the movie',
        }),
      (body) => {
        // It once always answered "Radarr has a file for this now": the
        // agent's movie plan carried no movie id, so the check passed for
        // nothing.
        assert.match(lastResult(body).content, /^Started Backfill job/);
        return say('Started it.');
      },
    ];
    const run = await agent.ask('Get Little Sheep of Horrors', await admin());
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'done', done.error ?? '');
    const job = await getRepository(BackfillJob).findOneOrFail({
      where: { id: done.actions[0].jobId },
    });
    assert.deepEqual(
      job.files.map((f) => f.episodeIds),
      [[MOVIE.id]]
    );
  });

  it('still turns a movie down once Radarr has a file for it', async () => {
    mock.method(BackfillRadarr.prototype, 'getMovieDetail', async () => ({
      ...MOVIE,
      hasFile: true,
      movieFileId: 77,
    }));
    script = [
      () =>
        toolUse('search_indexers', {
          query: 'Shaun the Sheep Little Sheep of Horrors',
          kind: 'movie',
        }),
      () => toolUse('release_files', { release: 'r1' }),
      () =>
        toolUse('grab', {
          title: 'movie:0:3831',
          release: 'r1',
          files: [{ index: 0 }],
          reason: 'The one file is the movie',
        }),
      (body) => {
        const refused = lastResult(body);
        assert.equal(refused.is_error, true);
        assert.match(refused.content, /already has a file/);
        return say('It has a file already.');
      },
    ];
    const run = await agent.ask('Get Little Sheep of Horrors', await admin());
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.deepEqual(done.actions, []);
  });
});

describe('changes the admin agent proposes', () => {
  /** What the run was paused with, for an admin to decide on. */
  const proposalOf = (run: AgentRun) =>
    (
      run.memory as {
        proposal?: {
          id: string;
          changes: { kind: string; headline: string; details: string[] }[];
        };
      }
    ).proposal;

  it('replaces a file only once an admin approves, and only once', async () => {
    script = [
      () => toolUse('search_indexers', { query: 'Casper', kind: 'series' }),
      () => toolUse('release_files', { release: 'r1' }),
      () =>
        toolUse('grab', {
          title: 'series:0:1283',
          release: 'r1',
          files: [{ index: 3, season: 1, episode: 3 }],
          reason: 'The file there is a 480p web rip; this is the DVD.',
          replace: true,
        }),
    ];
    const run = await agent.ask(
      'Replace Boo Hoo Baby in Casper with a better copy',
      await admin()
    );
    const waiting = await waitForRun(run.id, ['waiting']);
    // The model is not asked again until the admin decides.
    assert.equal(script.length, 0);
    const proposal = proposalOf(waiting);
    assert.ok(proposal);
    assert.equal(proposal.changes.length, 1);
    assert.equal(proposal.changes[0].kind, 'replace');
    assert.equal(
      proposal.changes[0].headline,
      'Replace a file of Casper the Friendly Ghost'
    );
    assert.match(proposal.changes[0].details.join('\n'), /S01E03 Boo Hoo Baby/);
    assert.match(
      proposal.changes[0].details.join('\n'),
      /until it has, the old file stays/
    );
    assert.match(waiting.question ?? '', /^Waiting for approval: Replace/);
    assert.equal(waiting.steps[waiting.steps.length - 1].kind, 'propose');
    // Nothing was started.
    assert.equal(await getRepository(BackfillJob).count(), 0);
    assert.equal(waiting.actions.length, 0);
    assert.match(sent[0]?.subject ?? '', /needs your approval/);

    script = [
      (body) => {
        const messages = body.messages as { role: string; content: unknown }[];
        const said = String(messages[messages.length - 1].content);
        assert.match(said, /approved\. What came of it:/);
        assert.match(
          said,
          /Done: Replace a file of .*Started Backfill job #\d+/
        );
        assert.match(said, /replaced only once its new one has imported/);
        return say('Replacing S01E03 with the DVD copy.');
      },
    ];
    const me = await admin();
    await agent.approve(run.id, proposal.id, me);
    // Deciding twice does nothing more.
    await assert.rejects(
      agent.approve(run.id, proposal.id, me),
      /no longer waiting/
    );
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.equal(proposalOf(done), undefined);
    assert.deepEqual(
      done.actions.map((a) => a.type),
      ['grab']
    );
    const job = await getRepository(BackfillJob).findOneOrFail({
      where: { id: done.actions[0].jobId },
    });
    assert.equal(job.mode, 'all');
    assert.equal(job.approvedByName, `AI agent, approved by ${me.displayName}`);
    assert.deepEqual(
      job.files.map((f) => [f.index, f.episodeIds, f.action, f.replaces]),
      [[3, [503], 'upgrade', 1]]
    );
    await assert.rejects(
      agent.approve(run.id, proposal.id, me),
      /no longer waiting/
    );
  });

  it('changes nothing when an admin declines, or answers instead', async () => {
    const settings = getSettings();
    mock.method(settings, 'save', async () => undefined);
    script = [
      () =>
        toolUse('propose_change', {
          kind: 'blockGroup',
          group: 'rothebehap',
          reason: 'Their releases have been fakes.',
        }),
    ];
    const run = await agent.ask('Block rothebehap', await admin());
    const waiting = await waitForRun(run.id, ['waiting']);
    const proposal = proposalOf(waiting);
    assert.equal(
      proposal?.changes[0].headline,
      'Block the release group rothebehap'
    );
    const declined = await agent.decline(run.id, proposal!.id, await admin());
    assert.equal(declined.status, 'done');
    assert.match(
      declined.summary ?? '',
      /declined: Block the release group rothebehap/
    );
    assert.deepEqual(settings.backfill.blockedGroups ?? [], []);
    await assert.rejects(
      agent.approve(run.id, proposal!.id, await admin()),
      /no longer waiting/
    );

    // Answering instead of approving: the proposal is dropped, and the
    // model is told nothing of it was done.
    script = [
      () =>
        toolUse('propose_change', {
          kind: 'blockGroup',
          group: 'rothebehap',
          reason: 'Asked again.',
        }),
    ];
    await agent.reply(run.id, 'Actually, block it', await admin());
    const again = await waitForRun(run.id, ['waiting']);
    const second = proposalOf(again);
    assert.ok(second && second.id !== proposal!.id);
    script = [
      (body) => {
        const messages = body.messages as { role: string; content: unknown }[];
        assert.match(
          String(messages[messages.length - 1].content),
          /not approved and nothing of it was done/
        );
        return say('Understood, leaving it.');
      },
    ];
    await agent.reply(run.id, 'Never mind', await admin());
    const left = await waitForRun(run.id);
    assert.equal(proposalOf(left), undefined);
    await assert.rejects(
      agent.approve(run.id, second!.id, await admin()),
      /no longer waiting/
    );
    assert.deepEqual(settings.backfill.blockedGroups ?? [], []);
  });

  it('blocks a release group in Seerr AI and Sonarr once approved', async () => {
    const settings = getSettings();
    mock.method(settings, 'save', async () => undefined);
    const formats: ArrCustomFormat[] = [];
    const profiles: ArrQualityProfile[] = [
      { id: 11, name: 'HD', minFormatScore: 0, formatItems: [] },
    ];
    mock.getter(
      FixSonarr.prototype,
      'extras',
      () =>
        ({
          customFormats: async () => formats,
          saveCustomFormat: async (f: ArrCustomFormat) => {
            const saved = { ...f, id: f.id ?? 40 };
            formats.splice(0, formats.length, saved);
            return saved;
          },
          qualityProfiles: async () => profiles,
          saveQualityProfile: async (p: ArrQualityProfile) => {
            profiles[0] = p;
          },
        }) as unknown as ArrExtras
    );
    script = [
      () =>
        toolUse('propose_change', {
          kind: 'blockGroup',
          group: 'rothebehap',
          reason: 'Their releases have been fakes.',
        }),
    ];
    const run = await agent.ask('Block rothebehap everywhere', await admin());
    const waiting = await waitForRun(run.id, ['waiting']);
    // Proposing changed nothing.
    assert.deepEqual(settings.backfill.blockedGroups ?? [], []);
    assert.equal(formats.length, 0);
    script = [
      (body) => {
        const messages = body.messages as { role: string; content: unknown }[];
        assert.match(
          String(messages[messages.length - 1].content),
          /Done: Block the release group rothebehap\. Blocked rothebehap\. Radarr and Sonarr are updated\./
        );
        return say('Blocked.');
      },
    ];
    await agent.approve(run.id, proposalOf(waiting)!.id, await admin());
    const done = await waitForRun(run.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.deepEqual(settings.backfill.blockedGroups, ['rothebehap']);
    assert.equal(formats[0].name, 'Seerr AI: blocked release groups');
    assert.deepEqual(profiles[0].formatItems, [
      { format: 40, name: 'Seerr AI: blocked release groups', score: -1 },
    ]);
    assert.equal(done.actions[0].type, 'change');
    assert.equal(done.actions[0].change, 'blockGroup');

    // The agent's own searches now say so, and it cannot take one.
    mock.method(ProwlarrAPI.prototype, 'search', async () => [
      {
        ...COLLECTION,
        guid: 'https://indexer/blocked',
        title: 'Casper.S01E01.DVDRip.x264-rothebehap',
      },
    ]);
    script = [
      () => toolUse('search_indexers', { query: 'Casper', kind: 'series' }),
      (body) => {
        assert.match(
          lastResult(body).content,
          /blocked group rothebehap: never take it/
        );
        return toolUse('grab', {
          title: 'series:0:1283',
          release: 'r1',
          files: [{ index: 0, season: 1, episode: 1 }],
          reason: 'try it',
        });
      },
      (body) => {
        const refused = lastResult(body);
        assert.equal(refused.is_error, true);
        assert.match(refused.content, /rothebehap is a blocked release group/);
        return say('Nothing usable.');
      },
    ];
    await agent.reply(run.id, 'Now get S01E01', await admin());
    assert.equal((await waitForRun(run.id)).status, 'done');
  });

  it('never offers changes, or replaces a file, when no admin is in the conversation', async () => {
    const state = {
      run: { trigger: 'auto', steps: [], actions: [] },
      releases: new Map(),
    } as unknown as AgentState;
    const proposed = await runTool(state, 'propose_change', {
      kind: 'blockGroup',
      group: 'x',
      reason: 'no',
    });
    assert.equal(proposed.isError, true);
    assert.match(proposed.text, /There is no tool called propose_change/);
    const replaced = await runTool(state, 'grab', {
      title: 'series:0:1283',
      release: 'r1',
      files: [{ index: 0, season: 1, episode: 3 }],
      reason: 'better',
      replace: true,
    });
    assert.equal(replaced.isError, true);
    assert.match(replaced.text, /replaced only when an admin asks/);
    // Once an admin has replied, they are.
    (state.run.steps as { kind: string }[]).push({ kind: 'reply' });
    const allowed = await runTool(state, 'propose_change', {
      kind: 'unblockGroup',
      group: 'x',
      reason: 'test',
    });
    assert.match(allowed.text, /x is not blocked/);
  });
});
