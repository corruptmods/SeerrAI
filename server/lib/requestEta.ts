import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type Media from '@server/entity/Media';
import MediaEvent, { MediaEventType } from '@server/entity/MediaEvent';
import type { MediaRequest } from '@server/entity/MediaRequest';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In } from 'typeorm';

/*
 * Rough arrival estimate for a request, from Radarr, Sonarr and this server's
 * history. Always an estimate: release dates slip, and a release can be out
 * before it is findable. So it says "expected" and "usually", and says
 * nothing rather than guess.
 */

export type RequestEta =
  | { stage: 'awaiting_approval' }
  /** Not out yet: when it is due, and which kind of release. */
  | {
      stage: 'unreleased';
      date: string;
      kind: 'cinemas' | 'digital' | 'physical' | 'airs';
    }
  /**
   * Being searched for; the usual time here, if known. `released` is false
   * when no release date is known, so it can't be called out.
   */
  | {
      stage: 'searching';
      typicalDays?: number;
      released?: boolean;
      /** Which release has happened, for the wording. */
      releasedAs?: 'digital' | 'physical' | 'cinemas' | 'aired';
    }
  | {
      stage: 'downloading';
      minutesLeft?: number;
      /**
       * Why there is no time left to show: nothing is downloading because it is
       * stalled, a torrent is fetching metadata, it is queued or paused in the
       * client, or held by a delay profile; or everything is in and the
       * furthest-behind part is blocked (needs an admin), failed and
       * re-searching, finishing in the client, or importing.
       */
      phase?:
        | 'waiting'
        | 'stalled'
        | 'details'
        | 'queued'
        | 'paused'
        | 'finishing'
        | 'importing'
        | 'held'
        | 'retrying';
    }
  | { stage: 'available' }
  | { stage: 'unknown' };

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKUP_TTL_MS = 10 * 60 * 1000;
const TYPICAL_TTL_MS = 60 * 60 * 1000;
/** Below this many finished requests, "usually" would be a guess. */
const MIN_SAMPLES = 5;
/**
 * Waits after approval longer than this were almost always for a release
 * date, not the search; excluded from "usually takes".
 */
const SEARCH_WINDOW_DAYS = 14;

// ---- Release dates, as the title page shows them --------------------------------

export interface RegionReleases {
  cinemas?: number;
  digital?: number;
  physical?: number;
}

interface TmdbReleaseResults {
  results?: {
    iso_3166_1: string;
    release_dates: { type: number; release_date: string }[];
  }[];
}

/**
 * A region's cinema, digital and physical release dates by the title page's
 * rule: viewer's discover region, else the server's, else US; first date of
 * each of TMDB types 3, 4 and 5. Same dates, so the estimate never disagrees
 * with the page.
 */
export const regionReleases = (
  releaseDates: TmdbReleaseResults | undefined,
  region: string
): RegionReleases => {
  const dates =
    releaseDates?.results?.find((r) => r.iso_3166_1 === region)
      ?.release_dates ?? [];
  const first = (type: number) => {
    const found = dates.find((d) => d.type === type);
    const at = found ? new Date(found.release_date).getTime() : NaN;
    return Number.isNaN(at) ? undefined : at;
  };
  return { cinemas: first(3), digital: first(4), physical: first(5) };
};

export const defaultRegion = () => getSettings().main.discoverRegion || 'US';

// ---- Radarr and Sonarr lookups, cached briefly ------------------------------

interface RadarrDates {
  isAvailable: boolean;
  hasFile: boolean;
  minimumAvailability?: string;
  inCinemas?: string;
  digitalRelease?: string;
  physicalRelease?: string;
}

interface SonarrEpisode {
  seasonNumber: number;
  episodeNumber: number;
  monitored: boolean;
  hasFile: boolean;
  airDateUtc?: string | null;
}

const lookups = new Map<string, { at: number; value: Promise<unknown> }>();
let lastSweep = 0;

/**
 * Drops expired lookups. Otherwise entries were replaced only on a repeat
 * lookup, so every title ever estimated (for a series, Sonarr's whole episode
 * list) stayed in memory for the server's lifetime.
 */
const sweepLookups = () => {
  const now = Date.now();
  if (now - lastSweep < LOOKUP_TTL_MS) {
    return;
  }
  lastSweep = now;
  for (const [key, entry] of lookups) {
    if (now - entry.at >= LOOKUP_TTL_MS) {
      lookups.delete(key);
    }
  }
};

const cached = <T>(key: string, load: () => Promise<T>): Promise<T> => {
  sweepLookups();
  const hit = lookups.get(key);
  if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) {
    return hit.value as Promise<T>;
  }
  const value = load().catch((e) => {
    // Failed lookups aren't cached, so the next call retries.
    lookups.delete(key);
    throw e;
  });
  lookups.set(key, { at: Date.now(), value });
  return value;
};

const radarrMovie = (serverId: number, movieId: number) =>
  cached(`radarr:${serverId}:${movieId}`, async () => {
    const server = getSettings().radarr.find((r) => r.id === serverId);
    if (!server) throw new Error('No such Radarr');
    return (await new RadarrAPI({
      apiKey: server.apiKey,
      url: RadarrAPI.buildUrl(server, '/api/v3'),
    }).getMovie({ id: movieId })) as unknown as RadarrDates;
  });

const sonarrEpisodes = (serverId: number, seriesId: number) =>
  cached(`sonarr:${serverId}:${seriesId}`, async () => {
    const server = getSettings().sonarr.find((s) => s.id === serverId);
    if (!server) throw new Error('No such Sonarr');
    return (await new SonarrAPI({
      apiKey: server.apiKey,
      url: SonarrAPI.buildUrl(server, '/api/v3'),
    }).getEpisodes(seriesId)) as unknown as SonarrEpisode[];
  });

// ---- How long requests usually take here --------------------------------------

let typicalCache: { at: number; value: Map<MediaType, number> } | null = null;

/**
 * Per media type, the 80th-percentile days from approval to arrival on this
 * server. Only waits up to two weeks count, which excludes those waiting on a
 * release date.
 */
export const typicalDays = async (): Promise<Map<MediaType, number>> => {
  if (typicalCache && Date.now() - typicalCache.at < TYPICAL_TTL_MS) {
    return typicalCache.value;
  }

  const events = await getRepository(MediaEvent).find({
    where: {
      type: In([MediaEventType.PROCESSING, MediaEventType.AVAILABLE]),
    },
    order: { occurredAt: 'ASC', id: 'ASC' },
  });

  const started = new Map<string, number>();
  const durations = new Map<MediaType, number[]>();
  for (const event of events) {
    const key = `${event.mediaType}:${event.tmdbId}:${event.is4k}`;
    const at = new Date(event.occurredAt).getTime();
    if (event.type === MediaEventType.PROCESSING) {
      started.set(key, at);
    } else if (started.has(key)) {
      const days = (at - started.get(key)!) / DAY_MS;
      started.delete(key);
      if (days >= 0 && days <= SEARCH_WINDOW_DAYS) {
        const list = durations.get(event.mediaType) ?? [];
        list.push(days);
        durations.set(event.mediaType, list);
      }
    }
  }

  const value = new Map<MediaType, number>();
  for (const [mediaType, list] of durations) {
    if (list.length < MIN_SAMPLES) continue;
    const sorted = [...list].sort((a, b) => a - b);
    const p80 =
      sorted[Math.min(sorted.length - 1, Math.ceil(0.8 * sorted.length) - 1)];
    value.set(mediaType, Math.max(1, Math.ceil(p80)));
  }

  typicalCache = { at: Date.now(), value };
  return value;
};

// ---- The estimate ---------------------------------------------------------------

const future = (date?: string | null): number | null => {
  const at = date ? new Date(date).getTime() : NaN;
  return !Number.isNaN(at) && at > Date.now() ? at : null;
};

type RequestEtaKind = 'cinemas' | 'digital' | 'physical';

export const estimateRequest = async (
  request: MediaRequest,
  /** The viewer's discover region, matching the page's release dates. */
  region: string = defaultRegion()
): Promise<RequestEta> => {
  const media = request.media;
  const is4k = !!request.is4k;

  if (request.status === MediaRequestStatus.PENDING) {
    return { stage: 'awaiting_approval' };
  }
  // Music has no release dates or *arr history to use; the artist being here
  // says nothing about the requested albums.
  if (request.type === MediaType.MUSIC) {
    return {
      stage:
        request.status === MediaRequestStatus.COMPLETED
          ? 'available'
          : 'unknown',
    };
  }
  if (
    request.status === MediaRequestStatus.COMPLETED ||
    media?.[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE
  ) {
    return { stage: 'available' };
  }
  if (request.status !== MediaRequestStatus.APPROVED || !media) {
    return { stage: 'unknown' };
  }

  return estimateTitle(media, is4k, region, {
    seasons: request.seasons,
    requestId: request.id,
  });
};

/**
 * Rough arrival for a title from its own state: what the request part hands
 * over once approved, and the whole estimate for a title processing with no
 * request (added in Radarr or Sonarr directly). Without seasons, the whole
 * series counts.
 */
export const estimateTitle = async (
  media: Media,
  is4k: boolean,
  region: string = defaultRegion(),
  scope: {
    /** Requested seasons and episodes; all when absent. */
    seasons?: MediaRequest['seasons'];
    /** Only for log lines. */
    requestId?: number;
  } = {}
): Promise<RequestEta> => {
  if (media[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE) {
    return { stage: 'available' };
  }

  const downloading = media[is4k ? 'downloadStatus4k' : 'downloadStatus'] ?? [];
  if (downloading.length) {
    // Anything still arriving decides it: the request isn't here until its last
    // part is. Only once every part is in does the next phase show. A copy
    // saved before stages were sent counts as downloading.
    const moving = (stage?: string) => !stage || stage === 'downloading';
    const arriving = downloading.filter(
      (item) =>
        moving(item.stage) ||
        item.stage === 'queued' ||
        item.stage === 'paused' ||
        item.stage === 'stalled' ||
        item.stage === 'waiting'
    );
    if (arriving.length) {
      // A part not downloading has no estimate, so neither has the request; if
      // none is downloading, say why.
      if (!arriving.some((item) => moving(item.stage))) {
        const has = (stage: string, step?: string) =>
          arriving.some(
            (item) => item.stage === stage && (!step || item.step === step)
          );
        return {
          stage: 'downloading',
          phase: has('stalled')
            ? 'stalled'
            : has('queued', 'metadata')
              ? 'details'
              : has('queued')
                ? 'queued'
                : has('paused')
                  ? 'paused'
                  : 'waiting',
        };
      }
      const latest = Math.max(
        ...arriving.map((item) =>
          item.estimatedCompletionTime
            ? new Date(item.estimatedCompletionTime).getTime()
            : NaN
        )
      );
      return {
        stage: 'downloading',
        minutesLeft:
          Number.isFinite(latest) && latest > Date.now()
            ? Math.max(1, Math.round((latest - Date.now()) / 60000))
            : undefined,
      };
    }
    const stages = downloading.map((item) => item.stage);
    return {
      stage: 'downloading',
      phase: stages.includes('needsAttention')
        ? 'held'
        : stages.includes('failed')
          ? 'retrying'
          : stages.includes('finishing')
            ? 'finishing'
            : 'importing',
    };
  }

  const serverId = is4k ? media.serviceId4k : media.serviceId;
  const externalId = is4k ? media.externalServiceId4k : media.externalServiceId;
  const linked = serverId != null && externalId != null;

  const searchingFor = async (): Promise<
    Extract<RequestEta, { stage: 'searching' }>
  > => ({
    stage: 'searching',
    typicalDays: (await typicalDays()).get(media.mediaType),
  });

  if (media.mediaType === MediaType.MOVIE) {
    // Radarr, when reachable, knows if the file is there and which release it
    // waits for. A film Radarr can't answer for still has release dates.
    let movie: RadarrDates | undefined;
    if (linked) {
      try {
        movie = await radarrMovie(serverId, externalId);
      } catch (e) {
        logger.debug('Could not ask Radarr about a request', {
          label: 'Request ETA',
          requestId: scope.requestId,
          errorMessage: e.message,
        });
      }
    }
    if (movie?.hasFile) {
      return { stage: 'available' };
    }

    // The title page's dates; Radarr's only when TMDB has none for the region.
    let dates: RegionReleases = {};
    try {
      dates = regionReleases(
        (await new TheMovieDb().getMovie({ movieId: media.tmdbId }))
          .release_dates,
        region
      );
    } catch {
      // Falls back to Radarr's dates below.
    }
    if (!dates.cinemas && !dates.digital && !dates.physical && movie) {
      const at = (d?: string) => (d ? new Date(d).getTime() : undefined);
      dates = {
        cinemas: at(movie.inCinemas),
        digital: at(movie.digitalRelease),
        physical: at(movie.physicalRelease),
      };
    }

    const now = Date.now();
    const known = (
      [
        ['cinemas', dates.cinemas],
        ['digital', dates.digital],
        ['physical', dates.physical],
      ] as const
    )
      .filter(([, at]) => at !== undefined && !Number.isNaN(at))
      .map(([kind, at]) => ({ kind, at: at as number }));
    const unreleased = (d: { kind: RequestEtaKind; at: number }) =>
      ({
        stage: 'unreleased',
        date: new Date(d.at).toISOString(),
        kind: d.kind,
      }) as const;

    // The awaited release: cinemas for "announced" and "in cinemas"; for
    // "released", the earlier of digital or physical.
    const waitsFor =
      movie?.minimumAvailability ??
      getSettings().radarr.find((r) => r.isDefault && r.is4k === is4k)
        ?.minimumAvailability ??
      'released';
    const wanted = (
      waitsFor === 'released'
        ? known.filter((d) => d.kind !== 'cinemas')
        : known.filter((d) => d.kind === 'cinemas')
    ).sort((a, b) => a.at - b.at)[0];

    if (wanted && wanted.at > now) {
      return unreleased(wanted);
    }
    // Nothing out and the awaited release unknown: the next known date, as
    // "In cinemas Oct 30".
    if (known.length && known.every((d) => d.at > now)) {
      return unreleased(known.sort((a, b) => a.at - b.at)[0]);
    }
    // In cinemas but not yet digital or on disc: a proper release comes with
    // those, so show that date, even if Radarr may already search (minimum
    // availability "announced").
    const atHome = known
      .filter((d) => d.kind !== 'cinemas')
      .sort((a, b) => a.at - b.at);
    const nextAtHome = atHome.find((d) => d.at > now);
    if (nextAtHome && !atHome.some((d) => d.at <= now)) {
      return unreleased(nextAtHome);
    }

    // Out. Only Radarr can say it is being searched for; a film it lacks or
    // can't answer for is not.
    if (!movie) {
      return { stage: 'unknown' };
    }
    if (!known.length) {
      return { ...(await searchingFor()), released: false };
    }
    const out = (kind: RequestEtaKind) =>
      known.some((d) => d.kind === kind && d.at <= now);
    return {
      ...(await searchingFor()),
      releasedAs: out('digital')
        ? 'digital'
        : out('physical')
          ? 'physical'
          : 'cinemas',
    };
  }

  // Sonarr unreachable: TMDB's next episode air date, if the request covers
  // that season.
  const tvFallback = async (): Promise<RequestEta> => {
    try {
      const next = (await new TheMovieDb().getTvShow({ tvId: media.tmdbId }))
        .next_episode_to_air;
      const season = scope.seasons?.find(
        (s) => s.seasonNumber === next?.season_number
      );
      const wanted =
        scope.seasons === undefined ||
        (!!season &&
          (!season.episodes?.length ||
            season.episodes.some(
              (e) => e.episodeNumber === next?.episode_number
            )));
      // TMDB gives a date only; noon UTC keeps it on the same day across
      // American and European time zones.
      const at = next?.air_date
        ? new Date(`${next.air_date}T12:00:00Z`).getTime()
        : NaN;
      return wanted && at > Date.now()
        ? {
            stage: 'unreleased',
            date: new Date(at).toISOString(),
            kind: 'airs',
          }
        : { stage: 'unknown' };
    } catch {
      return { stage: 'unknown' };
    }
  };

  if (!linked) {
    return tvFallback();
  }

  try {
    // Only requested episodes: whole seasons, or named episodes of a season.
    const wanted = new Map<number, Set<number> | 'all'>();
    for (const season of scope.seasons ?? []) {
      wanted.set(
        season.seasonNumber,
        season.episodes?.length
          ? new Set(season.episodes.map((e) => e.episodeNumber))
          : 'all'
      );
    }

    const missing = (await sonarrEpisodes(serverId, externalId)).filter(
      (episode) => {
        // No request, no scope: every season counts.
        const want =
          scope.seasons === undefined
            ? 'all'
            : wanted.get(episode.seasonNumber);
        return (
          !!want &&
          (want === 'all' || want.has(episode.episodeNumber)) &&
          episode.monitored &&
          !episode.hasFile
        );
      }
    );

    if (!missing.length) {
      return { stage: 'available' };
    }

    const upcoming = missing
      .map((episode) => future(episode.airDateUtc))
      .filter((at): at is number => at !== null);
    if (upcoming.length === missing.length) {
      return {
        stage: 'unreleased',
        date: new Date(Math.min(...upcoming)).toISOString(),
        kind: 'airs',
      };
    }
    return { ...(await searchingFor()), releasedAs: 'aired' };
  } catch (e) {
    logger.debug('Could not ask Sonarr about a request', {
      label: 'Request ETA',
      requestId: scope.requestId,
      errorMessage: e.message,
    });
    return tvFallback();
  }
};

/** Tests only. */
export const resetEtaCachesForTests = () => {
  lookups.clear();
  lastSweep = 0;
  typicalCache = null;
};

// ---- The line added to an approval notification -------------------------------

interface TmdbNextEpisode {
  air_date?: string | null;
  season_number?: number;
  episode_number?: number;
}

/**
 * TMDB dates are midnight UTC; in a server time zone west of UTC they'd fall
 * a day early, so they are formatted in UTC.
 */
const approvalDate = (at: number) =>
  new Date(at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
    year:
      new Date(at).getUTCFullYear() === new Date().getUTCFullYear()
        ? undefined
        : 'numeric',
  });

/**
 * "Digital release expected Nov 3" for the approval notification. At approval
 * the title is usually not in Radarr or Sonarr yet, so this reads TMDB by the
 * screens' rule: for a film, the release the default Radarr's minimum
 * availability waits for, earliest anywhere; for a series, the next requested
 * episode due. Nothing when already out or nothing is known.
 */
export const expectedOnApproval = (
  request: MediaRequest,
  tmdb: {
    release_dates?: TmdbReleaseResults;
    next_episode_to_air?: TmdbNextEpisode | null;
  }
): string | undefined => {
  if (request.type === MediaType.MOVIE) {
    // The requester's region, as their title page uses.
    const dates = regionReleases(
      tmdb.release_dates,
      request.requestedBy?.settings?.discoverRegion || defaultRegion()
    );
    const known = (
      [
        ['cinemas', dates.cinemas],
        ['digital', dates.digital],
        ['physical', dates.physical],
      ] as const
    )
      .filter(([, at]) => at !== undefined)
      .map(([kind, at]) => ({ kind, at: at as number }))
      .sort((a, b) => a.at - b.at);
    const waitsFor =
      getSettings().radarr.find(
        (server) => server.isDefault && server.is4k === !!request.is4k
      )?.minimumAvailability ?? 'released';
    const now = Date.now();
    const wanted = known.find((d) =>
      waitsFor === 'released' ? d.kind !== 'cinemas' : d.kind === 'cinemas'
    );
    // As on the screens: the awaited release; else, with nothing out, the first
    // date; else, in cinemas but not at home, the digital or physical date.
    const atHome = known.filter((d) => d.kind !== 'cinemas');
    const next =
      wanted && wanted.at > now
        ? wanted
        : known.length && known.every((d) => d.at > now)
          ? known[0]
          : !atHome.some((d) => d.at <= now)
            ? atHome.find((d) => d.at > now)
            : undefined;
    if (!next) {
      return undefined;
    }
    return next.kind === 'digital'
      ? `Digital release expected ${approvalDate(next.at)}`
      : next.kind === 'physical'
        ? `Physical release expected ${approvalDate(next.at)}`
        : `In cinemas ${approvalDate(next.at)}`;
  }

  const next = tmdb.next_episode_to_air;
  const at = next?.air_date ? new Date(next.air_date).getTime() : NaN;
  if (!next || Number.isNaN(at) || at <= Date.now()) {
    return undefined;
  }
  const season = request.seasons?.find(
    (s) => s.seasonNumber === next.season_number
  );
  const wanted =
    !!season &&
    (!season.episodes?.length ||
      season.episodes.some((e) => e.episodeNumber === next.episode_number));
  return wanted ? `Next requested episode airs ${approvalDate(at)}` : undefined;
};
