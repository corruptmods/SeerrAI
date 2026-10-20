import QBittorrentAPI from '@server/api/downloadclients/qbittorrent';
import type { ProwlarrRelease } from '@server/api/prowlarr';
import ProwlarrAPI from '@server/api/prowlarr';
import { getRepository } from '@server/datasource';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import BackfillJob from '@server/entity/BackfillJob';
import BackfillSeries from '@server/entity/BackfillSeries';
import backfill, { MAX_FAILED_PER_DAY } from '@server/lib/backfill/engine';
import { mentionsShow, sameShow } from '@server/lib/backfill/matcher';
import type { MovieContext } from '@server/lib/backfill/movies';
import { judgeMoviePack, movieName } from '@server/lib/backfill/movies';
import type {
  RadarrMovieDetail,
  RadarrMovieFile,
  RadarrParseResult,
} from '@server/lib/backfill/radarr';
import BackfillRadarr from '@server/lib/backfill/radarr';
import type {
  SonarrQuality,
  SonarrQualityProfile,
} from '@server/lib/backfill/sonarr';
import BackfillSonarr from '@server/lib/backfill/sonarr';
import notificationManager from '@server/lib/notifications';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { BACKFILL_DEFAULTS, getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { AxiosError } from 'axios';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { Not } from 'typeorm';

setupTestDb();

/*
 * Backfill for movies: judging packs against one movie with Radarr's
 * parser, and a movie followed from Radarr's wanted list to its import.
 * Radarr, Prowlarr and qBittorrent are stubbed at their API clients; the
 * parse answers have the shapes the live Radarr gave.
 */

const GB = 1024 ** 3;
const q = (id: number, name: string): SonarrQuality => ({
  quality: { id, name },
  revision: { version: 1, real: 0 },
});
const WEB_720 = q(5, 'WEBDL-720p');
const BLURAY_1080 = q(7, 'Bluray-1080p');

const PROFILE: SonarrQualityProfile = {
  id: 6,
  name: '1080p Efficient',
  upgradeAllowed: true,
  cutoff: 7,
  items: [
    { quality: { id: 5, name: 'WEBDL-720p' }, allowed: true },
    { quality: { id: 7, name: 'Bluray-1080p' }, allowed: true },
  ],
  minFormatScore: 0,
  cutoffFormatScore: 1000,
};

const SECRETS: RadarrMovieDetail = {
  id: 55,
  title: 'Harry Potter and the Chamber of Secrets',
  year: 2002,
  tmdbId: 672,
  path: '/movies/Harry Potter and the Chamber of Secrets (2002)',
  qualityProfileId: 6,
  monitored: true,
  isAvailable: true,
  hasFile: false,
  movieFileId: 0,
  lastSearchTime: '2026-01-01T00:00:00Z',
};

/** Radarr's parser: a name with the year, or one it knows as another movie. */
const parse = (title: string): RadarrParseResult => {
  const quality = /1080p/i.test(title) ? BLURAY_1080 : WEB_720;
  if (/Prisoner.of.Azkaban/i.test(title)) {
    return {
      title,
      movie: { id: 99, title: 'Harry Potter and the Prisoner of Azkaban' },
      parsedMovieInfo: { quality },
    };
  }
  const known = title.match(/^(.+?) \((\d{4})\)/);
  if (known && known[1] === SECRETS.title && Number(known[2]) === 2002) {
    return {
      title,
      movie: { id: SECRETS.id, title: SECRETS.title, year: 2002 },
      parsedMovieInfo: { quality, releaseGroup: 'GRP' },
      languages: [{ id: 1, name: 'English' }],
      customFormatScore: 120,
    };
  }
  const dated = title.match(/^(.+?)[ .](19\d{2}|20\d{2})\b/);
  return dated
    ? {
        title,
        parsedMovieInfo: {
          primaryMovieTitle: dated[1].replace(/\./g, ' '),
          year: Number(dated[2]),
          quality,
        },
      }
    : { title };
};

const context = (
  file: RadarrMovieFile | null = null,
  movie = SECRETS
): MovieContext => ({
  movie,
  file,
  profile: PROFILE,
  names: [movie.title],
  radarr: { parse: async (t: string) => parse(t) } as unknown as BackfillRadarr,
});

const files = (...names: string[]) =>
  names.map((path, index) => ({ index, path, size: 2 * GB }));

describe('Backfill for movies: judging a pack', () => {
  it('takes this movie out of a collection and leaves the others', async () => {
    const { plan, summary } = await judgeMoviePack(
      files(
        'Harry Potter Collection/Harry.Potter.and.the.Philosophers.Stone.mkv',
        'Harry Potter Collection/Harry.Potter.and.the.Chamber.of.Secrets.mkv',
        'Harry Potter Collection/Harry.Potter.and.the.Prisoner.of.Azkaban.2004.mkv'
      ),
      'Harry Potter Complete Collection 1080p BluRay x264-GRP',
      context()
    );
    assert.equal(summary.fill, 1);
    const used = plan.find((e) => e.action === 'fill')!;
    assert.equal(used.index, 1);
    assert.deepEqual(used.episodeIds, [55]);
    assert.equal(used.quality?.quality.name, 'Bluray-1080p');
    assert.equal(
      used.judgedAs,
      'Harry Potter and the Chamber of Secrets (2002) 1080p BluRay x264-GRP'
    );
    const reasons = plan
      .filter((e) => e.action === 'reject')
      .map((e) => e.reason);
    assert.deepEqual(reasons.sort(), [
      'Named as another movie: Harry Potter and the Prisoner of Azkaban',
      'Not this movie',
    ]);
  });

  it('takes a lone file with a bare name from a pack named for the movie', async () => {
    const { summary } = await judgeMoviePack(
      files('Chamber/movie.mkv', 'Chamber/sample.mkv'),
      'Harry Potter and the Chamber of Secrets 2002 1080p BluRay x264-GRP',
      context()
    );
    assert.equal(summary.fill, 1);
  });

  it('turns down a remake from another year', async () => {
    const thing: RadarrMovieDetail = {
      ...SECRETS,
      id: 60,
      title: 'The Thing',
      year: 2011,
    };
    const { plan } = await judgeMoviePack(
      files('The.Thing.1982.1080p.BluRay.x264-GRP.mkv'),
      'The Thing 1982 1080p BluRay x264-GRP',
      context(null, thing)
    );
    assert.equal(plan[0].action, 'reject');
    assert.equal(plan[0].reason, 'From 1982, not 2011');
  });

  it('upgrades a file on disk only when Radarr would', async () => {
    const onDisk = (
      quality: SonarrQuality,
      customFormatScore = 0
    ): RadarrMovieFile => ({
      id: 900,
      movieId: 55,
      size: GB,
      quality,
      customFormatScore,
    });
    const pack = files('Harry.Potter.and.the.Chamber.of.Secrets.mkv');
    const title = 'Harry Potter and the Chamber of Secrets 1080p BluRay';
    const better = await judgeMoviePack(pack, title, {
      ...context(onDisk(WEB_720)),
      movie: { ...SECRETS, hasFile: true, movieFileId: 900 },
    });
    assert.equal(better.plan[0].action, 'upgrade');
    assert.equal(better.plan[0].replaces, 1);
    const same = await judgeMoviePack(pack, title, {
      ...context(onDisk(BLURAY_1080, 1000)),
      movie: { ...SECRETS, hasFile: true, movieFileId: 900 },
    });
    assert.equal(same.plan[0].action, 'skip');
  });

  it('never takes a sequel for the movie, from a collection or alone', async () => {
    const toyStory: RadarrMovieDetail = {
      ...SECRETS,
      id: 70,
      title: 'Toy Story',
      year: 1995,
    };
    const ctx = context(null, toyStory);
    ctx.radarr = {
      parse: async (title: string) =>
        title.startsWith('Toy Story (1995)')
          ? {
              title,
              movie: { id: 70, title: 'Toy Story' },
              parsedMovieInfo: { quality: BLURAY_1080 },
            }
          : parse(title),
    } as unknown as BackfillRadarr;
    const { plan } = await judgeMoviePack(
      files(
        'Toy Story Collection/Toy Story 2.mkv',
        'Toy Story Collection/Toy Story.mkv',
        'Toy Story Collection/Toy Story 3.mkv'
      ),
      'Toy Story Collection 1080p BluRay x264-GRP',
      ctx
    );
    const used = plan.filter((e) => e.action === 'fill');
    assert.deepEqual(
      used.map((e) => e.path),
      ['Toy Story Collection/Toy Story.mkv']
    );
    const alone = await judgeMoviePack(
      files('Toy Story 2/movie.mkv'),
      'Toy Story 2 1999 1080p BluRay x264-GRP',
      ctx
    );
    assert.equal(alone.summary.fill, 0);
  });

  it('does not take a lone file from a pack of another year', async () => {
    const thing: RadarrMovieDetail = {
      ...SECRETS,
      id: 60,
      title: 'The Thing',
      year: 1982,
    };
    const { plan } = await judgeMoviePack(
      files('sparks-thething-1080p.mkv'),
      'The Thing 2011 1080p BluRay x264-SPARKS',
      context(null, thing)
    );
    assert.equal(plan[0].action, 'reject');
  });

  it('turns down episodes that come up in a movie search', async () => {
    const { plan } = await judgeMoviePack(
      files('Harry.Potter.and.the.Chamber.of.Secrets.S01E02.mkv'),
      'Harry Potter and the Chamber of Secrets S01 1080p',
      context()
    );
    assert.equal(plan[0].reason, 'An episode, not a movie');
  });

  it('finds titles that are only a year', () => {
    assert.equal(mentionsShow('1917 2019 1080p BluRay x264', ['1917']), true);
    assert.equal(sameShow('2012', ['1917']), false);
    assert.equal(sameShow('1917', ['1917']), true);
    assert.equal(sameShow('Perfect World 2021', ['Perfect World']), true);
  });

  it('names a file the way Radarr reads it', () => {
    assert.equal(
      movieName({
        fileName: 'movie',
        packTitle: 'WWF Hardcore 2001 DVDRip x264-GROUP',
        title: 'WWF: Hardcore',
        year: 2001,
      }),
      'WWF: Hardcore (2001) DVDRip x264-GROUP'
    );
  });
});

/* ---------------------------- end to end ---------------------------- */

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

const INFO = {
  name: 'Harry Potter Collection',
  'piece length': 4194304,
  pieces: Buffer.alloc(20),
  files: [
    { length: 2 * GB, path: ['Harry.Potter.and.the.Philosophers.Stone.mkv'] },
    { length: 2 * GB, path: ['Harry.Potter.and.the.Chamber.of.Secrets.mkv'] },
  ],
};
const TORRENT = ben({ announce: 'udp://tracker', info: INFO });
const HASH = createHash('sha1').update(ben(INFO)).digest('hex');

const RELEASE: ProwlarrRelease = {
  guid: 'https://indexer/hp',
  title:
    'Harry Potter and the Chamber of Secrets Collection 1080p BluRay x264-GRP',
  size: 4 * GB,
  indexerId: 3,
  indexer: 'Knaben',
  protocol: 'torrent',
  seeders: 30,
  downloadUrl: 'http://prowlarr/3/download',
};

/**
 * Radarr's and Sonarr's own wanted lists, kept before any test stands in
 * for them: a method stood in for twice is not always put back as it was.
 */
const radarrWanted = BackfillRadarr.prototype.getWanted;
const sonarrWanted = BackfillSonarr.prototype.getWanted;

let movie: RadarrMovieDetail;
let imports: { path: string; movieId: number }[][] = [];
let priorities: { indexes: number[]; priority: number }[] = [];
let removed: string[] = [];
let done = false;
let searchedWith: number[] | undefined;
/** Whether qBittorrent holds the torrent. */
let inClient = false;

/** The torrent as qBittorrent has it. */
const heldTorrent = (savePath = '/downloads/backfill') => ({
  hash: HASH,
  name: INFO.name,
  state: done ? 'stoppedUP' : 'downloading',
  progress: done ? 1 : 0.5,
  size: 2 * GB,
  amount_left: done ? 0 : GB,
  eta: 60,
  dlspeed: 1000,
  save_path: savePath,
  content_path: `${savePath}/Harry Potter Collection`,
});

beforeEach(() => {
  movie = { ...SECRETS };
  imports = [];
  priorities = [];
  removed = [];
  done = false;
  searchedWith = undefined;
  const settings = getSettings();
  settings.backfill = {
    ...BACKFILL_DEFAULTS,
    enabled: true,
    prowlarr: {
      ...BACKFILL_DEFAULTS.prowlarr,
      hostname: 'prowlarr',
      apiKey: 'k',
    },
    torrentClientId: 1,
    includeMovies: true,
  };
  settings.sonarr = [];
  settings.radarr = [
    {
      id: 0,
      name: 'Radarr',
      hostname: 'radarr',
      port: 7878,
      apiKey: 'x',
      useSsl: false,
      is4k: false,
    } as unknown as RadarrSettings,
  ];
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

  mock.method(notificationManager, 'sendNotification', () => undefined);
  const radarr = BackfillRadarr.prototype;
  mock.method(radarr, 'getWanted', async (kind: string) => ({
    records: kind === 'missing' && !movie.hasFile ? [movie] : [],
    complete: true,
  }));
  mock.method(radarr, 'getMovieQueueCount', async () => 0);
  mock.method(radarr, 'getMovieDetail', async () => movie);
  mock.method(radarr, 'getMovieFile', async () => null);
  mock.method(radarr, 'getQualityProfile', async () => PROFILE);
  mock.method(radarr, 'parse', async (title: string) => parse(title));
  mock.method(radarr, 'getRootFoldersNow', async () => [
    { path: '/movies', freeSpace: 50 * 1024 * GB },
  ]);
  mock.method(radarr, 'getRemotePathMappings', async () => [
    { host: 'qbittorrent', remotePath: '/downloads/', localPath: '/data/' },
  ]);
  mock.method(
    radarr,
    'manualImport',
    async (list: { path: string; movieId: number }[]) => {
      imports.push(list.map((f) => ({ path: f.path, movieId: f.movieId })));
      return 31;
    }
  );
  mock.method(radarr, 'getCommand', async () => ({
    id: 31,
    name: 'ManualImport',
    status: 'completed',
  }));

  mock.method(
    ProwlarrAPI.prototype,
    'search',
    async (_query: string, options: { categories?: number[] }) => {
      searchedWith = options.categories;
      return [RELEASE];
    }
  );
  mock.method(ProwlarrAPI.prototype, 'fetchRelease', async () => ({
    kind: 'torrent',
    data: TORRENT,
  }));

  const qbit = QBittorrentAPI.prototype;
  inClient = false;
  mock.method(qbit, 'ensureCategory', async () => undefined);
  mock.method(qbit, 'addTorrent', async () => {
    inClient = true;
  });
  mock.method(qbit, 'getTorrent', async () =>
    inClient ? heldTorrent() : undefined
  );
  mock.method(qbit, 'getFiles', async () =>
    INFO.files.map((f, index) => ({
      index,
      name: [INFO.name, ...f.path].join('/'),
      size: f.length,
      progress: done && index === 1 ? 1 : 0,
      priority: index === 1 ? 1 : 0,
    }))
  );
  mock.method(
    qbit,
    'setFilePriority',
    async (_hash: string, indexes: number[], priority: number) => {
      priorities.push({ indexes: [...indexes].sort(), priority });
    }
  );
  mock.method(qbit, 'startTorrent', async () => undefined);
  mock.method(qbit, 'getCategoryTorrents', async () => []);
  mock.method(qbit, 'stopTorrent', async () => undefined);
  mock.method(qbit, 'deleteTorrent', async (hash: string) => {
    removed.push(hash);
    inClient = false;
  });
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

describe('Backfill for movies: from Radarr’s wanted list to the library', () => {
  it('finds a stuck movie in a collection, downloads only it, and imports it through Radarr', async () => {
    await backfill.scan();
    const row = await getRepository(BackfillSeries).findOneOrFail({
      where: { kind: 'movie', arrId: 55 },
    });
    assert.equal(row.status, 'found');
    assert.equal(row.missing, 1);
    assert.deepEqual(searchedWith, [2000, 5070], 'movie categories');

    const candidate = await getRepository(BackfillCandidate).findOneOrFail({
      where: { seriesId: row.id },
    });
    assert.equal(candidate.status, 'ready');
    assert.equal(candidate.summary?.fill, 1);
    assert.equal(candidate.summary?.sonarrSeesTitle, false);

    const job = await backfill.approve(candidate.id, { mode: 'missing' });
    const jobs = getRepository(BackfillJob);
    assert.equal(
      (await jobs.findOneOrFail({ where: { id: job.id } })).status,
      'downloading'
    );
    assert.deepEqual(priorities, [
      { indexes: [0], priority: 0 },
      { indexes: [1], priority: 1 },
    ]);

    done = true;
    await backfill.tick();
    assert.deepEqual(imports, [
      [
        {
          path: '/data/backfill/Harry Potter Collection/Harry.Potter.and.the.Chamber.of.Secrets.mkv',
          movieId: 55,
        },
      ],
    ]);

    movie = { ...movie, hasFile: true, movieFileId: 901 };
    await backfill.tick();
    const finished = await jobs.findOneOrFail({ where: { id: job.id } });
    assert.equal(finished.status, 'done');
    assert.equal(finished.imported, 1);
    assert.deepEqual(removed, [HASH]);
    assert.equal(
      (
        await getRepository(BackfillSeries).findOneOrFail({
          where: { id: row.id },
        })
      ).status,
      'done'
    );
  });

  it('replaces a stalled download with the next good pack, searching again, until none is left', async () => {
    getSettings().backfill = {
      ...getSettings().backfill,
      autoApprove: { enabled: false, minScore: -10_000, maxSizeGb: 100 },
    };
    // The same torrent again from another indexer, and another one.
    const mirror = {
      ...RELEASE,
      guid: 'https://other-indexer/hp',
      size: RELEASE.size + 1e8,
    };
    const second = {
      ...RELEASE,
      guid: 'https://indexer/hp-2',
      size: RELEASE.size + 2e8,
      seeders: 4,
    };
    const OTHER = ben({
      announce: 'udp://tracker',
      info: { ...INFO, name: 'Harry Potter Collection REPACK' },
    });
    mock.method(
      ProwlarrAPI.prototype,
      'fetchRelease',
      async (release: ProwlarrRelease) => ({
        kind: 'torrent',
        data: release.guid === second.guid ? OTHER : TORRENT,
      })
    );
    let found = [RELEASE];
    mock.method(ProwlarrAPI.prototype, 'search', async () => found);
    let now = Date.now();
    mock.timers.enable({ apis: ['Date'], now });
    const jobs = getRepository(BackfillJob);
    const candidates = getRepository(BackfillCandidate);
    const waitFor = async (what: () => Promise<boolean>) => {
      for (let i = 0; i < 100 && !(await what()); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      while (backfill.isSearching(row.id)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const stall = async () => {
      await backfill.tick();
      now += 13 * 60 * 60_000;
      mock.timers.setTime(now);
      await backfill.tick();
    };

    await backfill.scan();
    const row = await getRepository(BackfillSeries).findOneOrFail({
      where: { kind: 'movie', arrId: 55 },
    });
    const first = await backfill.approve(
      (await candidates.findOneOrFail({ where: { seriesId: row.id } })).id,
      { mode: 'missing' }
    );

    // The only pack found is dead: Prowlarr is asked again, and the new
    // one is downloaded on its own, though auto-approve is off.
    found = [RELEASE, mirror, second];
    await stall();
    await waitFor(async () => (await jobs.count()) === 2);
    const failed = await jobs.findOneOrFail({ where: { id: first.id } });
    assert.equal(failed.status, 'failed');
    assert.match(failed.log.at(-1)?.message ?? '', /Searching again/);
    const replacement = await jobs.findOneOrFail({
      where: { id: Not(first.id) },
    });
    assert.equal(replacement.status, 'downloading');
    assert.equal(
      replacement.approvedByName,
      'Backfill (replacing a failed download)'
    );
    assert.equal(
      (await candidates.findOneOrFail({ where: { guid: RELEASE.guid } }))
        .status,
      'dead'
    );

    // That one stalls too, and nothing else turns up: it stops there.
    await stall();
    await waitFor(
      async () =>
        (await jobs.findOneOrFail({ where: { id: replacement.id } })).status ===
        'failed'
    );
    assert.equal(await jobs.count(), 2);
    assert.deepEqual(
      (await candidates.find({ order: { id: 'ASC' } })).map((c) => c.status),
      ['dead', 'dead']
    );
    assert.equal(
      (
        await getRepository(BackfillSeries).findOneOrFail({
          where: { id: row.id },
        })
      ).status,
      'none'
    );
  });

  it('leaves a failed download for an admin when replacing is off, or after too many fail', async () => {
    getSettings().backfill = {
      ...getSettings().backfill,
      autoApprove: { enabled: false, minScore: -10_000, maxSizeGb: 100 },
      replaceFailed: false,
    };
    let searches = 0;
    mock.method(ProwlarrAPI.prototype, 'search', async () => {
      searches += 1;
      return [RELEASE];
    });
    let now = Date.now();
    mock.timers.enable({ apis: ['Date'], now });
    const later = async () => {
      await backfill.tick();
      now += 13 * 60 * 60_000;
      mock.timers.setTime(now);
      await backfill.tick();
    };
    await backfill.scan();
    const row = await getRepository(BackfillSeries).findOneOrFail({
      where: { kind: 'movie', arrId: 55 },
    });
    const candidate = await getRepository(BackfillCandidate).findOneOrFail({
      where: { seriesId: row.id },
    });
    const job = await backfill.approve(candidate.id, { mode: 'missing' });
    await later();
    const jobs = getRepository(BackfillJob);
    assert.equal(
      (await jobs.findOneOrFail({ where: { id: job.id } })).status,
      'failed'
    );
    assert.equal(searches, 1, 'not searched again');
    assert.equal(await jobs.count(), 1);

    // On, but this title has already failed six times today.
    getSettings().backfill = { ...getSettings().backfill, replaceFailed: true };
    await jobs.save(
      Array.from(
        { length: MAX_FAILED_PER_DAY - 1 },
        () =>
          new BackfillJob({
            ...job,
            id: undefined,
            status: 'failed',
            candidateId: null,
            finishedAt: new Date(),
          })
      )
    );
    const again = await getRepository(BackfillCandidate).save(
      new BackfillCandidate({
        ...candidate,
        id: undefined,
        guid: 'https://indexer/hp-3',
        status: 'ready',
      })
    );
    const last = await backfill.approve(again.id, { mode: 'missing' });
    await later();
    const held = await jobs.findOneOrFail({ where: { id: last.id } });
    assert.equal(held.status, 'failed');
    assert.match(
      held.log.map((l) => l.message).join('\n'),
      /7 downloads for this title failed in the last day/
    );
    assert.equal(searches, 1);
    assert.equal(await jobs.count(), MAX_FAILED_PER_DAY + 1);
  });

  it('counts a movie Radarr never searched for as stuck, once it has been there a day', async () => {
    const hour = 60 * 60 * 1000;
    movie = {
      ...SECRETS,
      lastSearchTime: undefined,
      added: new Date(Date.now() - hour).toISOString(),
    };
    await backfill.scan();
    assert.equal(
      await getRepository(BackfillSeries).count(),
      0,
      'just added: Radarr may still search'
    );

    movie = { ...movie, added: new Date(Date.now() - 48 * hour).toISOString() };
    await backfill.scan();
    const row = await getRepository(BackfillSeries).findOneOrFail({
      where: { kind: 'movie', arrId: 55 },
    });
    assert.equal(row.status, 'found');
  });

  describe('searching everything stuck', () => {
    const several = (count: number) => {
      const movies = Array.from({ length: count }, (_, i) => ({
        ...SECRETS,
        id: 55 + i,
        tmdbId: 700 + i,
        title: `Film ${i}`,
      }));
      mock.method(
        BackfillRadarr.prototype,
        'getWanted',
        async (kind: string) => ({
          records: kind === 'missing' ? movies : [],
          complete: true,
        })
      );
    };
    const repo = () => getRepository(BackfillSeries);

    it('searches each stuck title once, then leaves them for a day', async () => {
      several(3);
      const searched: number[] = [];
      mock.method(backfill, 'search', async (id: number) => {
        searched.push(id);
        await repo().update(id, { status: 'none', lastSearchedAt: new Date() });
      });
      await backfill.startSearchAll(undefined, { pauseMs: 0 });
      assert.equal(searched.length, 3);
      assert.equal(new Set(searched).size, 3);
      assert.deepEqual(
        { ...backfill.searchAllStatus().last, startedAt: 0, finishedAt: 0 },
        { total: 3, done: 3, found: 0, startedAt: 0, finishedAt: 0 }
      );
      assert.equal(backfill.searchAllStatus().running, null);

      await backfill.startSearchAll(undefined, { pauseMs: 0 });
      assert.equal(searched.length, 3, 'nothing searched twice in a day');
    });

    it('stops after the title being searched when told to', async () => {
      several(3);
      const searched: number[] = [];
      mock.method(backfill, 'search', async (id: number) => {
        searched.push(id);
        backfill.stopSearchAll();
      });
      await backfill.startSearchAll(undefined, { pauseMs: 60_000 });
      assert.equal(searched.length, 1);
      assert.equal(backfill.searchAllStatus().last?.stoppedBecause, 'Stopped.');
    });

    it('gives up when Prowlarr is not answering, rather than trying every title', async () => {
      several(5);
      const searched: number[] = [];
      mock.method(backfill, 'search', async (id: number) => {
        searched.push(id);
        await repo().update(id, {
          searchError: 'Prowlarr: connect ECONNREFUSED',
          lastSearchedAt: new Date(),
        });
      });
      await backfill.startSearchAll(undefined, { pauseMs: 0 });
      assert.equal(searched.length, 3);
      assert.match(
        backfill.searchAllStatus().last?.stoppedBecause ?? '',
        /Prowlarr/
      );
    });

    it('searches the rest when one title’s search fails', async () => {
      several(3);
      const searched: number[] = [];
      mock.method(backfill, 'search', async (id: number) => {
        searched.push(id);
        // As a real search does: the failure is recorded, then thrown.
        if (searched.length === 1) {
          await repo().update(id, {
            searchError: 'Radarr answered 500',
            lastSearchedAt: new Date(),
          });
          throw new Error('Radarr answered 500');
        }
        await repo().update(id, { status: 'none', lastSearchedAt: new Date() });
      });
      await backfill.startSearchAll(undefined, { pauseMs: 0 });
      assert.equal(searched.length, 3);
      assert.equal(backfill.searchAllStatus().last?.done, 3);
      assert.equal(backfill.searchAllStatus().last?.stoppedBecause, undefined);
    });

    it('refuses to start twice at once', async () => {
      several(2);
      let release!: () => void;
      mock.method(
        backfill,
        'search',
        () => new Promise<void>((resolve) => (release = resolve))
      );
      const first = backfill.startSearchAll(undefined, { pauseMs: 0 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.throws(
        () => backfill.startSearchAll(undefined, { pauseMs: 0 }),
        /already being searched/
      );
      backfill.stopSearchAll();
      release();
      await first;
    });
  });

  it('keeps a movie and a series with the same id apart', async () => {
    const repo = getRepository(BackfillSeries);
    await repo.save(
      new BackfillSeries({ kind: 'series', serverId: 0, arrId: 55, title: 'S' })
    );
    const followed = await backfill.track('movie', 0, 55);
    assert.equal(followed.kind, 'movie');
    assert.equal(await repo.count(), 2);
  });

  it('leaves movies alone when they are turned off, even ones it follows', async () => {
    await getRepository(BackfillSeries).save(
      new BackfillSeries({
        kind: 'movie',
        serverId: 0,
        arrId: 55,
        title: SECRETS.title,
        status: 'stuck',
      })
    );
    getSettings().backfill = {
      ...getSettings().backfill,
      includeMovies: false,
    };
    await backfill.scan();
    assert.equal(await getRepository(BackfillSeries).count(), 1);
    assert.equal(searchedWith, undefined, 'nothing was searched');
  });

  it('refuses an approval once Radarr has the movie after all', async () => {
    await backfill.scan();
    const candidate = await getRepository(BackfillCandidate).findOneOrFail({
      where: { status: 'ready' },
    });
    movie = { ...movie, hasFile: true, movieFileId: 777 };
    await assert.rejects(
      backfill.approve(candidate.id, { mode: 'missing' }),
      /Radarr has a file for this now/
    );
    assert.equal(await getRepository(BackfillJob).count(), 0);
  });

  it('keeps searching when Radarr’s wanted list cannot be read', async () => {
    mock.method(BackfillRadarr.prototype, 'getWanted', async () => {
      throw new Error('connect ECONNREFUSED');
    });
    await getRepository(BackfillSeries).save(
      new BackfillSeries({
        kind: 'movie',
        serverId: 0,
        arrId: 55,
        title: SECRETS.title,
        status: 'stuck',
      })
    );
    await backfill.scan();
    assert.deepEqual(searchedWith, [2000, 5070], 'the due search still ran');
  });
});

describe('Backfill: searching for what a series is missing', () => {
  it('searches the missing season by number and opens what names the episode first', async () => {
    getSettings().sonarr = [
      {
        id: 0,
        name: 'Sonarr',
        hostname: 'sonarr',
        port: 8989,
        apiKey: 'x',
        useSsl: false,
      } as unknown as SonarrSettings,
    ];
    const sonarr = BackfillSonarr.prototype;
    mock.method(sonarr, 'getSeriesDetail', async () => ({
      id: 891,
      title: 'Expedition Unknown',
      year: 2015,
      tvdbId: 280316,
      seriesType: 'standard',
      qualityProfileId: 6,
      path: '/tv/Expedition Unknown',
    }));
    mock.method(sonarr, 'getSeriesEpisodes', async () => [
      {
        id: 7,
        seriesId: 891,
        seasonNumber: 17,
        episodeNumber: 7,
        hasFile: false,
        monitored: true,
        episodeFileId: 0,
        airDateUtc: '2026-09-01T00:00:00Z',
      },
    ]);
    mock.method(sonarr, 'getEpisodeFiles', async () => []);
    mock.method(sonarr, 'getQualityProfile', async () => PROFILE);
    mock.method(sonarr, 'parse', async (title: string) => ({ title }));
    const queries: string[] = [];
    mock.method(ProwlarrAPI.prototype, 'search', async (query: string) => {
      queries.push(query);
      return [
        {
          ...RELEASE,
          guid: 'old-pack',
          title: 'Expedition Unknown Season 4 Complete 720p HDTV x264',
          seeders: 90,
        },
        {
          ...RELEASE,
          guid: 'the-episode',
          title:
            'Expedition.Unknown.2018.S17E07.1080p.WEB-DL.DDP2.0.H.264-FUZEER',
          seeders: 2,
        },
      ];
    });
    const opened: string[] = [];
    mock.method(
      ProwlarrAPI.prototype,
      'fetchRelease',
      async (release: ProwlarrRelease) => {
        opened.push(release.guid);
        throw new Error('not needed');
      }
    );
    const row = await getRepository(BackfillSeries).save(
      new BackfillSeries({
        kind: 'series',
        serverId: 0,
        arrId: 891,
        title: 'Expedition Unknown',
        status: 'stuck',
      })
    );
    await backfill.search(row.id);
    assert.deepEqual(queries, ['Expedition Unknown', 'Expedition Unknown S17']);
    assert.equal(opened[0], 'the-episode');
  });
});

describe('Backfill when something goes wrong', () => {
  const jobs = () => getRepository(BackfillJob);
  const candidates = () => getRepository(BackfillCandidate);
  const titles = () => getRepository(BackfillSeries);
  const jobNow = (id: number) => jobs().findOneOrFail({ where: { id } });
  const logOf = (job: BackfillJob) => job.log.map((l) => l.message).join('\n');
  /** The movie found by a scan, and its pack approved. */
  const approved = async () => {
    await backfill.scan();
    const candidate = await candidates().findOneOrFail({
      where: { status: 'ready' },
    });
    const job = await backfill.approve(candidate.id, { mode: 'missing' });
    return { candidate, job };
  };
  const unreachable = () =>
    new AxiosError('connect ECONNREFUSED 10.0.0.2:8080', 'ECONNREFUSED');
  /** qBittorrent listing Backfill's category: the torrent, while it has it. */
  const listsCategory = () =>
    mock.method(QBittorrentAPI.prototype, 'getCategoryTorrents', async () =>
      inClient ? [{ hash: HASH, progress: done ? 1 : 0, added_on: 1 }] : []
    );
  const IMPORTED = [
    [
      {
        path: '/data/backfill/Harry Potter Collection/Harry.Potter.and.the.Chamber.of.Secrets.mkv',
        movieId: 55,
      },
    ],
  ];

  it('waits out qBittorrent and Radarr not answering, however long, and carries on', async () => {
    const { candidate, job } = await approved();
    const qbitDown = mock.method(
      QBittorrentAPI.prototype,
      'getTorrent',
      async () => {
        throw unreachable();
      }
    );
    for (let i = 0; i < 15; i++) await backfill.tick();
    const waiting = await jobNow(job.id);
    assert.equal(waiting.status, 'downloading', logOf(waiting));
    assert.deepEqual(removed, [], 'the download is kept');
    assert.equal(
      waiting.log.filter((l) =>
        l.message.endsWith('did not answer; trying again each minute')
      ).length,
      1,
      'said once, not every minute'
    );
    assert.equal(
      (await candidates().findOneOrFail({ where: { id: candidate.id } }))
        .status,
      'approved'
    );
    qbitDown.mock.restore();

    done = true;
    await backfill.tick();
    assert.equal((await jobNow(job.id)).status, 'importing');
    // Radarr's own calls wrap what went wrong.
    const radarrDown = mock.method(
      BackfillRadarr.prototype,
      'getCommand',
      async () => {
        throw new Error('[Radarr] Failed to read the command', {
          cause: unreachable(),
        });
      }
    );
    for (let i = 0; i < 12; i++) await backfill.tick();
    assert.equal((await jobNow(job.id)).status, 'importing');
    radarrDown.mock.restore();

    movie = { ...movie, hasFile: true, movieFileId: 901 };
    await backfill.tick();
    const finished = await jobNow(job.id);
    assert.equal(finished.status, 'done', logOf(finished));
    assert.deepEqual(removed, [HASH]);
  });

  it('gives up on a finished download it cannot hand over, keeping it and offering the pack again', async () => {
    const { candidate, job } = await approved();
    done = true;
    const mappings = mock.method(
      BackfillRadarr.prototype,
      'getRemotePathMappings',
      async () => {
        throw new Error('Radarr: the remote path mapping is wrong');
      }
    );
    for (let i = 0; i < 10; i++) await backfill.tick();
    const failed = await jobNow(job.id);
    assert.equal(failed.status, 'failed', logOf(failed));
    assert.deepEqual(removed, [], 'the files it fetched are kept');
    assert.match(logOf(failed), /Kept the download/);
    assert.equal(
      (await candidates().findOneOrFail({ where: { id: candidate.id } }))
        .status,
      'ready',
      'nothing was wrong with the release'
    );
    assert.equal(
      (await titles().findOneOrFail({ where: { id: candidate.seriesId } }))
        .status,
      'found'
    );

    // Put right, and approved again: the torrent kept is taken on.
    mappings.mock.restore();
    listsCategory();
    const adds = mock.method(
      QBittorrentAPI.prototype,
      'addTorrent',
      async () => undefined
    );
    const again = await backfill.approve(candidate.id, { mode: 'missing' });
    const taken = await jobNow(again.id);
    assert.equal(taken.status, 'downloading', logOf(taken));
    assert.equal(adds.mock.callCount(), 0, 'not fetched again');
    await backfill.tick();
    assert.deepEqual(imports, IMPORTED);
  });

  it('keeps an unfinished download, stopped, when it gives up for something other than the release', async () => {
    const { candidate, job } = await approved();
    mock.method(QBittorrentAPI.prototype, 'getTorrent', async () =>
      inClient ? { ...heldTorrent(), state: 'missingFiles' } : undefined
    );
    const stops = mock.method(
      QBittorrentAPI.prototype,
      'stopTorrent',
      async () => undefined
    );
    for (let i = 0; i < 10; i++) await backfill.tick();
    const failed = await jobNow(job.id);
    assert.equal(failed.status, 'failed', logOf(failed));
    assert.deepEqual(removed, [], 'what it fetched is kept');
    assert.equal(stops.mock.callCount(), 1, 'stopped in qBittorrent');
    assert.equal(
      (await candidates().findOneOrFail({ where: { id: candidate.id } }))
        .status,
      'ready'
    );
  });

  it('takes on a torrent qBittorrent added though its answer was lost', async () => {
    await backfill.scan();
    const candidate = await candidates().findOneOrFail({
      where: { status: 'ready' },
    });
    mock.method(QBittorrentAPI.prototype, 'addTorrent', async () => {
      inClient = true;
      throw new Error('socket hang up');
    });
    listsCategory();
    const job = await backfill.approve(candidate.id, { mode: 'missing' });
    assert.equal((await jobNow(job.id)).status, 'queued');
    await backfill.tick();
    const started = await jobNow(job.id);
    assert.equal(started.status, 'downloading', logOf(started));
    assert.equal(started.downloadId, HASH);
    assert.deepEqual(priorities.at(-1), { indexes: [1], priority: 1 });
  });

  it('finds the chosen file in a client that numbers padding files, as rTorrent does', async () => {
    const listed = [
      { name: `${INFO.name}/${INFO.files[0].path[0]}`, size: 2 * GB },
      { name: `${INFO.name}/.pad/1048576`, size: 1048576 },
      { name: `${INFO.name}/${INFO.files[1].path[0]}`, size: 2 * GB },
    ];
    mock.method(QBittorrentAPI.prototype, 'getFiles', async () =>
      listed.map((file, index) => ({
        index,
        ...file,
        progress: done && index === 2 ? 1 : 0,
        priority: index === 2 ? 1 : 0,
      }))
    );
    const { job } = await approved();
    const started = await jobNow(job.id);
    assert.equal(started.status, 'downloading', logOf(started));
    assert.deepEqual(priorities, [
      { indexes: [0, 1], priority: 0 },
      { indexes: [2], priority: 1 },
    ]);
    done = true;
    await backfill.tick();
    assert.deepEqual(imports, IMPORTED);
  });

  it('hands Radarr a Windows client’s path with Radarr’s own separators', async () => {
    mock.method(QBittorrentAPI.prototype, 'getTorrent', async () =>
      inClient ? heldTorrent('D:\\Downloads\\backfill') : undefined
    );
    mock.method(BackfillRadarr.prototype, 'getRemotePathMappings', async () => [
      {
        host: 'qbittorrent',
        remotePath: 'D:\\Downloads\\',
        localPath: '/data/',
      },
    ]);
    await approved();
    done = true;
    await backfill.tick();
    assert.deepEqual(imports, IMPORTED);
  });

  it('starts one download when a pack is approved twice at once', async () => {
    await backfill.scan();
    const candidate = await candidates().findOneOrFail({
      where: { status: 'ready' },
    });
    const results = await Promise.allSettled([
      backfill.approve(candidate.id, { mode: 'missing' }),
      backfill.approve(candidate.id, { mode: 'missing' }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [
      'fulfilled',
      'rejected',
    ]);
    assert.equal(await jobs().count(), 1);
  });

  it('keeps a pause made while the minute’s tick is under way', async () => {
    const { job } = await approved();
    let reached!: () => void;
    let release!: () => void;
    const inTick = new Promise<void>((resolve) => (reached = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    mock.method(QBittorrentAPI.prototype, 'getTorrent', async () => {
      reached();
      await held;
      return heldTorrent();
    });
    const ticking = backfill.tick();
    await inTick;
    // Paused while the tick has the job in hand, before it saves it.
    const pausing = backfill.pause(job.id);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    release();
    await Promise.all([ticking, pausing]);
    assert.equal((await jobNow(job.id)).status, 'paused');
  });

  it('never lets the minute’s tick fail outright', async () => {
    await approved();
    mock.method(QBittorrentAPI.prototype, 'getTorrent', async () => {
      throw new Error('qBittorrent answered nonsense');
    });
    const repo = jobs();
    const saves = mock.method(repo, 'save', async () => {
      throw new Error('database is locked');
    });
    await assert.doesNotReject(backfill.tick());
    saves.mock.restore();
    mock.method(repo, 'find', async () => {
      throw new Error('database is locked');
    });
    await assert.doesNotReject(backfill.tick());
  });

  it('cancelling a scan stops that scan, and no search after it', async () => {
    const row = await titles().save(
      new BackfillSeries({
        kind: 'movie',
        serverId: 0,
        arrId: 55,
        title: SECRETS.title,
        status: 'stuck',
      })
    );
    mock.method(BackfillRadarr.prototype, 'getWanted', async () => {
      backfill.cancel();
      return { records: [movie], complete: true };
    });
    await backfill.scan();
    assert.equal(
      searchedWith,
      undefined,
      'the cancelled scan searched nothing'
    );

    await backfill.search(row.id);
    assert.equal(
      (await titles().findOneOrFail({ where: { id: row.id } })).status,
      'found'
    );
    assert.equal(await candidates().count({ where: { status: 'ready' } }), 1);
  });

  it('leaves what changed while a scan ran: an approval, an admin’s search terms', async () => {
    const wanted = await titles().save(
      new BackfillSeries({
        kind: 'movie',
        serverId: 0,
        arrId: 55,
        title: SECRETS.title,
        status: 'found',
        lastSearchedAt: new Date(),
      })
    );
    const gone = await titles().save(
      new BackfillSeries({
        kind: 'movie',
        serverId: 0,
        arrId: 56,
        title: 'Harry Potter and the Goblet of Fire',
        status: 'found',
        lastSearchedAt: new Date(),
      })
    );
    const repo = titles();
    const find = repo.find.bind(repo);
    mock.method(repo, 'find', async (...args: Parameters<typeof find>) => {
      const rows = await find(...args);
      // Read by the scan; then both are approved, and a search term added.
      if (
        (args[0]?.where as { serverId?: number } | undefined)?.serverId === 0
      ) {
        await repo.update(wanted.id, {
          status: 'downloading',
          searchTerms: ['Chamber of Secrets'],
        });
        await repo.update(gone.id, { status: 'downloading' });
      }
      return rows;
    });
    await backfill.scan();
    const kept = await repo.findOneOrFail({ where: { id: wanted.id } });
    assert.equal(kept.status, 'downloading');
    assert.deepEqual(kept.searchTerms, ['Chamber of Secrets']);
    assert.equal(kept.missing, 1, 'what the scan read is still saved');
    assert.equal(
      (await repo.findOneOrFail({ where: { id: gone.id } })).status,
      'downloading'
    );
  });

  it('searches again a title left mid-search when Seerr stopped', async () => {
    const row = await titles().save(
      new BackfillSeries({
        kind: 'movie',
        serverId: 0,
        arrId: 55,
        title: SECRETS.title,
        status: 'searching',
      })
    );
    await backfill.scan();
    assert.deepEqual(searchedWith, [2000, 5070]);
    assert.equal(
      (await titles().findOneOrFail({ where: { id: row.id } })).status,
      'found'
    );
  });

  it('shows a title left mid-search as stuck, and resets it at startup', async () => {
    const row = await titles().save(
      new BackfillSeries({
        kind: 'movie',
        serverId: 0,
        arrId: 57,
        title: SECRETS.title,
        status: 'searching',
      })
    );
    assert.equal(backfill.isSearching(row.id), false);
    assert.equal(backfill.statusOf(row), 'stuck', 'nothing is searching');
    await backfill.unstickSearches();
    assert.equal(
      (await titles().findOneOrFail({ where: { id: row.id } })).status,
      'stuck'
    );
    assert.equal(backfill.statusOf({ id: row.id, status: 'found' }), 'found');
  });

  it('takes nothing for done when Radarr’s wanted list was too long to read whole', async () => {
    const row = await titles().save(
      new BackfillSeries({
        kind: 'movie',
        serverId: 0,
        arrId: 56,
        title: 'Harry Potter and the Goblet of Fire',
        status: 'found',
        missing: 1,
        lastSearchedAt: new Date(),
      })
    );
    mock.method(BackfillRadarr.prototype, 'getWanted', async () => ({
      records: [],
      complete: false,
    }));
    await backfill.scan();
    assert.equal(
      (await titles().findOneOrFail({ where: { id: row.id } })).status,
      'found',
      'not in the part read, so still missing'
    );
  });

  it('says when a wanted list was cut short', async () => {
    const server = getSettings().radarr[0];
    const pages: number[] = [];
    const answer = async (
      _url: string,
      options: { params: { page: number } }
    ) => {
      pages.push(options.params.page);
      return {
        data: {
          totalRecords: 50_000,
          records: Array.from({ length: 250 }, () => movie),
        },
      };
    };
    const radarr = BackfillRadarr.forServer(server);
    mock.method(
      (radarr as unknown as { axios: { get: typeof answer } }).axios,
      'get',
      answer
    );
    assert.equal((await radarrWanted.call(radarr, 'missing')).complete, false);
    assert.equal(pages.length, 40);

    const sonarr = BackfillSonarr.forServer(
      server as unknown as SonarrSettings
    );
    mock.method(
      (sonarr as unknown as { axios: { get: typeof answer } }).axios,
      'get',
      answer
    );
    assert.equal((await sonarrWanted.call(sonarr, 'missing')).complete, false);

    const few = async () => ({
      data: { totalRecords: 2, records: [movie, movie] },
    });
    mock.method(
      (radarr as unknown as { axios: { get: typeof few } }).axios,
      'get',
      few
    );
    assert.equal((await radarrWanted.call(radarr, 'missing')).complete, true);
  });

  it('searches the rest of a scan’s titles when one fails, and stops when Prowlarr does not answer', async () => {
    const films = Array.from({ length: 5 }, (_, i) => ({
      ...SECRETS,
      id: 55 + i,
      tmdbId: 700 + i,
      title: `Film ${i}`,
    }));
    mock.method(
      BackfillRadarr.prototype,
      'getWanted',
      async (kind: string) => ({
        records: kind === 'missing' ? films : [],
        complete: true,
      })
    );
    getSettings().backfill = {
      ...getSettings().backfill,
      searchesPerScan: 5,
    };
    let details = 0;
    mock.method(
      BackfillRadarr.prototype,
      'getMovieDetail',
      async (id: number) => {
        details += 1;
        if (details === 1) throw new Error('Radarr answered 500');
        return films.find((f) => f.id === id)!;
      }
    );
    await backfill.scan();
    const rows = await titles().find();
    assert.equal(rows.filter((r) => r.lastSearchedAt).length, 5);
    assert.equal(rows.filter((r) => r.searchError).length, 1);

    // Prowlarr down: three in a row fail, and the scan stops there.
    mock.method(ProwlarrAPI.prototype, 'search', async () => {
      throw unreachable();
    });
    await titles().update(
      { kind: 'movie' },
      { lastSearchedAt: null, searchError: null }
    );
    await backfill.scan();
    assert.equal(
      (await titles().find()).filter((r) => r.searchError).length,
      3
    );
  });
});
