import type { DeezerTrack } from '@server/api/deezer';
import { deezer } from '@server/api/deezer';
import {
  chartSongTitle,
  creditedNames,
  plainName,
} from '@server/lib/music/charts';
import { otherTake, splitTitle } from '@server/lib/music/songs';
import { getSettings } from '@server/lib/settings';

/*
 * Looks up a song on Deezer by title, artist and length, for its ISRC (to
 * match on MusicBrainz) and its album and track (to add it to MusicBrainz
 * when missing).
 */

/** Lengths further apart than this are a different recording. */
const SAME_LENGTH_MS = 4000;

export interface CatalogSong {
  deezerId: number;
  title: string;
  artistName: string;
  /** Uppercase ISRC, when Deezer has one. */
  isrc: string | null;
  /** Deezer album id and title. */
  albumId: number;
  album: string;
  trackNumber: number | null;
  discNumber: number | null;
  /** YYYY-MM-DD, when known. */
  releaseDate: string | null;
  /** Milliseconds. */
  length: number;
}

/** Deezer lookups are on unless turned off in Settings → Music. */
export const catalogOn = (): boolean => getSettings().music.deezer !== false;

const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/**
 * Picks the Deezer track matching a playlist song: a credited artist, same
 * title and take (no unnamed live or remix), and similar length when known.
 * Prefers an exact full title, then nearest length, then Deezer's order.
 */
export const trackFor = (
  tracks: DeezerTrack[],
  title: string,
  artistName: string,
  length: number | null | undefined
): DeezerTrack | undefined => {
  const named = chartSongTitle(title);
  const wanted = plainName(splitTitle(named).songTitle);
  const full = plainName(named);
  const artists = new Set(creditedNames(artistName).map(plainName));
  const fullTitle = (t: DeezerTrack) =>
    t.title_version?.trim()
      ? `${t.title_short ?? t.title} ${t.title_version}`
      : t.title;
  const gap = (t: DeezerTrack) =>
    length ? Math.abs(t.duration * 1000 - length) : 0;
  return tracks
    .filter(
      (t) =>
        artists.has(plainName(t.artist?.name ?? '')) &&
        plainName(
          splitTitle(chartSongTitle(t.title_short ?? t.title)).songTitle
        ) === wanted &&
        !otherTake(fullTitle(t), named) &&
        gap(t) <= SAME_LENGTH_MS
    )
    .map((t, i) => ({ t, i }))
    .sort(
      (a, b) =>
        Number(plainName(fullTitle(b.t)) === full) -
          Number(plainName(fullTitle(a.t)) === full) ||
        gap(a.t) - gap(b.t) ||
        a.i - b.i
    )[0]?.t;
};

/** The song on Deezer, or null if absent. Throws when Deezer fails. */
export const catalogSong = async (
  title: string,
  artistName: string,
  length: number | null | undefined
): Promise<CatalogSong | null> => {
  const songTitle = splitTitle(chartSongTitle(title)).songTitle;
  let hit: DeezerTrack | undefined;
  for (const name of creditedNames(artistName)) {
    hit = trackFor(
      await deezer().searchTracks(songTitle, name),
      title,
      artistName,
      length
    );
    if (hit) break;
  }
  if (!hit) return null;
  const track = (await deezer().getTrack(hit.id)) ?? hit;
  const isrc = track.isrc?.trim().toUpperCase().replace(/-/g, '') ?? '';
  return {
    deezerId: track.id,
    title: track.title,
    artistName: track.artist?.name ?? hit.artist.name,
    isrc: ISRC.test(isrc) ? isrc : null,
    albumId: track.album?.id ?? hit.album.id,
    album: track.album?.title ?? hit.album.title,
    trackNumber: track.track_position || null,
    discNumber: track.disk_number || null,
    releaseDate: track.release_date || track.album?.release_date || null,
    length: Math.round((track.duration || hit.duration) * 1000),
  };
};

/** Harmony prefills MusicBrainz's add-release form from a store listing. */
export const HARMONY_URL = 'https://harmony.pulsewidth.org.uk';

export const addToMusicBrainzUrl = (albumId: number): string =>
  `${HARMONY_URL}/release?deezer=${albumId}`;
