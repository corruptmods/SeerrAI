import type { AllSettings } from '@server/lib/settings';

/**
 * Drops retired music search options (where music is searchable, result
 * counts); only the All-search toggle remains.
 */
const DROPPED = ['musicPage', 'chip', 'artists', 'albums'];

const trimMusicSearch = (settings: any): AllSettings => {
  const search = settings.music?.search;
  if (search && typeof search === 'object') {
    for (const key of DROPPED) {
      delete search[key];
    }
  }
  return settings;
};

export default trimMusicSearch;
