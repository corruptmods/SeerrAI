import type { MediaServerKind } from '@server/constants/server';
import {
  MEDIA_SERVER_KINDS,
  MediaServerType,
  typeOfKind,
} from '@server/constants/server';
import blocklistedTagsProcessor from '@server/job/blocklistedTagsProcessor';
import {
  refreshMediaServerJobs,
  refreshMusicJobs,
  runJob,
  scheduledJobs,
  startJobs,
} from '@server/job/schedule';
import animeCheck from '@server/lib/animeCheck';
import availabilitySync from '@server/lib/availabilitySync';
import backfill from '@server/lib/backfill/engine';
import * as dbMaintenance from '@server/lib/dbMaintenance';
import downloadCheck from '@server/lib/downloadCheck';
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
  embyFullScanner,
  embyRecentScanner,
  jellyfinFullScanner,
  jellyfinRecentScanner,
} from '@server/lib/scanners/jellyfin';
import { musicFullScan, musicSync } from '@server/lib/scanners/music';
import { plexFullScanner, plexRecentScanner } from '@server/lib/scanners/plex';
import { radarrScanner } from '@server/lib/scanners/radarr';
import { sonarrScanner } from '@server/lib/scanners/sonarr';
import type { LidarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import watchlistSync from '@server/lib/watchlistsync';
import logger from '@server/logger';
import schedule from 'node-schedule';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * A scheduled job that fails is logged and left to run again next time.
 * Left alone, its rejected promise reached the process unhandled, and
 * Node stops the whole server when that happens.
 */

const fail = async () => {
  throw new Error('service unreachable');
};

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

const settle = () => new Promise((resolve) => setImmediate(resolve));

const stubEveryJob = () => {
  for (const [target, name] of [
    [plexRecentScanner, 'run'],
    [plexFullScanner, 'run'],
    [jellyfinRecentScanner, 'run'],
    [jellyfinFullScanner, 'run'],
    [embyRecentScanner, 'run'],
    [embyFullScanner, 'run'],
    [musicSync, 'run'],
    [musicFullScan, 'run'],
    [refreshToken, 'run'],
    [watchlistSync, 'syncWatchlist'],
    [radarrScanner, 'run'],
    [sonarrScanner, 'run'],
    [availabilitySync, 'run'],
    [downloadTracker, 'updateDownloads'],
    [downloadTracker, 'resetDownloadTracker'],
    [episodeSync, 'run'],
    [plexUserImport, 'run'],
    [futureSeasons, 'run'],
    [notificationReconciler, 'run'],
    [ImageProxy, 'clearCache'],
    [ImageProxy, 'trimToLimit'],
    [blocklistedTagsProcessor, 'run'],
    [animeCheck, 'run'],
    [backfill, 'scan'],
    [backfill, 'tick'],
    [downloadCheck, 'run'],
    [plexMatchCheck, 'run'],
    [healthAlerts, 'run'],
    [dbMaintenance, 'runDbMaintenance'],
  ] as const) {
    mock.method(target as unknown as Record<string, () => unknown>, name, fail);
  }
};

beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});

afterEach(async () => {
  await schedule.gracefulShutdown();
  scheduledJobs.length = 0;
  process.off('unhandledRejection', onUnhandled);
  getSettings().main.mediaServerType = MediaServerType.NOT_CONFIGURED;
  for (const kind of MEDIA_SERVER_KINDS) getSettings()[kind].connected = false;
  mock.restoreAll();
});

/** Connects the servers given, the first as the primary one. */
const connect = (...kinds: MediaServerKind[]) => {
  const settings = getSettings();
  settings.main.mediaServerType = typeOfKind(kinds[0]);
  for (const kind of MEDIA_SERVER_KINDS) {
    settings[kind].connected = kinds.includes(kind);
  }
};

const ids = (): string[] => scheduledJobs.map((job) => job.id);

describe('scheduled jobs', () => {
  for (const serverType of [
    MediaServerType.PLEX,
    MediaServerType.JELLYFIN,
  ] as const) {
    it(`logs a failed job and keeps the server up (${MediaServerType[serverType]})`, async () => {
      getSettings().main.mediaServerType = serverType;
      stubEveryJob();
      const errors = mock.method(logger, 'error');

      startJobs();
      assert.ok(scheduledJobs.length > 10);
      for (const job of scheduledJobs) job.job.invoke();
      await settle();
      await settle();

      assert.deepEqual(unhandled, []);
      // Every job's failure was logged with its name. Database
      // maintenance logs its own.
      for (const job of scheduledJobs) {
        if (job.id === 'database-maintenance') continue;
        assert.ok(
          errors.mock.calls.some((c) =>
            String(c.arguments[0]).includes(job.name)
          ),
          `${job.name} failure was not logged`
        );
      }
    });
  }

  // The interval decides which choices the schedule editor offers. Watchlist
  // Sync runs every few minutes, so offering only seconds left admins no way
  // to keep its schedule, or to set a sensible one.
  it('replaces its jobs when started again, rather than scheduling them twice', () => {
    connect('plex');
    stubEveryJob();
    startJobs();
    const first = [...scheduledJobs];
    // A media server set up after Seerr AI started starts the jobs again.
    startJobs();
    assert.equal(new Set(ids()).size, ids().length, 'each job once');
    assert.equal(scheduledJobs.length, first.length);
    assert.ok(
      first.every((job) => job.job.nextInvocation() === null),
      'the jobs scheduled first no longer run'
    );
  });

  it('edits Watchlist Sync in minutes', () => {
    getSettings().main.mediaServerType = MediaServerType.PLEX;
    stubEveryJob();

    startJobs();
    const job = scheduledJobs.find((j) => j.id === 'plex-watchlist-sync');
    assert.equal(job?.interval, 'minutes');
  });

  it('logs a job that throws before it starts', async () => {
    const logged: [string, Record<string, unknown>][] = [];
    mock.method(logger, 'error', (message: string, meta: object) => {
      logged.push([message, meta as Record<string, unknown>]);
      return logger;
    });
    const run = runJob('Thrower', () => {
      throw new Error('bad settings');
    });

    await run();

    assert.deepEqual(unhandled, []);
    assert.equal(logged.length, 1);
    const [message, meta] = logged[0];
    assert.match(message, /Thrower/);
    assert.equal(meta.errorMessage, 'bad settings');
    // Only the message and stack: an API client's error carries the
    // request, API key and all, which must not reach the log.
    assert.deepEqual(Object.keys(meta).sort(), [
      'errorMessage',
      'label',
      'stack',
    ]);
  });

  it('runs every connected server’s scans, and its jobs only', () => {
    connect('jellyfin', 'plex');
    stubEveryJob();

    startJobs();

    for (const id of [
      'jellyfin-recently-added-scan',
      'jellyfin-full-scan',
      'plex-recently-added-scan',
      'plex-full-scan',
      'plex-refresh-token',
      'plex-user-import',
      'plex-match-check',
    ]) {
      assert.ok(ids().includes(id), `${id} is not scheduled`);
    }
    assert.ok(!ids().some((id) => id.startsWith('emby-')));
    assert.equal(
      scheduledJobs.find((job) => job.id === 'plex-match-check')?.name,
      'Match Check'
    );
  });

  it('runs Match Check on Jellyfin alone too', () => {
    connect('jellyfin');
    stubEveryJob();

    startJobs();

    assert.ok(ids().includes('plex-match-check'));
    assert.ok(
      !ids().some(
        (id) =>
          id.startsWith('plex-') &&
          id !== 'plex-match-check' &&
          id !== 'plex-watchlist-sync'
      )
    );
  });

  it('adds and drops a server’s jobs as it is connected and removed', () => {
    connect('plex');
    stubEveryJob();
    startJobs();
    const others = scheduledJobs.length - 4;
    const plexScan = scheduledJobs.find(
      (job) => job.id === 'plex-recently-added-scan'
    );
    const scanCancelled = mock.method(plexRecentScanner, 'cancel', () => {});

    connect('plex', 'emby');
    refreshMediaServerJobs();
    assert.ok(ids().includes('emby-recently-added-scan'));
    assert.ok(ids().includes('emby-full-scan'));
    assert.ok(ids().includes('plex-recently-added-scan'));
    assert.equal(scanCancelled.mock.callCount(), 0);

    connect('emby');
    refreshMediaServerJobs();
    assert.ok(
      !ids().some(
        (id) =>
          id.startsWith('plex-') &&
          id !== 'plex-match-check' &&
          id !== 'plex-watchlist-sync'
      )
    );
    assert.ok(ids().includes('emby-recently-added-scan'));
    // The old schedule is gone, and a scan under way stops.
    assert.equal(plexScan?.job.nextInvocation(), null);
    assert.equal(scanCancelled.mock.callCount(), 1);
    // Everything else is there once, as it was.
    assert.equal(scheduledJobs.length - 2, others);
    assert.equal(new Set(ids()).size, scheduledJobs.length);
  });

  it('keeps an edited schedule when a server’s jobs are registered again', (t) => {
    connect('plex');
    stubEveryJob();
    startJobs();
    const jobs = getSettings().jobs;
    const saved = jobs['plex-full-scan'].schedule;
    t.after(() => {
      jobs['plex-full-scan'].schedule = saved;
    });
    jobs['plex-full-scan'].schedule = '0 0 4 * * *';

    refreshMediaServerJobs();

    assert.equal(
      scheduledJobs.find((job) => job.id === 'plex-full-scan')?.cronSchedule,
      '0 0 4 * * *'
    );
  });

  it('scans every connected server once downloads are imported', async () => {
    connect('plex', 'jellyfin', 'emby');
    stubEveryJob();
    let onImport: () => unknown = () => undefined;
    mock.method(downloadTracker, 'whenImported', (run: () => unknown) => {
      onImport = run;
    });
    const ran: string[] = [];
    for (const [name, scanner] of [
      ['plex', plexRecentScanner],
      ['jellyfin', jellyfinRecentScanner],
      ['emby', embyRecentScanner],
    ] as const) {
      mock.method(scanner, 'run', async () => {
        ran.push(name);
        if (name === 'plex') throw new Error('Plex is down');
      });
      mock.method(scanner, 'status', () => ({ running: name === 'jellyfin' }));
    }

    startJobs();
    await onImport();

    // Jellyfin's was already running; Plex failing does not stop Emby's.
    assert.deepEqual(ran.sort(), ['emby', 'plex']);
  });

  describe('music', () => {
    const setUpMusic = (t: { after: (fn: () => void) => void }) => {
      const settings = getSettings();
      settings.lidarr = [{ id: 0, isDefault: true } as LidarrSettings];
      t.after(() => {
        settings.lidarr = [];
        settings.main.disabledFeatures = [];
      });
    };

    it('registers the music jobs only once music is set up', (t) => {
      connect('plex');
      stubEveryJob();
      startJobs();
      assert.ok(!ids().some((id) => id.startsWith('music-')));

      setUpMusic(t);
      refreshMusicJobs();
      assert.equal(
        scheduledJobs.find((job) => job.id === 'music-sync')?.name,
        'Music Sync'
      );
      assert.equal(
        scheduledJobs.find((job) => job.id === 'music-full-scan')?.cronSchedule,
        getSettings().jobs['music-full-scan'].schedule
      );
      assert.equal(new Set(ids()).size, scheduledJobs.length);

      // Registered again (a Lidarr edited), still once each.
      refreshMusicJobs();
      assert.equal(ids().filter((id) => id === 'music-sync').length, 1);
      // A server connected or removed leaves them be.
      connect('plex', 'jellyfin');
      refreshMediaServerJobs();
      assert.ok(ids().includes('music-full-scan'));
    });

    it('drops the music jobs, and stops a scan, when music is turned off', (t) => {
      connect('plex');
      stubEveryJob();
      setUpMusic(t);
      startJobs();
      const job = scheduledJobs.find((j) => j.id === 'music-sync');
      assert.ok(job);
      const cancelled = mock.method(musicSync, 'cancel', () => {});

      getSettings().main.disabledFeatures = ['music'];
      refreshMusicJobs();

      assert.ok(!ids().some((id) => id.startsWith('music-')));
      assert.equal(job.job.nextInvocation(), null);
      assert.equal(cancelled.mock.callCount(), 1);
    });

    it('logs a failed music job and keeps the server up', async (t) => {
      connect('plex');
      stubEveryJob();
      setUpMusic(t);
      const errors = mock.method(logger, 'error');
      startJobs();

      for (const job of scheduledJobs.filter((j) => j.music)) {
        job.job.invoke();
      }
      await settle();
      await settle();

      assert.deepEqual(unhandled, []);
      for (const name of ['Music Sync', 'Music Full Scan']) {
        assert.ok(
          errors.mock.calls.some((c) => String(c.arguments[0]).includes(name))
        );
      }
    });

    it('runs Music Sync with the scans once downloads are imported', async (t) => {
      connect('plex');
      stubEveryJob();
      setUpMusic(t);
      let onImport: () => unknown = () => undefined;
      mock.method(downloadTracker, 'whenImported', (run: () => unknown) => {
        onImport = run;
      });
      const ran: string[] = [];
      mock.method(plexRecentScanner, 'run', async () => {
        ran.push('plex');
      });
      mock.method(musicSync, 'run', async () => {
        ran.push('music');
      });

      startJobs();
      await onImport();
      assert.deepEqual(ran.sort(), ['music', 'plex']);

      // Not while music is off.
      ran.length = 0;
      getSettings().main.disabledFeatures = ['music'];
      await onImport();
      assert.deepEqual(ran, ['plex']);
    });
  });
});
