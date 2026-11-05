import type {
  DownloadStage,
  DownloadStep,
  DownloadingItem,
} from '@server/lib/downloadtracker';

/** A title's combined download state, for its status badge. */
export interface DownloadSummary {
  /** The stage the badge shows. */
  stage: DownloadStage;
  /** The client's step within that stage, if reported. */
  step?: DownloadStep;
  /** Overall progress 0–100, once the size is known. */
  percent?: number;
}

/**
 * Badge stage priority across mixed downloads: active before blocked, and
 * needs-attention before self-resolving. The tooltip lists each.
 */
const BADGE_ORDER: DownloadStage[] = [
  'downloading',
  'finishing',
  'importing',
  'needsAttention',
  'stalled',
  'failed',
  'queued',
  'paused',
  'waiting',
  // Only once nothing else is under way.
  'imported',
];

/** A missing stage (older cached data) counts as downloading. */
const rank = (stage?: DownloadStage) =>
  Math.max(0, BADGE_ORDER.indexOf(stage ?? 'downloading'));

const finite = (value: number) => (Number.isFinite(value) ? value : 0);

/**
 * A queue item's release. A season pack is listed once per episode; a
 * release held before sending (delay, waiting for better) has no download
 * id, so its title identifies it.
 */
const releaseKey = (item: DownloadingItem, index: number): string =>
  item.downloadId || (item.title ? `title:${item.title}` : `item-${index}`);

/** A title's queue items deduplicated by release, with episode counts. */
export const releasesOf = (
  items: DownloadingItem[] = []
): { item: DownloadingItem; episodes: number }[] => {
  const releases = new Map<
    string,
    { item: DownloadingItem; episodes: number }
  >();
  items.forEach((item, index) => {
    const key = releaseKey(item, index);
    const release = releases.get(key);
    if (release) {
      release.episodes += 1;
    } else {
      releases.set(key, { item, episodes: 1 });
    }
  });
  return [...releases.values()];
};

/** Whether all queue items are one release (e.g. one pack). */
export const isOneRelease = (items: DownloadingItem[]): boolean =>
  items.length > 0 &&
  new Set(items.map((item, index) => releaseKey(item, index))).size === 1;

/** Episodes a series badge names: one episode, a season (pack), an episode range, or a season range. */
export type EpisodeSpan =
  | { kind: 'episode'; season: number; episode: number }
  | { kind: 'season'; season: number }
  | { kind: 'episodes'; season: number; first: number; last: number }
  | { kind: 'seasons'; first: number; last: number };

export const episodeSpan = (
  items: DownloadingItem[]
): EpisodeSpan | undefined => {
  const episodes = items.flatMap((item) =>
    item.episode ? [item.episode] : []
  );
  if (!episodes.length) {
    return undefined;
  }
  const seasons = [...new Set(episodes.map((e) => e.seasonNumber))].sort(
    (a, b) => a - b
  );
  if (seasons.length > 1) {
    return { kind: 'seasons', first: seasons[0], last: seasons.at(-1)! };
  }
  const numbers = [...new Set(episodes.map((e) => e.episodeNumber))].sort(
    (a, b) => a - b
  );
  if (numbers.length === 1) {
    return { kind: 'episode', season: seasons[0], episode: numbers[0] };
  }
  return isOneRelease(items)
    ? { kind: 'season', season: seasons[0] }
    : {
        kind: 'episodes',
        season: seasons[0],
        first: numbers[0],
        last: numbers.at(-1)!,
      };
};

export const summarizeDownloads = (
  items: DownloadingItem[]
): DownloadSummary | undefined => {
  const downloads = new Map<string, DownloadingItem>();
  items.forEach((item, index) => {
    downloads.set(releaseKey(item, index), item);
  });
  if (!downloads.size) {
    return undefined;
  }

  let size = 0;
  let arrived = 0;
  for (const item of downloads.values()) {
    const itemSize = Math.max(0, finite(item.size));
    size += itemSize;
    arrived += Math.max(0, itemSize - Math.max(0, finite(item.sizeLeft)));
  }

  const named = [...downloads.values()].reduce((best, item) =>
    rank(item.stage) < rank(best.stage) ? item : best
  );

  return {
    stage: BADGE_ORDER[rank(named.stage)],
    step: named.step,
    percent:
      size > 0 ? Math.min(100, Math.round((arrived / size) * 100)) : undefined,
  };
};

/** Message names for each stage and step. */
export type DownloadBadgeLabel =
  | 'downloading'
  | 'stalled'
  | 'gettingDetails'
  | 'checking'
  | 'queued'
  | 'paused'
  | 'waiting'
  | 'verifying'
  | 'repairing'
  | 'unpacking'
  | 'moving'
  | 'runningScript'
  | 'finishing'
  | 'importing'
  | 'needsAttention'
  | 'failed'
  | 'imported';

export const downloadBadgeLabel = ({
  stage,
  step,
}: Pick<DownloadSummary, 'stage' | 'step'>): DownloadBadgeLabel => {
  switch (stage) {
    case 'queued':
      return step === 'metadata'
        ? 'gettingDetails'
        : step === 'checking'
          ? 'checking'
          : 'queued';
    case 'finishing':
      switch (step) {
        case 'verifying':
          return 'verifying';
        case 'repairing':
          return 'repairing';
        case 'unpacking':
          return 'unpacking';
        case 'moving':
          return 'moving';
        case 'script':
          return 'runningScript';
        case 'checking':
          return 'checking';
        default:
          return 'finishing';
      }
    case 'stalled':
    case 'paused':
    case 'waiting':
    case 'importing':
    case 'needsAttention':
    case 'failed':
    case 'imported':
      return stage;
    default:
      return 'downloading';
  }
};

/**
 * Whether the download is active now (the badge spins). A queued torrent
 * fetching metadata or checking counts as busy.
 */
export const isDownloadBusy = ({
  stage,
  step,
}: Pick<DownloadSummary, 'stage' | 'step'>): boolean =>
  stage === 'downloading' ||
  stage === 'finishing' ||
  stage === 'importing' ||
  stage === 'imported' ||
  (stage === 'queued' && (step === 'metadata' || step === 'checking'));

/**
 * Seconds in a Radarr/Sonarr "time left" ("01:37:25.8878288", or
 * "1.02:00:00" for 1d 2h). Undefined if missing or invalid.
 */
export const secondsLeft = (timeLeft?: string): number | undefined => {
  const match = timeLeft?.match(/^(?:(\d+)\.)?(\d+):(\d{2}):(\d{2})/);
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 86400 +
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds);
  return total > 0 ? total : undefined;
};
