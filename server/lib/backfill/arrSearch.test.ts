import QBittorrentAPI from '@server/api/downloadclients/qbittorrent';
import type { ProwlarrRelease } from '@server/api/prowlarr';
import ProwlarrAPI from '@server/api/prowlarr';
import { getRepository } from '@server/datasource';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import BackfillSeries from '@server/entity/BackfillSeries';
import type { OwnArrSearch } from '@server/lib/backfill/arrSearch';
import {
  CLOCK_SKEW_MS,
  EPISODES_ONE_BY_ONE,
  MAX_OWN_SEARCHES,
  MAX_SERIES_SEARCHES,
  OWN_SEARCH_GRACE_MS,
  arrIndexer,
  arrRelease,
  closeOwnSearch,
  isOwnArrSearch,
  openOwnSearch,
  seriesSearches,
} from '@server/lib/backfill/arrSearch';
import backfill, { SourceWatch } from '@server/lib/backfill/engine';
import { indexerLimits } from '@server/lib/backfill/indexerLimit';
import type {
  ArrSearchRelease,
  SonarrEpisode,
  SonarrQualityProfile,
  SonarrWantedRecord,
} from '@server/lib/backfill/sonarr';
import BackfillSonarr, {
  RELEASE_SEARCH_TIMEOUT_MS,
} from '@server/lib/backfill/sonarr';
import notificationManager from '@server/lib/notifications';
import type { BackfillSearchWith, SonarrSettings } from '@server/lib/settings';
import { BACKFILL_DEFAULTS, getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { AxiosError, AxiosHeaders } from 'axios';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

setupTestDb();

/*
 * Backfill searching through the title's own Sonarr instead of, or as well
 * as, Prowlarr. Sonarr, Prowlarr and qBittorrent are stubbed at their API
 * clients; Sonarr's release answers have the shape of its /api/v3/release.
 */

const GB = 1024 ** 3;
const DAY = 24 * 60 * 60_000;

const ep = (
  id: number,
  seasonNumber: number,
  episodeNumber: number,
  hasFile = false
): SonarrEpisode => ({
  id,
  seriesId: 400,
  seasonNumber,
  episodeNumber,
  hasFile,
  monitored: true,
  episodeFileId: hasFile ? id + 1000 : 0,
  airDateUtc: '2025-03-01T00:00:00Z',
});

describe('Backfill’s searches through Sonarr: which', () => {
  const missing = (season: number, count: number, from = 1) =>
    Array.from({ length: count }, (_, i) =>
      ep(season * 100 + from + i, season, from + i)
    );

  it('searches a season missing several as a season, and one missing a few episode by episode', () => {
    assert.equal(EPISODES_ONE_BY_ONE, 2);
    assert.deepEqual(seriesSearches([...missing(1, 5), ...missing(2, 1)]), [
      { season: 1 },
      { season: 2, episode: 1, episodeId: 201 },
    ]);
    assert.deepEqual(seriesSearches(missing(3, 2, 4)), [
      { season: 3, episode: 4, episodeId: 304 },
      { season: 3, episode: 5, episodeId: 305 },
    ]);
  });

  it('keeps to a few searches, the seasons missing most first', () => {
    const searches = seriesSearches([
      ...missing(2, 1),
      ...missing(3, 2),
      ...missing(1, 5),
      ...missing(4, 3),
    ]);
    assert.equal(searches.length, MAX_SERIES_SEARCHES);
    assert.deepEqual(searches, [
      { season: 1 },
      { season: 4 },
      { season: 3, episode: 1, episodeId: 301 },
      { season: 3, episode: 2, episodeId: 302 },
    ]);
  });

  it('searches specials one by one, and seasons only below the cutoff last', () => {
    assert.deepEqual(
      seriesSearches([...missing(0, 3), ...missing(1, 1)], [2, 1]),
      [
        { season: 1, episode: 1, episodeId: 101 },
        { season: 0, episode: 1, episodeId: 1 },
        { season: 0, episode: 2, episodeId: 2 },
        { season: 0, episode: 3, episodeId: 3 },
      ]
    );
    assert.deepEqual(seriesSearches([], [3, 2, 3]), [
      { season: 2 },
      { season: 3 },
    ]);
  });

  it('reads an *arr’s result as a release Backfill can open, and skips what it cannot use', () => {
    const result: ArrSearchRelease = {
      guid: 'sonarr-guid',
      title: 'Harbour.Lights.S01.1080p.WEB-DL-GRP',
      indexerId: 12,
      indexer: 'Knaben (Prowlarr)',
      protocol: 'torrent',
      size: 3 * GB,
      seeders: 40,
      downloadUrl: 'http://prowlarr:9696/3/download?link=x',
      infoHash: 'ABCDEF',
      publishDate: '2026-01-01T00:00:00Z',
      approved: false,
      rejections: ['Not wanted in profile'],
      mappedEpisodeNumbers: [1, 2],
    };
    assert.deepEqual(arrRelease(result), {
      guid: 'sonarr-guid',
      title: 'Harbour.Lights.S01.1080p.WEB-DL-GRP',
      size: 3 * GB,
      indexerId: 12,
      indexer: 'Knaben',
      protocol: 'torrent',
      seeders: 40,
      downloadUrl: 'http://prowlarr:9696/3/download?link=x',
      magnetUrl: undefined,
      infoHash: 'ABCDEF',
      publishDate: '2026-01-01T00:00:00Z',
    });
    assert.equal(arrRelease({ ...result, protocol: 'unknown' }), null);
  });

  it('names an *arr server for its search limit', () => {
    assert.deepEqual(arrIndexer('Sonarr', { name: 'Sonarr' }), {
      name: 'Sonarr',
    });
    assert.deepEqual(arrIndexer('Sonarr', { name: '4K' }), {
      name: 'Sonarr 4K',
    });
    assert.deepEqual(arrIndexer('Radarr', { name: 'Main radarr' }), {
      name: 'Main radarr',
    });
  });

  it('tells Backfill’s own stamps from the *arr’s, with a minute of clock skew', () => {
    const from = '2026-03-01T10:00:00.000Z';
    const to = '2026-03-01T10:03:00.000Z';
    const own = [{ from, to, searches: 2 }];
    const at = (base: string, ms: number) =>
      new Date(Date.parse(base) + ms).toISOString();
    assert.equal(isOwnArrSearch(own, '2026-03-01T10:02:00Z'), true);
    // The *arr's clock a little behind Seerr's, or ahead.
    assert.equal(isOwnArrSearch(own, at(from, -59_000)), true);
    assert.equal(isOwnArrSearch(own, at(from, -61_000)), false);
    assert.equal(
      isOwnArrSearch(own, at(to, CLOCK_SKEW_MS + OWN_SEARCH_GRACE_MS)),
      true,
      'a search Backfill stopped waiting for, stamped when it ended'
    );
    assert.equal(
      isOwnArrSearch(own, at(to, CLOCK_SKEW_MS + OWN_SEARCH_GRACE_MS + 1000)),
      false
    );
    assert.equal(isOwnArrSearch(null, '2026-03-01T10:01:00Z'), false);
    assert.equal(isOwnArrSearch(own, undefined), false);
  });

  it('keeps a window open while its searches run, as long as they could take', () => {
    const from = '2026-03-01T10:00:00.000Z';
    const open = [{ from, to: null, searches: 2 }];
    const at = (ms: number) => new Date(Date.parse(from) + ms).toISOString();
    const now = Date.parse(from) + 60 * 60_000;
    // Two searches of at most RELEASE_SEARCH_TIMEOUT_MS each.
    const longest = 2 * RELEASE_SEARCH_TIMEOUT_MS;
    assert.equal(isOwnArrSearch(open, at(longest), now), true);
    assert.equal(
      isOwnArrSearch(
        open,
        at(longest + CLOCK_SKEW_MS + OWN_SEARCH_GRACE_MS + 1000),
        now
      ),
      false,
      'left open by a restart, it still ends'
    );
    // Still running: open until now, with the same leeway.
    const running = Date.parse(at(60_000));
    assert.equal(
      isOwnArrSearch(
        open,
        at(60_000 + CLOCK_SKEW_MS + OWN_SEARCH_GRACE_MS),
        running
      ),
      true
    );
    assert.equal(
      isOwnArrSearch(
        open,
        at(60_000 + CLOCK_SKEW_MS + OWN_SEARCH_GRACE_MS + 1000),
        running
      ),
      false
    );
  });

  it('keeps the last few windows, and closes the right one', () => {
    let own: OwnArrSearch[] = [];
    for (let i = 0; i < MAX_OWN_SEARCHES + 2; i++) {
      own = openOwnSearch(own, { from: `f${i}`, to: null, searches: 1 });
    }
    assert.equal(own.length, MAX_OWN_SEARCHES);
    assert.equal(own[0].from, 'f2');
    own = closeOwnSearch(own, 'f4', 't4');
    assert.deepEqual(
      own.map((w) => w.to),
      [null, null, 't4', null, null]
    );
  });
});

describe('Backfill’s searches: when a run stops using a source, or stops', () => {
  it('leaves out a source failing three titles in a row while another answers', () => {
    const watch = new SourceWatch();
    const both = (failed: string[]) =>
      watch.note({ searched: ['Prowlarr', 'Sonarr'], failed });
    assert.equal(both(['Prowlarr']), false);
    assert.equal(both(['Prowlarr']), false);
    assert.equal(watch.leftOut.size, 0);
    assert.equal(both(['Prowlarr']), false);
    assert.match(
      watch.leftOut.get('Prowlarr') ?? '',
      /^Prowlarr failed for 3 titles in a row/
    );
    assert.equal(watch.leftOut.has('Sonarr'), false);
  });

  it('stops once every source failed for three titles in a row, whichever', () => {
    const watch = new SourceWatch();
    assert.equal(
      watch.note({ searched: ['Sonarr'], failed: ['Sonarr'] }),
      false
    );
    assert.equal(
      watch.note({
        searched: ['Prowlarr', 'Radarr'],
        failed: ['Prowlarr', 'Radarr'],
      }),
      false
    );
    // One answering starts the count again; nothing searched leaves it be.
    assert.equal(watch.note({ searched: ['Sonarr'], failed: [] }), false);
    assert.equal(watch.note({ searched: [], failed: [] }), false);
    assert.equal(watch.note(undefined), false);
    assert.equal(
      watch.note({ searched: ['Sonarr'], failed: ['Sonarr'] }),
      false
    );
    assert.equal(
      watch.note({ searched: ['Sonarr'], failed: ['Sonarr'] }),
      false
    );
    assert.equal(
      watch.note({ searched: ['Sonarr'], failed: ['Sonarr'] }),
      true
    );
  });
});

// ---- the engine --------------------------------------------------------------

const PROFILE: SonarrQualityProfile = {
  id: 6,
  name: 'HD',
  upgradeAllowed: true,
  cutoff: 3,
  items: [{ quality: { id: 3, name: 'WEBDL-1080p' }, allowed: true }],
  minFormatScore: 0,
  cutoffFormatScore: 0,
};

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
  name: 'Harbour.Lights.S01.1080p.WEB-DL-GRP',
  'piece length': 4194304,
  pieces: Buffer.alloc(20),
  files: [1, 2, 3].map((n) => ({
    length: GB,
    path: [`Harbour.Lights.S01E0${n}.1080p.WEB-DL-GRP.mkv`],
  })),
};
const TORRENT = ben({ announce: 'udp://tracker', info: INFO });
const HASH = createHash('sha1').update(ben(INFO)).digest('hex');

/** Season 1's pack, as Sonarr's search answers it. */
const PACK: ArrSearchRelease = {
  guid: 'https://knaben/harbour-lights-s01',
  title: 'Harbour.Lights.S01.1080p.WEB-DL-GRP',
  indexerId: 12,
  indexer: 'Knaben (Prowlarr)',
  protocol: 'torrent',
  size: 3 * GB,
  seeders: 25,
  downloadUrl: 'http://prowlarr:9696/3/download?link=pack',
  fullSeason: true,
  seasonNumber: 1,
  approved: false,
  rejections: ['Not an upgrade'],
};

/** Prowlarr's copy of the same pack. */
const PROWLARR_PACK: ProwlarrRelease = {
  guid: 'https://prowlarr/3/harbour-lights-s01',
  title: 'Harbour.Lights.S01.1080p.WEB-DL-GRP',
  size: 3 * GB,
  indexerId: 3,
  indexer: 'Knaben',
  protocol: 'torrent',
  seeders: 30,
  downloadUrl: 'http://prowlarr:9696/3/download?link=pack',
};

const EPISODES = [ep(401, 1, 1), ep(402, 1, 2), ep(403, 1, 3)];

let releaseCalls: unknown[] = [];
let prowlarrQueries: string[] = [];
let sonarrAnswer: () => Promise<ArrSearchRelease[]> = async () => [PACK];
let prowlarrAnswer: () => Promise<ProwlarrRelease[]> = async () => [];
let wanted: SonarrWantedRecord[] = [];

const setUp = (searchWith: BackfillSearchWith, withProwlarr = true) => {
  getSettings().backfill = {
    ...BACKFILL_DEFAULTS,
    enabled: true,
    searchWith,
    prowlarr: withProwlarr
      ? { ...BACKFILL_DEFAULTS.prowlarr, hostname: 'prowlarr', apiKey: 'k' }
      : BACKFILL_DEFAULTS.prowlarr,
    torrentClientId: 1,
    includeMovies: false,
    includeMusic: false,
  };
};

beforeEach(() => {
  indexerLimits.reset();
  releaseCalls = [];
  prowlarrQueries = [];
  sonarrAnswer = async () => [PACK];
  prowlarrAnswer = async () => [];
  wanted = [];
  setUp('arrs', false);
  const settings = getSettings();
  settings.radarr = [];
  settings.lidarr = [];
  settings.sonarr = [
    {
      id: 0,
      name: 'Sonarr',
      hostname: 'sonarr',
      port: 8989,
      apiKey: 'x',
      useSsl: false,
    } as unknown as SonarrSettings,
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
  const sonarr = BackfillSonarr.prototype;
  mock.method(sonarr, 'getSeriesDetail', async () => ({
    id: 400,
    title: 'Harbour Lights',
    year: 2025,
    tvdbId: 9400,
    seriesType: 'standard',
    qualityProfileId: 6,
    path: '/tv/Harbour Lights',
  }));
  mock.method(sonarr, 'getSeriesEpisodes', async () => EPISODES);
  mock.method(sonarr, 'getEpisodeFiles', async () => []);
  mock.method(sonarr, 'getQualityProfile', async () => PROFILE);
  mock.method(sonarr, 'getQualityDefinitions', async () => []);
  mock.method(sonarr, 'getSeriesQueueCount', async () => 0);
  mock.method(sonarr, 'getWanted', async (kind: string) => ({
    records: kind === 'missing' ? wanted : [],
    complete: true,
  }));
  mock.method(sonarr, 'parse', async (title: string) => {
    const n = title.match(/S01E0(\d)/)?.[1];
    const episode = n ? EPISODES[Number(n) - 1] : undefined;
    return {
      title,
      parsedEpisodeInfo: {
        seriesTitle: 'Harbour Lights',
        quality: {
          quality: { id: 3, name: 'WEBDL-1080p' },
          revision: { version: 1, real: 0 },
        },
        seasonNumber: 1,
        episodeNumbers: episode ? [episode.episodeNumber] : [],
        fullSeason: !episode,
        releaseGroup: 'GRP',
      },
      series: { id: 400, title: 'Harbour Lights' },
      episodes: episode ? [episode] : [],
    };
  });
  mock.method(sonarr, 'getReleases', async (params: unknown) => {
    releaseCalls.push(params);
    return sonarrAnswer();
  });
  mock.method(ProwlarrAPI.prototype, 'search', async (query: string) => {
    prowlarrQueries.push(query);
    return prowlarrAnswer();
  });
  mock.method(ProwlarrAPI.prototype, 'fetchRelease', async () => ({
    kind: 'torrent',
    data: TORRENT,
  }));
  mock.method(QBittorrentAPI.prototype, 'getCategoryTorrents', async () => []);
});

afterEach(() => {
  mock.restoreAll();
  indexerLimits.reset();
});

const track = (over: Partial<BackfillSeries> = {}) =>
  getRepository(BackfillSeries).save(
    new BackfillSeries({
      kind: 'series',
      serverId: 0,
      arrId: 400,
      title: 'Harbour Lights',
      seriesType: 'standard',
      status: 'stuck',
      missing: 3,
      searchTerms: [],
      ...over,
    })
  );

const candidatesOf = (seriesId: number) =>
  getRepository(BackfillCandidate).find({ where: { seriesId } });

const answered = (status: number) =>
  new AxiosError(
    `Request failed with status code ${status}`,
    'ERR_BAD_RESPONSE',
    { headers: new AxiosHeaders(), url: 'http://sonarr:8989/api/v3/release' },
    undefined,
    {
      status,
      statusText: '',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: undefined,
    }
  );

describe('Backfill: whether it can search, by where it searches', () => {
  it('needs Prowlarr only when it searches with Prowlarr', () => {
    setUp('arrs', false);
    assert.equal(backfill.readiness().ready, true);
    assert.equal(backfill.readiness().searchWith, 'arrs');

    setUp('prowlarr', false);
    assert.equal(backfill.readiness().ready, false);
    assert.equal(
      backfill.readiness().problem,
      'Prowlarr is not set up in Settings → Services.'
    );

    setUp('both', false);
    assert.equal(backfill.readiness().ready, false);
    assert.match(backfill.readiness().problem ?? '', /Prowlarr too/);

    for (const searchWith of ['prowlarr', 'arrs', 'both'] as const) {
      setUp(searchWith, true);
      assert.equal(backfill.readiness().ready, true, searchWith);
    }
  });
});

describe('Backfill searching through Sonarr', () => {
  it('searches the missing season through Sonarr alone, and plans the pack it returns', async () => {
    const row = await track();
    await backfill.search(row.id);

    assert.deepEqual(releaseCalls, [{ seriesId: 400, seasonNumber: 1 }]);
    assert.deepEqual(prowlarrQueries, [], 'Prowlarr is not asked');
    const after = await getRepository(BackfillSeries).findOneOrFail({
      where: { id: row.id },
    });
    assert.equal(after.status, 'found');
    assert.equal(after.searchError, null);
    assert.ok(after.ownArrSearch, 'its own search through Sonarr is kept');

    const [candidate] = await candidatesOf(row.id);
    assert.equal(candidate.guid, PACK.guid);
    assert.equal(candidate.indexer, 'Knaben');
    assert.equal(candidate.infoHash, HASH);
    assert.equal(candidate.status, 'ready');
    assert.equal(candidate.summary?.fill, 3);
    assert.deepEqual(
      candidate.plan
        .filter((e) => e.action === 'fill')
        .map((e) => e.episodeIds),
      [[401], [402], [403]]
    );
  });

  it('searches episode by episode when a season misses only a few', async () => {
    mock.method(BackfillSonarr.prototype, 'getSeriesEpisodes', async () => [
      ep(401, 1, 1),
      ep(402, 1, 2, true),
      ep(403, 1, 3, true),
      ep(501, 2, 1),
    ]);
    sonarrAnswer = async () => [];
    const row = await track();
    await backfill.search(row.id);
    assert.deepEqual(releaseCalls, [{ episodeId: 401 }, { episodeId: 501 }]);
  });

  it('searches both and keeps one copy of a release both found, the better-seeded', async () => {
    setUp('both');
    prowlarrAnswer = async () => [
      PROWLARR_PACK,
      {
        ...PROWLARR_PACK,
        guid: 'https://prowlarr/9/other',
        title: 'Harbour.Lights.S01.720p.HDTV-OTHER',
        size: 2 * GB,
        seeders: 3,
      },
    ];
    // Sonarr's copy has fewer seeders; a release only Sonarr found is kept.
    sonarrAnswer = async () => [
      { ...PACK, seeders: 10 },
      {
        ...PACK,
        guid: 'https://knaben/harbour-lights-s01-x265',
        title: 'Harbour.Lights.S01.1080p.WEB-DL.x265-ELSE',
        size: 2.5 * GB,
      },
    ];
    const row = await track();
    await backfill.search(row.id);

    assert.ok(prowlarrQueries.length > 0);
    assert.equal(releaseCalls.length, 1);
    const guids = (await candidatesOf(row.id)).map((c) => c.guid).sort();
    assert.deepEqual(guids, [
      'https://knaben/harbour-lights-s01-x265',
      'https://prowlarr/3/harbour-lights-s01',
      'https://prowlarr/9/other',
    ]);
  });

  it('keeps Sonarr’s results when Prowlarr fails, and says so', async () => {
    setUp('both');
    prowlarrAnswer = async () => {
      throw new Error('Prowlarr timed out');
    };
    const row = await track();
    await backfill.search(row.id);
    const after = await getRepository(BackfillSeries).findOneOrFail({
      where: { id: row.id },
    });
    assert.equal(after.status, 'found');
    assert.match(
      after.searchError ?? '',
      /^Harbour Lights: Prowlarr timed out/
    );
    assert.equal((await candidatesOf(row.id)).length, 1);
  });

  it('keeps Prowlarr’s results when Sonarr fails, and says which search', async () => {
    setUp('both');
    prowlarrAnswer = async () => [PROWLARR_PACK];
    sonarrAnswer = async () => {
      throw new Error('Sonarr took too long');
    };
    const row = await track();
    await backfill.search(row.id);
    const after = await getRepository(BackfillSeries).findOneOrFail({
      where: { id: row.id },
    });
    assert.equal(after.status, 'found');
    assert.equal(after.searchError, 'Sonarr, S01: Sonarr took too long');
  });

  it('names each source that failed when none answered', async () => {
    setUp('both');
    prowlarrAnswer = async () => {
      throw new Error('Prowlarr timed out');
    };
    sonarrAnswer = async () => {
      throw new Error('Sonarr took too long');
    };
    const row = await track();
    await assert.rejects(
      backfill.search(row.id),
      /^Error: Prowlarr: Harbour Lights: Prowlarr timed out; Sonarr: S01: Sonarr took too long$/
    );
    const after = await getRepository(BackfillSeries).findOneOrFail({
      where: { id: row.id },
    });
    assert.equal(after.status, 'stuck');
    assert.match(after.searchError ?? '', /^Prowlarr: .*; Sonarr: S01: /);

    // Through Sonarr alone, only Sonarr is named.
    setUp('arrs', false);
    await assert.rejects(
      backfill.search(row.id),
      /^Error: Sonarr: S01: Sonarr took too long$/
    );
  });

  it('holds Sonarr’s searches to the indexer limits, and leaves it alone while it waits', async () => {
    mock.method(BackfillSonarr.prototype, 'getSeriesEpisodes', async () => [
      ...EPISODES,
      ep(501, 2, 1),
      ep(502, 2, 2),
      ep(503, 2, 3),
    ]);
    sonarrAnswer = async () => {
      throw answered(429);
    };
    const row = await track();
    await assert.rejects(
      backfill.search(row.id),
      /Sonarr has reached its search limit/
    );
    assert.equal(releaseCalls.length, 1, 'the second season is not searched');
    assert.ok(indexerLimits.waiting({ name: 'Sonarr' }));

    // Waiting out the limit: Sonarr isn't asked at all.
    await assert.rejects(
      backfill.search(row.id),
      /Sonarr has reached its search limit/
    );
    assert.equal(releaseCalls.length, 1);
  });
});

describe('Backfill’s own searches through Sonarr and stuck titles', () => {
  const record = (
    episode: SonarrEpisode,
    lastSearchTime?: string
  ): SonarrWantedRecord => ({
    id: episode.id,
    seriesId: 400,
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber,
    airDateUtc: episode.airDateUtc,
    monitored: true,
    lastSearchTime,
    series: {
      id: 400,
      title: 'Harbour Lights',
      tvdbId: 9400,
      seriesType: 'standard',
      monitored: true,
      added: '2025-01-01T00:00:00Z',
    },
  });

  it('does not take Backfill’s own search for Sonarr’s', async () => {
    const sonarrSearched = new Date(Date.now() - 3 * DAY);
    const row = await track({ lastArrSearchAt: sonarrSearched });
    await backfill.search(row.id);

    // Sonarr stamps the episodes Backfill's search covered with its time.
    const stamped = new Date().toISOString();
    wanted = EPISODES.map((e) => record(e, stamped));
    await backfill.scan({ searches: false });
    let after = await getRepository(BackfillSeries).findOneOrFail({
      where: { id: row.id },
    });
    assert.equal(
      after.lastArrSearchAt?.getTime(),
      sonarrSearched.getTime(),
      'still Sonarr’s own last search'
    );

    // A search of Sonarr's own later on counts again.
    const later = new Date(
      Date.now() + CLOCK_SKEW_MS + OWN_SEARCH_GRACE_MS + 60_000
    );
    wanted = [record(EPISODES[0], later.toISOString())];
    await backfill.scan({ searches: false });
    after = await getRepository(BackfillSeries).findOneOrFail({
      where: { id: row.id },
    });
    assert.equal(after.lastArrSearchAt?.getTime(), later.getTime());
  });

  it('shows no search of Sonarr’s when the only stamps are Backfill’s', async () => {
    const now = Date.now();
    const row = await track({
      ownArrSearch: [
        {
          from: new Date(now - 60_000).toISOString(),
          to: new Date(now).toISOString(),
          searches: 1,
        },
      ],
      lastArrSearchAt: null,
    });
    wanted = [record(EPISODES[0], new Date(now - 30_000).toISOString())];
    await backfill.scan({ searches: false });
    const after = await getRepository(BackfillSeries).findOneOrFail({
      where: { id: row.id },
    });
    assert.equal(after.lastArrSearchAt, null);
    assert.equal(after.missing, 1);
  });
});

/** Sonarr's wanted record for an episode, stamped when last searched. */
const wantedRecord = (
  episode: SonarrEpisode,
  lastSearchTime?: string
): SonarrWantedRecord => ({
  id: episode.id,
  seriesId: 400,
  seasonNumber: episode.seasonNumber,
  episodeNumber: episode.episodeNumber,
  airDateUtc: episode.airDateUtc,
  monitored: true,
  lastSearchTime,
  series: {
    id: 400,
    title: 'Harbour Lights',
    tvdbId: 9400,
    seriesType: 'standard',
    monitored: true,
    added: '2025-01-01T00:00:00Z',
  },
});

const seriesRow = (id: number) =>
  getRepository(BackfillSeries).findOneOrFail({ where: { id } });

describe('Backfill’s own searches through Sonarr while a scan reads it', () => {
  it('knows Sonarr’s stamps for its own from before the first search answers', async () => {
    const sonarrSearched = new Date(Date.now() - 3 * DAY);
    const row = await track({ lastArrSearchAt: sonarrSearched });
    let during: OwnArrSearch[] | null = null;
    sonarrAnswer = async () => {
      during = (await seriesRow(row.id)).ownArrSearch;
      // Sonarr stamps the episodes, and a scan reads them, before
      // Backfill's searches are over.
      wanted = EPISODES.map((e) => wantedRecord(e, new Date().toISOString()));
      await backfill.scan({ searches: false });
      return [PACK];
    };
    await backfill.search(row.id);

    assert.equal(during!.length, 1);
    assert.deepEqual(
      [during![0].to, during![0].searches],
      [null, 1],
      'open while searching'
    );
    const after = await seriesRow(row.id);
    assert.equal(after.lastArrSearchAt?.getTime(), sonarrSearched.getTime());
    assert.ok(after.ownArrSearch?.[0].to, 'closed once answered');
  });

  it('drops a last search known from before that was itself Backfill’s', async () => {
    const now = Date.now();
    const row = await track({
      ownArrSearch: [
        {
          from: new Date(now - 10 * 60_000).toISOString(),
          to: new Date(now - 9 * 60_000).toISOString(),
          searches: 1,
        },
      ],
      // Read by a scan that took Backfill's stamp for Sonarr's.
      lastArrSearchAt: new Date(now - 9.5 * 60_000),
    });
    wanted = [
      wantedRecord(EPISODES[0], new Date(now - 9.5 * 60_000).toISOString()),
    ];
    await backfill.scan({ searches: false });
    assert.equal((await seriesRow(row.id)).lastArrSearchAt, null);
  });

  it('never moves Sonarr’s last search back because of Backfill’s stamps', async () => {
    const now = Date.now();
    const known = new Date(now - DAY);
    const row = await track({
      ownArrSearch: [
        {
          from: new Date(now - 60_000).toISOString(),
          to: new Date(now).toISOString(),
          searches: 1,
        },
      ],
      lastArrSearchAt: known,
    });
    // Backfill's stamp hides Sonarr's day-old one; another episode still
    // has an older one of Sonarr's.
    wanted = [
      wantedRecord(EPISODES[0], new Date(now - 30_000).toISOString()),
      wantedRecord(EPISODES[1], new Date(now - 3 * DAY).toISOString()),
    ];
    await backfill.scan({ searches: false });
    assert.equal(
      (await seriesRow(row.id)).lastArrSearchAt?.getTime(),
      known.getTime()
    );

    // A later search of Sonarr's own moves it on.
    const later = new Date(now + CLOCK_SKEW_MS + OWN_SEARCH_GRACE_MS + 60_000);
    wanted = [wantedRecord(EPISODES[1], later.toISOString())];
    await backfill.scan({ searches: false });
    assert.equal(
      (await seriesRow(row.id)).lastArrSearchAt?.getTime(),
      later.getTime()
    );
  });
});

describe('A run of searches when a source stops answering', () => {
  const down = () =>
    new AxiosError('connect ECONNREFUSED sonarr:8989', 'ECONNREFUSED', {
      headers: new AxiosHeaders(),
      url: 'http://sonarr:8989/api/v3/release',
    });

  /** Five stuck series a scan will search, all through one Sonarr. */
  const fiveStuck = async () => {
    // A wanted list cut short leaves tracked titles as they are.
    mock.method(BackfillSonarr.prototype, 'getWanted', async () => ({
      records: [],
      complete: false,
    }));
    getSettings().backfill = {
      ...getSettings().backfill,
      searchesPerScan: 5,
    };
    for (let i = 0; i < 5; i++) {
      await track({ arrId: 400 + i, title: `Harbour Lights ${i}` });
    }
  };

  it('stops a scan once Sonarr failed three titles in a row', async () => {
    await fiveStuck();
    sonarrAnswer = async () => {
      throw down();
    };
    await backfill.scan();
    assert.equal(releaseCalls.length, 3);
    const rows = await getRepository(BackfillSeries).find();
    assert.equal(rows.filter((r) => r.searchError).length, 3);
  });

  it('stops a scan once Sonarr can’t even be read, three titles in a row', async () => {
    await fiveStuck();
    let reads = 0;
    mock.method(BackfillSonarr.prototype, 'getSeriesDetail', async () => {
      reads += 1;
      throw down();
    });
    await backfill.scan();
    assert.equal(reads, 3);
  });

  it('leaves Prowlarr out of the rest of a scan after it fails three in a row while Sonarr answers', async () => {
    setUp('both');
    await fiveStuck();
    prowlarrAnswer = async () => {
      throw new Error('Prowlarr timed out');
    };
    await backfill.scan();
    // Two searches a title (its name, and its season), three titles.
    assert.equal(prowlarrQueries.length, 6);
    assert.equal(releaseCalls.length, 5, 'Sonarr searched every title');
    const rows = await getRepository(BackfillSeries).find({
      order: { id: 'ASC' },
    });
    assert.deepEqual(
      rows.map((r) => r.status),
      ['found', 'found', 'found', 'found', 'found']
    );
    assert.match(
      rows[4].searchError ?? '',
      /^Prowlarr failed for 3 titles in a row, so it is left out for the rest of this run$/
    );
  });

  it('stops Search All once every source failed three titles in a row', async () => {
    setUp('both');
    await fiveStuck();
    prowlarrAnswer = async () => {
      throw new Error('Prowlarr timed out');
    };
    sonarrAnswer = async () => {
      throw down();
    };
    await backfill.startSearchAll(undefined, { pauseMs: 0 });
    const last = backfill.searchAllStatus().last;
    assert.equal(last?.done, 3);
    assert.match(
      last?.stoppedBecause ?? '',
      /^Stopped: Prowlarr: .*; Sonarr: S01: /
    );
  });
});

describe('A release skipped from one source', () => {
  it('isn’t offered again when the other finds it under another guid', async () => {
    const row = await track();
    await getRepository(BackfillCandidate).save(
      new BackfillCandidate({
        seriesId: row.id,
        guid: PROWLARR_PACK.guid,
        title: PROWLARR_PACK.title,
        indexer: 'Knaben',
        indexerId: 3,
        protocol: 'torrent',
        size: PROWLARR_PACK.size,
        status: 'skipped',
        plan: [],
      })
    );
    // Sonarr's copy: another guid and no hash, the same name and size.
    await backfill.search(row.id);
    const offered = (await candidatesOf(row.id)).filter(
      (c) => c.status !== 'skipped'
    );
    assert.deepEqual(offered, []);
    assert.equal((await seriesRow(row.id)).status, 'none');
  });
});

describe('Fetching a release found through an *arr without Prowlarr', () => {
  it('opens a magnet link with no Prowlarr set up', async () => {
    mock.restoreAll();
    const api = new ProwlarrAPI({ ...BACKFILL_DEFAULTS.prowlarr });
    const magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=Harbour.Lights.S01`;
    assert.deepEqual(
      await api.fetchRelease({ ...PROWLARR_PACK, downloadUrl: magnet }),
      { kind: 'magnet', uri: magnet }
    );
    // A local link that no *arr's indexer has is still refused, not sent
    // Prowlarr's (empty) key.
    await assert.rejects(
      api.fetchRelease(
        { ...PROWLARR_PACK, downloadUrl: 'http://127.0.0.1:9/x.torrent' },
        { indexerOrigins: async () => new Set<string>() }
      ),
      /is a local address/
    );
  });
});
