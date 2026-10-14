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
 * Plex records when a title was put on a watchlist. Sync keeps that time per
 * user and title, so an entry it has already acted on is left alone however
 * often the title is later deleted — and taking a title off the watchlist and
 * adding it back gives a new time, which is a new entry and is requested
 * again. For a series, the seasons already handled are kept too, so a new
 * season still comes through for a show that was deleted.
 *
 * Taken from seerr-team/seerr's feat/watchlist-entry-tracking, which fixes
 * #3222.
 */

/** A request made just before Plex's timestamp still counts as acting on it. */
const CLOCK_SKEW_SECONDS = 300;

/**
 * A title on someone's watchlist: their Plex watchlist, their public Trakt
 * watchlist, or both.
 */
export interface WatchItem {
  tmdbId: number;
  tvdbId?: number;
  type: 'movie' | 'show';
  title: string;
  /** Plex's id for it, to ask Plex when it was added. */
  plexRatingKey?: string;
  /** When Plex says it was added, if it said (see syncWithoutTimestamp). */
  addedAt?: Date;
  /** When it went on the Trakt watchlist, in seconds since 1970. */
  traktListedAt?: number;
}

const mediaTypeOf = (item: WatchItem) =>
  item.type === 'show' ? MediaType.TV : MediaType.MOVIE;

const keyOf = (item: WatchItem) => `${mediaTypeOf(item)}:${item.tmdbId}`;

/** Which watchlist a title's time comes from: Trakt's, when it is on it. */
const sourceOf = (item: WatchItem): WatchlistSource =>
  item.traktListedAt !== undefined ? 'trakt' : 'plex';

/**
 * Plex watchlists are read only while Seerr is connected to Plex: someone
 * who signed in with Plex once is not synced from Plex on a server that
 * only has Jellyfin or Emby.
 */
const onPlex = () => isConnected('plex') || !primaryServer();

/**
 * How often a user whose Plex sign-in has expired is tried again. They have
 * been told to sign in again (and the Health page lists them), so asking
 * Plex every few minutes only fills the log; once an hour still notices a
 * rejection that was Plex's own passing fault.
 */
export const EXPIRED_RETRY_MS = 60 * 60 * 1000;

class WatchlistSync {
  public running = false;
  /** When each user with an expired sign-in was last tried. */
  private expiredTriedAt = new Map<number, number>();
  /** When each user whose Trakt watchlist cannot be read was last told of. */
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

      // People with a Plex sign-in (on a Plex server), or a Trakt watchlist
      // to read.
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

      // One user's failure must not cost everyone after them their sync.
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
   * Whether the user has auto-requests and watchlist sync on for this kind
   * of title.
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
      // Skip sync if user settings have it disabled
      return;
    }

    const watchlist = await this.watchlistOf(user);
    if (!watchlist) {
      return;
    }
    const { plexTvApi } = watchlist;
    const response = watchlist;

    // Strict: a database it cannot read must stop the sync, not read as
    // "nothing here yet" and request the whole watchlist again.
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

    // A deleted title is not settled by its old request: whether it comes
    // back is for the entry to decide, below.
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
     * A title with no entry yet — every title, on the first sync after entries
     * began to be tracked — is settled by whether it was deleted, and when.
     * The fork's deletion records give the time. A title Seerr has marked
     * deleted with no record was deleted before those began: its row's last
     * update is the best time there is, and can only be at or after the
     * deletion, so it errs towards leaving the title alone. Re-downloading
     * something the owner deleted is the worse mistake; someone who does want
     * it back takes it off their watchlist and adds it again, a new entry.
     */
    const deletionTimes = await getDeletionTimes(unavailableTmdbIds);
    const markedDeleted = new Map<string, Date>(
      mediaItems
        .filter((m) => m.status === MediaStatus.DELETED)
        .map((m) => [`${m.mediaType}:${m.tmdbId}`, m.updatedAt])
    );

    const tmdb = new TheMovieDb();

    // When each title went on the watchlist, looked up five at a time
    // rather than one after another: Plex sometimes takes its full timeout
    // per title, and one slow user held up everyone synced after them.
    // A title on the Trakt watchlist goes by Trakt's time, which is always
    // there and stays put whatever Plex does; only a Plex-only title asks
    // Plex.
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
        // Sonarr finds a series by its TVDB id; without one the request
        // could not go anywhere.
        if (mediaItem.type === 'show' && !mediaItem.tvdbId) {
          throw new Error('Missing TVDB ID from the watchlist');
        }

        // Check if they have auto-request permissons and watchlist sync
        // enabled for the media type
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

        // Times from the two watchlists never match, so a title whose time
        // now comes from the other one (Trakt could not be read this time, or
        // a Trakt username was just added) is the same entry, not a re-add:
        // its new time is noted and nothing is requested again for it.
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
          // An auto-request made after the watchlist add means sync already
          // acted on this entry.
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

          // Deleted after it went on the watchlist, or at a time not
          // recorded: this entry is the stale one a cleanup was meant to be
          // rid of, not a request for it again.
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

        // Mirrors how 'all' expands in MediaRequest.request, which always
        // drops season 0.
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
          // Nothing new was requested but the entry has still been acted on,
          // so record it.
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
          // During watchlist sync, these errors aren't necessarily a problem
          // with Seerr — the user may simply be at their quota. Leave the
          // entry untracked so a later sync can retry.
          case RequestPermissionError:
          case QuotaRestrictedError:
            logger.debug('Failed to create media request from watchlist', {
              label: 'Watchlist Sync',
              userId: user.id,
              mediaTitle: mediaItem.title,
              errorMessage: e.message,
            });
            break;
          // Blocklisted media should be silently ignored during watchlist
          // sync to avoid spam
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
   * Plex did not say when this title went on the watchlist, so a re-add
   * cannot be told from the entry already acted on. Falls back to how this
   * fork decided before entries were tracked, and records nothing: an entry
   * needs the time to be of any use.
   *
   * Re-downloading something the owner deleted is the worse mistake, so a
   * title with an entry, or deleted since it was added, is left alone.
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
   * Everything on someone's watchlists, Plex's and Trakt's, one entry per
   * title. Undefined when there is nothing to go on this time.
   *
   * Either source may fail on its own and the other still syncs: a title on
   * both goes by Trakt's time, so Plex being down changes nothing for it.
   * Trakt being briefly unreachable holds the whole sync until next time
   * instead, as a title on both would otherwise go by Plex's time once and
   * look newly added.
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

  /** The newest titles on someone's Plex watchlist, if Plex answers. */
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

    // A rejected token means nothing here will sync until the user signs in
    // again, so tell them rather than failing quietly every few minutes.
    if (response.authFailed) {
      await markPlexTokenRejected(user);
      return undefined;
    }

    // Plex down or slow: nothing learnt about the token, and nothing to
    // sync. Clearing the rejected mark here would let an outage between two
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
   * The newest titles on someone's public Trakt watchlist; undefined when
   * they have none to read, 'later' when Trakt could not be asked just now.
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
      // A private watchlist or a wrong name stays so until someone fixes
      // it: said once an hour, not on every sync.
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
   * The seasons of a deleted show that count as already handled: whatever
   * had aired by the deletion — which is what got deleted — and any season
   * numbered below one that had, since TMDB occasionally lists an old season
   * with no date. Anything after is new, and is what the requester is still
   * waiting for.
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
    // A show that was downloaded and deleted had aired. With no dates to go
    // on, which of its seasons are new cannot be told, so none are.
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

      // Reuse the persisted rows so re-saving an entry does not collide with
      // the unique constraint on its seasons.
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
      // A concurrent run may have written the same entry first
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
