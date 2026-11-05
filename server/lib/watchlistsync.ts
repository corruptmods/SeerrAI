import PlexTvAPI from '@server/api/plextv';
import TheMovieDb from '@server/api/themoviedb';
import TraktAPI, { TraktError } from '@server/api/trakt';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  BlocklistedMediaError,
  DuplicateMediaRequestError,
  MediaRequest,
  NoSeasonsAvailableError,
  QuotaRestrictedError,
  RequestPermissionError,
} from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type { WatchlistSource } from '@server/entity/WatchlistSyncEntry';
import { WatchlistSyncEntry } from '@server/entity/WatchlistSyncEntry';
import { WatchlistSyncEntrySeason } from '@server/entity/WatchlistSyncEntrySeason';
import { getDeletionTimes } from '@server/lib/mediaDeletions';
import { isConnected, primaryServer } from '@server/lib/mediaServers';
import {
  clearPlexTokenRejected,
  markPlexTokenRejected,
} from '@server/lib/plexReauth';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';
import { In } from 'typeorm';
import { Permission } from './permissions';

/*
 * Each watchlist entry is acted on once.
 *
 * Plex records when a title was added to a watchlist. Sync stores that time
 * per user and title, so a handled entry is left alone however often the
 * title is later deleted, while removing and re-adding gives a new time: a
 * new entry, requested again. For series the handled seasons are stored too,
 * so a new season still comes through for a deleted show.
 *
 * From seerr-team/seerr's feat/watchlist-entry-tracking, which fixes #3222.
 */

/** A request made just before Plex's timestamp still counts as acting on it. */
const CLOCK_SKEW_SECONDS = 300;

/** A title on a user's Plex watchlist, public Trakt watchlist, or both. */
export interface WatchItem {
  tmdbId: number;
  tvdbId?: number;
  type: 'movie' | 'show';
  title: string;
  /** Plex's id, used to ask Plex when it was added. */
  plexRatingKey?: string;
  /** When Plex says it was added, if it did (see syncWithoutTimestamp). */
  addedAt?: Date;
  /** When it was added on Trakt, seconds since epoch. */
  traktListedAt?: number;
}

const mediaTypeOf = (item: WatchItem) =>
  item.type === 'show' ? MediaType.TV : MediaType.MOVIE;

const keyOf = (item: WatchItem) => `${mediaTypeOf(item)}:${item.tmdbId}`;

/** Which watchlist a title's time comes from: Trakt's when it is on it. */
const sourceOf = (item: WatchItem): WatchlistSource =>
  item.traktListedAt !== undefined ? 'trakt' : 'plex';

/**
 * Plex watchlists are read only while Seerr is connected to Plex: a user who
 * once signed in with Plex isn't synced from Plex on a Jellyfin/Emby-only
 * server.
 */
const onPlex = () => isConnected('plex') || !primaryServer();

/**
 * Retry interval for a user whose Plex sign-in expired. They have been told
 * to sign in again (and Health lists them), so polling every few minutes only
 * fills the log; hourly still catches a transient Plex rejection.
 */
export const EXPIRED_RETRY_MS = 60 * 60 * 1000;

class WatchlistSync {
  public running = false;
  /** When each user with an expired sign-in was last tried. */
  private expiredTriedAt = new Map<number, number>();
  /** When each user was last warned their Trakt watchlist can't be read. */
  private traktWarnedAt = new Map<number, number>();

  public async syncWatchlist() {
    if (this.running) {
      logger.warn('Watchlist sync is already running, skipping this run', {
        label: 'Watchlist Sync',
      });
      return;
    }

    this.running = true;

    try {
      const userRepository = getRepository(User);

      // Users with a Plex sign-in (on a Plex server) or a Trakt watchlist.
      const sources = [
        ...(onPlex() ? ["user.plexToken != ''"] : []),
        ...(getSettings().trakt.clientId
          ? [
              "(settings.traktUsername IS NOT NULL AND settings.traktUsername != '')",
            ]
          : []),
      ];
      if (!sources.length) {
        return;
      }
      const users = await userRepository
        .createQueryBuilder('user')
        .addSelect('user.plexToken')
        .leftJoinAndSelect('user.settings', 'settings')
        .where(sources.join(' OR '))
        .getMany();

      // One user's failure must not skip the users after them.
      for (const user of users) {
        try {
          await this.syncUserWatchlist(user);
        } catch (e) {
          logger.error('Failed to sync watchlist for user', {
            label: 'Watchlist Sync',
            userId: user.id,
            errorMessage: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Whether the user has auto-request and watchlist sync on for this kind of
   * title.
   */
  private syncsType(user: User, item: WatchItem): boolean {
    return item.type === 'movie'
      ? user.hasPermission(
          [Permission.AUTO_REQUEST, Permission.AUTO_REQUEST_MOVIE],
          { type: 'or' }
        ) && !!user.settings?.watchlistSyncMovies
      : item.type === 'show'
        ? user.hasPermission(
            [Permission.AUTO_REQUEST, Permission.AUTO_REQUEST_TV],
            { type: 'or' }
          ) && !!user.settings?.watchlistSyncTv
        : true;
  }

  private async syncUserWatchlist(user: User) {
    if (
      !user.hasPermission(
        [
          Permission.AUTO_REQUEST,
          Permission.AUTO_REQUEST_MOVIE,
          Permission.AUTO_REQUEST_TV,
        ],
        { type: 'or' }
      )
    ) {
      return;
    }

    if (
      !user.settings?.watchlistSyncMovies &&
      !user.settings?.watchlistSyncTv
    ) {
      return;
    }

    const watchlist = await this.watchlistOf(user);
    if (!watchlist) {
      return;
    }
    const { plexTvApi } = watchlist;
    const response = watchlist;

    // Strict: an unreadable database must stop the sync, not read as empty and
    // request the whole watchlist again.
    const mediaItems = await Media.findRelatedMedia(
      user,
      response.items.map((i) => ({
        tmdbId: i.tmdbId,
        mediaType: mediaTypeOf(i),
      }))
    );

    const watchlistTmdbIds = response.items.map((i) => i.tmdbId);

    const requestRepository = getRepository(MediaRequest);
    const existingAutoRequests: MediaRequest[] =
      watchlistTmdbIds.length > 0
        ? await requestRepository
            .createQueryBuilder('request')
            .leftJoinAndSelect('request.media', 'media')
            .leftJoinAndSelect('request.seasons', 'seasons')
            .where('request.requestedBy = :userId', { userId: user.id })
            .andWhere('request.isAutoRequest = true')
            .andWhere('media.tmdbId IN (:...tmdbIds)', {
              tmdbIds: watchlistTmdbIds,
            })
            .getMany()
        : [];

    // A deleted title's old request doesn't settle it; its entry decides below.
    const autoRequestedTmdbIds = new Set(
      existingAutoRequests
        .filter(
          (r) => r.media != null && r.media.status !== MediaStatus.DELETED
        )
        .map((r) => `${r.media.mediaType}:${r.media.tmdbId}`)
    );

    const unavailableItems = response.items.filter((i) => {
      const itemMediaType = mediaTypeOf(i);

      return (
        !autoRequestedTmdbIds.has(`${itemMediaType}:${i.tmdbId}`) &&
        !mediaItems.find(
          (m) =>
            m.tmdbId === i.tmdbId &&
            m.mediaType === itemMediaType &&
            (m.status === MediaStatus.BLOCKLISTED ||
              (itemMediaType === MediaType.MOVIE &&
                m.status !== MediaStatus.UNKNOWN &&
                m.status !== MediaStatus.DELETED) ||
              (itemMediaType === MediaType.TV &&
                m.status === MediaStatus.AVAILABLE))
        )
      );
    });

    if (!unavailableItems.length) {
      return;
    }

    const unavailableTmdbIds = unavailableItems.map((i) => i.tmdbId);

    const entries = await getRepository(WatchlistSyncEntry).find({
      where: {
        requestedBy: { id: user.id },
        tmdbId: In(unavailableTmdbIds),
      },
    });

    const entriesByKey = new Map(
      entries.map((e) => [`${e.mediaType}:${e.tmdbId}`, e])
    );

    const autoRequestsByKey = new Map<string, MediaRequest[]>();
    for (const request of existingAutoRequests) {
      if (!request.media) {
        continue;
      }

      const key = `${request.media.mediaType}:${request.media.tmdbId}`;
      autoRequestsByKey.set(key, [
        ...(autoRequestsByKey.get(key) ?? []),
        request,
      ]);
    }

    /*
     * A title with no entry yet (every title on the first sync after tracking
     * began) is settled by whether and when it was deleted, using the fork's
     * deletion records. A title marked deleted with no record predates them:
     * its row's last update is the best time available and is at or after the
     * deletion, so it errs towards leaving the title alone. Re-downloading what
     * the owner deleted is the worse mistake; a user who wants it back removes
     * and re-adds it, a new entry.
     */
    const deletionTimes = await getDeletionTimes(unavailableTmdbIds);
    const markedDeleted = new Map<string, Date>(
      mediaItems
        .filter((m) => m.status === MediaStatus.DELETED)
        .map((m) => [`${m.mediaType}:${m.tmdbId}`, m.updatedAt])
    );

    const tmdb = new TheMovieDb();

    // Watchlist-add times, five lookups at a time: Plex sometimes takes its
    // full timeout per title, and one slow user held up everyone after them. A
    // title on Trakt uses Trakt's time, which is always present and stable;
    // only Plex-only titles ask Plex.
    const watchlistedAtByKey = new Map<string, number | null>();
    await mapWithConcurrency(
      unavailableItems.filter(
        (item) =>
          this.syncsType(user, item) && (item.type !== 'show' || item.tvdbId)
      ),
      5,
      async (item) => {
        watchlistedAtByKey.set(
          keyOf(item),
          item.traktListedAt ??
            (item.plexRatingKey && plexTvApi
              ? await plexTvApi.getWatchlistedAt(item.plexRatingKey)
              : null)
        );
      }
    );

    for (const mediaItem of unavailableItems) {
      const mediaType = mediaTypeOf(mediaItem);
      const key = `${mediaType}:${mediaItem.tmdbId}`;

      let entryStamp: number | null = null;
      const source = sourceOf(mediaItem);
      let handledSeasons: number[] = [];
      let candidateSeasons: number[] = [];

      try {
        // Sonarr finds series by TVDB id; without one the request can't go
        // anywhere.
        if (mediaItem.type === 'show' && !mediaItem.tvdbId) {
          throw new Error('Missing TVDB ID from the watchlist');
        }

        if (!this.syncsType(user, mediaItem)) {
          continue;
        }

        const entry = entriesByKey.get(key);
        const deleted = deletionTimes.has(key) || markedDeleted.has(key);
        const deletedAt: Date | undefined =
          deletionTimes.get(key) ?? markedDeleted.get(key) ?? undefined;
        const watchlistedAt = watchlistedAtByKey.get(key) ?? null;

        if (!watchlistedAt) {
          await this.syncWithoutTimestamp(user, mediaItem, mediaType, {
            hasEntry: !!entry,
            hasAutoRequest: autoRequestsByKey.has(key),
            deleted,
            deletedAt,
          });
          continue;
        }

        entryStamp = watchlistedAt;

        // Times from the two watchlists never match, so a title whose time now
        // comes from the other source (Trakt unreadable this time, or a Trakt
        // username just added) is the same entry, not a re-add: store the new
        // time, request nothing.
        const sameSource =
          !entry || (entry.watchlistedFrom ?? 'plex') === source;
        if (entry && !sameSource) {
          await getRepository(WatchlistSyncEntry).update(entry.id, {
            watchlistedAt,
            watchlistedFrom: source,
          });
        }
        const rearmed =
          !!entry && sameSource && entry.watchlistedAt !== watchlistedAt;
        let handledPreviously = false;
        let deletedSinceAdded = false;

        if (entry && rearmed) {
          logger.info('Watchlist entry re-added, requesting again', {
            label: 'Watchlist Sync',
            userId: user.id,
            mediaTitle: mediaItem.title,
            previousWatchlistedAt: entry.watchlistedAt,
            watchlistedAt,
          });
        }

        if (entry && !rearmed) {
          handledSeasons = entry.seasons.map((s) => s.seasonNumber);
        } else if (!entry) {
          // An auto-request after the watchlist add means sync already handled
          // this entry.
          const priorRequests = (autoRequestsByKey.get(key) ?? []).filter(
            (r) =>
              Math.floor(r.createdAt.getTime() / 1000) >=
              watchlistedAt - CLOCK_SKEW_SECONDS
          );

          handledSeasons = this.mergeSeasons(
            priorRequests.flatMap((r) =>
              (r.seasons ?? []).map((s) => s.seasonNumber)
            )
          );

          // Deleted after the watchlist add, or at an unknown time: this is the
          // stale entry a cleanup meant to get rid of, not a new request.
          deletedSinceAdded =
            deleted &&
            (!deletedAt ||
              Math.floor(deletedAt.getTime() / 1000) >= watchlistedAt);

          handledPreviously = priorRequests.length > 0 || deletedSinceAdded;
        }

        if (mediaType === MediaType.MOVIE) {
          if (entry && !rearmed) {
            continue;
          }

          if (handledPreviously) {
            await this.saveEntry(user, mediaItem, mediaType, watchlistedAt, []);
            continue;
          }

          await MediaRequest.request(
            {
              mediaId: mediaItem.tmdbId,
              mediaType,
              tvdbId: mediaItem.tvdbId,
              is4k: false,
            },
            user,
            { isAutoRequest: true }
          );

          await this.saveEntry(user, mediaItem, mediaType, watchlistedAt, []);

          logger.info("Created media request from user's watchlist", {
            label: 'Watchlist Sync',
            userId: user.id,
            mediaTitle: mediaItem.title,
            from: mediaItem.traktListedAt ? 'Trakt' : 'Plex',
          });

          continue;
        }

        // Mirrors how 'all' expands in MediaRequest.request, which drops season
        // 0.
        const tmdbShow = await tmdb.getTvShow({ tvId: mediaItem.tmdbId });
        const seasons = tmdbShow.seasons.filter(
          (season) => season.season_number !== 0
        );
        candidateSeasons = seasons.map((season) => season.season_number);

        if (deletedSinceAdded) {
          handledSeasons = this.mergeSeasons(
            handledSeasons,
            this.airedBy(seasons, deletedAt ?? new Date())
          );
        }

        const requestedSeasons = candidateSeasons.filter(
          (season) => !handledSeasons.includes(season)
        );

        if (!requestedSeasons.length) {
          if (!entry || rearmed || handledPreviously) {
            await this.saveEntry(
              user,
              mediaItem,
              mediaType,
              watchlistedAt,
              this.mergeSeasons(handledSeasons, candidateSeasons)
            );
          }
          continue;
        }

        await MediaRequest.request(
          {
            mediaId: mediaItem.tmdbId,
            mediaType,
            seasons: requestedSeasons,
            tvdbId: mediaItem.tvdbId,
            is4k: false,
          },
          user,
          { isAutoRequest: true }
        );

        await this.saveEntry(
          user,
          mediaItem,
          mediaType,
          watchlistedAt,
          this.mergeSeasons(handledSeasons, candidateSeasons)
        );

        logger.info("Created media request from user's watchlist", {
          label: 'Watchlist Sync',
          userId: user.id,
          mediaTitle: mediaItem.title,
          from: mediaItem.traktListedAt ? 'Trakt' : 'Plex',
        });
      } catch (e) {
        if (!(e instanceof Error)) {
          continue;
        }

        switch (e.constructor) {
          // Nothing new requested, but the entry was handled, so record it.
          case DuplicateMediaRequestError:
          case NoSeasonsAvailableError:
            if (entryStamp) {
              await this.saveEntry(
                user,
                mediaItem,
                mediaType,
                entryStamp,
                mediaType === MediaType.TV
                  ? this.mergeSeasons(handledSeasons, candidateSeasons)
                  : []
              );
            }

            logger.debug('Failed to create media request from watchlist', {
              label: 'Watchlist Sync',
              userId: user.id,
              mediaTitle: mediaItem.title,
              errorMessage: e.message,
            });
            break;
          // Not necessarily a Seerr problem: the user may be at their quota.
          // Leave the entry untracked so a later sync retries.
          case RequestPermissionError:
          case QuotaRestrictedError:
            logger.debug('Failed to create media request from watchlist', {
              label: 'Watchlist Sync',
              userId: user.id,
              mediaTitle: mediaItem.title,
              errorMessage: e.message,
            });
            break;
          // Ignore blocklisted media silently to avoid spam.
          case BlocklistedMediaError:
            break;
          default:
            logger.error('Failed to create media request from watchlist', {
              label: 'Watchlist Sync',
              userId: user.id,
              mediaTitle: mediaItem.title,
              errorMessage: e.message,
            });
        }
      }
    }
  }

  /**
   * Plex gave no watchlist-add time, so a re-add can't be told from the handled
   * entry. Falls back to the fork's pre-tracking logic and records nothing,
   * since an entry is useless without the time.
   *
   * Re-downloading what the owner deleted is the worse mistake, so a title with
   * an entry, or deleted since it was added, is left alone.
   */
  private async syncWithoutTimestamp(
    user: User,
    mediaItem: WatchItem,
    mediaType: MediaType,
    known: {
      hasEntry: boolean;
      /** An earlier auto-request, including for a title since deleted. */
      hasAutoRequest: boolean;
      deleted: boolean;
      deletedAt?: Date;
    }
  ): Promise<void> {
    if (known.hasEntry || known.hasAutoRequest) {
      return;
    }

    // Only a deletion with a known time can be shown to predate the entry.
    if (
      known.deleted &&
      (!known.deletedAt ||
        !mediaItem.addedAt ||
        mediaItem.addedAt <= known.deletedAt)
    ) {
      return;
    }

    await MediaRequest.request(
      {
        mediaId: mediaItem.tmdbId,
        mediaType,
        seasons: mediaType === MediaType.TV ? 'all' : undefined,
        tvdbId: mediaItem.tvdbId,
        is4k: false,
      },
      user,
      { isAutoRequest: true }
    );

    logger.info("Created media request from user's watchlist", {
      label: 'Watchlist Sync',
      userId: user.id,
      mediaTitle: mediaItem.title,
      from: 'Plex',
    });
  }

  /**
   * Everything on a user's Plex and Trakt watchlists, one entry per title;
   * undefined when there is nothing to go on this time.
   *
   * Either source may fail and the other still syncs: a title on both uses
   * Trakt's time, so Plex being down changes nothing for it. Trakt being
   * briefly unreachable instead holds the whole sync, since a title on both
   * would otherwise use Plex's time once and look newly added.
   */
  private async watchlistOf(
    user: User
  ): Promise<{ items: WatchItem[]; plexTvApi?: PlexTvAPI } | undefined> {
    const trakt = await this.traktWatchlist(user);
    if (trakt === 'later') {
      return undefined;
    }
    const plex = await this.plexWatchlist(user);
    if (!plex && !trakt) {
      return undefined;
    }

    const byKey = new Map<string, WatchItem>();
    for (const item of plex?.items ?? []) {
      byKey.set(keyOf(item), item);
    }
    for (const item of trakt ?? []) {
      const onPlex = byKey.get(keyOf(item));
      byKey.set(
        keyOf(item),
        onPlex
          ? {
              ...onPlex,
              tvdbId: onPlex.tvdbId ?? item.tvdbId,
              traktListedAt: item.traktListedAt,
            }
          : item
      );
    }
    return { items: [...byKey.values()], plexTvApi: plex?.api };
  }

  /** The newest titles on a user's Plex watchlist, if Plex answers. */
  private async plexWatchlist(
    user: User
  ): Promise<{ api: PlexTvAPI; items: WatchItem[] } | undefined> {
    if (!user.plexToken || !onPlex()) {
      return undefined;
    }

    if (user.plexTokenExpiredAt) {
      const last = this.expiredTriedAt.get(user.id) ?? 0;
      if (Date.now() - last < EXPIRED_RETRY_MS) {
        return undefined;
      }
      this.expiredTriedAt.set(user.id, Date.now());
    } else {
      this.expiredTriedAt.delete(user.id);
    }

    const api = new PlexTvAPI(user.plexToken);
    const response = await api.getWatchlist({ size: 20 });

    // A rejected token blocks sync until the user signs in again, so tell them
    // instead of failing quietly every few minutes.
    if (response.authFailed) {
      await markPlexTokenRejected(user);
      return undefined;
    }

    // Plex down or slow: nothing learned about the token, nothing to sync.
    // Clearing the rejected mark here would let an outage between two
    // rejections send the "sign in again" notice twice.
    if (response.failed) {
      return undefined;
    }

    await clearPlexTokenRejected(user);

    return {
      api,
      items: response.items.map((item) => ({
        tmdbId: item.tmdbId,
        tvdbId: item.tvdbId,
        type: item.type,
        title: item.title,
        plexRatingKey: item.ratingKey,
        addedAt: item.addedAt,
      })),
    };
  }

  /**
   * The newest titles on a user's public Trakt watchlist; undefined when there
   * is none, 'later' when Trakt can't be reached right now.
   */
  private async traktWatchlist(
    user: User
  ): Promise<WatchItem[] | 'later' | undefined> {
    const clientId = getSettings().trakt.clientId;
    const username = user.settings?.traktUsername;
    if (!clientId || !username) {
      return undefined;
    }
    try {
      const titles = await new TraktAPI(clientId).recentWatchlist(username);
      this.traktWarnedAt.delete(user.id);
      return titles
        .filter((title) => !!title.tmdbId)
        .map((title) => ({
          tmdbId: title.tmdbId as number,
          tvdbId: title.tvdbId,
          type: title.type,
          title: title.title,
          traktListedAt: title.listedAt,
        }));
    } catch (e) {
      const problem = e instanceof TraktError ? e.problem : 'unreachable';
      if (problem === 'unreachable' || problem === 'rateLimited') {
        return 'later';
      }
      // A private watchlist or wrong name persists until fixed: warn hourly,
      // not every sync.
      const last = this.traktWarnedAt.get(user.id) ?? 0;
      if (Date.now() - last >= EXPIRED_RETRY_MS) {
        this.traktWarnedAt.set(user.id, Date.now());
        logger.warn('Could not read a Trakt watchlist', {
          label: 'Watchlist Sync',
          userId: user.id,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
      return undefined;
    }
  }

  /**
   * Seasons of a deleted show that count as handled: whatever had aired by the
   * deletion (what got deleted), plus any season numbered below one that had,
   * since TMDB sometimes lists an old season with no date. Later seasons are
   * new and still awaited.
   */
  private airedBy(
    seasons: { season_number: number; air_date?: string | null }[],
    cutoff: Date
  ): number[] {
    const aired = seasons.filter(
      (season) =>
        !!season.air_date &&
        new Date(season.air_date).getTime() <= cutoff.getTime()
    );
    // A downloaded-then-deleted show had aired. With no dates, new seasons
    // can't be identified, so none are.
    if (!aired.length) {
      return seasons.map((season) => season.season_number);
    }
    const lastAired = Math.max(0, ...aired.map((s) => s.season_number));
    return seasons
      .filter(
        (season) =>
          aired.includes(season) ||
          (!season.air_date && season.season_number < lastAired)
      )
      .map((season) => season.season_number);
  }

  private mergeSeasons(...seasons: number[][]): number[] {
    return [...new Set(seasons.flat())];
  }

  private async saveEntry(
    user: User,
    mediaItem: WatchItem,
    mediaType: MediaType,
    watchlistedAt: number,
    seasons: number[]
  ): Promise<void> {
    const entryRepository = getRepository(WatchlistSyncEntry);

    try {
      const entry =
        (await entryRepository.findOne({
          where: {
            requestedBy: { id: user.id },
            tmdbId: mediaItem.tmdbId,
            mediaType,
          },
        })) ??
        new WatchlistSyncEntry({
          requestedBy: user,
          tmdbId: mediaItem.tmdbId,
          mediaType,
        });

      // Reuse persisted rows so re-saving doesn't hit the seasons' unique
      // constraint.
      const existingSeasons = entry.seasons ?? [];

      entry.watchlistedAt = watchlistedAt;
      entry.watchlistedFrom = sourceOf(mediaItem);
      entry.seasons = seasons.map(
        (seasonNumber) =>
          existingSeasons.find((s) => s.seasonNumber === seasonNumber) ??
          new WatchlistSyncEntrySeason({ seasonNumber })
      );

      await entryRepository.save(entry);
    } catch (e) {
      // A concurrent run may have written the same entry first.
      logger.warn('Failed to record watchlist entry', {
        label: 'Watchlist Sync',
        userId: user.id,
        mediaTitle: mediaItem.title,
        errorMessage: e.message,
      });
    }
  }
}

const watchlistSync = new WatchlistSync();

export default watchlistSync;
