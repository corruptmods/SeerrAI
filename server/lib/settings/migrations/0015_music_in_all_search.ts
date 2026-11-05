import type { AllSettings } from '@server/lib/settings';

/**
 * Clears a saved "off" for music in All search, since it can't be told from
 * the old default; unset now follows whether Lidarr is set up. "On" is kept.
 * Runs once, so turning it off later sticks.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const migrateMusicInAllSearch = (settings: any): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes('0015_music_in_all_search')
  ) {
    return settings;
  }

  const search = settings.music?.search;
  if (search && typeof search === 'object' && search.inAll === false) {
    delete search.inAll;
  }

  if (!Array.isArray(settings.migrations)) {
    settings.migrations = [];
  }
  settings.migrations.push('0015_music_in_all_search');

  return settings;
};

export default migrateMusicInAllSearch;
