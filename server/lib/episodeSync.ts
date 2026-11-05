import type { SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Episode from '@server/entity/Episode';
import Media from '@server/entity/Media';
import Season from '@server/entity/Season';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

interface SonarrEpisodeState {
  seasonNumber: number;
  episodeNumber: number;
  hasFile: boolean;
}

/**
 * Per-season episode and file counts from Sonarr's series list. If unchanged
 * since the last pass, the episodes can't have changed, so they aren't read.
 */
const fingerprintOf = (series: SonarrSeries): string | null => {
  const seasons = series.seasons ?? [];
  if (seasons.some((season) => !season.statistics)) {
    return null;
  }
  return seasons
    .map(
      (season) =>
        `${season.seasonNumber}:${season.statistics?.episodeFileCount}/${season.statistics?.episodeCount}/${season.statistics?.totalEpisodeCount}`
    )
    .sort()
    .join(',');
};

/**
 * Keeps per-episode availability in step with Sonarr.
 *
 * Separate from availabilitySync on purpose: that drives season and media
 * status, which removal tooling depends on. This only writes Episode rows, so
 * it can't affect whether media counts as removed.
 */
class EpisodeSync {
  private running = false;

  /** Each series' fingerprint as of its last successful sync, by title. */
  private synced = new Map<string, string>();

  public async run(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const settings = getSettings();
      const sonarrSettings = settings.sonarr.filter((server) => !server.is4k);

      if (!sonarrSettings.length) {
        return;
      }

      const mediaRepository = getRepository(Media);
      const shows = await mediaRepository.find({
        where: [
          { mediaType: MediaType.TV, status: MediaStatus.PROCESSING },
          { mediaType: MediaType.TV, status: MediaStatus.PARTIALLY_AVAILABLE },
          { mediaType: MediaType.TV, status: MediaStatus.AVAILABLE },
        ],
        relations: { seasons: true },
      });

      if (!shows.length) {
        return;
      }

      const clients = new Map<number, SonarrAPI>();

      for (const server of sonarrSettings) {
        clients.set(
          server.id,
          new SonarrAPI({
            apiKey: server.apiKey,
            url: SonarrAPI.buildUrl(server, '/api/v3'),
          })
        );
      }

      // One call per server for all series' counts. Only series whose counts
      // changed are read episode by episode, so finished shows add no calls.
      const seriesByServer = new Map<number, Map<number, SonarrSeries>>();
      for (const [serverId, sonarr] of clients) {
        try {
          seriesByServer.set(
            serverId,
            new Map(
              (await sonarr.getSeries()).map((series) => [
                series.id as number,
                series,
              ])
            )
          );
        } catch (e) {
          logger.warn('Could not read the series list from Sonarr', {
            label: 'Episode Sync',
            serverId,
            errorMessage: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Ask only the Sonarr instance each show was sent to.
      for (const show of shows) {
        // Without externalServiceId the show was never sent to Sonarr. A
        // /series/lookup would return TVDB metadata with no library id, and
        // /episode would 400.
        if (
          show.serviceId === null ||
          show.serviceId === undefined ||
          !show.externalServiceId
        ) {
          continue;
        }

        const sonarr = clients.get(show.serviceId);
        const seriesList = seriesByServer.get(show.serviceId);

        if (!sonarr || !seriesList) {
          continue;
        }

        const series = seriesList.get(show.externalServiceId);
        // Removed from Sonarr since it was sent.
        if (!series) {
          continue;
        }

        // Include the media id: a cleared and re-requested title is a new row
        // with no episodes stored, though Sonarr's series and counts match.
        const key = `${show.id}:${show.serviceId}:${show.externalServiceId}`;
        const fingerprint = fingerprintOf(series);
        if (fingerprint && this.synced.get(key) === fingerprint) {
          continue;
        }

        // One show's failure (e.g. a season deleted mid-pass) must not stop
        // the rest.
        try {
          if (
            (await this.syncShow(sonarr, show, show.externalServiceId)) &&
            fingerprint
          ) {
            this.synced.set(key, fingerprint);
          }
        } catch (e) {
          logger.warn("Could not sync one show's episodes", {
            label: 'Episode Sync',
            mediaId: show.id,
            errorMessage: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } catch (e) {
      logger.error('Episode sync failed', {
        label: 'Episode Sync',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.running = false;
    }
  }

  /** Whether the show's episodes were read and stored. */
  private async syncShow(
    sonarr: SonarrAPI,
    show: Media,
    sonarrSeriesId: number
  ): Promise<boolean> {
    let episodes: SonarrEpisodeState[];

    try {
      episodes = await sonarr.getEpisodes(sonarrSeriesId);
    } catch (e) {
      // It may have been removed from Sonarr since; logged so a series that
      // never syncs is visible.
      logger.debug('Could not read episodes from Sonarr', {
        label: 'Episode Sync',
        sonarrSeriesId,
        errorMessage: e instanceof Error ? e.message : String(e),
      });

      return false;
    }

    if (!episodes.length) {
      return true;
    }

    const episodeRepository = getRepository(Episode);
    const seasonRepository = getRepository(Season);

    // Seasons with files but no Seerr row yet (the next scan adds them) have
    // nowhere to store episodes: re-read next pass instead of marking done.
    const waiting = [
      ...new Set(
        episodes
          .filter((episode) => episode.hasFile)
          .map((episode) => episode.seasonNumber)
      ),
    ].filter(
      (number) => !show.seasons.some((season) => season.seasonNumber === number)
    );

    for (const season of show.seasons) {
      const seasonEpisodes = episodes.filter(
        (episode) => episode.seasonNumber === season.seasonNumber
      );

      if (!seasonEpisodes.length) {
        continue;
      }

      const existing = await episodeRepository.find({
        where: { season: { id: season.id } },
        relations: { season: true },
      });

      const byNumber = new Map(
        existing.map((episode) => [episode.episodeNumber, episode])
      );

      for (const sonarrEpisode of seasonEpisodes) {
        const status = sonarrEpisode.hasFile
          ? MediaStatus.AVAILABLE
          : MediaStatus.UNKNOWN;

        const current = byNumber.get(sonarrEpisode.episodeNumber);

        if (!current) {
          const created = new Episode({
            episodeNumber: sonarrEpisode.episodeNumber,
            status,
          });
          created.season = Promise.resolve(
            await seasonRepository.findOneOrFail({ where: { id: season.id } })
          );
          await episodeRepository.save(created);

          continue;
        }

        if (current.status === status) {
          continue;
        }

        current.status = status;
        await episodeRepository.save(current);
      }
    }

    return waiting.length === 0;
  }
}

const episodeSync = new EpisodeSync();

export default episodeSync;
