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
import songFetcher from '@server/lib/music/songFetch';
import notificationReconciler from '@server/lib/notificationReconciler';
import plexMatchCheck from '@server/lib/plexMatchCheck';
import plexUserImport from '@server/lib/plexUserImport';
import refreshToken from '@server/lib/refreshToken';
import { jellyfinScanners } from '@server/lib/scanners/jellyfin';
import { musicFullScan, musicSync } from '@server/lib/scanners/music';
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
  /**
   * The media server the job works with: it is registered while that server
   * is connected (refreshMediaServerJobs).
   */
  server?: MediaServerKind;
  /** A music job: registered while music is set up and on. */
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
 * The work of one scheduled job, waited for, with anything it throws logged
 * and dropped. A job's failure (a service down, a bad answer) must not leave
 * a rejected promise nobody waits for: Node stops the whole server on one.
 * Only the message and stack are logged, since an API client's error carries
 * the request it made, API key included.
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

/** A server's recently added scan. */
const recentScanner = (kind: MediaServerKind) =>
  kind === 'plex' ? plexRecentScanner : jellyfinScanners(kind).recent;

/** The jobs that work with one media server, for while it is connected. */
const mediaServerJobs = (kind: MediaServerKind): ScheduledJob[] => {
  const jobs = getSettings().jobs;

  if (kind === 'plex') {
    return [
      // Run recently added plex scan every 5 minutes
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
      // Run full plex scan every 24 hours
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
      // Give new Plex friends an account, when Auto-Import Plex Users is on
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
    // Run the recently added scan every 5 minutes
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
    // Run the full scan every 24 hours
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
 * The music jobs, for while music is set up and on. Each run reads every
 * connected server's music libraries, and Lidarr.
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
          return musicSync.run();
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
  ];
};

/**
 * Registers the jobs of every connected media server, and only theirs: run
 * when a server is connected or removed, so its scans start or stop without
 * a restart. Jobs already registered are scheduled afresh from their saved
 * schedules; a scan under way on a server still connected carries on, and
 * one on a server no longer connected is stopped.
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

/** The jobs have been started (startJobs); until then none are registered. */
let started = false;

/**
 * Registers the music jobs while music is set up and on, and only then: run
 * when a Lidarr is added, changed or removed, or music is switched on or
 * off for everyone. A music scan under way stops when music does.
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
  // Started again (a media server set up after Seerr AI started): the jobs
  // already scheduled are replaced, not scheduled a second time. A job
  // under way finishes; only its next runs are cancelled.
  if (started) {
    scheduledJobs.forEach((scheduledJob) => scheduledJob.job.cancel());
    scheduledJobs.length = 0;
  }
  started = true;

  // Each connected media server's scans, the primary one's first.
  refreshMediaServerJobs();

  // Music's scans, once music is set up.
  refreshMusicJobs();

  // Watchlist sync: Plex watchlists, and public Trakt watchlists on any
  // media server. The id stays as it was, so saved schedules carry over.
  // It runs every few minutes, so its schedule is edited in minutes.
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
        return watchlistSync.syncWatchlist();
      })
    ),
    running: () => watchlistSync.running,
  });

  // Run full radarr scan every 24 hours
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

  // Run full sonarr scan every 24 hours
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

  // Checks if media is still available in plex/sonarr/radarr libs
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

  // Run download sync every minute. Requested titles just imported are
  // looked for on each media server alongside it, in case one matched them
  // to another title (lib/matchWatch).
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
          // It reads the media servers, not the queues: it goes on when
          // a queue cannot be read.
          await matchWatch.run();
        }
      })
    ),
  });
  downloadTracker.onEachImport((imported) => matchWatch.noteImports(imported));

  // A minute after Radarr or Sonarr imports something, every connected
  // media server's recently added scan runs (and again each minute, a few
  // times, until the media server lists it), so the title shows as
  // available then rather than at the next scheduled scan. Music Sync runs
  // with them. One server's scan failing does not hold up the others'.
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

  // Track per-episode availability from Sonarr
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

  // Request each followed series' new seasons as they premiere
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

  // Catch any availability or failure notification the subscribers missed
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

  // Reset download sync everyday at 01:00 am
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

  // Run image cache cleanup every 24 hours
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
        // Images not seen for a month past their expiry, from every source,
        // then the least recently used, to keep the cache under its limit.
        // Expired images seen since are kept: they are revalidated with the
        // host, not downloaded again, when next asked for.
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

  // Report only: Sonarr series and Radarr movies that disagree with what
  // Seerr says they are, anime or not. Nothing is changed.
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

  // Backfill: finds stuck series and searches a few each run. Does nothing
  // until it is turned on and set up in Settings → Backfill.
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

  // Moves approved backfills along: downloading, importing, cleaning up.
  scheduledJobs.push({
    id: 'backfill-monitor',
    name: 'Backfill Downloads',
    type: 'process',
    interval: 'fixed',
    cronSchedule: jobs['backfill-monitor'].schedule,
    job: schedule.scheduleJob(
      jobs['backfill-monitor'].schedule,
      runJob('Backfill Downloads', async () => {
        // And songs taken from albums, through Backfill's indexers and
        // client; neither waits on the other's trouble.
        const [series, songs] = await Promise.allSettled([
          backfill.tick(),
          songFetcher.tick(),
        ]);
        // Both told, should both fail.
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

  // Looks at what Radarr and Sonarr grab, and at imports that get stuck
  // (lib/downloadCheck). Does nothing until it's turned on in Settings →
  // Backfill, and needs nothing else of Backfill's.
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

  // Report only: folders a media server matched to a different title than
  // Sonarr or Radarr has in them (Settings → Health), on every connected
  // server. The id stays as it was, so saved schedules carry over.
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

  // Tells admins when a connected service newly has a problem, the same
  // problems the Health page lists.
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
