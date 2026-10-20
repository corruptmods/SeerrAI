import type { AllSettings } from '@server/lib/settings';

const HEALTH = 65536;
const WRONG_MATCH = 131072;

/**
 * The Wrong Match notification is new, so the bit is missing from every
 * channel that chose its types, which would read as "off". A channel that
 * sends Health is given Wrong Match too; one that sends everything (no
 * types chosen) gets it anyway. Run once, so turning it off later sticks.
 */
const migrateWrongMatchNotifications = (settings: any): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes('0014_wrong_match_notifications')
  ) {
    return settings;
  }

  const agents = settings.notifications?.agents;
  if (agents && typeof agents === 'object') {
    for (const agent of Object.values(agents) as { types?: unknown }[]) {
      if (
        agent &&
        typeof agent.types === 'number' &&
        agent.types & HEALTH &&
        !(agent.types & WRONG_MATCH)
      ) {
        agent.types |= WRONG_MATCH;
      }
    }
  }

  if (!Array.isArray(settings.migrations)) {
    settings.migrations = [];
  }
  settings.migrations.push('0014_wrong_match_notifications');

  return settings;
};

export default migrateWrongMatchNotifications;
