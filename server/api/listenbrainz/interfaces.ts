/* ListenBrainz's answers, only the parts Seerr reads. */

export interface LbFreshRelease {
  artist_credit_name: string;
  artist_mbids: string[];
  /** The release whose cover the Cover Art Archive has, and its id there. */
  caa_id?: number | null;
  caa_release_mbid?: string | null;
  release_date: string;
  release_group_mbid: string;
  release_group_primary_type?: string | null;
  release_group_secondary_type?: string | null;
  release_mbid: string;
  release_name: string;
}

export interface LbFreshReleasesResponse {
  payload: {
    releases: LbFreshRelease[];
  };
}

export interface LbTopReleaseGroup {
  artist_mbids: string[];
  artist_name: string;
  caa_id?: number | null;
  caa_release_mbid?: string | null;
  listen_count: number;
  release_group_mbid?: string | null;
  release_group_name: string;
}

export interface LbTopReleaseGroupsResponse {
  payload: {
    count: number;
    offset: number;
    range: string;
    last_updated: number;
    release_groups: LbTopReleaseGroup[];
  };
}

export interface LbTopArtist {
  artist_mbid?: string | null;
  artist_name: string;
  listen_count: number;
}

export interface LbTopArtistsResponse {
  payload: {
    count: number;
    offset: number;
    range: string;
    last_updated: number;
    artists: LbTopArtist[];
  };
}

/** An artist ListenBrainz finds people listen to alongside another. */
export interface LbSimilarArtist {
  artist_mbid: string;
  name: string;
  /** MusicBrainz's disambiguation ("French electronic duo"). */
  comment?: string;
  /** Person, Group and so on. */
  type?: string | null;
  /** How strongly, against the others for the same artist. */
  score: number;
  /** The artist they are like. */
  reference_mbid: string;
}
