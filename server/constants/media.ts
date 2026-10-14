export enum MediaRequestStatus {
  PENDING = 1,
  APPROVED,
  DECLINED,
  FAILED,
  COMPLETED,
}

/** The longest reason that can be given for declining a request. */
export const DECLINE_REASON_MAX_LENGTH = 500;

export enum MediaType {
  MOVIE = 'movie',
  TV = 'tv',
  /** An artist, whose albums are kept as MusicAlbum rows. */
  MUSIC = 'music',
}

/**
 * Films and series: what everything built around TMDB, Radarr and Sonarr
 * works on. Code that goes through titles in bulk keeps to these, so an
 * artist never reaches a lookup or a service meant for video.
 */
export type VideoMediaType = MediaType.MOVIE | MediaType.TV;

export const VIDEO_MEDIA_TYPES: readonly VideoMediaType[] = [
  MediaType.MOVIE,
  MediaType.TV,
];

export const isVideo = (
  mediaType: MediaType | string | undefined
): mediaType is VideoMediaType =>
  mediaType === MediaType.MOVIE || mediaType === MediaType.TV;

/**
 * MusicBrainz's "Various Artists", credited on compilations. Lidarr cannot
 * add it, so its albums cannot be requested.
 */
export const VARIOUS_ARTISTS_MBID = '89ad4ac3-39f7-470e-963a-56509c546377';

export enum MediaStatus {
  UNKNOWN = 1,
  PENDING,
  PROCESSING,
  PARTIALLY_AVAILABLE,
  AVAILABLE,
  BLOCKLISTED,
  DELETED,
}
