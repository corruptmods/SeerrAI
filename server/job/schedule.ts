import blocklistedTagsProcessor from '@server/job/blocklistedTagsProcessor';
import animeCheck from '@server/lib/animeCheck';
import availabilitySync from '@server/lib/availabilitySync';
import backfill from '@server/lib/backfill/engine';
import { maintenanceStatus, runDbMaintenance } from '@server/lib/dbMaintenance';
import downloadCheck from '@server/lib/downloadCheck';
import downloadTracker from '@server/lib/downloadtracker';
import episodeSync from '@server/lib/episodeSync';
import futureSeasons from '@server/lib/futureSeasons';
import healthAlerts from '@server/lib/healthAlerts';
import ImageProxy, { IMAGE_CACHES } from '@server/lib/imageproxy';
import matchWatch from '@server/lib/matchWatch';
import type { MediaServerKind } from '@server/lib/mediaServers';
import { connectedServers, serverName } from '@server/lib/mediaServers';
import { musicReady } from '@server/lib/music/access';
import blockedImports from '@server/lib/music/blockedImports';
import songFetcher from '@server/lib/music/songFetch';
import notificationReconciler from '@server/lib/notificationReconciler';
import playlists from '@server/lib/playlists';
import { plexListSync } from '@server/lib/plexLists';
import plexMatchCheck from '@server/lib/plexMatchCheck';
import plexUserImport from '@server/lib/plexUserImport';
import {
  qualityCheckRunning,
  runQualityCheck,
} from '@server/lib/quality/check';
import refreshToken from '@server/lib/refreshToken';
import { jellyfinScanners } from '@server/lib/scanners/jellyfin';
import { musicFullScan, musicSync } from '@server/lib/scanners/music';
import { plexFullScanner, plexRecentScanner } from '@server/lib/scanners/plex';
import { radarrScanner } from '@server/lib/scanners/radarr';
import { sonarrScanner } from '@server/lib/scanners/sonarr';
import type { JobId } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import userAccessCheck from '@server/lib/userAccessCheck';
import watchlistSync from '@server/lib/watchlistsync';
import logger from '@server/logger';
import schedule from 'node-schedule';

interface ScheduledJob {
  id: JobId;
  /**
   * The media server this job uses; registered only while it's connected
   * (refreshMediaServerJobs).
   */
  server?: MediaServerKind;
  /** A music job, registered only while music is set up and enabled. */
  music?: boolean;
  job: schedule.Job;
  name: string;
  type: 'process' | 'command';
  interval: 'seconds' | 'minutes' | 'hours' | 'days' | 'fixed';
  cronSchedule: string;
  running?: () => boolean;
  cancelFn?: () => void;
}

export const scheduledJobs: ScheduledJob[] = [];

/**
 * Wraps a job's work so anything it throws is logged and dropped: an unhandled
 * rejection stops the server. Logs only message and stack, since API client
 * errors carry the request, API key included.
 */
export const runJob =
  (name: string, work: () => unknown) => async (): Promise<void> => {
    try {
      await work();
    } catch (e) {
      logger.error(`Scheduled job failed: ${name}`, {
        label: 'Jobs',
        errorMessage: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
    }
  };

const recentScanner = (kind: MediaServerKind) =>
  kind === 'plex' ? plexRecentScanner : jellyfinScanners(kind).recent;

/** Jobs for one media server, registered while it's connected. */
const mediaServerJobs = (kind: MediaServerKind): ScheduledJob[] => {
  const jobs = getSettings().jobs;

  if (kind === 'plex') {
    return [
      {
        id: 'plex-recently-added-scan',
        server: 'plex',
        name: 'Plex Recently Added Scan',
        type: 'process',
        interval: 'minutes',
        cronSchedule: jobs['plex-recently-added-scan'].schedule,
        job: schedule.scheduleJob(
          jobs['plex-recently-added-scan'].schedule,
          runJob('Plex Recently Added Scan', () => {
            logger.info('Starting scheduled job: Plex Recently Added Scan', {
              label: 'Jobs',
            });
            return plexRecentScanner.run();
          })
        ),
        running: () => plexRecentScanner.status().running,
        cancelFn: () => plexRecentScanner.cancel(),
      },
      {
        id: 'plex-full-scan',
        server: 'plex',
        name: 'Plex Full Library Scan',
        type: 'process',
        interval: 'hours',
        cronSchedule: jobs['plex-full-scan'].schedule,
        job: schedule.scheduleJob(
          jobs['plex-full-scan'].schedule,
          runJob('Plex Full Library Scan', () => {
            logger.info('Starting scheduled job: Plex Full Library Scan', {
              label: 'Jobs',
            });
            return plexFullScanner.run();
          })
        ),
        running: () => plexFullScanner.status().running,
        cancelFn: () => plexFullScanner.cancel(),
      },
      {
        id: 'plex-refresh-token',
        server: 'plex',
        name: 'Plex Refresh Token',
        type: 'process',
        interval: 'fixed',
        cronSchedule: jobs['plex-refresh-token'].schedule,
        job: schedule.scheduleJob(
          jobs['plex-refresh-token'].schedule,
          runJob('Plex Refresh Token', () => {
            logger.info('Starting scheduled job: Plex Refresh Token', {
              label: 'Jobs',
            });
            return refreshToken.run();
          })
        ),
      },
      // Creates accounts for new Plex friends when Auto-Import Plex Users is
      // on.
      {
        id: 'plex-user-import',
        server: 'plex',
        name: 'Plex User Import',
        type: 'process',
        interval: 'hours',
        cronSchedule: jobs['plex-user-import'].schedule,
        job: schedule.scheduleJob(
          jobs['plex-user-import'].schedule,
          runJob('Plex User Import', () => {
            logger.debug('Starting scheduled job: Plex User Import', {
              label: 'Jobs',
            });
            return plexUserImport.run();
          })
        ),
      },
    ];
  }

  const name = serverName(kind);
  const scanners = jellyfinScanners(kind);
  const recentId = `${kind}-recently-added-scan` as const;
  const fullId = `${kind}-full-scan` as const;

  return [
    {
      id: recentId,
      server: kind,
      name: `${name} Recently Added Scan`,
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs[recentId].schedule,
      job: schedule.scheduleJob(
        jobs[recentId].schedule,
        runJob(`${name} Recently Added Scan`, () => {
          logger.info(`Starting scheduled job: ${name} Recently Added Scan`, {
            label: 'Jobs',
          });
          return scanners.recent.run();
        })
      ),
      running: () => scanners.recent.status().running,
      cancelFn: () => scanners.recent.cancel(),
    },
    {
      id: fullId,
      server: kind,
      name: `${name} Full Library Scan`,
      type: 'process',
      interval: 'hours',
      cronSchedule: jobs[fullId].schedule,
      job: schedule.scheduleJob(
        jobs[fullId].schedule,
        runJob(`${name} Full Library Scan`, () => {
          logger.info(`Starting scheduled job: ${name} Full Scan`, {
            label: 'Jobs',
          });
          return scanners.full.run();
        })
      ),
      running: () => scanners.full.status().running,
      cancelFn: () => scanners.full.cancel(),
    },
  ];
};

/**
 * Music jobs, registered while music is set up and enabled. Each run reads
 * every connected server's music libraries and Lidarr.
 */
const musicJobs = (): ScheduledJob[] => {
  if (!musicReady()) {
    return [];
  }
  const jobs = getSettings().jobs;
  return [
    {
      id: 'music-sync',
      music: true,
      name: 'Music Sync',
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs['music-sync'].schedule,
      job: schedule.scheduleJob(
        jobs['music-sync'].schedule,
        runJob('Music Sync', () => {
          logger.debug('Starting scheduled job: Music Sync', {
            label: 'Jobs',
          });
          // Then Lidarr downloads stuck before import, for requested songs
          // (lib/music/blockedImports).
          return musicSync.run().finally(() => blockedImports.run());
        })
      ),
      running: () => musicSync.status().running,
      cancelFn: () => musicSync.cancel(),
    },
    {
      id: 'music-full-scan',
      music: true,
      name: 'Music Full Scan',
      type: 'process',
      interval: 'hours',
      cronSchedule: jobs['music-full-scan'].schedule,
      job: schedule.scheduleJob(
        jobs['music-full-scan'].schedule,
        runJob('Music Full Scan', () => {
          logger.info('Starting scheduled job: Music Full Scan', {
            label: 'Jobs',
          });
          return musicFullScan.run();
        })
      ),
      running: () => musicFullScan.status().running,
      cancelFn: () => musicFullScan.cancel(),
    },
    {
      id: 'playlist-sync',
      music: true,
      name: 'Playlist Sync',
      type: 'process',
      interval: 'hours',
      cronSchedule: jobs['playlist-sync'].schedule,
      job: schedule.scheduleJob(
        jobs['playlist-sync'].schedule,
        runJob('Playlist Sync', () => {
          logger.debug('Starting scheduled job: Playlist Sync', {
            label: 'Jobs',
          });
          return playlists.sync();
        })
      ),
      running: () => playlists.isRunning(),
    },
  ];
};

/**
 * Registers jobs for exactly the connected media servers, so scans start or
 * stop without a restart when a server is added or removed. Existing jobs are
 * rescheduled from their saved schedules; a running scan on a still-connected
 * server continues, one on a removed server is stopped.
 */
export const refreshMediaServerJobs = (): void => {
  const servers = connectedServers();

  for (let i = scheduledJobs.length - 1; i >= 0; i--) {
    const job = scheduledJobs[i];
    if (!job.server) continue;
    job.job.cancel();
    if (!servers.includes(job.server)) {
      job.cancelFn?.();
    }
    scheduledJobs.splice(i, 1);
  }

  scheduledJobs.unshift(...servers.flatMap(mediaServerJobs));
};

/** Set by startJobs; no jobs are registered before then. */
let started = false;

/**
 * Registers music jobs only while music is set up and enabled. Called when a
 * Lidarr is added, changed or removed, or music is toggled globally. A running
 * music scan stops when music is disabled.
 */
export const refreshMusicJobs = (): void => {
  if (!started) {
    return;
  }
  const music = musicReady();
  for (let i = scheduledJobs.length - 1; i >= 0; i--) {
    const job = scheduledJobs[i];
    if (!job.music) continue;
    job.job.cancel();
    if (!music) {
      job.cancelFn?.();
    }
    scheduledJobs.splice(i, 1);
  }
  scheduledJobs.push(...musicJobs());
};

export const startJobs = (): void => {
  const jobs = getSettings().jobs;
  // On restart (e.g. a media server set up later), replace scheduled jobs
  // rather than duplicating them. Running jobs finish; only future runs are
  // cancelled.
  if (started) {
    scheduledJobs.forEach((scheduledJob) => scheduledJob.job.cancel());
    scheduledJobs.length = 0;
  }
  started = true;

  // Each connected media server's scans, primary first.
  refreshMediaServerJobs();

  refreshMusicJobs();

  // Watchlist sync: Plex watchlists, and public Trakt watchlists on any media
  // server, then Plex lists with auto-request on. The id is kept so saved schedules carry over. Edited in minutes
  // since it runs every few.
  scheduledJobs.push({
    id: 'plex-watchlist-sync',
    name: 'Watchlist Sync',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['plex-watchlist-sync'].schedule,
    job: schedule.scheduleJob(
      jobs['plex-watchlist-sync'].schedule,
      runJob('Watchlist Sync', () => {
        logger.info('Starting scheduled job: Watchlist Sync', {
          label: 'Jobs',
        });
        // Plex lists with auto-request on, after the watchlists.
        return watchlistSync.syncWatchlist().then(() => plexListSync.run());
      })
    ),
    running: () => watchlistSync.running || plexListSync.running,
  });

  scheduledJobs.push({
    id: 'radarr-scan',
    name: 'Radarr Scan',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['radarr-scan'].schedule,
    job: schedule.scheduleJob(
      jobs['radarr-scan'].schedule,
      runJob('Radarr Scan', () => {
        logger.info('Starting scheduled job: Radarr Scan', { label: 'Jobs' });
        return radarrScanner.run();
      })
    ),
    running: () => radarrScanner.status().running,
    cancelFn: () => radarrScanner.cancel(),
  });

  scheduledJobs.push({
    id: 'sonarr-scan',
    name: 'Sonarr Scan',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['sonarr-scan'].schedule,
    job: schedule.scheduleJob(
      jobs['sonarr-scan'].schedule,
      runJob('Sonarr Scan', () => {
        logger.info('Starting scheduled job: Sonarr Scan', { label: 'Jobs' });
        return sonarrScanner.run();
      })
    ),
    running: () => sonarrScanner.status().running,
    cancelFn: () => sonarrScanner.cancel(),
  });

  // Checks media is still in the media server, Sonarr and Radarr libraries.
  scheduledJobs.push({
    id: 'availability-sync',
    name: 'Media Availability Sync',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['availability-sync'].schedule,
    job: schedule.scheduleJob(
      jobs['availability-sync'].schedule,
      runJob('Media Availability Sync', () => {
        logger.info('Starting scheduled job: Media Availability Sync', {
          label: 'Jobs',
        });
        return availabilitySync.run();
      })
    ),
    running: () => availabilitySync.running,
    cancelFn: () => availabilitySync.cancel(),
  });

  // Also checks just-imported requested titles on each media server, in case
  // one was matched to another title (lib/matchWatch).
  scheduledJobs.push({
    id: 'download-sync',
    name: 'Download Sync',
    type: 'command',
    interval: 'seconds',
    cronSchedule: jobs['download-sync'].schedule,
    job: schedule.scheduleJob(
      jobs['download-sync'].schedule,
      runJob('Download Sync', async () => {
        logger.debug('Starting scheduled job: Download Sync', {
          label: 'Jobs',
        });
        try {
          await downloadTracker.updateDownloads();
        } finally {
          // Reads the media servers, not the queues, so it runs even if a queue
          // can't be read.
          await matchWatch.run();
        }
      })
    ),
  });
  downloadTracker.onEachImport((imported) => matchWatch.noteImports(imported));

  // A minute after a Radarr or Sonarr import, run every connected server's
  // recently added scan (retrying each minute a few times until it lists the
  // title), so it shows available before the next scheduled scan. Music Sync
  // runs with them. One failing scan doesn't hold up the others.
  downloadTracker.whenImported(async () => {
    const scanners: { run: () => Promise<void> }[] = connectedServers()
      .map(recentScanner)
      .filter((scanner) => !scanner.status().running);
    // Music Sync reads every server's newly added music, and Lidarr's.
    if (musicReady() && !musicSync.status().running) {
      scanners.push(musicSync);
    }
    if (!scanners.length) return;
    logger.info('Downloads were imported; running the recently added scan', {
      label: 'Jobs',
    });
    await Promise.allSettled(scanners.map((scanner) => scanner.run()));
  });

  // Per-episode availability from Sonarr.
  scheduledJobs.push({
    id: 'episode-sync',
    name: 'Episode Sync',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['episode-sync'].schedule,
    job: schedule.scheduleJob(
      jobs['episode-sync'].schedule,
      runJob('Episode Sync', () => {
        logger.debug('Starting scheduled job: Episode Sync', { label: 'Jobs' });
        return episodeSync.run();
      })
    ),
  });

  // Requests followed series' new seasons as they premiere.
  scheduledJobs.push({
    id: 'future-seasons',
    name: 'Future Season Requests',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['future-seasons'].schedule,
    job: schedule.scheduleJob(
      jobs['future-seasons'].schedule,
      runJob('Future Season Requests', () => {
        logger.debug('Starting scheduled job: Future Season Requests', {
          label: 'Jobs',
        });
        return futureSeasons.run();
      })
    ),
  });

  // Catches availability and failure notifications the subscribers missed.
  scheduledJobs.push({
    id: 'notification-reconcile',
    name: 'Notification Reconcile',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['notification-reconcile'].schedule,
    job: schedule.scheduleJob(
      jobs['notification-reconcile'].schedule,
      runJob('Notification Reconcile', () => {
        logger.debug('Starting scheduled job: Notification Reconcile', {
          label: 'Jobs',
        });
        return notificationReconciler.run();
      })
    ),
  });

  scheduledJobs.push({
    id: 'download-sync-reset',
    name: 'Download Sync Reset',
    type: 'command',
    interval: 'hours',
    cronSchedule: jobs['download-sync-reset'].schedule,
    job: schedule.scheduleJob(
      jobs['download-sync-reset'].schedule,
      runJob('Download Sync Reset', () => {
        logger.info('Starting scheduled job: Download Sync Reset', {
          label: 'Jobs',
        });
        return downloadTracker.resetDownloadTracker();
      })
    ),
  });

  scheduledJobs.push({
    id: 'image-cache-cleanup',
    name: 'Image Cache Cleanup',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['image-cache-cleanup'].schedule,
    job: schedule.scheduleJob(
      jobs['image-cache-cleanup'].schedule,
      runJob('Image Cache Cleanup', () => {
        logger.info('Starting scheduled job: Image Cache Cleanup', {
          label: 'Jobs',
        });
        // Evict images unseen for a month past expiry, from every source, then
        // least recently used ones to stay under the limit. Expired images seen
        // since are kept and revalidated on next request.
        return (async () => {
          for (const source of IMAGE_CACHES) {
            await ImageProxy.clearCache(source);
          }
          await ImageProxy.trimToLimit();
        })();
      })
    ),
  });

  scheduledJobs.push({
    id: 'process-blocklisted-tags',
    name: 'Process Blocklisted Tags',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['process-blocklisted-tags'].schedule,
    job: schedule.scheduleJob(
      jobs['process-blocklisted-tags'].schedule,
      runJob('Process Blocklisted Tags', () => {
        logger.info('Starting scheduled job: Process Blocklisted Tags', {
          label: 'Jobs',
        });
        return blocklistedTagsProcessor.run();
      })
    ),
    running: () => blocklistedTagsProcessor.status().running,
    cancelFn: () => blocklistedTagsProcessor.cancel(),
  });

  // Report only: Sonarr series and Radarr movies whose anime status disagrees
  // with Seerr's. Changes nothing.
  scheduledJobs.push({
    id: 'anime-check',
    name: 'Anime Check',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['anime-check'].schedule,
    job: schedule.scheduleJob(
      jobs['anime-check'].schedule,
      runJob('Anime Check', () => {
        logger.info('Starting scheduled job: Anime Check', { label: 'Jobs' });
        return animeCheck.run();
      })
    ),
    running: () => animeCheck.status().running,
    cancelFn: () => animeCheck.cancel(),
  });

  // Finds stuck series and searches a few each run. No-op until enabled and set
  // up in Settings → Backfill.
  scheduledJobs.push({
    id: 'backfill-scan',
    name: 'Backfill Scan',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['backfill-scan'].schedule,
    job: schedule.scheduleJob(
      jobs['backfill-scan'].schedule,
      runJob('Backfill Scan', () => {
        logger.info('Starting scheduled job: Backfill Scan', { label: 'Jobs' });
        return backfill.scan();
      })
    ),
    running: () => backfill.status().running,
    cancelFn: () => backfill.cancel(),
  });

  // Advances approved backfills: downloading, importing, cleaning up.
  scheduledJobs.push({
    id: 'backfill-monitor',
    name: 'Backfill Downloads',
    type: 'process',
    interval: 'fixed',
    cronSchedule: jobs['backfill-monitor'].schedule,
    job: schedule.scheduleJob(
      jobs['backfill-monitor'].schedule,
      runJob('Backfill Downloads', async () => {
        // Also songs taken from albums, via Backfill's indexers and client;
        // each runs regardless of the other failing.
        const [series, songs] = await Promise.allSettled([
          backfill.tick(),
          songFetcher.tick(),
        ]);
        // Throw only when both fail.
        if (series.status === 'rejected' && songs.status === 'rejected') {
          logger.error('Songs taken from albums could not move along', {
            label: 'Jobs',
            errorMessage:
              songs.reason instanceof Error
                ? songs.reason.message
                : String(songs.reason),
          });
        }
        for (const result of [series, songs]) {
          if (result.status === 'rejected') throw result.reason;
        }
      })
    ),
    running: () => backfill.monitorStatus().running || songFetcher.isRunning(),
  });

  // Checks Radarr and Sonarr grabs and stuck imports (lib/downloadCheck). No-op
  // until enabled in Settings → Backfill; needs nothing else from Backfill.
  scheduledJobs.push({
    id: 'download-check',
    name: 'Download Check',
    type: 'process',
    interval: 'seconds',
    cronSchedule: jobs['download-check'].schedule,
    job: schedule.scheduleJob(
      jobs['download-check'].schedule,
      runJob('Download Check', () => downloadCheck.run())
    ),
    running: () => downloadCheck.status().running,
  });

  // Quality profiles (Settings → Quality). No-op until an admin manages a
  // server there or enables Backfill's step-down.
  scheduledJobs.push({
    id: 'quality-check',
    name: 'Quality Profiles Check',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['quality-check'].schedule,
    job: schedule.scheduleJob(
      jobs['quality-check'].schedule,
      runJob('Quality Profiles Check', runQualityCheck)
    ),
    running: qualityCheckRunning,
  });

  // Report only: folders a media server matched to a different title than
  // Sonarr or Radarr has (Settings → Health), on every connected server. The id
  // is kept so saved schedules carry over.
  if (connectedServers().length) {
    scheduledJobs.push({
      id: 'plex-match-check',
      name: 'Match Check',
      type: 'process',
      interval: 'days',
      cronSchedule: jobs['plex-match-check'].schedule,
      job: schedule.scheduleJob(
        jobs['plex-match-check'].schedule,
        runJob('Match Check', () => {
          logger.info('Starting scheduled job: Match Check', {
            label: 'Jobs',
          });
          return plexMatchCheck.run();
        })
      ),
      running: () => plexMatchCheck.status().running,
      cancelFn: () => plexMatchCheck.cancel(),
    });
  }

  // Alerts admins when a connected service newly has a problem listed on the
  // Removes people the media server no longer has, when that's on.
  scheduledJobs.push({
    id: 'user-access-check',
    name: 'User Access Check',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['user-access-check'].schedule,
    job: schedule.scheduleJob(
      jobs['user-access-check'].schedule,
      runJob('User Access Check', () => userAccessCheck.run())
    ),
    running: () => userAccessCheck.running,
  });

  // Health page.
  scheduledJobs.push({
    id: 'health-watch',
    name: 'Health Alerts',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['health-watch'].schedule,
    job: schedule.scheduleJob(
      jobs['health-watch'].schedule,
      runJob('Health Alerts', () => {
        return healthAlerts.run();
      })
    ),
    running: () => false,
  });

  scheduledJobs.push({
    id: 'database-maintenance',
    name: 'Database Maintenance',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['database-maintenance'].schedule,
    job: schedule.scheduleJob(
      jobs['database-maintenance'].schedule,
      runJob('Database Maintenance', () => {
        logger.info('Starting scheduled job: Database Maintenance', {
          label: 'Jobs',
        });
        // Maintenance logs its own failure.
        return runDbMaintenance().catch(() => undefined);
      })
    ),
    running: () => maintenanceStatus().running,
  });

  logger.info('Scheduled jobs loaded', { label: 'Jobs' });
};
