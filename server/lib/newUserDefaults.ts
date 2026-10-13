import type { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { getSettings } from '@server/lib/settings';

/**
 * Gives an account being made what admins chose for new people in
 * Settings → Users, beyond permissions: whether watchlist sync starts on for
 * movies and for series. Without it a new person's Plex or Trakt watchlist
 * never requests anything until they find the switch themselves.
 *
 * Call it on a new account before its first save; the settings are saved
 * with it. Accounts that already exist are never passed here, so they keep
 * their own choice. With both defaults off nothing is added, as before.
 */
export const withNewUserDefaults = <T extends User>(user: T): T => {
  const { defaultWatchlistSyncMovies, defaultWatchlistSyncTv } =
    getSettings().main;

  if (defaultWatchlistSyncMovies || defaultWatchlistSyncTv) {
    user.settings = user.settings ?? new UserSettings();
    user.settings.watchlistSyncMovies = !!defaultWatchlistSyncMovies;
    user.settings.watchlistSyncTv = !!defaultWatchlistSyncTv;
  }

  return user;
};
