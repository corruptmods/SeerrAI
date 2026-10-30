import {
  PACE_WINDOW_MS,
  swarmLacks,
  TorrentWatch,
} from '@server/lib/backfill/watchdog';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const HOUR = 60 * 60_000;
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const LIMITS = { stallHours: 12, slowHours: 72 };
const reading = (have: number, left = 20 * GB) => ({
  have,
  left,
  held: false,
  incomplete: false,
});

describe('swarmLacks', () => {
  it('is true only when a wanted file not yet in is short of pieces', () => {
    assert.equal(swarmLacks({}, [{ progress: 0.2, availability: 1 }]), false);
    assert.equal(swarmLacks({}, [{ progress: 0.2 }]), false);
    assert.equal(
      swarmLacks({}, [
        { progress: 0.2, availability: 1 },
        { progress: 0.1, availability: 0.98 },
      ]),
      true
    );
    // Already in: what peers have no longer matters.
    assert.equal(swarmLacks({}, [{ progress: 1, availability: 0 }]), false);
    assert.equal(swarmLacks({ unavailable: 4 * MB }, []), true);
    assert.equal(swarmLacks({ unavailable: 0 }, []), false);
  });
});

describe('TorrentWatch', () => {
  it('gives up after the stall time with nothing gained', () => {
    const watch = new TorrentWatch();
    const t = Date.now();
    assert.equal(watch.check(1, reading(GB), LIMITS, t), null);
    assert.equal(watch.check(1, reading(GB), LIMITS, t + 11 * HOUR), null);
    assert.match(
      watch.check(1, reading(GB), LIMITS, t + 13 * HOUR) ?? '',
      /^Nothing downloaded for 12 hours/
    );
  });

  it('gives up within the hour on one whose swarm never had all of it', () => {
    const watch = new TorrentWatch();
    const t = Date.now();
    const short = (have: number) => ({ ...reading(have), incomplete: true });
    assert.equal(watch.check(1, short(GB), LIMITS, t), null);
    assert.equal(watch.check(1, short(2 * GB), LIMITS, t + 50 * 60_000), null);
    assert.match(
      watch.check(1, short(3 * GB), LIMITS, t + 61 * 60_000) ?? '',
      /from the start, so it could never finish/
    );
    // Waiting forever means forever.
    const patient = { stallHours: 0, slowHours: 0 };
    watch.check(2, short(GB), patient, t);
    assert.equal(watch.check(2, short(2 * GB), patient, t + 30 * HOUR), null);
  });

  it('gives up after the stall time on one whose swarm lost part of it, though the rest trickles in', () => {
    const watch = new TorrentWatch();
    const t = Date.now();
    const short = (have: number) => ({ ...reading(have), incomplete: true });
    assert.equal(watch.check(1, reading(GB), LIMITS, t), null);
    assert.equal(watch.check(1, short(2 * GB), LIMITS, t + HOUR), null);
    assert.equal(watch.check(1, short(3 * GB), LIMITS, t + 6 * HOUR), null);
    assert.match(
      watch.check(1, short(4 * GB), LIMITS, t + 14 * HOUR) ?? '',
      /on no one’s computer for 12 hours, so it could never finish/
    );
  });

  it('starts the clock again once the swarm has all of it', () => {
    const watch = new TorrentWatch();
    const t = Date.now();
    const short = (have: number) => ({ ...reading(have), incomplete: true });
    watch.check(1, reading(GB), LIMITS, t);
    watch.check(1, short(GB), LIMITS, t + HOUR);
    watch.check(1, reading(2 * GB, 5 * GB), LIMITS, t + 10 * HOUR);
    assert.equal(
      watch.check(1, reading(3 * GB, 4 * GB), LIMITS, t + 13 * HOUR),
      null
    );
  });

  it('gives up on one too slow over two windows in a row, saying how long it would take', () => {
    const watch = new TorrentWatch();
    const t = Date.now();
    // 20 KB/s with 23 GB left: about 14 days.
    const pace = 20 * 1024 * (PACE_WINDOW_MS / 1000);
    assert.equal(watch.check(1, reading(0, 23 * GB), LIMITS, t), null);
    assert.equal(
      watch.check(1, reading(pace, 23 * GB), LIMITS, t + PACE_WINDOW_MS),
      null
    );
    assert.equal(
      watch.check(
        1,
        reading(1.5 * pace, 23 * GB),
        LIMITS,
        t + PACE_WINDOW_MS + HOUR
      ),
      null,
      'judged only once a whole window has passed'
    );
    assert.equal(
      watch.check(
        1,
        reading(2 * pace, 23 * GB),
        LIMITS,
        t + 2 * PACE_WINDOW_MS
      ),
      'Too slow: at 20 KB/s, the 23.0 GB left would take about 14 days, over the 72 hours allowed.'
    );
  });

  it('lets one run on after a slow window that picks up again', () => {
    const watch = new TorrentWatch();
    const t = Date.now();
    const slow = 10 * 1024 * (PACE_WINDOW_MS / 1000);
    const fast = 10 * MB * (PACE_WINDOW_MS / 1000);
    watch.check(1, reading(0), LIMITS, t);
    watch.check(1, reading(slow), LIMITS, t + PACE_WINDOW_MS);
    assert.equal(
      watch.check(1, reading(slow + fast), LIMITS, t + 2 * PACE_WINDOW_MS),
      null
    );
    assert.equal(
      watch.check(1, reading(2 * slow + fast), LIMITS, t + 3 * PACE_WINDOW_MS),
      null
    );
  });

  it('counts no paused or queued time, and nothing when turned off', () => {
    const watch = new TorrentWatch();
    const t = Date.now();
    const crawl = 1024 * (PACE_WINDOW_MS / 1000);
    watch.check(1, reading(0), LIMITS, t);
    watch.check(1, { ...reading(0), held: true }, LIMITS, t + 20 * HOUR);
    assert.equal(watch.check(1, reading(0), LIMITS, t + 21 * HOUR), null);

    const off = { stallHours: 0, slowHours: 0 };
    watch.check(2, reading(0), off, t);
    assert.equal(watch.check(2, reading(crawl), off, t + 2 * HOUR), null);
    assert.equal(watch.check(2, reading(crawl), off, t + 900 * HOUR), null);
  });
});
