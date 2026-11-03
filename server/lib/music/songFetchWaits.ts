import { getRepository } from '@server/datasource';
import SongFetch from '@server/entity/SongFetch';
import { MoreThan } from 'typeorm';

/** What a fetch waiting for an answer, not for its next search, shows. */
export const SEARCHING_SOON = 'Searching again soon';

/*
 * Songs taken from albums whose search found nothing wait hours to look
 * again (lib/music/songFetch). A playlist's page says how many albums of
 * its songs are waiting, and can have them looked for now.
 */

/** Albums of these songs waiting to be searched again, at `now`. */
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

/** How many albums of these songs are waiting to be searched again. */
export const albumsWaitingToSearch = async (
  recordings: string[],
  now = new Date()
): Promise<number> => (await waitingFor(recordings, now)).length;

/**
 * Has the albums of these songs waiting to be searched again looked for at
 * the next turn. The wait it ends isn't counted against them: a search
 * that finds nothing waits as long as the last did.
 */
export const searchAgainNow = async (
  recordings: string[],
  now = new Date()
): Promise<number> => {
  const waiting = await waitingFor(recordings, now);
  for (const fetch of waiting) {
    await getRepository(SongFetch).update(fetch.id, {
      searchAgainAt: null,
      // A wait for an answer (Prowlarr, a resting indexer) was no search.
      searches: fetch.stage?.startsWith(SEARCHING_SOON)
        ? (fetch.searches ?? 0)
        : Math.max(0, (fetch.searches ?? 0) - 1),
    });
  }
  return waiting.length;
};
