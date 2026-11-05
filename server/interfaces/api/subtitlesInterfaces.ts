/*
 * Subtitles route responses. Server paths are never sent: a subtitle is
 * named by file name and acted on by id.
 */

export type SubtitleKind = 'file' | 'embedded';

/**
 * Where a subtitle file came from, per Bazarr's history. Omitted when Bazarr
 * has no record, as for a file that came with the video.
 */
export type SubtitleOrigin =
  | 'transcribed'
  | 'downloaded'
  | 'uploaded'
  | 'translated';

export interface SubtitleTrack {
  /** Bazarr's id; what Replace and Delete use. */
  id: number;
  /** ISO 639-1, as Bazarr keys it ("en"). */
  language: string;
  /** ISO 639-2 ("eng"), as Plex keys it, when Bazarr sends it. */
  language3?: string;
  /** "English". */
  name: string;
  kind: SubtitleKind;
  hi: boolean;
  forced: boolean;
  /** For a file beside the video: its name without folders. */
  fileName?: string;
  size?: number;
  /** Transcribed from the audio by Whisper. */
  ai: boolean;
  origin?: SubtitleOrigin;
  /** Download provider ("opensubtitlescom"). */
  provider?: string;
}

export interface MissingSubtitle {
  language: string;
  name: string;
  hi: boolean;
  forced: boolean;
}

export interface MovieSubtitles {
  /** Bazarr language profile name, or null for none. */
  profile: string | null;
  /** Languages the profile wants ("en"). */
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
  /** Bazarr language profile name, or null for none. */
  profile: string | null;
  /** Languages the profile wants ("en"). */
  wanted: string[];
  episodes: EpisodeSubtitles[];
}

/** A manual search result. */
export interface SubtitleSearchResult {
  provider: string;
  /** Bazarr's id for the result, valid only while the search is recent. */
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
  /** Transcribed from the audio on demand. */
  ai: boolean;
}

/**
 * Outcome of a search no subtitle provider had results for:
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
  /** Set only when no provider but Whisper had results. */
  noneFound?: NoneFoundOutcome;
}

/** A job's place in Bazarr's queue, as last read. */
export interface BazarrJobLive {
  state: 'waiting' | 'running';
  /** When it started waiting or running. */
  since: string;
  /** Waiting: jobs ahead of it, running ones included. */
  ahead?: number;
  /** Waiting: jobs Bazarr is running. */
  running?: number;
  /** Waiting: start of the longest-running job. */
  busySince?: string;
  /** Running: Bazarr's progress count, for jobs that report one. */
  progress?: { value: number; max: number };
}

/** A title's transcriptions: queued, running and finished. */
export interface TranscriptionStatus {
  queued: number;
  running: boolean;
  done: number;
  failed: number;
  /** Bazarr is searching providers for the title's missing subtitles. */
  searching: boolean;
  /** Queued or running jobs started because a search found nothing. */
  auto: number;
  /** Series only: the episode being transcribed. */
  current?: { seasonNumber: number; episodeNumber: number };
  /** The running job is still queued inside Bazarr. */
  waitingInBazarr?: boolean;
  /** The search job in Bazarr's queue. */
  searchJob?: BazarrJobLive;
  /** The running transcription in Bazarr's queue. */
  transcribeJob?: BazarrJobLive;
  /** Why the last failed job failed. */
  error?: SubtitleError;
}

/**
 * Why a subtitles request failed, for the page to show in the viewer's
 * language. Error responses carry it beside an English `message` for other
 * API clients.
 */
export type SubtitleErrorCode =
  /** Subtitles are not set up, or are off for this user. */
  | 'off'
  /** Not in Radarr or Sonarr. */
  | 'notInArr'
  /**
   * In Radarr or Sonarr but not (yet) in Bazarr, or on an instance Bazarr
   * does not follow (it follows one of each).
   */
  | 'notInBazarr'
  /** The subtitle file to delete is missing. */
  | 'notOnDisk'
  /** Bazarr's WhisperAI provider is off. */
  | 'whisperOff'
  /** Bazarr paused WhisperAI after an error; see `error` and `retry`. */
  | 'whisperPaused'
  /** Bazarr offered no Whisper transcription. */
  | 'noWhisper'
  /** Bazarr did not answer, or returned an error. */
  | 'bazarrFailed'
  /** A transcription was unfinished after a day. */
  | 'bazarrStuck'
  /** A transcription ended without saving a subtitle. */
  | 'noSubtitleSaved'
  /** The title is not in Plex. */
  | 'notInPlex'
  /** Plex did not answer. */
  | 'plexFailed'
  /** Plex did not offer the subtitle chosen. */
  | 'notOffered'
  /** The viewer has no usable Plex sign-in. */
  | 'noPlexSignIn';

export interface SubtitleError {
  code: SubtitleErrorCode;
  /** whisperPaused: Bazarr's name for the error that paused WhisperAI. */
  error?: string;
  /** whisperPaused: Bazarr's retry time ("in 41 minutes"). */
  retry?: string;
}

/** Which episodes of a series to transcribe. */
export type TranscribeScope =
  | 'missing'
  | 'season'
  | 'notTranscribed'
  | 'episode';

/** A movie subtitle choice in the viewer's Plex player. */
export interface PlexSubtitleOption {
  /** Plex's stream id; 0 is "no subtitles". */
  id: number;
  title: string;
  /** ISO 639-2 ("eng"). */
  language?: string;
  /** A sidecar file rather than an embedded track. */
  external?: boolean;
}

export interface PlexSubtitleDefault {
  /** False when the viewer has no usable Plex sign-in. */
  available: boolean;
  options: PlexSubtitleOption[];
  /** The selected option's id (movie) or language code (series); 0 or "" for none. */
  selected: number | string;
  /** Series only: the choice is by language. */
  languages?: { code: string; title: string }[];
}
