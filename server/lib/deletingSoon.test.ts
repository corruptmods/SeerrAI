import MaintainerrAPI from '@server/api/maintainerr';
import {
  getDeletingSoon,
  refreshDeletingSoon,
  resetDeletingSoonForTests,
} from '@server/lib/deletingSoon';
import type { MaintainerrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * Each Maintainerr server is asked again once its last attempt is old, not
 * its last answer: one that cannot be reached is retried every so often,
 * not on every page that shows a badge.
 */

const MINUTE = 60 * 1000;

const server = (id: number, hostname: string): MaintainerrSettings =>
  ({
    id,
    name: hostname,
    hostname,
    port: 6246,
    useSsl: false,
    urlBase: '',
    apiKey: '',
    showBadges: true,
    showDeletingSoon: true,
    allowKeep: true,
    keepDays: 0,
    soonDays: 7,
  }) as MaintainerrSettings;

let now = 0;
let down = new Set<string>();
let asked: string[] = [];

beforeEach(() => {
  now = Date.UTC(2026, 0, 1);
  down = new Set();
  asked = [];
  resetDeletingSoonForTests();
  mock.method(Date, 'now', () => now);
  mock.method(
    MaintainerrAPI.prototype,
    'getCollections',
    async function (this: { axios: { defaults: { baseURL: string } } }) {
      const host = new URL(this.axios.defaults.baseURL).hostname;
      asked.push(host);
      if (down.has(host)) throw new Error('connect ECONNREFUSED');
      return [];
    }
  );
});

afterEach(() => {
  mock.restoreAll();
  getSettings().maintainerr = [];
});

describe('deleting soon refresh', () => {
  it('retries a server that went away every so often, not on every call', async () => {
    getSettings().maintainerr = [server(0, 'a.test'), server(1, 'b.test')];
    await getDeletingSoon();
    assert.deepEqual(asked, ['a.test', 'b.test']);

    // Later, B stops answering: the next look refreshes both.
    now += 20 * MINUTE;
    down.add('b.test');
    await getDeletingSoon();
    await refreshDeletingSoon();
    asked = [];

    // Moments later, nothing is asked again.
    now += MINUTE;
    for (let i = 0; i < 3; i++) {
      await getDeletingSoon();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(asked, []);
  });

  it('tries again later when the only server could not be reached at first', async () => {
    getSettings().maintainerr = [server(0, 'a.test')];
    down.add('a.test');
    await getDeletingSoon();
    assert.deepEqual(asked, ['a.test']);

    now += 20 * MINUTE;
    down.clear();
    await getDeletingSoon();
    assert.deepEqual(asked, ['a.test', 'a.test']);
  });
});
