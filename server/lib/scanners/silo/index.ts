import { getMetadataProvider } from '@server/api/metadata';
import type SiloAPI from '@server/api/silo/client';
import type { SiloCatalogItem } from '@server/api/silo/types';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbTvDetails,
  TmdbTvScanDetails,
} from '@server/api/themoviedb/interfaces';
import { detectAnime } from '@server/lib/animeDecision';
import { combineQuality, siloVersionQuality } from '@server/lib/mediaQuality';
import { isConnected } from '@server/lib/mediaServers';
import type {
  ProcessableSeason,
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import { LibraryItems } from '@server/lib/scanners/libraryItems';
import {
  countSeasons,
  episodeRowOf,
  episodesOf,
  forgetUnseenSince,
  saveEpisodes,
} from '@server/lib/scanners/silo/episodes';
import type { ItemLabel } from '@server/lib/scanners/unidentified';
import {
  NotIdentifiedError,
  UnidentifiedTitles,
  nameOf,
} from '@server/lib/scanners/unidentified';
import type { Library } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { isSilo4k, recordSiloInfo, siloClient } from '@server/lib/silo';

/*
 * Silo's scans. Silo lists movies, series and episodes separately and can't
 * list one series' episodes, so a scan lists the episodes too, keeps them in
 * silo_episode and counts each series' seasons from there.
 */

/** How far a recently added scan reaches back before the last one. */
const RECENT_OVERLAP_MS = 10 * 60 * 1000;
/** How far the first recently added scan of a library reaches back. */
const FIRST_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

const labelOf = (item: SiloCatalogItem): ItemLabel => ({
  name: item.title,
  ...(item.year ? { year: item.year } : {}),
  type: item.type,
  id: item.content_id,
});

const hasAnyId = (item: SiloCatalogItem): boolean =>
  !!(item.tmdb_id || item.imdb_id || item.tvdb_id);

interface SiloSyncStatus extends StatusBase {
  currentLibrary?: Library;
  libraries: Library[];
}

export class SiloScanner
  extends BaseScanner<SiloCatalogItem>
  implements RunnableScanner<SiloSyncStatus>
{
  private client: SiloAPI;
  private libraries: Library[] = [];
  /** Ids of the enabled libraries. */
  private enabled = new Set<string>();
  private currentLibrary?: Library;
  private isRecentOnly: boolean;
  private unidentified: UnidentifiedTitles;
  /** Titles in the current library that failed for a real reason. */
  private failures = 0;

  constructor({
    isRecentOnly = false,
    updateRate,
  }: { isRecentOnly?: boolean; updateRate?: number } = {}) {
    super('Silo Sync', { updateRate });
    this.isRecentOnly = isRecentOnly;
    this.libraryItems = new LibraryItems('silo');
    this.unidentified = new UnidentifiedTitles({
      server: 'Silo',
      verb: 'identified',
      hint: "check the title's match in Silo",
    });
  }

  private failed(item: SiloCatalogItem, e: Error) {
    this.failures += 1;
    const label = labelOf(item);
    this.log(`Failed to process Silo item ${nameOf(label)}`, 'error', {
      errorMessage: e.message,
      item: label,
    });
  }

  /** The files of an item in the enabled libraries. */
  private versionsOf(item: SiloCatalogItem) {
    return (item.versions ?? []).filter((version) =>
      this.enabled.has(version.library_id)
    );
  }

  private async processSiloMovie(item: SiloCatalogItem): Promise<void> {
    let tmdbId = Number(item.tmdb_id || NaN);
    if (!tmdbId && item.imdb_id) {
      tmdbId = await this.tmdb.resolveImdbIdForScan({ imdbId: item.imdb_id });
    }
    if (!tmdbId) {
      if (!hasAnyId(item)) {
        throw new NotIdentifiedError('film', labelOf(item));
      }
      throw new Error('Unable to find TMDB ID');
    }

    const versions = this.versionsOf(item);
    if (!versions.length) {
      return;
    }
    const has4k = versions.some(isSilo4k);
    const hasStandard = versions.some((version) => !isSilo4k(version));
    const qualityOf = (fourK: boolean) =>
      combineQuality(
        versions
          .filter(
            (version) => !this.enable4kMovie || isSilo4k(version) === fourK
          )
          .map(siloVersionQuality)
      );
    const common = {
      mediaAddedAt: item.added_at ? new Date(item.added_at) : undefined,
      mediaServer: 'silo' as const,
      itemId: item.content_id,
      imdbId: item.imdb_id || undefined,
      title: item.title,
    };

    if (hasStandard || !this.enable4kMovie) {
      await this.processMovie(tmdbId, {
        ...common,
        is4k: false,
        quality: qualityOf(false),
      });
    }
    if (has4k && this.enable4kMovie) {
      await this.processMovie(tmdbId, {
        ...common,
        is4k: true,
        quality: qualityOf(true),
      });
    }
  }

  private async getTvShow(
    item: SiloCatalogItem
  ): Promise<TmdbTvScanDetails | TmdbTvDetails | undefined> {
    let tvShow: TmdbTvScanDetails | TmdbTvDetails | undefined;
    const tmdbId = Number(item.tmdb_id || NaN);
    const tvdbId = Number(item.tvdb_id || NaN);
    if (tmdbId) {
      try {
        tvShow = await this.tmdb.getTvShowForScan({ tvId: tmdbId });
      } catch (e) {
        this.log(
          `Couldn't find ${nameOf(labelOf(item))} on TMDB by its TMDB id`,
          'debug',
          { item: labelOf(item), errorMessage: e.message }
        );
      }
    }
    if (!tvShow && tvdbId) {
      try {
        tvShow = await this.tmdb.getShowByTvdbIdForScan({ tvdbId });
      } catch (e) {
        this.log(
          `Couldn't find ${nameOf(labelOf(item))} on TMDB by its TVDB id`,
          'debug',
          { item: labelOf(item), errorMessage: e.message }
        );
      }
    }
    if (!tvShow) {
      return undefined;
    }
    const provider = detectAnime(tvShow)
      ? await getMetadataProvider('anime')
      : await getMetadataProvider('tv');
    if (!(provider instanceof TheMovieDb)) {
      tvShow = await provider.getTvShow({ tvId: tvShow.id });
    }
    return tvShow;
  }

  private async processSiloShow(item: SiloCatalogItem): Promise<void> {
    if (!hasAnyId(item)) {
      throw new NotIdentifiedError('series', labelOf(item));
    }
    const tvShow = await this.getTvShow(item);
    if (!tvShow) {
      this.log(`No information found for the show: ${item.title}`, 'debug', {
        item: labelOf(item),
      });
      return;
    }

    const rows = await episodesOf(item.content_id, this.enabled);
    const { seasons: counts, qualities } = countSeasons(
      rows,
      this.enable4kShow
    );
    const settings = getSettings();
    const seasons: ProcessableSeason[] = tvShow.seasons
      .filter(
        (season) =>
          settings.main.enableSpecialEpisodes || season.season_number !== 0
      )
      .map((season) => ({
        seasonNumber: season.season_number,
        totalEpisodes: season.episode_count,
        episodes: counts.get(season.season_number)?.episodes ?? 0,
        episodes4k: counts.get(season.season_number)?.episodes4k ?? 0,
      }));

    await this.processShow(tvShow.id, tvShow.external_ids?.tvdb_id, seasons, {
      mediaAddedAt: item.added_at ? new Date(item.added_at) : undefined,
      mediaServer: 'silo',
      itemId: item.content_id,
      title: tvShow.name,
      qualities,
    });
  }

  private async processItem(item: SiloCatalogItem): Promise<void> {
    try {
      if (item.type === 'movie') {
        await this.processSiloMovie(item);
      } else if (item.type === 'series') {
        await this.processSiloShow(item);
      }
    } catch (e) {
      if (e instanceof NotIdentifiedError) {
        this.log(this.unidentified.add(e.kind, e.item), 'debug', {
          item: e.item,
        });
      } else {
        this.failed(item, e);
      }
    }
  }

  /** Stores listed episodes; returns the ids stored. */
  private async storeEpisodes(episodes: SiloCatalogItem[]): Promise<string[]> {
    const rows = new Map<
      string,
      NonNullable<ReturnType<typeof episodeRowOf>>
    >();
    for (const episode of episodes) {
      const row = episodeRowOf(episode, this.enabled);
      if (row) rows.set(row.contentId, row);
    }
    await saveEpisodes([...rows.values()]);
    return [...rows.keys()];
  }

  private async fullScan(sessionId: string): Promise<void> {
    // Episodes first, from every enabled library, so each series is counted
    // from all of them.
    const startedAt = Date.now();
    const episodes: SiloCatalogItem[] = [];
    const titles = new Map<string, SiloCatalogItem[]>();
    for (const library of this.libraries) {
      this.currentLibrary = library;
      this.log(`Listing Silo library: ${library.name}`, 'info');
      const askedAt = Date.now();
      const listed: SiloCatalogItem[] = [];
      if (library.type !== 'show') {
        listed.push(
          ...(await this.client.listCatalogItems({
            libraryId: library.id,
            type: 'movie',
          }))
        );
      }
      if (library.type !== 'movie') {
        listed.push(
          ...(await this.client.listCatalogItems({
            libraryId: library.id,
            type: 'series',
          }))
        );
        episodes.push(
          ...(await this.client.listCatalogItems({
            libraryId: library.id,
            type: 'episode',
          }))
        );
      }
      titles.set(library.id, listed);
      library.lastScan = askedAt;
    }
    await this.storeEpisodes(episodes);
    const forgotten = await forgetUnseenSince(startedAt);
    if (forgotten) {
      this.log(`Silo no longer lists ${forgotten} episode(s)`, 'info');
    }

    for (const library of this.libraries) {
      this.currentLibrary = library;
      this.log(`Beginning to process library: ${library.name}`, 'info');
      this.items = titles.get(library.id) ?? [];
      this.failures = 0;
      await this.libraryItems?.begin(library.id);
      await this.loop(this.processItem.bind(this), { sessionId });
      await this.settleLibraryItems(library);
    }
    await getSettings().save();
  }

  private async recentScan(sessionId: string): Promise<void> {
    for (const library of this.libraries) {
      this.currentLibrary = library;
      this.log(
        `Beginning to process recently added for library: ${library.name}`,
        'info'
      );
      const askedAt = Date.now();
      const addedAfter = new Date(
        library.lastScan
          ? library.lastScan - RECENT_OVERLAP_MS
          : askedAt - FIRST_RECENT_WINDOW_MS
      );
      const items: SiloCatalogItem[] = [];
      if (library.type !== 'show') {
        items.push(
          ...(await this.client.listCatalogItems({
            libraryId: library.id,
            type: 'movie',
            addedAfter,
          }))
        );
      }
      if (library.type !== 'movie') {
        const episodes = await this.client.listCatalogItems({
          libraryId: library.id,
          type: 'episode',
          addedAfter,
        });
        await this.storeEpisodes(episodes);
        const series = new Set(
          (
            await this.client.listCatalogItems({
              libraryId: library.id,
              type: 'series',
              addedAfter,
            })
          ).map((item) => item.content_id)
        );
        for (const episode of episodes) {
          if (episode.series_id) series.add(episode.series_id);
        }
        // Each touched series is counted again from all its stored episodes.
        items.push(
          ...(await this.client.getCatalogItems([...series])).filter(
            (item) => item.type === 'series'
          )
        );
      }
      this.items = items;
      await this.libraryItems?.begin(library.id);
      await this.loop(this.processItem.bind(this), { sessionId });
      this.libraryItems?.end();
      library.lastScan = askedAt;
    }
    await getSettings().save();
  }

  public async run(): Promise<void> {
    if (!isConnected('silo')) {
      return;
    }
    const sessionId = this.startRun();
    this.unidentified.clear();
    this.items = [];
    try {
      this.client = siloClient();
      // Stops here, changing nothing, when Silo speaks another API major.
      const info = await this.client.getCompatibleInfo();
      await recordSiloInfo(info);

      this.libraries = getSettings().silo.libraries.filter(
        (library) => library.enabled
      );
      this.enabled = new Set(this.libraries.map((library) => library.id));

      if (this.isRecentOnly) {
        await this.recentScan(sessionId);
      } else {
        await this.fullScan(sessionId);
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

  public status(): SiloSyncStatus {
    return {
      running: this.running,
      progress: this.progress,
      total: this.items.length,
      currentLibrary: this.currentLibrary,
      libraries: this.libraries,
    };
  }
}

export const siloFullScanner = new SiloScanner();
export const siloRecentScanner = new SiloScanner({ isRecentOnly: true });
