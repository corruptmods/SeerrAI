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
   * Keep anything that belongs to a requested season, and anything Sonarr
   * could not attribute to an episode at all.
   *
   * A season pack is queued as one item with no episode data, so filtering on
   * `item.episode` alone dropped it: the series downloaded with no progress
   * bar and the card sat on its pre-download status. Only discard an item we
   * can positively place in a season nobody asked for.
   */
  return items.filter(
    (item) => !item.episode || seasonNumbers.includes(item.episode.seasonNumber)
  );
};

/** While something is downloading: progress moves in seconds. */
const DOWNLOADING_MS = 5_000;
/** Requested and on its way: soon enough to see a download start. */
const WAITING_MS = 30_000;

interface Watched {
  downloadStatus?: DownloadingItem[];
  downloadStatus4k?: DownloadingItem[];
  /** On its way but not downloading yet: checked less often. */
  waiting?: boolean;
}

/**
 * What to watch on a title: its downloads, and whether one may start any
 * moment. Requested and not here yet, or here in part (Backfill fills
 * what is missing from those), so a download that starts after the page
 * loaded, Radarr's, Sonarr's or Backfill's, shows up on its own.
 */
export const watchMedia = (
  media:
    | {
        status?: MediaStatus;
        status4k?: MediaStatus;
        downloadStatus?: DownloadingItem[];
        downloadStatus4k?: DownloadingItem[];
      }
    | undefined
): Watched | undefined =>
  media
    ? {
        downloadStatus: media.downloadStatus,
        downloadStatus4k: media.downloadStatus4k,
        waiting: [media.status, media.status4k].some(
          (status) =>
            status === MediaStatus.PROCESSING ||
            status === MediaStatus.PARTIALLY_AVAILABLE
        ),
      }
    : undefined;

/**
 * What to watch on a request card: its title, as `watchMedia`, until the
 * request itself is finished with. A completed request (everything it asked
 * for is here) or a declined one has nothing more coming, however the title
 * stands: a series stays partly available for good when only some of its
 * seasons were ever asked for, and waiting on that would check every half
 * minute for as long as the card is open. A download still shows.
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
 * How often SWR asks again, worked out from the latest answer rather than
 * the first, so progress keeps moving after the page has loaded and a
 * download that starts later still shows up.
 *
 * `initial` is the answer the page arrived with (SWR's fallbackData). SWR
 * passes only what it has fetched itself, nothing at first, and sets the
 * first timer then; without `initial` a page that loaded mid-download only
 * started checking again if something else made it redraw.
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
