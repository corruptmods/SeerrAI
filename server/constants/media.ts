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
}

export enum MediaStatus {
  UNKNOWN = 1,
  PENDING,
  PROCESSING,
  PARTIALLY_AVAILABLE,
  AVAILABLE,
  BLOCKLISTED,
  DELETED,
}
