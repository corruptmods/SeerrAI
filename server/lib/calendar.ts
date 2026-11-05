import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In } from 'typeorm';

/*
 * Upcoming film releases and episode air dates for everything Radarr and
 * Sonarr watch, requested through Seerr or not. One calendar call per server.
 */

export interface CalendarItem {
  mediaType: MediaType;
  tmdbId?: number;
  title: string;
  /** Poster, from TMDB for films and TheTVDB for series. */
  poster?: string;
  /**
   * Film releases are dates stored as midnight UTC (`allDay`); episode air
   * times are real moments, shown in local time.
   */
  at: string;
  allDay: boolean;
  kind: 'cinemas' | 'digital' | 'physical' | 'episode';
  /** For series: the episodes airing then. */
  season?: number;
  episodes?: number[];
  episodeTitle?: string;
  /** Already downloaded. */
  available: boolean;
}

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: Promise<CalendarItem[]> }>();

const poster = (images?: { coverType: string; remoteUrl?: string }[]) =>
  images?.find((image) => image.coverType === 'poster')?.remoteUrl;

const inRange = (at: number, start: Date, end: Date) =>
  at >= start.getTime() && at < end.getTime();

const load = async (start: Date, end: Date): Promise<CalendarItem[]> => {
  const settings = getSettings();
  const items: CalendarItem[] = [];

  // A 4K server usually mirrors the regular one; list each title once.
  const seenFilms = new Set<string>();
  for (const server of [...settings.radarr].sort(
    (a, b) => Number(a.is4k) - Number(b.is4k)
  )) {
    try {
      const movies = await new RadarrAPI({
        apiKey: server.apiKey,
        url: RadarrAPI.buildUrl(server, '/api/v3'),
      }).getCalendar(start, end);

      for (const movie of movies) {
        for (const [kind, date] of [
          ['cinemas', movie.inCinemas],
          ['digital', movie.digitalRelease],
          ['physical', movie.physicalRelease],
        ] as const) {
          const at = date ? new Date(date).getTime() : NaN;
          const key = `${movie.tmdbId}:${kind}`;
          if (
            Number.isNaN(at) ||
            !inRange(at, start, end) ||
            seenFilms.has(key)
          ) {
            continue;
          }
          seenFilms.add(key);
          items.push({
            mediaType: MediaType.MOVIE,
            tmdbId: movie.tmdbId,
            title: movie.title,
            poster: poster(movie.images),
            at: new Date(at).toISOString(),
            allDay: true,
            kind,
            available: movie.hasFile,
          });
        }
      }
    } catch (e) {
      logger.warn('Could not read a Radarr calendar', {
        label: 'Calendar',
        server: server.name,
        errorMessage: e.message,
      });
    }
  }

  const seenEpisodes = new Set<string>();
  const episodesByShowAndTime = new Map<string, CalendarItem>();
  const tvdbOf = new Map<CalendarItem, number>();
  for (const server of [...settings.sonarr].sort(
    (a, b) => Number(a.is4k) - Number(b.is4k)
  )) {
    try {
      const episodes = await new SonarrAPI({
        apiKey: server.apiKey,
        url: SonarrAPI.buildUrl(server, '/api/v3'),
      }).getCalendar(start, end);

      for (const episode of episodes) {
        const at = episode.airDateUtc
          ? new Date(episode.airDateUtc).getTime()
          : NaN;
        const show = episode.series;
        const showKey = show?.tvdbId ?? `sonarr:${episode.seriesId}`;
        const key = `${showKey}:${episode.seasonNumber}:${episode.episodeNumber}`;
        if (
          Number.isNaN(at) ||
          !inRange(at, start, end) ||
          !show ||
          seenEpisodes.has(key)
        ) {
          continue;
        }
        seenEpisodes.add(key);

        // Episodes of a show airing at once (a season drop) form one entry.
        const groupKey = `${showKey}:${episode.seasonNumber}:${at}`;
        const group = episodesByShowAndTime.get(groupKey);
        if (group) {
          group.episodes!.push(episode.episodeNumber);
          group.available = group.available && episode.hasFile;
          group.episodeTitle = undefined;
          continue;
        }
        const item: CalendarItem = {
          mediaType: MediaType.TV,
          tmdbId: show.tmdbId || undefined,
          title: show.title,
          poster: poster(show.images),
          at: new Date(at).toISOString(),
          allDay: false,
          kind: 'episode',
          season: episode.seasonNumber,
          episodes: [episode.episodeNumber],
          episodeTitle: episode.title,
          available: episode.hasFile,
        };
        episodesByShowAndTime.set(groupKey, item);
        if (show.tvdbId) {
          tvdbOf.set(item, show.tvdbId);
        }
        items.push(item);
      }
    } catch (e) {
      logger.warn('Could not read a Sonarr calendar', {
        label: 'Calendar',
        server: server.name,
        errorMessage: e.message,
      });
    }
  }

  // Older Sonarr omits the TMDB id; find it by TVDB id so the entry links.
  const missing = items.filter(
    (item) => item.mediaType === MediaType.TV && !item.tmdbId
  );
  const tvdbIds = [
    ...new Set(
      missing.map((item) => tvdbOf.get(item)).filter((id): id is number => !!id)
    ),
  ];
  if (tvdbIds.length) {
    const known = await getRepository(Media).find({
      where: { mediaType: MediaType.TV, tvdbId: In(tvdbIds) },
    });
    const byTvdb = new Map(known.map((m) => [m.tvdbId, m.tmdbId]));
    for (const item of missing) {
      const tvdbId = tvdbOf.get(item);
      if (tvdbId && byTvdb.has(tvdbId)) {
        item.tmdbId = byTvdb.get(tvdbId);
      }
    }
  }

  items.sort(
    (a, b) =>
      new Date(a.at).getTime() - new Date(b.at).getTime() ||
      a.title.localeCompare(b.title)
  );
  return items;
};

/** Everything due between `start` and `end`, oldest first. */
export const getCalendar = (
  start: Date,
  end: Date
): Promise<CalendarItem[]> => {
  const key = `${start.toISOString()}|${end.toISOString()}`;
  const now = Date.now();
  for (const [k, entry] of cache) {
    if (now - entry.at >= CACHE_MS) {
      cache.delete(k);
    }
  }
  const hit = cache.get(key);
  if (hit) {
    return hit.value;
  }
  const value = load(start, end).catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, { at: now, value });
  return value;
};
