/* ListenBrainz response fields Seerr reads. */

export interface LbFreshRelease {
  artist_credit_name: string;
  artist_mbids: string[];
  /** Cover Art Archive image id and the release it belongs to. */
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

/** A similar artist from ListenBrainz. */
export interface LbSimilarArtist {
  artist_mbid: string;
  name: string;
  /** MusicBrainz's disambiguation ("French electronic duo"). */
  comment?: string;
  /** Person, Group, etc. */
  type?: string | null;
  /** Similarity, relative to others for the same reference artist. */
  score: number;
  /** The artist they're similar to. */
  reference_mbid: string;
}
