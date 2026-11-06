import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import type { TmdbTvDetails } from '@server/api/themoviedb/interfaces';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import FutureSeasonSubscription from '@server/entity/FutureSeasonSubscription';
import Media from '@server/entity/Media';
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
import notificationManager, { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

/*
 * "Future seasons only": follow a series without the seasons already out.
 * Subscribed series are checked on a schedule. Each new season is requested
 * for the follower as an ordinary automatic request as soon as it's announced
 * and Sonarr lists it, so Sonarr monitors it early and grabs the first episode
 * on air day; failing that, once it premieres. Approval, quotas, Sonarr and
 * notifications apply as usual. Followers are told when a season is
 * announced, when one starts and when the series ends.
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

/** The seasons TMDB lists, without specials. */
const listedSeasons = (show: Pick<TmdbTvDetails, 'seasons'>) =>
  (show.seasons ?? []).filter((season) => season.season_number > 0);

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

/**
 * Seasons from `fromSeason` on to request now, in order: those due, and those
 * announced that Sonarr already lists (`known`). TMDB lists a season once
 * it's renewed, dated or not. Nothing is requested early for a finished
 * series, nor early past a season that has to wait. A due season is never
 * held back by an earlier one that may never get a date; the follow then
 * stays at the earlier one (nextSeason), so it isn't skipped.
 */
export const seasonsToRequest = (
  show: Pick<TmdbTvDetails, 'seasons' | 'status'>,
  fromSeason: number,
  known: ReadonlySet<number> | undefined,
  now = Date.now()
): number[] => {
  const due = new Set(dueSeasons(show, fromSeason, now));
  const early = !isFinished(show) && known ? known : new Set<number>();
  const seasons: number[] = [];
  let waiting = false;
  for (const number of listedSeasons(show)
    .map((season) => season.season_number)
    .filter((number) => number >= fromSeason)
    .sort((a, b) => a - b)) {
    if (due.has(number) || (!waiting && early.has(number))) {
      seasons.push(number);
    } else {
      waiting = true;
    }
  }
  return seasons;
};

/**
 * Where a follow goes on once `requested` are handled: the first season TMDB
 * lists among them that wasn't, else the one after the last.
 */
export const nextSeason = (
  show: Pick<TmdbTvDetails, 'seasons'>,
  fromSeason: number,
  requested: number[]
): number => {
  const last = Math.max(...requested);
  const skipped = listedSeasons(show)
    .map((season) => season.season_number)
    .filter(
      (number) =>
        number >= fromSeason && number < last && !requested.includes(number)
    );
  return skipped.length ? Math.min(...skipped) : last + 1;
};

/**
 * Seasons the series' Sonarr server lists: the server it's on, else the
 * default. Sonarr only monitors a requested season it lists, and its next
 * scan declines a request for one it doesn't, so a season is requested early
 * only once Sonarr has it from TheTVDB. Undefined when there's no server or
 * it can't be reached; the premiere still brings the season then.
 */
const sonarrSeasons = async (
  show: TmdbTvDetails
): Promise<Set<number> | undefined> => {
  const tvdbId = show.external_ids?.tvdb_id;
  const servers = getSettings().sonarr.filter((server) => !server.is4k);
  if (!tvdbId || !servers.length) {
    return undefined;
  }
  const media = await getRepository(Media).findOne({
    where: { tmdbId: show.id, mediaType: MediaType.TV },
  });
  const server =
    servers.find((s) => s.id === media?.serviceId) ??
    servers.find((s) => s.isDefault);
  if (!server) {
    return undefined;
  }
  try {
    const sonarr = new SonarrAPI({
      apiKey: server.apiKey,
      url: SonarrAPI.buildUrl(server, '/api/v3'),
    });
    // A series Sonarr has goes by its own copy, which only learns of a new
    // season when Sonarr refreshes it; one it hasn't, by TheTVDB's.
    const [inLibrary] = await sonarr.getLibrarySeriesByTvdbId(tvdbId);
    const series = inLibrary ?? (await sonarr.getSeriesByTvdbId(tvdbId));
    return new Set((series.seasons ?? []).map((season) => season.seasonNumber));
  } catch (e) {
    logger.debug('Could not look up a followed series in Sonarr', {
      label: 'Future Seasons',
      tmdbId: show.id,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
};

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

  const fromSeason = firstFutureSeason(show);
  return getRepository(FutureSeasonSubscription).save(
    new FutureSeasonSubscription({
      user,
      tmdbId,
      fromSeason,
      premieredSeason: fromSeason - 1,
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

const POSTER = 'https://image.tmdb.org/t/p/w600_and_h900_bestv2';

/** "Season 4", "Seasons 4 and 5", "Seasons 4, 5 and 6". */
const seasonsText = (seasons: number[]) =>
  seasons.length === 1
    ? `Season ${seasons[0]}`
    : `Seasons ${seasons.slice(0, -1).join(', ')} and ${seasons.at(-1)}`;

const longDate = (time: number) =>
  new Date(time).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** Tells the follower, and only them, about a series they follow. */
const tell = (
  subscription: FutureSeasonSubscription,
  show: TmdbTvDetails,
  subject: string,
  message: string
) =>
  notificationManager.sendNotification(Notification.FOLLOWED_SERIES, {
    subject,
    message,
    image: show.poster_path ? `${POSTER}${show.poster_path}` : undefined,
    notifyAdmin: false,
    notifySystem: false,
    notifyUser: subscription.user,
    actionUrl: `/tv/${show.id}`,
    actionUrlTitle: 'View',
  });

/** Seasons requested ahead of their premiere, as they were announced. */
const tellAnnounced = (
  subscription: FutureSeasonSubscription,
  show: TmdbTvDetails,
  seasons: number[],
  outcome: 'requested' | 'already'
) => {
  const one = seasons.length === 1;
  const premiere = one
    ? airTime(
        show.seasons?.find((season) => season.season_number === seasons[0])
          ?.air_date
      )
    : undefined;
  tell(
    subscription,
    show,
    `${seasonsText(seasons)} of ${show.name} ${one ? 'was' : 'were'} announced`,
    (outcome === 'requested'
      ? one
        ? 'It’s been requested for you.'
        : 'They’ve been requested for you.'
      : one
        ? 'It’s already been requested.'
        : 'They’ve already been requested.') +
      (premiere !== undefined ? ` It starts ${longDate(premiere)}.` : '')
  );
};

/**
 * A season starting. `outcome` is set when it was requested in this check,
 * at its premiere.
 */
const tellPremiere = (
  subscription: FutureSeasonSubscription,
  show: TmdbTvDetails,
  season: { season_number: number; air_date?: string | null },
  outcome: 'requested' | 'already' | undefined,
  now: number
) => {
  const date = season.air_date?.slice(0, 10) ?? '';
  const today = new Date(now).toISOString().slice(0, 10);
  tell(
    subscription,
    show,
    `${show.name} season ${season.season_number} ${
      date === today
        ? 'starts today'
        : date > today
          ? 'starts tomorrow'
          : 'has started'
    }`,
    outcome === 'requested'
      ? 'It’s been requested for you.'
      : outcome === 'already'
        ? 'It’s already been requested.'
        : 'It was requested when it was announced.'
  );
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

        const listed = listedSeasons(show);
        // Sonarr is asked once per series, and only if a season could come
        // early.
        let known: Promise<Set<number> | undefined> | undefined;

        for (const subscription of followers) {
          // Feature off (globally or for this user): paused, not removed.
          if (!featureEnabled('newSeasons', subscription.user)) {
            continue;
          }

          const due = new Set(dueSeasons(show, subscription.fromSeason, now));
          const early =
            !isFinished(show) &&
            listed.some(
              (season) =>
                season.season_number >= subscription.fromSeason &&
                !due.has(season.season_number)
            );
          if (early) {
            known ??= sonarrSeasons(show);
          }
          const seasons = seasonsToRequest(
            show,
            subscription.fromSeason,
            early ? await known : undefined,
            now
          );

          let handled: 'requested' | 'already' | undefined;
          if (seasons.length) {
            const outcome = canSubscribe(subscription.user)
              ? await requestSeasons(subscription, show, seasons)
              : 'drop';

            if (outcome === 'drop') {
              await repository.delete(subscription.id);
              continue;
            }
            if (outcome !== 'retry') {
              handled = outcome;
              subscription.fromSeason = nextSeason(
                show,
                subscription.fromSeason,
                seasons
              );
              await repository.update(subscription.id, {
                fromSeason: subscription.fromSeason,
              });

              if (outcome === 'requested') {
                logger.info('Requested a new season for a follower', {
                  label: 'Future Seasons',
                  tmdbId,
                  userId: subscription.user.id,
                  seasons,
                });
              }

              const ahead = seasons.filter((number) => !due.has(number));
              if (ahead.length) {
                tellAnnounced(subscription, show, ahead, outcome);
              }
            }
          }

          // Seasons requested that start now; a season waiting on a retry is
          // told of once it's requested.
          const started = listed
            .filter(
              (season) =>
                season.season_number > subscription.premieredSeason &&
                (season.season_number < subscription.fromSeason ||
                  (!!handled && seasons.includes(season.season_number)))
            )
            .filter((season) => {
              const time = airTime(season.air_date);
              return time !== undefined && time <= now + DAY_MS;
            })
            .sort((a, b) => a.season_number - b.season_number);
          for (const season of started) {
            tellPremiere(
              subscription,
              show,
              season,
              handled && seasons.includes(season.season_number)
                ? handled
                : undefined,
              now
            );
          }
          if (started.length) {
            subscription.premieredSeason = started.at(-1)!.season_number;
            await repository.update(subscription.id, {
              premieredSeason: subscription.premieredSeason,
            });
          }

          // A finished series with no dated season still to start, nor the
          // next to request, needs no more checks; seasons it lists without a
          // date won't come.
          if (
            isFinished(show) &&
            !listed.some(
              (season) =>
                (season.season_number > subscription.premieredSeason ||
                  season.season_number === subscription.fromSeason) &&
                airTime(season.air_date) !== undefined
            )
          ) {
            tell(
              subscription,
              show,
              show.status === 'Canceled'
                ? `${show.name} was cancelled`
                : `${show.name} has ended`,
              'No more seasons are coming, so you’re no longer following it.'
            );
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
