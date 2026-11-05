import type { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { getSettings } from '@server/lib/settings';

/**
 * Applies the admin's new-user defaults from Settings → Users beyond
 * permissions: whether watchlist sync starts on for movies and series.
 * Without it a new user's Plex or Trakt watchlist requests nothing until they
 * find the switch.
 *
 * Call on a new account before its first save, which saves the settings.
 * Existing accounts never come here, so they keep their own choice. With both
 * defaults off nothing is added.
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
