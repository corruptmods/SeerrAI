import type { AllSettings } from '@server/lib/settings';

/**
 * Splits Backfill's concurrent download limit into series (the old value),
 * movies and music; the new two start at the old value. Runs once.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const migrateSplitDownloadLimits = (settings: any): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes('0016_split_download_limits')
  ) {
    return settings;
  }

  const backfill = settings.backfill;
  if (
    backfill &&
    typeof backfill === 'object' &&
    typeof backfill.maxActiveJobs === 'number'
  ) {
    backfill.maxMovieJobs ??= backfill.maxActiveJobs;
    backfill.maxMusicJobs ??= backfill.maxActiveJobs;
  }

  if (!Array.isArray(settings.migrations)) {
    settings.migrations = [];
  }
  settings.migrations.push('0016_split_download_limits');

  return settings;
};

export default migrateSplitDownloadLimits;
