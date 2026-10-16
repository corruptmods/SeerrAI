import downloadTracker from '@server/lib/downloadtracker';
import type {
  LidarrSettings,
  RadarrSettings,
  SonarrSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import axios from 'axios';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * A Radarr, Sonarr or Lidarr that stops answering is asked for its queue
 * every few seconds all the same. Saying so as an error on every pass
 * filled the logs all day: it is said once, as a warning with the reason,
 * quietly while it stays down, and once more when it answers again.
 */

const server = (name: string, port: number) => ({
  id: 0,
  name,
  hostname: name.toLowerCase(),
  port,
  apiKey: 'x',
  useSsl: false,
  baseUrl: '',
  is4k: false,
  isDefault: true,
  syncEnabled: true,
  activeProfileId: 1,
  activeDirectory: '/data',
  activeMetadataProfileId: 1,
  tags: [],
});

/** Which servers are down, by host name. */
let down = new Set<string>();

type Logged = { level: string; message: string; meta: Record<string, unknown> };
let logged: Logged[] = [];

beforeEach(async () => {
  await downloadTracker.resetDownloadTracker();
  down = new Set();
  logged = [];
  const settings = getSettings();
  settings.downloadClients = [];
  settings.radarr = [server('Radarr', 7878) as unknown as RadarrSettings];
  settings.sonarr = [server('Sonarr', 8989) as unknown as SonarrSettings];
  settings.lidarr = [server('Lidarr', 8686) as unknown as LidarrSettings];
  settings.main.disabledFeatures = [];

  mock.method(axios, 'create', (config: { baseURL?: string }) => {
    const host = new URL(config.baseURL ?? 'http://none').hostname;
    const answer = async () => {
      if (down.has(host)) {
        throw new Error(`connect ECONNREFUSED ${host}`);
      }
      return { data: { records: [], totalRecords: 0 } };
    };
    return {
      interceptors: { request: { use: () => 0 } },
      get: answer,
      post: answer,
    };
  });
  for (const level of ['error', 'warn', 'info', 'debug'] as const) {
    mock.method(logger, level, (message: string, meta: object) => {
      if ((meta as { label?: string })?.label === 'Download Tracker') {
        logged.push({
          level,
          message,
          meta: meta as Record<string, unknown>,
        });
      }
      return logger;
    });
  }
  // Each test starts with every server answering, whatever the last left.
  await downloadTracker.updateDownloads();
  logged = [];
});

afterEach(() => {
  mock.restoreAll();
  const settings = getSettings();
  settings.radarr = [];
  settings.sonarr = [];
  settings.lidarr = [];
});

const pass = async () => {
  logged = [];
  await downloadTracker.updateDownloads();
  return logged;
};
const at = (level: string, lines: Logged[]) =>
  lines
    .filter((l) => l.level === level)
    .map((l) => l.message)
    .sort();

describe('a server that stops answering', () => {
  it('is warned about once, with the reason, for each kind of server', async () => {
    down = new Set(['radarr', 'sonarr', 'lidarr']);

    const first = await pass();

    assert.deepEqual(at('error', first), []);
    const warnings = first.filter((l) => l.level === 'warn');
    assert.deepEqual(at('warn', first), [
      'Lidarr server Lidarr is not answering; its downloads are left as they were',
      'Radarr server Radarr is not answering; its downloads are left as they were',
      'Sonarr server Sonarr is not answering; its downloads are left as they were',
    ]);
    for (const warning of warnings) {
      assert.match(String(warning.meta.errorMessage), /ECONNREFUSED/);
    }
  });

  it('is only mentioned at debug level while it stays down', async () => {
    down = new Set(['radarr', 'sonarr', 'lidarr']);
    await pass();

    for (let i = 0; i < 3; i++) {
      const again = await pass();
      assert.deepEqual(at('error', again), []);
      assert.deepEqual(at('warn', again), []);
      assert.deepEqual(at('info', again), []);
      assert.deepEqual(at('debug', again), [
        'Lidarr server Lidarr is still not answering',
        'Radarr server Radarr is still not answering',
        'Sonarr server Sonarr is still not answering',
      ]);
    }
  });

  it('is announced once when it answers again', async () => {
    down = new Set(['radarr', 'sonarr', 'lidarr']);
    await pass();
    await pass();

    down = new Set();
    const back = await pass();
    assert.deepEqual(at('info', back), [
      'Lidarr server Lidarr is answering again',
      'Radarr server Radarr is answering again',
      'Sonarr server Sonarr is answering again',
    ]);

    const after = await pass();
    assert.deepEqual(at('info', after), []);
    assert.deepEqual(at('warn', after), []);
  });

  it('is warned about again if it goes down again', async () => {
    down = new Set(['sonarr']);
    await pass();
    down = new Set();
    await pass();

    down = new Set(['sonarr']);
    const again = await pass();
    assert.deepEqual(at('warn', again), [
      'Sonarr server Sonarr is not answering; its downloads are left as they were',
    ]);
  });

  it('says nothing about the servers that answer', async () => {
    down = new Set(['radarr']);

    const lines = await pass();

    assert.deepEqual(at('warn', lines), [
      'Radarr server Radarr is not answering; its downloads are left as they were',
    ]);
    assert.deepEqual(at('info', lines), []);
  });
});
