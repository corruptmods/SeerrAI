import {
  COVER_ART_ARCHIVE_URL,
  albumCoverUrl,
  releaseCoverPath,
} from '@server/api/coverartarchive';
import type { LbFreshRelease } from '@server/api/listenbrainz/interfaces';
import { isMbid } from '@server/api/musicbrainz';
import type {
  MbArtist,
  MbArtistCredit,
  MbGenre,
  MbMedium,
  MbReleaseGroup,
} from '@server/api/musicbrainz/interfaces';
import type { MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { PlayLink } from '@server/entity/Media';
import type { Song } from '@server/lib/music/songs';
import { albumFor, singleFor } from '@server/lib/music/songs';

/*
 * Artists and albums for the pages, mapped from MusicBrainz and ListenBrainz.
 * An artist's mediaInfo has been through mediaForViewer before it is
 * attached; an album's status is its MusicAlbum's.
 */

export interface MusicArtistResult {
  mediaType: 'artist';
  /** MusicBrainz artist id. */
  id: string;
  name: string;
  disambiguation?: string;
  /** Person, Group, Orchestra, Choir, Character or Other. */
  type?: string;
  country?: string;
  /** Seerr's status for the artist, if tracked. */
  status?: MediaStatus;
}

export interface MusicAlbumResult {
  mediaType: 'album';
  /** MusicBrainz release-group id. */
  id: string;
  title: string;
  /** Album, EP, Single, Broadcast or Other. */
  primaryType?: string;
  /** Live, Compilation, Soundtrack, Remix, etc. */
  secondaryTypes: string[];
  /** "2004", "2004-03" or a full date, as precise as MusicBrainz has it. */
  releaseDate?: string;
  /** The first credited artist, who owns the album here. */
  artistId?: string;
  /** Full credit as MusicBrainz writes it ("A feat. B"). */
  artistName?: string;
  /** Cover Art Archive front cover; may not exist. */
  coverUrl: string;
  /** Seerr's status for the album, if tracked. */
  status?: MediaStatus;
  /** Lidarr has the files but no media server lists it yet. */
  addingToLibrary?: boolean;
}

export interface MusicLink {
  /** MusicBrainz link type: official homepage, wikipedia... */
  kind: string;
  url: string;
}

export interface MusicArtistDetails extends MusicArtistResult {
  sortName?: string;
  area?: string;
  beginDate?: string;
  endDate?: string;
  ended: boolean;
  genres: string[];
  links: MusicLink[];
  /** Plain-text start of their Wikipedia article. */
  biography: string | null;
  mediaInfo?: Media;
}

export interface MusicAlbumDetails extends MusicAlbumResult {
  disambiguation?: string;
  genres: string[];
  /** All credited artists, in order. */
  artists: { id: string; name: string; joinphrase?: string }[];
  /** The artist's Seerr media record. */
  mediaInfo?: Media;
  /** Each connected server that has the album. */
  playLinks: PlayLink[];
}

/** A song's status when requested or on its way. */
export interface MusicSongStatus {
  /** Its own request's status, else that of the album bringing it. */
  status?: MediaStatus;
  /** The album that brings it, if any. */
  onAlbum?: { id: string; title: string };
}

/** One version of a song: a MusicBrainz recording. */
export interface MusicSongVersion extends MusicSongStatus {
  /** MusicBrainz recording id. */
  id: string;
  title: string;
  /** Distinguishing label ("radio edit"), if any. */
  version?: string;
  /** Milliseconds. */
  length?: number | null;
  /** The album or single it is best known from. */
  from?: {
    id: string;
    title: string;
    primaryType?: string;
    secondaryTypes: string[];
    coverUrl: string;
  };
  releaseCount: number;
  /**
   * On no single or EP of the artist's, so it can't be fetched or requested
   * alone.
   */
  onlyOnAlbums?: boolean;
}

/** A song: one artist's versions of one title. */
export interface MusicSongResult {
  mediaType: 'song';
  /** Artist and title as one key. */
  id: string;
  title: string;
  /** The first credited artist, who owns the song here. */
  artistId: string;
  /** Full credit as MusicBrainz writes it ("A feat. B"). */
  artistName: string;
  /** Best known first. */
  versions: MusicSongVersion[];
  /** Song requests are off; only its album can be requested. */
  canRequest?: false;
}

export interface MusicSongSearchResponse {
  songs: MusicSongResult[];
}

export interface MusicTrack extends MusicSongStatus {
  disc: number;
  /** The disc's title, if any. */
  discTitle?: string;
  position: number;
  /** As printed: "1", "A1"... */
  number?: string;
  title: string;
  /** Milliseconds. */
  length?: number | null;
  /** The track's recording: the version requested when it is. */
  recordingId?: string;
  /**
   * On no single or EP of the artist's, and songs aren't taken from albums
   * here, so only its album can be requested.
   */
  onlyOnAlbums?: boolean;
  /** Still checking whether it is on a single. */
  checking?: boolean;
}

export interface MusicPage<T> {
  page: number;
  totalPages: number;
  totalResults: number;
  results: T[];
}

export interface MusicSearchResponse {
  artists: MusicArtistResult[];
  albums: MusicAlbumResult[];
}

/** Statuses by MusicBrainz id. */
export type Statuses = Map<string, MediaStatus>;

const credited = (credits: MbArtistCredit[] = []) =>
  credits.length
    ? credits.map((c) => `${c.name}${c.joinphrase ?? ''}`).join('')
    : undefined;

export const mapArtistResult = (
  artist: MbArtist,
  statuses?: Statuses
): MusicArtistResult => ({
  mediaType: 'artist',
  id: artist.id,
  name: artist.name,
  disambiguation: artist.disambiguation || undefined,
  type: artist.type ?? undefined,
  country: artist.country ?? undefined,
  status: statuses?.get(artist.id),
});

export const mapAlbumResult = (
  group: MbReleaseGroup,
  statuses?: Statuses
): MusicAlbumResult => ({
  mediaType: 'album',
  id: group.id,
  title: group.title,
  primaryType: group['primary-type'] ?? undefined,
  secondaryTypes: group['secondary-types'] ?? [],
  releaseDate: group['first-release-date'] || undefined,
  artistId: group['artist-credit']?.[0]?.artist.id,
  artistName: credited(group['artist-credit']),
  coverUrl: albumCoverUrl(group.id),
  status: statuses?.get(group.id),
});

/**
 * Link types worth showing (https only); MusicBrainz lists dozens (lyrics
 * sites, databases, shops).
 */
const LINK_KINDS = [
  'official homepage',
  'wikipedia',
  'wikidata',
  'bandcamp',
  'soundcloud',
  'youtube',
  'free streaming',
  'streaming',
  'social network',
];

const linksOf = (artist: MbArtist): MusicLink[] =>
  (artist.relations ?? [])
    .filter(
      (relation) =>
        LINK_KINDS.includes(relation.type) &&
        relation.url?.resource.startsWith('https://')
    )
    .map((relation) => ({
      kind: relation.type,
      url: relation.url!.resource,
    }));

const genreNames = (genres?: MbGenre[]): string[] =>
  [...(genres ?? [])]
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .map((genre) => genre.name);

export const mapArtistDetails = (
  artist: MbArtist,
  { biography, mediaInfo }: { biography: string | null; mediaInfo?: Media }
): MusicArtistDetails => ({
  ...mapArtistResult(artist),
  status: mediaInfo?.status,
  sortName: artist['sort-name'],
  area: artist.area?.name,
  beginDate: artist['life-span']?.begin ?? undefined,
  endDate: artist['life-span']?.end ?? undefined,
  ended: !!artist['life-span']?.ended,
  genres: genreNames(artist.genres),
  links: linksOf(artist),
  biography,
  mediaInfo,
});

export const mapAlbumDetails = (
  group: MbReleaseGroup,
  {
    status,
    mediaInfo,
    playLinks = [],
  }: { status?: MediaStatus; mediaInfo?: Media; playLinks?: PlayLink[] }
): MusicAlbumDetails => ({
  ...mapAlbumResult(group),
  status,
  disambiguation: group.disambiguation || undefined,
  genres: genreNames(group.genres),
  artists: (group['artist-credit'] ?? []).map((credit) => ({
    id: credit.artist.id,
    name: credit.name,
    joinphrase: credit.joinphrase || undefined,
  })),
  mediaInfo,
  playLinks,
});

export const mapTracks = (media: MbMedium[]): MusicTrack[] =>
  media.flatMap((medium) =>
    (medium.tracks ?? []).map((track) => ({
      disc: medium.position,
      discTitle: medium.title || undefined,
      position: track.position,
      number: track.number,
      title: track.title,
      length: track.length ?? track.recording?.length ?? null,
      recordingId: track.recording?.id,
    }))
  );

/** A song and its versions for search, with each version's status. */
export const mapSongResult = (
  song: Song,
  standing: Map<string, MusicSongStatus>,
  /** Allow taking songs on no single from their albums. */
  fromAlbums = false
): MusicSongResult => ({
  mediaType: 'song',
  id: song.key,
  title: song.title,
  artistId: song.artistMbid,
  artistName: song.artistName,
  versions: song.versions.map((version) => ({
    id: version.mbId,
    title: version.title,
    version: version.version ?? undefined,
    length: version.length,
    from: version.from
      ? {
          id: version.from.mbId,
          title: version.from.title,
          primaryType: version.from.primaryType ?? undefined,
          secondaryTypes: version.from.secondaryTypes,
          coverUrl: albumCoverUrl(version.from.mbId),
        }
      : undefined,
    releaseCount: version.releaseCount,
    ...(singleFor(version) || (fromAlbums && albumFor(version))
      ? {}
      : { onlyOnAlbums: true }),
    ...standing.get(version.mbId),
  })),
});

/**
 * The release cover ListenBrainz names (it knows the Cover Art Archive has
 * it), else the album's.
 */
const listenBrainzCover = (
  releaseGroupId: string,
  caaReleaseId?: string | null
): string =>
  caaReleaseId && isMbid(caaReleaseId)
    ? `${COVER_ART_ARCHIVE_URL}${releaseCoverPath(caaReleaseId)}`
    : albumCoverUrl(releaseGroupId);

export const mapFreshRelease = (
  release: LbFreshRelease,
  statuses?: Statuses
): MusicAlbumResult => ({
  mediaType: 'album',
  id: release.release_group_mbid,
  title: release.release_name,
  primaryType: release.release_group_primary_type ?? undefined,
  secondaryTypes: release.release_group_secondary_type
    ? [release.release_group_secondary_type]
    : [],
  releaseDate: release.release_date || undefined,
  artistId: release.artist_mbids?.[0],
  artistName: release.artist_credit_name,
  coverUrl: listenBrainzCover(
    release.release_group_mbid,
    release.caa_release_mbid
  ),
  status: statuses?.get(release.release_group_mbid),
});
