import type { AllSettings } from '@server/lib/settings';

/**
 * Diwali and Pride Month were seasonal themes an admin could turn on
 * (Settings → Appearance → Seasonal themes). They are gone, so whatever
 * was saved for them goes too; the other seasons stay as they were.
 */
const RETIRED = ['diwali', 'pride'];

const removeRetiredSeasons = (settings: any): AllSettings => {
  const seasons = settings.appearance?.seasons;
  if (seasons && typeof seasons === 'object') {
    for (const id of RETIRED) {
      delete seasons[id];
    }
  }
  return settings;
};

export default removeRetiredSeasons;
