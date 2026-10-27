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
  MbMedium,
  MbReleaseGroup,
} from '@server/api/musicbrainz/interfaces';
import type { MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { PlayLink } from '@server/entity/Media';
import type { Song } from '@server/lib/music/songs';
import { albumFor, singleFor } from '@server/lib/music/songs';

/*
 * Artists and albums as the pages show them, shaped from MusicBrainz and
 * ListenBrainz answers. An artist's own record here (mediaInfo) has been
 * through mediaForViewer before it is attached; an album's status is its
 * MusicAlbum's.
 */

export interface MusicArtistResult {
  mediaType: 'artist';
  /** The artist's MusicBrainz id. */
  id: string;
  name: string;
  disambiguation?: string;
  /** Person, Group, Orchestra, Choir, Character or Other. */
  type?: string;
  country?: string;
  /** The artist's status here, when Seerr has them. */
  status?: MediaStatus;
}

export interface MusicAlbumResult {
  mediaType: 'album';
  /** The album's MusicBrainz release-group id. */
  id: string;
  title: string;
  /** Album, EP, Single, Broadcast or Other. */
  primaryType?: string;
  /** Live, Compilation, Soundtrack, Remix and so on. */
  secondaryTypes: string[];
  /** As precise as MusicBrainz knows it: "2004", "2004-03" or a full date. */
  releaseDate?: string;
  /** The first credited artist, whom the album belongs to here. */
  artistId?: string;
  /** Everyone credited, as MusicBrainz writes it ("A feat. B"). */
  artistName?: string;
  /** Its front cover at the Cover Art Archive; may not exist. */
  coverUrl: string;
  /** The album's status here, when Seerr has it. */
  status?: MediaStatus;
  /**
   * Lidarr has its files and no media server lists it yet: it is being
   * added to the library.
   */
  addingToLibrary?: boolean;
}

export interface MusicLink {
  /** MusicBrainz's name for the link: official homepage, wikipedia... */
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
  /** The start of their Wikipedia article, as plain text. */
  biography: string | null;
  mediaInfo?: Media;
}

export interface MusicAlbumDetails extends MusicAlbumResult {
  disambiguation?: string;
  genres: string[];
  /** Everyone credited, in order. */
  artists: { id: string; name: string; joinphrase?: string }[];
  /** The artist's own record here. */
  mediaInfo?: Media;
  /** Where to play the album: each connected server that has it. */
  playLinks: PlayLink[];
}

/** Where a song stands here, when it is asked for or coming. */
export interface MusicSongStatus {
  /**
   * Its own request's (pending, processing, available), or else that of
   * the album bringing it.
   */
  status?: MediaStatus;
  /** The album here or on its way that brings it, when one does. */
  onAlbum?: { id: string; title: string };
}

/** One version of a song: a MusicBrainz recording. */
export interface MusicSongVersion extends MusicSongStatus {
  /** The recording's MusicBrainz id. */
  id: string;
  title: string;
  /** What tells it apart ("radio edit"), when anything does. */
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
  /** How many releases it is on. */
  releaseCount: number;
  /**
   * It is on no single or EP of the artist's, only on albums, so it cannot
   * be fetched, or asked for, on its own.
   */
  onlyOnAlbums?: boolean;
}

/** A song: one artist's versions of one title. */
export interface MusicSongResult {
  mediaType: 'song';
  /** The artist and title, as one key. */
  id: string;
  title: string;
  /** The first credited artist, whom the song belongs to here. */
  artistId: string;
  /** Everyone credited, as MusicBrainz writes it ("A feat. B"). */
  artistName: string;
  /** Best known first. */
  versions: MusicSongVersion[];
  /** Song requests are switched off: only its album can be asked for. */
  canRequest?: false;
}

export interface MusicSongSearchResponse {
  songs: MusicSongResult[];
}

export interface MusicTrack extends MusicSongStatus {
  disc: number;
  /** The disc's own name, when it has one. */
  discTitle?: string;
  position: number;
  /** As printed: "1", "A1"... */
  number?: string;
  title: string;
  /** Milliseconds. */
  length?: number | null;
  /** The recording on this track: the version asked for when it is. */
  recordingId?: string;
  /**
   * It is on no single or EP of the artist's, and songs aren't taken from
   * albums here, so it can't be asked for by itself: its album can.
   */
  onlyOnAlbums?: boolean;
  /** Whether it is on a single is still being looked up. */
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
 * Links worth showing: https addresses only, of the kinds people follow.
 * MusicBrainz lists dozens (lyrics sites, databases, shops).
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
  genres: [...(artist.genres ?? [])]
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .map((genre) => genre.name),
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
  genres: [...(group.genres ?? [])]
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .map((genre) => genre.name),
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

/** A song and its versions as search shows them, with where each stands. */
export const mapSongResult = (
  song: Song,
  standing: Map<string, MusicSongStatus>,
  /** Songs on no single can be taken from their albums. */
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
 * ListenBrainz's own cover for a release when it names one (it knows the
 * Cover Art Archive has it), else the album's.
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
