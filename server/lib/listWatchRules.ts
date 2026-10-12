import type { Play } from '@server/lib/watchHistory';
import { isCompletedPlay } from '@server/lib/watchHistory';

export { isCompletedPlay };

/**
 * Whether a movie counts as watched: any completed play after the title was
 * added to the list. Plays from before it was added are deliberately ignored
 * — adding something you watched years ago means you intend to watch it
 * again, so it should only clear once you actually do.
 */
export const hasWatchedMovie = (plays: Play[], addedAt: Date): boolean => {
  const cutoff = Math.floor(addedAt.getTime() / 1000);

  return plays.some(
    (play) => play.at > cutoff && play.kind === 'movie' && isCompletedPlay(play)
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
 * A shared list only suggests removal once *everyone* on it has finished the
 * title — one person watching it does not mean the household is done with it.
 */
export const everyoneHasWatched = (perUser: boolean[]): boolean =>
  perUser.length > 0 && perUser.every(Boolean);
