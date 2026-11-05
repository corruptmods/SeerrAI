import type { JellyfinLibraryItem } from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import { getMetadataProvider } from '@server/api/metadata';
import type { PlexMetadata } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import RadarrAPI, { type RadarrMovie } from '@server/api/servarr/radarr';
import type { SonarrSeason, SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbTvDetails,
  TmdbTvScanDetails,
} from '@server/api/themoviedb/interfaces';
import {
  MediaRequestStatus,
  MediaStatus,
  VIDEO_MEDIA_TYPES,
} from '@server/constants/media';
import type {
  JellyfinFamilyKind,
  MediaServerKind,
} from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import type Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import { detectAnime } from '@server/lib/animeDecision';
import { recordMediaDeletion } from '@server/lib/mediaDeletions';
import {
  MEDIA_ID,
  MEDIA_SERVER_KINDS,
  connectedServers,
  hostnameFor,
  jellyfinAdmin,
  jellyfinFamily,
  serverName,
} from '@server/lib/mediaServers';
import { isBlocklisted } from '@server/lib/scanners/baseScanner';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In, MoreThan } from 'typeorm';

/** What one media server said about one version of a title. */
interface ServerCheck {
  server: MediaServerKind;
  exists: boolean;
  /**
   * The server answered 404 for its id: the id is stale, not just unanswered.
   */
  gone: boolean;
  /** For a show: the seasons the server has (only ever true). */
  seasonsMap?: Map<number, boolean>;
}

/** Every server's id columns on a title, for both versions. */
const serverIdColumns = () =>
  MEDIA_SERVER_KINDS.flatMap((kind) => MEDIA_ID[kind]);

class AvailabilitySync {
  public running = false;
  /**
   * A media server was removed mid-run: rerun once it finishes, since titles
   * already checked used the old server list.
   */
  private runAgain = false;
  /** Connected media servers this run asks, primary first. */
  private servers: MediaServerKind[] = [];
  private plexClient?: PlexAPI;
  private plexSeasonsCache: Record<string, PlexMetadata[] | undefined>;
  private plexEpisodeExistsCache: Record<string, boolean>;

  private jellyfinClients: Partial<Record<JellyfinFamilyKind, JellyfinAPI>> =
    {};
  /** Keyed by server and id: Jellyfin's and Emby's ids could coincide. */
  private jellyfinSeasonsCache: Record<string, JellyfinLibraryItem[]>;
  private jellyfinEpisodeExistsCache: Record<string, boolean>;

  private sonarrSeasonsCache: Record<string, SonarrSeason[]>;
  private radarrServers: RadarrSettings[];
  private sonarrServers: SonarrSettings[];
  private enable4kMovie: boolean;
  private enable4kShow: boolean;

  readonly tmdb = new TheMovieDb();

  async run() {
    // A concurrent run (Run now during a scheduled one) would reset the
    // first's caches and stop it when finishing.
    if (this.running) {
      logger.debug('Availability sync is already running.', {
        label: 'AvailabilitySync',
      });
      return;
    }
    this.running = true;
    try {
      do {
        this.runAgain = false;
        await this.syncOnce();
        // Stopped (cancelled, or a server unreachable): no rerun.
      } while (this.runAgain && this.running);
    } finally {
      this.runAgain = false;
      this.running = false;
    }
  }

  /**
   * Runs a sync now, or once more after the current one, since the media
   * servers changed under titles it already checked.
   */
  public runSoon(): Promise<void> {
    if (this.running) {
      this.runAgain = true;
      return Promise.resolve();
    }
    return this.run();
  }

  /**
   * Stops asking a server removed during the run: what it has must not keep
   * a title available.
   */
  private dropRemovedServers(): void {
    const connected = connectedServers();
    const removed = this.servers.filter(
      (server) => !connected.includes(server)
    );
    if (!removed.length) {
      return;
    }
    this.servers = this.servers.filter((server) => connected.includes(server));
    for (const server of removed) {
      if (server === 'plex') {
        this.plexClient = undefined;
      } else {
        delete this.jellyfinClients[server];
      }
    }
    logger.info(
      `No longer connected to ${removed.map(serverName).join(', ')}; the rest of this sync goes without it.`,
      { label: 'AvailabilitySync' }
    );
  }

  private async syncOnce() {
    const settings = getSettings();
    this.servers = connectedServers();
    this.plexClient = undefined;
    this.jellyfinClients = {};
    this.plexSeasonsCache = {};
    this.plexEpisodeExistsCache = {};
    this.jellyfinSeasonsCache = {};
    this.jellyfinEpisodeExistsCache = {};
    this.sonarrSeasonsCache = {};
    this.radarrServers = settings.radarr;
    this.sonarrServers = settings.sonarr;
    this.enable4kMovie = this.radarrServers.some((server) => server.is4k);
    this.enable4kShow = this.sonarrServers.some((server) => server.is4k);

    try {
      logger.info(`Starting availability sync...`, {
        label: 'AvailabilitySync',
      });
      const pageSize = 50;

      if (!this.servers.length) {
        logger.error('An admin is not configured.', {
          label: 'AvailabilitySync',
        });
        this.running = false;
        return;
      }

      // Every connected server must answer first: a title on an unreachable
      // server would look deleted.
      for (const server of this.servers) {
        if (!(await this.connect(server))) {
          this.running = false;
          return;
        }
      }

      for await (const media of this.loadAvailableMediaPaginated(pageSize)) {
        if (!this.running) {
          throw new Error('Job aborted');
        }
        this.dropRemovedServers();

        // Blocklisted stays blocklisted, files or not: marking it deleted
        // would let it be requested again.
        if (isBlocklisted(media)) {
          continue;
        }

        // Check every media server, Radarr and Sonarr; update only the
        // version (non-4K or 4K) that is missing everywhere.
        if (media.mediaType === 'movie') {
          const existsInRadarr = await this.mediaExistsInRadarr(media, false);
          const existsInRadarr4k = await this.mediaExistsInRadarr(media, true);

          for (const is4k of [false, true]) {
            const checks = await this.checkServers(media, is4k);
            const movieExists =
              (is4k ? existsInRadarr4k : existsInRadarr) ||
              checks.some((check) => check.exists);

            if (movieExists) {
              logger.debug(
                `The ${is4k ? '4K' : 'non-4K'} movie [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
                {
                  label: 'AvailabilitySync',
                }
              );
              await this.clearStaleIds(media, is4k, checks);
            } else if (
              media[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE
            ) {
              await this.mediaUpdater(media, is4k);
            }
          }
        }

        // Even when both versions exist, check per-season availability.
        if (media.mediaType === 'tv') {
          const checks = await this.checkServers(media, false);
          const checks4k = await this.checkServers(media, true);

          const { existsInSonarr, seasonsMap: sonarrSeasonsMap } =
            await this.mediaExistsInSonarr(media, false);
          const {
            existsInSonarr: existsInSonarr4k,
            seasonsMap: sonarrSeasonsMap4k,
          } = await this.mediaExistsInSonarr(media, true);

          const showExists =
            existsInSonarr || checks.some((check) => check.exists);
          const showExists4k =
            existsInSonarr4k || checks4k.some((check) => check.exists);

          if (showExists) {
            logger.debug(
              `The non-4K show [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
              {
                label: 'AvailabilitySync',
              }
            );
            await this.clearStaleIds(media, false, checks);
          }

          if (showExists4k) {
            logger.debug(
              `The 4K show [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
              {
                label: 'AvailabilitySync',
              }
            );
            await this.clearStaleIds(media, true, checks4k);
          }

          // Each season starts missing; it exists if any media server or
          // Sonarr has it.
          const filteredSeasonsMap: Map<number, boolean> = new Map();
          media.seasons
            .filter(
              (season) =>
                season.status === MediaStatus.AVAILABLE ||
                season.status === MediaStatus.PARTIALLY_AVAILABLE
            )
            .forEach((season) =>
              filteredSeasonsMap.set(season.seasonNumber, false)
            );

          const filteredSeasonsMap4k: Map<number, boolean> = new Map();
          media.seasons
            .filter(
              (season) =>
                season.status4k === MediaStatus.AVAILABLE ||
                season.status4k === MediaStatus.PARTIALLY_AVAILABLE
            )
            .forEach((season) =>
              filteredSeasonsMap4k.set(season.seasonNumber, false)
            );

          const finalSeasons: Map<number, boolean> = new Map([
            ...filteredSeasonsMap,
            ...checks.flatMap((check) => [...(check.seasonsMap ?? [])]),
            ...sonarrSeasonsMap,
          ]);
          const finalSeasons4k: Map<number, boolean> = new Map([
            ...filteredSeasonsMap4k,
            ...checks4k.flatMap((check) => [...(check.seasonsMap ?? [])]),
            ...sonarrSeasonsMap4k,
          ]);

          // Each season's episode count, from the scans' source.
          let tvShow: TmdbTvScanDetails | TmdbTvDetails | undefined;
          try {
            let found: TmdbTvScanDetails | TmdbTvDetails | undefined;
            if (media.tmdbId) {
              found = await this.tmdb.getTvShowForScan({
                tvId: Number(media.tmdbId),
              });
            } else if (media.tvdbId) {
              found = await this.tmdb.getShowByTvdbIdForScan({
                tvdbId: Number(media.tvdbId),
              });
            }

            // With TheTVDB chosen for series (Settings → Metadata), number
            // seasons as the scans do. Otherwise a TMDB-only season reads as
            // missing here and the next scan restores it, every hour.
            if (found) {
              const provider = detectAnime(found)
                ? await getMetadataProvider('anime')
                : await getMetadataProvider('tv');
              if (!(provider instanceof TheMovieDb)) {
                found = await provider.getTvShow({ tvId: found.id });
              }
            }
            tvShow = found;
          } catch (e) {
            logger.debug(
              `Failed to fetch the seasons of show [TMDB ID ${media.tmdbId}]. Skipping season enrichment.`,
              { label: 'AvailabilitySync', errorMessage: e.message }
            );
          }

          if (tvShow) {
            // Mark missing seasons false in finalSeasons and finalSeasons4k.
            media.seasons.forEach((season) => {
              // Specials don't count toward availability (baseScanner skips
              // them too).
              // TODO: respect enableSpecialEpisodes via a predicate shared with
              // baseScanner.ts.
              if (season.seasonNumber === 0) {
                return;
              }
              if (
                !finalSeasons.has(season.seasonNumber) &&
                tvShow.seasons.find(
                  (s) => s.season_number === season.seasonNumber
                )?.episode_count
              ) {
                finalSeasons.set(season.seasonNumber, false);
              }
              if (
                !finalSeasons4k.has(season.seasonNumber) &&
                tvShow.seasons.find(
                  (s) => s.season_number === season.seasonNumber
                )?.episode_count
              ) {
                finalSeasons4k.set(season.seasonNumber, false);
              }
            });
          }

          if (
            !showExists &&
            (media.status === MediaStatus.AVAILABLE ||
              media.status === MediaStatus.PARTIALLY_AVAILABLE ||
              media.seasons.some(
                (season) => season.status === MediaStatus.AVAILABLE
              ) ||
              media.seasons.some(
                (season) => season.status === MediaStatus.PARTIALLY_AVAILABLE
              ))
          ) {
            await this.mediaUpdater(media, false);
          }

          if (
            !showExists4k &&
            (media.status4k === MediaStatus.AVAILABLE ||
              media.status4k === MediaStatus.PARTIALLY_AVAILABLE ||
              media.seasons.some(
                (season) => season.status4k === MediaStatus.AVAILABLE
              ) ||
              media.seasons.some(
                (season) => season.status4k === MediaStatus.PARTIALLY_AVAILABLE
              ))
          ) {
            await this.mediaUpdater(media, true);
          }

          // TODO: run seasonUpdater for each season.

          if ([...finalSeasons.values()].includes(false)) {
            await this.seasonUpdater(media, finalSeasons, false);
          }

          if ([...finalSeasons4k.values()].includes(false)) {
            await this.seasonUpdater(media, finalSeasons4k, true);
          }
        }
      }
    } catch (ex) {
      logger.error('Failed to complete availability sync.', {
        errorMessage: ex.message,
        label: 'AvailabilitySync',
      });
    } finally {
      logger.info(`Availability sync complete.`, {
        label: 'AvailabilitySync',
      });
    }
  }

  public cancel() {
    this.running = false;
    this.runAgain = false;
  }

  /**
   * Saves the sync's changes to a title. Server ids are left out unless the
   * sync cleared them (`clearing`): the title was read at page start, and
   * writing that copy back would restore ids of a server removed since.
   */
  private async saveTitle(
    media: Media,
    clearing: ReturnType<typeof serverIdColumns> = []
  ): Promise<void> {
    const kept = serverIdColumns()
      .filter((column) => !clearing.includes(column))
      .map((column) => [column, media[column]] as const);
    // Undefined columns aren't written.
    for (const [column] of kept) {
      (media as unknown as Record<string, unknown>)[column] = undefined;
    }
    try {
      await getRepository(Media).save(media);
    } finally {
      for (const [column, value] of kept) {
        (media as unknown as Record<string, unknown>)[column] = value;
      }
    }
  }

  private async *loadAvailableMediaPaginated(pageSize: number) {
    let lastId = 0;
    const mediaRepository = getRepository(Media);
    const whereOptions = [
      { status: MediaStatus.AVAILABLE },
      { status: MediaStatus.PARTIALLY_AVAILABLE },
      { status4k: MediaStatus.AVAILABLE },
      { status4k: MediaStatus.PARTIALLY_AVAILABLE },
      { seasons: { status: MediaStatus.AVAILABLE } },
      { seasons: { status: MediaStatus.PARTIALLY_AVAILABLE } },
      { seasons: { status4k: MediaStatus.AVAILABLE } },
      { seasons: { status4k: MediaStatus.PARTIALLY_AVAILABLE } },
    ];

    let mediaPage: Media[];

    // Page by id, not offset: titles marked deleted leave the set, and an
    // offset would skip as many others.
    do {
      mediaPage = await mediaRepository.find({
        where: whereOptions.map((where) => ({
          ...where,
          mediaType: In(VIDEO_MEDIA_TYPES),
          id: MoreThan(lastId),
        })),
        order: { id: 'ASC' },
        take: pageSize,
      });
      if (mediaPage.length > 0) lastId = mediaPage[mediaPage.length - 1].id;
      yield* mediaPage;
    } while (mediaPage.length > 0);
  }

  /**
   * Sets up a server client and checks it answers; false (reason logged) if
   * not.
   */
  private async connect(server: MediaServerKind): Promise<boolean> {
    if (server === 'plex') {
      // Plex uses the owner's Plex token.
      const admin = await getRepository(User).findOne({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });
      // Without Plex, every title Radarr and Sonarr lack would look deleted.
      if (!admin?.plexToken) {
        logger.error('Plex admin is not configured.', {
          label: 'AvailabilitySync',
        });
        return false;
      }

      const client = new PlexAPI({ plexToken: admin.plexToken });
      try {
        await client.getStatus();
      } catch (e) {
        logger.error('Sync interrupted: Plex cannot be reached.', {
          label: 'AvailabilitySync',
          errorMessage: e.message,
        });
        return false;
      }
      this.plexClient = client;
      return true;
    }

    // Jellyfin and Emby use their API key, as their admin (jellyfinAdmin).
    const name = serverName(server);
    const admin = await jellyfinAdmin(server);
    if (!admin) {
      logger.error(`${name} admin is not configured.`, {
        label: 'AvailabilitySync',
      });
      return false;
    }

    const client = new JellyfinAPI(
      hostnameFor(server),
      jellyfinFamily(server).apiKey,
      admin.deviceId,
      server
    );
    client.setUserId(admin.userId);

    try {
      await client.getSystemInfo();
    } catch (e) {
      logger.error(`Sync interrupted: ${name} cannot be reached.`, {
        label: 'AvailabilitySync',
        status: e.statusCode,
        error: e.name,
        errorMessage: e.errorCode,
      });
      return false;
    }
    this.jellyfinClients[server] = client;
    return true;
  }

  /** What each connected server says about one version of a title. */
  private async checkServers(
    media: Media,
    is4k: boolean
  ): Promise<ServerCheck[]> {
    const checks: ServerCheck[] = [];
    for (const server of this.servers) {
      checks.push(
        server === 'plex'
          ? await this.mediaExistsInPlex(media, is4k)
          : await this.mediaExistsInJellyfin(server, media, is4k)
      );
    }
    return checks;
  }

  /**
   * Clears a server's id for a version it lost but another server still has,
   * so the title page offers no dead Play button. The title stays available;
   * the server's next scan restores the id if the title returns.
   */
  private async clearStaleIds(
    media: Media,
    is4k: boolean,
    checks: ServerCheck[]
  ): Promise<void> {
    const holders = checks.filter((check) => check.exists);
    if (!holders.length) {
      return;
    }
    for (const { server } of checks.filter((check) => check.gone)) {
      const column = MEDIA_ID[server][is4k ? 1 : 0];
      if (!media[column]) {
        continue;
      }
      media[column] = null;
      await getRepository(Media).update(media.id, { [column]: null });
      logger.info(
        `${serverName(server)} no longer has the ${is4k ? '4K' : 'non-4K'} ${
          media.mediaType === 'movie' ? 'movie' : 'show'
        } [TMDB ID ${media.tmdbId}]; its link there is removed. It is still on ${holders
          .map((check) => serverName(check.server))
          .join(', ')}.`,
        { label: 'AvailabilitySync' }
      );
    }
  }

  /** Connected server names, for messages. */
  private serverNames(): string {
    return this.servers.map(serverName).join(', ');
  }

  private async mediaUpdater(media: Media, is4k: boolean): Promise<void> {
    try {
      // An approved request still in flight keeps the external metadata.
      let isMediaProcessing = false;

      const requestRepository = getRepository(MediaRequest);

      const request = await requestRepository
        .createQueryBuilder('request')
        .leftJoinAndSelect('request.media', 'media')
        .where('(media.id = :id)', {
          id: media.id,
        })
        .andWhere(
          '(request.is4k = :is4k AND request.status = :requestStatus)',
          {
            requestStatus: MediaRequestStatus.APPROVED,
            is4k: is4k,
          }
        )
        .getOne();

      if (request) {
        isMediaProcessing = true;
      }

      // Mark this version deleted; clear its columns unless processing.
      media[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
      await recordMediaDeletion(media.tmdbId, media.mediaType);
      media[is4k ? 'serviceId4k' : 'serviceId'] = isMediaProcessing
        ? media[is4k ? 'serviceId4k' : 'serviceId']
        : null;
      media[is4k ? 'externalServiceId4k' : 'externalServiceId'] =
        isMediaProcessing
          ? media[is4k ? 'externalServiceId4k' : 'externalServiceId']
          : null;
      media[is4k ? 'externalServiceSlug4k' : 'externalServiceSlug'] =
        isMediaProcessing
          ? media[is4k ? 'externalServiceSlug4k' : 'externalServiceSlug']
          : null;
      // Gone from every server: clear all their ids.
      const clearing = isMediaProcessing
        ? []
        : MEDIA_SERVER_KINDS.map((kind) => MEDIA_ID[kind][is4k ? 1 : 0]);
      for (const column of clearing) {
        media[column] = null;
      }
      logger.debug(
        `The ${is4k ? '4K' : 'non-4K'} ${
          media.mediaType === 'movie' ? 'movie' : 'show'
        } [TMDB ID ${media.tmdbId}] was not found in any ${
          media.mediaType === 'movie' ? 'Radarr' : 'Sonarr'
        } instance or on ${this.serverNames()}. Status will be changed to deleted.`,
        { label: 'AvailabilitySync' }
      );

      await this.saveTitle(media, clearing);
    } catch (ex) {
      logger.debug(
        `Failure updating the ${is4k ? '4K' : 'non-4K'} ${
          media.mediaType === 'tv' ? 'show' : 'movie'
        } [TMDB ID ${media.tmdbId}].`,
        {
          errorMessage: ex.message,
          label: 'AvailabilitySync',
        }
      );
    }
  }

  private async seasonUpdater(
    media: Media,
    seasons: Map<number, boolean>,
    is4k: boolean
  ): Promise<void> {
    // Seasons that no longer exist.
    const seasonsPendingRemoval = new Map(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      [...seasons].filter(([_, exists]) => !exists)
    );
    const seasonKeys = [...seasonsPendingRemoval.keys()];
    // Specials can still be marked DELETED below, but don't demote the show.
    const nonSpecialSeasonKeys = seasonKeys.filter((key) => key !== 0);

    try {
      for (const mediaSeason of media.seasons) {
        if (
          seasonsPendingRemoval.has(mediaSeason.seasonNumber) &&
          (mediaSeason[is4k ? 'status4k' : 'status'] ===
            MediaStatus.AVAILABLE ||
            mediaSeason[is4k ? 'status4k' : 'status'] ===
              MediaStatus.PARTIALLY_AVAILABLE)
        ) {
          mediaSeason[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
        }
      }

      if (
        nonSpecialSeasonKeys.length > 0 &&
        media[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE
      ) {
        media[is4k ? 'status4k' : 'status'] = MediaStatus.PARTIALLY_AVAILABLE;
        logger.debug(
          `Marking the ${
            is4k ? '4K' : 'non-4K'
          } show [TMDB ID ${media.tmdbId}] as PARTIALLY_AVAILABLE because season(s) [${nonSpecialSeasonKeys}] was not found in any ${
            media.mediaType === 'tv' ? 'Sonarr' : 'Radarr'
          } instance or on ${this.serverNames()}.`,
          { label: 'AvailabilitySync' }
        );
      }

      media.lastSeasonChange = new Date();
      await this.saveTitle(media);
    } catch (ex) {
      logger.debug(
        `Failure updating the ${
          is4k ? '4K' : 'non-4K'
        } season(s) [${seasonKeys}], TMDB ID ${media.tmdbId}.`,
        {
          errorMessage: ex.message,
          label: 'AvailabilitySync',
        }
      );
    }
  }

  private async mediaExistsInRadarr(
    media: Media,
    is4k: boolean
  ): Promise<boolean> {
    let existsInRadarr = false;

    const hasSameServerInBothModes = this.radarrServers.some((a) =>
      this.radarrServers.some(
        (b) =>
          a.is4k !== b.is4k && a.hostname === b.hostname && a.port === b.port
      )
    );

    // The movie exists if any Radarr server of this version has it.
    for (const server of this.radarrServers.filter(
      (server) => server.is4k === is4k
    )) {
      const radarrAPI = new RadarrAPI({
        apiKey: server.apiKey,
        url: RadarrAPI.buildUrl(server, '/api/v3'),
      });

      try {
        let radarr: RadarrMovie | undefined;

        if (media.externalServiceId && !is4k) {
          radarr = await radarrAPI.getMovie({
            id: media.externalServiceId,
          });
        }

        if (media.externalServiceId4k && is4k) {
          radarr = await radarrAPI.getMovie({
            id: media.externalServiceId4k,
          });
        }

        if (radarr && radarr.tmdbId !== media.tmdbId) {
          continue;
        }

        if (radarr && radarr.hasFile) {
          const resolution =
            radarr?.movieFile?.mediaInfo?.resolution?.split('x');
          const is4kMovie =
            resolution?.length === 2 && Number(resolution[0]) >= 2000;

          if (hasSameServerInBothModes && resolution?.length === 2) {
            // One server for both: tell versions apart by resolution.
            existsInRadarr = is4k ? is4kMovie : !is4kMovie;
          } else {
            // Dedicated server with a file: it counts.
            existsInRadarr = true;
          }
        }
      } catch (ex) {
        if (!ex.message.includes('404')) {
          existsInRadarr = true;
          logger.debug(
            `Failure retrieving the ${is4k ? '4K' : 'non-4K'} movie [TMDB ID ${
              media.tmdbId
            }] from Radarr.`,
            {
              errorMessage: ex.message,
              label: 'AvailabilitySync',
            }
          );
        }
      }

      if (existsInRadarr) break;
    }

    return existsInRadarr;
  }

  private async mediaExistsInSonarr(
    media: Media,
    is4k: boolean
  ): Promise<{ existsInSonarr: boolean; seasonsMap: Map<number, boolean> }> {
    let existsInSonarr = false;
    let preventSeasonSearch = false;

    // The series exists if any Sonarr server of this version has it.
    for (const server of this.sonarrServers.filter((server) => {
      return server.is4k === is4k;
    })) {
      const sonarrAPI = new SonarrAPI({
        apiKey: server.apiKey,
        url: SonarrAPI.buildUrl(server, '/api/v3'),
      });

      try {
        let sonarr: SonarrSeries | undefined;

        if (media.externalServiceId && !is4k) {
          sonarr = await sonarrAPI.getSeriesById(media.externalServiceId);
        }

        if (media.externalServiceId4k && is4k) {
          sonarr = await sonarrAPI.getSeriesById(media.externalServiceId4k);
        }

        if (sonarr && media.tvdbId != null && sonarr.tvdbId !== media.tvdbId) {
          continue;
        }

        if (sonarr) {
          const externalServiceId = is4k
            ? media.externalServiceId4k
            : media.externalServiceId;
          this.sonarrSeasonsCache[`${server.id}-${externalServiceId}`] =
            sonarr.seasons;

          if (sonarr.statistics.episodeFileCount > 0) {
            existsInSonarr = true;
          }
        }
      } catch (ex) {
        if (!ex.message.includes('404')) {
          existsInSonarr = true;
          preventSeasonSearch = true;
          logger.debug(
            `Failure retrieving the ${is4k ? '4K' : 'non-4K'} show [TMDB ID ${
              media.tmdbId
            }] from Sonarr.`,
            {
              errorMessage: ex.message,
              label: 'AvailabilitySync',
            }
          );
        }
      }
    }

    // A non-404 API error prevents the season check.
    const seasonsMap: Map<number, boolean> = new Map();

    if (!preventSeasonSearch) {
      const filteredSeasons = media.seasons.filter(
        (season) =>
          season[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE ||
          season[is4k ? 'status4k' : 'status'] ===
            MediaStatus.PARTIALLY_AVAILABLE
      );

      for (const season of filteredSeasons) {
        const seasonExists = await this.seasonExistsInSonarr(
          media,
          season,
          is4k
        );

        if (seasonExists) {
          seasonsMap.set(season.seasonNumber, true);
        }
      }
    }

    return { existsInSonarr, seasonsMap };
  }

  private async seasonExistsInSonarr(
    media: Media,
    season: Season,
    is4k: boolean
  ): Promise<boolean> {
    let seasonExists = false;

    // Found on any Sonarr instance: exists, so no removal. Uses the cache
    // built by mediaExistsInSonarr.
    for (const server of this.sonarrServers.filter(
      (server) => server.is4k === is4k
    )) {
      let sonarrSeasons: SonarrSeason[] | undefined;

      if (media.externalServiceId && !is4k) {
        sonarrSeasons =
          this.sonarrSeasonsCache[`${server.id}-${media.externalServiceId}`];
      }

      if (media.externalServiceId4k && is4k) {
        sonarrSeasons =
          this.sonarrSeasonsCache[`${server.id}-${media.externalServiceId4k}`];
      }

      const seasonIsAvailable = sonarrSeasons?.find(
        ({ seasonNumber, statistics }) =>
          season.seasonNumber === seasonNumber &&
          statistics?.episodeFileCount &&
          statistics?.episodeFileCount > 0
      );

      if (seasonIsAvailable && sonarrSeasons) {
        seasonExists = true;
      }
    }

    return seasonExists;
  }

  private async mediaExistsInPlex(
    media: Media,
    is4k: boolean
  ): Promise<ServerCheck> {
    const ratingKey = media.ratingKey;
    const ratingKey4k = media.ratingKey4k;
    let existsInPlex = false;
    let gone = false;
    let preventSeasonSearch = false;

    // Found on Plex: exists, so no removal. Uses the cache built by
    // mediaExistsInPlex.
    try {
      let plexMedia: PlexMetadata | undefined;

      if (ratingKey && !is4k) {
        plexMedia = await this.plexClient?.getMetadata(ratingKey);

        if (media.mediaType === 'tv') {
          this.plexSeasonsCache[ratingKey] =
            await this.plexClient?.getChildrenMetadata(ratingKey);
        }

        if (
          plexMedia &&
          media.mediaType === 'movie' &&
          this.enable4kMovie &&
          plexMedia.Media?.length &&
          !plexMedia.Media.some((mediaItem) => (mediaItem.width ?? 0) < 2000)
        ) {
          plexMedia = undefined;
        }
      }

      if (ratingKey4k && is4k) {
        plexMedia = await this.plexClient?.getMetadata(ratingKey4k);

        if (media.mediaType === 'tv') {
          this.plexSeasonsCache[ratingKey4k] =
            await this.plexClient?.getChildrenMetadata(ratingKey4k);
        }

        if (plexMedia) {
          if (
            plexMedia &&
            media.mediaType === 'movie' &&
            plexMedia.Media?.length &&
            !plexMedia.Media.some((mediaItem) => (mediaItem.width ?? 0) >= 2000)
          ) {
            plexMedia = undefined;
          }

          if (plexMedia && media.mediaType === 'tv') {
            const cachedSeasons = this.plexSeasonsCache[ratingKey4k];
            if (cachedSeasons?.length) {
              let has4kInAnySeason = false;
              let verifiedAnySeason = false;
              for (const season of cachedSeasons) {
                try {
                  const episodes = await this.plexClient?.getChildrenMetadata(
                    season.ratingKey
                  );
                  if (episodes?.some((episode) => episode.Media?.length)) {
                    verifiedAnySeason = true;
                  }
                  const has4kEpisode = episodes?.some((episode) =>
                    episode.Media?.some(
                      (mediaItem) => (mediaItem.width ?? 0) >= 2000
                    )
                  );
                  if (has4kEpisode) {
                    has4kInAnySeason = true;
                    break;
                  }
                } catch {
                  // Can't fetch this season's episodes: check the others.
                }
              }
              if (verifiedAnySeason && !has4kInAnySeason) {
                plexMedia = undefined;
              }
            }
          }
        }
      }

      if (plexMedia) {
        existsInPlex = true;
      }
    } catch (ex) {
      if (ex.message.includes('404')) {
        gone = !!(is4k ? ratingKey4k : ratingKey);
      } else {
        existsInPlex = true;
        preventSeasonSearch = true;
        logger.debug(
          `Failure retrieving the ${is4k ? '4K' : 'non-4K'} ${
            media.mediaType === 'tv' ? 'show' : 'movie'
          } [TMDB ID ${media.tmdbId}] from Plex.`,
          {
            errorMessage: ex.message,
            label: 'AvailabilitySync',
          }
        );
      }
    }

    // Per-season availability in Plex.
    if (media.mediaType === 'tv') {
      const seasonsMap: Map<number, boolean> = new Map();
      const filteredSeasons = media.seasons.filter(
        (season) =>
          season[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE ||
          season[is4k ? 'status4k' : 'status'] ===
            MediaStatus.PARTIALLY_AVAILABLE
      );

      // Plex couldn't answer for the show (non-404 error): keep seasons as
      // they are. Otherwise every season reads as gone, and those Sonarr has
      // no files for would be marked deleted.
      if (preventSeasonSearch) {
        for (const season of filteredSeasons) {
          seasonsMap.set(season.seasonNumber, true);
        }
      } else {
        for (const season of filteredSeasons) {
          const seasonExists = await this.seasonExistsInPlex(
            media,
            season,
            is4k
          );

          if (seasonExists) {
            seasonsMap.set(season.seasonNumber, true);
          }
        }
      }

      return { server: 'plex', exists: existsInPlex, gone, seasonsMap };
    }

    return { server: 'plex', exists: existsInPlex, gone };
  }

  private async seasonExistsInPlex(
    media: Media,
    season: Season,
    is4k: boolean
  ): Promise<boolean> {
    const ratingKey = media.ratingKey;
    const ratingKey4k = media.ratingKey4k;
    let seasonExistsInPlex = false;

    let plexSeasons: PlexMetadata[] | undefined;

    if (ratingKey && !is4k) {
      plexSeasons = this.plexSeasonsCache[ratingKey];
    }

    if (ratingKey4k && is4k) {
      plexSeasons = this.plexSeasonsCache[ratingKey4k];
    }

    const seasonMeta = plexSeasons?.find(
      (plexSeason) => plexSeason.index === season.seasonNumber
    );

    if (seasonMeta) {
      const cacheKey = `${is4k ? '4k' : 'std'}-${seasonMeta.ratingKey}`;

      if (cacheKey in this.plexEpisodeExistsCache) {
        seasonExistsInPlex = this.plexEpisodeExistsCache[cacheKey];
      } else {
        try {
          // Plex can keep empty season entries; verify episode files exist.
          const episodes = await this.plexClient?.getChildrenMetadata(
            seasonMeta.ratingKey
          );

          const episodeVersions =
            episodes?.flatMap((episode) => episode.Media ?? []) ?? [];

          if (is4k) {
            seasonExistsInPlex = episodeVersions.some(
              (mediaItem) => (mediaItem.width ?? 0) >= 2000
            );
          } else if (this.enable4kShow) {
            seasonExistsInPlex = episodeVersions.some(
              (mediaItem) => (mediaItem.width ?? 0) < 2000
            );
          } else {
            seasonExistsInPlex = episodeVersions.length > 0;
          }
        } catch {
          // Can't fetch episodes: assume it exists to avoid false removal.
          seasonExistsInPlex = true;
        }

        this.plexEpisodeExistsCache[cacheKey] = seasonExistsInPlex;
      }
    }

    return seasonExistsInPlex;
  }

  private async mediaExistsInJellyfin(
    server: JellyfinFamilyKind,
    media: Media,
    is4k: boolean
  ): Promise<ServerCheck> {
    const [idColumn, idColumn4k] = MEDIA_ID[server];
    const ratingKey = media[idColumn];
    const ratingKey4k = media[idColumn4k];
    const client = this.jellyfinClients[server];
    const name = serverName(server);
    let existsInJellyfin = false;
    let gone = false;
    let preventSeasonSearch = false;

    // Found on Jellyfin: exists, so no removal. Uses the cache built by
    // mediaExistsInJellyfin.
    try {
      let jellyfinMedia: JellyfinLibraryItem | undefined;

      const id = is4k ? ratingKey4k : ratingKey;

      if (id && client) {
        jellyfinMedia = await client.getItemData(id);
        // Answered without the item: the id is stale.
        gone = jellyfinMedia === undefined;

        if (media.mediaType === 'tv' && jellyfinMedia !== undefined) {
          this.jellyfinSeasonsCache[`${server}:${id}`] =
            await client.getSeasons(id);
        }
      }

      if (jellyfinMedia) {
        existsInJellyfin = true;
      }
    } catch (ex) {
      if (ex.message.includes('404') || ex.message.includes('500')) {
        gone = !!(is4k ? ratingKey4k : ratingKey);
      } else {
        existsInJellyfin = true;
        preventSeasonSearch = true;
        logger.debug(
          `Failure retrieving the ${is4k ? '4K' : 'non-4K'} ${
            media.mediaType === 'tv' ? 'show' : 'movie'
          } [TMDB ID ${media.tmdbId}] from ${name}.`,
          {
            errorMessage: ex.message,
            label: 'AvailabilitySync',
          }
        );
      }
    }

    // Per-season availability in Jellyfin.
    if (media.mediaType === 'tv') {
      const seasonsMap: Map<number, boolean> = new Map();
      const filteredSeasons = media.seasons.filter(
        (season) =>
          season[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE ||
          season[is4k ? 'status4k' : 'status'] ===
            MediaStatus.PARTIALLY_AVAILABLE
      );

      // Jellyfin couldn't answer for the show (non-404 error): keep seasons
      // as they are. Otherwise every season reads as gone, and those Sonarr
      // has no files for would be marked deleted.
      if (preventSeasonSearch) {
        for (const season of filteredSeasons) {
          seasonsMap.set(season.seasonNumber, true);
        }
      } else {
        for (const season of filteredSeasons) {
          const seasonExists = await this.seasonExistsInJellyfin(
            server,
            media,
            season,
            is4k
          );

          if (seasonExists) {
            seasonsMap.set(season.seasonNumber, true);
          }
        }
      }

      return { server, exists: existsInJellyfin, gone, seasonsMap };
    }

    return { server, exists: existsInJellyfin, gone };
  }

  private async seasonExistsInJellyfin(
    server: JellyfinFamilyKind,
    media: Media,
    season: Season,
    is4k: boolean
  ): Promise<boolean> {
    const [idColumn, idColumn4k] = MEDIA_ID[server];
    const ratingKey = media[idColumn];
    const ratingKey4k = media[idColumn4k];
    let seasonExistsInJellyfin = false;

    let jellyfinSeasons: JellyfinLibraryItem[] | undefined;

    if (ratingKey && !is4k) {
      jellyfinSeasons = this.jellyfinSeasonsCache[`${server}:${ratingKey}`];
    }

    if (ratingKey4k && is4k) {
      jellyfinSeasons = this.jellyfinSeasonsCache[`${server}:${ratingKey4k}`];
    }

    const seasonMeta = jellyfinSeasons?.find(
      (jellyfinSeason) => jellyfinSeason.IndexNumber === season.seasonNumber
    );

    if (seasonMeta) {
      const seriesId = is4k ? ratingKey4k : ratingKey;

      if (seriesId) {
        const cacheKey = `${server}:${seriesId}-${seasonMeta.Id}`;

        if (cacheKey in this.jellyfinEpisodeExistsCache) {
          seasonExistsInJellyfin = this.jellyfinEpisodeExistsCache[cacheKey];
        } else {
          try {
            // Jellyfin keeps season entries after all episodes are deleted;
            // verify files exist. getEpisodes already drops virtual episodes.
            const episodes = await this.jellyfinClients[server]?.getEpisodes(
              seriesId,
              seasonMeta.Id
            );

            seasonExistsInJellyfin = !!episodes?.length;
          } catch {
            // Can't fetch episodes: assume it exists to avoid false removal.
            seasonExistsInJellyfin = true;
          }

          this.jellyfinEpisodeExistsCache[cacheKey] = seasonExistsInJellyfin;
        }
      }
    }

    return seasonExistsInJellyfin;
  }
}

const availabilitySync = new AvailabilitySync();

export default availabilitySync;
