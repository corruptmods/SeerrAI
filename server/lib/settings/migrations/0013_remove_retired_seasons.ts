import type { AllSettings } from '@server/lib/settings';

/**
 * Removes saved settings for the retired Diwali and Pride Month seasonal
 * themes.
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
