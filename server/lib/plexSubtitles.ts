import PlexTvAPI from '@server/api/plextv';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import type {
  PlexSubtitleDefault,
  PlexSubtitleOption,
} from '@server/interfaces/api/subtitlesInterfaces';
import { isConnected } from '@server/lib/mediaServers';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { AxiosInstance } from 'axios';
import axios from 'axios';

/*
 * Which subtitle someone's own Plex player starts with. Plex keeps that
 * choice per person and per video, so it is read and set with that person's
 * own access to the server: plex.tv lists the servers they can use, with a
 * token for each. Setting it for a series sets it on every episode.
 */

const PLEX_TIMEOUT_MS = 10_000;
/** Server tokens from plex.tv, kept for a while. */
const TOKEN_TTL_MS = 60 * 60_000;
const EPISODE_CONCURRENCY = 3;

const SUBTITLE_STREAM = 3;

interface PlexStream {
  id: number;
  streamType: number;
  languageCode?: string;
  language?: string;
  displayTitle?: string;
  extendedDisplayTitle?: string;
  selected?: boolean | number | string;
  forced?: boolean | number | string;
  hearingImpaired?: boolean | number | string;
  /** Set for a file beside the video. */
  key?: string;
}

interface PlexPart {
  id: number;
  Stream?: PlexStream[];
}

interface PlexItem {
  ratingKey: string;
  index?: number;
  parentIndex?: number;
  Media?: { Part?: PlexPart[] }[];
}

interface PlexAnswer {
  MediaContainer?: { Metadata?: PlexItem[] };
}

const yes = (value: unknown) =>
  value === true || value === 1 || value === '1' || value === 'true';

/** By person: their token, and the server (machine id) it is for. */
const tokens = new Map<
  number,
  { at: number; machineId: string; token: string }
>();

/** The person's own token for this Plex server, if they have one. */
const serverToken = async (userId: number): Promise<string | undefined> => {
  const settings = getSettings();
  const { machineId } = settings.plex;
  if (!isConnected('plex') || !machineId) {
    return undefined;
  }
  // A token for a server Seerr has since moved off is never sent to the new.
  const cached = tokens.get(userId);
  if (
    cached &&
    cached.machineId === machineId &&
    Date.now() - cached.at < TOKEN_TTL_MS
  ) {
    return cached.token;
  }
  const user = await getRepository(User).findOne({
    where: { id: userId },
    select: ['id', 'plexToken'],
  });
  if (!user?.plexToken) {
    return undefined;
  }
  const server = (await new PlexTvAPI(user.plexToken).getDevices()).find(
    (device) => device.clientIdentifier === machineId
  );
  if (!server?.accessToken) {
    return undefined;
  }
  tokens.set(userId, { at: Date.now(), machineId, token: server.accessToken });
  return server.accessToken;
};

const plexFor = (token: string): AxiosInstance => {
  const settings = getSettings();
  return axios.create({
    baseURL: `${settings.plex.useSsl ? 'https' : 'http'}://${
      settings.plex.ip
    }:${settings.plex.port}`,
    timeout: PLEX_TIMEOUT_MS,
    headers: {
      'X-Plex-Token': token,
      'X-Plex-Client-Identifier': settings.clientId,
      'X-Plex-Product': 'Seerr',
      Accept: 'application/json',
    },
  });
};

const itemOf = async (plex: AxiosInstance, ratingKey: string) => {
  const { data } = await plex.get<PlexAnswer>(`/library/metadata/${ratingKey}`);
  return data.MediaContainer?.Metadata?.[0];
};

const partOf = (item?: PlexItem): PlexPart | undefined =>
  item?.Media?.[0]?.Part?.[0];

const subtitlesOf = (part?: PlexPart): PlexStream[] =>
  (part?.Stream ?? []).filter(
    (stream) => stream.streamType === SUBTITLE_STREAM
  );

const optionOf = (stream: PlexStream): PlexSubtitleOption => ({
  id: stream.id,
  title:
    stream.extendedDisplayTitle ??
    stream.displayTitle ??
    stream.language ??
    String(stream.id),
  ...(stream.languageCode ? { language: stream.languageCode } : {}),
  external: !!stream.key,
});

const selectStream = (plex: AxiosInstance, partId: number, streamId: number) =>
  plex.put(`/library/parts/${partId}`, null, {
    params: { subtitleStreamID: streamId, allParts: 1 },
  });

const UNAVAILABLE: PlexSubtitleDefault = {
  available: false,
  options: [],
  selected: 0,
};

export const movieDefault = async (
  userId: number,
  ratingKey: string
): Promise<PlexSubtitleDefault> => {
  const token = await serverToken(userId);
  if (!token) {
    return UNAVAILABLE;
  }
  const streams = subtitlesOf(partOf(await itemOf(plexFor(token), ratingKey)));
  return {
    available: true,
    options: streams.map(optionOf),
    selected: streams.find((stream) => yes(stream.selected))?.id ?? 0,
  };
};

export const setMovieDefault = async (
  userId: number,
  ratingKey: string,
  streamId: number
): Promise<boolean> => {
  const token = await serverToken(userId);
  if (!token) {
    return false;
  }
  const plex = plexFor(token);
  const part = partOf(await itemOf(plex, ratingKey));
  if (
    !part ||
    (streamId !== 0 &&
      !subtitlesOf(part).some((stream) => stream.id === streamId))
  ) {
    return false;
  }
  await selectStream(plex, part.id, streamId);
  return true;
};

const episodesOf = async (plex: AxiosInstance, showKey: string) => {
  const { data } = await plex.get<PlexAnswer>(
    `/library/metadata/${showKey}/allLeaves`
  );
  return (data.MediaContainer?.Metadata ?? []).sort(
    (a, b) =>
      (a.parentIndex ?? 0) - (b.parentIndex ?? 0) ||
      (a.index ?? 0) - (b.index ?? 0)
  );
};

/** The best of a language's subtitles to start with: plain over forced or SDH. */
export const pickStream = (
  streams: PlexStream[],
  language: string
): PlexStream | undefined => {
  const ofLanguage = streams.filter(
    (stream) => stream.languageCode === language
  );
  return (
    ofLanguage.find(
      (stream) => !yes(stream.forced) && !yes(stream.hearingImpaired)
    ) ??
    ofLanguage.find((stream) => !yes(stream.forced)) ??
    ofLanguage[0]
  );
};

/**
 * A series is set by language. What it is set to now is read from its
 * latest episode, the one most likely to be played next.
 */
export const seriesDefault = async (
  userId: number,
  showKey: string
): Promise<PlexSubtitleDefault> => {
  const token = await serverToken(userId);
  if (!token) {
    return UNAVAILABLE;
  }
  const plex = plexFor(token);
  const latest = (await episodesOf(plex, showKey)).pop();
  if (!latest) {
    return { available: true, options: [], selected: '', languages: [] };
  }
  const streams = subtitlesOf(partOf(await itemOf(plex, latest.ratingKey)));
  const languages = new Map<string, string>();
  for (const stream of streams) {
    if (stream.languageCode && !languages.has(stream.languageCode)) {
      languages.set(
        stream.languageCode,
        stream.language ?? stream.languageCode
      );
    }
  }
  return {
    available: true,
    options: [],
    selected:
      streams.find((stream) => yes(stream.selected))?.languageCode ?? '',
    languages: [...languages].map(([code, title]) => ({ code, title })),
  };
};

/*
 * The pass setting each person's series, by "user:show", numbered. A new
 * choice for the same series starts a new pass, and the one before stops
 * before its next write, so the episodes all end up with the latest choice
 * rather than a mix of the two.
 */
const seriesPasses = new Map<string, number>();
let passCount = 0;

/**
 * Sets every episode to the language given (or to none), in the
 * background. Returns how many episodes it will go through, or undefined
 * without a Plex sign-in to use.
 */
export const setSeriesDefault = async (
  userId: number,
  showKey: string,
  language: string
): Promise<number | undefined> => {
  // Numbered as it is asked, before anything is awaited, so the order of
  // the choices is the order they were made in.
  const passKey = `${userId}:${showKey}`;
  const pass = ++passCount;
  seriesPasses.set(passKey, pass);
  const superseded = () => seriesPasses.get(passKey) !== pass;
  const finished = () => {
    if (!superseded()) {
      seriesPasses.delete(passKey);
    }
  };

  let plex: AxiosInstance;
  let episodes: PlexItem[];
  try {
    const token = await serverToken(userId);
    if (!token) {
      finished();
      return undefined;
    }
    plex = plexFor(token);
    episodes = await episodesOf(plex, showKey);
  } catch (e) {
    finished();
    throw e;
  }

  let next = 0;
  const worker = async () => {
    while (next < episodes.length && !superseded()) {
      const episode = episodes[next++];
      try {
        const part = partOf(await itemOf(plex, episode.ratingKey));
        if (!part) {
          continue;
        }
        const stream = language
          ? pickStream(subtitlesOf(part), language)
          : undefined;
        // An episode without that language is left as it is.
        if (language && !stream) {
          continue;
        }
        if (superseded()) {
          return;
        }
        await selectStream(plex, part.id, stream?.id ?? 0);
      } catch (e) {
        logger.warn('Could not set an episode’s subtitle in Plex', {
          label: 'Subtitles',
          ratingKey: episode.ratingKey,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    }
  };
  void Promise.all(
    Array.from(
      { length: Math.min(EPISODE_CONCURRENCY, episodes.length) },
      worker
    )
  ).finally(finished);
  return episodes.length;
};
