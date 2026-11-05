import animeList from '@server/api/animelist';
import { getMetadataProvider } from '@server/api/metadata';
import type { PlexLibraryItem, PlexMetadata } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbTvDetails,
  TmdbTvScanDetails,
} from '@server/api/themoviedb/interfaces';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { detectAnime } from '@server/lib/animeDecision';
import { isConnected } from '@server/lib/mediaServers';
import type {
  MediaIds,
  ProcessableSeason,
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import { RecentRetries, titleKey } from '@server/lib/scanners/plex/recent';
import type { ItemLabel } from '@server/lib/scanners/unidentified';
import {
  NotIdentifiedError,
  UnidentifiedTitles,
} from '@server/lib/scanners/unidentified';
import type { Library } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { uniqWith } from 'lodash';

const imdbRegex = new RegExp(/imdb:\/\/(tt[0-9]+)/);
const tmdbRegex = new RegExp(/tmdb:\/\/([0-9]+)/);
const tvdbRegex = new RegExp(/tvdb:\/\/([0-9]+)/);
const tmdbShowRegex = new RegExp(/themoviedb:\/\/([0-9]+)/);
const plexRegex = new RegExp(/plex:\/\//);
const plexCustomProviderRegex = new RegExp(
  /tv\.plex\.agents\.custom(\.[a-zA-Z0-9]+)+:\/\//
);
// The Hama agent uses ASS naming:
// https://github.com/ZeroQI/Absolute-Series-Scanner/blob/master/README.md#forcing-the-movieseries-id
const hamaTvdbRegex = new RegExp(/hama:\/\/tvdb[0-9]?-([0-9]+)/);
const hamaAnidbRegex = new RegExp(/hama:\/\/anidb[0-9]?-([0-9]+)/);
const HAMA_AGENT = 'com.plexapp.agents.hama';

/**
 * An item as the log names it; never Plex's whole record. An episode (from
 * a recently added scan) is named by its show.
 */
const labelOf = (item: PlexLibraryItem): ItemLabel =>
  item.type === 'episode' && item.grandparentTitle
    ? {
        name: item.grandparentTitle,
        type: 'show',
        id: item.grandparentRatingKey ?? item.ratingKey,
      }
    : {
        name: item.title,
        ...(item.year ? { year: item.year } : {}),
        type: item.type,
        id: item.ratingKey,
      };

type SyncStatus = StatusBase & {
  currentLibrary: Library;
  libraries: Library[];
};

class PlexScanner
  extends BaseScanner<PlexLibraryItem>
  implements RunnableScanner<SyncStatus>
{
  private plexClient: PlexAPI;
  private libraries: Library[];
  private currentLibrary: Library;
  private isRecentOnly = false;
  /** Titles a recently added scan couldn't place yet, to retry. */
  public readonly retries = new RecentRetries();
  /** Titles this scan skipped because Plex hasn't matched them yet. */
  private unidentified = new UnidentifiedTitles({
    server: 'Plex',
    verb: 'matched',
    hint: "refresh the library's metadata, or use Match on a title",
  });

  public constructor(isRecentOnly = false) {
    super('Plex Scan', { bundleSize: 50 });
    this.isRecentOnly = isRecentOnly;
  }

  public status(): SyncStatus {
    return {
      running: this.running,
      progress: this.progress,
      total: this.totalSize ?? 0,
      currentLibrary: this.currentLibrary,
      libraries: this.libraries,
    };
  }

  public async run(): Promise<void> {
    // Scan Plex only while Seerr is connected to it.
    if (!isConnected('plex')) {
      return;
    }

    const settings = getSettings();
    const sessionId = this.startRun();
    this.unidentified.clear();
    try {
      const userRepository = getRepository(User);
      const admin = await userRepository.findOne({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });

      if (!admin) {
        return this.log('No admin configured. Plex scan skipped.', 'warn');
      }

      this.plexClient = new PlexAPI({ plexToken: admin.plexToken });

      this.libraries = settings.plex.libraries.filter(
        (library) => library.enabled
      );

      const hasHama = await this.hasHamaAgent();
      if (hasHama) {
        await animeList.sync();
      }

      if (this.isRecentOnly) {
        for (const library of this.libraries) {
          if (!this.stillEnabled(library)) continue;
          this.currentLibrary = library;
          this.log(
            `Beginning to process recently added for library: ${library.name}`,
            'info',
            { lastScan: library.lastScan }
          );
          // The next window starts when this one was requested, not when it
          // ended, so items added during the run fall in the next.
          const askedAt = Date.now();
          const libraryItems = await this.plexClient.getRecentlyAdded(
            library.id,
            library.lastScan
              ? {
                  // 10-minute buffer before the last scan.
                  addedAt: library.lastScan - 1000 * 60 * 10,
                }
              : undefined,
            library.type
          );
          const due = await this.refreshed(
            library,
            this.retries.due(library.id, askedAt).map((entry) => entry.item)
          );

          // One entry per title.
          this.items = uniqWith(
            [...libraryItems, ...due],
            (a, b) => titleKey(a) === titleKey(b)
          );

          let missed = 0;
          let gaveUp = 0;
          await this.loop(
            async (item) => {
              const error = await this.processItem(item);
              if (!error) {
                this.retries.succeeded(library.id, item);
              } else if (this.retries.failed(library.id, item, error)) {
                gaveUp += 1;
                this.log(
                  'Gave up on a recently added title after a day; the full scan will look at it',
                  'warn',
                  { title: item.grandparentTitle ?? item.title, error }
                );
              } else {
                missed += 1;
              }
            },
            { sessionId }
          );
          this.log(
            `${library.name}: ${libraryItems.length} recently added, ${due.length} looked at again`,
            'info',
            {
              placed: this.items.length - missed - gaveUp,
              toTryAgain: this.retries.count(library.id),
            }
          );

          const newLibraries = settings.plex.libraries.map((lib) => {
            if (lib.id === library.id) {
              return {
                ...lib,
                lastScan: askedAt,
              };
            }
            return lib;
          });

          settings.plex.libraries = newLibraries;
          await settings.save();
        }
      } else {
        for (const library of this.libraries) {
          if (!this.stillEnabled(library)) continue;
          this.currentLibrary = library;
          this.log(`Beginning to process library: ${library.name}`, 'info');
          await this.paginateLibrary(library, { sessionId });
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
      this.log('Scan interrupted', 'error', {
        errorMessage: e.message,
      });
    } finally {
      this.endRun(sessionId);
    }
  }

  /**
   * Whether a library is still enabled. The list is read at scan start and
   * full scans are long, so a library disabled mid-scan is skipped or stopped
   * at its next page.
   */
  private stillEnabled(library: Library): boolean {
    const now = getSettings().plex.libraries.find((l) => l.id === library.id);
    if (now?.enabled) return true;
    this.log(`Skipping library ${library.name}: it was switched off`, 'info');
    return false;
  }

  private async paginateLibrary(
    library: Library,
    { start = 0, sessionId }: { start?: number; sessionId: string }
  ) {
    if (!this.running) {
      throw new Error('Sync was aborted.');
    }

    if (this.sessionId !== sessionId) {
      throw new Error('New session was started. Old session aborted.');
    }

    // Disabled part-way through: leave the rest.
    if (start > 0 && !this.stillEnabled(library)) return;

    const response = await this.plexClient.getLibraryContents(library.id, {
      size: this.protectedBundleSize,
      offset: start,
    });

    this.progress = start;
    this.totalSize = response.totalSize;

    if (response.items.length === 0) {
      return;
    }

    await Promise.all(
      response.items.map(async (item) => {
        await this.processItem(item);
      })
    );

    if (response.items.length < this.protectedBundleSize) {
      return;
    }

    await new Promise<void>((resolve, reject) =>
      setTimeout(() => {
        this.paginateLibrary(library, {
          start: start + this.protectedBundleSize,
          sessionId,
        })
          .then(() => resolve())
          .catch((e) => reject(new Error(e.message)));
      }, this.protectedUpdateRate)
    );
  }

  /** Processes one item; returns the error message, or null on success. */
  private async processItem(plexitem: PlexLibraryItem): Promise<string | null> {
    try {
      if (plexitem.type === 'movie') {
        await this.processPlexMovie(plexitem);
      } else if (
        plexitem.type === 'show' ||
        plexitem.type === 'episode' ||
        plexitem.type === 'season'
      ) {
        await this.processPlexShow(plexitem);
      }
      return null;
    } catch (e) {
      // An unmatched title is normal for new files: counted, not an error.
      // It is still retried like any other.
      if (e instanceof NotIdentifiedError) {
        this.log(this.unidentified.add(e.kind, e.item), 'debug', {
          item: e.item,
        });
      } else {
        this.log('Failed to process Plex media', 'error', {
          errorMessage: e.message,
          item: labelOf(plexitem),
        });
      }
      return e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * Retry titles with current Plex metadata, since a movie may have been
   * matched since. Titles Plex no longer has are forgotten.
   */
  private async refreshed(
    library: Library,
    items: PlexLibraryItem[]
  ): Promise<PlexLibraryItem[]> {
    const fresh: PlexLibraryItem[] = [];
    for (const item of items) {
      if (item.type !== 'movie') {
        // Shows are re-read from Plex when processed.
        fresh.push(item);
        continue;
      }
      try {
        const now = await this.plexClient.getMetadata(item.ratingKey);
        if (now) {
          fresh.push({ ...item, ...(now as unknown as PlexLibraryItem) });
        } else {
          this.retries.forget(library.id, item);
        }
      } catch (e) {
        if (
          (e as { response?: { status?: number } }).response?.status === 404
        ) {
          this.retries.forget(library.id, item);
        } else {
          fresh.push(item);
        }
      }
    }
    return fresh;
  }

  private async processPlexMovie(plexitem: PlexLibraryItem) {
    const mediaIds = await this.getMediaIds(plexitem);

    await this.processPlexMovieByTmdbId(plexitem, mediaIds.tmdbId);
  }

  /**
   * One Plex item can hold several versions of a movie, each counting for
   * its own quality: 1080p and 4K versions make it available in both.
   * Without a 4K Radarr any version counts for the single quality.
   */
  private async processPlexMovieByTmdbId(
    plexitem: PlexLibraryItem | PlexMetadata,
    tmdbId: number
  ) {
    const has4k =
      this.enable4kMovie &&
      plexitem.Media.some((media) => media.videoResolution === '4k');
    const hasStandard =
      !has4k || plexitem.Media.some((media) => media.videoResolution !== '4k');
    const details = {
      mediaAddedAt: new Date(plexitem.addedAt * 1000),
      ratingKey: plexitem.ratingKey,
      title: plexitem.title,
    };

    if (hasStandard) {
      await this.processMovie(tmdbId, { ...details, is4k: false });
    }

    if (has4k) {
      await this.processMovie(tmdbId, { ...details, is4k: true });
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

  private async processPlexShow(plexitem: PlexLibraryItem) {
    const ratingKey =
      plexitem.grandparentRatingKey ??
      plexitem.parentRatingKey ??
      plexitem.ratingKey;
    const metadata = await this.plexClient.getMetadata(ratingKey, {
      includeChildren: true,
    });

    const mediaIds = await this.getMediaIds(metadata);

    // HAMA media without a TVDB ID is a HAMA movie.
    if (mediaIds.tmdbId && !mediaIds.tvdbId && mediaIds.isHama) {
      this.processHamaMovie(metadata, mediaIds.tmdbId);
      return;
    }

    // HAMA media with a TVDB ID may have specials.
    if (mediaIds.tvdbId && mediaIds.isHama) {
      await this.processHamaSpecials(metadata, mediaIds.tvdbId);
    }

    const tvShow = await this.getTvShow({
      tmdbId: mediaIds.tmdbId,
    });

    const seasons = tvShow.seasons;
    const processableSeasons: ProcessableSeason[] = [];

    const settings = getSettings();
    const filteredSeasons = settings.main.enableSpecialEpisodes
      ? seasons
      : seasons.filter((sn) => sn.season_number !== 0);

    for (const season of filteredSeasons) {
      const matchedPlexSeason = metadata.Children?.Metadata.find(
        (md) => Number(md.index) === season.season_number
      );

      if (matchedPlexSeason) {
        const episodes = await this.plexClient.getChildrenMetadata(
          matchedPlexSeason.ratingKey
        );
        // Non-4K episodes (all of them when 4K is disabled).
        const totalStandard = episodes.filter(
          (episode) =>
            !this.enable4kShow ||
            episode.Media.some((media) => media.videoResolution !== '4k')
        ).length;

        const total4k = this.enable4kShow
          ? episodes.filter((episode) =>
              episode.Media.some((media) => media.videoResolution === '4k')
            ).length
          : 0;

        processableSeasons.push({
          seasonNumber: season.season_number,
          episodes: totalStandard,
          episodes4k: total4k,
          totalEpisodes: season.episode_count,
        });
      } else {
        processableSeasons.push({
          seasonNumber: season.season_number,
          episodes: 0,
          episodes4k: 0,
          totalEpisodes: season.episode_count,
        });
      }
    }

    await this.processShow(
      mediaIds.tmdbId,
      mediaIds.tvdbId ?? tvShow.external_ids.tvdb_id,
      processableSeasons,
      {
        mediaAddedAt: new Date(metadata.addedAt * 1000),
        ratingKey: ratingKey,
        title: metadata.title,
      }
    );
  }

  private async getMediaIds(plexitem: PlexLibraryItem): Promise<MediaIds> {
    const mediaIds: Partial<MediaIds> = {};
    // New Plex movie/TV agent.
    if (
      plexitem.guid.match(plexRegex) ||
      plexitem.guid.match(plexCustomProviderRegex)
    ) {
      const metadata =
        plexitem.Guid && plexitem.Guid.length > 0
          ? plexitem
          : await this.plexClient.getMetadata(plexitem.ratingKey);

      if (!metadata.Guid) {
        throw new NotIdentifiedError(
          plexitem.type === 'movie' ? 'film' : 'series',
          labelOf(plexitem),
          'No Guid metadata for this title. Skipping. (Try refreshing the metadata in Plex for this media!)'
        );
      }

      metadata.Guid.forEach((ref) => {
        if (ref.id.match(imdbRegex)) {
          mediaIds.imdbId = ref.id.match(imdbRegex)?.[1] ?? undefined;
        } else if (ref.id.match(tmdbRegex)) {
          const tmdbMatch = ref.id.match(tmdbRegex)?.[1];
          mediaIds.tmdbId = Number(tmdbMatch);
        } else if (ref.id.match(tvdbRegex)) {
          const tvdbMatch = ref.id.match(tvdbRegex)?.[1];
          mediaIds.tvdbId = Number(tvdbMatch);
        }
      });

      if (mediaIds.imdbId && !mediaIds.tmdbId) {
        mediaIds.tmdbId = await this.tmdb.resolveImdbIdForScan({
          imdbId: mediaIds.imdbId,
        });
      }

      if (mediaIds.tvdbId && !mediaIds.tmdbId) {
        const show = await this.tmdb.getShowByTvdbIdForScan({
          tvdbId: mediaIds.tvdbId,
        });
        mediaIds.tmdbId = show.id;
      }
    } else if (plexitem.guid.match(imdbRegex)) {
      const imdbMatch = plexitem.guid.match(imdbRegex);
      if (imdbMatch) {
        mediaIds.imdbId = imdbMatch[1];
        mediaIds.tmdbId = await this.tmdb.resolveImdbIdForScan({
          imdbId: mediaIds.imdbId,
        });
      }
    } else if (plexitem.guid.match(tmdbRegex)) {
      const tmdbMatch = plexitem.guid.match(tmdbRegex);
      if (tmdbMatch) {
        mediaIds.tmdbId = Number(tmdbMatch[1]);
      }
    } else if (plexitem.guid.match(tvdbRegex)) {
      const matchedtvdb = plexitem.guid.match(tvdbRegex);

      if (matchedtvdb) {
        const show = await this.tmdb.getShowByTvdbIdForScan({
          tvdbId: Number(matchedtvdb[1]),
        });

        mediaIds.tvdbId = Number(matchedtvdb[1]);
        mediaIds.tmdbId = show.id;
      }
    } else if (plexitem.guid.match(tmdbShowRegex)) {
      const matchedtmdb = plexitem.guid.match(tmdbShowRegex);
      if (matchedtmdb) {
        mediaIds.tmdbId = Number(matchedtmdb[1]);
      }
    } else if (plexitem.guid.match(hamaTvdbRegex)) {
      const matchedtvdb = plexitem.guid.match(hamaTvdbRegex);

      if (matchedtvdb) {
        const show = await this.tmdb.getShowByTvdbIdForScan({
          tvdbId: Number(matchedtvdb[1]),
        });

        mediaIds.tvdbId = Number(matchedtvdb[1]);
        mediaIds.tmdbId = show.id;
        mediaIds.isHama = true;
      }
    } else if (plexitem.guid.match(hamaAnidbRegex)) {
      const matchedhama = plexitem.guid.match(hamaAnidbRegex);

      if (!animeList.isLoaded()) {
        this.log(
          `Hama ID ${plexitem.guid} detected, but library agent is not set to Hama`,
          'warn',
          { title: plexitem.title }
        );
      } else if (matchedhama) {
        const anidbId = Number(matchedhama[1]);
        const result = animeList.getFromAnidbId(anidbId);
        let tvShow: TmdbTvScanDetails | TmdbTvDetails | null = null;

        mediaIds.isHama = true;

        // Try the show by TVDB ID first.
        if (result?.tvdbId) {
          const extResponse = await this.tmdb.getByExternalIdForScan({
            externalId: result.tvdbId,
            type: 'tvdb',
          });
          if (extResponse.tv_results[0]) {
            tvShow = await this.tmdb.getTvShowForScan({
              tvId: extResponse.tv_results[0].id,
            });
            mediaIds.tvdbId = result.tvdbId;
            mediaIds.tmdbId = tvShow.id;
          } else {
            this.log(
              `Missing TVDB ${result.tvdbId} entry in TMDB for AniDB ${anidbId}`
            );
          }
        }

        if (!tvShow) {
          // Fall back to a movie by TMDB/IMDb ID. Some shows have an IMDb ID
          // too, so this must come second.
          if (result?.tmdbId) {
            mediaIds.tmdbId = result.tmdbId;
            mediaIds.imdbId = result?.imdbId;
          } else if (result?.imdbId) {
            mediaIds.tmdbId = await this.tmdb.resolveImdbIdForScan({
              imdbId: result.imdbId,
            });
            mediaIds.imdbId = result.imdbId;
          }
        }
      }
    }

    if (!mediaIds.tmdbId) {
      // A HAMA AniDB id missing from the anime list is a real gap; anything
      // else without an id is a title Plex hasn't matched yet.
      if (plexitem.guid.match(hamaAnidbRegex)) {
        throw new Error('Unable to find TMDB ID');
      }
      throw new NotIdentifiedError(
        plexitem.type === 'movie' ? 'film' : 'series',
        labelOf(plexitem)
      );
    }

    return mediaIds as MediaIds;
  }

  // HAMA movies are shows with at least one episode. Use the first episode
  // of the first season; it isn't always S01E01.
  private async processHamaMovie(metadata: PlexMetadata, tmdbId: number) {
    const season = metadata.Children?.Metadata[0];
    if (season) {
      const episodes = await this.plexClient.getChildrenMetadata(
        season.ratingKey
      );
      if (episodes) {
        await this.processPlexMovieByTmdbId(episodes[0], tmdbId);
      }
    }
  }

  // Adds movie episodes from a HAMA show's specials season.
  private async processHamaSpecials(metadata: PlexMetadata, tvdbId: number) {
    const specials = metadata.Children?.Metadata.find(
      (md) => Number(md.index) === 0
    );
    if (specials) {
      const episodes = await this.plexClient.getChildrenMetadata(
        specials.ratingKey
      );
      if (episodes) {
        for (const episode of episodes) {
          const special = animeList.getSpecialEpisode(tvdbId, episode.index);
          if (special) {
            if (special.tmdbId) {
              await this.processPlexMovieByTmdbId(episode, special.tmdbId);
            } else if (special.imdbId) {
              const tmdbId = await this.tmdb.resolveImdbIdForScan({
                imdbId: special.imdbId,
              });
              await this.processPlexMovieByTmdbId(episode, tmdbId);
            }
          }
        }
      }
    }
  }

  private async hasHamaAgent() {
    const plexLibraries = await this.plexClient.getLibraries();
    return this.libraries.some((library) =>
      plexLibraries.some(
        (plexLibrary) =>
          plexLibrary.agent === HAMA_AGENT && library.id === plexLibrary.key
      )
    );
  }
}

export const plexFullScanner = new PlexScanner();
export const plexRecentScanner = new PlexScanner(true);
