import type { AllSettings } from '@server/lib/settings';

/**
 * Music in All search results used to start off, and that "off" was saved
 * with the rest of Settings → Music. It now starts on once Lidarr is set
 * up, unless an admin chose otherwise. A saved "off" can't be told apart
 * from the old default, so it is cleared once, to the new one; "on" is
 * kept. Run once, so turning it off later sticks.
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
