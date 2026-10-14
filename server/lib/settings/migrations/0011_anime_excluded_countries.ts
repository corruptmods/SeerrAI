import type { AllSettings } from '@server/lib/settings';

/**
 * What counts as anime became a setting: the countries whose anime is left
 * out unless it is in Japanese. Until then, American titles were always left
 * out, so a server from before the setting keeps that rule. A new server
 * already has the setting (empty) when it first saves, and is left alone.
 */
const migrateAnimeExcludedCountries = (settings: any): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes('0011_anime_excluded_countries')
  ) {
    return settings;
  }

  if (settings.main && !Array.isArray(settings.main.animeExcludedCountries)) {
    settings.main.animeExcludedCountries = ['US'];
  }

  if (!Array.isArray(settings.migrations)) {
    settings.migrations = [];
  }
  settings.migrations.push('0011_anime_excluded_countries');

  return settings;
};

export default migrateAnimeExcludedCountries;
