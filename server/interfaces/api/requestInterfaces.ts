import type { MediaType } from '@server/constants/media';
import type { SeriesType } from '@server/constants/seriesType';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties, PaginatedResponse } from './common';

export interface RequestResultsResponse extends PaginatedResponse {
  results: (NonFunctionProperties<MediaRequest> & {
    profileName?: string;
    canRemove?: boolean;
  })[];
  serviceErrors: {
    radarr: { id: number; name: string }[];
    sonarr: { id: number; name: string }[];
  };
}

export type MediaRequestBody = {
  mediaType: MediaType;
  mediaId: number;
  tvdbId?: number;
  seasons?: number[] | 'all';
  /**
   * Optional per-season episode selection, keyed by season number. A season
   * absent from this map, or mapped to an empty array, means the whole season.
   */
  episodes?: Record<number, number[]>;
  is4k?: boolean;
  serverId?: number;
  profileId?: number;
  profileName?: string;
  rootFolder?: string;
  languageProfileId?: number;
  userId?: number;
  tags?: number[];
  /**
   * Anime or not, as whoever requested it ticked it ('anime' or 'standard');
   * left out or null, it goes by the title's setting, rules and detection.
   */
  seriesType?: SeriesType | null;
  ignoreQuota?: boolean;
};
