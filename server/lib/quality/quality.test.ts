import { getRepository } from '@server/datasource';
import QualityApply from '@server/entity/QualityApply';
import QualityGrabNote from '@server/entity/QualityGrabNote';
import QualityManaged from '@server/entity/QualityManaged';
import QualityStepDown from '@server/entity/QualityStepDown';
import type {
  ArrCustomFormat,
  ArrQualityProfile,
} from '@server/lib/autofix/arr';
import { BLOCK_FORMAT_NAME } from '@server/lib/blockedGroups';
import type {
  ArrDelayProfile,
  ArrGrab,
  ArrProfileItem,
  ArrTitle,
} from '@server/lib/quality/arr';
import { QualityArr } from '@server/lib/quality/arr';
import type { ServerFacts } from '@server/lib/quality/build';
import { band, buildDesired, materialize } from '@server/lib/quality/build';
import { runQualityCheck } from '@server/lib/quality/check';
import {
  describe as describeProfile,
  recentGrabs,
  tryName,
} from '@server/lib/quality/describe';
import type { QualityError } from '@server/lib/quality/engine';
import {
  apply,
  configFor,
  keepChanges,
  preview,
  stateOf,
  undo,
} from '@server/lib/quality/engine';
import { noteGrab } from '@server/lib/quality/notes';
import { LAST_RESORT, NEVER } from '@server/lib/quality/presets';
import { runStepDown } from '@server/lib/quality/stepDown';
import type { TrashData } from '@server/lib/quality/trash';
import * as trashModule from '@server/lib/quality/trash';
import {
  TRASH_PROFILES,
  setTrashDataForTests,
  trashProfileFormats,
} from '@server/lib/quality/trash';
import type { ArrKind, QualityServerSettings } from '@server/lib/quality/types';
import { serverDefaults } from '@server/lib/quality/types';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * Quality profiles: how a server's choices become profiles and formats,
 * and applying, undoing, change checks and the step-down against a
 * stand-in that keeps profiles, formats and titles the way Radarr and
 * Sonarr do.
 */

setupTestDb();

// Every quality, lowest first, as Radarr's and Sonarr's empty profiles
// lay them out (the WEB pairs grouped).
const QUALITIES: Record<ArrKind, [number, string][]> = {
  radarr: [
    [0, 'Unknown'],
    [25, 'CAM'],
    [1, 'SDTV'],
    [2, 'DVD'],
    [8, 'WEBDL-480p'],
    [12, 'WEBRip-480p'],
    [20, 'Bluray-480p'],
    [21, 'Bluray-576p'],
    [4, 'HDTV-720p'],
    [5, 'WEBDL-720p'],
    [14, 'WEBRip-720p'],
    [6, 'Bluray-720p'],
    [9, 'HDTV-1080p'],
    [3, 'WEBDL-1080p'],
    [15, 'WEBRip-1080p'],
    [7, 'Bluray-1080p'],
    [30, 'Remux-1080p'],
    [16, 'HDTV-2160p'],
    [18, 'WEBDL-2160p'],
    [17, 'WEBRip-2160p'],
    [19, 'Bluray-2160p'],
    [31, 'Remux-2160p'],
  ],
  sonarr: [
    [0, 'Unknown'],
    [1, 'SDTV'],
    [2, 'DVD'],
    [8, 'WEBDL-480p'],
    [12, 'WEBRip-480p'],
    [13, 'Bluray-480p'],
    [22, 'Bluray-576p'],
    [4, 'HDTV-720p'],
    [5, 'WEBDL-720p'],
    [14, 'WEBRip-720p'],
    [6, 'Bluray-720p'],
    [9, 'HDTV-1080p'],
    [3, 'WEBDL-1080p'],
    [15, 'WEBRip-1080p'],
    [7, 'Bluray-1080p'],
    [20, 'Bluray-1080p Remux'],
    [16, 'HDTV-2160p'],
    [18, 'WEBDL-2160p'],
    [17, 'WEBRip-2160p'],
    [19, 'Bluray-2160p'],
    [21, 'Bluray-2160p Remux'],
  ],
};

const template = (kind: ArrKind, sizes = false): ArrQualityProfile => {
  const items: ArrProfileItem[] = [];
  let group = 1000;
  const list = QUALITIES[kind];
  for (let i = 0; i < list.length; i++) {
    const [id, name] = list[i];
    const leaf = (qid: number, qname: string): ArrProfileItem => ({
      quality: { id: qid, name: qname },
      items: [],
      allowed: false,
      ...(sizes ? { minSize: 0, maxSize: 1000, preferredSize: 995 } : {}),
    });
    const web = /^WEBDL-(\d+p)$/.exec(name);
    if (web && list[i + 1]?.[1] === `WEBRip-${web[1]}`) {
      items.push({
        id: group++,
        name: `WEB ${web[1]}`,
        allowed: false,
        items: [leaf(id, name), leaf(list[i + 1][0], list[i + 1][1])],
      });
      i += 1;
    } else {
      items.push(leaf(id, name));
    }
  }
  return {
    id: 0,
    name: '',
    upgradeAllowed: false,
    cutoff: 0,
    items,
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    formatItems: [],
    ...(kind === 'radarr' ? { language: { id: -2, name: 'Original' } } : {}),
  };
};

/** A Radarr or Sonarr that keeps its profiles, formats and titles in memory. */
const standIn = (
  kind: ArrKind,
  options: { version?: string; sizes?: boolean } = {}
) => {
  let nextProfile = 10;
  let nextFormat = 100;
  const state = {
    profiles: [
      {
        ...template(kind, options.sizes),
        id: 1,
        name: 'Admin’s own',
      } as ArrQualityProfile,
    ],
    formats: [
      { id: 7, name: 'Admin’s format', specifications: [] },
    ] as ArrCustomFormat[],
    delays: [
      {
        id: 1,
        enableUsenet: true,
        enableTorrent: true,
        preferredProtocol: 'torrent',
        usenetDelay: 0,
        torrentDelay: 0,
        order: 2147483647,
        tags: [],
      },
    ] as ArrDelayProfile[],
    titles: [] as (ArrTitle & { searched?: boolean })[],
    grabs: [] as ArrGrab[],
    parsed: { quality: 'WEBDL-1080p', languages: ['English'], formats: [] } as {
      quality?: string;
      languages: string[];
      formats: { id: number; name: string }[];
    },
    calls: [] as string[],
  };
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  // A new format lands in every profile at 0, as the apps do.
  const addToProfiles = (format: ArrCustomFormat) => {
    for (const p of state.profiles) {
      p.formatItems = [
        ...(p.formatItems ?? []),
        { format: format.id as number, name: format.name, score: 0 },
      ];
    }
  };
  const fake = {
    kind,
    version: async () =>
      options.version ?? (kind === 'radarr' ? '5.2.0' : '4.0.9'),
    template: async () => clone(template(kind, options.sizes)),
    profiles: async () => clone(state.profiles),
    createProfile: async (p: ArrQualityProfile) => {
      state.calls.push(`create profile ${p.name}`);
      const saved = { ...clone(p), id: nextProfile++ } as ArrQualityProfile;
      state.profiles.push(saved);
      return clone(saved);
    },
    saveProfile: async (p: ArrQualityProfile) => {
      state.calls.push(`save profile ${p.id}`);
      const at = state.profiles.findIndex((x) => x.id === p.id);
      state.profiles[at] = clone(p);
      return clone(p);
    },
    deleteProfile: async (id: number) => {
      state.calls.push(`delete profile ${id}`);
      state.profiles = state.profiles.filter((p) => p.id !== id);
    },
    formats: async () => clone(state.formats),
    saveFormat: async (f: ArrCustomFormat) => {
      // Format names are unique in the apps.
      if (state.formats.some((x) => x.name === f.name && x.id !== f.id)) {
        throw new Error(`${f.name}: must be unique`);
      }
      state.calls.push(
        f.id ? `save format ${f.id}` : `create format ${f.name}`
      );
      if (f.id) {
        const at = state.formats.findIndex((x) => x.id === f.id);
        state.formats[at] = clone(f);
        return clone(f);
      }
      const saved = { ...clone(f), id: nextFormat++ };
      state.formats.push(saved);
      addToProfiles(saved);
      return clone(saved);
    },
    deleteFormat: async (id: number) => {
      state.calls.push(`delete format ${id}`);
      state.formats = state.formats.filter((f) => f.id !== id);
      for (const p of state.profiles) {
        p.formatItems = (p.formatItems ?? []).filter((i) => i.format !== id);
      }
    },
    delayProfiles: async () => clone(state.delays),
    saveDelayProfile: async (d: ArrDelayProfile) => {
      state.calls.push('save delay');
      state.delays = state.delays.map((x) => (x.id === d.id ? clone(d) : x));
    },
    parse: async () => clone(state.parsed),
    grabs: async () => clone(state.grabs),
    titles: async () => clone(state.titles),
    moveTitles: async (ids: number[], profileId: number) => {
      if (!state.profiles.some((p) => p.id === profileId)) {
        throw new Error(`No profile ${profileId}`);
      }
      state.calls.push(`move ${ids.join(',')} to ${profileId}`);
      for (const t of state.titles)
        if (ids.includes(t.id)) t.profileId = profileId;
    },
    search: async (ids: number[]) => {
      for (const t of state.titles) if (ids.includes(t.id)) t.searched = true;
    },
  };
  return { fake: fake as unknown as QualityArr, state };
};

const RADARR = { kind: 'radarr' as const, serverId: 0 };
const SONARR = { kind: 'sonarr' as const, serverId: 0 };

const manage = (
  kind: ArrKind,
  change: (s: QualityServerSettings) => void = () => undefined
) => {
  const config = serverDefaults(kind, 0, false);
  config.managed = true;
  change(config);
  const settings = getSettings();
  settings.quality = {
    ...settings.quality,
    servers: [
      ...settings.quality.servers.filter((s) => s.kind !== kind),
      config,
    ],
  };
};

let radarr: ReturnType<typeof standIn>;
let sonarr: ReturnType<typeof standIn>;

beforeEach(() => {
  const settings = getSettings();
  settings.radarr = [
    {
      id: 0,
      name: 'Radarr',
      hostname: 'radarr',
      activeProfileId: 1,
      is4k: false,
    } as unknown as RadarrSettings,
  ];
  settings.sonarr = [
    {
      id: 0,
      name: 'Sonarr',
      hostname: 'sonarr',
      activeProfileId: 1,
      is4k: false,
    } as unknown as SonarrSettings,
  ];
  settings.quality = {
    trash: { autoApply: false, fillGaps: true },
    servers: [],
  };
  settings.backfill = {
    ...settings.backfill,
    stepDown: { enabled: false, days: 30 },
  };
  mock.method(settings, 'save', async () => undefined);
  radarr = standIn('radarr');
  sonarr = standIn('sonarr', { version: '5.0.0', sizes: true });
  mock.method(QualityArr, 'forServer', (ref: { kind: ArrKind }) =>
    ref.kind === 'radarr' ? radarr.fake : sonarr.fake
  );
  setTrashDataForTests(null);
  // TRaSH Guides is never fetched here: tests hand it their own copy.
  mock.method(trashModule, 'readTrashState', async () => ({
    blobs: {},
    commit: 'abc1234',
    checkedAt: new Date().toISOString(),
  }));
  mock.method(trashModule, 'refreshTrash', async () => ({ blobs: {} }));
  mock.method(trashModule, 'refreshTrashIfOlder', async () => ({
    blobs: {},
  }));
});

afterEach(() => {
  mock.restoreAll();
  setTrashDataForTests(null);
});

const facts = (kind: ArrKind, sizes = false): ServerFacts => ({
  kind,
  template: template(kind, sizes),
  sizesOnProfile: sizes,
});

const config = (
  kind: ArrKind,
  change: (s: QualityServerSettings) => void = () => undefined
) => {
  const c = serverDefaults(kind, 0, false);
  c.managed = true;
  change(c);
  return c;
};

describe('the bands', () => {
  it('round to the step, halves down, and leave last resorts and nothing alone', () => {
    assert.equal(band(1750, 100), 1700);
    assert.equal(band(1751, 100), 1800);
    assert.equal(band(1800, 100), 1800);
    assert.equal(band(5, 100), 0);
    assert.equal(band(-50, 100), 0);
    assert.equal(band(-120, 100), -100);
    assert.equal(band(1750, 500), 1500);
    assert.equal(band(LAST_RESORT, 100), LAST_RESORT);
    assert.equal(band(NEVER, 100), NEVER);
    assert.equal(band(0, 100), 0);
  });
});

describe("Seerr AI's own presets", () => {
  it('build the chosen presets only, with ladders in each app’s names', () => {
    const radarrBuilt = buildDesired(
      config('radarr', (c) => {
        c.presets = { '1080p-remux': 'seerr', sd: 'off', anime: 'seerr' };
      }),
      facts('radarr'),
      null,
      true
    );
    assert.deepEqual(
      radarrBuilt.profiles.map((p) => p.name),
      ['Seerr AI · 1080p Remux', 'Seerr AI · Anime']
    );
    assert.equal(radarrBuilt.profiles[0].ladder.cutoff, 'Remux-1080p');
    const sonarrBuilt = buildDesired(
      config('sonarr', (c) => {
        c.presets = { '1080p-remux': 'seerr', '1080p': 'seerr' };
      }),
      facts('sonarr'),
      null,
      true
    );
    assert.equal(sonarrBuilt.profiles[0].ladder.cutoff, 'WEB 1080p');
    assert.equal(sonarrBuilt.profiles[1].ladder.cutoff, 'Bluray-1080p Remux');
  });

  it('score the formats from the adjustments, and round small ones away', () => {
    const built = buildDesired(config('radarr'), facts('radarr'), null, true);
    const p1080 = built.profiles.find((p) => p.preset === '1080p');
    assert.ok(p1080);
    const score = (key: string) =>
      p1080.formats.find((f) => f.key === key)?.score;
    assert.equal(score('seerr:x265-hd'), NEVER);
    assert.equal(score('seerr:upscaled'), NEVER);
    assert.equal(score('seerr:language'), NEVER);
    assert.equal(score('seerr:burned-in'), LAST_RESORT);
    assert.equal(score('seerr:size-15'), LAST_RESORT);
    // Repack's 5 is rounded to the band: it can't beat usenet.
    assert.equal(score('seerr:repack'), 0);
    assert.equal(p1080.minUpgradeFormatScore, 100);
    // Movies: no multi-episode format.
    assert.equal(score('seerr:multi-episode'), undefined);
    const anime = built.profiles.find((p) => p.preset === 'anime');
    assert.equal(
      anime?.formats.find((f) => f.key === 'seerr:dual-audio')?.score,
      1000
    );
  });

  it('keep exact scores with no usenet preference, and follow the other choices', () => {
    const built = buildDesired(
      config('sonarr', (c) => {
        c.presets = { '2160p': 'seerr' };
        c.adjustments.preferUsenet = 'none';
        c.adjustments.hdr = false;
        c.adjustments.languages = 'any';
        c.adjustments.singleEpisodes = true;
      }),
      facts('sonarr'),
      null,
      true
    );
    const profile = built.profiles[0];
    const score = (key: string) =>
      profile.formats.find((f) => f.key === key)?.score;
    assert.equal(score('seerr:repack'), 5);
    assert.equal(score('seerr:hdr'), 0);
    assert.equal(score('seerr:language'), undefined);
    assert.equal(score('seerr:multi-episode'), LAST_RESORT);
    assert.equal(built.delay, null);
    assert.equal(profile.minUpgradeFormatScore, 1);
  });

  it('move single formats a band, or never take them', () => {
    const built = buildDesired(
      config('radarr', (c) => {
        c.presets = { '1080p': 'seerr' };
        c.bandStep = 250;
        c.nudges = { 'seerr:repack': 'up', 'seerr:burned-in': 'never' };
      }),
      facts('radarr'),
      null,
      true
    );
    const formats = built.profiles[0].formats;
    assert.equal(formats.find((f) => f.key === 'seerr:repack')?.score, 250);
    assert.equal(
      formats.find((f) => f.key === 'seerr:burned-in')?.score,
      NEVER
    );
  });

  it('ask the delay profile to prefer usenet, and to hold torrents when told to', () => {
    const equal = buildDesired(config('radarr'), facts('radarr'), null, true);
    assert.deepEqual(equal.delay, {
      preferredProtocol: 'usenet',
      torrentDelay: null,
    });
    const always = buildDesired(
      config('radarr', (c) => {
        c.adjustments.preferUsenet = 'always';
        c.adjustments.torrentWaitHours = 3;
      }),
      facts('radarr'),
      null,
      true
    );
    assert.deepEqual(always.delay, {
      preferredProtocol: 'usenet',
      torrentDelay: 180,
    });
  });

  it('cap Sonarr v5 sizes per quality from the file size choice', () => {
    const built = buildDesired(
      config('sonarr', (c) => {
        c.presets = { '1080p': 'seerr' };
        c.adjustments.fileSize = 'small';
      }),
      facts('sonarr', true),
      null,
      true
    );
    const sizes = built.profiles[0].sizes ?? [];
    assert.ok(sizes.length);
    assert.ok(sizes.every((s) => s.max === 25 && s.preferred <= s.max));
    assert.equal(built.profiles[0].sizeCapGb, undefined);
  });
});

describe('a profile laid out for the app', () => {
  it('has every quality once, the preset’s in its order on top, and the cutoff by id', () => {
    const built = buildDesired(config('radarr'), facts('radarr'), null, true);
    const profile = built.profiles.find((p) => p.preset === '1080p');
    assert.ok(profile);
    const ids = new Map(built.formats.map((f, i) => [f.key, 200 + i]));
    const formats = [
      ...built.formats.map((f, i) => ({ ...f.format, id: 200 + i })),
      { id: 7, name: 'Admin’s format', specifications: [] },
    ];
    const body = materialize(profile, facts('radarr'), ids, formats, new Map());
    const flat = (items: ArrProfileItem[]): string[] =>
      items.flatMap((i) => (i.quality ? [i.quality.name] : flat(i.items)));
    const names = flat(body.items);
    assert.equal(names.length, QUALITIES.radarr.length);
    assert.equal(new Set(names).size, names.length);
    const top = body.items.slice(-3);
    assert.deepEqual(
      top.map((i) => i.quality?.name ?? i.name),
      ['HDTV-1080p', 'WEB 1080p', 'Bluray-1080p']
    );
    assert.ok(top.every((i) => i.allowed));
    assert.equal(body.cutoff, 7);
    assert.deepEqual(body.language, { id: -1, name: 'Any' });
    // Every format on the server is listed; the admin's own at 0.
    assert.equal(body.formatItems.length, formats.length);
    assert.equal(body.formatItems.find((f) => f.format === 7)?.score, 0);
    const web = top[1];
    assert.ok(web.id !== undefined && web.id >= 1000);
    assert.deepEqual(
      web.items.map((i) => i.quality?.name),
      ['WEBDL-1080p', 'WEBRip-1080p']
    );
  });
});

/** A small TRaSH Guides, in the shape it publishes. */
const trashFixture = (): TrashData => {
  const app = (kind: ArrKind) => {
    const id1080 = TRASH_PROFILES[kind]['1080p'] as string;
    const tier = (n: number, score: number) => ({
      trash_id: `tier${n}`,
      name: `WEB Tier 0${n}`,
      trash_scores: { default: score },
      specifications: [
        {
          name: 'Group',
          implementation: 'ReleaseGroupSpecification',
          negate: false,
          required: false,
          fields: { value: `^(GROUP${n})$` },
        },
      ],
    });
    return {
      formats: Object.fromEntries(
        [
          tier(1, 1800),
          tier(2, 1750),
          {
            trash_id:
              kind === 'radarr'
                ? 'dc98083864ea246d05a42df0d05f81cc'
                : '47435ece6b99a0b477caf360e79ba0bb',
            name: 'x265 (HD)',
            trash_scores: { default: -10000 },
            specifications: [],
          },
          {
            trash_id: 'lq',
            name: 'LQ',
            trash_scores: { default: -10000 },
            specifications: [],
          },
          {
            trash_id:
              kind === 'radarr'
                ? 'cae4ca30163749b891686f95532519bd'
                : '15a05bc7c1a36e2b57fd628f8977e2fc',
            name: 'AV1',
            trash_scores: { default: -10000 },
            specifications: [],
          },
          {
            trash_id: 'sdr',
            name: 'SDR',
            trash_scores: { default: 0 },
            specifications: [],
          },
        ].map((f) => [f.trash_id, f])
      ),
      profiles: {
        [id1080]: {
          trash_id: id1080,
          name: 'HD Bluray + WEB',
          upgradeAllowed: true,
          cutoff: 'Bluray-1080p',
          minFormatScore: 0,
          cutoffFormatScore: 10000,
          minUpgradeFormatScore: 1,
          items: [
            { name: 'Bluray-1080p', allowed: true },
            {
              name: 'WEB 1080p',
              allowed: true,
              items: ['WEBRip-1080p', 'WEBDL-1080p'],
            },
          ],
          formatItems: { 'WEB Tier 01': 'tier1', 'WEB Tier 02': 'tier2' },
        },
      },
      groups: [
        {
          name: '[Unwanted] Unwanted Formats',
          trash_id: 'g1',
          default: true,
          custom_formats: [
            { name: 'LQ', trash_id: 'lq', required: false, default: true },
            {
              name: 'AV1',
              trash_id:
                kind === 'radarr'
                  ? 'cae4ca30163749b891686f95532519bd'
                  : '15a05bc7c1a36e2b57fd628f8977e2fc',
              required: false,
              default: true,
            },
            { name: 'Scene', trash_id: 'scene', required: false },
          ],
          quality_profiles: { include: { 'HD Bluray + WEB': id1080 } },
        },
        {
          name: '[Optional] Golden Rule HD',
          trash_id: 'g2',
          default: true,
          custom_formats: [
            {
              name: 'x265 (HD)',
              trash_id:
                kind === 'radarr'
                  ? 'dc98083864ea246d05a42df0d05f81cc'
                  : '47435ece6b99a0b477caf360e79ba0bb',
              required: false,
              default: true,
            },
          ],
          quality_profiles: { include: { 'HD Bluray + WEB': id1080 } },
        },
        {
          name: '[Optional] Not by default',
          trash_id: 'g3',
          custom_formats: [{ name: 'SDR', trash_id: 'sdr', required: true }],
          quality_profiles: { include: { 'HD Bluray + WEB': id1080 } },
        },
      ],
      conflicts: [['tier1', 'tier2']],
      sizes: {},
    };
  };
  return { commit: 'abc1234', radarr: app('radarr'), sonarr: app('sonarr') };
};

describe('TRaSH Guides presets', () => {
  it('take a profile’s own formats and those of groups on by default', () => {
    const trash = trashFixture();
    const id = TRASH_PROFILES.radarr['1080p'] as string;
    const ids = trashProfileFormats(
      trash.radarr,
      trash.radarr.profiles[id]
    ).map((f) => f.trashId);
    assert.deepEqual(ids, [
      'tier1',
      'tier2',
      'lq',
      'cae4ca30163749b891686f95532519bd',
      'dc98083864ea246d05a42df0d05f81cc',
    ]);
  });

  it('use TRaSH scores, bands, never for -10000, and fill SD and 720p in', () => {
    const built = buildDesired(
      config('radarr', (c) => {
        c.presets = { sd: 'trash', '1080p': 'trash' };
      }),
      facts('radarr'),
      trashFixture(),
      true
    );
    assert.deepEqual(
      built.profiles.map((p) => [p.preset, p.source, p.filledIn]),
      [
        ['sd', 'seerr', true],
        ['1080p', 'trash', false],
      ]
    );
    const p = built.profiles[1];
    const by = (name: string) =>
      p.formats.find((f) => f.name === `Seerr AI · ${name}`);
    assert.equal(by('WEB Tier 01')?.score, 1800);
    // Tier 2 rounds to 1700 … and conflicts with tier 1, so it is dropped.
    assert.equal(by('WEB Tier 02')?.score, 0);
    assert.ok(by('WEB Tier 02')?.changes.some((c) => c.kind === 'conflict'));
    assert.equal(by('LQ')?.score, NEVER);
    assert.equal(by('x265 (HD)')?.score, NEVER);
    // Gaps filled beside TRaSH: burned-in subtitles.
    assert.ok(p.formats.some((f) => f.key === 'seerr:burned-in'));
    assert.equal(p.ladder.cutoff, 'Bluray-1080p');
  });

  it('follow x265 allowed, and leave gaps unfilled when told to', () => {
    const built = buildDesired(
      config('radarr', (c) => {
        c.presets = { sd: 'trash', '1080p': 'trash' };
        c.adjustments.x265At1080p = true;
      }),
      facts('radarr'),
      trashFixture(),
      false
    );
    assert.deepEqual(built.skipped, [{ preset: 'sd', reason: 'no-trash' }]);
    const p = built.profiles[0];
    assert.equal(
      p.formats.find((f) => f.name === 'Seerr AI · x265 (HD)')?.score,
      0
    );
    assert.ok(!p.formats.some((f) => f.key === 'seerr:burned-in'));
  });

  it('make AV1 a last resort, or take it, as the AV1 adjustment says', () => {
    const av1 = (lastResort: boolean, source: 'seerr' | 'trash') =>
      buildDesired(
        config('radarr', (c) => {
          c.presets = { '1080p': source };
          c.adjustments.av1LastResort = lastResort;
        }),
        facts('radarr'),
        trashFixture(),
        true
      ).profiles[0].formats.find((f) => /AV1/.test(f.name));
    assert.equal(av1(true, 'seerr')?.score, LAST_RESORT);
    assert.equal(av1(false, 'seerr')?.score, 0);
    // TRaSH Guides never takes AV1; the adjustment goes on top of it.
    assert.equal(av1(true, 'trash')?.score, LAST_RESORT);
    assert.deepEqual(av1(true, 'trash')?.changes, [
      { kind: 'av1', to: 'last-resort' },
    ]);
    assert.equal(av1(false, 'trash')?.score, 0);
    assert.equal(av1(false, 'trash')?.raw, -10000);
  });

  it('wait for TRaSH Guides to be fetched', () => {
    const built = buildDesired(
      config('radarr', (c) => {
        c.presets = { '1080p': 'trash' };
      }),
      facts('radarr'),
      null,
      true
    );
    assert.deepEqual(built.skipped, [
      { preset: '1080p', reason: 'trash-missing' },
    ]);
  });
});

describe('applying, undoing and changes made elsewhere', () => {
  it('does nothing to a server nobody manages', async () => {
    await assert.rejects(
      preview(RADARR),
      (e: QualityError) => e.code === 'not-managed'
    );
    assert.equal((await stateOf(RADARR)).status, 'not-managed');
    assert.equal(radarr.state.calls.length, 0);
  });

  it('previews, then creates only its own profiles and formats', async () => {
    manage('radarr');
    const before = await preview(RADARR);
    assert.equal(before.first, true);
    assert.ok(
      before.changes.some(
        (c) => c.itemKind === 'profile' && c.action === 'create'
      )
    );
    assert.deepEqual(
      before.ownProfiles.map((p) => p.name),
      ['Admin’s own']
    );
    assert.equal(radarr.state.calls.length, 0);

    const result = await apply(RADARR, { userId: 1 });
    assert.ok(result.applyId);
    assert.ok(result.created > 0);
    const names = radarr.state.profiles.map((p) => p.name);
    assert.deepEqual(names, [
      'Admin’s own',
      'Seerr AI · 1080p',
      'Seerr AI · Anime',
    ]);
    // The admin's own profile and format are untouched.
    assert.ok(!radarr.state.calls.includes('save profile 1'));
    assert.ok(!radarr.state.calls.some((c) => c.startsWith('save format 7')));
    // Usenet preferred in the delay profile.
    assert.equal(radarr.state.delays[0].preferredProtocol, 'usenet');
    assert.equal((await stateOf(RADARR)).status, 'in-sync');

    // Nothing left to do: a second apply changes nothing.
    radarr.state.calls.length = 0;
    const again = await apply(RADARR, { userId: 1 });
    assert.equal(again.applyId, null);
    assert.equal(radarr.state.calls.length, 0);
  });

  it('scores the blocked release groups format so nothing with it is taken', async () => {
    radarr.state.formats.push({
      id: 50,
      name: BLOCK_FORMAT_NAME,
      specifications: [],
    });
    manage('radarr');
    await apply(RADARR);
    const profile = radarr.state.profiles.find(
      (p) => p.name === 'Seerr AI · 1080p'
    );
    const block = profile?.formatItems?.find((f) => f.format === 50);
    assert.ok(block && block.score < (profile?.minFormatScore ?? 0));
  });

  it('notices a change made in the app, and keeps or puts it back', async () => {
    manage('radarr');
    await apply(RADARR);
    const profile = radarr.state.profiles.find(
      (p) => p.name === 'Seerr AI · 1080p'
    );
    assert.ok(profile);
    profile.cutoff = 3;
    const changed = await stateOf(RADARR);
    assert.equal(changed.status, 'changed');
    assert.deepEqual(changed.changed, [
      { name: 'Seerr AI · 1080p', removed: false },
    ]);

    assert.equal(await keepChanges(RADARR), 1);
    assert.equal((await stateOf(RADARR)).status, 'kept');
    radarr.state.calls.length = 0;
    await apply(RADARR);
    assert.ok(!radarr.state.calls.includes(`save profile ${profile.id}`));

    await apply(RADARR, { restoreKept: true });
    assert.equal(
      radarr.state.profiles.find((p) => p.id === profile.id)?.cutoff,
      7
    );
    assert.equal((await stateOf(RADARR)).status, 'in-sync');
  });

  it('says ready when choices changed, and puts back what an undo restores', async () => {
    manage('radarr');
    const first = await apply(RADARR);
    manage('radarr', (c) => {
      c.adjustments.x265At1080p = true;
    });
    assert.equal((await stateOf(RADARR)).status, 'ready');
    const second = await apply(RADARR);
    assert.ok(second.applyId);
    const x265 = () =>
      radarr.state.profiles
        .find((p) => p.name === 'Seerr AI · 1080p')
        ?.formatItems?.find(
          (f) => f.name === 'Seerr AI · x265 at 1080p or below'
        )?.score;
    assert.equal(x265(), 0);

    // Only the newest can be undone.
    await assert.rejects(
      undo(first.applyId as number),
      (e: QualityError) => e.code === 'undo-newer-first'
    );
    await undo(second.applyId as number);
    assert.equal(x265(), NEVER);
    // Undone, it no longer counts as a change made in the app.
    manage('radarr');
    assert.equal((await stateOf(RADARR)).status, 'in-sync');

    // The first undone removes what it created, and puts the delay back.
    await undo(first.applyId as number);
    assert.deepEqual(
      radarr.state.profiles.map((p) => p.name),
      ['Admin’s own']
    );
    assert.deepEqual(
      radarr.state.formats.map((f) => f.name),
      ['Admin’s format']
    );
    assert.equal(radarr.state.delays[0].preferredProtocol, 'torrent');
    assert.equal(await getRepository(QualityManaged).count(), 0);
    await assert.rejects(
      undo(first.applyId as number),
      (e: QualityError) => e.code === 'already-undone'
    );
  });

  it('keeps a profile on undo while titles or request settings use it', async () => {
    manage('radarr');
    radarr.state.titles = [
      {
        id: 1,
        title: 'A Made-Up Film',
        profileId: 1,
        hasFile: true,
        monitored: true,
        wanted: true,
      },
    ];
    const result = await apply(RADARR, {
      move: [{ fromProfileId: 1, preset: '1080p' }],
    });
    assert.equal(result.moved, 1);
    const ours = radarr.state.profiles.find(
      (p) => p.name === 'Seerr AI · 1080p'
    );
    assert.equal(radarr.state.titles[0].profileId, ours?.id);
    // Seerr AI's request settings now send titles to the anime preset.
    const anime = radarr.state.profiles.find(
      (p) => p.name === 'Seerr AI · Anime'
    );
    (getSettings().radarr[0] as RadarrSettings).activeAnimeProfileId =
      anime?.id;
    const undone = await undo(result.applyId as number);
    assert.equal(undone.movedBack, 1);
    assert.equal(radarr.state.titles[0].profileId, 1);
    assert.deepEqual(undone.keptInUse, ['Seerr AI · Anime']);
    assert.ok(radarr.state.profiles.some((p) => p.name === 'Seerr AI · Anime'));
    assert.ok(
      !radarr.state.profiles.some((p) => p.name === 'Seerr AI · 1080p')
    );
  });

  it('does nothing on Sonarr v3, which has no custom formats', async () => {
    sonarr = standIn('sonarr', { version: '3.0.10' });
    manage('sonarr');
    assert.equal((await stateOf(SONARR)).status, 'unsupported');
    await assert.rejects(
      apply(SONARR),
      (e: QualityError) => e.code === 'unsupported'
    );
  });

  it('applies Sonarr v5 sizes on the profile itself', async () => {
    manage('sonarr', (c) => {
      c.presets = { '1080p': 'seerr' };
      c.adjustments.fileSize = 'balanced';
    });
    await apply(SONARR);
    const profile = sonarr.state.profiles.find(
      (p) => p.name === 'Seerr AI · 1080p'
    );
    const flat = (items: ArrProfileItem[]): ArrProfileItem[] =>
      items.flatMap((i) => (i.quality ? [i] : flat(i.items)));
    const allowed = flat((profile?.items as ArrProfileItem[]) ?? []).filter(
      (i) => i.allowed
    );
    assert.ok(allowed.length);
    assert.ok(allowed.every((i) => i.maxSize === 45));
    assert.equal((await stateOf(SONARR)).sizesOnProfile, true);
  });

  it('applies TRaSH Guides updates on its own only when switched on', async () => {
    const trash = trashFixture();
    setTrashDataForTests(trash);
    manage('radarr', (c) => {
      c.presets = { '1080p': 'trash' };
    });
    await apply(RADARR);
    assert.equal((await stateOf(RADARR)).status, 'in-sync');
    // A newer TRaSH Guides changes tier 1.
    const next = trashFixture();
    next.commit = 'def5678';
    next.radarr.formats.tier1.trash_scores = { default: 2000 };
    setTrashDataForTests(next);
    assert.equal((await stateOf(RADARR)).status, 'update-ready');
    await runQualityCheck();
    assert.equal(await getRepository(QualityApply).count(), 1);
    getSettings().quality = {
      ...getSettings().quality,
      trash: { autoApply: true, fillGaps: true },
    };
    await runQualityCheck();
    const entries = await getRepository(QualityApply).find({
      order: { id: 'DESC' },
    });
    assert.equal(entries.length, 2);
    assert.equal(entries[0].summary.trash, true);
    assert.equal(entries[0].userId, null);
    assert.equal((await stateOf(RADARR)).status, 'in-sync');
  });

  it('points out a TRaSH Guides change to a format an admin moved', async () => {
    setTrashDataForTests(trashFixture());
    manage('radarr', (c) => {
      c.presets = { '1080p': 'trash' };
      c.nudges = { 'trash:tier1': 'down' };
    });
    await apply(RADARR);
    assert.deepEqual((await stateOf(RADARR)).clashes, []);
    const next = trashFixture();
    next.commit = 'def5678';
    next.radarr.formats.tier1.trash_scores = { default: 2000 };
    setTrashDataForTests(next);
    assert.deepEqual((await stateOf(RADARR)).clashes, [
      'Seerr AI · WEB Tier 01',
    ]);
  });
});

describe('applying only what was previewed, and undoing it whole', () => {
  it('names a TRaSH Guides format apart from a Seerr AI one of the same name', async () => {
    setTrashDataForTests(trashFixture());
    // SD is filled in by Seerr AI (its own AV1); 1080p has TRaSH's AV1.
    manage('radarr', (c) => {
      c.presets = { sd: 'trash', '1080p': 'trash' };
    });
    await apply(RADARR);
    const names = radarr.state.formats.map((f) => f.name);
    assert.ok(names.includes('Seerr AI · AV1'));
    assert.ok(names.includes('Seerr AI · AV1 (TRaSH Guides)'));
    assert.equal(new Set(names).size, names.length);
    assert.equal((await stateOf(RADARR)).status, 'in-sync');
  });
});

describe('what it does', () => {
  it('lays a preset out: qualities, bands, never, last resorts', async () => {
    manage('radarr');
    await apply(RADARR);
    const d = await describeProfile(RADARR, '1080p');
    assert.equal(d.applied, true);
    assert.deepEqual(
      d.qualities.map((q) => [q.name, q.goal, q.lowest]),
      [
        ['Bluray-1080p', true, false],
        ['WEB 1080p', false, false],
        ['HDTV-1080p', false, true],
      ]
    );
    assert.ok(d.notAllowed.includes('Remux-1080p'));
    assert.ok(!d.notAllowed.includes('CAM'));
    assert.ok(d.never.some((f) => f.key === 'seerr:x265-hd'));
    assert.ok(d.lastResort.some((f) => f.key === 'seerr:burned-in'));
    assert.ok(d.nothing.some((f) => f.key === 'seerr:repack'));
    assert.equal(d.sizeCapGb, 15);
    assert.equal(d.preferredProtocol, 'usenet');
  });

  it('tries a release name against the profile as it is in the app', async () => {
    manage('radarr');
    await apply(RADARR);
    const x265 = radarr.state.formats.find(
      (f) => f.name === 'Seerr AI · x265 at 1080p or below'
    );
    radarr.state.parsed = {
      quality: 'WEBDL-1080p',
      languages: ['Unknown'],
      formats: [{ id: x265?.id as number, name: x265?.name as string }],
    };
    const never = await tryName(
      RADARR,
      '1080p',
      'Made.Up.Film.2020.1080p.WEB-DL.x265-GROUP'
    );
    assert.deepEqual(never.result, {
      verdict: 'never',
      format: 'Seerr AI · x265 at 1080p or below',
    });
    assert.equal(never.languageUnknown, true);
    radarr.state.parsed = {
      quality: 'Remux-1080p',
      languages: ['English'],
      formats: [],
    };
    assert.deepEqual((await tryName(RADARR, '1080p', 'x')).result, {
      verdict: 'quality',
      quality: 'Remux-1080p',
    });
    radarr.state.parsed = {
      quality: 'Bluray-1080p',
      languages: ['English'],
      formats: [],
    };
    assert.deepEqual((await tryName(RADARR, '1080p', 'x')).result, {
      verdict: 'grab',
      score: 0,
    });
  });

  it('lists recent grabs, saying which Seerr AI made and what they beat', async () => {
    manage('radarr');
    await apply(RADARR);
    const ours = radarr.state.profiles.find(
      (p) => p.name === 'Seerr AI · 1080p'
    );
    radarr.state.grabs = [
      {
        title: 'Film.One.1080p.WEB-DL-GROUPA',
        date: '2026-10-30T10:00:00Z',
        score: 1700,
        protocol: 'usenet',
        profileId: ours?.id,
      },
      {
        title: 'Film.Two.1080p.WEB-DL-GROUPB',
        date: '2026-10-29T10:00:00Z',
        score: 1800,
        protocol: 'torrent',
        profileId: ours?.id,
      },
      {
        title: 'Other.Profile.1080p',
        date: '2026-10-28T10:00:00Z',
        score: 0,
        protocol: 'usenet',
        profileId: 1,
      },
    ];
    await noteGrab('radarr', 0, 'g1', [
      {
        guid: 'g1',
        indexerId: 1,
        title: 'Film.One.1080p.WEB-DL-GROUPA',
        protocol: 'usenet',
        customFormatScore: 1700,
        quality: { quality: { id: 3, name: 'WEBDL-1080p' } },
      },
      {
        guid: 'g2',
        indexerId: 2,
        title: 'Film.One.1080p.WEB-DL-GROUPC',
        protocol: 'torrent',
        customFormatScore: 1700,
        quality: { quality: { id: 3, name: 'WEBDL-1080p' } },
      },
    ]);
    const grabs = await recentGrabs(RADARR, '1080p');
    assert.deepEqual(
      grabs.map((g) => [g.title, g.bySeerr, g.wonTie]),
      [
        ['Film.One.1080p.WEB-DL-GROUPA', true, true],
        ['Film.Two.1080p.WEB-DL-GROUPB', false, false],
      ]
    );
    assert.equal(await getRepository(QualityGrabNote).count(), 1);
  });
});

describe('the step-down', () => {
  it('does nothing while off', async () => {
    manage('radarr', (c) => {
      c.presets = { '1080p': 'seerr', '720p': 'seerr' };
    });
    await apply(RADARR);
    const p1080 = radarr.state.profiles.find(
      (p) => p.name === 'Seerr AI · 1080p'
    );
    radarr.state.titles = [
      {
        id: 5,
        title: 'A Hard To Find Film',
        profileId: p1080?.id as number,
        hasFile: false,
        monitored: true,
        wanted: true,
        added: '2026-01-01T00:00:00Z',
      },
    ];
    radarr.state.calls.length = 0;
    assert.deepEqual(await runStepDown(), { down: 0, back: 0 });
    assert.equal(radarr.state.calls.length, 0);
  });

  it('moves a long-missing title down a preset, and back once it has a file', async () => {
    getSettings().backfill = {
      ...getSettings().backfill,
      stepDown: { enabled: true, days: 30 },
    };
    manage('radarr', (c) => {
      c.presets = { '1080p': 'seerr', '720p': 'seerr' };
    });
    await apply(RADARR);
    const p1080 = radarr.state.profiles.find(
      (p) => p.name === 'Seerr AI · 1080p'
    );
    const p720 = radarr.state.profiles.find(
      (p) => p.name === 'Seerr AI · 720p'
    );
    const old = '2026-01-01T00:00:00Z';
    radarr.state.titles = [
      {
        id: 5,
        title: 'A Hard To Find Film',
        profileId: p1080?.id as number,
        hasFile: false,
        monitored: true,
        wanted: true,
        added: old,
      },
      {
        id: 6,
        title: 'Has One Already',
        profileId: p1080?.id as number,
        hasFile: true,
        monitored: true,
        wanted: true,
        added: old,
      },
      {
        id: 7,
        title: 'Not Out Yet',
        profileId: p1080?.id as number,
        hasFile: false,
        monitored: true,
        wanted: false,
        added: old,
      },
      {
        id: 8,
        title: 'Added Today',
        profileId: p1080?.id as number,
        hasFile: false,
        monitored: true,
        wanted: true,
        added: new Date().toISOString(),
      },
    ];
    assert.deepEqual(await runStepDown(), { down: 1, back: 0 });
    assert.equal(radarr.state.titles[0].profileId, p720?.id);
    assert.equal(radarr.state.titles[0].searched, true);
    assert.ok(
      radarr.state.titles.slice(1).every((t) => t.profileId === p1080?.id)
    );
    assert.equal(await getRepository(QualityStepDown).count(), 1);

    radarr.state.titles[0].hasFile = true;
    assert.deepEqual(await runStepDown(), { down: 0, back: 1 });
    assert.equal(radarr.state.titles[0].profileId, p1080?.id);
    assert.equal(await getRepository(QualityStepDown).count(), 0);
  });

  it('goes on when a title’s own profile was removed', async () => {
    getSettings().backfill = {
      ...getSettings().backfill,
      stepDown: { enabled: true, days: 30 },
    };
    manage('radarr', (c) => {
      c.presets = { '1080p': 'seerr', '720p': 'seerr' };
    });
    await apply(RADARR);
    const p1080 = radarr.state.profiles.find(
      (p) => p.name === 'Seerr AI · 1080p'
    );
    const p720 = radarr.state.profiles.find(
      (p) => p.name === 'Seerr AI · 720p'
    );
    radarr.state.titles = [
      {
        id: 5,
        title: 'A Hard To Find Film',
        profileId: p1080?.id as number,
        hasFile: false,
        monitored: true,
        wanted: true,
        added: '2026-01-01T00:00:00Z',
      },
    ];
    await runStepDown();
    assert.equal(radarr.state.titles[0].profileId, p720?.id);
    // The admin removes the 1080p profile; the film turns up meanwhile.
    radarr.state.profiles = radarr.state.profiles.filter(
      (p) => p.id !== p1080?.id
    );
    radarr.state.titles[0].hasFile = true;
    assert.deepEqual(await runStepDown(), { down: 0, back: 0 });
    assert.equal(radarr.state.titles[0].profileId, p720?.id);
    assert.equal(await getRepository(QualityStepDown).count(), 0);
  });
});

describe('a server’s choices', () => {
  it('start not managed, with presets by whether the server is 4K', () => {
    const plain = configFor(RADARR);
    assert.equal(plain.managed, false);
    assert.deepEqual(plain.presets, { '1080p': 'seerr', anime: 'seerr' });
    getSettings().radarr[0].is4k = true;
    assert.deepEqual(configFor(RADARR).presets, { '2160p': 'seerr' });
  });
});
