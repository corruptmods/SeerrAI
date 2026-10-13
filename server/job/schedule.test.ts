import { MediaServerType } from '@server/constants/server';
import blocklistedTagsProcessor from '@server/job/blocklistedTagsProcessor';
import { runJob, scheduledJobs, startJobs } from '@server/job/schedule';
import animeCheck from '@server/lib/animeCheck';
import availabilitySync from '@server/lib/availabilitySync';
import backfill from '@server/lib/backfill/engine';
import * as dbMaintenance from '@server/lib/dbMaintenance';
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
  mock.restoreAll();
});

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
});
