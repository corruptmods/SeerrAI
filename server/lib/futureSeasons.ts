import TheMovieDb from '@server/api/themoviedb';
import type { TmdbTvDetails } from '@server/api/themoviedb/interfaces';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import FutureSeasonSubscription from '@server/entity/FutureSeasonSubscription';
import {
  BlocklistedMediaError,
  DuplicateMediaRequestError,
  MediaRequest,
  NoSeasonsAvailableError,
  QuotaRestrictedError,
  RequestPermissionError,
} from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import { featureEnabled } from '@server/lib/features';
import { Permission } from '@server/lib/permissions';
import logger from '@server/logger';

/*
 * "Future seasons only": follow a series without the seasons already out.
 * Subscribed series are checked on a schedule, and each new season is
 * requested for the follower as an ordinary automatic request once it
 * premieres, so approval, quotas, Sonarr and notifications apply as usual.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** TMDB's statuses for a series that will have no more seasons. */
const FINISHED = new Set(['Ended', 'Canceled']);

export const isFinished = (show: Pick<TmdbTvDetails, 'status'>): boolean =>
  FINISHED.has(show.status);

const airTime = (date: string | null | undefined) => {
  const time = date ? Date.parse(date) : NaN;
  return Number.isNaN(time) ? undefined : time;
};

/**
 * The first unpremiered season: one past the latest aired one. A season
 * still airing counts as out; request it the usual way.
 */
export const firstFutureSeason = (
  show: Pick<TmdbTvDetails, 'seasons'>,
  now = Date.now()
): number => {
  const aired = (show.seasons ?? [])
    .filter((season) => season.season_number > 0)
    .filter((season) => {
      const time = airTime(season.air_date);
      return time !== undefined && time <= now;
    })
    .map((season) => season.season_number);
  return aired.length ? Math.max(...aired) + 1 : 1;
};

/**
 * Seasons from `fromSeason` on that premiere within a day. TMDB dates are the
 * network's local date, so a day's grace avoids a time-zone delay of a whole
 * check; nothing downloads before an episode airs anyway.
 */
export const dueSeasons = (
  show: Pick<TmdbTvDetails, 'seasons'>,
  fromSeason: number,
  now = Date.now()
): number[] =>
  (show.seasons ?? [])
    .filter((season) => season.season_number >= fromSeason)
    .filter((season) => {
      const time = airTime(season.air_date);
      return time !== undefined && time <= now + DAY_MS;
    })
    .map((season) => season.season_number)
    .sort((a, b) => a - b);

export const canSubscribe = (user: User): boolean =>
  user.hasPermission([Permission.REQUEST, Permission.REQUEST_TV], {
    type: 'or',
  });

export class SeriesFinishedError extends Error {}

export const getSubscription = (userId: number, tmdbId: number) =>
  getRepository(FutureSeasonSubscription).findOne({
    where: { user: { id: userId }, tmdbId },
  });

/**
 * Other followers of a series and the earliest season due for any of them.
 * Shown to everyone, since each new season arrives for all.
 */
export const otherFollowers = async (
  userId: number,
  tmdbId: number
): Promise<{ names: string[]; fromSeason?: number }> => {
  const others = (
    await getRepository(FutureSeasonSubscription).find({
      where: { tmdbId },
      relations: { user: true },
      order: { createdAt: 'ASC' },
    })
  ).filter((s) => s.user.id !== userId);
  return {
    names: others.map((s) => s.user.displayName),
    fromSeason: others.length
      ? Math.min(...others.map((s) => s.fromSeason))
      : undefined,
  };
};

/** Follows a series' new seasons; returns the subscription. */
export const subscribe = async (
  user: User,
  tmdbId: number
): Promise<FutureSeasonSubscription> => {
  const existing = await getSubscription(user.id, tmdbId);
  if (existing) {
    return existing;
  }

  const show = await new TheMovieDb().getTvShow({ tvId: tmdbId });
  if (isFinished(show)) {
    throw new SeriesFinishedError('This series has ended.');
  }

  return getRepository(FutureSeasonSubscription).save(
    new FutureSeasonSubscription({
      user,
      tmdbId,
      fromSeason: firstFutureSeason(show),
    })
  );
};

export const unsubscribe = async (userId: number, tmdbId: number) => {
  await getRepository(FutureSeasonSubscription).delete({
    user: { id: userId },
    tmdbId,
  });
};

/** Removes every follower of a series. */
export const unsubscribeEveryone = async (tmdbId: number) => {
  await getRepository(FutureSeasonSubscription).delete({ tmdbId });
};

type Outcome = 'requested' | 'already' | 'retry' | 'drop';

/**
 * Requests the due seasons as the follower; returns what to do with the
 * subscription.
 */
const requestSeasons = async (
  subscription: FutureSeasonSubscription,
  show: TmdbTvDetails,
  seasons: number[]
): Promise<Outcome> => {
  try {
    await MediaRequest.request(
      {
        mediaId: show.id,
        mediaType: MediaType.TV,
        tvdbId: show.external_ids?.tvdb_id,
        seasons,
        is4k: false,
      },
      subscription.user,
      { isAutoRequest: true, newSeasonOfFollowedSeries: true }
    );
    return 'requested';
  } catch (e) {
    // Already requested or available.
    if (
      e instanceof DuplicateMediaRequestError ||
      e instanceof NoSeasonsAvailableError
    ) {
      return 'already';
    }
    // Over quota: retry later.
    if (e instanceof QuotaRestrictedError) {
      return 'retry';
    }
    // No longer allowed to request, or blocklisted.
    if (
      e instanceof RequestPermissionError ||
      e instanceof BlocklistedMediaError
    ) {
      return 'drop';
    }
    logger.warn('Could not request a new season', {
      label: 'Future Seasons',
      tmdbId: show.id,
      userId: subscription.user.id,
      seasons,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return 'retry';
  }
};

class FutureSeasons {
  public running = false;

  public async run(now = Date.now()): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      const repository = getRepository(FutureSeasonSubscription);
      const subscriptions = await repository.find({
        relations: { user: true },
        order: { id: 'ASC' },
      });

      // One TMDB lookup per series, however many people follow it.
      const byShow = new Map<number, FutureSeasonSubscription[]>();
      for (const subscription of subscriptions) {
        const followers = byShow.get(subscription.tmdbId) ?? [];
        followers.push(subscription);
        byShow.set(subscription.tmdbId, followers);
      }

      const tmdb = new TheMovieDb();
      for (const [tmdbId, followers] of byShow) {
        let show: TmdbTvDetails;
        try {
          show = await tmdb.getTvShow({ tvId: tmdbId });
        } catch (e) {
          logger.debug('Could not look up a followed series', {
            label: 'Future Seasons',
            tmdbId,
            errorMessage: e instanceof Error ? e.message : String(e),
          });
          continue;
        }

        const latest = Math.max(
          0,
          ...(show.seasons ?? []).map((season) => season.season_number)
        );

        for (const subscription of followers) {
          // Feature off (globally or for this user): paused, not removed.
          if (!featureEnabled('newSeasons', subscription.user)) {
            continue;
          }
          const due = dueSeasons(show, subscription.fromSeason, now);

          if (due.length) {
            const outcome = canSubscribe(subscription.user)
              ? await requestSeasons(subscription, show, due)
              : 'drop';

            if (outcome === 'drop') {
              await repository.delete(subscription.id);
              continue;
            }
            if (outcome === 'retry') {
              continue;
            }

            subscription.fromSeason = Math.max(...due) + 1;
            await repository.update(subscription.id, {
              fromSeason: subscription.fromSeason,
            });

            if (outcome === 'requested') {
              logger.info('Requested a new season for a follower', {
                label: 'Future Seasons',
                tmdbId,
                userId: subscription.user.id,
                seasons: due,
              });
            }
          }

          // A finished series with nothing left to come needs no more checks.
          if (isFinished(show) && subscription.fromSeason > latest) {
            await repository.delete(subscription.id);
          }
        }
      }
    } catch (e) {
      logger.error('Future season check failed', {
        label: 'Future Seasons',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.running = false;
    }
  }
}

const futureSeasons = new FutureSeasons();

export default futureSeasons;
