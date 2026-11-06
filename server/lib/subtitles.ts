import type {
  BazarrEpisode,
  BazarrHistoryEntry,
  BazarrJobEnd,
  BazarrMissing,
  BazarrMovie,
  BazarrSearchResult,
  BazarrSubtitle,
  JobWatch,
} from '@server/api/bazarr';
import BazarrAPI, {
  WHISPER_PROVIDER,
  bazarrConfigured,
  bazarrJobPoll,
} from '@server/api/bazarr';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type {
  EpisodeSubtitles,
  MissingSubtitle,
  MovieSubtitles,
  NoneFoundOutcome,
  SeriesSubtitles,
  SubtitleError,
  SubtitleOrigin,
  SubtitleSearchResult,
  SubtitleTrack,
  TranscribeScope,
} from '@server/interfaces/api/subtitlesInterfaces';
import type { DVRSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import type { TranscriptionTask } from '@server/lib/transcriber';
import transcriber, { SubtitleProblem } from '@server/lib/transcriber';
import logger from '@server/logger';
import { createHash } from 'node:crypto';

/*
 * Bazarr subtitles for title pages. Bazarr knows a movie by its Radarr id and
 * a series by its Sonarr id, which Seerr stores on the title when it sends a
 * request (its "external service id").
 */

export const subtitlesReady = (): boolean =>
  bazarrConfigured(getSettings().bazarr);

export const bazarr = (): BazarrAPI => new BazarrAPI(getSettings().bazarr);

/**
 * The Radarr or Sonarr server Bazarr follows. Bazarr follows one of each and
 * Seerr can't ask which, so it is assumed to be the main (non-4K) default
 * server, or the only one.
 */
const followedServer = (servers: DVRSettings[]): DVRSettings | undefined => {
  const main = servers.filter((server) => !server.is4k);
  return main.length === 1 ? main[0] : main.find((server) => server.isDefault);
};

/**
 * Bazarr's id for a title: its Radarr or Sonarr id, but only when the title is
 * on the server Bazarr follows. Ids are per server, so the same id from
 * another server names a different title in Bazarr, whose subtitles would be
 * shown, replaced or deleted instead. A title on another server counts as not
 * in Bazarr.
 */
export const bazarrIdOf = (
  media: Pick<Media, 'mediaType' | 'serviceId' | 'externalServiceId'>
): number | undefined => {
  if (!media.externalServiceId) {
    return undefined;
  }
  const settings = getSettings();
  const servers =
    media.mediaType === MediaType.MOVIE
      ? settings.radarr
      : media.mediaType === MediaType.TV
        ? settings.sonarr
        : undefined;
  if (!servers) {
    return undefined;
  }
  const followed = followedServer(servers);
  if (!followed) {
    return undefined;
  }
  // With no recorded server, trust the id only when there is a single main
  // server it could have come from.
  const onFollowed =
    media.serviceId == null
      ? servers.filter((server) => !server.is4k).length === 1
      : media.serviceId === followed.id;
  return onFollowed ? media.externalServiceId : undefined;
};

/**
 * Whether Radarr or Sonarr has the title at all, and Bazarr's id for it when
 * Bazarr can have it.
 */
export const arrIdFor = async (
  mediaType: MediaType,
  tmdbId: number
): Promise<{ inArr: boolean; id?: number }> => {
  const media = await getRepository(Media).findOne({
    where: { tmdbId, mediaType },
  });
  return {
    inArr: !!media?.externalServiceId,
    id: media ? bazarrIdOf(media) : undefined,
  };
};

/** The file name without its server folders. */
export const fileNameOf = (path: string): string =>
  path.split(/[\\/]/).pop() ?? path;

/*
 * Bazarr's history action numbers. A sync changes a subtitle's timing, not its
 * origin; the others say where the file at that path came from, or that it
 * was deleted.
 */
const ACTION_DELETED = 0;
/** Bazarr's own search, a manual pick, or an upgrade. */
const FROM_A_PROVIDER = new Set([1, 2, 3]);
const ACTION_UPLOADED = 4;
const ACTION_TRANSLATED = 6;

export interface FileOrigin {
  origin: SubtitleOrigin;
  provider?: string;
}

/**
 * Origin of each subtitle file by path: the newest action that wrote or
 * deleted it decides. History is newest first. Paths with no such action are
 * omitted.
 */
export const originsOf = (
  history: BazarrHistoryEntry[]
): Map<string, FileOrigin> => {
  const decided = new Set<string>();
  const origins = new Map<string, FileOrigin>();
  for (const entry of history) {
    const path = entry.subtitles_path;
    if (!path || decided.has(path)) {
      continue;
    }
    let origin: FileOrigin | undefined;
    if (FROM_A_PROVIDER.has(entry.action)) {
      origin =
        entry.provider === WHISPER_PROVIDER
          ? { origin: 'transcribed' }
          : {
              origin: 'downloaded',
              ...(entry.provider ? { provider: entry.provider } : {}),
            };
    } else if (entry.action === ACTION_UPLOADED) {
      origin = { origin: 'uploaded' };
    } else if (entry.action === ACTION_TRANSLATED) {
      origin = { origin: 'translated' };
    } else if (entry.action !== ACTION_DELETED) {
      // A sync, or anything else that keeps the file's origin.
      continue;
    }
    decided.add(path);
    if (origin) {
      origins.set(path, origin);
    }
  }
  return origins;
};

/** Subtitle paths whose current file Whisper made. */
export const transcribedPaths = (history: BazarrHistoryEntry[]): Set<string> =>
  new Set(
    [...originsOf(history)]
      .filter(([, origin]) => origin.origin === 'transcribed')
      .map(([path]) => path)
  );

export const toTrack = (
  subtitle: BazarrSubtitle,
  origins: Map<string, FileOrigin>
): SubtitleTrack => {
  const origin = subtitle.path ? origins.get(subtitle.path) : undefined;
  return {
    id: subtitle.id ?? -1,
    language: subtitle.code2,
    ...(subtitle.code3 ? { language3: subtitle.code3 } : {}),
    name: subtitle.name,
    kind: subtitle.path ? 'file' : 'embedded',
    hi: !!subtitle.hi,
    forced: !!subtitle.forced,
    ...(subtitle.path
      ? {
          fileName: fileNameOf(subtitle.path),
          ...(subtitle.file_size ? { size: subtitle.file_size } : {}),
        }
      : {}),
    ai: origin?.origin === 'transcribed',
    ...(origin ?? {}),
  };
};

export const toMissing = (missing: BazarrMissing): MissingSubtitle => ({
  language: missing.code2,
  name: missing.name,
  hi: !!missing.hi,
  forced: !!missing.forced,
});

/** Bazarr's names for what a search result matched on. */
const MATCH_FIELDS = [
  'title',
  'series',
  'year',
  'season',
  'episode',
  'source',
  'resolution',
  'release_group',
  'video_codec',
  'audio_codec',
];

const isTrue = (value: unknown) => String(value).toLowerCase() === 'true';

export const toSearchResult = (
  result: BazarrSearchResult
): SubtitleSearchResult => ({
  provider: result.provider,
  subtitle: result.subtitle,
  language: result.language,
  score: Math.max(0, Math.min(100, Math.round(Number(result.score) || 0))),
  hi: isTrue(result.hearing_impaired),
  forced: isTrue(result.forced),
  originalFormat: isTrue(result.original_format),
  releases: (result.release_info ?? []).filter(Boolean),
  matched: MATCH_FIELDS.filter((field) => result.matches?.includes(field)),
  missed: MATCH_FIELDS.filter((field) => result.dont_matches?.includes(field)),
  ai: result.provider === WHISPER_PROVIDER,
});

/*
 * Manual search offers, by title ("movie:3745", "episode:139851"). Bazarr
 * identifies a result by the provider's pickled subtitle object and unpickles
 * whatever is sent back to download it, so a forged one would run code in
 * Bazarr. Only a result Bazarr itself offered for the same title within the
 * last hour is ever sent back. Only hashes are kept.
 */
const OFFER_TTL_MS = 60 * 60_000;
/** Titles whose offers are kept; least recently searched dropped first. */
const OFFERED_TITLES = 500;
/** Results kept per title across its searches. */
const OFFERS_PER_TITLE = 2000;
const offers = new Map<string, Map<string, number>>();

const offerHash = (choice: { provider: string; subtitle: string }) =>
  createHash('sha256')
    .update(choice.provider)
    .update('\0')
    .update(choice.subtitle)
    .digest('base64');

/** Records the results a search for a title offered. */
export const rememberOffered = (
  title: string,
  results: Pick<BazarrSearchResult, 'provider' | 'subtitle'>[]
): void => {
  const now = Date.now();
  const kept = offers.get(title) ?? new Map<string, number>();
  offers.delete(title);
  for (const [hash, at] of kept) {
    if (now - at >= OFFER_TTL_MS) kept.delete(hash);
  }
  for (const result of results) {
    const hash = offerHash(result);
    kept.delete(hash);
    kept.set(hash, now);
  }
  for (const hash of kept.keys()) {
    if (kept.size <= OFFERS_PER_TITLE) break;
    kept.delete(hash);
  }
  offers.set(title, kept);
  for (const oldest of offers.keys()) {
    if (offers.size <= OFFERED_TITLES) break;
    offers.delete(oldest);
  }
};

/** Whether a recent search for the title offered this result. */
export const wasOffered = (
  title: string,
  choice: { provider: string; subtitle: string }
): boolean => {
  const at = offers.get(title)?.get(offerHash(choice));
  return at !== undefined && Date.now() - at < OFFER_TTL_MS;
};

/** For tests: clears recorded offers. */
export const forgetOffered = () => offers.clear();

/** Each language profile's name and languages. */
const profilesOf = async (api: BazarrAPI) =>
  new Map(
    (await api.getLanguageProfiles()).map((profile) => [
      profile.profileId,
      {
        name: profile.name,
        wanted: [...new Set(profile.items.map((item) => item.language))],
      },
    ])
  );

const profileOf = (
  profiles: Awaited<ReturnType<typeof profilesOf>>,
  profileId: number | null
) => {
  const profile = profileId != null ? profiles.get(profileId) : undefined;
  return { profile: profile?.name ?? null, wanted: profile?.wanted ?? [] };
};

export const movieSubtitles = async (
  radarrId: number
): Promise<MovieSubtitles | undefined> => {
  const api = bazarr();
  const movie = await api.getMovie(radarrId);
  if (!movie) {
    return undefined;
  }
  const [history, profiles] = await Promise.all([
    api.getMovieHistory(radarrId),
    profilesOf(api),
  ]);
  const origins = originsOf(history);
  return {
    ...profileOf(profiles, movie.profileId),
    tracks: (movie.subtitles ?? []).map((subtitle) =>
      toTrack(subtitle, origins)
    ),
    missing: (movie.missing_subtitles ?? []).map(toMissing),
  };
};

/*
 * An episode's subtitle origins are only in its own history, one request per
 * episode. Each answer is cached for a while and dropped as soon as Seerr
 * changes that episode's subtitles.
 */
const HISTORY_TTL_MS = 30 * 60_000;
const HISTORY_CONCURRENCY = 6;
const episodeOrigins = new Map<
  number,
  { at: number; origins: Map<string, FileOrigin> }
>();

export const forgetEpisodeHistory = (sonarrEpisodeId: number) => {
  episodeOrigins.delete(sonarrEpisodeId);
};

const originsForEpisodes = async (
  api: BazarrAPI,
  episodes: BazarrEpisode[]
): Promise<Map<number, Map<string, FileOrigin>>> => {
  const now = Date.now();
  // Drop expired answers so the cache doesn't grow with every episode viewed.
  for (const [id, cached] of episodeOrigins) {
    if (now - cached.at >= HISTORY_TTL_MS) episodeOrigins.delete(id);
  }
  const found = new Map<number, Map<string, FileOrigin>>();
  const toAsk = episodes.filter((episode) => {
    // Only files have an origin.
    if (!(episode.subtitles ?? []).some((subtitle) => subtitle.path)) {
      return false;
    }
    const cached = episodeOrigins.get(episode.sonarrEpisodeId);
    if (cached && now - cached.at < HISTORY_TTL_MS) {
      found.set(episode.sonarrEpisodeId, cached.origins);
      return false;
    }
    return true;
  });

  let next = 0;
  const worker = async () => {
    while (next < toAsk.length) {
      const episode = toAsk[next++];
      try {
        const origins = originsOf(
          await api.getEpisodeHistory(episode.sonarrEpisodeId)
        );
        episodeOrigins.set(episode.sonarrEpisodeId, {
          at: Date.now(),
          origins,
        });
        found.set(episode.sonarrEpisodeId, origins);
      } catch {
        // Unknown for now; retried next time.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HISTORY_CONCURRENCY, toAsk.length) }, worker)
  );
  return found;
};

export const toEpisode = (
  episode: BazarrEpisode,
  origins: Map<string, FileOrigin>
): EpisodeSubtitles => ({
  seasonNumber: episode.season,
  episodeNumber: episode.episode,
  title: episode.title,
  tracks: (episode.subtitles ?? []).map((subtitle) =>
    toTrack(subtitle, origins)
  ),
  missing: (episode.missing_subtitles ?? []).map(toMissing),
});

export const seriesSubtitles = async (
  sonarrSeriesId: number
): Promise<SeriesSubtitles | undefined> => {
  const api = bazarr();
  const [series, episodes, profiles] = await Promise.all([
    api.getSeries(sonarrSeriesId),
    api.getEpisodes(sonarrSeriesId),
    profilesOf(api),
  ]);
  if (!series) {
    return undefined;
  }
  const origins = await originsForEpisodes(api, episodes);
  return {
    ...profileOf(profiles, series.profileId),
    episodes: episodes
      .map((episode) =>
        toEpisode(episode, origins.get(episode.sonarrEpisodeId) ?? new Map())
      )
      .sort(
        (a, b) =>
          a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber
      ),
  };
};

/** Bazarr's episode by the season and episode numbers Seerr shows. */
export const findEpisode = async (
  sonarrSeriesId: number,
  seasonNumber: number,
  episodeNumber: number
): Promise<BazarrEpisode | undefined> =>
  (await bazarr().getEpisodes(sonarrSeriesId)).find(
    (episode) =>
      episode.season === seasonNumber && episode.episode === episodeNumber
  );

/** A search result's language, as Bazarr keys languages ("en"). */
const languageOf = (result: BazarrSearchResult): string =>
  (result.language ?? '').toLowerCase().split(/[^a-z]/)[0];

/**
 * Languages a movie or episode lacks that a transcription can fill without
 * replacing anything: wanted by its profile, with no plain subtitle file.
 * Whisper writes a plain subtitle (not forced or SDH) under the plain file's
 * name, so a language missing only its forced or SDH copy is not a gap.
 */
export const gapsOf = (
  item:
    | Pick<BazarrMovie | BazarrEpisode, 'subtitles' | 'missing_subtitles'>
    | undefined
): string[] => {
  const files = new Set(
    (item?.subtitles ?? [])
      .filter((subtitle) => subtitle.path && !subtitle.forced)
      .map((subtitle) => subtitle.code2)
  );
  return [
    ...new Set(
      (item?.missing_subtitles ?? [])
        .filter((missing) => !missing.forced)
        .map((missing) => missing.code2)
    ),
  ].filter((code) => !files.has(code));
};

/**
 * A search's Whisper result (how Bazarr transcribes). One in a gap language
 * comes first; with `onlyGaps`, it is that or nothing.
 */
export const whisperResult = (
  results: BazarrSearchResult[],
  gaps: string[] = [],
  onlyGaps = false
): BazarrSearchResult | undefined => {
  const whisper = results.filter(
    (result) => result.provider === WHISPER_PROVIDER
  );
  const filling = whisper.find((result) => gaps.includes(languageOf(result)));
  return onlyGaps ? filling : (filling ?? whisper[0]);
};

interface TranscribeOptions {
  /** Queued because a search found nothing: only ever fills a gap. */
  auto?: boolean;
  /** The Whisper result that search offered, so it isn't searched again. */
  known?: BazarrSearchResult;
}

/** Times a transcription lost to a Bazarr restart is requested again. */
const MAX_ASKS = 3;
/** How long Bazarr may take to come back after a restart. */
const BACK_WAIT_MS = 10 * 60_000;

/** Whisper subtitles in a history, keyed by time and path. */
const whisperMarks = (history: BazarrHistoryEntry[]): Set<string> =>
  new Set(
    history
      .filter((entry) => entry.provider === WHISPER_PROVIDER)
      .map((entry) =>
        [entry.parsed_timestamp, entry.subtitles_path, entry.description].join(
          '|'
        )
      )
  );

/** Waits a while for Bazarr to answer again; whether it did. */
const bazarrBack = async (): Promise<boolean> => {
  const until = Date.now() + BACK_WAIT_MS;
  for (;;) {
    if (
      await bazarr()
        .getVersion()
        .then(
          () => true,
          () => false
        )
    ) {
      return true;
    }
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, bazarrJobPoll.ms));
  }
};

/**
 * Transcribes via Bazarr: downloads a search's Whisper result and follows the
 * job until it ends; done once history has a new Whisper subtitle for it. A
 * transcription lost to a Bazarr restart is searched and requested again. One
 * queued because nothing was found first rechecks the gap, as Bazarr's own
 * searches may have filled it meanwhile.
 */
const transcribeWith = async ({
  search,
  download,
  gaps,
  history,
  auto,
  known,
  watch,
}: TranscribeOptions & {
  search: () => Promise<BazarrSearchResult[]>;
  download: (
    result: BazarrSearchResult,
    watch: JobWatch
  ) => Promise<BazarrJobEnd>;
  gaps: () => Promise<string[]>;
  history: () => Promise<BazarrHistoryEntry[]>;
  watch: JobWatch;
}) => {
  for (let ask = 1; ; ask++) {
    // Requested manually, gaps only pick the preferred language.
    const languages = await gaps().catch((e) => {
      if (auto) {
        throw e;
      }
      return [] as string[];
    });
    // After a Bazarr restart its old search result is no longer valid.
    const offered = ask === 1 ? known : undefined;
    if (
      auto &&
      (offered ? !languages.includes(languageOf(offered)) : !languages.length)
    ) {
      return;
    }
    const whisper = offered ?? whisperResult(await search(), languages, auto);
    if (!whisper) {
      const reason = await noWhisperReason();
      throw new SubtitleProblem(reason, whisperProblemText(reason));
    }
    const before = await history().catch(() => undefined);
    const end = await download(whisper, watch);
    const after = await history().catch(() => undefined);
    if (before && after) {
      const seen = whisperMarks(before);
      if ([...whisperMarks(after)].some((mark) => !seen.has(mark))) {
        return;
      }
    } else if (end === 'finished') {
      // Nothing to verify against: take Bazarr's word that it is done.
      return;
    }
    if (end === 'gone' && ask < MAX_ASKS && (await bazarrBack())) {
      logger.info('Bazarr lost a transcription, restarted; asking again', {
        label: 'Subtitles',
      });
      continue;
    }
    if (end === 'timedOut') {
      throw new SubtitleProblem(
        { code: 'bazarrStuck' },
        'Bazarr did not finish the transcription in a day.'
      );
    }
    const reason = await whisperUnavailable();
    throw reason
      ? new SubtitleProblem(reason, whisperProblemText(reason))
      : new SubtitleProblem(
          { code: 'noSubtitleSaved' },
          `Bazarr's transcription ended (${end}) with no subtitle saved.`
        );
  }
};

/**
 * Why Bazarr can't transcribe now, or null when it can (or can't be asked).
 * Usually it paused its WhisperAI provider after a Whisper request timed out
 * (Whisper busy with another job) and offers no Whisper result until the
 * pause ends.
 */
export const whisperUnavailable = async (): Promise<SubtitleError | null> => {
  const providers = await bazarr()
    .getProviderStatus()
    .catch(() => null);
  if (!providers) {
    return null;
  }
  const whisper = providers.find((p) => p.name === WHISPER_PROVIDER);
  if (!whisper) {
    return { code: 'whisperOff' };
  }
  if (whisper.status && whisper.status !== 'Good') {
    return {
      code: 'whisperPaused',
      error: whisper.status,
      ...(whisper.retry && whisper.retry !== '-'
        ? { retry: whisper.retry }
        : {}),
    };
  }
  return null;
};

/** Why a search offered no Whisper result. */
export const noWhisperReason = async (): Promise<SubtitleError> =>
  (await whisperUnavailable()) ?? { code: 'noWhisper' };

/** English text for a Whisper problem, for the log and API. */
export const whisperProblemText = (reason: SubtitleError): string => {
  switch (reason.code) {
    case 'whisperOff':
      return 'WhisperAI is not turned on in Bazarr (Settings → Providers).';
    case 'whisperPaused':
      return `Bazarr paused WhisperAI after an error (${reason.error})${
        reason.retry ? `; it tries again ${reason.retry}` : ''
      }. Whisper may be busy with another job.`;
    default:
      return 'Bazarr offered no Whisper transcription for it.';
  }
};

/** The download request Bazarr gets for a search result. */
export const choiceOf = (result: BazarrSearchResult) => ({
  provider: result.provider,
  subtitle: result.subtitle,
  hi: result.hearing_impaired,
  forced: result.forced,
  originalFormat: result.original_format,
});

/** Episodes in a scope, minus any already transcribed. */
export const episodesToTranscribe = (
  episodes: EpisodeSubtitles[],
  scope: TranscribeScope,
  seasonNumber?: number,
  episodeNumber?: number
): EpisodeSubtitles[] =>
  episodes.filter((episode) => {
    if (episode.tracks.some((track) => track.ai)) {
      return false;
    }
    switch (scope) {
      case 'missing':
        return episode.missing.length > 0;
      case 'season':
        return episode.seasonNumber === seasonNumber;
      case 'episode':
        return (
          episode.seasonNumber === seasonNumber &&
          episode.episodeNumber === episodeNumber
        );
      default:
        return true;
    }
  });

/**
 * Queues a movie's transcription under its title ("movie:603") so the title
 * page shows progress. Returns how many were added.
 */
export const queueMovieTranscription = (
  owner: string,
  radarrId: number,
  options: TranscribeOptions = {}
): number =>
  transcriber.enqueue([
    {
      key: `movie:${radarrId}`,
      owner,
      ...(options.auto ? { auto: true } : {}),
      run: (watch) =>
        transcribeWith({
          ...options,
          watch,
          search: () => bazarr().searchMovie(radarrId),
          download: (whisper, jobWatch) =>
            bazarr().downloadMovie(radarrId, choiceOf(whisper), jobWatch),
          gaps: async () => gapsOf(await bazarr().getMovie(radarrId)),
          history: () => bazarr().getMovieHistory(radarrId),
        }),
    },
  ]);

/** One episode's transcription task. */
const episodeTask = (
  owner: string,
  seriesId: number,
  episode: { sonarrEpisodeId: number; season: number; episode: number },
  options: TranscribeOptions = {}
): TranscriptionTask => {
  const episodeId = episode.sonarrEpisodeId;
  return {
    key: `episode:${episodeId}`,
    owner,
    seasonNumber: episode.season,
    episodeNumber: episode.episode,
    ...(options.auto ? { auto: true } : {}),
    run: async (watch) => {
      try {
        await transcribeWith({
          ...options,
          watch,
          search: () => bazarr().searchEpisode(episodeId),
          download: (whisper, jobWatch) =>
            bazarr().downloadEpisode(
              seriesId,
              episodeId,
              choiceOf(whisper),
              jobWatch
            ),
          history: () => bazarr().getEpisodeHistory(episodeId),
          gaps: async () =>
            gapsOf(
              (await bazarr().getEpisodes(seriesId)).find(
                (e) => e.sonarrEpisodeId === episodeId
              )
            ),
        });
      } finally {
        forgetEpisodeHistory(episodeId);
      }
    },
  };
};

/** Queues a scope's episodes one at a time; returns how many. */
export const queueSeriesTranscription = async (
  owner: string,
  seriesId: number,
  scope: TranscribeScope,
  seasonNumber?: number,
  episodeNumber?: number
): Promise<number> => {
  const [subtitles, episodes] = await Promise.all([
    seriesSubtitles(seriesId),
    bazarr().getEpisodes(seriesId),
  ]);
  const byNumber = new Map(
    episodes.map((e) => [`${e.season}x${e.episode}`, e])
  );
  const tasks = episodesToTranscribe(
    subtitles?.episodes ?? [],
    scope,
    seasonNumber,
    episodeNumber
  ).flatMap((episode): TranscriptionTask[] => {
    const found = byNumber.get(
      `${episode.seasonNumber}x${episode.episodeNumber}`
    );
    return found ? [episodeTask(owner, seriesId, found)] : [];
  });
  return transcriber.enqueue(tasks);
};

// ---- When a search finds nothing -------------------------------------------

/*
 * Whether Bazarr has Whisper on, checked at most once a minute: an empty
 * search is followed by a transcription only when Whisper is available.
 */
const WHISPER_CHECK_MS = 60_000;
let whisperChecked: { at: number; on: boolean } | undefined;

export const whisperOn = async (): Promise<boolean> => {
  if (whisperChecked && Date.now() - whisperChecked.at < WHISPER_CHECK_MS) {
    return whisperChecked.on;
  }
  let on = false;
  try {
    on = (await bazarr().getProviders()).includes(WHISPER_PROVIDER);
  } catch {
    // Unknown: skip this time.
  }
  whisperChecked = { at: Date.now(), on };
  return on;
};

/** For tests: recheck Bazarr next time. */
export const forgetWhisper = () => {
  whisperChecked = undefined;
};

/**
 * After a manual search with no provider result in a language the title
 * lacks, queues a Whisper transcription with that search's result. Never
 * replaces anything on disk: no gap, nothing queued. Undefined when a
 * provider had what was missing.
 */
export const transcribeIfNone = (
  results: BazarrSearchResult[],
  gaps: string[],
  key: string,
  queue: (whisper: BazarrSearchResult) => number
): NoneFoundOutcome | undefined => {
  const found = results.filter(
    (result) => result.provider !== WHISPER_PROVIDER
  );
  if (!gaps.length) {
    return found.length ? undefined : 'notMissing';
  }
  const unfilled = gaps.filter(
    (code) => !found.some((result) => languageOf(result) === code)
  );
  if (!unfilled.length) {
    return undefined;
  }
  const whisper = whisperResult(results, unfilled, true);
  if (!whisper) {
    return 'unavailable';
  }
  if (transcriber.isQueued(key)) {
    return 'alreadyQueued';
  }
  return queue(whisper) ? 'started' : 'alreadyQueued';
};

export const searchMovieOrTranscribe = async (
  owner: string,
  radarrId: number
): Promise<{ results: BazarrSearchResult[]; noneFound?: NoneFoundOutcome }> => {
  const api = bazarr();
  const [results, movie] = await Promise.all([
    api.searchMovie(radarrId),
    api.getMovie(radarrId),
  ]);
  const noneFound = transcribeIfNone(
    results,
    gapsOf(movie),
    `movie:${radarrId}`,
    (known) => queueMovieTranscription(owner, radarrId, { auto: true, known })
  );
  return { results, ...(noneFound ? { noneFound } : {}) };
};

export const searchEpisodeOrTranscribe = async (
  owner: string,
  seriesId: number,
  episode: BazarrEpisode
): Promise<{ results: BazarrSearchResult[]; noneFound?: NoneFoundOutcome }> => {
  const results = await bazarr().searchEpisode(episode.sonarrEpisodeId);
  const noneFound = transcribeIfNone(
    results,
    gapsOf(episode),
    `episode:${episode.sonarrEpisodeId}`,
    (known) =>
      transcriber.enqueue([
        episodeTask(owner, seriesId, episode, { auto: true, known }),
      ])
  );
  return { results, ...(noneFound ? { noneFound } : {}) };
};

/**
 * Bazarr's own search for what a movie is missing, then transcriptions for
 * what it still lacks. Bazarr answers when its search ends, which can take
 * minutes; the title's status shows it searching meanwhile. Returns how many
 * transcriptions were queued.
 */
export const searchMissingMovieOrTranscribe = async (
  owner: string,
  radarrId: number
): Promise<number> => {
  const searched = await transcriber.searching(owner, (watch) =>
    bazarr().searchMissingMovie(radarrId, watch)
  );
  // Results of an unfinished search are unknown.
  if (searched !== 'finished' || !(await whisperOn())) {
    return 0;
  }
  if (!gapsOf(await bazarr().getMovie(radarrId)).length) {
    return 0;
  }
  return queueMovieTranscription(owner, radarrId, { auto: true });
};

/** Same for a series: each episode still lacking one is transcribed. */
export const searchMissingSeriesOrTranscribe = async (
  owner: string,
  seriesId: number
): Promise<number> => {
  const searched = await transcriber.searching(owner, (watch) =>
    bazarr().searchMissingSeries(seriesId, watch)
  );
  const episodes = await bazarr().getEpisodes(seriesId);
  // The search's downloads change those episodes' subtitle origins.
  episodes.forEach((episode) => forgetEpisodeHistory(episode.sonarrEpisodeId));
  // Results of an unfinished search are unknown.
  if (searched !== 'finished' || !(await whisperOn())) {
    return 0;
  }
  return transcriber.enqueue(
    episodes
      .filter((episode) => gapsOf(episode).length > 0)
      .sort((a, b) => a.season - b.season || a.episode - b.episode)
      .map((episode) => episodeTask(owner, seriesId, episode, { auto: true }))
  );
};
