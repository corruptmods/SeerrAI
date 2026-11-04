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
 * A song as the stores list it, looked up on Deezer by its title, artist
 * and length: its ISRC, the code of the very recording, to match it on
 * MusicBrainz by, and the album and track it is found on there, for adding
 * it to MusicBrainz when MusicBrainz has no such song.
 */

/** Lengths further apart than this are another recording. */
const SAME_LENGTH_MS = 4000;

export interface CatalogSong {
  /** Deezer's id for the track. */
  deezerId: number;
  title: string;
  artistName: string;
  /** ISRC, in capitals, when Deezer has one. */
  isrc: string | null;
  /** Deezer's id for its album, and the album's title. */
  albumId: number;
  album: string;
  trackNumber: number | null;
  discNumber: number | null;
  /** YYYY-MM-DD, when known. */
  releaseDate: string | null;
  /** Milliseconds. */
  length: number;
}

/** Whether Deezer is asked: on unless turned off in Settings → Music. */
export const catalogOn = (): boolean => getSettings().music.deezer !== false;

const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/**
 * Which of Deezer's tracks is the song a playlist names: by one of the
 * artists it credits, titled as it is, the same take (never a live or
 * remixed one the title doesn't name), and as long as it is, when its
 * length is known. A track titled in full as the playlist titles it comes
 * first, then the nearest in length, then the best known.
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

/**
 * The song on Deezer, or null when Deezer has no such track. Throws when
 * Deezer can't be asked.
 */
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

/**
 * Harmony, which fills in MusicBrainz's form for adding a release from a
 * store's listing of it: the way to add a song MusicBrainz doesn't have.
 */
export const HARMONY_URL = 'https://harmony.pulsewidth.org.uk';

export const addToMusicBrainzUrl = (albumId: number): string =>
  `${HARMONY_URL}/release?deezer=${albumId}`;
