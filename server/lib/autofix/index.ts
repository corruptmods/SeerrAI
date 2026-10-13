import type { BazarrSearchResult, BazarrSubtitle } from '@server/api/bazarr';
import { WHISPER_PROVIDER } from '@server/api/bazarr';
import { IssueType } from '@server/constants/issue';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type { BackfillKind } from '@server/entity/BackfillSeries';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import type Media from '@server/entity/Media';
import type { User } from '@server/entity/User';
import agent from '@server/lib/agent';
import type {
  ArrEpisode,
  ArrFile,
  ArrHistoryRecord,
  ArrRelease,
} from '@server/lib/autofix/arr';
import { FixRadarr, FixSonarr } from '@server/lib/autofix/arr';
import backfill from '@server/lib/backfill/engine';
import { featureEnabled } from '@server/lib/features';
import { owner } from '@server/lib/owner';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import {
  bazarr,
  bazarrIdOf,
  choiceOf,
  findEpisode,
  forgetEpisodeHistory,
  queueMovieTranscription,
  queueSeriesTranscription,
  searchMissingSeriesOrTranscribe,
  subtitlesReady,
} from '@server/lib/subtitles';
import logger from '@server/logger';

/*
 * Fixing what someone says is wrong with a title, as an admin would: find
 * subtitles (or transcribe them), look for missing episodes, replace a
 * broken file with a different release, or check a season whose episodes
 * are mixed up. Asked for from AI Search or by reporting an issue; on an
 * issue, each step is written as a comment, which tells the reporter.
 *
 * A file is only ever removed once another release for it has been found,
 * and the same title is replaced at most once a day.
 */

const LABEL = 'Auto-fix';
/** Said when the admin agent will look further, should nothing turn up. */
const agentAfter = (req: { issueId?: number }) =>
  req.issueId
    ? ' If nothing turns up, the admin agent looks further and answers here.'
    : ' If nothing turns up, the admin agent looks further.';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** The most episodes one "wrong episode" report replaces. */
const MAX_REPLACED = 6;
/** Files one person (not an admin) can have replaced in a day. */
const MAX_REPLACED_PER_DAY = 10;
const TOO_MANY =
  'You have had as many files replaced today as allowed. An admin can replace more, or try again tomorrow.';
/** Fixes of any kind one person (not an admin) can ask for in a day. */
const MAX_FIXES_PER_DAY = 30;
/** The most episodes of a season checked against where they came from. */
const MAX_CHECKED = 60;

export type FixKind =
  | 'subtitles'
  | 'transcribe'
  | 'missing'
  | 'broken'
  | 'wrongEpisode';

export const FIX_KINDS: FixKind[] = [
  'subtitles',
  'transcribe',
  'missing',
  'broken',
  'wrongEpisode',
];

export interface FixRequest {
  kind: FixKind;
  media: Media;
  seasonNumber?: number;
  episodeNumber?: number;
  /** Two-letter language code, for subtitles. */
  language?: string;
  /** For subtitles: the ones there are wrong, not merely missing. */
  replace?: boolean;
  /** Who asked: their limits apply, and what they may see is shown. */
  user: User;
  /** The issue it was reported on, to answer there. */
  issueId?: number;
}

export interface FixResult {
  kind: FixKind;
  ok: boolean;
  message: string;
  /** A page in Seerr that follows what was started. */
  link?: string;
  /** Nothing applied (the title is not on the server): say nothing. */
  skipped?: boolean;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** An error whose message is fit to show the person who asked. */
class Shown extends Error {}
const pad = (n: number) => String(n).padStart(2, '0');
const label = (s?: number, e?: number) =>
  s === undefined
    ? ''
    : e === undefined
      ? `season ${s}`
      : `S${pad(s)}E${pad(e)}`;

const LANGUAGES: Record<string, string> = {
  english: 'en',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  italian: 'it',
  portuguese: 'pt',
  brazilian: 'pt',
  dutch: 'nl',
  swedish: 'sv',
  norwegian: 'no',
  danish: 'da',
  finnish: 'fi',
  polish: 'pl',
  russian: 'ru',
  ukrainian: 'uk',
  turkish: 'tr',
  greek: 'el',
  arabic: 'ar',
  hebrew: 'he',
  hindi: 'hi',
  japanese: 'ja',
  korean: 'ko',
  chinese: 'zh',
  vietnamese: 'vi',
  thai: 'th',
  indonesian: 'id',
};

/** The language named first in the text, as a two-letter code. */
const languageIn = (text: string): string | undefined => {
  const lower = text.toLowerCase();
  let first: { at: number; code: string } | undefined;
  for (const [name, code] of Object.entries(LANGUAGES)) {
    const at = lower.search(new RegExp(`\\b${name}\\b`));
    if (at !== -1 && (!first || at < first.at)) first = { at, code };
  }
  return first?.code;
};

/** The wrong episode or film: named as such, never just "wrong". */
const WRONG_EPISODE =
  /\b(wrong|different|incorrect)\s+(episode|ep|movie|film)\b|\bnot the (right|correct|same) (episode|ep|movie|film)\b|\b(episodes?|eps?)\b[^.]{0,30}\b(mislabel+ed|mixed[ -]?up|out of order|swapped)\b|\b(mislabel+ed|mixed[ -]?up|swapped)\b[^.]{0,30}\b(episodes?|eps?)\b|\bis actually (episode|ep)\b|\bplays (episode|ep)\b/i;
const MISSING =
  /\b(missing|lost|absent)\s+episodes?\b|\bepisodes?\s+(are\s+|is\s+)?(missing|lost|gone|not (there|available))\b/i;
const TRANSCRIBE = /\b(transcri\w*|whisper)\b/i;
const SUBTITLE = /\b(sub(title)?s|subtitle|captions?|cc)\b/i;
const SUBTITLE_WRONG =
  /\b(sync|timing|off|late|early|wrong|bad|garbled|another language|different language|don'?t match)\b/i;
const BROKEN =
  /\b(broken|corrupt\w*|won'?t (play|load|start)|doesn'?t (play|load|work)|can'?t (play|watch)|no (sound|audio|picture|video)|black screen|green screen|stutter\w*|freez\w*|glitch\w*|pixelat\w*|artifact\w*|cuts? (out|off)|audio (is )?(out of sync|missing|wrong)|bad (quality|file|copy|encode))\b/i;

/**
 * What a report or request asks to have fixed, from its words and, for an
 * issue, its type. A subtitle issue is only ever about subtitles; a video or
 * audio issue is about the file unless it names the wrong episode. Nothing
 * when it is not clear.
 */
export const classify = (
  text: string,
  issueType?: IssueType
): { kind: FixKind; language?: string; replace?: boolean } | undefined => {
  const language = languageIn(text);
  const subtitles = (): {
    kind: FixKind;
    language?: string;
    replace?: boolean;
  } =>
    TRANSCRIBE.test(text)
      ? { kind: 'transcribe', language }
      : {
          kind: 'subtitles',
          language,
          replace:
            issueType === IssueType.SUBTITLES || SUBTITLE_WRONG.test(text)
              ? true
              : undefined,
        };
  if (issueType === IssueType.SUBTITLES) return subtitles();
  if (WRONG_EPISODE.test(text)) return { kind: 'wrongEpisode' };
  if (issueType === IssueType.VIDEO || issueType === IssueType.AUDIO) {
    return { kind: 'broken' };
  }
  if (MISSING.test(text) && !SUBTITLE.test(text)) return { kind: 'missing' };
  if (TRANSCRIBE.test(text) || SUBTITLE.test(text)) return subtitles();
  if (BROKEN.test(text)) return { kind: 'broken' };
  return undefined;
};

/** The server and id a title has there; the 4K one only when that is all. */
const serviceOf = (media: Media) =>
  !media.externalServiceId && media.externalServiceId4k
    ? { serverId: media.serviceId4k, id: media.externalServiceId4k }
    : { serverId: media.serviceId, id: media.externalServiceId };

const sonarrFor = (media: Media) => {
  const { serverId, id } = serviceOf(media);
  const server = getSettings().sonarr.find((s) => s.id === serverId);
  return server && id
    ? { api: FixSonarr.forServer(server), id, serverId: server.id }
    : undefined;
};

const radarrFor = (media: Media) => {
  const { serverId, id } = serviceOf(media);
  const server = getSettings().radarr.find((s) => s.id === serverId);
  return server && id
    ? { api: FixRadarr.forServer(server), id, serverId: server.id }
    : undefined;
};

const isAdmin = (user: User) => user.hasPermission(Permission.ADMIN);

const NOT_ON_SERVER: Omit<FixResult, 'kind'> = {
  ok: false,
  skipped: true,
  message:
    'This title is not in Sonarr or Radarr yet, so there is nothing on the server to fix.',
};

const NOT_IN_BAZARR: Omit<FixResult, 'kind'> = {
  ok: false,
  skipped: true,
  message:
    'This title is on a Radarr or Sonarr that Bazarr does not follow, so its subtitles cannot be fixed here.',
};

const NO_BAZARR = (what: string): Omit<FixResult, 'kind'> => ({
  ok: false,
  skipped: true,
  message: `Bazarr is not set up, so ${what}.`,
});

const ASK_SEASON: Omit<FixResult, 'kind'> = {
  ok: false,
  message: 'Which season is that episode in?',
};

const needsSeason = (req: FixRequest) =>
  req.media.mediaType === MediaType.TV &&
  req.episodeNumber !== undefined &&
  req.seasonNumber === undefined;

const grabbedFrom = (release: ArrRelease) =>
  `${release.title}${release.indexer ? ` from ${release.indexer}` : ''}`;

/** One file swapped for another release, through Sonarr or Radarr. */
interface Swap {
  /** "S01E02", or nothing for a movie. */
  name?: string;
  app: 'Sonarr' | 'Radarr';
  episodeId?: number;
  current: () => Promise<{ title?: string; group?: string | null }>;
  releases: () => Promise<ArrRelease[]>;
  remove: () => Promise<void>;
  grab: (release: ArrRelease) => Promise<void>;
  search: () => Promise<void>;
}

/** Rejections that only say the file on disk is as good: fine to replace. */
const ONLY_EXISTING =
  /existing file|equal or higher preference|not an upgrade|cutoff (has been |already )?(met|reached)|already meets cutoff/i;

const rejectionText = (r: string | { reason?: string }) =>
  typeof r === 'string' ? r : (r.reason ?? '');

const groupOf = (title?: string | null) =>
  (
    title?.match(/^\s*\[([^\]]+)\]/)?.[1] ??
    title?.match(/-([A-Za-z0-9]+)$/)?.[1] ??
    ''
  ).toLowerCase();

const bare = (title: string) =>
  title
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

const sameTitle = (a?: string | null, b?: string | null) =>
  !!a && !!b && bare(a) === bare(b);

/**
 * The best other release for one episode or movie: one Sonarr or Radarr
 * would only turn down because a file is already there, for that episode
 * alone (a release holding others too would not import over their files),
 * never the release the current file came from, a different group first.
 */
export const pickReplacement = (
  releases: ArrRelease[],
  current: { title?: string | null; group?: string | null },
  episodeId?: number
): ArrRelease | undefined => {
  const currentGroup = (current.group ?? groupOf(current.title)).toLowerCase();
  const forThisEpisode = (r: ArrRelease) => {
    if (episodeId === undefined) return true;
    const mapped = r.mappedEpisodeInfo ?? [];
    return mapped.length
      ? mapped.length === 1 && mapped[0].id === episodeId
      : !!r.episodeRequested;
  };
  const usable = releases.filter(
    (r) =>
      r.downloadAllowed !== false &&
      !r.fullSeason &&
      (!r.rejected ||
        (r.rejections ?? []).every((x) =>
          ONLY_EXISTING.test(rejectionText(x))
        )) &&
      forThisEpisode(r) &&
      !sameTitle(r.title, current.title)
  );
  const differs = (r: ArrRelease) =>
    !!currentGroup &&
    (r.releaseGroup ?? groupOf(r.title)).toLowerCase() !== currentGroup;
  return usable.sort(
    (a, b) =>
      Number(differs(b)) - Number(differs(a)) ||
      (b.qualityWeight ?? 0) - (a.qualityWeight ?? 0) ||
      (b.customFormatScore ?? 0) - (a.customFormatScore ?? 0) ||
      (b.seeders ?? 0) - (a.seeders ?? 0)
  )[0];
};

/** Where the file on disk came from: the release's own name, if known. */
const originOf = (
  file: ArrFile | undefined,
  history: ArrHistoryRecord[]
): string | undefined => {
  const imported = history.find(
    (h) =>
      h.eventType === 'downloadFolderImported' &&
      (!file || String(h.data?.fileId ?? '') === String(file.id))
  );
  const dropped = imported?.data?.droppedPath?.split(/[\\/]/).pop();
  return file?.sceneName || dropped || imported?.sourceTitle || undefined;
};

/** "S05E17 (202)": an episode number with its absolute number in brackets. */
const BRACKETED_ABSOLUTE = /S\d{1,2}E\d{1,3}\b.*?\((\d{2,4})\)/i;

/** "22:55" or "1:02:03" in minutes. */
export const minutesOf = (runTime?: string): number | undefined => {
  if (!runTime) return undefined;
  const parts = runTime.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return undefined;
  const [h, m, s] =
    parts.length === 3
      ? parts
      : parts.length === 2
        ? [0, ...parts]
        : [0, parts[0], 0];
  return h * 60 + m + s / 60;
};

/** Whether a file is far longer or shorter than its episode should be. */
export const wrongLength = (expected?: number, actual?: number): boolean =>
  !!expected &&
  actual !== undefined &&
  Math.abs(actual - expected) > Math.max(5, expected * 0.35);

/**
 * Whether most files of a season are off by the same number: the files are
 * fine and only numbered differently. Needs three such files, and four in
 * five of the files whose origin points elsewhere to agree.
 */
const commonOffset = (offsets: (number | undefined)[]): number | undefined => {
  const known = offsets.filter((o): o is number => o !== undefined && o !== 0);
  if (known.length < 3) return undefined;
  const counts = new Map<number, number>();
  for (const o of known) counts.set(o, (counts.get(o) ?? 0) + 1);
  const [offset, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return count >= 3 && count >= known.length * 0.8 ? offset : undefined;
};

type Outcome = Omit<FixResult, 'kind'>;

interface IssueFixOptions {
  /** Who filed it, when someone else filed it for them; their limits apply. */
  actor?: User;
  /** What AI Search already worked out, instead of reading the report. */
  asked?: Pick<FixRequest, 'kind' | 'language' | 'replace'>;
}

const today = () => new Date().toISOString().slice(0, 10);

class AutoFix {
  /** When each title was last fixed each way, to keep from repeating. */
  private recent = new Map<string, number>();
  /** What each person used today, by "kind:user:day". */
  private used = new Map<string, number>();

  /**
   * Claims a key for a while: undefined if it was claimed too recently,
   * otherwise a way to give it back when nothing came of it.
   */
  private claim(key: string, within: number): (() => void) | undefined {
    const now = Date.now();
    if (this.recent.size > 5000) {
      for (const [k, at] of this.recent) {
        if (now - at > DAY) this.recent.delete(k);
      }
    }
    const at = this.recent.get(key);
    if (at && now - at < within) return undefined;
    this.recent.set(key, now);
    return () => {
      if (this.recent.get(key) === now) this.recent.delete(key);
    };
  }

  /**
   * Takes one of today's allowance for this person, before the work, so
   * reports made at the same moment cannot all get through. Admins are not
   * limited. Returns a refund, or undefined when none is left.
   */
  private take(
    what: 'fix' | 'replace',
    user: User,
    limit: number
  ): (() => void) | undefined {
    if (isAdmin(user)) return () => undefined;
    const key = `${what}:${user.id}:${today()}`;
    if (this.used.size > 5000) {
      for (const k of this.used.keys()) {
        if (!k.endsWith(today())) this.used.delete(k);
      }
    }
    const count = this.used.get(key) ?? 0;
    if (count >= limit) return undefined;
    this.used.set(key, count + 1);
    return () => this.used.set(key, Math.max(0, (this.used.get(key) ?? 1) - 1));
  }

  /** Forgets what was done, for tests. */
  public reset() {
    this.recent.clear();
    this.used.clear();
  }

  /** Fixes started from issues, still running. */
  private pending = new Set<Promise<FixResult | undefined>>();

  public enabledFor(user?: User | null): boolean {
    return featureEnabled('autoFix', user);
  }

  public async run(req: FixRequest): Promise<FixResult> {
    const refund = this.take('fix', req.user, MAX_FIXES_PER_DAY);
    if (!refund) {
      return {
        kind: req.kind,
        ok: false,
        message:
          'You have asked for as many fixes today as allowed. Try again tomorrow, or ask an admin.',
      };
    }
    const result = await this.dispatch(req).catch((e): Outcome => {
      logger.warn('Automatic fix failed', {
        label: LABEL,
        kind: req.kind,
        mediaId: req.media.id,
        errorMessage: message(e),
      });
      // Only messages written for people are shown; the rest can name
      // servers on the network, so they stay in the log.
      return {
        ok: false,
        message:
          e instanceof Shown
            ? e.message
            : 'That could not be fixed right now. An admin can see why in the logs.',
      };
    });
    if (!result.ok) refund();
    logger.info('Automatic fix', {
      label: LABEL,
      kind: req.kind,
      mediaId: req.media.id,
      ok: result.ok,
      userId: req.user.id,
    });
    return { kind: req.kind, ...result };
  }

  private dispatch(req: FixRequest): Promise<Outcome> {
    switch (req.kind) {
      case 'subtitles':
        return this.subtitles(req);
      case 'transcribe':
        return this.transcribe(req);
      case 'missing':
        return this.missing(req);
      case 'broken':
        return this.broken(req);
      case 'wrongEpisode':
        return this.wrongEpisode(req);
    }
  }

  /** Runs `work` holding `key`; gives the key back if nothing came of it. */
  private async holding(
    key: string,
    within: number,
    busy: string,
    work: () => Promise<Outcome>
  ): Promise<Outcome> {
    const release = this.claim(key, within);
    if (!release) return { ok: false, message: busy };
    try {
      const outcome = await work();
      if (!outcome.ok) release();
      return outcome;
    } catch (e) {
      release();
      throw e;
    }
  }

  private async subtitles(req: FixRequest): Promise<Outcome> {
    if (!subtitlesReady()) return NO_BAZARR('subtitles cannot be fetched');
    if (!req.media.externalServiceId) return NOT_ON_SERVER;
    // Bazarr follows one Radarr and one Sonarr; another's ids are not its.
    const arrId = bazarrIdOf(req.media);
    if (!arrId) return NOT_IN_BAZARR;
    if (needsSeason(req)) return ASK_SEASON;
    const isMovie = req.media.mediaType === MediaType.MOVIE;
    return this.holding(
      `subs:${req.media.id}:${req.seasonNumber ?? ''}:${req.episodeNumber ?? ''}:${req.language ?? ''}`,
      HOUR,
      'Subtitles for this were looked for in the last hour.',
      () => this.findSubtitles(req, arrId, isMovie)
    );
  }

  private async findSubtitles(
    req: FixRequest,
    arrId: number,
    isMovie: boolean
  ): Promise<Outcome> {
    const api = bazarr();
    // A whole series or season: Bazarr's own search for what is missing,
    // which can take a long while, then Whisper for what it cannot find.
    if (!isMovie && req.episodeNumber === undefined) {
      searchMissingSeriesOrTranscribe(`tv:${req.media.tmdbId}`, arrId).catch(
        (e) =>
          logger.warn('Bazarr could not search for a series’ subtitles', {
            label: LABEL,
            errorMessage: e instanceof Error ? e.message : String(e),
          })
      );
      return {
        ok: true,
        message:
          'Asked Bazarr to search for every subtitle this series is missing. Episodes it finds nothing for are then transcribed from the audio, when Bazarr has Whisper.',
        link: `/tv/${req.media.tmdbId}`,
      };
    }

    let item: {
      subtitles: BazarrSubtitle[] | null;
      missing_subtitles: { code2: string }[] | null;
    };
    let lastProvider: string | null | undefined;
    let results: BazarrSearchResult[];
    let download: (r: BazarrSearchResult) => Promise<void>;
    if (isMovie) {
      const movie = await api.getMovie(arrId);
      if (!movie) return NOT_ON_SERVER;
      item = movie;
      lastProvider = (await api.getMovieHistory(arrId))[0]?.provider;
      results = await api.searchMovie(arrId);
      download = (r) => api.downloadMovie(arrId, choiceOf(r));
    } else {
      const episode = await findEpisode(
        arrId,
        req.seasonNumber!,
        req.episodeNumber!
      );
      if (!episode) {
        return {
          ok: false,
          message: `Bazarr does not have ${label(req.seasonNumber, req.episodeNumber)}.`,
        };
      }
      item = episode;
      lastProvider = (await api.getEpisodeHistory(episode.sonarrEpisodeId))[0]
        ?.provider;
      results = await api.searchEpisode(episode.sonarrEpisodeId);
      download = async (r) => {
        try {
          await api.downloadEpisode(
            arrId,
            episode.sonarrEpisodeId,
            choiceOf(r)
          );
        } finally {
          forgetEpisodeHistory(episode.sonarrEpisodeId);
        }
      };
    }

    // Wrong subtitles are replaced in the languages there are; otherwise
    // what is missing is fetched. English when nothing says.
    const present = [
      ...new Set(
        (item.subtitles ?? []).filter((s) => !s.forced).map((s) => s.code2)
      ),
    ];
    const missing = (item.missing_subtitles ?? []).map((m) => m.code2);
    const wanted = req.language
      ? [req.language]
      : req.replace && present.length
        ? present
        : missing.length
          ? missing
          : present.length
            ? present
            : ['en'];

    const isTrue = (v: unknown) => String(v).toLowerCase() === 'true';
    const found = results
      .filter(
        (r) =>
          r.provider !== WHISPER_PROVIDER &&
          !isTrue(r.forced) &&
          wanted.some((code) => r.language?.toLowerCase().startsWith(code))
      )
      .sort(
        (a, b) =>
          // A wrong subtitle is replaced from somewhere else first.
          Number(req.replace && a.provider === lastProvider) -
            Number(req.replace && b.provider === lastProvider) ||
          Number(isTrue(a.hearing_impaired)) -
            Number(isTrue(b.hearing_impaired)) ||
          Number(b.score) - Number(a.score)
      );
    const best = found[0];
    if (best) {
      await download(best);
      return {
        ok: true,
        message: `Downloaded ${best.language} subtitles from ${best.provider} (match ${Math.round(
          Number(best.score)
        )}%).`,
        link: isMovie
          ? `/movie/${req.media.tmdbId}`
          : `/tv/${req.media.tmdbId}`,
      };
    }
    if (results.some((r) => r.provider === WHISPER_PROVIDER)) {
      const transcribed = await this.queueTranscription(req, arrId);
      return {
        ...transcribed,
        message: `No ${wanted.join('/')} subtitles were found. ${transcribed.message}`,
      };
    }
    return {
      ok: false,
      message: `No ${wanted.join('/')} subtitles were found, and Bazarr has no Whisper set up to transcribe them.`,
    };
  }

  private async transcribe(req: FixRequest): Promise<Outcome> {
    if (!subtitlesReady()) return NO_BAZARR('nothing can be transcribed');
    if (!req.media.externalServiceId) return NOT_ON_SERVER;
    const arrId = bazarrIdOf(req.media);
    if (!arrId) return NOT_IN_BAZARR;
    if (needsSeason(req)) return ASK_SEASON;
    return this.holding(
      `transcribe:${req.media.id}:${req.seasonNumber ?? ''}:${req.episodeNumber ?? ''}`,
      HOUR,
      'This was queued for transcription in the last hour.',
      () => this.queueTranscription(req, arrId)
    );
  }

  private async queueTranscription(
    req: FixRequest,
    arrId: number
  ): Promise<Outcome> {
    if (req.media.mediaType === MediaType.MOVIE) {
      const added = queueMovieTranscription(`movie:${req.media.tmdbId}`, arrId);
      return {
        ok: true,
        message: added
          ? 'Transcribing the audio with Whisper. It runs one title at a time, so it can take a while.'
          : 'It is already being transcribed.',
        link: `/movie/${req.media.tmdbId}`,
      };
    }
    const scope =
      req.episodeNumber !== undefined
        ? 'episode'
        : req.seasonNumber !== undefined
          ? 'season'
          : 'missing';
    const added = await queueSeriesTranscription(
      `tv:${req.media.tmdbId}`,
      arrId,
      scope,
      req.seasonNumber,
      req.episodeNumber
    );
    return {
      ok: added > 0,
      message: added
        ? `Transcribing ${added} episode${added === 1 ? '' : 's'} with Whisper, one at a time.`
        : scope === 'missing'
          ? 'No episode is missing subtitles that has not been transcribed already.'
          : 'Those episodes are already transcribed or queued.',
      link: `/tv/${req.media.tmdbId}`,
    };
  }

  private async missing(req: FixRequest): Promise<Outcome> {
    if (req.media.mediaType === MediaType.MOVIE) {
      const radarr = radarrFor(req.media);
      if (!radarr) return NOT_ON_SERVER;
      return this.holding(
        `missing:${req.media.id}`,
        HOUR,
        'This was searched for in the last hour.',
        async () => {
          await radarr.api.searchMovie(radarr.id);
          const handedOn = getSettings().backfill.includeMovies
            ? await this.handOn(req, 'movie', radarr.serverId, radarr.id)
            : false;
          const looking = getSettings().backfill.includeMovies
            ? await this.backfillSearch(
                req,
                'movie',
                radarr.serverId,
                radarr.id
              )
            : undefined;
          return looking
            ? {
                ok: true,
                link: looking.link,
                message: `Searching for it: Radarr is looking, and Backfill is checking indexers for releases Radarr cannot see. An admin approves anything it finds.${
                  handedOn ? agentAfter(req) : ''
                }`,
              }
            : { ok: true, message: 'Asked Radarr to search for it again.' };
        }
      );
    }
    const sonarr = sonarrFor(req.media);
    if (!sonarr) return NOT_ON_SERVER;
    return this.holding(
      `missing:${req.media.id}`,
      HOUR,
      'Missing episodes were searched for in the last hour.',
      () => this.searchMissing(req, sonarr)
    );
  }

  private async searchMissing(
    req: FixRequest,
    sonarr: NonNullable<ReturnType<typeof sonarrFor>>
  ): Promise<Outcome> {
    const episodes = await sonarr.api.episodes(sonarr.id);
    const now = Date.now();
    const missing = episodes.filter(
      (ep) =>
        ep.monitored &&
        !ep.hasFile &&
        ep.seasonNumber > 0 &&
        (req.seasonNumber === undefined ||
          ep.seasonNumber === req.seasonNumber) &&
        !!ep.airDateUtc &&
        new Date(ep.airDateUtc).getTime() < now
    );
    if (!missing.length) {
      return {
        ok: false,
        message: `Sonarr shows nothing missing${
          req.seasonNumber !== undefined ? ` in season ${req.seasonNumber}` : ''
        }. If an episode is there but wrong, report it as the wrong episode.`,
      };
    }
    const count = `${missing.length} missing episode${missing.length === 1 ? '' : 's'}`;
    // Sonarr's own search first; Backfill for the packs Sonarr cannot see.
    await sonarr.api.searchEpisodes(missing.map((ep) => ep.id));
    const handedOn = await this.handOn(
      req,
      'series',
      sonarr.serverId,
      sonarr.id
    );
    const looking = await this.backfillSearch(
      req,
      'series',
      sonarr.serverId,
      sonarr.id
    );
    return looking
      ? {
          ok: true,
          link: looking.link,
          message: `Searching for the ${count}: Sonarr is looking, and Backfill is checking indexers for packs Sonarr cannot see. An admin approves any pack it finds.${
            handedOn ? agentAfter(req) : ''
          }`,
        }
      : { ok: true, message: `Asked Sonarr to search for the ${count}.` };
  }

  /**
   * Has the admin agent look further once these searches are over, should
   * they find nothing; not for a title an admin set aside in Backfill.
   */
  private async handOn(
    req: FixRequest,
    kind: BackfillKind,
    serverId: number,
    arrId: number
  ): Promise<boolean> {
    try {
      if (!backfill.readiness().ready) return false;
      const row = await backfill.track(kind, serverId, arrId);
      if (row.status === 'ignored') return false;
      const run = await agent.afterReport({
        kind,
        serverId,
        arrId,
        title: row.title,
        reporter: req.user,
        issueId: req.issueId,
        seasonNumber: req.seasonNumber,
      });
      return !!run;
    } catch (e) {
      logger.warn('Could not hand a report on to the admin agent', {
        label: LABEL,
        errorMessage: message(e),
      });
      return false;
    }
  }

  /**
   * Starts a Backfill search for the title, when Backfill is set up and an
   * admin has not set it aside or seen it done. Admins get its page.
   */
  private async backfillSearch(
    req: FixRequest,
    kind: BackfillKind,
    serverId: number,
    arrId: number
  ): Promise<{ link?: string } | undefined> {
    if (!backfill.readiness().ready) return undefined;
    const row = await backfill.track(kind, serverId, arrId);
    if (row.status === 'ignored' || row.status === 'done') return undefined;
    backfill.startSearch(row.id, (await owner()) ?? undefined, {
      autoApprove: isAdmin(req.user),
    });
    return isAdmin(req.user) ? { link: `/backfill/series/${row.id}` } : {};
  }

  private async broken(req: FixRequest): Promise<Outcome> {
    if (req.media.mediaType === MediaType.MOVIE) {
      return this.replaceMovie(req);
    }
    if (req.episodeNumber === undefined || req.seasonNumber === undefined) {
      return {
        ok: false,
        message:
          'Say which episode is broken (for example S02E05) and it will be replaced.',
      };
    }
    const sonarr = sonarrFor(req.media);
    if (!sonarr) return NOT_ON_SERVER;
    const all = await sonarr.api.episodes(sonarr.id);
    const episode = all.find(
      (ep) =>
        ep.seasonNumber === req.seasonNumber &&
        ep.episodeNumber === req.episodeNumber
    );
    if (!episode) {
      return {
        ok: false,
        message: `Sonarr has no ${label(req.seasonNumber, req.episodeNumber)}.`,
      };
    }
    return this.replaceEpisode(sonarr.api, episode, all, req.user);
  }

  private async replaceEpisode(
    api: FixSonarr,
    episode: ArrEpisode,
    all: ArrEpisode[],
    user: User
  ): Promise<Outcome> {
    const name = label(episode.seasonNumber, episode.episodeNumber);
    if (!episode.hasFile || !episode.episodeFileId) {
      await api.searchEpisodes([episode.id]);
      return {
        ok: true,
        message: `${name} has no file, so Sonarr was asked to search for it.`,
      };
    }
    // One file holding several episodes is left to an admin: removing it
    // would take the others with it.
    const sharing = all.filter(
      (ep) => ep.id !== episode.id && ep.episodeFileId === episode.episodeFileId
    );
    if (sharing.length) {
      return {
        ok: false,
        message: `${name} shares its file with ${sharing
          .map((ep) => label(ep.seasonNumber, ep.episodeNumber))
          .join(', ')}, so it was left for an admin.`,
      };
    }
    return this.holding(
      `replace:episode:${episode.id}`,
      DAY,
      `${name} was already replaced in the last day.`,
      () =>
        this.swap(user, {
          name,
          app: 'Sonarr',
          episodeId: episode.id,
          current: async () => {
            const [file, history] = await Promise.all([
              api.episodeFile(episode.episodeFileId),
              api.history(episode.id),
            ]);
            return {
              title: originOf(file, history),
              group: file?.releaseGroup,
            };
          },
          releases: () => api.releases(episode.id),
          remove: () => api.deleteEpisodeFile(episode.episodeFileId),
          grab: (release) => api.grab(release),
          search: () => api.searchEpisodes([episode.id]),
        })
    );
  }

  private async replaceMovie(req: FixRequest): Promise<Outcome> {
    const radarr = radarrFor(req.media);
    if (!radarr) return NOT_ON_SERVER;
    const movie = await radarr.api.movieDetail(radarr.id);
    if (!movie.hasFile || !movie.movieFile) {
      await radarr.api.searchMovie(radarr.id);
      return {
        ok: true,
        message: 'It has no file, so Radarr was asked to search for it.',
      };
    }
    const file = movie.movieFile;
    return this.holding(
      `replace:movie:${radarr.id}`,
      DAY,
      'It was already replaced in the last day.',
      () =>
        this.swap(req.user, {
          app: 'Radarr',
          current: async () => ({
            title: originOf(file, await radarr.api.history(radarr.id)),
            group: file.releaseGroup,
          }),
          releases: () => radarr.api.releases(radarr.id),
          remove: () => radarr.api.deleteMovieFile(file.id),
          grab: (release) => radarr.api.grab(release),
          search: () => radarr.api.searchMovie(radarr.id),
        })
    );
  }

  /**
   * Removes the file only once another release is in hand (Sonarr and
   * Radarr would not import a release of the same quality over it), then
   * grabs that release. Counts against the person's replacements for the
   * day unless nothing was removed.
   */
  private async swap(user: User, swap: Swap): Promise<Outcome> {
    const refund = this.take('replace', user, MAX_REPLACED_PER_DAY);
    if (!refund) return { ok: false, message: TOO_MANY };
    const of = swap.name ? ` of ${swap.name}` : '';
    try {
      const current = await swap.current();
      const release = pickReplacement(
        await swap.releases(),
        current,
        swap.episodeId
      );
      if (!release) {
        refund();
        return {
          ok: false,
          message: `No other release${of} was found, so the file was left in place.`,
        };
      }
      await swap.remove();
      try {
        await swap.grab(release);
      } catch {
        await swap.search().catch(() => undefined);
        throw new Shown(
          `The broken file${of} was removed, but the other release could not be grabbed, so ${swap.app} is searching for one instead.`
        );
      }
      return {
        ok: true,
        message: `Replacing ${swap.name ?? 'it'}: removed ${
          current.title ?? 'the old file'
        } and grabbed ${grabbedFrom(release)}.`,
      };
    } catch (e) {
      if (!(e instanceof Shown)) refund();
      throw e;
    }
  }

  /**
   * Checks every file in the season against the release it came from and
   * its length. When most files are off by the same number, the files are
   * fine and the numbering is not, which needs an admin, not new downloads.
   * Otherwise the reported episode and any others that look wrong are
   * replaced with other releases.
   */
  private async wrongEpisode(req: FixRequest): Promise<Outcome> {
    if (req.media.mediaType === MediaType.MOVIE) {
      return this.replaceMovie(req);
    }
    if (req.seasonNumber === undefined) {
      return {
        ok: false,
        message:
          'Say which season (or episode) is mixed up and it will be checked.',
      };
    }
    const sonarr = sonarrFor(req.media);
    if (!sonarr) return NOT_ON_SERVER;
    const all = await sonarr.api.episodes(sonarr.id);
    const season = all
      .filter((ep) => ep.seasonNumber === req.seasonNumber && ep.hasFile)
      .slice(0, MAX_CHECKED);
    const byAbsolute = new Map(
      all
        .filter((ep) => ep.absoluteEpisodeNumber !== undefined)
        .map((ep) => [ep.absoluteEpisodeNumber!, ep])
    );
    const shared = (ep: ArrEpisode) =>
      all.some(
        (other) =>
          other.id !== ep.id && other.episodeFileId === ep.episodeFileId
      );

    const findings: { episode: ArrEpisode; why: string; offset?: number }[] =
      [];
    for (const episode of season) {
      const [file, history] = await Promise.all([
        sonarr.api.episodeFile(episode.episodeFileId),
        sonarr.api.history(episode.id),
      ]);
      const origin = originOf(file, history);
      let mappedTo: ArrEpisode[] = [];
      if (origin) {
        // A name that gives both its own SxxEyy and the absolute number in
        // brackets ("S05E17 (202)") means the absolute one; anything else
        // is read by Sonarr, with its scene mappings.
        const bracketed = origin.match(BRACKETED_ABSOLUTE)?.[1];
        const absolute = bracketed
          ? byAbsolute.get(Number(bracketed))
          : undefined;
        if (absolute) {
          mappedTo = [absolute];
        } else {
          const parsed = await sonarr.api.parse(origin).catch(() => undefined);
          if (parsed?.series?.id === sonarr.id) {
            mappedTo = (parsed.episodes ?? [])
              .map((p) => all.find((ep) => ep.id === p.id))
              .filter((ep): ep is ArrEpisode => !!ep);
          }
        }
      }
      if (mappedTo.length && !mappedTo.some((ep) => ep.id === episode.id)) {
        const to = mappedTo[0];
        findings.push({
          episode,
          why: `came from “${origin}”, which is ${label(to.seasonNumber, to.episodeNumber)}`,
          offset:
            to.seasonNumber === episode.seasonNumber
              ? to.episodeNumber - episode.episodeNumber
              : undefined,
        });
        continue;
      }
      // A file holding two episodes runs long on purpose.
      const minutes = minutesOf(file?.mediaInfo?.runTime);
      if (
        mappedTo.length <= 1 &&
        !shared(episode) &&
        wrongLength(episode.runtime, minutes)
      ) {
        findings.push({
          episode,
          why: `runs ${Math.round(minutes!)} minutes where the episode is ${episode.runtime}`,
        });
      }
    }

    const lines = findings
      .slice(0, 12)
      .map(
        (f) =>
          `${label(f.episode.seasonNumber, f.episode.episodeNumber)} ${f.why}`
      );
    const offset = commonOffset(findings.map((f) => f.offset));
    if (offset !== undefined) {
      const off = findings.filter((f) => f.offset === offset).length;
      return {
        ok: false,
        message: `${off} of season ${req.seasonNumber}'s ${season.length} files are off by ${offset}: the files are fine but numbered differently from Sonarr. An admin should rename or re-map them rather than download them again.\n${lines.join('\n')}`,
      };
    }

    const reported = season.find(
      (ep) => ep.episodeNumber === req.episodeNumber
    );
    const toReplace = [
      ...(reported ? [reported] : []),
      ...findings.map((f) => f.episode).filter((ep) => ep.id !== reported?.id),
    ].slice(0, MAX_REPLACED);
    if (!toReplace.length) {
      return {
        ok: false,
        message: `Every file in season ${req.seasonNumber} matches its episode by name and length. Say which episode is wrong and it will be replaced.`,
      };
    }
    const done: Outcome[] = [];
    for (const episode of toReplace) {
      done.push(
        await this.replaceEpisode(sonarr.api, episode, all, req.user).catch(
          (e): Outcome => ({
            ok: false,
            message:
              e instanceof Shown
                ? e.message
                : `${label(episode.seasonNumber, episode.episodeNumber)} could not be replaced right now.`,
          })
        )
      );
    }
    return {
      ok: done.some((d) => d.ok),
      message: [
        findings.length
          ? `Checked season ${req.seasonNumber}; ${findings.length} file${findings.length === 1 ? '' : 's'} looked wrong:\n${lines.join('\n')}`
          : `Checked season ${req.seasonNumber}; only the reported episode looked wrong.`,
        ...done.map((d) => d.message),
      ].join('\n'),
    };
  }

  /**
   * Tries to fix what a new issue reports, and writes what happened on the
   * issue. `actor` is who filed it (an admin may file for someone else):
   * their switch and limits apply. `asked` is what AI Search already worked
   * out, used instead of reading the report again. Runs in the background;
   * never throws.
   */
  public fromIssue(
    issueId: number,
    options: IssueFixOptions = {}
  ): Promise<FixResult | undefined> {
    const work = this.fixIssue(issueId, options);
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
    return work;
  }

  /** Settles once the fixes running in the background are done. */
  public async idle(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private async fixIssue(
    issueId: number,
    options: IssueFixOptions
  ): Promise<FixResult | undefined> {
    try {
      const issue = await getRepository(Issue).findOne({
        where: { id: issueId },
        relations: { media: true, createdBy: true, comments: true },
      });
      if (!issue) return undefined;
      const actor = options.actor ?? issue.createdBy;
      if (!this.enabledFor(actor)) return undefined;
      const text = [...(issue.comments ?? [])]
        .sort((a, b) => a.id - b.id)
        .map((c) => c.message)
        .join('\n');
      const asked = options.asked ?? classify(text, issue.issueType);
      if (!asked) return undefined;
      const result = await this.run({
        ...asked,
        media: issue.media,
        seasonNumber: issue.problemSeason || undefined,
        episodeNumber: issue.problemEpisode || undefined,
        user: actor,
        issueId: issue.id,
      });
      if (result.skipped) return result;
      const author = (await owner()) ?? issue.createdBy;
      await getRepository(IssueComment).save(
        new IssueComment({
          issue,
          user: author,
          message: `Automatic fix: ${result.message}`,
        })
      );
      return result;
    } catch (e) {
      logger.error('Could not act on a reported issue', {
        label: LABEL,
        issueId,
        errorMessage: message(e),
      });
      return undefined;
    }
  }
}

const autofix = new AutoFix();
export default autofix;
