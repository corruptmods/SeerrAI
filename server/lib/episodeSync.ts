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
 * Keeps per-episode availability in step with Sonarr, and notifies when a new
 * episode of a requested season lands.
 *
 * Deliberately separate from availabilitySync: that path drives season and
 * media status, which removal tooling depends on. This job only ever writes
 * Episode rows, so it cannot influence whether media is considered removed.
 */
/**
 * What Sonarr's series list says about a series' episodes: per season, how
 * many there are and how many have a file. Unchanged since the last pass, its
 * episodes cannot have changed either, so they are not asked for again.
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

      // One call per server for every series' episode counts. Only series
      // whose counts moved since their last sync are read episode by episode,
      // so a library of finished shows costs a single request per pass.
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

      // A show records which Sonarr instance it was sent to. Asking only that
      // instance keeps each pass at one call per show rather than one per
      // show per server, and avoids polling instances the show is not on.
      for (const show of shows) {
        // externalServiceId is the Sonarr series id recorded when the request
        // was sent. A show without one was never sent to Sonarr, so there is
        // nothing to sync — and looking it up via /series/lookup would return
        // TVDB metadata with no library id, producing a 400 on /episode.
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
        // Gone from Sonarr since it was sent: nothing to read.
        if (!series) {
          continue;
        }

        // The title's own id is part of the key: a title cleared and
        // requested again is a new row, with no episodes stored yet, though
        // the Sonarr series and its counts are the same.
        const key = `${show.id}:${show.serviceId}:${show.externalServiceId}`;
        const fingerprint = fingerprintOf(series);
        if (fingerprint && this.synced.get(key) === fingerprint) {
          continue;
        }

        // One show's failure (a season deleted mid-pass, say) must not stop
        // the rest.
        try {
          if (await this.syncShow(sonarr, show, show.externalServiceId)) {
            if (fingerprint) {
              this.synced.set(key, fingerprint);
            }
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
      // The series may have been removed from this instance since the request
      // was sent. Logged so a persistently failing series is visible rather
      // than silently never syncing.
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

    // A season Sonarr has files for, that Seerr has no row for yet (a title
    // just requested gets its season rows from the next scan), has nowhere
    // to keep its episodes: this show is read again next pass, rather than
    // marked done and skipped until its file count changes.
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
