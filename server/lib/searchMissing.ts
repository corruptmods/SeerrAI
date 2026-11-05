import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaStatus, MediaType, isVideo } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type Media from '@server/entity/Media';
import MusicAlbum from '@server/entity/MusicAlbum';
import { lidarrApi } from '@server/lib/music/access';
import { getSettings } from '@server/lib/settings';
import { IsNull, Not } from 'typeorm';

/*
 * Asks Radarr, Sonarr or Lidarr to search now for what a title is missing.
 *
 * Sonarr grabs new episodes of a monitored series as they release but doesn't
 * go back for missed ones: it searches only when a series is added or on
 * Search. An episode not found around its air date can stay missing forever.
 * This is that Search, targeted: only monitored, aired episodes with no file
 * (what the health page counts as missing). Radarr searches for a film;
 * Lidarr for requested albums it has no files for yet.
 *
 * Each search is an indexer query, and many indexers cap queries a day. So a
 * season with every aired episode missing gets one season search (for a
 * season pack) instead of one per episode, like Sonarr's Search All Missing;
 * the rest go in a single episode search.
 */

export class NotInServiceError extends Error {}
export class NothingMissingError extends Error {}

export interface SearchStarted {
  service: string;
  /** Episodes searched; 1 for a film; albums for an artist. */
  searched: number;
  /** How many of those were whole-season searches. */
  seasons: number;
}

export const searchMissing = async (
  media: Media,
  is4k: boolean
): Promise<SearchStarted> => {
  if (media.mediaType === MediaType.MUSIC) {
    return searchMissingAlbums(media);
  }
  if (!isVideo(media.mediaType)) {
    throw new NotInServiceError(
      'Only films, series and music are searched here.'
    );
  }
  const settings = getSettings();
  const serverId = is4k ? media.serviceId4k : media.serviceId;
  const externalId = is4k ? media.externalServiceId4k : media.externalServiceId;

  if (media.mediaType === MediaType.MOVIE) {
    const server = settings.radarr.find((r) => r.id === serverId);
    if (!server || externalId == null) {
      throw new NotInServiceError('This film is not linked to Radarr.');
    }

    await new RadarrAPI({
      apiKey: server.apiKey,
      url: RadarrAPI.buildUrl(server, '/api/v3'),
    }).searchMovies([externalId]);

    return { service: server.name, searched: 1, seasons: 0 };
  }

  const server = settings.sonarr.find((s) => s.id === serverId);
  if (!server || externalId == null) {
    throw new NotInServiceError('This series is not linked to Sonarr.');
  }

  const sonarr = new SonarrAPI({
    apiKey: server.apiKey,
    url: SonarrAPI.buildUrl(server, '/api/v3'),
  });
  const now = Date.now();
  const airedMonitored = (await sonarr.getEpisodes(externalId)).filter(
    (episode) =>
      episode.monitored &&
      !!episode.airDateUtc &&
      new Date(episode.airDateUtc).getTime() <= now
  );
  const missing = airedMonitored.filter((episode) => !episode.hasFile);

  if (!missing.length) {
    throw new NothingMissingError(
      'Sonarr has every aired episode it is monitoring.'
    );
  }

  // A season with every aired episode missing, and more than one, is searched
  // whole; the rest episode by episode.
  const wholeSeasons: number[] = [];
  const episodeIds: number[] = [];
  const seasons = [...new Set(missing.map((episode) => episode.seasonNumber))];
  for (const seasonNumber of seasons) {
    const inSeason = missing.filter((e) => e.seasonNumber === seasonNumber);
    const aired = airedMonitored.filter((e) => e.seasonNumber === seasonNumber);
    if (inSeason.length > 1 && inSeason.length === aired.length) {
      wholeSeasons.push(seasonNumber);
    } else {
      episodeIds.push(...inSeason.map((episode) => episode.id));
    }
  }

  for (const seasonNumber of wholeSeasons) {
    await sonarr.searchSeason(externalId, seasonNumber);
  }
  if (episodeIds.length) {
    await sonarr.searchEpisodes(episodeIds);
  }

  return {
    service: server.name,
    searched: missing.length,
    seasons: wholeSeasons.length,
  };
};

/**
 * An artist's requested albums (processing) that Lidarr has no files for
 * yet; Lidarr searches them in one command.
 */
export const searchMissingAlbums = async (
  media: Media
): Promise<SearchStarted> => {
  const server = getSettings().lidarr.find((l) => l.id === media.serviceId);
  if (!server || media.externalServiceId == null) {
    throw new NotInServiceError('This artist is not linked to Lidarr.');
  }

  const albums = await getRepository(MusicAlbum).find({
    select: {
      id: true,
      lidarrAlbumId: true,
      trackCount: true,
      trackFileCount: true,
    },
    where: {
      mediaId: media.id,
      status: MediaStatus.PROCESSING,
      lidarrAlbumId: Not(IsNull()),
    },
  });
  const missing = albums.filter((album) => !album.trackFileCount);
  if (!missing.length) {
    throw new NothingMissingError(
      'Lidarr has files for every album asked for.'
    );
  }

  await lidarrApi(server).searchAlbums(
    missing.map((album) => album.lidarrAlbumId as number)
  );

  return { service: server.name, searched: missing.length, seasons: 0 };
};

export interface SearchAllResult {
  titles: number;
  episodes: number;
  failed: { title: number; message: string }[];
}

/**
 * Searches everything the health page lists as searchable. Films go to each
 * Radarr in one command; each series gets the search above. One failing title
 * doesn't stop the rest; failures are reported.
 */
export const searchAllMissing = async (
  media: { media: Media; is4k: boolean }[]
): Promise<SearchAllResult & { searched: Media[] }> => {
  const settings = getSettings();
  const result = {
    titles: 0,
    episodes: 0,
    failed: [] as SearchAllResult['failed'],
    searched: [] as Media[],
  };

  const films = new Map<number, { ids: number[]; media: Media[] }>();
  for (const { media: item, is4k } of media) {
    if (item.mediaType !== MediaType.MOVIE) continue;
    const serverId = is4k ? item.serviceId4k : item.serviceId;
    const externalId = is4k ? item.externalServiceId4k : item.externalServiceId;
    if (serverId == null || externalId == null) continue;
    const group = films.get(serverId) ?? { ids: [], media: [] };
    group.ids.push(externalId);
    group.media.push(item);
    films.set(serverId, group);
  }

  for (const [serverId, group] of films) {
    const server = settings.radarr.find((r) => r.id === serverId);
    if (!server) continue;
    try {
      await new RadarrAPI({
        apiKey: server.apiKey,
        url: RadarrAPI.buildUrl(server, '/api/v3'),
      }).searchMovies(group.ids);
      result.titles += group.media.length;
      result.episodes += group.media.length;
      result.searched.push(...group.media);
    } catch (e) {
      result.failed.push(
        ...group.media.map((item) => ({
          title: item.tmdbId,
          message: e.message,
        }))
      );
    }
  }

  for (const { media: item, is4k } of media) {
    if (item.mediaType !== MediaType.TV) continue;
    try {
      const started = await searchMissing(item, is4k);
      result.titles += 1;
      result.episodes += started.searched;
      result.searched.push(item);
    } catch (e) {
      if (!(e instanceof NothingMissingError)) {
        result.failed.push({ title: item.tmdbId, message: e.message });
      }
    }
  }

  return result;
};
