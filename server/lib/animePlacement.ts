import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import type { SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import type { SeriesType } from '@server/constants/seriesType';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import {
  hasAnimeProfile,
  judgeMovie,
  judgeSeries,
} from '@server/lib/animeCheck';
import type { AnimeDecidedBy } from '@server/lib/animeDecision';
import { decideAnime } from '@server/lib/animeDecision';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { AnimeSignals } from '@server/utils/isAnime';
import { isAnime } from '@server/utils/isAnime';
import { In } from 'typeorm';

/*
 * A title's anime setting, set on its page by an admin, and where it sits in
 * Sonarr or Radarr against where that says it belongs. Saving the setting
 * puts it there: the anime or standard root folder (Sonarr or Radarr moves
 * the files), quality profile and, for a series, series type, the same
 * things Anime Check looks at.
 */

/** What would put a title where it belongs. Empty when it is there. */
export interface AnimePlacementChanges {
  rootFolderPath?: string;
  qualityProfileId?: number;
  /** The new quality profile's name, for showing; not sent. */
  qualityProfileName?: string;
  seriesType?: SeriesType;
}

export interface AnimePlacementServer {
  service: 'sonarr' | 'radarr';
  serverId: number;
  serverName: string;
  is4k: boolean;
  /** Whether it belongs there as anime, and why. */
  anime: boolean;
  decidedBy: AnimeDecidedBy;
  /** Whether it would be anime there with the title's setting automatic. */
  automatic: boolean;
  path?: string;
  qualityProfile?: string;
  seriesType?: SeriesType;
  /** What would put it where anime belongs, and where the rest does. */
  ifAnime: AnimePlacementChanges;
  ifNotAnime: AnimePlacementChanges;
  error?: string;
}

export interface AnimePlacement {
  /** The title's own setting; null leaves it to rules and detection. */
  animeSetting: boolean | null;
  /** What anime detection says, from TMDB. */
  detected: boolean;
  /** Whether Seerr treats the title as anime, and why. */
  anime: boolean;
  decidedBy: AnimeDecidedBy;
  /** Whether it would be anime with its setting automatic. */
  automatic: boolean;
  /** Each Sonarr or Radarr server the title is on. */
  servers: AnimePlacementServer[];
}

export interface AnimePlacementResult extends AnimePlacement {
  /** What saving changed, server by server. */
  applied: {
    serverName: string;
    is4k: boolean;
    changes: AnimePlacementChanges;
    error?: string;
  }[];
}

/** What would put a series where it belongs in Sonarr. */
export const seriesChanges = (
  series: Pick<SonarrSeries, 'path' | 'seriesType' | 'qualityProfileId'>,
  anime: boolean,
  server: SonarrSettings
): AnimePlacementChanges => {
  const verdict = judgeSeries(series, anime, server);
  const changes: AnimePlacementChanges = {};
  if (verdict.expectedFolder) {
    changes.rootFolderPath = verdict.expectedFolder;
  }
  if (verdict.wrongType) {
    changes.seriesType = anime
      ? 'anime'
      : server.seriesType && server.seriesType !== 'anime'
        ? server.seriesType
        : 'standard';
  }
  // Other series may sit on any profile but the anime one.
  if (
    hasAnimeProfile(server) &&
    anime !== (series.qualityProfileId === server.activeAnimeProfileId)
  ) {
    changes.qualityProfileId = anime
      ? server.activeAnimeProfileId
      : server.activeProfileId;
  }
  return changes;
};

/** What would put a movie where it belongs in Radarr. */
export const movieChanges = (
  movie: Pick<RadarrMovie, 'path' | 'qualityProfileId'>,
  anime: boolean,
  server: RadarrSettings
): AnimePlacementChanges => {
  const verdict = judgeMovie(movie, anime, server);
  const changes: AnimePlacementChanges = {};
  if (verdict.expectedFolder) {
    changes.rootFolderPath = verdict.expectedFolder;
  }
  if (verdict.wrongProfile) {
    changes.qualityProfileId = anime
      ? server.activeAnimeProfileId
      : server.activeProfileId;
  }
  return changes;
};

/** The series type chosen on the title's newest request that has one. */
const requestSeriesType = (media: Media, is4k: boolean) => {
  const seriesType =
    (media.requests ?? [])
      .filter((r) => r.is4k === is4k && r.seriesType)
      .sort((a, b) => b.id - a.id)[0]?.seriesType ?? null;
  // A movie is only ever anime or not.
  return media.mediaType === MediaType.MOVIE &&
    seriesType !== 'anime' &&
    seriesType !== 'standard'
    ? null
    : seriesType;
};

const sonarrFor = (server: SonarrSettings) =>
  new SonarrAPI({
    apiKey: server.apiKey,
    url: SonarrAPI.buildUrl(server, '/api/v3'),
  });

const radarrFor = (server: RadarrSettings) =>
  new RadarrAPI({
    apiKey: server.apiKey,
    url: RadarrAPI.buildUrl(server, '/api/v3'),
  });

/** The Sonarr or Radarr servers the title is on, with its id on each. */
const linkedServers = (media: Media) => {
  const settings = getSettings();
  const servers =
    media.mediaType === MediaType.MOVIE ? settings.radarr : settings.sonarr;
  return [false, true].flatMap((is4k) => {
    const serviceId = is4k ? media.serviceId4k : media.serviceId;
    const arrId = is4k ? media.externalServiceId4k : media.externalServiceId;
    const server = servers.find((s) => s.id === serviceId);
    return server && arrId ? [{ server, arrId, is4k }] : [];
  });
};

const withProfileName = (
  changes: AnimePlacementChanges,
  profiles: { id: number; name: string }[]
): AnimePlacementChanges =>
  changes.qualityProfileId === undefined
    ? changes
    : {
        ...changes,
        qualityProfileName: profiles.find(
          (p) => p.id === changes.qualityProfileId
        )?.name,
      };

const placeOnServer = async (
  media: Media,
  details: AnimeSignals,
  server: SonarrSettings | RadarrSettings,
  arrId: number,
  is4k: boolean
): Promise<AnimePlacementServer & { arrId: number }> => {
  const requestType = requestSeriesType(media, is4k);
  const { anime, decidedBy } = decideAnime(
    details,
    requestType,
    media.animeSetting
  );
  const base = {
    service:
      media.mediaType === MediaType.MOVIE
        ? ('radarr' as const)
        : ('sonarr' as const),
    serverId: server.id,
    serverName: server.name,
    is4k,
    anime,
    decidedBy,
    automatic: decideAnime(details, requestType, null).anime,
    arrId,
    ifAnime: {},
    ifNotAnime: {},
  };
  try {
    if (media.mediaType === MediaType.MOVIE) {
      const radarr = radarrFor(server as RadarrSettings);
      const [movie, profiles] = await Promise.all([
        radarr.getMovie({ id: arrId }),
        radarr.getProfiles(),
      ]);
      const changes = (value: boolean) =>
        withProfileName(
          movieChanges(movie, value, server as RadarrSettings),
          profiles
        );
      return {
        ...base,
        path: movie.path,
        qualityProfile: profiles.find((p) => p.id === movie.qualityProfileId)
          ?.name,
        ifAnime: changes(true),
        ifNotAnime: changes(false),
      };
    }
    const sonarr = sonarrFor(server as SonarrSettings);
    const [series, profiles] = await Promise.all([
      sonarr.getSeriesById(arrId),
      sonarr.getProfiles(),
    ]);
    const changes = (value: boolean) =>
      withProfileName(
        seriesChanges(series, value, server as SonarrSettings),
        profiles
      );
    return {
      ...base,
      path: series.path,
      qualityProfile: profiles.find((p) => p.id === series.qualityProfileId)
        ?.name,
      seriesType: series.seriesType,
      ifAnime: changes(true),
      ifNotAnime: changes(false),
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
};

const place = async (media: Media) => {
  const tmdb = new TheMovieDb();
  const details: AnimeSignals =
    media.mediaType === MediaType.MOVIE
      ? await tmdb.getMovieForScan({ movieId: media.tmdbId })
      : await tmdb.getTvShowForScan({ tvId: media.tmdbId });
  const requestType = requestSeriesType(media, false);
  const { anime, decidedBy } = decideAnime(
    details,
    requestType,
    media.animeSetting
  );
  const servers = await Promise.all(
    linkedServers(media).map(({ server, arrId, is4k }) =>
      placeOnServer(media, details, server, arrId, is4k)
    )
  );
  return {
    animeSetting: media.animeSetting ?? null,
    detected: isAnime(details),
    anime,
    decidedBy,
    automatic: decideAnime(details, requestType, null).anime,
    servers,
  };
};

/** The placement as the API gives it, without Sonarr's or Radarr's ids. */
const withoutIds = (
  placement: Awaited<ReturnType<typeof place>>
): AnimePlacement => ({
  ...placement,
  servers: placement.servers.map((server) => {
    const shown: AnimePlacementServer & { arrId?: number } = { ...server };
    delete shown.arrId;
    return shown;
  }),
});

const loadMedia = (id: number) =>
  getRepository(Media).findOneOrFail({
    where: { id },
    relations: { requests: true },
  });

/** A title's anime setting and where it sits against it. */
export const getAnimePlacement = async (
  mediaId: number
): Promise<AnimePlacement> => withoutIds(await place(await loadMedia(mediaId)));

/**
 * Sets a title's anime setting (null for automatic) and puts it where that
 * says it belongs on every Sonarr or Radarr server it is on. Anime or not
 * chosen on its requests that disagrees is cleared, so the setting decides.
 * Saving the same setting again puts it right if it has moved since.
 */
export const setAnimeSetting = async (
  mediaId: number,
  animeSetting: boolean | null
): Promise<AnimePlacementResult> => {
  const found = await loadMedia(mediaId);
  await getRepository(Media).update(found.id, { animeSetting });
  // The title's setting is now the decision: anime or not chosen on its
  // requests that says otherwise gives way (lib/animeDecision). A rule's
  // daily type for a title set as not anime agrees, so it stays.
  if (animeSetting !== null) {
    const disagreeing = (found.requests ?? []).filter(
      (r) => r.seriesType && (r.seriesType === 'anime') !== animeSetting
    );
    if (disagreeing.length) {
      await getRepository(MediaRequest).update(
        { id: In(disagreeing.map((r) => r.id)) },
        { seriesType: null }
      );
    }
  }
  const media = await loadMedia(mediaId);

  const before = await place(media);
  const applied: AnimePlacementResult['applied'] = [];
  for (const server of before.servers) {
    // The profile's name is for showing; Sonarr and Radarr take its id.
    const changes = { ...(server.anime ? server.ifAnime : server.ifNotAnime) };
    delete changes.qualityProfileName;
    if (server.error || !Object.keys(changes).length) {
      continue;
    }
    const settings = linkedServers(media).find(
      (linked) => linked.is4k === server.is4k
    )?.server;
    if (!settings) {
      continue;
    }
    try {
      if (server.service === 'radarr') {
        await radarrFor(settings as RadarrSettings).editMovie(
          server.arrId,
          changes
        );
      } else {
        await sonarrFor(settings as SonarrSettings).editSeries(
          server.arrId,
          changes
        );
      }
      applied.push({
        serverName: server.serverName,
        is4k: server.is4k,
        changes,
      });
      logger.info(`Moved to match its anime setting on ${server.serverName}`, {
        label: 'Anime Setting',
        mediaId: media.id,
        tmdbId: media.tmdbId,
        animeSetting,
        changes,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      applied.push({
        serverName: server.serverName,
        is4k: server.is4k,
        changes,
        error,
      });
      logger.error(
        `Could not move to match its anime setting on ${server.serverName}`,
        {
          label: 'Anime Setting',
          mediaId: media.id,
          tmdbId: media.tmdbId,
          errorMessage: error,
        }
      );
    }
  }

  return {
    ...withoutIds(applied.length ? await place(media) : before),
    applied,
  };
};
