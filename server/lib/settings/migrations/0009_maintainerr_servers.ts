import type { AllSettings } from '@server/lib/settings';

/**
 * Maintainerr started as a single server, saved as one object. It is now a
 * list, like Radarr and Sonarr. A configured, enabled server becomes the
 * first entry; one that was never set up, or was switched off, becomes an
 * empty list rather than a server that is suddenly live.
 */
const migrateMaintainerrServers = (settings: any): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes('0009_maintainerr_servers')
  ) {
    return settings;
  }

  const old = settings.maintainerr;

  if (old && !Array.isArray(old)) {
    settings.maintainerr =
      old.enabled && old.hostname
        ? [
            {
              id: 0,
              name: 'Maintainerr',
              hostname: old.hostname,
              port: old.port ?? 6246,
              useSsl: old.useSsl ?? false,
              urlBase: old.urlBase ?? '',
              apiKey: old.apiKey ?? '',
              showBadges: old.showBadges ?? true,
              showDeletingSoon: old.showDeletingSoon ?? true,
              allowKeep: old.allowKeep ?? true,
              keepDays: old.keepDays ?? 0,
              soonDays: old.soonDays ?? 14,
            },
          ]
        : [];
  }

  if (!Array.isArray(settings.migrations)) {
    settings.migrations = [];
  }
  settings.migrations.push('0009_maintainerr_servers');

  return settings;
};

export default migrateMaintainerrServers;
