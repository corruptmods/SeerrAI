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
 * scores them as the real release (Judas's Naruto 202 as Bluray-1080p, +700;
 * HuangSubs' Perfect World 131 under its 2021 title, +403).
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

const JUDAS_PACK =
  '[Judas] Naruto (Complete Series) [BD 1080p][HEVC x265 10bit][Multi-Audio][Multi-Subs]';

describe('Backfill: reading names', () => {
  it('takes the absolute number in brackets after a pack’s own SxxEyy', () => {
    assert.deepEqual(readNumbers('[Judas] Naruto - S05E17 (202)'), {
      season: 5,
      episode: 17,
      absolute: 202,
    });
  });

  it('reads a file holding several episodes, however the range is written', () => {
    const range = { season: 6, episode: 1, through: 2 };
    for (const name of [
      'Shaun the Sheep - S06E01-02 - Baa-gherita + Get Your Goat.mkv',
      'Shaun.the.Sheep.S06E01E02.1080p.mkv',
      'Shaun.the.Sheep.S06E01-E02.720p.mkv',
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
      readNumbers('[HuangSubs] Perfect World - 131v3 (1080P HEVC AAC)'),
      { absolute: 131, version: 3 }
    );
  });

  it('keeps a pack’s quality tags and drops what describes the pack', () => {
    assert.equal(
      releaseTags(JUDAS_PACK),
      '[BD 1080p][HEVC x265 10bit][Multi-Audio][Multi-Subs]'
    );
    assert.equal(
      releaseTags('Baggage.S01-S04.480p.WEB-DL.x264-GRP'),
      '480p WEB-DL x264'
    );
  });

  it('builds the names Sonarr was shown to judge correctly', () => {
    assert.equal(
      canonicalName({
        fileName: '[Judas] Naruto - S05E17 (202)',
        packTitle: JUDAS_PACK,
        seriesTitle: 'Naruto',
        number: { absolute: 202 },
      }),
      '[Judas] Naruto - 202 [BD 1080p][HEVC x265 10bit][Multi-Audio][Multi-Subs]'
    );
    assert.equal(
      canonicalName({
        fileName: '[HuangSubs] Perfect World - 131v3 (1080P HEVC AAC)',
        packTitle: '[HuangSubs] Perfect World (1080p)',
        seriesTitle: 'Perfect World (2021)',
        number: { absolute: 131 },
        version: 3,
      }),
      '[HuangSubs] Perfect World 2021 - 131v3 (1080P HEVC AAC)'
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
        packTitle: 'Perfect World 2021 S01 1080p WEB-DL-GRP',
        seriesTitle: 'Perfect World (2021)',
        number: { season: 1, episode: 1, through: 2 },
      }),
      'Perfect World 2021 S01E01-E02 1080p WEB-DL-GRP'
    );
    assert.equal(
      canonicalName({
        fileName: '[Judas] Naruto - 01-02.mkv',
        packTitle: JUDAS_PACK,
        seriesTitle: 'Naruto',
        number: { absolute: 1, through: 2 },
      }),
      '[Judas] Naruto - 01-02 [BD 1080p][HEVC x265 10bit][Multi-Audio][Multi-Subs]'
    );
  });

  it('passes over samples and extras', () => {
    assert.ok(isExtra('Show/Extras/Making of.mkv'));
    assert.ok(isExtra('Show - 01 sample.mkv'));
    assert.ok(isExtra('[Group] Show - NCOP1.mkv'));
    assert.ok(!isExtra('[Judas] Naruto - S05E17 (202).mkv'));
  });

  it('tells this show from one that only starts the same way', () => {
    const names = ['Naruto', 'Naruto (2002)'];
    assert.ok(sameShow('Naruto', names));
    assert.ok(sameShow('Naruto 2002', names));
    assert.ok(!sameShow('Naruto Shippuuden', names));
    assert.ok(mentionsShow('[Erai-raws] Naruto Shippuuden - 080', names));
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
      name: '[Judas] Naruto',
      'piece length': 4194304,
      pieces: Buffer.alloc(20),
      files: [
        {
          length: 476_000_000,
          path: ['S5', '[Judas] Naruto - S05E17 (202).mkv'],
        },
        {
          length: 274_000_000,
          path: ['S1', '[Judas] Naruto - S01E02 (002).mkv'],
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
        path: '[Judas] Naruto/S5/[Judas] Naruto - S05E17 (202).mkv',
        size: 476_000_000,
      },
      {
        index: 1,
        path: '[Judas] Naruto/S1/[Judas] Naruto - S01E02 (002).mkv',
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
      <file poster="p" date="1" subject="[1/3] - &quot;[HuangSubs] Perfect World - 153 (1080p HEVC AAC).mkv&quot; yEnc (1/2)">
        <segments><segment bytes="700000" number="1">a@b</segment><segment bytes="300000" number="2">c@d</segment></segments>
      </file>
      <file poster="p" date="1" subject="[2/3] - &quot;Perfect.World.153.par2&quot; yEnc (1/1)">
        <segments><segment bytes="1000" number="1">e@f</segment></segments>
      </file></nzb>`;
    const files = parseNzb(nzb);
    assert.deepEqual(files[0], {
      index: 0,
      name: '[HuangSubs] Perfect World - 153 (1080p HEVC AAC).mkv',
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
    '[Judas] Naruto - S05E17 (202)': {
      title: '[Judas] Naruto - S05E17 (202)',
      parsedEpisodeInfo: {
        seriesTitle: 'Naruto',
        quality: q(0, 'Unknown'),
        seasonNumber: 5,
        episodeNumbers: [17],
        absoluteEpisodeNumbers: [],
        releaseGroup: 'Judas',
      },
      series: { id: 1279, title: 'Naruto' },
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
    '[Judas] Naruto - 202 [BD 1080p][HEVC x265 10bit][Multi-Audio][Multi-Subs]':
      {
        title: '',
        parsedEpisodeInfo: {
          seriesTitle: 'Naruto',
          quality: q(7, 'Bluray-1080p'),
          absoluteEpisodeNumbers: [202],
          releaseGroup: 'Judas',
        },
        series: { id: 1279, title: 'Naruto' },
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
    '[Erai-raws] Naruto Shippuuden - 080 [1080p]': {
      title: '',
      parsedEpisodeInfo: {
        seriesTitle: 'Naruto Shippuuden',
        absoluteEpisodeNumbers: [80],
      },
      customFormatScore: 0,
    },
  };

  const ctx = (): SeriesContext => ({
    series: {
      id: 1279,
      title: 'Naruto',
      year: 2002,
      tvdbId: 78857,
      seriesType: 'anime',
      qualityProfileId: 13,
      path: '/anime/Naruto',
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
    names: ['Naruto'],
    sonarr: {
      parse: async (title: string) => {
        const answer = answers[title];
        if (!answer) throw new Error(`No recorded answer for ${title}`);
        return answer;
      },
    } as unknown as SeriesContext['sonarr'],
  });

  it('maps a Judas file by its absolute number, not the pack’s SxxEyy', async () => {
    const { plan, summary } = await judgePack(
      [
        {
          index: 0,
          path: '[Judas] Naruto/S5/[Judas] Naruto - S05E17 (202).mkv',
          size: 476e6,
        },
        { index: 1, path: '[Judas] Naruto/S5/sample.mkv', size: 30e6 },
      ],
      JUDAS_PACK,
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
          path: '[Erai-raws] Naruto Shippuuden - 080 [1080p].mkv',
          size: 500e6,
        },
      ],
      '[Erai-raws] Naruto Shippuuden - 080 ~ 500 [1080p]',
      ctx()
    );
    assert.equal(plan[0].action, 'reject');
    assert.equal(plan[0].reason, 'Named as another show: Naruto Shippuuden');
  });
});

describe('Backfill: a two-part finale the scene numbers as one', () => {
  // Blue Mountain State S03: the scene's S03E12 is TVDB's E12 and E13, as
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
      title: 'Blue Mountain State',
      year: 2010,
      tvdbId: 134511,
      seriesType: 'standard',
      qualityProfileId: 13,
      path: '/tv/Blue Mountain State',
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
    names: ['Blue Mountain State'],
    sonarr: {
      parse: async (title: string) => ({
        title,
        parsedEpisodeInfo: {
          seriesTitle: 'Blue Mountain State (2010)',
          quality: q(3, 'WEBDL-1080p'),
          seasonNumber: 3,
          episodeNumbers: [/S03E12/.test(title) ? 12 : 13],
          releaseGroup: 'Panda',
        },
        series: { id: 1243, title: 'Blue Mountain State' },
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
          path: 'Blue Mountain State (2010) - S03E12 - The Corn Field (1) (1080p WEB-DL x265 Panda).mkv',
          size: 627e6,
        },
        {
          index: 12,
          path: 'Blue Mountain State (2010) - S03E13 - The Corn Field (2) (1080p WEB-DL x265 Panda).mkv',
          size: 627e6,
        },
      ],
      'Blue Mountain State (2010) Season 3 S03 (1080p WEB-DL x265 Panda)',
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
          path: 'Blue Mountain State (2010) - S03E12 - The Corn Field (1080p WEB-DL x265 Panda).mkv',
          size: 1.2e9,
        },
      ],
      'Blue Mountain State (2010) S03E12 (1080p WEB-DL x265 Panda)',
      ctx()
    );
    assert.deepEqual([...plan[0].episodeIds].sort(), [142107, 142108]);
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
    title: 'The Battle Begins: Naruto vs. Sasuke',
    hasFile: false,
    monitored: true,
    episodeFileId: 0,
  };
  const festival = special(
    145157,
    3,
    'Naruto OVA 3: Hidden Leaf Village Grand Sports Festival'
  );
  const clover = special(
    145155,
    1,
    'Naruto OVA: Find the Crimson Four-Leaf Clover!'
  );

  /** Answers Sonarr gave on the live server for these exact names. */
  const sonarrAnswers: Record<string, SonarrParseResult> = {
    '[Judas] Naruto - Hidden Leaf Village Grand Sports Festival': {
      title: '[Judas] Naruto - Hidden Leaf Village Grand Sports Festival',
      customFormatScore: 0,
    },
    '[Judas] Naruto - Crimson Clover': {
      title: '[Judas] Naruto - Crimson Clover',
      customFormatScore: 0,
    },
    '[Judas] Naruto - S00E03 [BD 1080p][HEVC x265 10bit][Multi-Audio][Multi-Subs]':
      {
        title: '',
        parsedEpisodeInfo: {
          seriesTitle: 'Naruto',
          quality: q(7, 'Bluray-1080p'),
          seasonNumber: 0,
          episodeNumbers: [3],
          releaseGroup: 'Judas',
        },
        series: { id: 1279, title: 'Naruto' },
        episodes: [{ ...festival }],
        languages: [{ id: 8, name: 'Japanese' }],
        customFormatScore: 700,
      },
    // Sonarr maps the clover file to a different special than the one the
    // model names, so the model's match is turned down.
    '[Judas] Naruto - S00E01 [BD 1080p][HEVC x265 10bit][Multi-Audio][Multi-Subs]':
      {
        title: '',
        parsedEpisodeInfo: {
          seriesTitle: 'Naruto',
          quality: q(7, 'Bluray-1080p'),
          seasonNumber: 0,
          episodeNumbers: [1],
          releaseGroup: 'Judas',
        },
        series: { id: 1279, title: 'Naruto' },
        episodes: [{ ...festival }],
        customFormatScore: 700,
      },
  };

  const context = (
    secondOpinion?: SeriesContext['secondOpinion']
  ): SeriesContext => ({
    series: {
      id: 1279,
      title: 'Naruto',
      year: 2002,
      tvdbId: 78857,
      seriesType: 'anime',
      qualityProfileId: 13,
      path: '/anime/Naruto',
    },
    episodes: [ep202, festival, clover],
    files: [],
    profile: ANIME_1080P,
    names: ['Naruto'],
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
    path: '[Judas] Naruto/Specials/[Judas] Naruto - Hidden Leaf Village Grand Sports Festival.mkv',
    size: 300e6,
  };

  it('places a file named only by its title, as the model read it, once Sonarr agrees', async () => {
    let asked: Parameters<NonNullable<SeriesContext['secondOpinion']>>[0];
    const { plan, summary } = await judgePack(
      [FESTIVAL_FILE],
      JUDAS_PACK,
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
      '[Judas] Naruto - Hidden Leaf Village Grand Sports Festival'
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
          path: '[Judas] Naruto/Specials/[Judas] Naruto - Crimson Clover.mkv',
          size: 300e6,
        },
      ],
      JUDAS_PACK,
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
      JUDAS_PACK,
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
      JUDAS_PACK,
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
