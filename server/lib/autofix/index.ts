import type {
  BazarrJobEnd,
  BazarrSearchResult,
  BazarrSubtitle,
} from '@server/api/bazarr';
import { WHISPER_PROVIDER } from '@server/api/bazarr';
import { IssueType } from '@server/constants/issue';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type { BackfillKind } from '@server/entity/BackfillSeries';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import type Media from '@server/entity/Media';
import type MusicAlbum from '@server/entity/MusicAlbum';
import type { User } from '@server/entity/User';
import agent from '@server/lib/agent';
import type { ArrEpisode, ArrRelease } from '@server/lib/autofix/arr';
import { FixRadarr, FixSonarr } from '@server/lib/autofix/arr';
import {
  grabbedFrom,
  originOf,
  pickReplacement,
} from '@server/lib/autofix/releases';
import {
  approvedOf,
  carryOutSeason,
  planDetails,
  planHeadline,
  planSeason,
} from '@server/lib/autofix/season';
import type { ReadReport } from '@server/lib/autofix/understand';
import { REPLACES_FILES, askAboutReport } from '@server/lib/autofix/understand';
import backfill from '@server/lib/backfill/engine';
import { featureEnabled } from '@server/lib/features';
import { lidarrApi, musicReady } from '@server/lib/music/access';
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
 * Auto-fix for reported problems: subtitles (or transcription), missing
 * episodes, broken files, mixed-up seasons, whole-season replacement.
 * Triggered from AI Search or an issue; on an issue each step is a comment.
 *
 * A file is removed only once a replacement release is found (for a season,
 * grabbed). A title is replaced at most once a day, except an admin's season
 * replace. Non-admin season replacements wait for admin approval.
 */

const LABEL = 'Auto-fix';
/** Suffix for when the admin agent will follow up if nothing turns up. */
const agentAfter = (req: { issueId?: number }) =>
  req.issueId
    ? ' If nothing turns up, the admin agent looks further and answers here.'
    : ' If nothing turns up, the admin agent looks further.';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Max episodes one "wrong episode" report replaces. */
const MAX_REPLACED = 6;
/** Daily file replacements per non-admin. */
const MAX_REPLACED_PER_DAY = 10;
const TOO_MANY =
  'You have had as many files replaced today as allowed. An admin can replace more, or try again tomorrow.';
/** Daily fixes of any kind per non-admin. */
const MAX_FIXES_PER_DAY = 30;
/** Max episodes per season checked against their source release. */
const MAX_CHECKED = 60;

export type FixKind =
  | 'subtitles'
  | 'transcribe'
  | 'missing'
  | 'broken'
  | 'wrongEpisode'
  | 'replaceSeason';

export const FIX_KINDS: FixKind[] = [
  'subtitles',
  'transcribe',
  'missing',
  'broken',
  'wrongEpisode',
  'replaceSeason',
];

export interface FixRequest {
  kind: FixKind;
  /** The film or series; for music, the artist. */
  media: Media;
  /** Music only: the album; omitted means all the artist's albums. */
  album?: MusicAlbum;
  seasonNumber?: number;
  episodeNumber?: number;
  /** Two-letter subtitle language code. */
  language?: string;
  /** Subtitles present are wrong, not just missing. */
  replace?: boolean;
  /** Requester: their limits and visibility apply. */
  user: User;
  /** Issue to reply on. */
  issueId?: number;
}

export interface FixResult {
  kind: FixKind;
  ok: boolean;
  message: string;
  /** Seerr page tracking what was started. */
  link?: string;
  /** Not applicable (title not on the server); stay silent. */
  skipped?: boolean;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** An error whose message is safe to show the requester. */
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

/** First language named in the text, as a two-letter code. */
const languageIn = (text: string): string | undefined => {
  const lower = text.toLowerCase();
  let first: { at: number; code: string } | undefined;
  for (const [name, code] of Object.entries(LANGUAGES)) {
    const at = lower.search(new RegExp(`\\b${name}\\b`));
    if (at !== -1 && (!first || at < first.at)) first = { at, code };
  }
  return first?.code;
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};
const NUMBER = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})`;
const numberOf = (word: string) =>
  NUMBER_WORDS[word.toLowerCase()] ?? Number(word);

/**
 * Season/episode named in text: "S06E03", "6x03", "season 6", "s6",
 * "season six episode two", "episode 3 of season 6". Unnamed parts are omitted.
 */
export const seasonEpisodeIn = (
  text: string
): { season?: number; episode?: number } => {
  const both =
    text.match(/\bs(\d{1,2})\s*e(\d{1,3})\b/i) ??
    text.match(/\b(\d{1,2})x(\d{2,3})\b/i);
  if (both) return { season: Number(both[1]), episode: Number(both[2]) };
  const season =
    text.match(new RegExp(`\\bseason\\s+${NUMBER}\\b`, 'i'))?.[1] ??
    text.match(/\bs(\d{1,2})\b/i)?.[1];
  const episode = text.match(
    new RegExp(`\\b(?:episode|ep)\\.?\\s*${NUMBER}\\b`, 'i')
  )?.[1];
  return {
    ...(season !== undefined ? { season: numberOf(season) } : {}),
    ...(episode !== undefined ? { episode: numberOf(episode) } : {}),
  };
};

/**
 * "Whole season" phrasing. The number is an optional group, not `\s*\d*\s+`,
 * which is quadratic on long runs of spaces.
 */
const WHOLE_SEASON =
  /\b(whole|entire|full|complete)\s+(season|series)\b|\ball\s+(of\s+)?(the\s+)?season\b|\bseason(?:\s*\d+)?\s+(is\s+)?(all|completely|totally|entirely)\b/i;
/** "All episodes/files" phrasing. */
const WHOLE_OTHERWISE =
  /\b(every|all( of)?( the)?) (episodes?|files?)\b|\b(replace|redownload|re-download)\s+(it|them)\s+all\b/i;
const REPLACE_WORDS =
  /\b(replac\w*|re-?download\w*|download\w* (it |them )?again|re-?grab\w*)\b/i;
const BAD_WORDS =
  /\b(bad|messed[ -]?up|a mess|wrong|broken|corrupt\w*|garbage|trash|screwed( up)?|ruined|unwatchable|mixed[ -]?up)\b/i;

/**
 * A whole season called bad, or a season (no single episode) to replace or
 * redownload.
 */
const wholeSeason = (text: string) => {
  const named = seasonEpisodeIn(text);
  return (
    (WHOLE_SEASON.test(text) &&
      (BAD_WORDS.test(text) || REPLACE_WORDS.test(text))) ||
    (WHOLE_OTHERWISE.test(text) &&
      REPLACE_WORDS.test(text) &&
      named.episode === undefined) ||
    (REPLACE_WORDS.test(text) &&
      /\bseason\b|\bs\d{1,2}\b/i.test(text) &&
      named.episode === undefined)
  );
};

/** Wrong episode or film, named explicitly; bare "wrong" doesn't match. */
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
 * The fix a report asks for, from its text and issue type. Subtitle issues
 * are always subtitles; video/audio issues are the file unless they name the
 * wrong episode. Undefined when unclear.
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
  if (wholeSeason(text) && !SUBTITLE.test(text)) {
    return { kind: 'replaceSeason' };
  }
  if (WRONG_EPISODE.test(text)) return { kind: 'wrongEpisode' };
  if (issueType === IssueType.VIDEO || issueType === IssueType.AUDIO) {
    return { kind: 'broken' };
  }
  if (MISSING.test(text) && !SUBTITLE.test(text)) return { kind: 'missing' };
  if (TRANSCRIBE.test(text) || SUBTITLE.test(text)) return subtitles();
  if (BROKEN.test(text)) return { kind: 'broken' };
  return undefined;
};

/** Phrase for each fix kind: "this reads as …". */
export const KIND_SAID: Record<FixKind, string> = {
  subtitles: 'a subtitle problem',
  transcribe: 'a request for subtitles from the audio',
  missing: 'something missing',
  broken: 'a bad or broken file',
  wrongEpisode: 'the wrong episode',
  replaceSeason: 'a whole bad season',
};

/**
 * Reads a report by rules, then the AI model if unclear and "Understand
 * Reports" is on. `by` matters: an AI reading is only a suggestion for
 * file-replacing fixes.
 */
export const readReport = async (
  text: string,
  { user, episode }: { user: User; episode: boolean }
): Promise<(ReadReport & { by: 'rules' | 'ai' }) | undefined> => {
  const rule = classify(text);
  if (rule) return { ...rule, by: 'rules' };
  const read = await askAboutReport(text, { user, episode });
  return read ? { ...read, by: 'ai' } : undefined;
};

/** The title's server and id; 4K only when it's the only one. */
const serviceOf = (media: Media) =>
  !media.externalServiceId && media.externalServiceId4k
    ? { serverId: media.serviceId4k, id: media.externalServiceId4k }
    : { serverId: media.serviceId, id: media.externalServiceId };

const sonarrFor = (media: Media) => {
  if (media.mediaType !== MediaType.TV) return undefined;
  const { serverId, id } = serviceOf(media);
  const server = getSettings().sonarr.find((s) => s.id === serverId);
  return server && id
    ? { api: FixSonarr.forServer(server), id, serverId: server.id }
    : undefined;
};

const radarrFor = (media: Media) => {
  if (media.mediaType !== MediaType.MOVIE) return undefined;
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

/** Music is on Lidarr: only its missing tracks and albums are searched for. */
const MUSIC_ONLY_MISSING: Omit<FixResult, 'kind'> = {
  ok: false,
  skipped: true,
  message:
    'For music, only missing tracks or albums can be searched for again here. For anything else, ask an admin.',
};

const ASK_SEASON: Omit<FixResult, 'kind'> = {
  ok: false,
  message: 'Which season is that episode in?',
};

const needsSeason = (req: FixRequest) =>
  req.media.mediaType === MediaType.TV &&
  req.episodeNumber !== undefined &&
  req.seasonNumber === undefined;

/** Swapping one file for another release via Sonarr or Radarr. */
interface Swap {
  /** "S01E02"; unset for a movie. */
  name?: string;
  app: 'Sonarr' | 'Radarr';
  episodeId?: number;
  current: () => Promise<{ title?: string; group?: string | null }>;
  releases: () => Promise<ArrRelease[]>;
  remove: () => Promise<void>;
  grab: (release: ArrRelease) => Promise<void>;
  search: () => Promise<void>;
}

/** "S05E17 (202)": episode number with the absolute number in brackets. */
const BRACKETED_ABSOLUTE = /S\d{1,2}E\d{1,3}\b.*?\((\d{2,4})\)/i;

/** Parses "22:55" or "1:02:03" to minutes. */
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

/** Whether a file's length is far off the expected runtime. */
export const wrongLength = (expected?: number, actual?: number): boolean =>
  !!expected &&
  actual !== undefined &&
  Math.abs(actual - expected) > Math.max(5, expected * 0.35);

/**
 * A shared numbering offset across a season (files fine, numbering off).
 * Needs at least three, and 80% of the offset files, to agree.
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
  /** Whom it was filed for, if by someone else; their limits apply. */
  actor?: User;
  /** AI Search's reading, used instead of re-reading the report. */
  asked?: Pick<FixRequest, 'kind' | 'language' | 'replace'>;
}

const today = () => new Date().toISOString().slice(0, 10);

class AutoFix {
  /** Last fix time per title and kind, to prevent repeats. */
  private recent = new Map<string, number>();
  /** Daily usage by "kind:user:day". */
  private used = new Map<string, number>();

  /**
   * Claims a key; undefined if claimed within `within`, else a callback that
   * releases it.
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
   * Takes one daily allowance before the work, so simultaneous reports can't
   * all pass. Admins are unlimited. Returns a refund, or undefined if none
   * left.
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

  /** Clears state, for tests. */
  public reset() {
    this.recent.clear();
    this.used.clear();
  }

  /** Running issue fixes. */
  private pending = new Set<Promise<FixResult | undefined>>();

  public enabledFor(user?: User | null): boolean {
    return featureEnabled('autoFix', user);
  }

  public async run(req: FixRequest): Promise<FixResult> {
    if (req.media.mediaType === MediaType.MUSIC && req.kind !== 'missing') {
      return { kind: req.kind, ...MUSIC_ONLY_MISSING };
    }
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
      // Only Shown errors reach the user; others may name internal hosts.
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
      case 'replaceSeason':
        return this.replaceSeason(req);
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
    // Bazarr follows one Radarr and one Sonarr; other servers' ids don't apply.
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
    // Whole series/season: Bazarr's (slow) missing search, then Whisper for the
    // rest.
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
    let download: (r: BazarrSearchResult) => Promise<BazarrJobEnd>;
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
          return await api.downloadEpisode(
            arrId,
            episode.sonarrEpisodeId,
            choiceOf(r)
          );
        } finally {
          forgetEpisodeHistory(episode.sonarrEpisodeId);
        }
      };
    }

    // Replace: the present languages; otherwise the missing ones; default
    // English.
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
          // When replacing, prefer a different provider.
          Number(req.replace && a.provider === lastProvider) -
            Number(req.replace && b.provider === lastProvider) ||
          Number(isTrue(a.hearing_impaired)) -
            Number(isTrue(b.hearing_impaired)) ||
          Number(b.score) - Number(a.score)
      );
    const best = found[0];
    if (best) {
      const end = await download(best);
      if (end === 'failed' || end === 'gone') {
        return {
          ok: false,
          message: `Bazarr could not download the ${best.language} subtitles from ${best.provider}.`,
        };
      }
      const match = Math.round(Number(best.score));
      return {
        ok: true,
        message:
          end === 'timedOut'
            ? `Asked Bazarr for ${best.language} subtitles from ${best.provider} (match ${match}%); it is still getting them.`
            : `Downloaded ${best.language} subtitles from ${best.provider} (match ${match}%).`,
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
    if (req.media.mediaType === MediaType.MUSIC) {
      return this.missingMusic(req);
    }
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

  /**
   * Lidarr re-searches the album, and Backfill (with Music on) looks for
   * releases Lidarr can't see. Without an album, all the artist's missing ones.
   */
  private async missingMusic(req: FixRequest): Promise<Outcome> {
    const lidarrs = getSettings().lidarr;
    const server =
      lidarrs.find((s) => s.id === req.media.serviceId) ??
      lidarrs.find((s) => s.isDefault);
    if (!server) return NOT_ON_SERVER;
    const api = lidarrApi(server);
    const album = req.album;
    if (!album) {
      const artistId = req.media.externalServiceId;
      if (!artistId) return NOT_ON_SERVER;
      return this.holding(
        `missing:artist:${req.media.id}`,
        HOUR,
        'Their missing albums were searched for in the last hour.',
        async () => {
          await api.searchArtist(artistId);
          return {
            ok: true,
            message: `Asked Lidarr to search for every missing album of ${
              req.media.foreignTitle ?? 'theirs'
            }.`,
          };
        }
      );
    }
    const link = album.mbId ? `/music/album/${album.mbId}` : undefined;
    if (!album.lidarrAlbumId) {
      return {
        ok: false,
        message: `${album.title} isn’t in Lidarr, so there is nothing to search for. It can be requested instead.`,
        ...(link && { link }),
      };
    }
    if (
      album.status === MediaStatus.AVAILABLE &&
      !!album.trackCount &&
      (album.trackFileCount ?? 0) >= album.trackCount
    ) {
      return {
        ok: false,
        message: `Lidarr has every track of ${album.title}, so nothing is missing. If some won't play, ask an admin.`,
        ...(link && { link }),
      };
    }
    const lidarrAlbumId = album.lidarrAlbumId;
    return this.holding(
      `missing:album:${album.id}`,
      HOUR,
      'This album was searched for in the last hour.',
      async () => {
        await api.searchAlbums([lidarrAlbumId]);
        const looking =
          getSettings().backfill.includeMusic && musicReady()
            ? await this.backfillSearch(req, 'album', server.id, lidarrAlbumId)
            : undefined;
        return looking
          ? {
              ok: true,
              link: looking.link ?? link,
              message: `Searching for ${album.title}: Lidarr is looking, and Backfill is checking indexers for releases Lidarr cannot see. An admin approves anything it finds.`,
            }
          : {
              ok: true,
              ...(link && { link }),
              message: `Asked Lidarr to search for ${album.title} again.`,
            };
      }
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
      // Nothing missing: ask what's actually wrong.
      return {
        ok: false,
        message:
          req.seasonNumber !== undefined
            ? `Sonarr has every aired episode of season ${req.seasonNumber}, so nothing is missing. What is wrong with it: should I replace the whole season, check it for mixed-up episodes, or fix its subtitles?`
            : 'Sonarr has every aired episode, so nothing is missing. What is wrong with it: a season to replace (say which), mixed-up episodes, or subtitles?',
      };
    }
    const count = `${missing.length} missing episode${missing.length === 1 ? '' : 's'}`;
    // Sonarr search first; Backfill for packs Sonarr can't see.
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
   * Queues an admin agent follow-up if the searches find nothing; not for
   * titles ignored in Backfill.
   */
  private async handOn(
    req: FixRequest,
    kind: 'series' | 'movie',
    serverId: number,
    arrId: number,
    replace?: boolean
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
        ...(replace ? { replace: true } : {}),
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
   * Starts a Backfill search unless unconfigured, ignored or done. Admins get
   * its page link.
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
    // A multi-episode file is left to an admin: removing it removes the others.
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
   * Removes the file only once a replacement is found (the *arrs won't import
   * same quality over it), then grabs it. Counts toward the daily limit
   * unless nothing was removed.
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
   * Replaces every file of a season (season.ts): immediately for admins
   * (repeatable the same day); others need admin approval, once a day per
   * season. For a movie, replaces its one file.
   */
  private async replaceSeason(req: FixRequest): Promise<Outcome> {
    if (req.media.mediaType === MediaType.MOVIE) {
      return this.replaceMovie(req);
    }
    if (req.seasonNumber === undefined) {
      return {
        ok: false,
        message:
          'Which season should be replaced? Say its number, for example “replace season 2”.',
      };
    }
    const sonarr = sonarrFor(req.media);
    if (!sonarr) return NOT_ON_SERVER;
    const season = req.seasonNumber;
    const admin = isAdmin(req.user);
    const release = admin
      ? () => undefined
      : this.claim(`replace:season:${req.media.id}:${season}`, DAY);
    if (!release) {
      return {
        ok: false,
        message: `Season ${season} was already asked to be replaced today. An admin can see where that stands, or ask again tomorrow.`,
      };
    }
    const refund = this.take('replace', req.user, MAX_REPLACED_PER_DAY);
    if (!refund) {
      release();
      return { ok: false, message: TOO_MANY };
    }
    try {
      const outcome = await this.seasonWork(req, sonarr, season);
      if (!outcome.ok) {
        release();
        refund();
      }
      return outcome;
    } catch (e) {
      release();
      refund();
      throw e;
    }
  }

  private async seasonWork(
    req: FixRequest,
    sonarr: NonNullable<ReturnType<typeof sonarrFor>>,
    season: number
  ): Promise<Outcome> {
    const plan = await planSeason(sonarr.api, sonarr.id, season);
    if ('nothing' in plan) {
      if (plan.noFiles) {
        // No files: search for the monitored ones instead.
        const wanted = plan.noFiles.filter((ep) => ep.monitored);
        if (wanted.length) {
          await sonarr.api.searchEpisodes(wanted.map((ep) => ep.id));
          return {
            ok: true,
            message: `Season ${season} has no files yet, so Sonarr was asked to search for it.`,
          };
        }
        return { ok: false, message: plan.nothing };
      }
      const handedOn = await this.handOn(
        req,
        'series',
        sonarr.serverId,
        sonarr.id,
        true
      );
      return {
        ok: false,
        message: `${plan.nothing}${
          handedOn
            ? req.issueId
              ? ' The admin agent looks further, and answers here.'
              : ' The admin agent looks further.'
            : ''
        }`,
      };
    }
    const title = {
      kind: 'series' as const,
      serverId: sonarr.serverId,
      arrId: sonarr.id,
    };
    if (!isAdmin(req.user)) {
      // Queued for approval in the admin agent.
      const run = await agent.awaitApproval({
        title,
        name: plan.name,
        change: {
          kind: 'replaceSeason',
          headline: planHeadline(plan),
          title,
          details: planDetails(plan),
          params: { season, ...approvedOf(plan) },
        },
        reporter: req.user,
        issueId: req.issueId,
        seasonNumber: season,
        ask: `Asked to replace all of season ${season}`,
      });
      if (!run) {
        return {
          ok: false,
          message: `Replacing a whole season needs an admin’s approval, and the admin agent that asks for it is not set up. An admin can replace season ${season} themselves.`,
        };
      }
      return {
        ok: true,
        message: `Found ${
          plan.pack
            ? `the season pack ${grabbedFrom(plan.pack)}`
            : `${plan.singles.length === 1 ? 'a release' : `${plan.singles.length} releases`} to replace season ${season} with`
        }. Replacing a whole season needs an admin’s approval, so it is waiting for an admin; once one approves, it is downloaded first and the current files are removed after. Nothing changes until then.`,
      };
    }
    const outcome = await carryOutSeason(sonarr.api, plan);
    if (outcome.ok && req.issueId) {
      // Tell the reporter when the season is back.
      await agent
        .follow({
          title,
          name: plan.name,
          reporter: req.user,
          issueId: req.issueId,
          seasonNumber: season,
          episodeIds: outcome.episodeIds,
        })
        .catch((e) =>
          logger.warn('Could not follow a replaced season', {
            label: LABEL,
            mediaId: req.media.id,
            errorMessage: message(e),
          })
        );
    }
    return {
      ok: outcome.ok,
      message:
        outcome.ok && req.issueId
          ? `${outcome.message} You will be told here when it is back.`
          : outcome.message,
    };
  }

  /**
   * Checks each file in the season against its source release and length.
   * A shared offset means the numbering is wrong, which needs an admin, not
   * downloads. Otherwise replaces the reported episode and any that look wrong.
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
        // "S05E17 (202)" means the bracketed absolute number; otherwise
        // Sonarr parses it with its scene mappings.
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
      // Multi-episode files are long by design.
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
   * Tries to fix a new issue and comments the outcome on it. `actor` is the
   * user it was filed for (their switch and limits apply); `asked` is AI
   * Search's reading. Runs in the background; never throws.
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

  /** Resolves when background fixes finish. */
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
      let asked = options.asked ?? classify(text, issue.issueType);
      if (!asked) {
        // Rules unclear: ask the model. File-replacing readings are left to
        // an admin, since nobody confirmed them.
        const read = await askAboutReport(text, {
          user: actor,
          episode: issue.media.mediaType === MediaType.TV,
        });
        if (!read) return undefined;
        if (REPLACES_FILES.includes(read.kind)) {
          await getRepository(IssueComment).save(
            new IssueComment({
              issue,
              user: (await owner()) ?? issue.createdBy,
              message: `Automatic fix: this reads as ${KIND_SAID[read.kind]}. That replaces files, so it is left for an admin.`,
            })
          );
          return undefined;
        }
        asked = read;
      }
      // Filed on All Seasons but the text names one: use it and set it on the
      // issue.
      let seasonNumber = issue.problemSeason || undefined;
      let episodeNumber = issue.problemEpisode || undefined;
      if (
        issue.media.mediaType === MediaType.TV &&
        seasonNumber === undefined
      ) {
        const said = seasonEpisodeIn(text);
        if (said.season) {
          seasonNumber = said.season;
          episodeNumber = said.episode || undefined;
          await getRepository(Issue).update(issue.id, {
            problemSeason: seasonNumber,
            problemEpisode: episodeNumber ?? 0,
          });
        }
      }
      const result = await this.run({
        ...asked,
        media: issue.media,
        seasonNumber,
        episodeNumber,
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

export { pickReplacement };

const autofix = new AutoFix();
export default autofix;
