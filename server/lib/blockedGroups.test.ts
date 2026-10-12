import type {
  ArrCustomFormat,
  ArrExtras,
  ArrQualityProfile,
} from '@server/lib/autofix/arr';
import { FixRadarr, FixSonarr } from '@server/lib/autofix/arr';
import {
  BLOCK_FORMAT_NAME,
  blockFormat,
  blockScore,
  blockedGroupOf,
  setGroupBlocked,
  syncBlockedGroups,
} from '@server/lib/blockedGroups';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * Blocked release groups: which releases they catch, the custom format and
 * scores Radarr and Sonarr are given, and keeping each server in line,
 * against stand-ins that keep formats and profiles the way the apps do.
 */

/** A Radarr or Sonarr that keeps custom formats and profiles in memory. */
const standIn = (profiles: ArrQualityProfile[], failing = false) => {
  const formats: ArrCustomFormat[] = [
    { id: 7, name: 'Admin’s own format', specifications: [] },
  ];
  let nextId = 100;
  const calls: string[] = [];
  const api = {
    customFormats: async () => {
      if (failing) throw new Error('connect ECONNREFUSED');
      return formats.map((f) => ({ ...f }));
    },
    saveCustomFormat: async (format: ArrCustomFormat) => {
      calls.push(format.id ? `put ${format.id}` : 'post');
      const saved = { ...format, id: format.id ?? nextId++ };
      const at = formats.findIndex((f) => f.id === saved.id);
      if (at >= 0) formats[at] = saved;
      else formats.push(saved);
      return saved;
    },
    deleteCustomFormat: async (id: number) => {
      calls.push(`delete ${id}`);
      formats.splice(
        formats.findIndex((f) => f.id === id),
        1
      );
      // As the apps do: a deleted format's scores go with it.
      for (const p of profiles) {
        p.formatItems = (p.formatItems ?? []).filter((i) => i.format !== id);
      }
    },
    qualityProfiles: async () =>
      profiles.map((p) => ({ ...p, formatItems: [...(p.formatItems ?? [])] })),
    saveQualityProfile: async (profile: ArrQualityProfile) => {
      calls.push(`profile ${profile.id}`);
      const at = profiles.findIndex((p) => p.id === profile.id);
      profiles[at] = profile;
    },
  } as unknown as ArrExtras;
  return { api, formats, profiles, calls };
};

beforeEach(() => {
  const settings = getSettings();
  settings.backfill = { ...settings.backfill, blockedGroups: [] };
  settings.radarr = [
    { id: 0, name: 'Radarr', hostname: 'radarr' } as unknown as RadarrSettings,
  ];
  settings.sonarr = [
    { id: 0, name: 'Sonarr', hostname: 'sonarr' } as unknown as SonarrSettings,
  ];
  mock.method(settings, 'save', async () => undefined);
});

afterEach(() => mock.restoreAll());

describe('blocked release groups', () => {
  it('catches a group by what was read, or as a word of the title, nothing else', () => {
    const blocked = ['rothebehap', 'turkseed', 'Flux.X'];
    const of = (title: string, group?: string) =>
      blockedGroupOf(title, group, blocked);
    assert.equal(
      of('The.Odyssey.2026.720p.WEB-DL.AAC.x264-rothebehap'),
      'rothebehap'
    );
    assert.equal(
      of('The Odyssey (2026) 1080p WEBDL H264 [EN TR SUB] AAC #turkseed'),
      'turkseed'
    );
    assert.equal(of('Movie 2026 x264 ROTHEBEHAP mp4'), 'rothebehap');
    assert.equal(of('Some.Movie.2026.1080p', 'RoTheBeHap'), 'rothebehap');
    // A dot in a name is a dot, not any character.
    assert.equal(of('Movie.2026.1080p-Flux.X'), 'Flux.X');
    assert.equal(of('Movie.2026.1080p-FluxyX'), undefined);
    // Part of a longer word is not the group.
    assert.equal(of('Movie.2026.1080p-rothebehapper'), undefined);
    assert.equal(of('Movie.2026.1080p-NTb'), undefined);
  });

  it('gives Radarr and Sonarr a format matching the groups by group and by title', () => {
    const format = blockFormat(['rothebehap', 'Flux.X']);
    assert.equal(format.name, BLOCK_FORMAT_NAME);
    const [group, title] = format.specifications;
    assert.equal(group.implementation, 'ReleaseGroupSpecification');
    assert.equal(title.implementation, 'ReleaseTitleSpecification');
    const groupRe = new RegExp(String(group.fields[0].value), 'i');
    const titleRe = new RegExp(String(title.fields[0].value), 'i');
    assert.ok(groupRe.test('ROTHEBEHAP'));
    assert.ok(groupRe.test('flux.x'));
    assert.ok(!groupRe.test('fluxyx'));
    assert.ok(!groupRe.test('rothebehap2'));
    assert.ok(titleRe.test('Movie 2026 x264 rothebehap mp4'));
    assert.ok(!titleRe.test('Movie 2026 x264 rothebehapper'));
  });

  it('scores the format below the minimum whatever else a release scores', () => {
    const profile = {
      minFormatScore: 200_000,
      formatItems: [
        { format: 1, score: 100_000 },
        { format: 2, score: 680_000 },
        { format: 3, score: -10_000 },
        { format: 9, score: -5 },
      ],
    };
    const score = blockScore(profile, 9);
    assert.equal(score, -(1 + 780_000 + 200_000));
    // Every reward together, with the blocked format, is still below it.
    assert.ok(780_000 + score < profile.minFormatScore);
    assert.equal(blockScore({}), -1);
    assert.equal(blockScore({ minFormatScore: -50 }), -51);
  });

  it('creates the format, scores it in every profile, and leaves the admin’s own formats alone', async () => {
    const radarr = standIn([
      {
        id: 1,
        name: 'HD',
        minFormatScore: 0,
        formatItems: [{ format: 7, name: 'Admin’s own format', score: 500 }],
      },
      { id: 2, name: '4K', minFormatScore: 1000, formatItems: [] },
    ]);
    const sonarr = standIn([
      { id: 5, name: 'Any', minFormatScore: 0, formatItems: [] },
    ]);
    mock.getter(FixRadarr.prototype, 'extras', () => radarr.api);
    mock.getter(FixSonarr.prototype, 'extras', () => sonarr.api);

    const { groups, problems } = await setGroupBlocked('rothebehap', true);
    assert.deepEqual(groups, ['rothebehap']);
    assert.deepEqual(problems, []);
    assert.deepEqual(getSettings().backfill.blockedGroups, ['rothebehap']);

    const made = radarr.formats.find((f) => f.name === BLOCK_FORMAT_NAME);
    assert.ok(made?.id);
    assert.equal(
      radarr.formats.find((f) => f.id === 7)?.specifications.length,
      0
    );
    const hd = radarr.profiles[0].formatItems ?? [];
    assert.deepEqual(
      hd.map((i) => [i.format, i.score]),
      [
        [7, 500],
        [made.id, -501],
      ]
    );
    assert.deepEqual(
      radarr.profiles[1].formatItems?.map((i) => i.score),
      [-1001]
    );
    assert.equal(sonarr.profiles[0].formatItems?.[0].score, -1);

    // A second group updates the same format; scores already right are
    // not saved again.
    radarr.calls.length = 0;
    await setGroupBlocked('turkseed', true);
    assert.deepEqual(radarr.calls, [`put ${made.id}`]);
    assert.deepEqual(getSettings().backfill.blockedGroups, [
      'rothebehap',
      'turkseed',
    ]);
    // The same group again, in other case, is one entry.
    await setGroupBlocked('TURKSEED', true);
    assert.deepEqual(getSettings().backfill.blockedGroups, [
      'rothebehap',
      'TURKSEED',
    ]);

    // Nothing left blocked: the format goes, with its scores.
    await setGroupBlocked('rothebehap', false);
    await setGroupBlocked('turkseed', false);
    assert.deepEqual(getSettings().backfill.blockedGroups, []);
    assert.ok(!radarr.formats.some((f) => f.name === BLOCK_FORMAT_NAME));
    assert.deepEqual(
      radarr.profiles[0].formatItems?.map((i) => i.format),
      [7]
    );
    assert.ok(radarr.formats.some((f) => f.id === 7));
  });

  it('saves the list even when a server cannot be reached, and says which', async () => {
    const radarr = standIn([], true);
    const sonarr = standIn([]);
    mock.getter(FixRadarr.prototype, 'extras', () => radarr.api);
    mock.getter(FixSonarr.prototype, 'extras', () => sonarr.api);
    const { groups, problems } = await setGroupBlocked('rothebehap', true);
    assert.deepEqual(groups, ['rothebehap']);
    assert.equal(problems.length, 1);
    assert.match(
      problems[0],
      /^Radarr could not be updated \(connect ECONNREFUSED\)/
    );
    // Trying again later brings it in line.
    assert.deepEqual(await syncBlockedGroups(), problems);
  });

  it('turns down a name that is not a release group', async () => {
    await assert.rejects(
      setGroupBlocked('a|b', true),
      /is not a release group's name/
    );
    await assert.rejects(setGroupBlocked('', true));
    assert.deepEqual(getSettings().backfill.blockedGroups, []);
  });
});
