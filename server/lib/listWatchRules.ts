import type { TautulliHistoryRecord } from '@server/api/tautulli';

/**
 * A play counts as finished when Tautulli marked it watched. Some records
 * carry only a completion percentage, so fall back to that.
 */
const COMPLETE_PERCENT = 85;

export const isCompletedPlay = (record: TautulliHistoryRecord): boolean =>
  record.watched_status >= 1 || record.percent_complete >= COMPLETE_PERCENT;

/**
 * Whether a movie counts as watched: any completed play after the title was
 * added to the list. Plays from before it was added are deliberately ignored
 * — adding something you watched years ago means you intend to watch it
 * again, so it should only clear once you actually do.
 */
export const hasWatchedMovie = (
  plays: TautulliHistoryRecord[],
  addedAt: Date
): boolean => {
  const cutoff = Math.floor(addedAt.getTime() / 1000);

  return plays.some(
    (play) => play.date > cutoff && play.media_type === 'movie' && isCompletedPlay(play)
  );
};

/**
 * Whether a series counts as watched: every episode available in the library
 * has a completed play after the title was added.
 *
 * `available` is the set of episodes Seerr knows exist, as "season:episode".
 * A series with nothing available is never "watched" — otherwise a show that
 * has not aired yet would clear itself the moment it was added.
 */
export const hasWatchedSeries = (
  plays: TautulliHistoryRecord[],
  addedAt: Date,
  available: Set<string>
): boolean => {
  if (!available.size) {
    return false;
  }

  const cutoff = Math.floor(addedAt.getTime() / 1000);
  const watched = new Set<string>();

  for (const play of plays) {
    if (play.date <= cutoff || !isCompletedPlay(play)) {
      continue;
    }

    if (play.media_type !== 'episode') {
      continue;
    }

    watched.add(`${play.parent_media_index}:${play.media_index}`);
  }

  for (const episode of available) {
    if (!watched.has(episode)) {
      return false;
    }
  }

  return true;
};

/**
 * A shared list only suggests removal once *everyone* on it has finished the
 * title — one person watching it does not mean the household is done with it.
 */
export const everyoneHasWatched = (perUser: boolean[]): boolean =>
  perUser.length > 0 && perUser.every(Boolean);
