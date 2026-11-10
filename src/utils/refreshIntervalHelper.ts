import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';

export const getRequestDownloadStatus = (
  downloadStatus: DownloadingItem[] | undefined,
  seasonNumbers: number[]
): DownloadingItem[] => {
  const items = downloadStatus ?? [];

  if (!seasonNumbers.length) {
    return items;
  }

  /*
   * Keep items in a requested season, and items Sonarr can't attribute to an
   * episode: a season pack is one item with no episode data. Only drop items
   * placed in a season nobody asked for.
   */
  return items.filter(
    (item) => !item.episode || seasonNumbers.includes(item.episode.seasonNumber)
  );
};

/** While downloading: progress moves in seconds. */
const DOWNLOADING_MS = 5_000;
/** Requested, not yet downloading: soon enough to see a download start. */
const WAITING_MS = 30_000;

interface Watched {
  downloadStatus?: DownloadingItem[];
  downloadStatus4k?: DownloadingItem[];
  /** Expected but not downloading yet: polled less often. */
  waiting?: boolean;
}

/**
 * What to poll on a title: its downloads, and whether one may start (requested
 * or partly available, which Backfill fills), so a later Radarr, Sonarr or
 * Backfill download appears on its own.
 */
export const watchMedia = (
  media:
    | {
        status?: MediaStatus;
        status4k?: MediaStatus;
        downloadStatus?: DownloadingItem[];
        downloadStatus4k?: DownloadingItem[];
        seasons?: { status?: MediaStatus; status4k?: MediaStatus }[];
      }
    | undefined
): Watched | undefined =>
  media
    ? {
        downloadStatus: media.downloadStatus,
        downloadStatus4k: media.downloadStatus4k,
        // A season can be on its way while the series as a whole isn't.
        waiting:
          [media.status, media.status4k].some(
            (status) =>
              status === MediaStatus.PROCESSING ||
              status === MediaStatus.PARTIALLY_AVAILABLE
          ) ||
          (media.seasons ?? []).some(
            (season) =>
              season.status === MediaStatus.PROCESSING ||
              season.status4k === MediaStatus.PROCESSING
          ),
      }
    : undefined;

/**
 * `watchMedia` for a music page (album or artist). `onItsWay` covers what only
 * the page knows (e.g. an album being added to the library).
 */
export const watchMusic = ({
  status,
  downloads,
  onItsWay = false,
}: {
  status?: MediaStatus;
  downloads?: DownloadingItem[];
  onItsWay?: boolean;
}): Watched => ({
  downloadStatus: downloads,
  waiting:
    onItsWay ||
    status === MediaStatus.PROCESSING ||
    status === MediaStatus.PARTIALLY_AVAILABLE,
});

/**
 * `watchMedia` for a request card, until the request is done. Completed or
 * declined requests stop waiting even if the title stays partly available
 * (only some seasons requested), which would otherwise poll forever. Active
 * downloads still show.
 */
export const watchRequest = (request: {
  status: MediaRequestStatus;
  media?: Parameters<typeof watchMedia>[0];
}): Watched | undefined => {
  const watched = watchMedia(request.media);
  if (
    watched &&
    (request.status === MediaRequestStatus.COMPLETED ||
      request.status === MediaRequestStatus.DECLINED)
  ) {
    return { ...watched, waiting: false };
  }
  return watched;
};

/**
 * SWR refreshInterval computed from the latest data, so polling adapts as
 * downloads start and progress.
 *
 * `initial` is SWR's fallbackData. SWR passes nothing before its own first
 * fetch, when it sets the first timer; without `initial` a page loaded
 * mid-download would not poll.
 */
export const refreshIntervalHelper =
  <T>(watch: (data: T) => Watched | undefined, initial?: T) =>
  (latest: T | undefined): number => {
    const data = latest ?? initial;
    const watched = data === undefined ? undefined : watch(data);
    if (!watched) {
      return 0;
    }
    if (
      (watched.downloadStatus ?? []).length > 0 ||
      (watched.downloadStatus4k ?? []).length > 0
    ) {
      return DOWNLOADING_MS;
    }
    return watched.waiting ? WAITING_MS : 0;
  };
