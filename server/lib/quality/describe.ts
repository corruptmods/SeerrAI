import { getRepository } from '@server/datasource';
import QualityManaged from '@server/entity/QualityManaged';
import { BLOCK_FORMAT_NAME } from '@server/lib/blockedGroups';
import type { ArrProfileItem, QualityServerRef } from '@server/lib/quality/arr';
import { QualityArr } from '@server/lib/quality/arr';
import type {
  DesiredProfile,
  ScoreChange,
  ScoredFormat,
} from '@server/lib/quality/build';
import { notesFor } from '@server/lib/quality/notes';
import {
  QualityError,
  choicesOf,
  configFor,
  defaultDelay,
  desiredFor,
  loadContext,
} from '@server/lib/quality/plan';
import { LAST_RESORT } from '@server/lib/quality/presets';
import { trashData } from '@server/lib/quality/trash';
import type {
  PresetKey,
  QualityServerSettings,
} from '@server/lib/quality/types';
import { getSettings } from '@server/lib/settings';

/*
 * What it does: one preset on one server, laid out for an admin. All but
 * Try a release name and Recent grabs come from the profile as Seerr AI
 * builds it, so it is exact without asking the server; those two ask
 * Radarr or Sonarr.
 */

/** Qualities nobody would choose, left out of "not allowed". */
const NEVER_LISTED = new Set([
  'Unknown',
  'WORKPRINT',
  'CAM',
  'TELESYNC',
  'TELECINE',
  'REGIONAL',
  'DVDSCR',
  'DVD-R',
  'BR-DISK',
  'Raw-HD',
]);

export interface DescribedFormat {
  key: string;
  name: string;
  origin: 'seerr' | 'trash' | 'you';
  score: number;
  changes: ScoreChange[];
}

export interface Description {
  preset: PresetKey;
  name: string;
  source: 'seerr' | 'trash';
  filledIn: boolean;
  trashName?: string;
  /** Best first. */
  qualities: {
    name: string;
    goal: boolean;
    lowest: boolean;
    /** Sonarr v5, MB a minute. */
    maxMbMin?: number;
  }[];
  notAllowed: string[];
  /** Radarr: films over this are a last resort. */
  sizeCapGb?: number;
  sizesOnProfile: boolean;
  /** Formats that raise a release, best band first. */
  bands: { score: number; formats: DescribedFormat[] }[];
  /** Formats whose score is 0 because of a choice or the bands. */
  nothing: DescribedFormat[];
  /** Taken only when nothing else is out. */
  lastResort: DescribedFormat[];
  never: DescribedFormat[];
  bandStep: number;
  banding: boolean;
  preferredProtocol?: 'usenet' | 'torrent';
  torrentDelayMinutes?: number;
  minFormatScore: number;
  /** In Radarr or Sonarr as built here. */
  applied: boolean;
}

const originOf = (format: ScoredFormat): DescribedFormat['origin'] =>
  format.changes.some(
    (c) => c.kind === 'nudged' || c.kind === 'x265-allowed' || c.kind === 'av1'
  )
    ? 'you'
    : format.origin;

const describeFormat = (format: ScoredFormat): DescribedFormat => ({
  key: format.key,
  name: format.name,
  origin: originOf(format),
  score: format.score,
  changes: format.changes,
});

/**
 * Choices on the page not saved yet, which What it does shows as they
 * would be: the saved ones stand for anything left out.
 */
export type DraftChoices = Partial<
  Pick<QualityServerSettings, 'presets' | 'adjustments' | 'nudges' | 'bandStep'>
>;

/** Builds what a server's preset is, or throws when it isn't one. */
const desiredOf = async (
  ref: QualityServerRef,
  preset: PresetKey,
  choices?: DraftChoices
) => {
  const saved = configFor(ref);
  const config = { ...saved, ...choices, managed: saved.managed };
  if (!config.managed) {
    throw new QualityError(
      'not-managed',
      'Seerr AI does not manage this server.'
    );
  }
  const ctx = await loadContext(ref);
  const desired = desiredFor(config, ctx.facts, await trashData());
  const profile = desired.profiles.find((p) => p.preset === preset);
  if (!profile) {
    throw new QualityError('not-found', 'That preset is off on this server.');
  }
  return { ctx, config, desired, profile };
};

const sumPositive = (profile: DesiredProfile) =>
  profile.formats.reduce((n, f) => n + Math.max(0, f.score), 0);

export const describe = async (
  ref: QualityServerRef,
  preset: PresetKey,
  choices?: DraftChoices
): Promise<Description> => {
  const { ctx, config, desired, profile } = await desiredOf(
    ref,
    preset,
    choices
  );
  const allowed = profile.ladder.entries.filter((e) => e.allowed);
  const sizes = new Map(profile.sizes?.map((s) => [s.quality, s]));
  const qualities = allowed.map((entry, i) => {
    const members = entry.items ?? [entry.name];
    const caps = members
      .map((m) => sizes.get(m)?.max)
      .filter((n): n is number => n !== undefined);
    return {
      name: entry.name,
      goal: entry.name === profile.ladder.cutoff,
      lowest: i === allowed.length - 1 && allowed.length > 1,
      ...(caps.length ? { maxMbMin: Math.max(...caps) } : {}),
    };
  });
  const inLadder = new Set(
    allowed.flatMap((entry) => [entry.name, ...(entry.items ?? [])])
  );
  const notAllowed = ((ctx.facts.template.items as ArrProfileItem[]) ?? [])
    .map((item) => item.quality?.name ?? item.name ?? '')
    .filter((name) => name && !inLadder.has(name) && !NEVER_LISTED.has(name))
    .reverse();

  const reach = sumPositive(profile);
  const positive = profile.formats.filter((f) => f.score > 0);
  const scores = [...new Set(positive.map((f) => f.score))].sort(
    (a, b) => b - a
  );
  const never = profile.formats
    .filter((f) => f.score < 0 && f.score + reach < profile.minFormatScore)
    .map(describeFormat);
  const block = ctx.formats.find((f) => f.name === BLOCK_FORMAT_NAME);
  if (block) {
    never.push({
      key: 'blocked-groups',
      name: BLOCK_FORMAT_NAME,
      origin: 'seerr',
      score: 0,
      changes: [],
    });
  }
  const rows = await getRepository(QualityManaged).find({
    where: {
      serverKind: ref.kind,
      serverId: ref.serverId,
      itemKind: 'profile',
      key: preset,
    },
  });
  // In Radarr or Sonarr, and as these choices make it (the page's, which
  // may not be the ones applied).
  const applied =
    !!rows.length &&
    ctx.profiles.some((p) => p.id === rows[0].arrId) &&
    (!choices ||
      choicesOf(config, getSettings().quality.trash.fillGaps) ===
        configFor(ref).appliedChoices);
  const delay = defaultDelay(ctx.delays);
  return {
    preset,
    name: profile.name,
    source: profile.source,
    filledIn: profile.filledIn,
    trashName: profile.trashName,
    qualities,
    notAllowed,
    sizeCapGb: profile.sizeCapGb,
    sizesOnProfile: ctx.facts.sizesOnProfile,
    bands: scores.map((score) => ({
      score,
      formats: positive.filter((f) => f.score === score).map(describeFormat),
    })),
    nothing: profile.formats
      .filter((f) => f.score === 0 && f.changes.length)
      .map(describeFormat),
    lastResort: profile.formats
      .filter(
        (f) =>
          f.score < 0 &&
          f.score + reach >= profile.minFormatScore &&
          f.score <= LAST_RESORT
      )
      .map(describeFormat),
    never,
    bandStep: config.bandStep,
    banding: config.adjustments.preferUsenet !== 'none',
    preferredProtocol:
      desired.delay?.preferredProtocol ?? delay?.preferredProtocol,
    torrentDelayMinutes:
      desired.delay?.torrentDelay ?? delay?.torrentDelay ?? undefined,
    minFormatScore: profile.minFormatScore,
    applied,
  };
};

export type TryVerdict =
  | { verdict: 'grab'; score: number }
  | { verdict: 'quality'; quality?: string }
  | { verdict: 'never'; format: string }
  | { verdict: 'too-low'; score: number; min: number }
  | { verdict: 'not-applied' };

export interface TryResult {
  quality?: string;
  matched: { name: string; score: number }[];
  /** Radarr or Sonarr couldn't tell its language from the name. */
  languageUnknown: boolean;
  result: TryVerdict;
}

/**
 * Whether this profile would take a name: as it is in Radarr or Sonarr, or
 * as the choices on the page would make it.
 */
export const tryName = async (
  ref: QualityServerRef,
  preset: PresetKey,
  title: string,
  choices?: DraftChoices
): Promise<TryResult> => {
  const arr = QualityArr.forServer(ref);
  if (!arr) throw new QualityError('not-found', 'There is no such server.');
  const row = await getRepository(QualityManaged).findOne({
    where: {
      serverKind: ref.kind,
      serverId: ref.serverId,
      itemKind: 'profile',
      key: preset,
    },
  });
  const [parsed, profiles] = await Promise.all([
    arr.parse(title),
    arr.profiles(),
  ]);
  const profile = row && profiles.find((p) => p.id === row.arrId);
  const languageUnknown =
    !parsed.languages.length ||
    parsed.languages.every((l) => l.toLowerCase() === 'unknown');
  if (!profile) {
    return {
      quality: parsed.quality,
      matched: parsed.formats.map((f) => ({ name: f.name, score: 0 })),
      languageUnknown,
      result: { verdict: 'not-applied' },
    };
  }
  const allowedQualities = new Set<string>();
  let matched: { name: string; score: number }[];
  let min: number;
  let reach: number;
  if (choices) {
    // As the page's choices would make it: the formats Radarr or Sonarr
    // matched, scored as they would be.
    const { profile: wanted } = await desiredOf(ref, preset, choices);
    const byName = new Map(wanted.formats.map((f) => [f.name, f.score]));
    matched = parsed.formats.map((f) => ({
      name: f.name,
      score: byName.get(f.name) ?? 0,
    }));
    for (const entry of wanted.ladder.entries) {
      if (!entry.allowed) continue;
      for (const quality of entry.items ?? [entry.name]) {
        allowedQualities.add(quality);
      }
    }
    min = wanted.minFormatScore;
    reach = sumPositive(wanted);
  } else {
    const scores = new Map(
      (profile.formatItems ?? []).map((item) => [item.format, item.score])
    );
    matched = parsed.formats.map((f) => ({
      name: f.name,
      score: scores.get(f.id) ?? 0,
    }));
    const walk = (items: ArrProfileItem[], parentAllowed = false) => {
      for (const item of items) {
        const on = item.allowed || parentAllowed;
        if (item.quality && on) allowedQualities.add(item.quality.name);
        walk(item.items ?? [], on);
      }
    };
    walk((profile.items as ArrProfileItem[]) ?? []);
    min = profile.minFormatScore ?? 0;
    reach = [...scores.values()].reduce((n, s) => n + Math.max(0, s), 0);
  }
  const score = matched.reduce((n, f) => n + f.score, 0);
  const blocker = matched.find((f) => f.score < 0 && f.score + reach < min);
  const result: TryVerdict =
    parsed.quality && !allowedQualities.has(parsed.quality)
      ? { verdict: 'quality', quality: parsed.quality }
      : blocker
        ? { verdict: 'never', format: blocker.name }
        : score < min
          ? { verdict: 'too-low', score, min }
          : { verdict: 'grab', score };
  return { quality: parsed.quality, matched, languageUnknown, result };
};

export interface RecentGrab {
  title: string;
  date: string;
  score: number;
  protocol: 'usenet' | 'torrent' | null;
  quality?: string;
  /** Seerr AI grabbed it itself, so what it beat is known. */
  bySeerr: boolean;
  wonTie: boolean;
}

/** The latest grabs onto this preset's profile, newest first. */
export const recentGrabs = async (
  ref: QualityServerRef,
  preset: PresetKey,
  limit = 10
): Promise<RecentGrab[]> => {
  const arr = QualityArr.forServer(ref);
  if (!arr) throw new QualityError('not-found', 'There is no such server.');
  const row = await getRepository(QualityManaged).findOne({
    where: {
      serverKind: ref.kind,
      serverId: ref.serverId,
      itemKind: 'profile',
      key: preset,
    },
  });
  if (!row) return [];
  const grabs = (await arr.grabs(200)).filter((g) => g.profileId === row.arrId);
  const notes = await notesFor(
    ref.kind,
    ref.serverId,
    new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
  );
  return grabs.slice(0, limit).map((grab) => {
    const note = notes.get(grab.title);
    return {
      title: grab.title,
      date: grab.date,
      score: grab.score,
      protocol: grab.protocol,
      quality: grab.quality,
      bySeerr: !!note,
      wonTie: !!note?.wonTie,
    };
  });
};

export interface ServerFormat {
  key: string;
  name: string;
  origin: 'seerr' | 'trash';
  presets: PresetKey[];
}

/** Every format this server's presets use, for Advanced. */
export const serverFormats = async (
  ref: QualityServerRef
): Promise<ServerFormat[]> => {
  const config = configFor(ref);
  const ctx = await loadContext(ref);
  // Without nudges, so a format's own score is what is listed.
  const desired = desiredFor(
    { ...config, nudges: {} },
    ctx.facts,
    await trashData()
  );
  const out = new Map<string, ServerFormat>();
  for (const profile of desired.profiles) {
    for (const format of profile.formats) {
      const seen = out.get(format.key);
      if (seen) seen.presets.push(profile.preset);
      else {
        out.set(format.key, {
          key: format.key,
          name: format.name,
          origin: format.origin,
          presets: [profile.preset],
        });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
};
