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
 * "Future seasons only": someone wants a series from here on without the
 * seasons already out. Each subscribed series is checked on a schedule, and a
 * season is requested for that person, as an ordinary automatic request, once
 * it premieres. Approval, quotas, Sonarr, notifications and arrival estimates
 * then all work as they do for any request.
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
 * The first season that has not premiered yet: one past the latest season
 * with an air date already reached. A season still airing counts as out, so
 * it is not included; request it the usual way.
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
 * network's local date, so a day's grace keeps a premiere from waiting a whole
 * extra check because of time zones; nothing downloads before an episode
 * airs anyway.
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

/** Start getting new seasons of a series. Returns the first one to come. */
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

type Outcome = 'requested' | 'already' | 'retry' | 'drop';

/** Ask for the due seasons as this person; what that means for the subscription. */
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
    // Already requested or already here, by anyone: nothing left to do.
    if (
      e instanceof DuplicateMediaRequestError ||
      e instanceof NoSeasonsAvailableError
    ) {
      return 'already';
    }
    // Over quota for now: try again on a later check.
    if (e instanceof QuotaRestrictedError) {
      return 'retry';
    }
    // They can no longer request series, or it was blocklisted: stop.
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
        byShow.set(subscription.tmdbId, [
          ...(byShow.get(subscription.tmdbId) ?? []),
          subscription,
        ]);
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
          // Turned off, for everyone or by this person: kept, but paused.
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
