import QBittorrentAPI from '@server/api/downloadclients/qbittorrent';
import { getRepository } from '@server/datasource';
import DownloadCheck from '@server/entity/DownloadCheck';
import downloadCheck from '@server/lib/downloadCheck';
import type {
  CheckServer,
  Grab,
  HeldFile,
  ImportCandidate,
  ImportFile,
  ItemFacts,
  QueueEpisode,
  Removal,
} from '@server/lib/downloadCheck/arr';
import { grabsOf } from '@server/lib/downloadCheck/arr';
import {
  judgeName,
  readEpisodeRelease,
  readMovieRelease,
} from '@server/lib/downloadCheck/names';
import {
  checkFiles,
  hoursBeforeAir,
  importProblemOf,
  isUpgrade,
  planImport,
  ranksOf,
} from '@server/lib/downloadCheck/rules';
import type {
  DownloadClientSettings,
  RadarrSettings,
  SonarrSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * Download Check against a stand-in Sonarr and Radarr: the rules on real
 * release names and real messages from a live server's history, and the
 * engine recording, acting and holding back as its mode says.
 */

setupTestDb();

const MB = 1024 * 1024;
const HOUR = 3600_000;

const WEB1080 = {
  quality: { id: 3, name: 'WEBDL-1080p' },
  revision: { version: 1, real: 0 },
};
const WEB720 = {
  quality: { id: 5, name: 'WEBDL-720p' },
  revision: { version: 1, real: 0 },
};
const PROFILE = {
  items: [
    { quality: { id: 4, name: 'HDTV-720p' }, allowed: true },
    { quality: { id: 5, name: 'WEBDL-720p' }, allowed: true },
    { quality: { id: 3, name: 'WEBDL-1080p' }, allowed: true },
  ],
};

describe('reading release names', () => {
  it('finds the title, year, country and episode title', () => {
    assert.deepEqual(
      readEpisodeRelease(
        'Wayfarer.Ledger.2018.S02E05.The.Real.Copper.Fox.1080p.DSCP.WEB-DL.DDP2.0.H.264-FIZZLR'
      ),
      {
        title: 'wayfarer ledger',
        year: 2018,
        country: undefined,
        episodeTitle: 'the real copper fox',
        hasEpisode: true,
      }
    );
    const wall = readEpisodeRelease('The.Turnstile.AU.S01E01.WEB-DL.x264-QXO');
    assert.equal(wall.title, 'the turnstile');
    assert.equal(wall.country, 'au');
    // "Us" is a word here, not the United States.
    const bramble = readEpisodeRelease(
      'Bramble.&amp;.Finch-Trick.Us.S02E04.Ladle.of.the.Evening.1080p.Netflix.WEB-DL.DD+.2.0.x264-GoblinHD'
    );
    assert.equal(bramble.title, 'bramble and finch trick us');
    assert.equal(bramble.country, undefined);
    assert.equal(bramble.episodeTitle, 'ladle of the evening');
    const club = readEpisodeRelease(
      'The 9 Society (2024) S01E02 (1080p AMZN WEB-DL H265 SDR DDP 5.1 English - KILN)'
    );
    assert.equal(club.title, 'the 9 society');
    assert.equal(club.year, 2024);
    assert.equal(club.episodeTitle, undefined);
    assert.equal(
      readEpisodeRelease(
        '[Dusk] Kitchen Clash! The Fourth Course - S04E07 (BDRip)'
      ).title,
      'kitchen clash the fourth course'
    );
  });

  it('reads a movie title up to its year', () => {
    const driftwood = readMovieRelease('2087.A.Tidal.Voyage.1968.1080p.BluRay');
    assert.equal(driftwood.title, '2087 a tidal voyage');
    assert.equal(driftwood.year, 1968);
    assert.equal(readMovieRelease('Scorch (1995) 2160p UHD').title, 'scorch');
  });
});

describe('telling the right title from another', () => {
  const snackKingdom = { title: 'Snack Kingdom', year: 2007 };

  it('takes the right show under another name', () => {
    assert.equal(
      judgeName(
        readEpisodeRelease(
          'Bramble.&amp;.Finch-Trick.Us.S02E04.Ladle.of.the.Evening.1080p.Netflix.WEB-DL-GoblinHD'
        ),
        { title: 'Bramble & Finch: Trick Us', year: 2011 },
        [{ id: 1, title: 'Ladle of the Evening' }]
      ).verdict,
      'same'
    );
    assert.deepEqual(
      judgeName(
        readEpisodeRelease(
          'The.Turnstile.S02E02.Theo.and.Mira.720p.NBC.WEB-DL-KXR'
        ),
        { title: 'The Turnstile (2016)', year: 2016 },
        [{ id: 1, title: 'Theo and Mira' }]
      ).verdict,
      'same'
    );
  });

  it('turns down another country’s version, a revival and a spin-off’s numbering', () => {
    const wall = judgeName(
      readEpisodeRelease('The.Turnstile.AU.S01E03.1080p.WEB.H264-PLWK'),
      {
        title: 'The Turnstile (2016)',
        year: 2016,
        alternateTitles: [{ title: 'The Turnstile US' }],
      },
      [{ id: 1, title: 'Gus and Ivy' }]
    );
    assert.deepEqual([wall.verdict, wall.reason], ['different', 'country']);

    const gurneys = judgeName(
      readEpisodeRelease('Gurneys.2026.S02E04.1080p.HEVC.x265-LeSigh'),
      { title: 'Gurneys', year: 2001 },
      [{ id: 1, title: 'My Loud Pager' }]
    );
    assert.deepEqual([gurneys.verdict, gurneys.reason], ['different', 'year']);

    // Another episode altogether, and no other episode has its title.
    const bramble = judgeName(
      readEpisodeRelease(
        'Bramble.&amp;.Finch-Trick.Us.S01E04.Steady.Tadpole.1080p.Netflix.WEB-DL-GoblinHD'
      ),
      { title: 'Bramble & Finch: Trick Us', year: 2011 },
      [{ id: 1, title: 'Finch Is a Featherbrain' }],
      [
        {
          id: 1,
          seasonNumber: 1,
          episodeNumber: 4,
          title: 'Finch Is a Featherbrain',
          hasFile: false,
        },
      ]
    );
    assert.deepEqual(
      [bramble.verdict, bramble.reason],
      ['different', 'episodeTitle']
    );
  });

  it('finds an episode numbered another way by its title', () => {
    const evidence = judgeName(
      readEpisodeRelease(
        'Snack.Kingdom.2013.S09E11.Pretzel.Champions.720p.HMAX.WEB-DL.DDP2.0.H.264-FIZZLR'
      ),
      snackKingdom,
      [{ id: 911, title: 'Waffle Kingdom 2' }],
      [
        {
          id: 911,
          seasonNumber: 9,
          episodeNumber: 11,
          title: 'Waffle Kingdom 2',
          hasFile: false,
        },
        {
          id: 1403,
          seasonNumber: 14,
          episodeNumber: 3,
          title: 'Pretzel Champions',
          hasFile: true,
        },
        {
          id: 1404,
          seasonNumber: 14,
          episodeNumber: 4,
          title: 'Spice Jamboree!',
          hasFile: true,
        },
      ]
    );
    assert.equal(evidence.verdict, 'renumbered');
    assert.equal(evidence.episode?.id, 1403);
  });

  it('keeps numbers apart: Taco Kingdom 2 is not Taco Kingdom 3', () => {
    const evidence = judgeName(
      readEpisodeRelease(
        'Snack.Kingdom.2013.S01E13.Taco.Kingdom.3.720p.HMAX.WEB-DL-FIZZLR'
      ),
      snackKingdom,
      [{ id: 113, title: 'Taco Kingdom 2' }],
      [
        {
          id: 113,
          seasonNumber: 1,
          episodeNumber: 13,
          title: 'Taco Kingdom 2',
          hasFile: true,
        },
        {
          id: 705,
          seasonNumber: 7,
          episodeNumber: 5,
          title: 'Taco Kingdom 3',
          hasFile: false,
        },
      ]
    );
    assert.equal(evidence.verdict, 'renumbered');
    assert.equal(evidence.episode?.id, 705);
  });

  it('leaves what the name can’t settle for an admin', () => {
    assert.equal(
      judgeName(
        readEpisodeRelease(
          'The.Schemers.Fresh.Blood.S01E05.720p.WEB.H264-iNTRePiD'
        ),
        { title: 'The Schemers (US)', year: 2023 },
        [{ id: 1, title: 'Walking Away With Jewels' }]
      ).verdict,
      'unsure'
    );
    assert.equal(
      judgeName(
        readEpisodeRelease('Hold.You.Next.S01E05.1080p.WEB.h264-MABEL'),
        { title: "Hold Tight You're Live", year: 2006 },
        [{ id: 1, title: 'Dorian Pike, Wendell Marsh' }]
      ).verdict,
      'unsure'
    );
  });

  it('judges a movie by its title and year', () => {
    const movie = { title: 'Scorch', year: 1995 };
    assert.equal(
      judgeName(readMovieRelease('Scorch.1995.1080p.BluRay'), movie).verdict,
      'same'
    );
    assert.equal(
      judgeName(readMovieRelease('Scorch.2013.1080p.WEB'), movie).verdict,
      'different'
    );
  });
});

describe('the rules', () => {
  it('reads a torrent’s files', () => {
    assert.deepEqual(
      checkFiles([
        { name: 'Show.S01E03/Show.S01E03.mkv', size: 900 * MB },
        { name: 'Show.S01E03/Codec.Setup.exe', size: 2 * MB },
      ]),
      { code: 'program', files: ['Codec.Setup.exe'] }
    );
    assert.equal(
      checkFiles([
        { name: 'a.rar', size: 50 * MB },
        { name: 'a.r00', size: 50 * MB },
      ])?.code,
      'archive'
    );
    assert.equal(
      checkFiles([{ name: 'readme.txt', size: 10 }])?.code,
      'noVideo'
    );
    assert.equal(
      checkFiles([{ name: 'sample.mkv', size: 20 * MB }])?.code,
      'sample'
    );
    assert.equal(
      checkFiles([
        { name: 'Show.mkv', size: 900 * MB },
        { name: 'Show.nfo', size: 1000 },
      ]),
      undefined
    );
  });

  it('says a grab came days before its episode aired', () => {
    const grabbed = Date.parse('2026-10-14T12:00:00Z');
    assert.equal(hoursBeforeAir(grabbed, ['2026-10-21T01:00:00Z']), 157);
    // Hours early is a real episode turning up early.
    assert.equal(hoursBeforeAir(grabbed, ['2026-10-14T20:00:00Z']), undefined);
    assert.equal(hoursBeforeAir(grabbed, [undefined]), undefined);
  });

  it('compares a grab with the file there as the import does', () => {
    const ranks = ranksOf(PROFILE);
    assert.equal(
      isUpgrade(ranks, { quality: WEB1080 }, { quality: WEB720 }).upgrade,
      false
    );
    assert.equal(
      isUpgrade(ranks, { quality: WEB720 }, { quality: WEB1080 }).upgrade,
      true
    );
    // The same quality scoring lower on custom formats: refused.
    const lower = isUpgrade(
      ranks,
      { quality: WEB1080, customFormatScore: 860006 },
      { quality: WEB1080, customFormatScore: -137399 }
    );
    assert.deepEqual(lower, {
      upgrade: false,
      why: 'score',
      have: 'WEBDL-1080p (860006)',
      offered: 'WEBDL-1080p (-137399)',
    });
    // The same score is let through, as Sonarr lets it through.
    assert.equal(
      isUpgrade(
        ranks,
        { quality: WEB1080, customFormatScore: 10 },
        { quality: WEB1080, customFormatScore: 10 }
      ).upgrade,
      true
    );
    // An older revision of the same quality.
    assert.equal(
      isUpgrade(
        ranks,
        { quality: { ...WEB1080, revision: { version: 2, real: 0 } } },
        { quality: WEB1080 }
      ).upgrade,
      false
    );
  });

  it('knows every reason a live server gave for a stuck import', () => {
    const seen: [string, string][] = [
      [
        'Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible. See the FAQ for details.',
        'byId',
      ],
      [
        'Found matching movie via grab history, but release was matched to movie by ID. Manual Import required.',
        'byId',
      ],
      [
        'Episode file on disk contains more episodes than this file contains',
        'moreEpisodes',
      ],
      [
        'Not a Custom Format upgrade for existing episode file(s). New: [x264] (-137399) do not improve on Existing: [x264] (860006)',
        'notUpgrade',
      ],
      [
        'Not an upgrade for existing episode file(s). Existing quality: HDTV720p. New Quality HDTV720p.',
        'notUpgrade',
      ],
      [
        'This show has individual episode mappings on TheXEM but the mapping for this episode has not been confirmed yet by their administrators. TheXEM needs manual input.',
        'xem',
      ],
      [
        'Episode 1x2 was not found in the grabbed release: Truthtesters.S01E02',
        'badFiles',
      ],
      [
        'Episode 1x3 was unexpected considering the Truthtesters.S01E02.1080p folder name',
        'badFiles',
      ],
      [
        'One or more episodes expected in this release were not imported or missing from the release',
        'partial',
      ],
      [
        'One or more movies expected in this release were not imported or missing',
        'partial',
      ],
      ['Found archive file, might need to be extracted', 'badFiles'],
      ['Sample', 'badFiles'],
      [
        'No files found are eligible for import in /data/usenet/completed/tv/Show.S01',
        'badFiles',
      ],
      ['Unable to determine if file is a sample', 'sampleUnsure'],
      ['Unable to parse file', 'unparsed'],
      [
        'Episode file already imported at 10/12/2026 4:02:11 PM',
        'alreadyImported',
      ],
      [
        'Single episode file contains all episodes in seasons. Review file name or manually import',
        'badFiles',
      ],
      ['Invalid season or episode', 'badFiles'],
    ];
    for (const [message, problem] of seen) {
      assert.equal(importProblemOf(message), problem, message);
    }
    assert.equal(importProblemOf('Something new'), 'unknown');
  });

  it('plans what to do about a stuck import', () => {
    assert.equal(planImport(['byId']), 'byName');
    assert.equal(planImport(['xem']), 'import');
    assert.equal(planImport(['badFiles', 'alreadyImported']), 'reject');
    assert.equal(planImport(['partial', 'badFiles']), 'clear');
    assert.equal(planImport(['alreadyImported']), 'clear');
    assert.equal(planImport(['xem', 'unknown']), 'review');
  });

  it('joins a pack’s queue records into one download', () => {
    const grabs = grabsOf(
      [1, 2].map((n) => ({
        id: 100 + n,
        downloadId: 'ABC',
        title: 'Show.S01.1080p',
        seriesId: 7,
        status: 'downloading',
        trackedDownloadState: 'downloading',
        statusMessages: [{ title: 'x', messages: ['Same line'] }],
        episode: { id: n, seasonNumber: 1, episodeNumber: n, hasFile: false },
      })),
      'sonarr'
    );
    assert.equal(grabs.length, 1);
    assert.deepEqual(grabs[0].queueIds, [101, 102]);
    assert.deepEqual(
      grabs[0].episodes.map((e) => e.id),
      [1, 2]
    );
    assert.deepEqual(grabs[0].messages, ['Same line']);
    assert.equal(grabs[0].key, 'abc');
  });
});

/** A Sonarr or Radarr that answers from what a test gives it. */
class FakeServer implements CheckServer {
  public queueNow: Grab[] = [];
  public parsed = new Map<string, number>();
  public itemFacts = new Map<number, ItemFacts>();
  public seriesEpisodes = new Map<number, QueueEpisode[]>();
  public held = new Map<number, Map<number, HeldFile>>();
  public importable = new Map<string, ImportCandidate[]>();
  public removed: { ids: number[]; how: Removal }[] = [];
  public imported: ImportFile[][] = [];
  public searched: { itemId: number; episodeIds: number[] }[] = [];

  constructor(public readonly app: 'sonarr' | 'radarr') {}

  async queue() {
    return this.queueNow;
  }
  async parsedItem(title: string) {
    return this.parsed.get(title);
  }
  async facts(itemId: number) {
    const facts = this.itemFacts.get(itemId);
    if (!facts) throw new Error('no such title');
    return facts;
  }
  async episodes(itemId: number) {
    return this.seriesEpisodes.get(itemId) ?? [];
  }
  async files(itemId: number) {
    if (this.app === 'radarr') {
      const movieFile = this.itemFacts.get(itemId)?.movieFile;
      return new Map(movieFile ? [[movieFile.id, movieFile]] : []);
    }
    return this.held.get(itemId) ?? new Map();
  }
  async profile() {
    return PROFILE;
  }
  async candidates(downloadId: string) {
    return this.importable.get(downloadId) ?? [];
  }
  async manualImport(files: ImportFile[]) {
    this.imported.push(files);
    return 77;
  }
  async command() {
    return { status: 'completed' };
  }
  async remove(ids: number[], how: Removal) {
    this.removed.push({ ids, how });
    this.queueNow = this.queueNow.filter(
      (g) => !g.queueIds.some((id) => ids.includes(id))
    );
  }
  async search(itemId: number, episodeIds: number[]) {
    this.searched.push({ itemId, episodeIds });
  }
}

const SONARR = {
  id: 0,
  name: 'Sonarr',
  hostname: 'sonarr.test',
  port: 8989,
  apiKey: 'key',
  useSsl: false,
  baseUrl: '',
} as SonarrSettings;

const RADARR = {
  id: 0,
  name: 'Radarr',
  hostname: 'radarr.test',
  port: 7878,
  apiKey: 'key',
  useSsl: false,
  baseUrl: '',
} as RadarrSettings;

const grab = (over: Partial<Grab>): Grab => ({
  key: 'hash1',
  downloadId: 'HASH1',
  queueIds: [1],
  title: 'Show.S01E03.1080p.WEB-DL-GRP',
  protocol: 'usenet',
  status: 'downloading',
  state: 'downloading',
  trackedStatus: 'ok',
  messages: [],
  added: new Date().toISOString(),
  size: 1000 * MB,
  sizeLeft: 900 * MB,
  quality: WEB1080,
  customFormatScore: 100,
  itemId: 10,
  episodes: [
    {
      id: 103,
      seasonNumber: 1,
      episodeNumber: 3,
      title: 'Reboot',
      airDateUtc: new Date(Date.now() - 48 * HOUR).toISOString(),
      hasFile: false,
      episodeFileId: 0,
    },
  ],
  ...over,
});

/** The setting is read back as a copy: the whole of Backfill's is set. */
const setMode = (mode: 'off' | 'report' | 'on') => {
  getSettings().backfill = {
    ...getSettings().backfill,
    downloadCheck: { mode },
  };
};

const rows = () => getRepository(DownloadCheck).find({ order: { id: 'ASC' } });

describe('Download Check', () => {
  let sonarr: FakeServer;
  let radarr: FakeServer;

  beforeEach(() => {
    downloadCheck.forget();
    downloadCheck.blockedForMs = 0;
    sonarr = new FakeServer('sonarr');
    radarr = new FakeServer('radarr');
    sonarr.itemFacts.set(10, {
      title: 'Show',
      year: 2020,
      qualityProfileId: 1,
      poster: 'https://artworks.thetvdb.com/p.jpg',
    });
    sonarr.parsed.set('Show.S01E03.1080p.WEB-DL-GRP', 10);
    const settings = getSettings();
    settings.sonarr = [SONARR];
    settings.radarr = [RADARR];
    settings.downloadClients = [];
    settings.backfill = {
      ...settings.backfill,
      downloadCheck: { mode: 'on' },
    };
    mock.method(downloadCheck, 'apiFor', (ref: { app: string }) =>
      ref.app === 'sonarr' ? sonarr : radarr
    );
  });

  afterEach(() => {
    mock.restoreAll();
    getSettings().backfill = {
      ...getSettings().backfill,
      downloadCheck: { mode: 'off' },
    };
  });

  it('does nothing while off', async () => {
    setMode('off');
    sonarr.queueNow = [
      grab({ added: new Date(Date.now() - 5 * 24 * HOUR).toISOString() }),
    ];
    sonarr.queueNow[0].episodes[0].airDateUtc = new Date().toISOString();
    await downloadCheck.run();
    assert.equal((await rows()).length, 0);
    assert.equal(sonarr.removed.length, 0);
  });

  it('passes a good download by without a word', async () => {
    sonarr.queueNow = [grab({})];
    await downloadCheck.run();
    assert.equal((await rows()).length, 0);
    assert.equal(sonarr.removed.length, 0);
  });

  it('rejects a fake grabbed days before its episode aired, and searches again', async () => {
    const fake = grab({
      key: 'waiting:10:show',
      downloadId: undefined,
      status: 'delay',
      state: '',
      added: new Date(Date.now() - 6 * 24 * HOUR).toISOString(),
    });
    fake.episodes[0].airDateUtc = new Date().toISOString();
    sonarr.queueNow = [fake];
    sonarr.seriesEpisodes.set(10, fake.episodes);
    await downloadCheck.run();
    const [row] = await rows();
    assert.equal(row.finding, 'early');
    assert.equal(row.status, 'done');
    assert.equal(row.itemTitle, 'Show');
    assert.equal(row.episodes, 'S01E03');
    assert.deepEqual(sonarr.removed, [
      {
        ids: [1],
        how: { removeFromClient: true, blocklist: true, skipRedownload: false },
      },
    ]);
  });

  it('with Report only, says what it would do and does nothing; turned on, it does it', async () => {
    setMode('report');
    const fake = grab({
      added: new Date(Date.now() - 3 * 24 * HOUR).toISOString(),
    });
    fake.episodes[0].airDateUtc = new Date().toISOString();
    sonarr.queueNow = [fake];
    await downloadCheck.run();
    let [row] = await rows();
    assert.equal(row.status, 'would');
    assert.equal(row.action, 'reject');
    assert.equal(sonarr.removed.length, 0);

    setMode('on');
    await downloadCheck.run();
    [row] = await rows();
    assert.equal(row.status, 'done');
    assert.equal(sonarr.removed.length, 1);
  });

  it('rejects what’s no better than the file there, without searching again', async () => {
    const have = grab({ customFormatScore: -137399 });
    have.episodes[0].hasFile = true;
    have.episodes[0].episodeFileId = 55;
    sonarr.held.set(
      10,
      new Map([[55, { quality: WEB1080, customFormatScore: 860006 }]])
    );
    sonarr.seriesEpisodes.set(10, have.episodes);
    sonarr.queueNow = [have];
    await downloadCheck.run();
    const [row] = await rows();
    assert.equal(row.finding, 'notUpgrade');
    assert.deepEqual(JSON.parse(row.params), {
      upgrade: false,
      why: 'score',
      have: 'WEBDL-1080p (860006)',
      offered: 'WEBDL-1080p (-137399)',
    });
    assert.equal(sonarr.removed[0].how.skipRedownload, true);
  });

  it('rejects a single episode where the file there holds two', async () => {
    const one = grab({});
    one.episodes[0].hasFile = true;
    one.episodes[0].episodeFileId = 56;
    sonarr.held.set(10, new Map([[56, { quality: WEB720 }]]));
    sonarr.seriesEpisodes.set(10, [
      one.episodes[0],
      {
        id: 104,
        seasonNumber: 1,
        episodeNumber: 4,
        hasFile: true,
        episodeFileId: 56,
      },
    ]);
    sonarr.queueNow = [one];
    await downloadCheck.run();
    const [row] = await rows();
    assert.equal(row.finding, 'moreEpisodes');
    assert.deepEqual(JSON.parse(row.params), { also: 'S01E04' });
  });

  it('drops a worse copy while a better one is coming', async () => {
    const worse = grab({
      key: 'w',
      downloadId: 'W',
      queueIds: [2],
      quality: WEB720,
      title: 'Show.S01E03.720p',
    });
    const better = grab({ key: 'b', downloadId: 'B', queueIds: [3] });
    sonarr.parsed.set('Show.S01E03.720p', 10);
    sonarr.queueNow = [worse, better];
    await downloadCheck.run();
    const [row] = await rows();
    assert.equal(row.downloadKey, 'w');
    assert.equal(row.finding, 'duplicate');
    assert.deepEqual(sonarr.removed, [
      {
        ids: [2],
        how: { removeFromClient: true, blocklist: false, skipRedownload: true },
      },
    ]);
  });

  it('rejects another country’s version before it downloads', async () => {
    const au = grab({ title: 'The.Turnstile.AU.S01E01.WEB-DL.x264-QXO' });
    sonarr.itemFacts.set(10, {
      title: 'The Turnstile (2016)',
      year: 2016,
      qualityProfileId: 1,
    });
    sonarr.queueNow = [au];
    await downloadCheck.run();
    const [row] = await rows();
    assert.equal(row.finding, 'otherTitle');
    assert.equal(JSON.parse(row.params).reason, 'country');
    assert.equal(row.status, 'done');
  });

  it('rejects a torrent with a program in it once its files are listed', async (t) => {
    getSettings().downloadClients = [
      {
        id: 1,
        name: 'qBittorrent',
        type: 'qbittorrent',
        hostname: 'qbit.test',
        port: 8080,
      } as DownloadClientSettings,
    ];
    t.mock.method(QBittorrentAPI.prototype, 'findTorrent', async () => ({
      hash: 'hash1',
    }));
    let files: {
      index: number;
      name: string;
      size: number;
      progress: number;
    }[] = [];
    t.mock.method(QBittorrentAPI.prototype, 'getFiles', async () => files);
    sonarr.queueNow = [grab({ protocol: 'torrent' })];
    // No file list yet (a magnet link): nothing said, asked again next time.
    await downloadCheck.run();
    assert.equal((await rows()).length, 0);
    files = [
      {
        index: 0,
        name: 'Show.S01E03/Show.S01E03.mkv',
        size: 10 * MB,
        progress: 0,
      },
      {
        index: 1,
        name: 'Show.S01E03/Show.S01E03.exe',
        size: 2 * MB,
        progress: 0,
      },
    ];
    await downloadCheck.run();
    const [row] = await rows();
    assert.equal(row.finding, 'program');
    assert.deepEqual(JSON.parse(row.params).files, ['Show.S01E03.exe']);
  });

  it('imports the right show filed by ID, telling Sonarr the episode', async () => {
    const stuck = grab({
      title:
        'Bramble.&amp;.Finch-Trick.Us.S02E04.Ladle.of.the.Evening.1080p.Netflix.WEB-DL-GoblinHD',
      status: 'completed',
      state: 'importblocked',
      trackedStatus: 'warning',
      sizeLeft: 0,
      messages: [
        'Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible. See the FAQ for details.',
      ],
    });
    stuck.episodes[0].title = 'Ladle of the Evening';
    sonarr.itemFacts.set(10, {
      title: 'Bramble & Finch: Trick Us',
      year: 2011,
      qualityProfileId: 1,
    });
    sonarr.seriesEpisodes.set(10, stuck.episodes);
    sonarr.importable.set('HASH1', [
      {
        path: '/dl/Bramble/a.mkv',
        size: 1200 * MB,
        episodeIds: [],
        quality: WEB1080,
      },
      {
        path: '/dl/Bramble/sample.mkv',
        size: 20 * MB,
        episodeIds: [],
        quality: WEB1080,
      },
    ]);
    sonarr.queueNow = [stuck];
    await downloadCheck.run();
    const [row] = await rows();
    assert.equal(row.stage, 'import');
    assert.equal(row.finding, 'sameTitle');
    assert.equal(row.status, 'done');
    assert.equal(sonarr.imported.length, 1);
    assert.deepEqual(
      sonarr.imported[0].map((f) => [f.path, f.episodeIds, f.downloadId]),
      [['/dl/Bramble/a.mkv', [103], 'HASH1']]
    );
  });

  it('imports a renumbered episode as the one it is, when that one is missing', async () => {
    const stuck = grab({
      title: 'Snack.Kingdom.2013.S01E13.Taco.Kingdom.3.720p.HMAX.WEB-DL-FIZZLR',
      status: 'completed',
      state: 'importblocked',
      trackedStatus: 'warning',
      sizeLeft: 0,
      messages: [
        'Found matching series via grab history, but release was matched to series by ID.',
      ],
    });
    stuck.episodes = [
      {
        id: 113,
        seasonNumber: 1,
        episodeNumber: 13,
        title: 'Taco Kingdom 2',
        hasFile: false,
      },
    ];
    sonarr.itemFacts.set(10, {
      title: 'Snack Kingdom',
      year: 2007,
      qualityProfileId: 1,
    });
    sonarr.seriesEpisodes.set(10, [
      stuck.episodes[0],
      {
        id: 705,
        seasonNumber: 7,
        episodeNumber: 5,
        title: 'Taco Kingdom 3',
        hasFile: false,
      },
    ]);
    sonarr.importable.set('HASH1', [
      {
        path: '/dl/fp.mkv',
        size: 800 * MB,
        episodeIds: [113],
        quality: WEB720,
      },
    ]);
    sonarr.queueNow = [stuck];
    await downloadCheck.run();
    const [row] = await rows();
    assert.equal(row.finding, 'renumbered');
    assert.equal(row.action, 'import');
    assert.deepEqual(sonarr.imported[0][0].episodeIds, [705]);
  });

  it('waits before touching a stuck import, in case it clears', async () => {
    downloadCheck.blockedForMs = 60_000;
    sonarr.queueNow = [
      grab({
        state: 'importblocked',
        trackedStatus: 'warning',
        messages: ['Sample'],
      }),
    ];
    await downloadCheck.run();
    assert.equal((await rows()).length, 0);
  });

  it('leaves an unsure title for an admin, and their choice stands', async () => {
    const stuck = grab({
      title: 'The.Schemers.Fresh.Blood.S01E05.720p.WEB.H264-iNTRePiD',
      state: 'importblocked',
      trackedStatus: 'warning',
      sizeLeft: 0,
      messages: [
        'Found matching series via grab history, but release was matched to series by ID.',
      ],
    });
    sonarr.itemFacts.set(10, {
      title: 'The Schemers (US)',
      year: 2023,
      qualityProfileId: 1,
    });
    sonarr.queueNow = [stuck];
    await downloadCheck.run();
    let [row] = await rows();
    assert.equal(row.status, 'waiting');
    assert.equal(sonarr.removed.length + sonarr.imported.length, 0);

    // Seen again: still left alone.
    await downloadCheck.run();
    assert.equal(sonarr.removed.length + sonarr.imported.length, 0);

    row = await downloadCheck.decide(row.id, 'reject');
    assert.equal(row.status, 'done');
    assert.equal(row.action, 'reject');
    assert.equal(sonarr.removed.length, 1);
  });

  it('clears a pack once part of it is in, and searches for the rest', async () => {
    const pack = grab({
      title: 'Show.S01.1080p.WEB-DL-GRP',
      queueIds: [5, 6],
      state: 'importblocked',
      trackedStatus: 'warning',
      sizeLeft: 0,
      messages: [
        'One or more episodes expected in this release were not imported or missing from the release',
        'Sample',
      ],
    });
    pack.episodes = [
      { id: 101, seasonNumber: 1, episodeNumber: 1, hasFile: true },
      { id: 102, seasonNumber: 1, episodeNumber: 2, hasFile: false },
    ];
    sonarr.seriesEpisodes.set(10, pack.episodes);
    sonarr.queueNow = [pack];
    await downloadCheck.run();
    const [row] = await rows();
    assert.equal(row.finding, 'partial');
    assert.deepEqual(sonarr.removed[0], {
      ids: [5, 6],
      how: { removeFromClient: false, blocklist: false, skipRedownload: true },
    });
    assert.deepEqual(sonarr.searched, [{ itemId: 10, episodeIds: [102] }]);
  });

  it('marks what left the queue before anything was done', async () => {
    setMode('report');
    const fake = grab({
      added: new Date(Date.now() - 3 * 24 * HOUR).toISOString(),
    });
    fake.episodes[0].airDateUtc = new Date().toISOString();
    sonarr.queueNow = [fake];
    await downloadCheck.run();
    sonarr.queueNow = [];
    await downloadCheck.run();
    const [row] = await rows();
    assert.equal(row.status, 'gone');
  });

  it('rejects a movie no better than the one there', async () => {
    radarr.itemFacts.set(20, {
      title: 'Scorch',
      year: 1995,
      qualityProfileId: 1,
      movieFile: { id: 9, quality: WEB1080, customFormatScore: 500 },
    });
    radarr.parsed.set('Scorch.1995.720p.WEB-DL', 20);
    radarr.queueNow = [
      grab({
        title: 'Scorch.1995.720p.WEB-DL',
        itemId: 20,
        episodes: [],
        quality: WEB720,
      }),
    ];
    await downloadCheck.run();
    const [row] = await rows();
    assert.equal(row.app, 'radarr');
    assert.equal(row.finding, 'notUpgrade');
    assert.equal(radarr.removed[0].how.skipRedownload, true);
  });
});
