import type { PlanEntry } from '@server/lib/backfill/plan';
import type {
  QualityDefinition,
  SonarrProfileItem,
  SonarrQualityProfile,
} from '@server/lib/backfill/sonarr';

/*
 * Sonarr's and Radarr's per-quality size limits, in MB per minute. Sonarr v5
 * keeps them per profile; Radarr and older Sonarr globally per quality.
 * Backfill and the admin agent import files directly, which skips these
 * checks, so they run here: a release outside them needs admin approval.
 */

const MB = 1024 * 1024;

/** A quality's limits in MB per minute; null max is no limit. */
export interface SizeLimit {
  min: number;
  max: number | null;
}

/** Limits by quality id: the profile's, else the app's. */
export const limitsOf = (
  profile: SonarrQualityProfile,
  definitions: QualityDefinition[]
): Map<number, SizeLimit> => {
  const limits = new Map<number, SizeLimit>();
  for (const def of definitions) {
    if (def.minSize == null && def.maxSize == null) continue;
    limits.set(def.quality.id, {
      min: def.minSize ?? 0,
      max: def.maxSize ?? null,
    });
  }
  const walk = (items: SonarrProfileItem[] = []) => {
    for (const item of items) {
      if (item.quality && (item.minSize != null || item.maxSize != null)) {
        limits.set(item.quality.id, {
          min: item.minSize ?? 0,
          max: item.maxSize ?? null,
        });
      }
      walk(item.items);
    }
  };
  walk(profile.items);
  return limits;
};

const gb = (bytes: number) =>
  `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`;

/** A file outside its quality's limits, with a readable note. */
export interface SizeProblem {
  index: number;
  note: string;
}

/**
 * Filled or upgraded plan files outside their quality's limits. Multi-episode
 * files scale by episode count. Unknown runtimes and unlimited qualities pass.
 */
export const sizeProblems = (
  plan: PlanEntry[],
  limits: Map<number, SizeLimit>,
  runtimeMinutes: number | undefined,
  app: string
): SizeProblem[] => {
  if (!runtimeMinutes || runtimeMinutes <= 0) return [];
  const problems: SizeProblem[] = [];
  for (const entry of plan) {
    if (entry.action !== 'fill' && entry.action !== 'upgrade') continue;
    const quality = entry.quality?.quality;
    const limit = quality ? limits.get(quality.id) : undefined;
    if (!quality || !limit) continue;
    const minutes = runtimeMinutes * Math.max(1, entry.episodeIds.length);
    const perMinute = entry.size / MB / minutes;
    if (limit.max != null && limit.max > 0 && perMinute > limit.max) {
      problems.push({
        index: entry.index,
        note: `${gb(entry.size)} is over ${app}'s ${quality.name} limit of ${gb(limit.max * MB * minutes)}`,
      });
    } else if (limit.min > 0 && perMinute < limit.min) {
      problems.push({
        index: entry.index,
        note: `${gb(entry.size)} is under ${app}'s ${quality.name} minimum of ${gb(limit.min * MB * minutes)}`,
      });
    }
  }
  return problems;
};

/** A pack's reason line, e.g. "Outside the size limits: 6.2 GB is over …". */
export const sizeNote = (problems: SizeProblem[]): string | undefined =>
  problems.length
    ? `Outside the size limits: ${problems
        .slice(0, 2)
        .map((p) => p.note)
        .join(
          '; '
        )}${problems.length > 2 ? `, and ${problems.length - 2} more` : ''}`
    : undefined;
