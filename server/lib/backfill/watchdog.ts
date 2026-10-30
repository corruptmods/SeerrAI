import { sizeOf } from '@server/lib/agent/rules';

/*
 * Watches torrents Backfill downloads (and the songs it takes from albums)
 * for ones that will never finish, or not in any useful time, so they are
 * given up and the next release tried:
 * - stalled: nothing gained for the stall time;
 * - incomplete: part of what is wanted is on no peer connected, so it can't
 *   finish however long it runs. The stall clock runs on while that lasts,
 *   even as the rest trickles in;
 * - too slow: at the pace of the last two windows in a row, what is left
 *   would take longer than allowed.
 * Paused, queued or checking time counts for none of them. Kept in memory:
 * a restart gives every torrent a fresh allowance.
 */

const HOUR = 60 * 60_000;

/** How long each measure of a torrent's pace runs. */
export const PACE_WINDOW_MS = 2 * HOUR;
/** Windows in a row too slow before it is given up. */
const SLOW_WINDOWS = 2;

export interface TorrentReading {
  /** Bytes of what is wanted that are in. */
  have: number;
  /** Bytes of what is wanted still to come. */
  left: number;
  /** Paused, queued or being checked in the client. */
  held: boolean;
  /** Part of what is wanted is on no peer connected. */
  incomplete: boolean;
}

export interface WatchLimits {
  /** 0 never gives up on a stall. */
  stallHours: number;
  /** 0 never gives up on a slow one. */
  slowHours: number;
}

const hoursText = (hours: number) => `${hours} hour${hours === 1 ? '' : 's'}`;

/** A download speed, as people read one. */
const speedText = (bytesPerSecond: number): string =>
  bytesPerSecond >= 1024 ** 2
    ? `${(bytesPerSecond / 1024 ** 2).toFixed(1)} MB/s`
    : `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;

/** Hours, or days once it is over two. */
const durationText = (seconds: number): string => {
  const hours = Math.round(seconds / 3600);
  if (hours < 48) return hoursText(Math.max(1, hours));
  return `${Math.round(hours / 24)} days`;
};

/**
 * What the swarm lacks of the files wanted: true when any of them, not yet
 * in, has pieces no peer connected has, or the client says so for the
 * torrent. Unknown counts as not lacking.
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
  /** The bytes each had when it last gained any it could finish with. */
  private gains = new Map<number, { have: number; at: number }>();
  /** Where each pace window began, and how many in a row were too slow. */
  private paces = new Map<number, { have: number; at: number; slow: number }>();

  public forget(id: number): void {
    this.gains.delete(id);
    this.paces.delete(id);
  }

  /** Why to give it up now, or null to let it run on. */
  public check(
    id: number,
    reading: TorrentReading,
    limits: WatchLimits,
    now = Date.now()
  ): string | null {
    const { have, left, held, incomplete } = reading;
    if (held) {
      this.gains.set(id, { have, at: now });
      this.paces.delete(id);
      return null;
    }

    const seen = this.gains.get(id);
    if (!seen || (have > seen.have && !incomplete)) {
      this.gains.set(id, { have, at: now });
    } else {
      seen.have = Math.max(seen.have, have);
      if (limits.stallHours > 0 && now - seen.at > limits.stallHours * HOUR) {
        this.forget(id);
        return incomplete
          ? `Part of it was on no one’s computer for ${hoursText(limits.stallHours)}, so it could never finish.`
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
    // Nothing gained is the stall clock's to judge.
    const slow =
      speed > 0 && left / speed > limits.slowHours * 3600 ? pace.slow + 1 : 0;
    this.paces.set(id, { have, at: now, slow });
    if (slow < SLOW_WINDOWS) return null;
    this.forget(id);
    return `Too slow: at ${speedText(speed)}, the ${sizeOf(left)} left would take about ${durationText(left / speed)}, over the ${hoursText(limits.slowHours)} allowed.`;
  }
}
