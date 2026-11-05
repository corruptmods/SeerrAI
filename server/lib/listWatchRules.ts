import type { Play } from '@server/lib/watchHistory';
import { isCompletedPlay } from '@server/lib/watchHistory';

export { isCompletedPlay };

/**
 * Whether a movie counts as watched: any completed play after it was added to
 * the list. Earlier plays are ignored on purpose: adding something watched
 * years ago means you intend to rewatch it, so it clears only once you do.
 */
export const hasWatchedMovie = (plays: Play[], addedAt: Date): boolean => {
  const cutoff = Math.floor(addedAt.getTime() / 1000);

  return plays.some(
    (play) => play.at > cutoff && play.kind === 'movie' && isCompletedPlay(play)
  );
};

/**
 * Whether a series counts as watched: every available episode has a completed
 * play after the title was added.
 *
 * `available` holds the episodes Seerr knows exist, as "season:episode". A
 * series with nothing available is never watched, or an unaired show would
 * clear itself the moment it was added.
 */
export const hasWatchedSeries = (
  plays: Play[],
  addedAt: Date,
  available: Set<string>
): boolean => {
  if (!available.size) {
    return false;
  }

  const cutoff = Math.floor(addedAt.getTime() / 1000);
  const watched = new Set<string>();

  for (const play of plays) {
    if (play.at <= cutoff || !isCompletedPlay(play)) {
      continue;
    }

    if (play.kind !== 'episode') {
      continue;
    }

    watched.add(`${play.season}:${play.episode}`);
  }

  for (const episode of available) {
    if (!watched.has(episode)) {
      return false;
    }
  }

  return true;
};

/**
 * A shared list suggests removal only once *everyone* has finished the title:
 * one viewer doesn't mean the household is done.
 */
export const everyoneHasWatched = (perUser: boolean[]): boolean =>
  perUser.length > 0 && perUser.every(Boolean);
