import type {
  DownloadStage,
  DownloadStep,
  DownloadingItem,
} from '@server/lib/downloadtracker';

/** Where a title's downloads stand, put together, for its status badge. */
export interface DownloadSummary {
  /** The stage the badge names. */
  stage: DownloadStage;
  /** What the download client is doing within that stage, when it says. */
  step?: DownloadStep;
  /** How much of all of it has arrived, 0 to 100, once its size is known. */
  percent?: number;
}

/**
 * Which stage a badge names when a title's downloads stand in different
 * places: what is happening to it before what is holding it up, and what
 * needs someone before what will sort itself out. The tooltip lists each.
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
  // Imported, the media server about to list it: only once nothing else
  // is under way.
  'imported',
];

/** A copy saved before stages were sent counts as downloading. */
const rank = (stage?: DownloadStage) =>
  Math.max(0, BADGE_ORDER.indexOf(stage ?? 'downloading'));

const finite = (value: number) => (Number.isFinite(value) ? value : 0);

/**
 * Which release a queue item is part of. A season pack is one release,
 * listed once for each of its episodes; one held back before it is sent
 * (a delay, or waiting for a better copy) has no download yet, so its
 * name tells it apart.
 */
const releaseKey = (item: DownloadingItem, index: number): string =>
  item.downloadId || (item.title ? `title:${item.title}` : `item-${index}`);

/**
 * A title's queue items, one per release, each with how many episodes it
 * brings: a pack is shown once, as its season.
 */
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

/** Whether a title's queue items are all one release, such as one pack. */
export const isOneRelease = (items: DownloadingItem[]): boolean =>
  items.length > 0 &&
  new Set(items.map((item, index) => releaseKey(item, index))).size === 1;

/**
 * Which episodes a series' badge names: the episode, when there is one; the
 * season, for a pack; the stretch of a season, for several downloads in it;
 * or the stretch of seasons.
 */
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

/** The badge's words for each stage and step, as message names. */
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
 * Whether something is happening to it right now (the badge spins), rather
 * than waiting or held up. A torrent getting its details or being checked
 * before it starts is busy, though queued.
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
 * Seconds in Radarr's and Sonarr's "time left": "01:37:25.8878288", or
 * "1.02:00:00" for a day and two hours. Undefined for none or nonsense.
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
