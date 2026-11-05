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
  /** With playlists=group: playlists whose requests are not in `results`. */
  playlists?: PlaylistRequestGroup[];
}

/** One playlist's song requests, shown as a group. */
export interface PlaylistRequestGroup {
  listId: number;
  /** The viewer may open the playlist (lists are private). */
  canOpen: boolean;
  /** Who linked it and owns these requests. */
  requestedBy: { id: number; displayName: string; avatar: string };
  /** Song count. */
  songs: number;
  here: number;
  /** Requested and on their way. */
  onTheWay: number;
  /** Awaiting admin approval. */
  approval: number;
  /** Not requested yet: being found, or waiting on the user's limit. */
  waiting: number;
  /** Couldn't be requested or downloaded. */
  failed: number;
  /** Album ids for card covers. */
  albums: string[];
  /** Latest request time. */
  latestAt: string;
}

export type MediaRequestBody = {
  mediaType: MediaType;
  mediaId: number;
  tvdbId?: number;
  seasons?: number[] | 'all';
  /**
   * Episodes per season number. A season absent or mapped to [] means the
   * whole season.
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
   * The requester's anime choice; omitted or null uses the title's setting,
   * rules and detection.
   */
  seriesType?: SeriesType | null;
  ignoreQuota?: boolean;
};

/** A Lidarr request for one artist's albums. */
export type MusicRequestBody = {
  /** MusicBrainz artist id. */
  artistMbid: string;
  /** MusicBrainz release-group ids. */
  albums?: string[];
  /** MusicBrainz recording ids, one version per song. */
  songs?: string[];
  serverId?: number;
  profileId?: number;
  metadataProfileId?: number;
  rootFolder?: string;
  tags?: number[];
  userId?: number;
  ignoreQuota?: boolean;
};
