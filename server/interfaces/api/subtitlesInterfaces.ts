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
  /** Why the last one that failed did, in words an admin can act on. */
  error?: string;
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
