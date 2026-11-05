import type { AllSettings } from '@server/lib/settings';

/**
 * Existing servers get US in animeExcludedCountries, the rule they had
 * before it was a setting. New servers already have it (empty) and are skipped.
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
