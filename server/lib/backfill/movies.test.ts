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

let movie: RadarrMovieDetail;
let imports: { path: string; movieId: number }[][] = [];
let priorities: { indexes: number[]; priority: number }[] = [];
let removed: string[] = [];
let done = false;
let searchedWith: number[] | undefined;

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
  mock.method(radarr, 'getWanted', async (kind: string) =>
    kind === 'missing' && !movie.hasFile ? [movie] : []
  );
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
  let added = false;
  mock.method(qbit, 'ensureCategory', async () => undefined);
  mock.method(qbit, 'addTorrent', async () => {
    added = true;
  });
  mock.method(qbit, 'getTorrent', async () =>
    added
      ? {
          hash: HASH,
          name: INFO.name,
          state: done ? 'stoppedUP' : 'downloading',
          progress: done ? 1 : 0.5,
          size: 2 * GB,
          amount_left: done ? 0 : GB,
          eta: 60,
          dlspeed: 1000,
          save_path: '/downloads/backfill',
          content_path: '/downloads/backfill/Harry Potter Collection',
        }
      : undefined
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
    added = false;
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
        async (kind: string) => (kind === 'missing' ? movies : [])
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
