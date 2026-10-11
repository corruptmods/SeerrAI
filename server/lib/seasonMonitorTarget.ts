import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { EntityManager } from 'typeorm';

/**
 * The set of episodes that should be monitored for one season.
 *
 * `wholeSeason` means at least one live request asked for the season without
 * naming episodes, so every episode is wanted and `episodeNumbers` is
 * irrelevant. Otherwise `episodeNumbers` is the union of every episode named
 * by every live request.
 *
 * Unioning rather than overwriting is what lets two users coexist: if one asks
 * for episodes 3 and 5 and another later asks for the whole season, the season
 * wins for both; if the second asks only for episode 8, all three are
 * monitored. No request ever removes what another request asked for.
 */
export interface SeasonMonitorTarget {
  wholeSeason: boolean;
  episodeNumbers: number[];
}

const LIVE_STATUSES = [
  MediaRequestStatus.PENDING,
  MediaRequestStatus.APPROVED,
  MediaRequestStatus.COMPLETED,
];

export const resolveSeasonMonitorTarget = async (
  mediaId: number,
  seasonNumber: number,
  is4k: boolean,
  options: {
    /**
     * The connection of the save this runs inside. After a request is
     * removed, the clean-up runs inside the removal's transaction: through
     * the global connection, Postgres still shows the removed request, whose
     * episodes then stay wanted and are never unmonitored.
     */
    manager?: EntityManager;
    /** A request being removed, left out whatever the connection shows. */
    excludeRequestId?: number;
  } = {}
): Promise<SeasonMonitorTarget> => {
  const requests = (
    await (options.manager ?? getRepository(MediaRequest).manager)
      .getRepository(MediaRequest)
      .find({
        where: { media: { id: mediaId }, is4k },
        relations: { seasons: { episodes: true } },
      })
  ).filter((request) => request.id !== options.excludeRequestId);

  const episodeNumbers = new Set<number>();
  let wholeSeason = false;

  for (const request of requests) {
    if (!LIVE_STATUSES.includes(request.status)) {
      continue;
    }

    for (const seasonRequest of request.seasons) {
      if (seasonRequest.seasonNumber !== seasonNumber) {
        continue;
      }

      if (!LIVE_STATUSES.includes(seasonRequest.status)) {
        continue;
      }

      // No episode rows means the whole season, which is also how every
      // request created before episode-level requests existed is stored.
      if (!seasonRequest.episodes?.length) {
        wholeSeason = true;
        continue;
      }

      for (const episode of seasonRequest.episodes) {
        episodeNumbers.add(episode.episodeNumber);
      }
    }
  }

  return {
    wholeSeason,
    episodeNumbers: [...episodeNumbers].sort((a, b) => a - b),
  };
};

export default resolveSeasonMonitorTarget;
