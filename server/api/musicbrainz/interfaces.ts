/*
 * MusicBrainz's answers (https://musicbrainz.org/doc/MusicBrainz_API), only
 * the parts Seerr reads. Dates are as precise as MusicBrainz knows them:
 * "2004", "2004-03" or "2004-03-15".
 */

export interface MbLifeSpan {
  begin?: string | null;
  end?: string | null;
  ended?: boolean | null;
}

export interface MbGenre {
  id?: string;
  name: string;
  count?: number;
}

export interface MbUrlRelation {
  type: string;
  url?: { id?: string; resource: string };
}

export interface MbArtist {
  id: string;
  name: string;
  'sort-name'?: string;
  /** Group, Person, Orchestra, Choir, Character or Other. */
  type?: string | null;
  disambiguation?: string;
  country?: string | null;
  area?: { id: string; name: string } | null;
  'life-span'?: MbLifeSpan;
  genres?: MbGenre[];
  aliases?: { name: string; 'sort-name'?: string; type?: string | null }[];
  relations?: MbUrlRelation[];
  /** Search results only: the tags people gave it, with their votes. */
  tags?: MbGenre[];
  /** Search results only: how well it matched, out of 100. */
  score?: number;
}

export interface MbArtistCredit {
  name: string;
  joinphrase?: string;
  artist: Pick<MbArtist, 'id' | 'name' | 'sort-name' | 'disambiguation'>;
}

export interface MbReleaseSummary {
  id: string;
  title: string;
  /** Official, Promotion, Bootleg or Pseudo-Release. */
  status?: string | null;
  date?: string;
  country?: string | null;
}

export interface MbReleaseGroup {
  id: string;
  title: string;
  /** Album, Single, EP, Broadcast or Other. */
  'primary-type'?: string | null;
  /** Compilation, Live, Soundtrack, Remix and so on. */
  'secondary-types'?: string[];
  'first-release-date'?: string;
  disambiguation?: string;
  'artist-credit'?: MbArtistCredit[];
  releases?: MbReleaseSummary[];
  genres?: MbGenre[];
  /** Search results only: how many releases it has. */
  count?: number;
  /** Search results only: how well it matched, out of 100. */
  score?: number;
}

export interface MbTrack {
  id: string;
  position: number;
  number?: string;
  title: string;
  /** Milliseconds. */
  length?: number | null;
  recording?: { id: string; title: string; length?: number | null };
}

export interface MbMedium {
  position: number;
  format?: string | null;
  title?: string;
  'track-count'?: number;
  tracks?: MbTrack[];
}

export interface MbRelease extends MbReleaseSummary {
  'release-group'?: MbReleaseGroup;
  media?: MbMedium[];
}

/** A release a recording is on, as a recording search gives it. */
export interface MbRecordingRelease extends MbReleaseSummary {
  /** Whom the release is by: Various Artists on a compilation. */
  'artist-credit'?: MbArtistCredit[];
  'release-group'?: Pick<
    MbReleaseGroup,
    'id' | 'title' | 'primary-type' | 'secondary-types'
  >;
  /** The medium and track the recording is on: `track`, not `tracks`. */
  media?: {
    position?: number;
    format?: string | null;
    track?: { id: string; number?: string; title: string }[];
  }[];
}

/**
 * One recording: a song as recorded once, in one version. A radio edit
 * and the album take are different recordings of the same song.
 */
export interface MbRecording {
  id: string;
  title: string;
  /** What tells it apart: "radio edit", "live, 2013-05-31: …". */
  disambiguation?: string;
  /** Milliseconds. */
  length?: number | null;
  video?: boolean | null;
  'first-release-date'?: string;
  'artist-credit'?: MbArtistCredit[];
  releases?: MbRecordingRelease[];
  /** Search results only: how well it matched, out of 100. */
  score?: number;
}

export interface MbRecordingSearchResponse {
  count: number;
  offset: number;
  recordings: MbRecording[];
}

export interface MbArtistSearchResponse {
  count: number;
  offset: number;
  artists: MbArtist[];
}

export interface MbReleaseGroupSearchResponse {
  count: number;
  offset: number;
  'release-groups': MbReleaseGroup[];
}

/** A page of an artist's release groups (browse, not search). */
export interface MbReleaseGroupBrowseResponse {
  'release-group-count': number;
  'release-group-offset': number;
  'release-groups': MbReleaseGroup[];
}

/** The website's Wikipedia extract for an artist, with its HTML. */
export interface MbWikipediaExtractResponse {
  wikipediaExtract?: {
    url?: string;
    language?: string;
    content?: string;
  } | null;
}
