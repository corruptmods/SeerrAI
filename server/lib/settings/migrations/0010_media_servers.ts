import { MediaServerType } from '@server/constants/server';
import type { AllSettings } from '@server/lib/settings';
import { jellyfinDefaults } from '@server/lib/settings';

/**
 * Seerr used to work with one media server, chosen at setup. Each server
 * now says whether Seerr is connected to it and whether people may sign in
 * with it; the one chosen at setup stays the primary one
 * (main.mediaServerType), and its sign-in follows the old single switch.
 *
 * Emby used to share Jellyfin's settings. On an Emby server they move to
 * their own block, with Jellyfin's scan schedules, and the ids Emby gave
 * titles and people are moved to Emby's own columns once the database is
 * open (pendingEmbySplit, lib/embySplit).
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
