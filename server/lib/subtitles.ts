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

/*
 * Subtitles as Bazarr has them, for title pages. Bazarr knows a movie by
 * its Radarr id and a series by its Sonarr id, which Seerr records on the
 * title when it sends a request (its "external service id").
 */

export const subtitlesReady = (): boolean =>
  bazarrConfigured(getSettings().bazarr);

export const bazarr = (): BazarrAPI => new BazarrAPI(getSettings().bazarr);

/**
 * The Radarr or Sonarr server Bazarr follows. Bazarr follows one of each,
 * and Seerr cannot ask which, so it is taken to be the main (not 4K) server
 * new requests go to: the one marked default, or the only one there is.
 */
const followedServer = (servers: DVRSettings[]): DVRSettings | undefined => {
  const main = servers.filter((server) => !server.is4k);
  return main.length === 1 ? main[0] : main.find((server) => server.isDefault);
};

/**
 * The id Bazarr knows a title by: the one Radarr or Sonarr gave it, but only
 * when the title is on the server Bazarr follows. Each server numbers its
 * titles on its own, so the same id on another server names some other
 * title in Bazarr, whose subtitles would be shown, replaced or deleted
 * instead. A title on another server counts as not in Bazarr.
 */
export const bazarrIdOf = (
  media: Pick<Media, 'mediaType' | 'serviceId' | 'externalServiceId'>
): number | undefined => {
  if (!media.externalServiceId) {
    return undefined;
  }
  const settings = getSettings();
  const servers =
    media.mediaType === MediaType.MOVIE ? settings.radarr : settings.sonarr;
  const followed = followedServer(servers);
  if (!followed) {
    return undefined;
  }
  // Without a record of its server, the id can only be trusted when there
  // is a single main server it could have come from.
  const onFollowed =
    media.serviceId == null
      ? servers.filter((server) => !server.is4k).length === 1
      : media.serviceId === followed.id;
  return onFollowed ? media.externalServiceId : undefined;
};

/**
 * A title Seerr has: whether Radarr or Sonarr has it at all, and the id
 * Bazarr knows it by, when Bazarr can have it.
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

/** The file's name, without the folders it is in on the server. */
export const fileNameOf = (path: string): string =>
  path.split(/[\\/]/).pop() ?? path;

/*
 * Bazarr's history actions, as it numbers them. A sync changes the timing
 * of a subtitle, not where it came from; the others say where the file at
 * that path came from, or that it was deleted.
 */
const ACTION_DELETED = 0;
/** Downloaded by Bazarr's own search, chosen by hand, or an upgrade. */
const FROM_A_PROVIDER = new Set([1, 2, 3]);
const ACTION_UPLOADED = 4;
const ACTION_TRANSLATED = 6;

export interface FileOrigin {
  origin: SubtitleOrigin;
  provider?: string;
}

/**
 * Where each subtitle file came from, by path: for each path, the newest
 * action that put a file there (or deleted it) decides. History comes
 * newest first. A path with no such action is left out.
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
      // A sync, or anything else that leaves the file as it came.
      continue;
    }
    decided.add(path);
    if (origin) {
      origins.set(path, origin);
    }
  }
  return origins;
};

/** The subtitle files, by path, whose current copy Whisper made. */
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

/** What Bazarr matched a search result on, by the names it uses. */
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

/** Each language profile's name, and the languages it asks for. */
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
 * Where an episode's subtitle came from is only in its own history, one
 * request per episode. Each episode's answer is kept for a
 * while, and dropped as soon as Seerr changes that episode's subtitles.
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
  const found = new Map<number, Map<string, FileOrigin>>();
  const toAsk = episodes.filter((episode) => {
    // Only a file has an origin to tell.
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
        // Unknown for now; asked again next time.
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

/** Bazarr's episode, by the season and episode numbers Seerr shows. */
export const findEpisode = async (
  sonarrSeriesId: number,
  seasonNumber: number,
  episodeNumber: number
): Promise<BazarrEpisode | undefined> =>
  (await bazarr().getEpisodes(sonarrSeriesId)).find(
    (episode) =>
      episode.season === seasonNumber && episode.episode === episodeNumber
  );

/** The language of a search result, as Bazarr keys languages ("en"). */
const languageOf = (result: BazarrSearchResult): string =>
  (result.language ?? '').toLowerCase().split(/[^a-z]/)[0];

/**
 * The languages a movie or episode lacks that a transcription can fill
 * without replacing anything: a language its profile wants, with no plain
 * subtitle file in it. Whisper writes a plain subtitle (neither forced nor
 * SDH), under the same name a plain file in that language has, so a
 * language with only its forced or SDH copy missing is not one.
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
 * The Whisper result of a search: what transcribing means to Bazarr. One
 * in a language that is a gap comes first; with `onlyGaps`, it is that or
 * nothing.
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
  /** Queued because a search found nothing: it only ever fills a gap. */
  auto?: boolean;
  /** The Whisper result that search offered, so it is not asked again. */
  known?: BazarrSearchResult;
}

/** Times a transcription Bazarr lost (by restarting) is asked for again. */
const MAX_ASKS = 3;
/** How long Bazarr may take to come back after it restarts. */
const BACK_WAIT_MS = 10 * 60_000;

/** Each Whisper subtitle in a history, told apart by when and where. */
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

/** Waits until Bazarr answers again, for a while; whether it did. */
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
 * Bazarr's way to transcribe: download the Whisper result of a search, and
 * follow Bazarr's job until it ends. It is done once Bazarr's history has
 * a new Whisper subtitle for it. A transcription Bazarr lost, by being
 * restarted, is searched for and asked for again; one queued because
 * nothing was found checks first that the gap is still there, as Bazarr's
 * own searches may have filled it meanwhile.
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
    // Asked for by hand, the gaps only say which language to prefer.
    const languages = await gaps().catch((e) => {
      if (auto) {
        throw e;
      }
      return [] as string[];
    });
    // Its search result is Bazarr's no longer once Bazarr restarted.
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
      // Nothing to check it by: Bazarr says it is done.
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
 * Why Bazarr cannot transcribe right now, or null when it can (or cannot
 * be asked). Most often it paused its WhisperAI provider after a request
 * to Whisper timed out (Whisper busy with another job), and offers no
 * Whisper result until the pause is over.
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

/** A reason Whisper cannot be used, in English, for the log and the API. */
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

/** What Bazarr is told to download for a search result. */
export const choiceOf = (result: BazarrSearchResult) => ({
  provider: result.provider,
  subtitle: result.subtitle,
  hi: result.hearing_impaired,
  forced: result.forced,
  originalFormat: result.original_format,
});

/** The episodes a scope covers, leaving out any already transcribed. */
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
 * Queues a movie's transcription under its title ("movie:603"), so the
 * title page shows its progress. Returns how many were added.
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

/** One episode's transcription, for the queue. */
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

/** Queues the episodes a scope covers, one at a time; returns how many. */
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
 * Whether Bazarr has Whisper turned on, asked at most once a minute: a
 * search that found nothing is followed by a transcription only when there
 * is something to transcribe with.
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
    // Unknown: not this time.
  }
  whisperChecked = { at: Date.now(), on };
  return on;
};

/** For tests: ask Bazarr again. */
export const forgetWhisper = () => {
  whisperChecked = undefined;
};

/**
 * After a manual search: when no provider had a subtitle in a language the
 * title lacks, Whisper's transcription is queued for it instead, with the
 * result that search offered. Nothing on disk is ever replaced: with no gap
 * nothing is queued. Undefined when a provider had what was missing.
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
 * Bazarr's own search for what a movie is missing, then a transcription of
 * whatever it still lacks. Bazarr answers once its search is over, which
 * can take minutes; the title's status says it is searching meanwhile.
 * Returns how many transcriptions were queued.
 */
export const searchMissingMovieOrTranscribe = async (
  owner: string,
  radarrId: number
): Promise<number> => {
  const searched = await transcriber.searching(owner, () =>
    bazarr().searchMissingMovie(radarrId)
  );
  // What a search Bazarr did not finish would have found is not known.
  if (searched !== 'finished' || !(await whisperOn())) {
    return 0;
  }
  if (!gapsOf(await bazarr().getMovie(radarrId)).length) {
    return 0;
  }
  return queueMovieTranscription(owner, radarrId, { auto: true });
};

/** The same for a series: each episode still lacking one is transcribed. */
export const searchMissingSeriesOrTranscribe = async (
  owner: string,
  seriesId: number
): Promise<number> => {
  const searched = await transcriber.searching(owner, () =>
    bazarr().searchMissingSeries(seriesId)
  );
  const episodes = await bazarr().getEpisodes(seriesId);
  // What the search downloaded changes where their subtitles came from.
  episodes.forEach((episode) => forgetEpisodeHistory(episode.sonarrEpisodeId));
  // What a search Bazarr did not finish would have found is not known.
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
