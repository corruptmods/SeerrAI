import animeList from '@server/api/animelist';
import type {
  JellyfinLibraryItem,
  JellyfinLibraryItemExtended,
  JellyfinMediaSource,
} from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import { getMetadataProvider } from '@server/api/metadata';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbTvDetails,
  TmdbTvScanDetails,
} from '@server/api/themoviedb/interfaces';
import type { JellyfinFamilyKind } from '@server/constants/server';
import { detectAnime } from '@server/lib/animeDecision';
import type { SeenQuality } from '@server/lib/mediaQuality';
import {
  combineQuality,
  jellyfinSourceQuality,
} from '@server/lib/mediaQuality';
import {
  hostnameFor,
  isConnected,
  jellyfinAdmin,
  jellyfinFamily,
  serverName,
} from '@server/lib/mediaServers';
import type {
  ProcessableSeason,
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import { LibraryItems } from '@server/lib/scanners/libraryItems';
import type { ItemLabel } from '@server/lib/scanners/unidentified';
import {
  NotIdentifiedError,
  UnidentifiedTitles,
  nameOf,
} from '@server/lib/scanners/unidentified';
import type { Library } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { uniqWith } from 'lodash';

/**
 * Whether the server hasn't probed an item's file yet: Jellyfin and Emby
 * list a file before probing it, so it has no media sources or no video
 * stream. Such an item counts as standard quality; if it turns out to be
 * 4K, the next scan adds 4K too without revoking the standard status.
 */
const resolutionUnknown = (item: {
  MediaSources?: JellyfinMediaSource[];
}): boolean =>
  !item.MediaSources?.some((MediaSource) =>
    MediaSource.MediaStreams?.some(
      (MediaStream) => MediaStream.Type === 'Video'
    )
  );

/** Whether a version is 4K by Seerr's rule: wider than 2000 pixels. */
const is4kSource = (source: JellyfinMediaSource): boolean =>
  source.MediaStreams?.some(
    (stream) => stream.Type === 'Video' && (stream.Width ?? 0) > 2000
  ) ?? false;

/** What an item's versions are in, on the side they count for. */
const qualityOfSources = (
  sources: JellyfinMediaSource[] | undefined,
  is4k: boolean,
  split4k: boolean
): SeenQuality | undefined =>
  combineQuality(
    (sources ?? [])
      .filter((source) => !split4k || is4kSource(source) === is4k)
      .map(jellyfinSourceQuality)
  );

/** Episodes a file covers (IndexNumber..IndexNumberEnd for multi-episode). */
const episodeCountOf = (episode: {
  IndexNumber?: number;
  IndexNumberEnd?: number;
}): number =>
  episode.IndexNumber !== undefined && episode.IndexNumberEnd !== undefined
    ? episode.IndexNumberEnd - episode.IndexNumber + 1
    : 1;

/**
 * An item as the log names it; never the server's whole record. An episode
 * or season (from a recently added scan) is named by its series, whose id
 * the scan uses.
 */
const labelOf = (item: JellyfinLibraryItem): ItemLabel =>
  item.SeriesName && (item.Type === 'Episode' || item.Type === 'Season')
    ? { name: item.SeriesName, type: 'Series', id: item.SeriesId ?? item.Id }
    : {
        name: item.Name,
        ...(item.ProductionYear ? { year: item.ProductionYear } : {}),
        type: item.Type,
        id: item.Id,
      };

/** Whether the server has given the title any matchable id. */
const hasAnyId = (ids: JellyfinLibraryItemExtended['ProviderIds']): boolean =>
  !!(ids.Tmdb || ids.TheMovieDb || ids.Imdb || ids.Tvdb || ids.AniDB);

interface JellyfinSyncStatus extends StatusBase {
  currentLibrary: Library;
  libraries: Library[];
}

class JellyfinScanner
  extends BaseScanner<JellyfinLibraryItem>
  implements RunnableScanner<JellyfinSyncStatus>
{
  private jfClient: JellyfinAPI;
  private libraries: Library[];
  private currentLibrary: Library;
  private isRecentOnly = false;
  private processedAnidbSeason: Map<number, Map<number, number>>;
  /** The server this scanner reads: Jellyfin or Emby. */
  public readonly kind: JellyfinFamilyKind;
  /** Titles this scan skipped because the server hasn't identified them. */
  private unidentified: UnidentifiedTitles;
  /** Titles in the current library that failed for a real reason. */
  private failures = 0;

  constructor({
    isRecentOnly,
    kind = 'jellyfin',
  }: { isRecentOnly?: boolean; kind?: JellyfinFamilyKind } = {}) {
    super(`${serverName(kind)} Sync`);
    this.isRecentOnly = isRecentOnly ?? false;
    this.kind = kind;
    this.libraryItems = new LibraryItems(kind);
    this.unidentified = new UnidentifiedTitles({
      server: serverName(kind),
      verb: 'identified',
      hint: "refresh the library's metadata, or use Identify on a title",
    });
  }

  /** Logs and counts a title the server hasn't identified yet; not an error. */
  private skipUnidentified(e: NotIdentifiedError) {
    this.log(this.unidentified.add(e.kind, e.item), 'debug', {
      item: e.item,
    });
  }

  /** Logs one line naming a title that failed for a real reason. */
  private failed(item: JellyfinLibraryItem, e: Error) {
    this.failures += 1;
    const label = labelOf(item);
    this.log(
      `Failed to process ${serverName(this.kind)} item ${nameOf(label)}`,
      'error',
      { errorMessage: e.message, item: label }
    );
  }

  private async extractMovieIds(jellyfinitem: JellyfinLibraryItem): Promise<{
    tmdbId: number;
    imdbId?: string;
    metadata: JellyfinLibraryItemExtended;
  } | null> {
    let metadata = await this.jfClient.getItemData(jellyfinitem.Id);

    if (!metadata?.Id) {
      this.log('No Id metadata for this title. Skipping', 'debug', {
        item: labelOf(jellyfinitem),
      });
      return null;
    }

    const anidbId = Number(metadata.ProviderIds.AniDB ?? null);
    let tmdbId = Number(
      metadata.ProviderIds.Tmdb || metadata.ProviderIds.TheMovieDb || null
    );
    let imdbId = metadata.ProviderIds.Imdb;

    // Use AniDB only when it's the sole id.
    if (anidbId && !imdbId && !tmdbId) {
      const result = animeList.getFromAnidbId(anidbId);
      tmdbId = Number(result?.tmdbId ?? null);
      imdbId = result?.imdbId;
    }

    if (imdbId && !tmdbId) {
      tmdbId = await this.tmdb.resolveImdbIdForScan({
        imdbId: imdbId,
      });
    }

    if (!tmdbId) {
      // No id at all means not identified yet, which is normal for new
      // files. An AniDB id missing from the anime list is a real gap and
      // stays an error.
      if (!hasAnyId(metadata.ProviderIds)) {
        throw new NotIdentifiedError('film', labelOf(metadata));
      }
      throw new Error('Unable to find TMDb ID');
    }

    // AniDB libraries can mix movies into a "show" library. The first
    // episode of the first season is the movie; use it for details such as
    // the MediaSource.
    if (anidbId && metadata.Type === 'Series') {
      const season = (await this.jfClient.getSeasons(jellyfinitem.Id)).find(
        (md) => {
          return md.IndexNumber === 1;
        }
      );
      if (!season) {
        this.log('No season found for anidb movie', 'debug', {
          item: labelOf(jellyfinitem),
        });
        return null;
      }
      const episodes = await this.jfClient.getEpisodes(
        jellyfinitem.Id,
        season.Id
      );
      if (!episodes[0]) {
        this.log('No episode found for anidb movie', 'debug', {
          item: labelOf(jellyfinitem),
        });
        return null;
      }
      metadata = await this.jfClient.getItemData(episodes[0].Id);
      if (!metadata) {
        this.log('No metadata found for anidb movie', 'debug', {
          item: labelOf(jellyfinitem),
        });
        return null;
      }
    }

    return { tmdbId, imdbId, metadata };
  }

  private async processJellyfinMovie(jellyfinitem: JellyfinLibraryItem) {
    try {
      const extracted = await this.extractMovieIds(jellyfinitem);
      if (!extracted) return;

      const { tmdbId, imdbId, metadata } = extracted;

      const has4k = metadata.MediaSources?.some((MediaSource) => {
        return MediaSource.MediaStreams.filter(
          (MediaStream) => MediaStream.Type === 'Video'
        ).some((MediaStream) => {
          return (MediaStream.Width ?? 0) > 2000;
        });
      });

      const hasOtherResolution = metadata.MediaSources?.some((MediaSource) => {
        return MediaSource.MediaStreams.filter(
          (MediaStream) => MediaStream.Type === 'Video'
        ).some((MediaStream) => {
          return (MediaStream.Width ?? 0) <= 2000;
        });
      });

      const mediaAddedAt = metadata.DateCreated
        ? new Date(metadata.DateCreated)
        : undefined;

      if (
        hasOtherResolution ||
        resolutionUnknown(metadata) ||
        (!this.enable4kMovie && has4k)
      ) {
        await this.processMovie(tmdbId, {
          is4k: false,
          mediaAddedAt,
          mediaServer: this.kind,
          itemId: metadata.Id,
          imdbId,
          title: metadata.Name,
          quality: qualityOfSources(
            metadata.MediaSources,
            false,
            this.enable4kMovie
          ),
        });
      }

      if (has4k && this.enable4kMovie) {
        await this.processMovie(tmdbId, {
          is4k: true,
          mediaAddedAt,
          mediaServer: this.kind,
          itemId: metadata.Id,
          imdbId,
          title: metadata.Name,
          quality: qualityOfSources(metadata.MediaSources, true, true),
        });
      }
    } catch (e) {
      if (e instanceof NotIdentifiedError) {
        this.skipUnidentified(e);
      } else {
        this.failed(jellyfinitem, e);
      }
    }
  }

  private async getTvShow({
    tmdbId,
    tvdbId,
  }: {
    tmdbId?: number;
    tvdbId?: number;
  }): Promise<TmdbTvScanDetails | TmdbTvDetails> {
    let tvShow;

    if (tmdbId) {
      tvShow = await this.tmdb.getTvShowForScan({
        tvId: Number(tmdbId),
      });
    } else if (tvdbId) {
      tvShow = await this.tmdb.getShowByTvdbIdForScan({
        tvdbId: Number(tvdbId),
      });
    } else {
      throw new Error('No ID provided');
    }

    const metadataProvider = detectAnime(tvShow)
      ? await getMetadataProvider('anime')
      : await getMetadataProvider('tv');

    if (!(metadataProvider instanceof TheMovieDb)) {
      tvShow = await metadataProvider.getTvShow({
        tvId: Number(tmdbId),
      });
    }

    return tvShow;
  }

  private async processJellyfinShow(jellyfinitem: JellyfinLibraryItem) {
    let tvShow: TmdbTvScanDetails | TmdbTvDetails | null = null;

    try {
      const Id =
        jellyfinitem.SeriesId ?? jellyfinitem.SeasonId ?? jellyfinitem.Id;
      const metadata = await this.jfClient.getItemData(Id);

      if (!metadata?.Id) {
        this.log('No Id metadata for this title. Skipping', 'debug', {
          item: labelOf(jellyfinitem),
        });
        return;
      }

      if (!hasAnyId(metadata.ProviderIds)) {
        throw new NotIdentifiedError('series', labelOf(metadata));
      }

      if (metadata.ProviderIds.Tmdb || metadata.ProviderIds.TheMovieDb) {
        try {
          tvShow = await this.getTvShow({
            tmdbId: Number(
              metadata.ProviderIds.Tmdb || metadata.ProviderIds.TheMovieDb
            ),
          });
        } catch (e) {
          this.log(
            `Couldn't find ${nameOf(labelOf(metadata))} on TMDB by its TMDB id`,
            'debug',
            { item: labelOf(metadata), errorMessage: e.message }
          );
        }
      }

      if (!tvShow && metadata.ProviderIds.Tvdb) {
        try {
          tvShow = await this.getTvShow({
            tvdbId: Number(metadata.ProviderIds.Tvdb),
          });
        } catch (e) {
          this.log(
            `Couldn't find ${nameOf(labelOf(metadata))} on TMDB by its TVDB id`,
            'debug',
            { item: labelOf(metadata), errorMessage: e.message }
          );
        }
      }

      let tvdbSeasonFromAnidb: number | undefined;
      if (!tvShow && metadata.ProviderIds.AniDB) {
        const anidbId = Number(metadata.ProviderIds.AniDB);
        const result = animeList.getFromAnidbId(anidbId);
        tvdbSeasonFromAnidb = result?.tvdbSeason;
        if (result?.tvdbId) {
          try {
            tvShow = await this.tmdb.getShowByTvdbIdForScan({
              tvdbId: result.tvdbId,
            });
          } catch (e) {
            this.log(
              `Couldn't find ${nameOf(labelOf(metadata))} on TMDB by its AniDB id`,
              'debug',
              { item: labelOf(metadata), errorMessage: e.message }
            );
          }
        }
        // AniDB libraries can mix movies into a "show" library.
        else if (result?.imdbId || result?.tmdbId) {
          await this.processJellyfinMovie(jellyfinitem);
          return;
        }
      }

      if (tvShow) {
        const seasons = tvShow.seasons;
        const jellyfinSeasons = await this.jfClient.getSeasons(Id);

        const processableSeasons: ProcessableSeason[] = [];
        const seen: Record<'standard' | '4k', (SeenQuality | undefined)[]> = {
          standard: [],
          '4k': [],
        };

        const settings = getSettings();
        const filteredSeasons = settings.main.enableSpecialEpisodes
          ? seasons
          : seasons.filter((sn) => sn.season_number !== 0);

        for (const season of filteredSeasons) {
          const matchedJellyfinSeason = jellyfinSeasons.find((md) => {
            if (tvdbSeasonFromAnidb) {
              // AniDB has no seasons: each is a separate show with only
              // Season 1 (and sometimes 0 for specials). tvdbSeasonFromAnidb
              // picks the TMDB season; md.IndexNumber === 1 picks the
              // Jellyfin season.
              return (
                tvdbSeasonFromAnidb === season.season_number &&
                md.IndexNumber === 1
              );
            } else {
              return Number(md.IndexNumber) === season.season_number;
            }
          });

          if (matchedJellyfinSeason) {
            let totalStandard = 0;
            let total4k = 0;

            // With media info: resolution for 4K, and what each is in.
            const episodes = await this.jfClient.getEpisodes(
              Id,
              matchedJellyfinSeason.Id,
              { includeMediaInfo: true }
            );

            for (const episode of episodes) {
              seen.standard.push(
                qualityOfSources(episode.MediaSources, false, this.enable4kShow)
              );
              if (this.enable4kShow) {
                seen['4k'].push(
                  qualityOfSources(episode.MediaSources, true, true)
                );
              }
            }

            if (!this.enable4kShow) {
              for (const episode of episodes) {
                totalStandard += episodeCountOf(episode);
              }
            } else {
              for (const episode of episodes) {
                const episodeCount = episodeCountOf(episode);

                const has4k = episode.MediaSources?.some((MediaSource) =>
                  MediaSource.MediaStreams.some(
                    (MediaStream) =>
                      MediaStream.Type === 'Video' &&
                      (MediaStream.Width ?? 0) > 2000
                  )
                );

                const hasStandard =
                  resolutionUnknown(episode) ||
                  episode.MediaSources?.some((MediaSource) =>
                    MediaSource.MediaStreams.some(
                      (MediaStream) =>
                        MediaStream.Type === 'Video' &&
                        (MediaStream.Width ?? 0) <= 2000
                    )
                  );

                // Counts in both if the episode has both versions.
                // TODO: Detection uses file resolution only, not which
                // Radarr/Sonarr instance the file came from. 1080p files from
                // a 4K request (no 4K release yet) count as standard even in
                // the 4K library, so non-4K users may see content as available
                // that they can't access.
                // See https://github.com/seerr-team/seerr/issues/1744.
                if (hasStandard) totalStandard += episodeCount;
                if (has4k) total4k += episodeCount;
              }
            }

            // With AniDB one season can span several shows, so sum episodes
            // across all Jellyfin entries.
            if (tvdbSeasonFromAnidb) {
              let show = this.processedAnidbSeason.get(tvShow.id);

              if (!show) {
                show = new Map([[season.season_number, totalStandard]]);
                this.processedAnidbSeason.set(tvShow.id, show);
              } else {
                const currentCount = show.get(season.season_number) ?? 0;
                const newCount = currentCount + totalStandard;
                show.set(season.season_number, newCount);
                totalStandard = newCount;
              }
            }

            processableSeasons.push({
              seasonNumber: season.season_number,
              totalEpisodes: season.episode_count,
              episodes: totalStandard,
              episodes4k: total4k,
            });
          } else {
            processableSeasons.push({
              seasonNumber: season.season_number,
              totalEpisodes: season.episode_count,
              episodes: 0,
              episodes4k: 0,
            });
          }
        }

        await this.processShow(
          tvShow.id,
          tvShow.external_ids?.tvdb_id,
          processableSeasons,
          {
            mediaAddedAt: metadata.DateCreated
              ? new Date(metadata.DateCreated)
              : undefined,
            mediaServer: this.kind,
            itemId: Id,
            title: tvShow.name,
            qualities: {
              standard: combineQuality(seen.standard),
              '4k': combineQuality(seen['4k']),
            },
          }
        );
      } else {
        this.log(
          `No information found for the show: ${metadata.Name}`,
          'debug',
          { item: labelOf(metadata) }
        );
      }
    } catch (e) {
      if (e instanceof NotIdentifiedError) {
        this.skipUnidentified(e);
      } else {
        this.failed(jellyfinitem, e);
      }
    }
  }

  private async processItem(item: JellyfinLibraryItem): Promise<void> {
    if (item.Type === 'Movie') {
      await this.processJellyfinMovie(item);
    } else if (item.Type === 'Series') {
      await this.processJellyfinShow(item);
    } else if (
      (item.Type === 'Season' || item.Type === 'Episode') &&
      item.SeriesId
    ) {
      await this.processJellyfinShow({ ...item, Id: item.SeriesId });
    }
  }

  public async run(): Promise<void> {
    if (!isConnected(this.kind)) {
      return;
    }

    const sessionId = this.startRun();
    this.unidentified.clear();

    try {
      const admin = await jellyfinAdmin(this.kind);

      if (!admin) {
        return this.log(
          `No admin configured. ${serverName(this.kind)} sync skipped.`,
          'warn'
        );
      }

      const server = jellyfinFamily(this.kind);
      this.jfClient = new JellyfinAPI(
        hostnameFor(this.kind),
        server.apiKey,
        admin.deviceId,
        this.kind
      );

      this.jfClient.setUserId(admin.userId);

      this.libraries = server.libraries.filter((library) => library.enabled);

      await animeList.sync();

      if (this.isRecentOnly) {
        for (const library of this.libraries) {
          this.currentLibrary = library;
          this.processedAnidbSeason = new Map();
          this.log(
            `Beginning to process recently added for library: ${library.name}`,
            'info'
          );
          const libraryItems = await this.jfClient.getRecentlyAdded(library.id);
          await this.libraryItems?.begin(library.id);

          // One entry per series, season or item.
          this.items = uniqWith(libraryItems, (mediaA, mediaB) => {
            if (mediaA.SeriesId && mediaB.SeriesId) {
              return mediaA.SeriesId === mediaB.SeriesId;
            }

            if (mediaA.SeasonId && mediaB.SeasonId) {
              return mediaA.SeasonId === mediaB.SeasonId;
            }

            return mediaA.Id === mediaB.Id;
          });

          await this.loop(this.processItem.bind(this), { sessionId });
          this.libraryItems?.end();
        }
      } else {
        for (const library of this.libraries) {
          this.currentLibrary = library;
          this.processedAnidbSeason = new Map();
          this.log(`Beginning to process library: ${library.name}`, 'info');
          this.items = await this.jfClient.getLibraryContents(library.id);
          this.failures = 0;
          await this.libraryItems?.begin(library.id);
          await this.loop(this.processItem.bind(this), { sessionId });
          await this.settleLibraryItems(library);
        }
      }

      const skipped = this.unidentified.summary();
      if (skipped) {
        this.log(skipped.message, 'info', { examples: skipped.examples });
      }

      this.log(
        this.isRecentOnly
          ? 'Recently Added Scan Complete'
          : 'Full Scan Complete',
        'info'
      );
    } catch (e) {
      this.log('Sync interrupted', 'error', { errorMessage: e.message });
    } finally {
      this.libraryItems?.end();
      this.endRun(sessionId);
    }
  }

  /**
   * After a full pass of a library, forgets titles it no longer holds; not
   * after a pass with failures, where a title it missed would look gone.
   */
  private async settleLibraryItems(library: Library): Promise<void> {
    if (this.failures > 0) {
      this.libraryItems?.end();
      return;
    }
    const forgotten = (await this.libraryItems?.prune()) ?? 0;
    if (forgotten) {
      this.log(
        `${library.name} no longer holds ${forgotten} title(s) it held`,
        'info'
      );
    }
  }

  public status(): JellyfinSyncStatus {
    return {
      running: this.running,
      progress: this.progress,
      total: this.items.length,
      currentLibrary: this.currentLibrary,
      libraries: this.libraries,
    };
  }
}

export const jellyfinFullScanner = new JellyfinScanner();
export const jellyfinRecentScanner = new JellyfinScanner({
  isRecentOnly: true,
});

export const embyFullScanner = new JellyfinScanner({ kind: 'emby' });
export const embyRecentScanner = new JellyfinScanner({
  isRecentOnly: true,
  kind: 'emby',
});

/** A Jellyfin or Emby server's full and recently added scanners. */
export const jellyfinScanners = (
  kind: JellyfinFamilyKind
): { full: JellyfinScanner; recent: JellyfinScanner } =>
  kind === 'emby'
    ? { full: embyFullScanner, recent: embyRecentScanner }
    : { full: jellyfinFullScanner, recent: jellyfinRecentScanner };
