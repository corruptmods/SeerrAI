import { magnetHash, parseTorrent } from '@server/lib/backfill/bencode';
import type { SeriesContext } from '@server/lib/backfill/matcher';
import {
  judgePack,
  mentionsShow,
  sameShow,
} from '@server/lib/backfill/matcher';
import {
  canonicalName,
  isExtra,
  readNumbers,
  releaseTags,
} from '@server/lib/backfill/naming';
import { packingOf, parseNzb, readNzb } from '@server/lib/backfill/nzb';
import type { PlanEntry } from '@server/lib/backfill/plan';
import {
  decide,
  dedupe,
  multiMustWait,
  rankCandidates,
  selectEntries,
  summarize,
  upgradeVerdict,
} from '@server/lib/backfill/plan';
import { episodesFor, readOpinions } from '@server/lib/backfill/secondOpinion';
import type {
  SonarrEpisode,
  SonarrEpisodeFile,
  SonarrParseResult,
  SonarrQualityProfile,
} from '@server/lib/backfill/sonarr';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

/*
 * The canonical names below are the ones Sonarr was asked about on the live
 * server while this was built: Sonarr maps them to the right episode and
 * scores them as the real release (Tengu's Kitsuraga 202 as Bluray-1080p, +700;
 * LiangSubs' Ninefold Sky 131 under its 2021 title, +403).
 */

/** The fork's "Anime 1080p" profile, as Sonarr returns it, trimmed. */
const ANIME_1080P: SonarrQualityProfile = {
  id: 13,
  name: 'Anime 1080p',
  upgradeAllowed: true,
  cutoff: 7,
  minFormatScore: 100,
  cutoffFormatScore: 10000,
  minUpgradeFormatScore: 1,
  items: [
    { quality: { id: 0, name: 'Unknown' }, allowed: false },
    { quality: { id: 1, name: 'SDTV' }, allowed: true },
    {
      id: 1001,
      name: 'WEB 480p',
      allowed: true,
      items: [
        { quality: { id: 8, name: 'WEBDL-480p' }, allowed: true },
        { quality: { id: 12, name: 'WEBRip-480p' }, allowed: true },
      ],
    },
    { quality: { id: 2, name: 'DVD' }, allowed: true },
    { quality: { id: 6, name: 'Bluray-720p' }, allowed: true },
    {
      id: 1003,
      name: 'WEB 1080p',
      allowed: true,
      items: [
        { quality: { id: 3, name: 'WEBDL-1080p' }, allowed: true },
        { quality: { id: 15, name: 'WEBRip-1080p' }, allowed: true },
        { quality: { id: 9, name: 'HDTV-1080p' }, allowed: true },
      ],
    },
    { quality: { id: 7, name: 'Bluray-1080p' }, allowed: true },
    { quality: { id: 20, name: 'Bluray-1080p Remux' }, allowed: false },
  ],
};

const q = (id: number, name: string, version = 1) => ({
  quality: { id, name },
  revision: { version, real: 0 },
});

const TENGU_PACK =
  '[Tengu] Kitsuraga (Complete Series) [BD 1080p][HEVC x265 10bit][Multi-Audio][Multi-Subs]';

describe('Backfill: reading names', () => {
  it('takes the absolute number in brackets after a pack’s own SxxEyy', () => {
    assert.deepEqual(readNumbers('[Tengu] Kitsuraga - S05E17 (202)'), {
      season: 5,
      episode: 17,
      absolute: 202,
    });
  });

  it('reads a file holding several episodes, however the range is written', () => {
    const range = { season: 6, episode: 1, through: 2 };
    for (const name of [
      'Bramwell the Goat - S06E01-02 - Bleat-ballad + Hold Your Hooves.mkv',
      'Bramwell.the.Goat.S06E01E02.1080p.mkv',
      'Bramwell.the.Goat.S06E01-E02.720p.mkv',
    ]) {
      assert.deepEqual(readNumbers(name), range, name);
    }
    // A resolution after a dash is not a second episode.
    assert.deepEqual(readNumbers('Show.S01E05-1080p.mkv'), {
      season: 1,
      episode: 5,
    });
    assert.deepEqual(readNumbers('Show.S01E05-720p.mkv'), {
      season: 1,
      episode: 5,
    });
  });

  it('reads " - 131v3" as episode 131, version 3', () => {
    assert.deepEqual(
      readNumbers('[LiangSubs] Ninefold Sky - 131v3 (1080P HEVC AAC)'),
      { absolute: 131, version: 3 }
    );
  });

  it('keeps a pack’s quality tags and drops what describes the pack', () => {
    assert.equal(
      releaseTags(TENGU_PACK),
      '[BD 1080p][HEVC x265 10bit][Multi-Audio][Multi-Subs]'
    );
    assert.equal(
      releaseTags('Carryall.S01-S04.480p.WEB-DL.x264-GRP'),
      '480p WEB-DL x264'
    );
  });

  it('builds the names Sonarr was shown to judge correctly', () => {
    assert.equal(
      canonicalName({
        fileName: '[Tengu] Kitsuraga - S05E17 (202)',
        packTitle: TENGU_PACK,
        seriesTitle: 'Kitsuraga',
        number: { absolute: 202 },
      }),
      '[Tengu] Kitsuraga - 202 [BD 1080p][HEVC x265 10bit][Multi-Audio][Multi-Subs]'
    );
    assert.equal(
      canonicalName({
        fileName: '[LiangSubs] Ninefold Sky - 131v3 (1080P HEVC AAC)',
        packTitle: '[LiangSubs] Ninefold Sky (1080p)',
        seriesTitle: 'Ninefold Sky (2021)',
        number: { absolute: 131 },
        version: 3,
      }),
      '[LiangSubs] Ninefold Sky 2021 - 131v3 (1080P HEVC AAC)'
    );
  });

  it('keeps every episode of a file that holds several, in forms Sonarr reads', () => {
    assert.deepEqual(readNumbers('Show.S01E01E02.1080p.WEB-DL-GRP'), {
      season: 1,
      episode: 1,
      through: 2,
    });
    // Both names were checked with Sonarr's own parser on the live server.
    assert.equal(
      canonicalName({
        fileName: 'Show.S01E01E02.1080p.WEB-DL-GRP',
        packTitle: 'Ninefold Sky 2021 S01 1080p WEB-DL-GRP',
        seriesTitle: 'Ninefold Sky (2021)',
        number: { season: 1, episode: 1, through: 2 },
      }),
      'Ninefold Sky 2021 S01E01-E02 1080p WEB-DL-GRP'
    );
    assert.equal(
      canonicalName({
        fileName: '[Tengu] Kitsuraga - 01-02.mkv',
        packTitle: TENGU_PACK,
        seriesTitle: 'Kitsuraga',
        number: { absolute: 1, through: 2 },
      }),
      '[Tengu] Kitsuraga - 01-02 [BD 1080p][HEVC x265 10bit][Multi-Audio][Multi-Subs]'
    );
  });

  it('passes over samples and extras', () => {
    assert.ok(isExtra('Show/Extras/Making of.mkv'));
    assert.ok(isExtra('Show - 01 sample.mkv'));
    assert.ok(isExtra('[Group] Show - NCOP1.mkv'));
    assert.ok(!isExtra('[Tengu] Kitsuraga - S05E17 (202).mkv'));
  });

  it('tells this show from one that only starts the same way', () => {
    const names = ['Kitsuraga', 'Kitsuraga (2002)'];
    assert.ok(sameShow('Kitsuraga', names));
    assert.ok(sameShow('Kitsuraga 2002', names));
    assert.ok(!sameShow('Kitsuraga Tsumuuden', names));
    assert.ok(mentionsShow('[Kaze-raws] Kitsuraga Tsumuuden - 080', names));
  });
});

/** A bencoded value, for building test torrents. */
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

describe('Backfill: torrents and NZBs', () => {
  it('lists a torrent’s files, folder first, and works out its hash', () => {
    const info = {
      name: '[Tengu] Kitsuraga',
      'piece length': 4194304,
      pieces: Buffer.alloc(20),
      files: [
        {
          length: 476_000_000,
          path: ['S5', '[Tengu] Kitsuraga - S05E17 (202).mkv'],
        },
        {
          length: 274_000_000,
          path: ['S1', '[Tengu] Kitsuraga - S01E02 (002).mkv'],
        },
      ],
    };
    const data = ben({ announce: 'udp://tracker', info });
    const meta = parseTorrent(data);
    assert.equal(
      meta.infoHash,
      createHash('sha1').update(ben(info)).digest('hex')
    );
    assert.deepEqual(meta.files, [
      {
        index: 0,
        path: '[Tengu] Kitsuraga/S5/[Tengu] Kitsuraga - S05E17 (202).mkv',
        size: 476_000_000,
      },
      {
        index: 1,
        path: '[Tengu] Kitsuraga/S1/[Tengu] Kitsuraga - S01E02 (002).mkv',
        size: 274_000_000,
      },
    ]);
  });

  it('leaves padding out of a torrent’s numbering, as qBittorrent does', () => {
    const info = {
      name: 'Pack',
      'piece length': 16384,
      pieces: Buffer.alloc(20),
      files: [
        { length: 10, path: ['a.mkv'] },
        { length: 5, path: ['.pad', '5'], attr: 'p' },
        { length: 10, path: ['b.mkv'] },
      ],
    };
    const meta = parseTorrent(ben({ announce: 'x', info }));
    assert.deepEqual(
      meta.files.map((f) => [f.index, f.path]),
      [
        [0, 'Pack/a.mkv'],
        [1, 'Pack/b.mkv'],
      ]
    );
  });

  it('reads an NZB with no closing tag at once, rather than taking minutes', () => {
    const started = Date.now();
    parseNzb('<nzb>' + '<file subject="x">'.repeat(40000));
    assert.ok(Date.now() - started < 1000);
  });

  it('reads an NZB whose subject has a character number no character has', () => {
    const files = parseNzb(
      '<nzb><file subject="&#99999999; &#x41;&quot;show.s01e01.mkv&quot;"><segment bytes="5">a@b</segment></file></nzb>'
    );
    assert.deepEqual(files, [{ index: 0, name: 'show.s01e01.mkv', size: 5 }]);
  });

  it('reads a magnet link’s hash, hex or base32', () => {
    assert.equal(
      magnetHash(
        'magnet:?xt=urn:btih:B5958B477FEA5223E33109FA094754294ED49B04&dn=x'
      ),
      'b5958b477fea5223e33109fa094754294ed49b04'
    );
    assert.equal(
      magnetHash('magnet:?xt=urn:btih:WWKYWR375JJCHYZRBH5ASR2UFFHNJGYE'),
      'b5958b477fea5223e33109fa094754294ed49b04'
    );
  });

  it('reads an NZB’s files from their subjects, and spots RAR posts', () => {
    const nzb = `<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
      <file poster="p" date="1" subject="[1/3] - &quot;[LiangSubs] Ninefold Sky - 153 (1080p HEVC AAC).mkv&quot; yEnc (1/2)">
        <segments><segment bytes="700000" number="1">a@b</segment><segment bytes="300000" number="2">c@d</segment></segments>
      </file>
      <file poster="p" date="1" subject="[2/3] - &quot;Ninefold.Sky.153.par2&quot; yEnc (1/1)">
        <segments><segment bytes="1000" number="1">e@f</segment></segments>
      </file></nzb>`;
    const files = parseNzb(nzb);
    assert.deepEqual(files[0], {
      index: 0,
      name: '[LiangSubs] Ninefold Sky - 153 (1080p HEVC AAC).mkv',
      size: 1_000_000,
    });
    assert.equal(packingOf(readNzb(nzb)), undefined);
    assert.equal(
      packingOf({
        files: [
          { index: 0, name: 'show.part01.rar', size: 1 },
          { index: 1, name: 'show.par2', size: 1 },
        ],
        unnamedBytes: 0,
      }),
      'archives'
    );
  });

  it('spots a post with scrambled names, which names only its repair files', () => {
    const file = (subject: string, bytes: number) =>
      `<file poster="p" date="1" subject="${subject}"><segments><segment bytes="${bytes}" number="1">x@y</segment></segments></file>`;
    const nzb = `<?xml version="1.0"?><nzb>${[
      file('[1/4] - &quot;b7f0c2e94a1d6e83&quot; yEnc (1/1)', 900_000_000),
      file('[2/4] - &quot;5d2a9e0c7b13f846&quot; yEnc (1/1)', 900_000_000),
      file('[3/4] - &quot;b7f0c2e94a1d6e83.par2&quot; yEnc (1/1)', 40_000),
      file(
        '[4/4] - &quot;b7f0c2e94a1d6e83.vol00+01.par2&quot; yEnc (1/1)',
        9_000_000
      ),
    ].join('')}</nzb>`;
    const contents = readNzb(nzb);
    assert.deepEqual(
      contents.files.map((f) => f.name),
      ['b7f0c2e94a1d6e83.par2', 'b7f0c2e94a1d6e83.vol00+01.par2']
    );
    assert.equal(contents.unnamedBytes, 1_800_000_000);
    assert.equal(packingOf(contents), 'scrambled');
    // Named with made-up extensions rather than none: scrambled all the same.
    assert.equal(
      packingOf({
        files: [
          { index: 0, name: 'qx81kd.mp9', size: 900 },
          { index: 1, name: 'qx81kd.par2', size: 10 },
        ],
        unnamedBytes: 0,
      }),
      'scrambled'
    );
    // Only repair data and a note, and no video: nothing to hide, just
    // nothing in it.
    assert.equal(
      packingOf({
        files: [
          { index: 0, name: 'movie.par2', size: 10 },
          { index: 1, name: 'movie.nfo', size: 1 },
        ],
        unnamedBytes: 0,
      }),
      undefined
    );
  });
});

describe('Backfill: what Sonarr would take', () => {
  it('ranks quality first: Blu-ray over 1080p TV, whatever the scores', () => {
    assert.deepEqual(
      upgradeVerdict(
        ANIME_1080P,
        { qualityId: 9, revision: 1, score: 2000 },
        { qualityId: 7, revision: 1, score: 700 }
      ),
      { upgrade: true }
    );
  });

  it('never takes a lower quality, even with a better score', () => {
    assert.equal(
      upgradeVerdict(
        ANIME_1080P,
        { qualityId: 7, revision: 1, score: 0 },
        { qualityId: 9, revision: 1, score: 2000 }
      ).upgrade,
      false
    );
  });

  it('at equal quality, takes a newer revision, then a better score', () => {
    const at = (revision: number, score: number) => ({
      qualityId: 9,
      revision,
      score,
    });
    assert.ok(upgradeVerdict(ANIME_1080P, at(1, 400), at(2, 400)).upgrade);
    assert.ok(!upgradeVerdict(ANIME_1080P, at(2, 400), at(1, 900)).upgrade);
    assert.ok(upgradeVerdict(ANIME_1080P, at(1, 400), at(1, 401)).upgrade);
    assert.ok(!upgradeVerdict(ANIME_1080P, at(1, 400), at(1, 400)).upgrade);
  });

  it('leaves alone what meets the cutoff', () => {
    const profile = { ...ANIME_1080P, cutoffFormatScore: 500 };
    assert.equal(
      upgradeVerdict(
        profile,
        { qualityId: 7, revision: 1, score: 700 },
        { qualityId: 7, revision: 1, score: 900 }
      ).reason,
      'What is on disk meets the cutoff'
    );
  });

  const episodes = new Map<number, SonarrEpisode>([
    [
      1,
      {
        id: 1,
        seriesId: 9,
        seasonNumber: 1,
        episodeNumber: 1,
        hasFile: false,
        monitored: true,
        episodeFileId: 0,
      },
    ],
    [
      2,
      {
        id: 2,
        seriesId: 9,
        seasonNumber: 1,
        episodeNumber: 2,
        hasFile: true,
        monitored: true,
        episodeFileId: 50,
      },
    ],
    [
      3,
      {
        id: 3,
        seriesId: 9,
        seasonNumber: 1,
        episodeNumber: 3,
        hasFile: true,
        monitored: true,
        episodeFileId: 51,
      },
    ],
  ]);
  const files = new Map<number, SonarrEpisodeFile>([
    [
      50,
      {
        id: 50,
        seasonNumber: 1,
        size: 1,
        quality: q(1, 'SDTV'),
        customFormatScore: 300,
      },
    ],
    [
      51,
      {
        id: 51,
        seasonNumber: 1,
        size: 1,
        quality: q(7, 'Bluray-1080p'),
        customFormatScore: 900,
      },
    ],
  ]);
  const entry = (
    index: number,
    episodeIds: number[],
    quality = q(7, 'Bluray-1080p'),
    score = 700
  ) => ({
    index,
    path: `pack/${index}.mkv`,
    size: 1000,
    judgedAs: '',
    episodeIds,
    quality,
    score,
  });

  it('fills a missing episode, upgrades a 480p one, skips a better one', () => {
    const plan = [
      decide(entry(0, [1]), ANIME_1080P, episodes, files),
      decide(entry(1, [2]), ANIME_1080P, episodes, files),
      decide(entry(2, [3]), ANIME_1080P, episodes, files),
    ];
    assert.deepEqual(
      plan.map((p) => [p.action, p.replaces]),
      [
        ['fill', 0],
        ['upgrade', 1],
        ['skip', 0],
      ]
    );
    const summary = summarize(plan);
    assert.equal(summary.fill, 1);
    assert.equal(summary.upgrade, 1);
    assert.equal(summary.replaces, 1);
    assert.deepEqual(
      selectEntries(plan, 'missing').map((p) => p.index),
      [0]
    );
    assert.deepEqual(
      selectEntries(plan, 'all').map((p) => p.index),
      [0, 1]
    );
  });

  it('ranks packs of files holding several episodes last, and takes them only when nothing else fills', () => {
    const fill = (index: number, ids: number[]): PlanEntry => ({
      ...entry(index, ids),
      action: 'fill',
      replaces: 0,
    });
    const doubles = {
      title: 'doubles',
      summary: summarize([fill(0, [1, 2]), fill(1, [3, 4]), fill(2, [5, 6])]),
    };
    const single = { title: 'single', summary: summarize([fill(0, [2])]) };
    const nothing = { title: 'nothing', summary: summarize([]) };
    assert.equal(doubles.summary.multi, 3);
    assert.equal(single.summary.multi, 0);
    assert.deepEqual(
      rankCandidates([nothing, doubles, single]).map((c) => c.title),
      ['single', 'doubles', 'nothing']
    );
    assert.equal(multiMustWait(doubles, [doubles, single, nothing]), true);
    assert.equal(multiMustWait(doubles, [doubles, nothing]), false);
    assert.equal(multiMustWait(single, [doubles, single]), false);
  });

  it('ranks a torrent nobody seeds after one somebody does, whatever else it fills', () => {
    const fill = (index: number, ids: number[]): PlanEntry => ({
      ...entry(index, ids),
      action: 'fill',
      replaces: 0,
    });
    const whole = summarize([fill(0, [1]), fill(1, [2]), fill(2, [3])]);
    const one = summarize([fill(0, [1])]);
    const packs = [
      { title: 'unseeded', protocol: 'torrent', seeders: 0, summary: whole },
      { title: 'seeded', protocol: 'torrent', seeders: 3, summary: one },
      { title: 'usenet', protocol: 'usenet', seeders: null, summary: one },
    ];
    assert.deepEqual(
      rankCandidates(packs).map((c) => c.title),
      ['seeded', 'usenet', 'unseeded']
    );
  });

  it('rejects what the profile does not allow, or scores too low', () => {
    assert.equal(
      decide(
        entry(0, [1], q(20, 'Bluray-1080p Remux')),
        ANIME_1080P,
        episodes,
        files
      ).action,
      'reject'
    );
    assert.match(
      decide(
        entry(0, [1], q(7, 'Bluray-1080p'), 0),
        ANIME_1080P,
        episodes,
        files
      ).reason ?? '',
      /below the profile's minimum of 100/
    );
  });

  it('uses only the better of two files for one episode', () => {
    const plan = dedupe(
      [
        decide(
          entry(0, [1], q(7, 'Bluray-1080p', 1)),
          ANIME_1080P,
          episodes,
          files
        ),
        decide(
          entry(1, [1], q(7, 'Bluray-1080p', 2)),
          ANIME_1080P,
          episodes,
          files
        ),
      ] as PlanEntry[],
      ANIME_1080P
    );
    assert.deepEqual(
      plan.map((p) => p.action),
      ['skip', 'fill']
    );
  });

  it('keeps the better quality of two copies, whatever their order', () => {
    const plan = dedupe(
      [
        decide(
          entry(0, [1], q(7, 'Bluray-1080p')),
          ANIME_1080P,
          episodes,
          files
        ),
        decide(
          entry(1, [1], q(6, 'Bluray-720p')),
          ANIME_1080P,
          episodes,
          files
        ),
      ] as PlanEntry[],
      ANIME_1080P
    );
    assert.deepEqual(
      plan.map((p) => p.action),
      ['fill', 'skip']
    );
  });

  it('takes a v2 of what is on disk even when that meets the cutoff', () => {
    assert.deepEqual(
      upgradeVerdict(
        ANIME_1080P,
        { qualityId: 7, revision: 1, score: 20000 },
        { qualityId: 7, revision: 2, score: 0 }
      ),
      { upgrade: true }
    );
  });
});

describe('Backfill: judging a pack', () => {
  /** What Sonarr answered on the live server, for these names. */
  const answers: Record<string, SonarrParseResult> = {
    '[Tengu] Kitsuraga - S05E17 (202)': {
      title: '[Tengu] Kitsuraga - S05E17 (202)',
      parsedEpisodeInfo: {
        seriesTitle: 'Kitsuraga',
        quality: q(0, 'Unknown'),
        seasonNumber: 5,
        episodeNumbers: [17],
        absoluteEpisodeNumbers: [],
        releaseGroup: 'Tengu',
      },
      series: { id: 1279, title: 'Kitsuraga' },
      episodes: [
        {
          id: 145130,
          seriesId: 1279,
          seasonNumber: 5,
          episodeNumber: 17,
          absoluteEpisodeNumber: 196,
          hasFile: false,
          monitored: true,
          episodeFileId: 0,
        },
      ],
      customFormatScore: 0,
    },
    '[Tengu] Kitsuraga - 202 [BD 1080p][HEVC x265 10bit][Multi-Audio][Multi-Subs]':
      {
        title: '',
        parsedEpisodeInfo: {
          seriesTitle: 'Kitsuraga',
          quality: q(7, 'Bluray-1080p'),
          absoluteEpisodeNumbers: [202],
          releaseGroup: 'Tengu',
        },
        series: { id: 1279, title: 'Kitsuraga' },
        episodes: [
          {
            id: 145136,
            seriesId: 1279,
            seasonNumber: 5,
            episodeNumber: 23,
            absoluteEpisodeNumber: 202,
            hasFile: false,
            monitored: true,
            episodeFileId: 0,
          },
        ],
        languages: [{ id: 8, name: 'Japanese' }],
        customFormatScore: 700,
      },
    '[Kaze-raws] Kitsuraga Tsumuuden - 080 [1080p]': {
      title: '',
      parsedEpisodeInfo: {
        seriesTitle: 'Kitsuraga Tsumuuden',
        absoluteEpisodeNumbers: [80],
      },
      customFormatScore: 0,
    },
  };

  const ctx = (): SeriesContext => ({
    series: {
      id: 1279,
      title: 'Kitsuraga',
      year: 2002,
      tvdbId: 63914,
      seriesType: 'anime',
      qualityProfileId: 13,
      path: '/anime/Kitsuraga',
    },
    episodes: [
      {
        id: 145130,
        seriesId: 1279,
        seasonNumber: 5,
        episodeNumber: 17,
        absoluteEpisodeNumber: 196,
        hasFile: false,
        monitored: true,
        episodeFileId: 0,
      },
      {
        id: 145136,
        seriesId: 1279,
        seasonNumber: 5,
        episodeNumber: 23,
        absoluteEpisodeNumber: 202,
        hasFile: false,
        monitored: true,
        episodeFileId: 0,
      },
    ],
    files: [],
    profile: ANIME_1080P,
    names: ['Kitsuraga'],
    sonarr: {
      parse: async (title: string) => {
        const answer = answers[title];
        if (!answer) throw new Error(`No recorded answer for ${title}`);
        return answer;
      },
    } as unknown as SeriesContext['sonarr'],
  });

  it('maps a Tengu file by its absolute number, not the pack’s SxxEyy', async () => {
    const { plan, summary } = await judgePack(
      [
        {
          index: 0,
          path: '[Tengu] Kitsuraga/S5/[Tengu] Kitsuraga - S05E17 (202).mkv',
          size: 476e6,
        },
        { index: 1, path: '[Tengu] Kitsuraga/S5/sample.mkv', size: 30e6 },
      ],
      TENGU_PACK,
      ctx()
    );
    assert.equal(plan.length, 1, 'the sample is passed over');
    assert.deepEqual(plan[0].episodeIds, [145136], 'episode 202, not 196');
    assert.equal(plan[0].action, 'fill');
    assert.equal(plan[0].score, 700);
    assert.equal(plan[0].quality?.quality.name, 'Bluray-1080p');
    assert.equal(summary.fill, 1);
  });

  it('turns down a file named as another show', async () => {
    const { plan } = await judgePack(
      [
        {
          index: 0,
          path: '[Kaze-raws] Kitsuraga Tsumuuden - 080 [1080p].mkv',
          size: 500e6,
        },
      ],
      '[Kaze-raws] Kitsuraga Tsumuuden - 080 ~ 500 [1080p]',
      ctx()
    );
    assert.equal(plan[0].action, 'reject');
    assert.equal(plan[0].reason, 'Named as another show: Kitsuraga Tsumuuden');
  });
});

describe('Backfill: a two-part finale the scene numbers as one', () => {
  // Grey Summit State S03: the scene's S03E12 is TVDB's E12 and E13, as
  // Sonarr answered on the live server, but the pack has a file for each.
  const ep = (id: number, episodeNumber: number, hasFile: boolean) => ({
    id,
    seriesId: 1243,
    seasonNumber: 3,
    episodeNumber,
    absoluteEpisodeNumber: 26 + episodeNumber,
    hasFile,
    monitored: true,
    episodeFileId: hasFile ? 163521 : 0,
  });
  const e12 = ep(142107, 12, false);
  const e13 = ep(142108, 13, true);
  const ctx = (): SeriesContext => ({
    series: {
      id: 1243,
      title: 'Grey Summit State',
      year: 2010,
      tvdbId: 245622,
      seriesType: 'standard',
      qualityProfileId: 13,
      path: '/tv/Grey Summit State',
    },
    episodes: [e12, e13],
    files: [
      {
        id: 163521,
        seasonNumber: 3,
        size: 300e6,
        quality: q(4, 'HDTV-720p'),
        customFormatScore: 0,
      },
    ],
    profile: ANIME_1080P,
    names: ['Grey Summit State'],
    sonarr: {
      parse: async (title: string) => ({
        title,
        parsedEpisodeInfo: {
          seriesTitle: 'Grey Summit State (2010)',
          quality: q(3, 'WEBDL-1080p'),
          seasonNumber: 3,
          episodeNumbers: [/S03E12/.test(title) ? 12 : 13],
          releaseGroup: 'Koala',
        },
        series: { id: 1243, title: 'Grey Summit State' },
        episodes: /S03E12/.test(title) ? [e13, e12] : [e13],
        customFormatScore: 885000,
      }),
    } as unknown as SeriesContext['sonarr'],
  });

  it('takes each file as the episode its name gives', async () => {
    const { plan } = await judgePack(
      [
        {
          index: 11,
          path: 'Grey Summit State (2010) - S03E12 - The Barley Patch (1) (1080p WEB-DL x265 Koala).mkv',
          size: 627e6,
        },
        {
          index: 12,
          path: 'Grey Summit State (2010) - S03E13 - The Barley Patch (2) (1080p WEB-DL x265 Koala).mkv',
          size: 627e6,
        },
      ],
      'Grey Summit State (2010) Season 3 S03 (1080p WEB-DL x265 Koala)',
      ctx()
    );
    const byIndex = new Map(plan.map((e) => [e.index, e]));
    assert.deepEqual(byIndex.get(11)?.episodeIds, [142107]);
    assert.equal(byIndex.get(11)?.action, 'fill');
    assert.equal(byIndex.get(11)?.episode, 12);
    assert.deepEqual(byIndex.get(12)?.episodeIds, [142108]);
    assert.equal(byIndex.get(12)?.action, 'upgrade');
  });

  it('keeps the scene’s double episode when the pack has no second file', async () => {
    const { plan } = await judgePack(
      [
        {
          index: 0,
          path: 'Grey Summit State (2010) - S03E12 - The Barley Patch (1080p WEB-DL x265 Koala).mkv',
          size: 1.2e9,
        },
      ],
      'Grey Summit State (2010) S03E12 (1080p WEB-DL x265 Koala)',
      ctx()
    );
    assert.deepEqual([...plan[0].episodeIds].sort(), [142107, 142108]);
  });
});

describe('Backfill: a name whose episode title is another episode', () => {
  // A made-up series Sonarr numbers by the scene (TheXEM): library S08E01
  // is the scene's S06E15, and the scene's S08E01 is library S09E01. Some
  // groups name files by the library's numbers, some count the special as
  // S03E01; the episode title in the name says which episode it is.
  const ep = (
    id: number,
    season: number,
    episode: number,
    title: string,
    hasFile: boolean,
    scene?: [number, number]
  ): SonarrEpisode => ({
    id,
    seriesId: 77,
    seasonNumber: season,
    episodeNumber: episode,
    title,
    hasFile,
    monitored: true,
    episodeFileId: hasFile ? id + 1000 : 0,
    ...(scene
      ? { sceneSeasonNumber: scene[0], sceneEpisodeNumber: scene[1] }
      : {}),
  });
  const atoll = ep(941, 8, 1, 'Atoll Exile', false, [6, 15]);
  const river = ep(948, 9, 1, 'River Bend', true, [8, 1]);
  const map = ep(863, 0, 1, 'Beyond the Map', false);
  const ochre = ep(893, 3, 1, 'Ochre Canyon', true);
  const kiln = ep(895, 3, 3, 'Into the Kiln', false);
  const salt = ep(912, 5, 2, 'Salt Flats', false);
  const wayOut = ep(920, 1, 2, 'The Long Way Out', false);
  const reckoning = ep(927, 1, 7, 'Reckoning', true);
  const dayOne = ep(940, 0, 9, 'Day One', false);
  const episodes = [
    atoll,
    river,
    map,
    ochre,
    kiln,
    salt,
    wayOut,
    reckoning,
    dayOne,
  ];

  const ctx = (): SeriesContext => ({
    series: {
      id: 77,
      title: 'Remote Reach',
      year: 2010,
      tvdbId: 999001,
      seriesType: 'standard',
      qualityProfileId: 13,
      path: '/tv/Remote Reach',
    },
    episodes,
    files: [river, ochre].map((e) => ({
      id: e.episodeFileId,
      seasonNumber: e.seasonNumber,
      size: 300e6,
      quality: q(4, 'HDTV-720p'),
      customFormatScore: 0,
    })),
    profile: ANIME_1080P,
    names: ['Remote Reach'],
    sonarr: {
      // As Sonarr reads a series numbered by the scene: by the scene's
      // numbers, then by TVDB's for an episode the scene doesn't renumber.
      // It has nothing for season 5.
      parse: async (title: string) => {
        const m = /S(\d+)E(\d+)/i.exec(title);
        if (!m) {
          return {
            title,
            parsedEpisodeInfo: { seriesTitle: 'Remote Reach' },
            customFormatScore: 0,
          };
        }
        const season = Number(m[1]);
        const episode = Number(m[2]);
        const found =
          season === 5
            ? undefined
            : (episodes.find(
                (e) =>
                  e.sceneSeasonNumber === season &&
                  e.sceneEpisodeNumber === episode
              ) ??
              episodes.find(
                (e) =>
                  e.sceneSeasonNumber === undefined &&
                  e.seasonNumber === season &&
                  e.episodeNumber === episode
              ));
        return {
          title,
          parsedEpisodeInfo: {
            seriesTitle: 'Remote Reach',
            quality: q(3, 'WEBDL-1080p'),
            seasonNumber: season,
            episodeNumbers: [episode],
            releaseGroup: 'GRP',
          },
          series: { id: 77, title: 'Remote Reach' },
          episodes: found ? [found] : [],
          customFormatScore: 500,
        };
      },
    } as unknown as SeriesContext['sonarr'],
  });

  const PACK = 'Remote.Reach.Complete.1080p.WEB-DL-GRP';
  const file = (index: number, name: string) => ({
    index,
    path: `${PACK}/${name}.mkv`,
    size: 900e6,
  });

  it('takes a file by its title when Sonarr reads its number as another episode', async () => {
    const { plan } = await judgePack(
      [file(0, 'Remote.Reach.S08E01.Atoll.Exile.1080p.WEB-DL-GRP')],
      PACK,
      ctx()
    );
    assert.deepEqual(plan[0].episodeIds, [atoll.id], 'not River Bend');
    assert.equal(plan[0].season, 8);
    assert.equal(plan[0].episode, 1);
    assert.equal(plan[0].matchedBy, 'title');
    assert.equal(plan[0].action, 'fill');
  });

  it('takes a special a group numbered as a season’s first episode', async () => {
    const { plan } = await judgePack(
      [file(0, 'Remote.Reach.S03E01.Beyond.the.Map.1080p.WEB-DL-GRP')],
      PACK,
      ctx()
    );
    assert.deepEqual(plan[0].episodeIds, [map.id], 'not Ochre Canyon');
    assert.equal(plan[0].season, 0);
    assert.equal(plan[0].matchedBy, 'title');
    assert.equal(plan[0].action, 'fill');
  });

  it('takes a special named only by its title', async () => {
    const { plan } = await judgePack(
      [
        file(0, 'Specials/Remote Reach - Beyond the Map'),
        file(1, 'Specials/Remote Reach - Salt Flats'),
      ],
      PACK,
      ctx()
    );
    const byIndex = new Map(plan.map((e) => [e.index, e]));
    assert.deepEqual(byIndex.get(0)?.episodeIds, [map.id]);
    assert.equal(byIndex.get(0)?.matchedBy, 'title');
    assert.equal(byIndex.get(0)?.action, 'fill');
    // Sonarr has nothing for season 5, as before.
    assert.equal(byIndex.get(1)?.action, 'reject');
  });

  it('goes by the number when the title only shares a word with another episode’s', async () => {
    const { plan } = await judgePack(
      [
        file(0, 'Remote.Reach.S01E02.The.Reckoning.Begins.1080p.WEB-DL-GRP'),
        // Not an episode, though it holds one's title.
        file(1, 'Specials/Remote Reach - Day One Interview'),
      ],
      PACK,
      ctx()
    );
    const byIndex = new Map(plan.map((e) => [e.index, e]));
    assert.deepEqual(byIndex.get(0)?.episodeIds, [wayOut.id]);
    assert.equal(byIndex.get(0)?.matchedBy, undefined);
    assert.equal(byIndex.get(1)?.action, 'reject');
    assert.deepEqual(byIndex.get(1)?.episodeIds, []);
  });

  it('leaves a file whose number and title agree as it was', async () => {
    const { plan } = await judgePack(
      [file(0, 'Remote.Reach.S03E03.Into.the.Kiln.1080p.WEB-DL-GRP')],
      PACK,
      ctx()
    );
    assert.deepEqual(plan[0].episodeIds, [kiln.id]);
    assert.equal(plan[0].matchedBy, undefined);
  });

  it('turns a file down when Sonarr won’t read it as the episode its title is', async () => {
    const { plan } = await judgePack(
      [file(0, 'Remote.Reach.S03E01.Salt.Flats.1080p.WEB-DL-GRP')],
      PACK,
      ctx()
    );
    assert.equal(plan[0].action, 'reject');
    assert.deepEqual(plan[0].episodeIds, []);
    assert.equal(
      plan[0].reason,
      'Its title is S05E02 "Salt Flats", which Sonarr won\'t read it as'
    );
  });
});

describe('Backfill: the AI second opinion', () => {
  const special = (
    id: number,
    episodeNumber: number,
    title: string
  ): SonarrEpisode => ({
    id,
    seriesId: 1279,
    seasonNumber: 0,
    episodeNumber,
    title,
    hasFile: false,
    monitored: true,
    episodeFileId: 0,
  });
  const ep202: SonarrEpisode = {
    id: 145136,
    seriesId: 1279,
    seasonNumber: 5,
    episodeNumber: 23,
    absoluteEpisodeNumber: 202,
    title: 'The Battle Begins: Kitsuraga vs. Ryomaru',
    hasFile: false,
    monitored: true,
    episodeFileId: 0,
  };
  const festival = special(
    145157,
    3,
    'Kitsuraga OVA 3: Misty Pine Village Grand Sports Festival'
  );
  const clover = special(
    145155,
    1,
    'Kitsuraga OVA: Find the Amber Four-Leaf Clover!'
  );

  /** Answers Sonarr gave on the live server for these exact names. */
  const sonarrAnswers: Record<string, SonarrParseResult> = {
    '[Tengu] Kitsuraga - Misty Pine Village Grand Sports Festival': {
      title: '[Tengu] Kitsuraga - Misty Pine Village Grand Sports Festival',
      customFormatScore: 0,
    },
    '[Tengu] Kitsuraga - Amber Clover': {
      title: '[Tengu] Kitsuraga - Amber Clover',
      customFormatScore: 0,
    },
    '[Tengu] Kitsuraga - S00E03 [BD 1080p][HEVC x265 10bit][Multi-Audio][Multi-Subs]':
      {
        title: '',
        parsedEpisodeInfo: {
          seriesTitle: 'Kitsuraga',
          quality: q(7, 'Bluray-1080p'),
          seasonNumber: 0,
          episodeNumbers: [3],
          releaseGroup: 'Tengu',
        },
        series: { id: 1279, title: 'Kitsuraga' },
        episodes: [{ ...festival }],
        languages: [{ id: 8, name: 'Japanese' }],
        customFormatScore: 700,
      },
    // Sonarr maps the clover file to a different special than the one the
    // model names, so the model's match is turned down.
    '[Tengu] Kitsuraga - S00E01 [BD 1080p][HEVC x265 10bit][Multi-Audio][Multi-Subs]':
      {
        title: '',
        parsedEpisodeInfo: {
          seriesTitle: 'Kitsuraga',
          quality: q(7, 'Bluray-1080p'),
          seasonNumber: 0,
          episodeNumbers: [1],
          releaseGroup: 'Tengu',
        },
        series: { id: 1279, title: 'Kitsuraga' },
        episodes: [{ ...festival }],
        customFormatScore: 700,
      },
  };

  const context = (
    secondOpinion?: SeriesContext['secondOpinion']
  ): SeriesContext => ({
    series: {
      id: 1279,
      title: 'Kitsuraga',
      year: 2002,
      tvdbId: 63914,
      seriesType: 'anime',
      qualityProfileId: 13,
      path: '/anime/Kitsuraga',
    },
    episodes: [ep202, festival, clover],
    files: [],
    profile: ANIME_1080P,
    names: ['Kitsuraga'],
    sonarr: {
      parse: async (title: string) => {
        const answer = sonarrAnswers[title];
        if (!answer) throw new Error(`No recorded answer for ${title}`);
        return answer;
      },
    } as unknown as SeriesContext['sonarr'],
    secondOpinion,
  });

  const FESTIVAL_FILE = {
    index: 4,
    path: '[Tengu] Kitsuraga/Specials/[Tengu] Kitsuraga - Misty Pine Village Grand Sports Festival.mkv',
    size: 300e6,
  };

  it('places a file named only by its title, as the model read it, once Sonarr agrees', async () => {
    let asked: Parameters<NonNullable<SeriesContext['secondOpinion']>>[0];
    const { plan, summary } = await judgePack(
      [FESTIVAL_FILE],
      TENGU_PACK,
      context(async (req) => {
        asked = req;
        return [
          {
            index: 4,
            episodeIds: [145157],
            why: 'Title matches OVA 3, the Sports Festival',
          },
        ];
      })
    );
    assert.equal(asked!.files.length, 1);
    assert.equal(
      asked!.files[0].name,
      '[Tengu] Kitsuraga - Misty Pine Village Grand Sports Festival'
    );
    assert.equal(asked!.files[0].problem, 'No episode number in the name');
    assert.equal(plan[0].action, 'fill');
    assert.deepEqual(plan[0].episodeIds, [145157]);
    assert.equal(plan[0].matchedBy, 'ai');
    assert.equal(plan[0].why, 'Title matches OVA 3, the Sports Festival');
    assert.equal(plan[0].score, 700);
    assert.equal(summary.aiMatched, 1);
  });

  it('turns the model down when Sonarr reads its pick as another episode', async () => {
    const { plan, summary } = await judgePack(
      [
        {
          index: 5,
          path: '[Tengu] Kitsuraga/Specials/[Tengu] Kitsuraga - Amber Clover.mkv',
          size: 300e6,
        },
      ],
      TENGU_PACK,
      context(async () => [
        { index: 5, episodeIds: [145155], why: 'The clover OVA' },
      ])
    );
    assert.equal(plan[0].action, 'reject');
    assert.equal(
      plan[0].reason,
      'AI suggested S00E01, but Sonarr read it differently'
    );
    assert.equal(plan[0].matchedBy, undefined);
    assert.equal(summary.aiMatched, 0);
  });

  it('keeps going, and says why, when the model cannot be asked', async () => {
    const { plan, summary } = await judgePack(
      [FESTIVAL_FILE],
      TENGU_PACK,
      context(async () => {
        throw new Error('You have used all 20 of today’s AI answers.');
      })
    );
    assert.equal(plan[0].action, 'reject');
    assert.equal(plan[0].reason, 'No episode number in the name');
    assert.match(summary.aiNote ?? '', /^AI second opinion unavailable: /);
  });

  it('asks nothing when every file was placed by its name', async () => {
    let asked = false;
    await judgePack(
      [],
      TENGU_PACK,
      context(async () => {
        asked = true;
        return [];
      })
    );
    assert.equal(asked, false);
  });

  it('reads only answers about files and episodes it listed, each claimed once', () => {
    const files = [
      { index: 10, name: 'a', problem: 'x' },
      { index: 11, name: 'b', problem: 'x' },
      { index: 12, name: 'c', problem: 'x' },
    ];
    const listed = [ep202, festival, clover];
    const read = readOpinions(
      {
        m: [
          { f: 1, e: [2], w: 'festival' },
          { f: 1, e: [3], w: 'asked twice: ignored' },
          { f: 2, e: [2], w: 'already claimed: ignored' },
          { f: 3, e: [9], w: 'not on the list: ignored' },
          { f: 7, e: [1], w: 'no such file: ignored' },
        ],
      },
      files,
      listed
    );
    assert.deepEqual(read, [
      { index: 10, episodeIds: [145157], why: 'festival' },
    ]);
  });

  it('cuts a long series down to the stretch the pack is about, with every special', () => {
    const long: SonarrEpisode[] = Array.from({ length: 1100 }, (_, i) => ({
      id: i + 1,
      seriesId: 1,
      seasonNumber: 1,
      episodeNumber: i + 1,
      absoluteEpisodeNumber: i + 1,
      hasFile: false,
      monitored: true,
      episodeFileId: 0,
    }));
    const listed = episodesFor([...long, festival], {
      seasons: [],
      absolutes: [500, 520],
    });
    assert.ok(listed.includes(festival), 'specials are always listed');
    assert.equal(listed.length, 1 + (550 - 470 + 1));
    assert.equal(
      episodesFor([ep202, festival], { seasons: [], absolutes: [] }).length,
      2
    );
  });

  it('leaves AI matches out of an approval when asked to', () => {
    const plan = [
      { action: 'fill', matchedBy: 'ai' },
      { action: 'fill' },
      { action: 'upgrade', matchedBy: 'ai' },
    ] as PlanEntry[];
    assert.equal(selectEntries(plan, 'all').length, 3);
    assert.equal(selectEntries(plan, 'all', false).length, 1);
    assert.equal(selectEntries(plan, 'missing', false).length, 1);
  });
});
