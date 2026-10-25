import { normalizeTitle } from '@server/lib/music/songs';

/*
 * Reading a release of an album, to take songs from it: whether its name
 * is the album's, and which of its files is each song. Nothing here asks
 * anything; the names are all there is to go on, as Backfill's packs are
 * read by their file names before anything downloads.
 */

/** Files a song can be. */
const AUDIO = /\.(flac|mp3|m4a|aac|ogg|oga|opus|wav|aiff?|alac|ape|wv|wma)$/i;

export const isAudio = (path: string): boolean => AUDIO.test(path);

/** Words only: punctuation and brackets as spaces, case and accents aside. */
const words = (text: string): string =>
  normalizeTitle(text)
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Whether a release's name is this album of this artist: it names the
 * album, and the artist too (a compilation of many may say "VA" instead).
 */
export const namesAlbum = (
  title: string,
  album: string,
  artist: string
): boolean => {
  const t = ` ${words(title)} `;
  const a = words(album);
  const by = words(artist);
  return (
    a.length >= 2 &&
    t.includes(` ${a} `) &&
    (t.includes(` ${by} `) || /\b(va|various artists)\b/.test(t))
  );
};

/**
 * A file's name as the song it may be, without its folder, extension,
 * track number or artist: "03 - Artist - Song (Live).flac" is "song live".
 * With the number kept too, for a song whose title starts with one ("99
 * Problems").
 */
export const songsOfFile = (path: string, artist: string): string[] => {
  const name = (path.replace(/\\/g, '/').split('/').pop() ?? path).replace(
    AUDIO,
    ''
  );
  const by = words(artist);
  const withoutArtist = (w: string) =>
    by && w.startsWith(`${by} `) ? w.slice(by.length + 1) : w;
  const whole = words(name);
  // A disc and track number in front: "1 03", "103", "03", "a1".
  const unnumbered = whole.replace(/^(\d{1,2}\s+)?[a-d]?\d{1,3}\s+/, '');
  return [
    ...new Set([
      withoutArtist(unnumbered),
      withoutArtist(whole),
      unnumbered,
      whole,
    ]),
  ].filter(Boolean);
};

export interface ReleaseFile {
  index: number;
  path: string;
  size: number;
}

/**
 * The file in a release that is this song: the one named just as the
 * track, else the one whose name holds it, the shortest of those (not
 * "Song (Remix)" for "Song"). Samples and tiny files are passed over.
 */
export const fileForTrack = <T extends ReleaseFile>(
  files: T[],
  track: string,
  artist: string
): T | undefined => {
  const want = words(track);
  if (!want) return undefined;
  const audio = files.filter((f) => isAudio(f.path) && f.size >= 200 * 1024);
  const named = audio.map((file) => ({
    file,
    songs: songsOfFile(file.path, artist),
  }));
  const exact = named.filter((n) => n.songs.includes(want));
  if (exact.length) return exact[0].file;
  return named
    .map((n) => ({
      file: n.file,
      length: Math.min(
        ...n.songs
          .filter((song) => ` ${song} `.includes(` ${want} `))
          .map((song) => song.length)
      ),
    }))
    .filter((n) => Number.isFinite(n.length))
    .sort((a, b) => a.length - b.length)[0]?.file;
};
