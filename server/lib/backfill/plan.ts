import type {
  SonarrEpisode,
  SonarrEpisodeFile,
  SonarrProfileItem,
  SonarrQuality,
  SonarrQualityProfile,
} from '@server/lib/backfill/sonarr';

/*
 * What a pack would do to a series, file by file, judged the way Sonarr
 * judges: the quality profile's order of qualities first, then the release
 * revision (v2, v3), then the custom format score — and nothing that would
 * replace a file Sonarr itself would keep.
 */

export type PlanAction = 'fill' | 'upgrade' | 'skip' | 'reject';

export interface PlanEntry {
  /** The file's index in the torrent or NZB. */
  index: number;
  /** Its path inside the pack. */
  path: string;
  size: number;
  /** The name Sonarr was asked to judge. */
  judgedAs: string;
  episodeIds: number[];
  absolute?: number;
  season?: number;
  episode?: number;
  quality?: SonarrQuality;
  languages?: { id: number; name: string }[];
  releaseGroup?: string;
  score: number;
  action: PlanAction;
  reason?: string;
  /** Existing files this one would replace. */
  replaces: number;
  /** Placed by the AI second opinion rather than by its name. */
  matchedBy?: 'ai';
  /** What the model read in the name, for an AI match. */
  why?: string;
  /**
   * The whole release, a Usenet post packed in archives or with scrambled
   * names whose name is this one episode (or the movie): its files are
   * unknown until it is downloaded, and its one video is imported.
   */
  whole?: true;
}

export interface PlanSummary {
  fill: number;
  upgrade: number;
  skip: number;
  reject: number;
  /** Distinct episodes the pack has a usable file for. */
  covered: number;
  /** Bytes of the files the full plan (fill + upgrade) would download. */
  bytes: number;
  /** Bytes for filling the missing episodes alone. */
  fillBytes: number;
  replaces: number;
  quality?: string;
  score: number;
  /**
   * Whether Sonarr can match the pack's own title to the series. When it
   * can't, Sonarr's own searches never see the pack.
   */
  sonarrSeesTitle?: boolean;
  /** Files the plan uses that only the AI second opinion placed. */
  aiMatched?: number;
  /**
   * Files the plan uses that hold several episodes each (S01E01-E02).
   * Such packs come last: one file per episode is preferred.
   */
  multi?: number;
  /** Why the second opinion could not be asked, when it could not. */
  aiNote?: string;
}

/** A profile's qualities in order, lowest first, a group counting once. */
const topLevelIndex = (
  items: SonarrProfileItem[],
  match: (item: SonarrProfileItem) => boolean
): number =>
  items.findIndex(
    (item) => match(item) || (item.items ?? []).some((inner) => match(inner))
  );

export const qualityRank = (
  profile: SonarrQualityProfile,
  qualityId: number
): number => topLevelIndex(profile.items, (i) => i.quality?.id === qualityId);

export const qualityAllowed = (
  profile: SonarrQualityProfile,
  qualityId: number
): boolean => {
  for (const item of profile.items) {
    if (item.quality?.id === qualityId) return item.allowed;
    const inner = (item.items ?? []).find((i) => i.quality?.id === qualityId);
    if (inner) return item.allowed && inner.allowed !== false;
  }
  return false;
};

const cutoffRank = (profile: SonarrQualityProfile): number =>
  topLevelIndex(
    profile.items,
    (item) => item.quality?.id === profile.cutoff || item.id === profile.cutoff
  );

export interface Judged {
  qualityId: number;
  revision: number;
  score: number;
}

/** Whether Sonarr would take `next` over the file it already has. */
export const upgradeVerdict = (
  profile: SonarrQualityProfile,
  current: Judged,
  next: Judged
): { upgrade: boolean; reason?: string } => {
  if (!profile.upgradeAllowed) {
    return { upgrade: false, reason: 'Upgrades are off in the profile' };
  }
  const have = qualityRank(profile, current.qualityId);
  const want = qualityRank(profile, next.qualityId);
  // A newer revision (v2, a proper) of the same quality is taken even at
  // the cutoff, as Sonarr does.
  if (want === have && next.revision > current.revision) {
    return { upgrade: true };
  }
  const cutoffMet =
    have >= cutoffRank(profile) && current.score >= profile.cutoffFormatScore;
  if (cutoffMet) {
    return { upgrade: false, reason: 'What is on disk meets the cutoff' };
  }
  if (want > have) return { upgrade: true };
  if (want < have) {
    return { upgrade: false, reason: 'Lower quality than what is on disk' };
  }
  if (next.revision > current.revision) return { upgrade: true };
  if (next.revision < current.revision) {
    return { upgrade: false, reason: 'Older revision than what is on disk' };
  }
  const step = Math.max(1, profile.minUpgradeFormatScore ?? 1);
  if (next.score - current.score >= step) return { upgrade: true };
  return { upgrade: false, reason: 'Not better than what is on disk' };
};

const judged = (
  quality: SonarrQuality | undefined,
  score: number | undefined
): Judged => ({
  qualityId: quality?.quality.id ?? 0,
  revision: quality?.revision.version ?? 1,
  score: score ?? 0,
});

/**
 * Decides one file's action from the episodes it maps to. A file for a
 * missing episode fills it; one for an episode on disk is an upgrade only if
 * Sonarr would take it over every file it would replace.
 */
export const decide = (
  entry: Omit<PlanEntry, 'action' | 'reason' | 'replaces'>,
  profile: SonarrQualityProfile,
  episodes: Map<number, SonarrEpisode>,
  files: Map<number, SonarrEpisodeFile>
): PlanEntry => {
  const base = { ...entry, replaces: 0 };
  if (!entry.episodeIds.length) {
    return { ...base, action: 'reject', reason: 'No matching episode' };
  }
  const qualityId = entry.quality?.quality.id ?? 0;
  if (!qualityId || !qualityAllowed(profile, qualityId)) {
    return {
      ...base,
      action: 'reject',
      reason: `${entry.quality?.quality.name ?? 'Unknown quality'} is not in the profile`,
    };
  }
  if (entry.score < profile.minFormatScore) {
    return {
      ...base,
      action: 'reject',
      reason: `Scores ${entry.score}, below the profile's minimum of ${profile.minFormatScore}`,
    };
  }
  const existing = entry.episodeIds
    .map((id) => episodes.get(id))
    .filter((ep): ep is SonarrEpisode => !!ep && ep.hasFile);
  const missing = entry.episodeIds.length - existing.length;
  const next = judged(entry.quality, entry.score);
  const verdicts = [...new Set(existing.map((ep) => ep.episodeFileId))].map(
    (fileId) => {
      const file = files.get(fileId);
      return file
        ? upgradeVerdict(
            profile,
            judged(file.quality, file.customFormatScore),
            next
          )
        : { upgrade: true };
    }
  );
  const replaces = verdicts.length;
  if (missing > 0) {
    const blocked = verdicts.find((v) => !v.upgrade);
    if (blocked) {
      return {
        ...base,
        action: 'skip',
        reason: `Would replace a file Sonarr keeps: ${blocked.reason}`,
      };
    }
    return { ...base, action: 'fill', replaces };
  }
  const refused = verdicts.find((v) => !v.upgrade);
  if (refused) {
    return { ...base, action: 'skip', reason: refused.reason, replaces: 0 };
  }
  return { ...base, action: 'upgrade', replaces };
};

const better = (
  profile: SonarrQualityProfile,
  a: PlanEntry,
  b: PlanEntry
): boolean => {
  const aq = qualityRank(profile, a.quality?.quality.id ?? 0);
  const bq = qualityRank(profile, b.quality?.quality.id ?? 0);
  if (aq !== bq) return aq > bq;
  const av = a.quality?.revision.version ?? 1;
  const bv = b.quality?.revision.version ?? 1;
  if (av !== bv) return av > bv;
  return a.score > b.score;
};

/**
 * Where a pack holds two files for one episode (a v1 and a v2), only the
 * better one is used; the other is skipped.
 */
export const dedupe = (
  entries: PlanEntry[],
  profile: SonarrQualityProfile
): PlanEntry[] => {
  const best = new Map<string, PlanEntry>();
  for (const entry of entries) {
    if (entry.action !== 'fill' && entry.action !== 'upgrade') continue;
    const key = [...entry.episodeIds].sort().join(',');
    const held = best.get(key);
    if (!held || better(profile, entry, held)) best.set(key, entry);
  }
  const keep = new Set(best.values());
  return entries.map((entry) =>
    (entry.action === 'fill' || entry.action === 'upgrade') && !keep.has(entry)
      ? {
          ...entry,
          action: 'skip',
          reason: 'Another file in the pack is better',
          replaces: 0,
        }
      : entry
  );
};

export const summarize = (entries: PlanEntry[]): PlanSummary => {
  const used = entries.filter(
    (e) => e.action === 'fill' || e.action === 'upgrade'
  );
  const covered = new Set(used.flatMap((e) => e.episodeIds)).size;
  const scores = used.map((e) => e.score).sort((a, b) => a - b);
  const qualities = new Map<string, number>();
  for (const e of used) {
    const name = e.quality?.quality.name;
    if (name) qualities.set(name, (qualities.get(name) ?? 0) + 1);
  }
  const quality = [...qualities.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const count = (action: PlanAction) =>
    entries.filter((e) => e.action === action).length;
  return {
    fill: count('fill'),
    upgrade: count('upgrade'),
    skip: count('skip'),
    reject: count('reject'),
    covered,
    bytes: used.reduce((n, e) => n + e.size, 0),
    fillBytes: entries
      .filter((e) => e.action === 'fill')
      .reduce((n, e) => n + e.size, 0),
    replaces: used.reduce((n, e) => n + e.replaces, 0),
    quality,
    score: scores.length ? scores[Math.floor(scores.length / 2)] : 0,
    aiMatched: used.filter((e) => e.matchedBy === 'ai').length,
    multi: used.filter((e) => e.episodeIds.length > 1).length,
  };
};

/**
 * The entries an approval imports, by mode, with or without the files only
 * the AI second opinion placed.
 */
export const selectEntries = (
  entries: PlanEntry[],
  mode: 'missing' | 'all',
  includeAi = true
): PlanEntry[] =>
  entries.filter(
    (e) =>
      (e.action === 'fill' || (mode === 'all' && e.action === 'upgrade')) &&
      (includeAi || e.matchedBy !== 'ai')
  );

/**
 * Ranks candidates: those that fill something missing, one file per
 * episode before files holding several episodes, then most missing
 * episodes filled, most upgrades, the better score, the healthier swarm.
 */
/**
 * Whether a pack of multi-episode files must wait: another pack would fill
 * something with one file per episode. Multi-episode files are the last
 * resort, so Backfill takes them by itself only when nothing else will do.
 */
export const multiMustWait = (
  pack: { summary: PlanSummary },
  others: { summary: PlanSummary }[]
): boolean =>
  !!pack.summary.multi &&
  others.some((o) => o !== pack && o.summary.fill > 0 && !o.summary.multi);

export const rankCandidates = <
  T extends { summary: PlanSummary; seeders?: number | null },
>(
  candidates: T[]
): T[] =>
  [...candidates].sort(
    (a, b) =>
      Number(b.summary.fill > 0) - Number(a.summary.fill > 0) ||
      // Files holding several episodes are the last resort.
      Number(!!a.summary.multi) - Number(!!b.summary.multi) ||
      b.summary.fill - a.summary.fill ||
      b.summary.upgrade - a.summary.upgrade ||
      b.summary.score - a.summary.score ||
      (b.seeders ?? 0) - (a.seeders ?? 0)
  );
