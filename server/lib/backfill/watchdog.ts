import { sizeOf } from '@server/lib/agent/rules';

/*
 * Gives up on Backfill torrents (and album songs) that won't finish in useful
 * time, so the next release is tried:
 * - stalled: nothing gained for the stall time;
 * - incomplete: part of what's wanted is on no connected peer, so it can't
 *   finish. The stall clock keeps running meanwhile, even as the rest
 *   trickles in. A swarm that never had all of it is given up within its
 *   first hour (indexer seeder counts are often stale);
 * - too slow: at the pace of two windows in a row, the rest would take
 *   longer than allowed.
 * Paused, queued or checking time doesn't count. State is in memory: a
 * restart gives every torrent a fresh allowance.
 */

const HOUR = 60 * 60_000;

/** Length of each pace window. */
export const PACE_WINDOW_MS = 2 * HOUR;
/** Consecutive slow windows before giving up. */
const SLOW_WINDOWS = 2;
/** Grace for a swarm that never had all of it. */
export const NEVER_WHOLE_MS = HOUR;

export interface TorrentReading {
  /** Wanted bytes downloaded. */
  have: number;
  /** Wanted bytes remaining. */
  left: number;
  /** Paused, queued or checking in the client. */
  held: boolean;
  /** Part of what's wanted is on no connected peer. */
  incomplete: boolean;
}

export interface WatchLimits {
  /** 0 disables the stall limit. */
  stallHours: number;
  /** 0 disables the speed limit. */
  slowHours: number;
}

const hoursText = (hours: number) => `${hours} hour${hours === 1 ? '' : 's'}`;

/** Human-readable download speed. */
const speedText = (bytesPerSecond: number): string =>
  bytesPerSecond >= 1024 ** 2
    ? `${(bytesPerSecond / 1024 ** 2).toFixed(1)} MB/s`
    : `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;

/** Hours, or days from 48 hours on. */
const durationText = (seconds: number): string => {
  const hours = Math.round(seconds / 3600);
  if (hours < 48) return hoursText(Math.max(1, hours));
  return `${Math.round(hours / 24)} days`;
};

/**
 * True if the client reports unavailable pieces, or an unfinished chosen
 * file has pieces on no connected peer. Unknown counts as available.
 */
export const swarmLacks = (
  torrent: { unavailable?: number },
  chosen: { progress: number; availability?: number }[]
): boolean =>
  (torrent.unavailable ?? 0) > 0 ||
  chosen.some(
    (file) =>
      file.progress < 1 &&
      file.availability !== undefined &&
      file.availability < 1
  );

export class TorrentWatch {
  /** Bytes each had at its last finishable progress. */
  private gains = new Map<number, { have: number; at: number }>();
  /** Start of each pace window, and consecutive slow windows. */
  private paces = new Map<number, { have: number; at: number; slow: number }>();
  /**
   * When each started downloading (null while held), and whether its swarm
   * was ever complete.
   */
  private starts = new Map<number, { at: number | null; whole: boolean }>();

  /** Time since its last finishable progress, as of the last check; 0 before. */
  public idleFor(id: number, now = Date.now()): number {
    const seen = this.gains.get(id);
    return seen ? now - seen.at : 0;
  }

  public forget(id: number): void {
    this.gains.delete(id);
    this.paces.delete(id);
    this.starts.delete(id);
  }

  /** Why to give it up now, or null to keep going. */
  public check(
    id: number,
    reading: TorrentReading,
    limits: WatchLimits,
    now = Date.now()
  ): string | null {
    const { have, left, held, incomplete } = reading;
    const start = this.starts.get(id) ?? { at: null, whole: false };
    this.starts.set(id, start);
    if (held) {
      this.gains.set(id, { have, at: now });
      this.paces.delete(id);
      start.at = null;
      return null;
    }
    start.at ??= now;
    if (!incomplete) start.whole = true;
    const firstLook = Math.min(NEVER_WHOLE_MS, limits.stallHours * HOUR);
    if (
      incomplete &&
      !start.whole &&
      firstLook > 0 &&
      now - start.at > firstLook
    ) {
      this.forget(id);
      return 'Nobody sharing this torrent has a complete copy, so it could never finish. Backfill will try a different release.';
    }

    const seen = this.gains.get(id);
    if (!seen || (have > seen.have && !incomplete)) {
      this.gains.set(id, { have, at: now });
    } else {
      seen.have = Math.max(seen.have, have);
      if (limits.stallHours > 0 && now - seen.at > limits.stallHours * HOUR) {
        this.forget(id);
        return incomplete
          ? `Nobody sharing this torrent has had a complete copy for ${hoursText(limits.stallHours)}, so it could never finish. Backfill will try a different release.`
          : `Nothing downloaded for ${hoursText(limits.stallHours)}: nobody seems to be sharing it.`;
      }
    }

    if (limits.slowHours <= 0) {
      this.paces.delete(id);
      return null;
    }
    const pace = this.paces.get(id);
    if (!pace) {
      this.paces.set(id, { have, at: now, slow: 0 });
      return null;
    }
    if (now - pace.at < PACE_WINDOW_MS) return null;
    const speed = Math.max(0, have - pace.have) / ((now - pace.at) / 1000);
    // Zero speed is left to the stall check.
    const slow =
      speed > 0 && left / speed > limits.slowHours * 3600 ? pace.slow + 1 : 0;
    this.paces.set(id, { have, at: now, slow });
    if (slow < SLOW_WINDOWS) return null;
    this.forget(id);
    return `Too slow: at ${speedText(speed)}, the ${sizeOf(left)} left would take about ${durationText(left / speed)}, over the ${hoursText(limits.slowHours)} allowed.`;
  }
}
