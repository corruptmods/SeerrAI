import { getRepository } from '@server/datasource';
import SongFetch from '@server/entity/SongFetch';
import { MoreThan } from 'typeorm';

/** Stage shown by a fetch waiting on an answer rather than its next search. */
export const SEARCHING_SOON = 'Searching again soon';

/*
 * Album searches that find nothing wait hours before retrying
 * (lib/music/songFetch); a playlist page can count and retry them now.
 */

/** Fetches for these songs waiting to search again at `now`. */
const waitingFor = async (recordings: string[], now: Date) => {
  if (!recordings.length) return [];
  const wanted = new Set(recordings);
  const waiting = await getRepository(SongFetch).find({
    select: { id: true, recordings: true, searches: true, stage: true },
    where: { status: 'searching', searchAgainAt: MoreThan(now) },
  });
  return waiting.filter((fetch) =>
    fetch.recordings.some((recording) => wanted.has(recording))
  );
};

/** Counts fetches for these songs waiting to search again. */
export const albumsWaitingToSearch = async (
  recordings: string[],
  now = new Date()
): Promise<number> => (await waitingFor(recordings, now)).length;

/**
 * Queues waiting fetches for these songs for the next pass. The skipped
 * wait isn't counted, so an empty search waits as long as the last did.
 */
export const searchAgainNow = async (
  recordings: string[],
  now = new Date()
): Promise<number> => {
  const waiting = await waitingFor(recordings, now);
  for (const fetch of waiting) {
    await getRepository(SongFetch).update(fetch.id, {
      searchAgainAt: null,
      // Waiting on Prowlarr or a resting indexer wasn't a search.
      searches: fetch.stage?.startsWith(SEARCHING_SOON)
        ? (fetch.searches ?? 0)
        : Math.max(0, (fetch.searches ?? 0) - 1),
    });
  }
  return waiting.length;
};
