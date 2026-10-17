import type { AllSettings } from '@server/lib/settings';

/**
 * Settings → Music once chose where music could be searched (the Music
 * page's own search box, Music on the search page) and how many artists
 * and albums a search showed. Those are fixed now, so only whether music
 * comes below the films and series in All is kept.
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
