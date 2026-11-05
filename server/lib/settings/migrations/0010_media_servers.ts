import { MediaServerType } from '@server/constants/server';
import type { AllSettings } from '@server/lib/settings';
import { jellyfinDefaults } from '@server/lib/settings';

/**
 * Adds per-server `connected` and `signIn` flags. The setup server stays
 * primary (main.mediaServerType) and its sign-in follows the old switch.
 *
 * On Emby, settings move out of the shared Jellyfin block (with Jellyfin's
 * scan schedules), and Emby ids move to Emby columns once the database opens
 * (pendingEmbySplit, lib/embySplit).
 */
const migrateMediaServers = (settings: any): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes('0010_media_servers')
  ) {
    return settings;
  }

  const type = settings.main?.mediaServerType;
  const signIn = settings.main?.mediaServerLogin !== false;

  settings.plex = {
    ...settings.plex,
    connected: type === MediaServerType.PLEX,
    signIn: type === MediaServerType.PLEX ? signIn : true,
  };

  if (type === MediaServerType.EMBY) {
    settings.emby = {
      ...jellyfinDefaults(),
      ...settings.jellyfin,
      connected: true,
      signIn,
    };
    settings.jellyfin = jellyfinDefaults();

    settings.jobs = settings.jobs ?? {};
    for (const job of ['recently-added-scan', 'full-scan']) {
      if (settings.jobs[`jellyfin-${job}`]) {
        settings.jobs[`emby-${job}`] = { ...settings.jobs[`jellyfin-${job}`] };
      }
    }

    settings.pendingEmbySplit = true;
  } else {
    settings.jellyfin = {
      ...jellyfinDefaults(),
      ...settings.jellyfin,
      connected: type === MediaServerType.JELLYFIN,
      signIn: type === MediaServerType.JELLYFIN ? signIn : true,
    };
    settings.emby = { ...jellyfinDefaults(), ...settings.emby };
  }

  if (!Array.isArray(settings.migrations)) {
    settings.migrations = [];
  }
  settings.migrations.push('0010_media_servers');

  return settings;
};

export default migrateMediaServers;
