import type {
  ArrCustomFormat,
  ArrQualityProfile,
} from '@server/lib/autofix/arr';
import type { ArrProfileItem } from '@server/lib/quality/arr';
import type { Ladder, SeerrFormat } from '@server/lib/quality/presets';
import {
  AV1,
  BURNED_IN,
  DUAL_AUDIO,
  EPISODE_CAPS_MB_MIN,
  FILM_CAPS_GB,
  HDR,
  LAST_RESORT,
  LOWEST_TAKEN,
  MULTI_EPISODE,
  NAME_PREFIX,
  NEVER,
  REPACK,
  SEERR_SCORES,
  UPSCALED,
  X265_HD,
  is2160,
  languageFormat,
  profileName,
  seerrLadder,
  sizeFormat,
} from '@server/lib/quality/presets';
import type { TrashApp, TrashData } from '@server/lib/quality/trash';
import {
  TRASH_PROFILES,
  toArrFormat,
  trashProfileFormats,
  trashScore,
} from '@server/lib/quality/trash';
import type {
  ArrKind,
  Nudge,
  PresetKey,
  QualityServerSettings,
} from '@server/lib/quality/types';
import { PRESET_KEYS } from '@server/lib/quality/types';

/*
 * What one server's quality profiles should be, from its choices: each
 * preset's ladder and the score of every format in it, built the same way
 * every time (base, gaps filled, adjustments, bands, nudges), so it can be
 * shown before it is sent. Nothing here talks to a server.
 */

/** TRaSH Guides' AV1 format, which never takes AV1. */
const TRASH_AV1: Record<ArrKind, string> = {
  radarr: 'cae4ca30163749b891686f95532519bd',
  sonarr: '15a05bc7c1a36e2b57fd628f8977e2fc',
};

/** TRaSH Guides' x265 (HD) format, which never takes x265 at 1080p. */
const TRASH_X265_HD: Record<ArrKind, string> = {
  radarr: 'dc98083864ea246d05a42df0d05f81cc',
  sonarr: '47435ece6b99a0b477caf360e79ba0bb',
};

export interface DesiredFormat {
  key: string;
  source: 'seerr' | 'trash';
  format: ArrCustomFormat;
}

/** Why a format's score is not the one its source gives it. */
export type ScoreChange =
  | { kind: 'rounded'; from: number }
  | { kind: 'nudged'; nudge: Nudge }
  | { kind: 'x265-allowed' }
  | { kind: 'av1'; to: 'last-resort' | 'allowed' }
  | { kind: 'hdr-off' }
  | { kind: 'conflict' };

export interface ScoredFormat {
  key: string;
  /** As Radarr or Sonarr shows it. */
  name: string;
  origin: 'seerr' | 'trash';
  score: number;
  changes: ScoreChange[];
  /** The TRaSH Guides group it came in with. */
  group?: string;
  /** TRaSH Guides' own score, before anything here changed it. */
  raw?: number;
}

export interface QualitySize {
  quality: string;
  min: number;
  preferred: number;
  max: number;
}

export interface DesiredProfile {
  preset: PresetKey;
  name: string;
  source: 'seerr' | 'trash';
  /** A TRaSH Guides preset Seerr AI built because TRaSH Guides has none. */
  filledIn: boolean;
  trashName?: string;
  ladder: Ladder;
  upgradeAllowed: boolean;
  minFormatScore: number;
  cutoffFormatScore: number;
  minUpgradeFormatScore: number;
  formats: ScoredFormat[];
  /** Sonarr v5: sizes per quality, in MB a minute. */
  sizes?: QualitySize[];
  /** Radarr: films over this many GB are a last resort. */
  sizeCapGb?: number;
}

export interface DesiredDelay {
  preferredProtocol: 'usenet';
  /** Minutes torrents wait; null leaves the wait as it is. */
  torrentDelay: number | null;
}

export interface DesiredState {
  formats: DesiredFormat[];
  profiles: DesiredProfile[];
  delay: DesiredDelay | null;
  /** Presets that could not be built, and why. */
  skipped: { preset: PresetKey; reason: 'no-trash' | 'trash-missing' }[];
}

/** A quality profile as sent to Radarr or Sonarr, without its id. */
export interface ProfileBody {
  name: string;
  upgradeAllowed: boolean;
  cutoff: number;
  items: ArrProfileItem[];
  minFormatScore: number;
  cutoffFormatScore: number;
  minUpgradeFormatScore: number;
  formatItems: { format: number; name?: string; score: number }[];
  [field: string]: unknown;
}

export interface ServerFacts {
  kind: ArrKind;
  /** The app's empty profile: every quality, in order. */
  template: ArrQualityProfile;
  /** Sonarr v5 keeps file sizes per profile. */
  sizesOnProfile: boolean;
}

const trashFormatName = (name: string) => `${NAME_PREFIX}${name}`;

/** Rounds a score to the band step; halves go down. */
export const band = (score: number, step: number): number => {
  if (score <= LAST_RESORT || score === 0) return score;
  const steps = Math.floor(Math.abs(score) / step + 0.5 - 1e-9);
  return Math.sign(score) * steps * step || 0;
};

const seerrScored = (
  seerr: SeerrFormat,
  score: number
): { def: DesiredFormat; scored: ScoredFormat } => ({
  def: { key: seerr.key, source: 'seerr', format: seerr.format },
  scored: {
    key: seerr.key,
    name: seerr.format.name,
    origin: 'seerr',
    score,
    changes: [],
  },
});

/** The rules Seerr AI adds to any preset: gaps TRaSH Guides doesn't fill. */
const gapRules = (
  config: QualityServerSettings,
  preset: PresetKey,
  kind: ArrKind
) => {
  const adj = config.adjustments;
  const out = [
    seerrScored(BURNED_IN, adj.burnedInLastResort ? LAST_RESORT : 0),
  ];
  if (preset === 'anime') {
    out.push(
      seerrScored(DUAL_AUDIO, adj.dualAudioAnime ? SEERR_SCORES.dualAudio : 0)
    );
  }
  if (kind === 'sonarr') {
    out.push(seerrScored(MULTI_EPISODE, adj.singleEpisodes ? LAST_RESORT : 0));
  }
  return out;
};

/** What any preset gets from the adjustments: language and file size. */
const adjustmentRules = (
  config: QualityServerSettings,
  preset: PresetKey,
  facts: ServerFacts
) => {
  const adj = config.adjustments;
  const out: { def: DesiredFormat; scored: ScoredFormat }[] = [];
  const lang = languageFormat(adj.languages);
  if (lang) out.push(seerrScored(lang, NEVER));
  let sizeCapGb: number | undefined;
  if (facts.kind === 'radarr' && adj.fileSize !== 'best') {
    sizeCapGb = FILM_CAPS_GB[adj.fileSize][preset];
    out.push(seerrScored(sizeFormat(sizeCapGb), LAST_RESORT));
  }
  return { rules: out, sizeCapGb };
};

const flatQualities = (items: ArrProfileItem[]): ArrProfileItem[] =>
  items.flatMap((item) =>
    item.quality ? [item] : flatQualities(item.items ?? [])
  );

/** Sonarr v5: each allowed quality's sizes, capped by the file size choice. */
const sizesFor = (
  config: QualityServerSettings,
  preset: PresetKey,
  ladder: Ladder,
  facts: ServerFacts,
  base?: Record<string, { min: number; preferred: number; max: number }>
): QualitySize[] | undefined => {
  if (!facts.sizesOnProfile) return undefined;
  const fromTemplate = Object.fromEntries(
    flatQualities((facts.template.items as ArrProfileItem[]) ?? []).map(
      (item) => [
        item.quality?.name ?? '',
        {
          min: item.minSize ?? 0,
          preferred: item.preferredSize ?? 995,
          max: item.maxSize ?? 1000,
        },
      ]
    )
  );
  const cap =
    config.adjustments.fileSize === 'best'
      ? undefined
      : EPISODE_CAPS_MB_MIN[config.adjustments.fileSize][preset];
  const names = ladder.entries
    .filter((entry) => entry.allowed)
    .flatMap((entry) => entry.items ?? [entry.name]);
  return names.map((quality) => {
    const start = base?.[quality] ??
      fromTemplate[quality] ?? { min: 0, preferred: 995, max: 1000 };
    const max = cap === undefined ? start.max : Math.min(start.max, cap);
    const min = Math.min(start.min, max);
    const preferred = Math.max(min, Math.min(start.preferred, max));
    return { quality, min, preferred, max };
  });
};

const seerrProfile = (
  config: QualityServerSettings,
  preset: PresetKey,
  facts: ServerFacts,
  filledIn: boolean
): { profile: DesiredProfile; defs: DesiredFormat[] } => {
  const adj = config.adjustments;
  const parts = [seerrScored(REPACK, SEERR_SCORES.repack)];
  if (is2160(preset)) {
    parts.push(seerrScored(HDR, adj.hdr ? SEERR_SCORES.hdr : 0));
  } else {
    parts.push(seerrScored(X265_HD, adj.x265At1080p ? 0 : NEVER));
  }
  parts.push(seerrScored(UPSCALED, NEVER));
  parts.push(seerrScored(AV1, adj.av1LastResort ? LAST_RESORT : 0));
  parts.push(...gapRules(config, preset, facts.kind));
  const { rules, sizeCapGb } = adjustmentRules(config, preset, facts);
  parts.push(...rules);
  const ladder = seerrLadder(preset, facts.kind);
  return {
    profile: {
      preset,
      name: profileName(preset),
      source: 'seerr',
      filledIn,
      ladder,
      upgradeAllowed: true,
      minFormatScore: LOWEST_TAKEN,
      cutoffFormatScore: 10_000,
      minUpgradeFormatScore: 1,
      formats: parts.map((p) => p.scored),
      sizes: sizesFor(config, preset, ladder, facts),
      sizeCapGb,
    },
    defs: parts.map((p) => p.def),
  };
};

const trashProfile = (
  config: QualityServerSettings,
  preset: PresetKey,
  facts: ServerFacts,
  app: TrashApp,
  trashId: string,
  fillGaps: boolean
): { profile: DesiredProfile; defs: DesiredFormat[] } | undefined => {
  const source = app.profiles[trashId];
  if (!source) return undefined;
  const adj = config.adjustments;
  const defs: DesiredFormat[] = [];
  const formats: ScoredFormat[] = [];
  for (const { trashId: id, group } of trashProfileFormats(app, source)) {
    const format = app.formats[id];
    if (!format) continue;
    const key = `trash:${id}`;
    const name = trashFormatName(format.name);
    const raw = trashScore(format, source.trash_score_set);
    let score = raw;
    const changes: ScoreChange[] = [];
    if (score <= LAST_RESORT) score = NEVER;
    if (id === TRASH_X265_HD[facts.kind] && adj.x265At1080p && score < 0) {
      score = 0;
      changes.push({ kind: 'x265-allowed' });
    }
    if (id === TRASH_AV1[facts.kind] && score < 0) {
      const to = adj.av1LastResort ? LAST_RESORT : 0;
      if (score !== to) {
        score = to;
        changes.push({
          kind: 'av1',
          to: adj.av1LastResort ? 'last-resort' : 'allowed',
        });
      }
    }
    if (!adj.hdr && score > 0 && group?.startsWith('[HDR')) {
      score = 0;
      changes.push({ kind: 'hdr-off' });
    }
    defs.push({ key, source: 'trash', format: toArrFormat(format, name) });
    formats.push({ key, name, origin: 'trash', score, changes, group, raw });
  }
  if (fillGaps) {
    for (const part of gapRules(config, preset, facts.kind)) {
      defs.push(part.def);
      formats.push(part.scored);
    }
  }
  const { rules, sizeCapGb } = adjustmentRules(config, preset, facts);
  for (const part of rules) {
    defs.push(part.def);
    formats.push(part.scored);
  }

  const ladder: Ladder = {
    entries: source.items.map((item) => ({
      name: item.name,
      allowed: item.allowed,
      ...(item.items?.length ? { items: item.items } : {}),
    })),
    cutoff: source.cutoff,
  };
  const sizeSet = Object.values(source.trash_quality_definition ?? {})[0];
  const base = sizeSet
    ? Object.fromEntries(
        (app.sizes[sizeSet]?.qualities ?? []).map((q) => [
          q.quality,
          { min: q.min, preferred: q.preferred, max: q.max },
        ])
      )
    : undefined;
  return {
    profile: {
      preset,
      name: profileName(preset),
      source: 'trash',
      filledIn: false,
      trashName: source.name,
      ladder,
      upgradeAllowed: source.upgradeAllowed,
      // TRaSH Guides' own lowest score where it asks for one above zero
      // (anime: a known release group); otherwise room for last resorts.
      minFormatScore:
        source.minFormatScore > 0 ? source.minFormatScore : LOWEST_TAKEN,
      cutoffFormatScore: source.cutoffFormatScore,
      minUpgradeFormatScore: source.minUpgradeFormatScore ?? 1,
      formats,
      sizes: sizesFor(config, preset, ladder, facts, base),
      sizeCapGb,
    },
    defs,
  };
};

/** Bands, then nudges, then TRaSH Guides' conflicts, on one profile. */
const finish = (
  profile: DesiredProfile,
  config: QualityServerSettings,
  conflicts: string[][]
) => {
  const step = config.bandStep;
  const banding = config.adjustments.preferUsenet !== 'none';
  for (const format of profile.formats) {
    if (banding) {
      const banded = band(format.score, step);
      if (banded !== format.score) {
        format.changes.push({ kind: 'rounded', from: format.score });
        format.score = banded;
      }
    }
    const nudge = config.nudges[format.key];
    if (nudge === 'never' && format.score !== NEVER) {
      format.score = NEVER;
      format.changes.push({ kind: 'nudged', nudge });
    } else if (
      (nudge === 'up' || nudge === 'down') &&
      format.score > LAST_RESORT
    ) {
      format.score += nudge === 'up' ? step : -step;
      format.changes.push({ kind: 'nudged', nudge });
    }
  }
  if (banding) profile.minUpgradeFormatScore = step;
  for (const set of conflicts) {
    const keys = new Set(set.map((id) => `trash:${id}`));
    const used = profile.formats.filter(
      (format) => keys.has(format.key) && format.score !== 0
    );
    for (const format of used.slice(1)) {
      format.score = 0;
      format.changes.push({ kind: 'conflict' });
    }
  }
};

/** Everything one server should have, from its choices. */
export const buildDesired = (
  config: QualityServerSettings,
  facts: ServerFacts,
  trash: TrashData | null,
  fillGaps: boolean
): DesiredState => {
  const defs = new Map<string, DesiredFormat>();
  const profiles: DesiredProfile[] = [];
  const skipped: DesiredState['skipped'] = [];
  const app = trash?.[facts.kind];

  for (const preset of PRESET_KEYS) {
    const choice = config.presets[preset] ?? 'off';
    if (choice === 'off') continue;
    let built: { profile: DesiredProfile; defs: DesiredFormat[] } | undefined;
    if (choice === 'seerr') {
      built = seerrProfile(config, preset, facts, false);
    } else {
      const trashId = TRASH_PROFILES[facts.kind][preset];
      if (!trashId) {
        if (fillGaps) built = seerrProfile(config, preset, facts, true);
        else skipped.push({ preset, reason: 'no-trash' });
      } else if (!app) {
        skipped.push({ preset, reason: 'trash-missing' });
      } else {
        built = trashProfile(config, preset, facts, app, trashId, fillGaps);
        if (!built) skipped.push({ preset, reason: 'trash-missing' });
      }
    }
    if (!built) continue;
    finish(built.profile, config, app?.conflicts ?? []);
    profiles.push(built.profile);
    for (const def of built.defs) defs.set(def.key, def);
  }

  const adj = config.adjustments;
  return {
    formats: [...defs.values()],
    profiles,
    delay:
      adj.preferUsenet === 'none' || !profiles.length
        ? null
        : {
            preferredProtocol: 'usenet',
            torrentDelay:
              adj.preferUsenet === 'always'
                ? Math.round(adj.torrentWaitHours * 60)
                : null,
          },
    skipped,
  };
};

/**
 * A profile as Radarr or Sonarr takes it, laid out on the app's own empty
 * profile: every quality once, lowest first, the preset's own in its order
 * at the top.
 */
export const materialize = (
  desired: DesiredProfile,
  facts: ServerFacts,
  formatIds: Map<string, number>,
  serverFormats: ArrCustomFormat[],
  extraScores: Map<number, number>
): ProfileBody => {
  const template = facts.template;
  const all = flatQualities((template.items as ArrProfileItem[]) ?? []);
  const byName = new Map(all.map((item) => [item.quality?.name ?? '', item]));
  const groups = new Map(
    ((template.items as ArrProfileItem[]) ?? [])
      .filter((item) => !item.quality && item.name)
      .map((item) => [item.name ?? '', item])
  );
  const sizes = new Map(desired.sizes?.map((s) => [s.quality, s]));
  const leaf = (name: string, allowed: boolean): ArrProfileItem | null => {
    const item = byName.get(name);
    if (!item?.quality) return null;
    const size = sizes.get(name);
    return {
      quality: item.quality,
      items: [],
      allowed,
      ...(facts.sizesOnProfile
        ? {
            minSize: size?.min ?? item.minSize ?? 0,
            maxSize: size?.max ?? item.maxSize ?? 1000,
            preferredSize: size?.preferred ?? item.preferredSize ?? 995,
          }
        : {}),
    };
  };

  const used = new Set<string>();
  let nextGroupId = 1000;
  const top: ArrProfileItem[] = [];
  let cutoff: number | undefined;
  // Lowest first, as the apps keep them.
  for (const entry of [...desired.ladder.entries].reverse()) {
    const members =
      entry.items ??
      (byName.has(entry.name)
        ? [entry.name]
        : (groups.get(entry.name)?.items ?? [])
            .map((i) => i.quality?.name ?? '')
            .filter(Boolean));
    const leaves = members
      .filter((name) => !used.has(name))
      .map((name) => leaf(name, entry.allowed))
      .filter((item): item is ArrProfileItem => !!item);
    if (!leaves.length) continue;
    leaves.forEach((item) => used.add(item.quality?.name ?? ''));
    let id: number;
    if (members.length === 1 && byName.has(entry.name)) {
      top.push(leaves[0]);
      id = leaves[0].quality?.id ?? -1;
    } else {
      id = nextGroupId++;
      top.push({ id, name: entry.name, items: leaves, allowed: entry.allowed });
    }
    if (entry.name === desired.ladder.cutoff) cutoff = id;
  }
  const rest = all
    .filter((item) => !used.has(item.quality?.name ?? ''))
    .map((item) => leaf(item.quality?.name ?? '', false))
    .filter((item): item is ArrProfileItem => !!item);

  const scores = new Map<number, number>();
  for (const format of desired.formats) {
    const id = formatIds.get(format.key);
    if (id !== undefined) scores.set(id, format.score);
  }
  for (const [id, score] of extraScores) scores.set(id, score);

  return {
    ...Object.fromEntries(
      Object.entries(template).filter(
        ([field]) => !['id', 'items', 'formatItems'].includes(field)
      )
    ),
    name: desired.name,
    upgradeAllowed: desired.upgradeAllowed,
    cutoff: cutoff ?? top[top.length - 1]?.quality?.id ?? 0,
    items: [...rest, ...top],
    minFormatScore: desired.minFormatScore,
    cutoffFormatScore: desired.cutoffFormatScore,
    minUpgradeFormatScore: desired.minUpgradeFormatScore,
    formatItems: serverFormats
      .filter((format) => format.id !== undefined)
      .map((format) => ({
        format: format.id as number,
        name: format.name,
        score: scores.get(format.id as number) ?? 0,
      })),
    ...(facts.kind === 'radarr' ? { language: { id: -1, name: 'Any' } } : {}),
  };
};
