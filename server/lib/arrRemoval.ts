import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { MediaType, isVideo } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { DVRSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

/** No Radarr or Sonarr server could be found to remove this title from. */
export class NoArrServerError extends Error {
  constructor(public readonly arrName: string) {
    super(`No ${arrName} server configured to delete media files`);
    this.name = 'NoArrServerError';
  }
}

/**
 * Removes a title from Radarr or Sonarr and deletes its files.
 *
 * Shared by the manage panel's "remove file" action and by blocklisting, so
 * there is one path that decides which server holds a title. Status changes
 * are left to the caller: removing a file marks media DELETED, while a
 * blocklist keeps it BLOCKLISTED.
 */
export const removeFromArr = async (
  media: Media,
  is4k: boolean,
  { addImportExclusion = false }: { addImportExclusion?: boolean } = {}
): Promise<void> => {
  // A music title's server ids are Lidarr's, and must never be read as a
  // Radarr or Sonarr id.
  if (!isVideo(media.mediaType)) {
    throw new NoArrServerError('Radarr or Sonarr');
  }
  const settings = getSettings();
  const isMovie = media.mediaType === MediaType.MOVIE;
  const servers: DVRSettings[] = isMovie ? settings.radarr : settings.sonarr;

  // The server it was sent to, or else the default one. The first server
  // added has id 0, a server like any other.
  const specificServiceId = is4k ? media.serviceId4k : media.serviceId;
  const serviceSettings =
    specificServiceId != null && specificServiceId >= 0
      ? servers.find((server) => server.id === specificServiceId)
      : servers.find((server) => server.isDefault && server.is4k === is4k);

  if (!serviceSettings) {
    const arrName = `${is4k ? '4K ' : ''}${isMovie ? 'Radarr' : 'Sonarr'}`;
    logger.info(
      `There is no default ${arrName} server configured. Did you set any of your ${arrName} servers as default?`,
      {
        label: 'Media Request',
        mediaId: media.id,
      }
    );
    throw new NoArrServerError(arrName);
  }

  if (isMovie) {
    const radarr = new RadarrAPI({
      apiKey: serviceSettings.apiKey,
      url: RadarrAPI.buildUrl(serviceSettings, '/api/v3'),
    });

    await radarr.removeMovie(media.tmdbId, { addImportExclusion });
    return;
  }

  const tmdb = new TheMovieDb();
  const series = await tmdb.getTvShow({ tvId: media.tmdbId });
  const tvdbId = series.external_ids.tvdb_id ?? media.tvdbId;
  if (!tvdbId) {
    throw new Error('TVDB ID not found');
  }

  const sonarr = new SonarrAPI({
    apiKey: serviceSettings.apiKey,
    url: SonarrAPI.buildUrl(serviceSettings, '/api/v3'),
  });

  await sonarr.removeSeries(tvdbId, { addImportExclusion });
};

export default removeFromArr;
