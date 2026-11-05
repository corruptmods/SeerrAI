import {
  OTHER_TAKE_WORDS,
  normalizeTitle,
  takeWords,
} from '@server/lib/music/songs';

/*
 * Matches release and file names to albums and songs. Names are all there
 * is: Backfill reads packs by file name before downloading.
 */

const AUDIO = /\.(flac|mp3|m4a|aac|ogg|oga|opus|wav|aiff?|alac|ape|wv|wma)$/i;

/** A quoted file name in a Usenet post title ("Album \"03 - Song.mp3\""). */
const QUOTED = /(?:"|%22)[^"]*?(?:"|%22)/g;

export const isAudio = (path: string): boolean => AUDIO.test(path);

/**
 * Two normalisations, each compared alike: apostrophes as spaces ("it s",
 * as titles and tags have it) and dropped ("its", common in file names).
 */
type Form = (text: string) => string;
const words: Form = takeWords;
const joined: Form = (text) =>
  takeWords(normalizeTitle(text).replace(/'/g, ''));
const FORMS: Form[] = [words, joined];

/**
 * Words marking a different version: another take (live, acoustic, remix,
 * Atmos mix…), a radio edit, or a music video ("[1080p]", "x264").
 * Remasters and deluxe editions count as the same take.
 */
const VERSIONS = new RegExp(
  String.raw`\b(?:${OTHER_TAKE_WORDS}|radio edit|radio mix|(?:480|576|720|1080|1440|2160)[pi]|[xh] ?26[45]|hevc|music video|mvid|dvdrip)\b`,
  'g'
);

const versionsIn = (text: string): Set<string> =>
  new Set(text.match(VERSIONS) ?? []);

/** True when `name` has a version word `title` lacks. */
const otherVersion = (name: string, title: string): boolean => {
  const own = versionsIn(title);
  return [...versionsIn(name)].some((version) => !own.has(version));
};

/** Whole-word occurrences of a phrase in a space-padded name. */
const timesIn = (t: string, phrase: string): number => {
  let count = 0;
  for (
    let at = t.indexOf(` ${phrase} `);
    at >= 0;
    at = t.indexOf(` ${phrase} `, at + 1)
  ) {
    count++;
  }
  return count;
};

/**
 * True when a release name is this album by this artist, with no extra
 * version words. Only Various Artists albums may use "VA"; a self-titled
 * album must appear twice ("Artist - Artist"). Quoted file names in Usenet
 * posts are ignored.
 */
export const namesAlbum = (
  title: string,
  album: string,
  artist: string
): boolean => {
  const name = title.replace(QUOTED, ' ');
  return FORMS.some((form) => namesAlbumAs(form, name, album, artist));
};

const namesAlbumAs = (
  form: Form,
  name: string,
  album: string,
  artist: string
): boolean => {
  const t = ` ${form(name)} `;
  const a = form(album);
  const by = form(artist);
  // Symbol or one-letter titles ("÷", "+", "x"): match the raw characters
  // as a separate token, plus the artist.
  if (a.length < 2) {
    const sign = normalizeTitle(album).trim();
    if (!sign || !by) return false;
    const raw = ` ${normalizeTitle(name).replace(/[\s\-–_.()[\]]+/g, ' ')} `;
    return raw.includes(` ${sign} `) && timesIn(t, by) > 0;
  }
  if (!timesIn(t, a)) return false;
  // The artist's name may contain a version word (a band called Live).
  if (otherVersion(t, ` ${a} ${by} `)) return false;
  if (by === 'various artists') {
    return /\b(va|various artists)\b/.test(t);
  }
  return a === by ? timesIn(t, a) >= 2 : timesIn(t, by) > 0;
};

/** Words after the artist's name that mark a discography pack. */
const CATALOG =
  /\b(discography|discografia|diskografie|collection|anthology|singles|complete (albums|works|discography|collection)|\d+ (albums?|releases|singles|eps))\b/;

/**
 * True when a release name is the artist's own discography or collection,
 * led by their name ("Artist - Discography 2011-2021"). Not Various Artists.
 */
export const namesCatalog = (title: string, artist: string): boolean => {
  // Strip leading tags: "(Country)", "[TR24][OF]".
  const name = title
    .replace(QUOTED, ' ')
    .replace(/^\s*(?:[([][^)\]]*[)\]]\s*)+/, '');
  return FORMS.some((form) => {
    const t = form(name);
    const by = form(artist);
    if (!by || by === 'various artists' || !t.startsWith(`${by} `)) {
      return false;
    }
    return CATALOG.test(t.slice(by.length));
  });
};

/**
 * True when a release name has version words `own` lacks (live, remix,
 * karaoke), ignoring quoted file names.
 */
export const namesOtherVersion = (title: string, ...own: string[]): boolean =>
  otherVersion(
    ` ${words(title.replace(QUOTED, ' '))} `,
    ` ${own.map(words).join(' ')} `
  );

/** True when a release name contains the artist as whole words. */
export const namesArtist = (title: string, artist: string): boolean =>
  FORMS.some((form) => {
    const by = form(artist);
    return !!by && timesIn(` ${form(title)} `, by) > 0;
  });

/** A file's folder path joined into one name. */
const foldersOf = (path: string): string =>
  path.replace(/\\/g, '/').split('/').slice(0, -1).join(' ');

/**
 * The song's file in an artist pack, preferring the album's folder. Skips
 * folders of other versions (a live album's "03 - Song.mp3" looks the same).
 */
export const fileInCatalog = <T extends ReleaseFile>(
  files: T[],
  track: string,
  album: string,
  artist: string
): T | undefined => {
  const own = ` ${words(album)} ${words(artist)} ${words(track)} `;
  const usable = files.filter(
    (file) => !otherVersion(` ${words(foldersOf(file.path))} `, own)
  );
  const inAlbum = usable.filter((file) =>
    FORMS.some((form) =>
      ` ${form(foldersOf(file.path))} `.includes(` ${form(album)} `)
    )
  );
  return (
    (inAlbum.length ? fileForTrack(inAlbum, track, artist) : undefined) ??
    fileForTrack(usable, track, artist)
  );
};

const nameOf = (path: string): string =>
  (path.replace(/\\/g, '/').split('/').pop() ?? path).replace(AUDIO, '');

/**
 * The part after the track number in a dash-separated name ("Artist - Album
 * - 03 - Song" → "song"), or ''.
 */
const titleOfFile = (path: string, form: Form = words): string => {
  const parts = nameOf(path).split(/\s+-\s+/);
  let numbered = -1;
  parts.forEach((part, index) => {
    if (/^(\d{1,2}\s+)?[a-d]?\d{1,3}$/.test(words(part))) numbered = index;
  });
  return numbered >= 0 && numbered < parts.length - 1
    ? form(parts.slice(numbered + 1).join(' - '))
    : '';
};

/**
 * Candidate song titles from a file name, without folder, extension, track
 * number or artist ("03 - Artist - Song (Live).flac" → "song live"). Also
 * keeps the number, for titles starting with one. The part after a track
 * number in a dash-separated name comes first.
 */
export const songsOfFile = (
  path: string,
  artist: string,
  form: Form = words
): string[] => {
  const by = form(artist);
  const withoutArtist = (w: string) =>
    by && w.startsWith(`${by} `) ? w.slice(by.length + 1) : w;
  const titled = titleOfFile(path, form);
  const whole = form(nameOf(path));
  // Leading disc/track number: "1 03", "103", "03", "a1".
  const unnumbered = whole.replace(/^(\d{1,2}\s+)?[a-d]?\d{1,3}\s+/, '');
  return [
    ...new Set([
      ...(titled ? [withoutArtist(titled), titled] : []),
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
 * The release file for this song: an exact name match, else the shortest
 * name containing it, never one with extra version words ("Song (Live)").
 * In "Album - 03 - Song" only the part after the number counts. Skips
 * samples, tiny files and whole-album images (with a .cue beside them).
 */
export const fileForTrack = <T extends ReleaseFile>(
  files: T[],
  track: string,
  artist: string
): T | undefined => {
  if (!words(track)) return undefined;
  const base = (path: string) => path.replace(/\.[^./\\]+$/, '').toLowerCase();
  const sheets = new Set(
    files.filter((f) => /\.cue$/i.test(f.path)).map((f) => base(f.path))
  );
  const audio = files.filter(
    (f) => isAudio(f.path) && f.size >= 200 * 1024 && !sheets.has(base(f.path))
  );
  const readings = FORMS.map((form) => {
    const by = form(artist);
    return {
      want: form(track),
      named: audio.map((file) => {
        const titled = titleOfFile(file.path, form);
        return {
          file,
          songs: songsOfFile(file.path, artist, form),
          // A name with a numbered title part matches on that part only.
          holding: titled
            ? [
                ...new Set([
                  titled,
                  by && titled.startsWith(`${by} `)
                    ? titled.slice(by.length + 1)
                    : titled,
                ]),
              ]
            : undefined,
        };
      }),
    };
  });
  for (const { want, named } of readings) {
    const exact = named.find((n) => n.songs.includes(want));
    if (exact) return exact.file;
  }
  return readings
    .flatMap(({ want, named }) =>
      named.map((n) => ({
        file: n.file,
        length: Math.min(
          ...(n.holding ?? n.songs)
            .filter(
              (song) =>
                ` ${song} `.includes(` ${want} `) &&
                !otherVersion(` ${song} `, ` ${want} `)
            )
            .map((song) => song.length)
        ),
      }))
    )
    .filter((n) => Number.isFinite(n.length))
    .sort((a, b) => a.length - b.length)[0]?.file;
};
