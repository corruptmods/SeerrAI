/*
 * What the subtitles routes send. Paths on the server are never sent: a
 * subtitle is named by its file name and acted on by its id.
 */

export type SubtitleKind = 'file' | 'embedded';

/**
 * Where a subtitle file came from, as Bazarr's history tells it:
 * transcribed from the audio by Whisper, downloaded from a provider,
 * uploaded by hand, or translated from another subtitle. Left out when
 * Bazarr has no record of it, as for a file that came with the video.
 */
export type SubtitleOrigin =
  | 'transcribed'
  | 'downloaded'
  | 'uploaded'
  | 'translated';

export interface SubtitleTrack {
  /** Bazarr's id for it; what Replace and Delete name. */
  id: number;
  /** ISO 639-1, as Bazarr keys it ("en"). */
  language: string;
  /** ISO 639-2 ("eng"), as Plex keys it, when Bazarr says. */
  language3?: string;
  /** "English". */
  name: string;
  kind: SubtitleKind;
  hi: boolean;
  forced: boolean;
  /** A file beside the video: its name, without the folders. */
  fileName?: string;
  size?: number;
  /** Made by transcribing the audio with Whisper. */
  ai: boolean;
  /** A file's origin, when Bazarr recorded one. */
  origin?: SubtitleOrigin;
  /** The provider it was downloaded from ("opensubtitlescom"). */
  provider?: string;
}

export interface MissingSubtitle {
  language: string;
  name: string;
  hi: boolean;
  forced: boolean;
}

export interface MovieSubtitles {
  /** The Bazarr language profile's name, or null for none. */
  profile: string | null;
  /** The languages the profile asks for ("en"). */
  wanted: string[];
  tracks: SubtitleTrack[];
  missing: MissingSubtitle[];
}

export interface EpisodeSubtitles {
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  tracks: SubtitleTrack[];
  missing: MissingSubtitle[];
}

export interface SeriesSubtitles {
  /** The Bazarr language profile's name, or null for none. */
  profile: string | null;
  /** The languages the profile asks for ("en"). */
  wanted: string[];
  episodes: EpisodeSubtitles[];
}

/** A result of a manual search. */
export interface SubtitleSearchResult {
  provider: string;
  /** Bazarr's id for the result, valid while its search is recent. */
  subtitle: string;
  language: string;
  /** 0 to 100. */
  score: number;
  hi: boolean;
  forced: boolean;
  originalFormat: boolean;
  /** Release names the subtitle was made for. */
  releases: string[];
  matched: string[];
  missed: string[];
  /** Made on demand by transcribing the audio. */
  ai: boolean;
}

/**
 * What became of a search that found nothing from a subtitle provider:
 * - started: Whisper is transcribing the missing subtitle instead;
 * - alreadyQueued: it was already queued to transcribe;
 * - notMissing: nothing is missing, so nothing on disk is replaced;
 * - unavailable: Bazarr has no Whisper to transcribe with.
 */
export type NoneFoundOutcome =
  | 'started'
  | 'alreadyQueued'
  | 'notMissing'
  | 'unavailable';

export interface SubtitleSearchResponse {
  results: SubtitleSearchResult[];
  /** Set only when no provider but Whisper had anything. */
  noneFound?: NoneFoundOutcome;
}

/** Transcriptions asked for a title: queued, under way and finished. */
/** Where a job asked of Bazarr is, as it last read its queue. */
export interface BazarrJobLive {
  state: 'waiting' | 'running';
  /** When it began waiting, or running. */
  since: string;
  /** Waiting: the jobs before it, those running included. */
  ahead?: number;
  /** Waiting: how many jobs Bazarr is running. */
  running?: number;
  /** Waiting: when the longest running of them started. */
  busySince?: string;
  /** Running: Bazarr's count, for a job that keeps one. */
  progress?: { value: number; max: number };
}

export interface TranscriptionStatus {
  queued: number;
  running: boolean;
  done: number;
  failed: number;
  /** Bazarr is searching its providers for what the title is missing. */
  searching: boolean;
  /**
   * Of those queued or under way, how many are there because a search
   * found nothing.
   */
  auto: number;
  /** The episode being transcribed now, for a series. */
  current?: { seasonNumber: number; episodeNumber: number };
  /** The one under way is waiting its turn in Bazarr's own queue. */
  waitingInBazarr?: boolean;
  /** The search, in Bazarr's queue. */
  searchJob?: BazarrJobLive;
  /** The transcription under way, in Bazarr's queue. */
  transcribeJob?: BazarrJobLive;
  /** Why the last one that failed did. */
  error?: SubtitleError;
}

/**
 * Why something asked of subtitles could not be done, for the page to say
 * in the viewer's own language. Error answers carry it beside an English
 * `message`, which is for anything else that reads the API.
 */
export type SubtitleErrorCode =
  /** Subtitles are not set up, or are off for this person. */
  | 'off'
  /** Not in Radarr or Sonarr. */
  | 'notInArr'
  /**
   * Radarr or Sonarr has it, but Bazarr does not (yet), or it is on a
   * Radarr or Sonarr Bazarr does not follow (it follows one of each).
   */
  | 'notInBazarr'
  /** The subtitle file is not there to delete. */
  | 'notOnDisk'
  /** Bazarr's WhisperAI provider is not turned on. */
  | 'whisperOff'
  /** Bazarr paused WhisperAI after an error; see `error` and `retry`. */
  | 'whisperPaused'
  /** Bazarr offered no Whisper transcription. */
  | 'noWhisper'
  /** Bazarr did not answer, or answered with an error. */
  | 'bazarrFailed'
  /** Bazarr had not finished a transcription after a day. */
  | 'bazarrStuck'
  /** Bazarr's transcription ended without a subtitle saved. */
  | 'noSubtitleSaved'
  /** The title is not in Plex. */
  | 'notInPlex'
  /** Plex did not answer. */
  | 'plexFailed'
  /** Plex did not offer the subtitle chosen. */
  | 'notOffered'
  /** The viewer has no Plex sign-in Seerr can use. */
  | 'noPlexSignIn';

export interface SubtitleError {
  code: SubtitleErrorCode;
  /** whisperPaused: the error Bazarr paused WhisperAI after, as Bazarr names it. */
  error?: string;
  /** whisperPaused: when Bazarr tries again, as Bazarr puts it ("in 41 minutes"). */
  retry?: string;
}

/** Which episodes of a series to transcribe. */
export type TranscribeScope =
  | 'missing'
  | 'season'
  | 'notTranscribed'
  | 'episode';

/** A subtitle choice in the viewer's own Plex player, for a movie. */
export interface PlexSubtitleOption {
  /** Plex's stream id; 0 is "no subtitles". */
  id: number;
  title: string;
  /** ISO 639-2 ("eng"). */
  language?: string;
  /** A file beside the video, rather than a track inside it. */
  external?: boolean;
}

export interface PlexSubtitleDefault {
  /** False when the viewer has no Plex sign-in Seerr can use. */
  available: boolean;
  options: PlexSubtitleOption[];
  /** The selected option's id (movie) or language code (series); 0 or "" for none. */
  selected: number | string;
  /** A series: what the choice is made by. */
  languages?: { code: string; title: string }[];
}
