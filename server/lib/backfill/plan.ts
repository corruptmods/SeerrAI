import type {
  SonarrEpisode,
  SonarrEpisodeFile,
  SonarrProfileItem,
  SonarrQuality,
  SonarrQualityProfile,
} from '@server/lib/backfill/sonarr';
import { getSettings } from '@server/lib/settings';

/**
 * Hours a new episode is left to Sonarr after it airs (Settings → Backfill →
 * New episodes wait). Backfill treats it as missing only after this, so
 * Sonarr's own feeds get the first go, even for a show just requested.
 */
export const newEpisodeWaitHours = (): number =>
  getSettings().backfill.newEpisodeWaitHours ?? 12;

/** Aired, and long enough ago that Backfill may fetch it. */
export const airedAWhile = (ep: { airDateUtc?: string }): boolean =>
  !!ep.airDateUtc &&
  new Date(ep.airDateUtc).getTime() <
    Date.now() - newEpisodeWaitHours() * 3_600_000;

/** "Aired under 12 hours ago". */
export const airedUnder = (): string =>
  `Aired under ${newEpisodeWaitHours()} hour${newEpisodeWaitHours() === 1 ? '' : 's'} ago`;

/*
 * A pack's effect on a series, file by file, judged as Sonarr does: profile
 * quality order, then revision (v2, v3), then custom format score. Never
 * replaces a file Sonarr would keep.
 */

export type PlanAction = 'fill' | 'upgrade' | 'skip' | 'reject';

export interface PlanEntry {
  /** Index in the torrent or NZB. */
  index: number;
  /** Path inside the pack. */
  path: string;
  size: number;
  /** The name Sonarr judged. */
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
  /**
   * Placed by the AI second opinion, or by the episode title in its name
   * where its number points to another episode.
   */
  matchedBy?: 'ai' | 'title';
  /** What the model read in the name, for an AI match. */
  why?: string;
  /** The album edition (Lidarr release) imported into; track ids are its. */
  releaseId?: number;
  /**
   * The whole release: a Usenet post in archives or with scrambled names,
   * named as this one episode (or movie). Its files are unknown until
   * downloaded; its one video is imported.
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
  /** Bytes the full plan (fill + upgrade) downloads. */
  bytes: number;
  /** Bytes for filling missing episodes only. */
  fillBytes: number;
  replaces: number;
  quality?: string;
  score: number;
  /**
   * Whether Sonarr matches the pack title to the series; if not, Sonarr's
   * own searches never see the pack.
   */
  sonarrSeesTitle?: boolean;
  /** Files the plan uses that only the AI second opinion placed. */
  aiMatched?: number;
  /**
   * Used files holding several episodes (S01E01-E02). Such packs rank last:
   * one file per episode is preferred.
   */
  multi?: number;
  /** Why the second opinion wasn't asked, if it wasn't. */
  aiNote?: string;
  /**
   * Files to take that are outside Sonarr's or Radarr's size limits: such a
   * pack is offered only when nothing within them is, and never taken
   * without an admin.
   */
  outsideSize?: number;
  /** The size-limit problem in words. */
  sizeNote?: string;
}

/** Index of the matching top-level quality, lowest first; groups count once. */
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
  // As in Sonarr, a newer revision (v2, proper) upgrades even at the cutoff.
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
 * Decides one file's action. A file for a missing episode fills it; one for
 * an episode on disk upgrades only if Sonarr would take it over every file
 * it replaces.
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
  if (
    missing > 0 &&
    entry.episodeIds.every((id) => {
      const ep = episodes.get(id);
      return ep?.hasFile || (!!ep?.airDateUtc && !airedAWhile(ep));
    })
  ) {
    return {
      ...base,
      action: 'skip',
      reason: `${airedUnder()}: Sonarr gets new episodes first`,
    };
  }
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
 * When a pack has two files for one episode (v1 and v2), keeps the better
 * and skips the other.
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

/** The entries an approval imports, by mode, optionally without AI matches. */
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
 * Whether a multi-episode pack must wait because another pack fills
 * something with one file per episode. Multi-episode files are a last
 * resort, taken automatically only when nothing else will do.
 */
export const multiMustWait = (
  pack: { summary: PlanSummary },
  others: { summary: PlanSummary }[]
): boolean =>
  !!pack.summary.multi &&
  others.some((o) => o !== pack && o.summary.fill > 0 && !o.summary.multi);

/**
 * A torrent its indexer reports 0 seeders for. Counts are often stale, but
 * 0 is the likeliest never to finish.
 */
export const unseeded = (pack: {
  protocol?: string;
  seeders?: number | null;
}): boolean => pack.protocol === 'torrent' && pack.seeders === 0;

/**
 * Ranks candidates: fills first, seeded before unseeded, one file per
 * episode before multi-episode, then most fills, most upgrades, better
 * score, more seeders.
 */
export const rankCandidates = <
  T extends {
    summary: PlanSummary;
    seeders?: number | null;
    protocol?: string;
  },
>(
  candidates: T[]
): T[] =>
  [...candidates].sort(
    (a, b) =>
      Number(b.summary.fill > 0) - Number(a.summary.fill > 0) ||
      Number(unseeded(a)) - Number(unseeded(b)) ||
      Number(!!a.summary.multi) - Number(!!b.summary.multi) ||
      b.summary.fill - a.summary.fill ||
      b.summary.upgrade - a.summary.upgrade ||
      b.summary.score - a.summary.score ||
      (b.seeders ?? 0) - (a.seeders ?? 0)
  );
