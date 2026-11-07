import type { AllSettings } from '@server/lib/settings';

/**
 * Backfill can now search via Sonarr, Radarr and Lidarr as well as Prowlarr.
 * Installs from before keep searching as they did: with Prowlarr when it is
 * set up; without it Backfill couldn't run, so it now searches the *arrs.
 * Runs only while the choice is unset, so it never overrides an admin's.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const migrateBackfillSearchWith = (settings: any): AllSettings => {
  const backfill = settings.backfill;
  if (
    !backfill ||
    typeof backfill !== 'object' ||
    ['prowlarr', 'arrs', 'both'].includes(backfill.searchWith)
  ) {
    return settings;
  }
  const prowlarr = backfill.prowlarr;
  backfill.searchWith =
    prowlarr && prowlarr.hostname && prowlarr.apiKey ? 'prowlarr' : 'arrs';
  return settings;
};

export default migrateBackfillSearchWith;
