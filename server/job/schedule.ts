import { MediaServerType } from '@server/constants/server';
import blocklistedTagsProcessor from '@server/job/blocklistedTagsProcessor';
import animeCheck from '@server/lib/animeCheck';
import availabilitySync from '@server/lib/availabilitySync';
import backfill from '@server/lib/backfill/engine';
import { maintenanceStatus, runDbMaintenance } from '@server/lib/dbMaintenance';
import downloadTracker from '@server/lib/downloadtracker';
import episodeSync from '@server/lib/episodeSync';
import futureSeasons from '@server/lib/futureSeasons';
import healthAlerts from '@server/lib/healthAlerts';
import ImageProxy from '@server/lib/imageproxy';
import notificationReconciler from '@server/lib/notificationReconciler';
import plexMatchCheck from '@server/lib/plexMatchCheck';
import plexUserImport from '@server/lib/plexUserImport';
import refreshToken from '@server/lib/refreshToken';
import {
  jellyfinFullScanner,
  jellyfinRecentScanner,
} from '@server/lib/scanners/jellyfin';
import { plexFullScanner, plexRecentScanner } from '@server/lib/scanners/plex';
import { radarrScanner } from '@server/lib/scanners/radarr';
import { sonarrScanner } from '@server/lib/scanners/sonarr';
import type { JobId } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import watchlistSync from '@server/lib/watchlistsync';
import logger from '@server/logger';
import schedule from 'node-schedule';

interface ScheduledJob {
  id: JobId;
  job: schedule.Job;
  name: string;
  type: 'process' | 'command';
  interval: 'seconds' | 'minutes' | 'hours' | 'days' | 'fixed';
  cronSchedule: string;
  running?: () => boolean;
  cancelFn?: () => void;
}

export const scheduledJobs: ScheduledJob[] = [];

export const startJobs = (): void => {
  const jobs = getSettings().jobs;
  const mediaServerType = getSettings().main.mediaServerType;

  if (mediaServerType === MediaServerType.PLEX) {
    // Run recently added plex scan every 5 minutes
    scheduledJobs.push({
      id: 'plex-recently-added-scan',
      name: 'Plex Recently Added Scan',
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs['plex-recently-added-scan'].schedule,
      job: schedule.scheduleJob(
        jobs['plex-recently-added-scan'].schedule,
        () => {
          logger.info('Starting scheduled job: Plex Recently Added Scan', {
            label: 'Jobs',
          });
          plexRecentScanner.run();
        }
      ),
      running: () => plexRecentScanner.status().running,
      cancelFn: () => plexRecentScanner.cancel(),
    });

    // Run full plex scan every 24 hours
    scheduledJobs.push({
      id: 'plex-full-scan',
      name: 'Plex Full Library Scan',
      type: 'process',
      interval: 'hours',
      cronSchedule: jobs['plex-full-scan'].schedule,
      job: schedule.scheduleJob(jobs['plex-full-scan'].schedule, () => {
        logger.info('Starting scheduled job: Plex Full Library Scan', {
          label: 'Jobs',
        });
        plexFullScanner.run();
      }),
      running: () => plexFullScanner.status().running,
      cancelFn: () => plexFullScanner.cancel(),
    });

    scheduledJobs.push({
      id: 'plex-refresh-token',
      name: 'Plex Refresh Token',
      type: 'process',
      interval: 'fixed',
      cronSchedule: jobs['plex-refresh-token'].schedule,
      job: schedule.scheduleJob(jobs['plex-refresh-token'].schedule, () => {
        logger.info('Starting scheduled job: Plex Refresh Token', {
          label: 'Jobs',
        });
        refreshToken.run();
      }),
    });

    // Watchlist Sync
    scheduledJobs.push({
      id: 'plex-watchlist-sync',
      name: 'Plex Watchlist Sync',
      type: 'process',
      interval: 'seconds',
      cronSchedule: jobs['plex-watchlist-sync'].schedule,
      job: schedule.scheduleJob(jobs['plex-watchlist-sync'].schedule, () => {
        logger.info('Starting scheduled job: Plex Watchlist Sync', {
          label: 'Jobs',
        });
        watchlistSync.syncWatchlist().catch((e) => {
          logger.error('Failed to sync watchlists', {
            label: 'Plex Watchlist Sync',
            errorMessage: e.message,
          });
        });
      }),
      running: () => watchlistSync.running,
    });
  } else if (
    mediaServerType === MediaServerType.JELLYFIN ||
    mediaServerType === MediaServerType.EMBY
  ) {
    // Run recently added jellyfin sync every 5 minutes
    scheduledJobs.push({
      id: 'jellyfin-recently-added-scan',
      name: 'Jellyfin Recently Added Scan',
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs['jellyfin-recently-added-scan'].schedule,
      job: schedule.scheduleJob(
        jobs['jellyfin-recently-added-scan'].schedule,
        () => {
          logger.info('Starting scheduled job: Jellyfin Recently Added Scan', {
            label: 'Jobs',
          });
          jellyfinRecentScanner.run();
        }
      ),
      running: () => jellyfinRecentScanner.status().running,
      cancelFn: () => jellyfinRecentScanner.cancel(),
    });

    // Run full jellyfin sync every 24 hours
    scheduledJobs.push({
      id: 'jellyfin-full-scan',
      name: 'Jellyfin Full Library Scan',
      type: 'process',
      interval: 'hours',
      cronSchedule: jobs['jellyfin-full-scan'].schedule,
      job: schedule.scheduleJob(jobs['jellyfin-full-scan'].schedule, () => {
        logger.info('Starting scheduled job: Jellyfin Full Scan', {
          label: 'Jobs',
        });
        jellyfinFullScanner.run();
      }),
      running: () => jellyfinFullScanner.status().running,
      cancelFn: () => jellyfinFullScanner.cancel(),
    });
  }

  // Run full radarr scan every 24 hours
  scheduledJobs.push({
    id: 'radarr-scan',
    name: 'Radarr Scan',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['radarr-scan'].schedule,
    job: schedule.scheduleJob(jobs['radarr-scan'].schedule, () => {
      logger.info('Starting scheduled job: Radarr Scan', { label: 'Jobs' });
      radarrScanner.run();
    }),
    running: () => radarrScanner.status().running,
    cancelFn: () => radarrScanner.cancel(),
  });

  // Run full sonarr scan every 24 hours
  scheduledJobs.push({
    id: 'sonarr-scan',
    name: 'Sonarr Scan',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['sonarr-scan'].schedule,
    job: schedule.scheduleJob(jobs['sonarr-scan'].schedule, () => {
      logger.info('Starting scheduled job: Sonarr Scan', { label: 'Jobs' });
      sonarrScanner.run();
    }),
    running: () => sonarrScanner.status().running,
    cancelFn: () => sonarrScanner.cancel(),
  });

  // Checks if media is still available in plex/sonarr/radarr libs
  scheduledJobs.push({
    id: 'availability-sync',
    name: 'Media Availability Sync',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['availability-sync'].schedule,
    job: schedule.scheduleJob(jobs['availability-sync'].schedule, () => {
      logger.info('Starting scheduled job: Media Availability Sync', {
        label: 'Jobs',
      });
      availabilitySync.run();
    }),
    running: () => availabilitySync.running,
    cancelFn: () => availabilitySync.cancel(),
  });

  // Run download sync every minute
  scheduledJobs.push({
    id: 'download-sync',
    name: 'Download Sync',
    type: 'command',
    interval: 'seconds',
    cronSchedule: jobs['download-sync'].schedule,
    job: schedule.scheduleJob(jobs['download-sync'].schedule, () => {
      logger.debug('Starting scheduled job: Download Sync', {
        label: 'Jobs',
      });
      downloadTracker.updateDownloads();
    }),
  });

  // A minute after Radarr or Sonarr imports something, the media server's
  // recently added scan runs (and again each minute, a few times, until the
  // media server lists it), so the title shows as available then rather
  // than at the next scheduled scan.
  downloadTracker.whenImported(() => {
    const scanner =
      mediaServerType === MediaServerType.PLEX
        ? plexRecentScanner
        : mediaServerType === MediaServerType.JELLYFIN ||
            mediaServerType === MediaServerType.EMBY
          ? jellyfinRecentScanner
          : undefined;
    if (!scanner || scanner.status().running) return;
    logger.info('Downloads were imported; running the recently added scan', {
      label: 'Jobs',
    });
    return scanner.run();
  });

  // Track per-episode availability from Sonarr
  scheduledJobs.push({
    id: 'episode-sync',
    name: 'Episode Sync',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['episode-sync'].schedule,
    job: schedule.scheduleJob(jobs['episode-sync'].schedule, () => {
      logger.debug('Starting scheduled job: Episode Sync', { label: 'Jobs' });
      episodeSync.run();
    }),
  });

  // Give new Plex friends an account, when Auto-Import Plex Users is on
  if (mediaServerType === MediaServerType.PLEX) {
    scheduledJobs.push({
      id: 'plex-user-import',
      name: 'Plex User Import',
      type: 'process',
      interval: 'hours',
      cronSchedule: jobs['plex-user-import'].schedule,
      job: schedule.scheduleJob(jobs['plex-user-import'].schedule, () => {
        logger.debug('Starting scheduled job: Plex User Import', {
          label: 'Jobs',
        });
        plexUserImport.run();
      }),
    });
  }

  // Request each followed series' new seasons as they premiere
  scheduledJobs.push({
    id: 'future-seasons',
    name: 'Future Season Requests',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['future-seasons'].schedule,
    job: schedule.scheduleJob(jobs['future-seasons'].schedule, () => {
      logger.debug('Starting scheduled job: Future Season Requests', {
        label: 'Jobs',
      });
      futureSeasons.run();
    }),
  });

  // Catch any availability or failure notification the subscribers missed
  scheduledJobs.push({
    id: 'notification-reconcile',
    name: 'Notification Reconcile',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['notification-reconcile'].schedule,
    job: schedule.scheduleJob(jobs['notification-reconcile'].schedule, () => {
      logger.debug('Starting scheduled job: Notification Reconcile', {
        label: 'Jobs',
      });
      notificationReconciler.run();
    }),
  });

  // Reset download sync everyday at 01:00 am
  scheduledJobs.push({
    id: 'download-sync-reset',
    name: 'Download Sync Reset',
    type: 'command',
    interval: 'hours',
    cronSchedule: jobs['download-sync-reset'].schedule,
    job: schedule.scheduleJob(jobs['download-sync-reset'].schedule, () => {
      logger.info('Starting scheduled job: Download Sync Reset', {
        label: 'Jobs',
      });
      downloadTracker.resetDownloadTracker();
    }),
  });

  // Run image cache cleanup every 24 hours
  scheduledJobs.push({
    id: 'image-cache-cleanup',
    name: 'Image Cache Cleanup',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['image-cache-cleanup'].schedule,
    job: schedule.scheduleJob(jobs['image-cache-cleanup'].schedule, () => {
      logger.info('Starting scheduled job: Image Cache Cleanup', {
        label: 'Jobs',
      });
      // Images not seen for a month past their expiry, from every source,
      // then the least recently used, to keep the cache under its limit.
      // Expired images seen since are kept: they are revalidated with the
      // host, not downloaded again, when next asked for.
      (async () => {
        for (const source of ['tmdb', 'tvdb', 'avatar']) {
          await ImageProxy.clearCache(source);
        }
        await ImageProxy.trimToLimit();
      })().catch((e) =>
        logger.error('Image Cache Cleanup failed', {
          label: 'Jobs',
          errorMessage: e.message,
        })
      );
    }),
  });

  scheduledJobs.push({
    id: 'process-blocklisted-tags',
    name: 'Process Blocklisted Tags',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['process-blocklisted-tags'].schedule,
    job: schedule.scheduleJob(jobs['process-blocklisted-tags'].schedule, () => {
      logger.info('Starting scheduled job: Process Blocklisted Tags', {
        label: 'Jobs',
      });
      blocklistedTagsProcessor.run();
    }),
    running: () => blocklistedTagsProcessor.status().running,
    cancelFn: () => blocklistedTagsProcessor.cancel(),
  });

  // Report only: Sonarr series and Radarr movies that disagree with what
  // Seerr says they are, anime or not. Nothing is changed.
  scheduledJobs.push({
    id: 'anime-check',
    name: 'Anime Check',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['anime-check'].schedule,
    job: schedule.scheduleJob(jobs['anime-check'].schedule, () => {
      logger.info('Starting scheduled job: Anime Check', { label: 'Jobs' });
      animeCheck.run();
    }),
    running: () => animeCheck.status().running,
    cancelFn: () => animeCheck.cancel(),
  });

  // Backfill: finds stuck series and searches a few each run. Does nothing
  // until it is turned on and set up in Settings → Backfill.
  scheduledJobs.push({
    id: 'backfill-scan',
    name: 'Backfill Scan',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['backfill-scan'].schedule,
    job: schedule.scheduleJob(jobs['backfill-scan'].schedule, () => {
      logger.info('Starting scheduled job: Backfill Scan', { label: 'Jobs' });
      backfill.scan();
    }),
    running: () => backfill.status().running,
    cancelFn: () => backfill.cancel(),
  });

  // Moves approved backfills along: downloading, importing, cleaning up.
  scheduledJobs.push({
    id: 'backfill-monitor',
    name: 'Backfill Downloads',
    type: 'process',
    interval: 'fixed',
    cronSchedule: jobs['backfill-monitor'].schedule,
    job: schedule.scheduleJob(jobs['backfill-monitor'].schedule, () => {
      backfill.tick();
    }),
    running: () => backfill.monitorStatus().running,
  });

  // Report only: folders Plex matched to a different title than Sonarr or
  // Radarr has in them (Settings → Health). Plex only.
  if (mediaServerType === MediaServerType.PLEX) {
    scheduledJobs.push({
      id: 'plex-match-check',
      name: 'Plex Match Check',
      type: 'process',
      interval: 'days',
      cronSchedule: jobs['plex-match-check'].schedule,
      job: schedule.scheduleJob(jobs['plex-match-check'].schedule, () => {
        logger.info('Starting scheduled job: Plex Match Check', {
          label: 'Jobs',
        });
        plexMatchCheck.run();
      }),
      running: () => plexMatchCheck.status().running,
      cancelFn: () => plexMatchCheck.cancel(),
    });
  }

  // Tells admins when a connected service newly has a problem, the same
  // problems the Health page lists.
  scheduledJobs.push({
    id: 'health-watch',
    name: 'Health Alerts',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['health-watch'].schedule,
    job: schedule.scheduleJob(jobs['health-watch'].schedule, () => {
      healthAlerts.run();
    }),
    running: () => false,
  });

  scheduledJobs.push({
    id: 'database-maintenance',
    name: 'Database Maintenance',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['database-maintenance'].schedule,
    job: schedule.scheduleJob(jobs['database-maintenance'].schedule, () => {
      logger.info('Starting scheduled job: Database Maintenance', {
        label: 'Jobs',
      });
      runDbMaintenance().catch(() => undefined);
    }),
    running: () => maintenanceStatus().running,
  });

  logger.info('Scheduled jobs loaded', { label: 'Jobs' });
};
