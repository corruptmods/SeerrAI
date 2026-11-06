import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import type { PaginatedResponse } from './common';

export interface UserResultsResponse extends PaginatedResponse {
  results: User[];
}

export interface UserRequestsResponse extends PaginatedResponse {
  results: MediaRequest[];
}

export interface QuotaStatus {
  days?: number;
  limit?: number;
  used: number;
  remaining?: number;
  restricted: boolean;
}

export interface QuotaResponse {
  movie: QuotaStatus;
  tv: QuotaStatus;
  /**
   * Albums (counted like seasons) and songs (one each), unless songs have
   * their own limit.
   */
  music: QuotaStatus;
  /** Songs, when Settings → Music gives them their own limit. */
  song?: QuotaStatus;
  /**
   * Requests over a limit wait for an admin instead of being refused
   * (Settings → Users).
   */
  overQuotaWaits: boolean;
}

export interface UserWatchDataResponse {
  recentlyWatched: Media[];
  playCount: number;
}
