import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import type Media from '@server/entity/Media';
import { getSettings } from '@server/lib/settings';

/*
 * Asks Radarr or Sonarr to search now for what a title is missing.
 *
 * Sonarr grabs new episodes of a monitored series as they are released, but
 * does not go back for ones that were missed: it searches when a series is
 * added, or when someone presses Search. An episode not found around its air
 * date can stay missing indefinitely. This is that Search, aimed precisely:
 * only episodes that are monitored, have aired, and have no file — the ones
 * the health page counts as missing. For a film, Radarr searches for it.
 *
 * Each search is a query to the indexers, and many cap queries a day. So a
 * season whose every aired episode is missing gets one season search, which
 * looks for a season pack, instead of one query per episode — as Sonarr's
 * own Search All Missing does. The rest go in a single episode search.
 */

export class NotInServiceError extends Error {}
export class NothingMissingError extends Error {}

export interface SearchStarted {
  service: string;
  /** Episodes searched for; 1 for a film. */
  searched: number;
  /** Of those, how many seasons were searched whole. */
  seasons: number;
}

export const searchMissing = async (
  media: Media,
  is4k: boolean
): Promise<SearchStarted> => {
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

  // A season with every aired episode missing, and more than one of them,
  // is searched whole; everything else episode by episode.
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

export interface SearchAllResult {
  titles: number;
  episodes: number;
  failed: { title: number; message: string }[];
}

/**
 * Searches for everything the health page lists as searchable. Films are
 * sent to each Radarr in a single command; each series gets the search above.
 * One title failing does not stop the rest; failures are reported.
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
