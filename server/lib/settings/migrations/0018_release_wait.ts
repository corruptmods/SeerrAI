import type { AllSettings } from '@server/lib/settings';

/**
 * Backfill's wait for new episodes now covers films too, under a new name. A
 * wait saved under the old one carries over.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const migrateReleaseWait = (settings: any): AllSettings => {
  const backfill = settings.backfill;
  if (
    backfill &&
    typeof backfill === 'object' &&
    'newEpisodeWaitHours' in backfill
  ) {
    if (typeof backfill.newReleaseWaitHours !== 'number') {
      backfill.newReleaseWaitHours = backfill.newEpisodeWaitHours;
    }
    delete backfill.newEpisodeWaitHours;
  }
  return settings;
};

export default migrateReleaseWait;
