import {
  OTHER_TAKE_WORDS,
  normalizeTitle,
  takeWords,
} from '@server/lib/music/songs';

/*
 * Reading a release of an album, to take songs from it: whether its name
 * is the album's, and which of its files is each song. Nothing here asks
 * anything; the names are all there is to go on, as Backfill's packs are
 * read by their file names before anything downloads.
 */

/** Files a song can be. */
const AUDIO = /\.(flac|mp3|m4a|aac|ogg|oga|opus|wav|aiff?|alac|ape|wv|wma)$/i;

export const isAudio = (path: string): boolean => AUDIO.test(path);

/**
 * A name as words, two ways: apostrophes as spaces ("It's" as "it s", as
 * a title or a tagged file has it) and dropped ("its", as file and release
 * names often have it). Names are compared each way, alike.
 */
type Form = (text: string) => string;
const words: Form = takeWords;
const joined: Form = (text) =>
  takeWords(normalizeTitle(text).replace(/'/g, ''));
const FORMS: Form[] = [words, joined];

/**
 * Words that make a release, or a file, another version of what it names:
 * another take of its songs (live, acoustic, a remix, a Dolby Atmos mix…),
 * a radio edit, which is no album, or a music video ("[1080p]", "x264").
 * A remaster or a deluxe edition is the same take.
 */
const VERSIONS = new RegExp(
  String.raw`\b(?:${OTHER_TAKE_WORDS}|radio edit|radio mix|(?:480|576|720|1080|1440|2160)[pi]|[xh] ?26[45]|hevc|music video|mvid|dvdrip)\b`,
  'g'
);

/** The version words in a name. */
const versionsIn = (text: string): Set<string> =>
  new Set(text.match(VERSIONS) ?? []);

/** Whether `name` is some other version than `title`: it says one `title` doesn't. */
const otherVersion = (name: string, title: string): boolean => {
  const own = versionsIn(title);
  return [...versionsIn(name)].some((version) => !own.has(version));
};

/** How many times a phrase is in a name (spaced words), as whole words. */
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
 * Whether a release's name is this album of this artist: it names the
 * album, and the artist too. Only an album of Various Artists may go by
 * "VA" instead: another artist's song on a compilation is not their album.
 * A self-titled album is named twice ("Artist - Artist"), so not just any
 * album of theirs. It says no other version than the album does (a live
 * album, a remix, a karaoke copy). A Usenet post of one file names that
 * file in quotes ("Album \"03 - Song.mp3\""), which is not the album's name.
 */
export const namesAlbum = (
  title: string,
  album: string,
  artist: string
): boolean => {
  const name = title.replace(/(?:"|%22)[^"]*?(?:"|%22)/g, ' ');
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
  // A name of signs or one letter ("÷", "+", "x"): its own characters,
  // apart from any word, by the artist.
  if (a.length < 2) {
    const sign = normalizeTitle(album).trim();
    if (!sign || !by) return false;
    const raw = ` ${normalizeTitle(name).replace(/[\s\-–_.()[\]]+/g, ' ')} `;
    return raw.includes(` ${sign} `) && timesIn(t, by) > 0;
  }
  if (!timesIn(t, a)) return false;
  // The artist's own name may say one (a band called Live).
  if (otherVersion(t, ` ${a} ${by} `)) return false;
  if (by === 'various artists') {
    return /\b(va|various artists)\b/.test(t);
  }
  return a === by ? timesIn(t, a) >= 2 : timesIn(t, by) > 0;
};

/** What a pack of everything an artist put out is called, after their name. */
const CATALOG =
  /\b(discography|discografia|diskografie|collection|anthology|singles|complete (albums|works|discography|collection)|\d+ (albums?|releases|singles|eps))\b/;

/**
 * Whether a release's name is a pack of the artist's own releases: their
 * discography or a collection, named for them first ("Artist - Discography
 * 2011-2021", "(Country) Artist - Collection: 25 Releases"), not another
 * artist's that features them, nor Various Artists'.
 */
export const namesCatalog = (title: string, artist: string): boolean => {
  // Tags in front of the name: "(Country)", "[TR24][OF]".
  const name = title
    .replace(/(?:"|%22)[^"]*?(?:"|%22)/g, ' ')
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
 * Whether a release's name says it is another version than `own` names (a
 * live album, a remix album, a karaoke copy), its quoted file names aside.
 */
export const namesOtherVersion = (title: string, ...own: string[]): boolean =>
  otherVersion(
    ` ${words(title.replace(/(?:"|%22)[^"]*?(?:"|%22)/g, ' '))} `,
    ` ${own.map(words).join(' ')} `
  );

/** Whether a release's name names the artist, as whole words. */
export const namesArtist = (title: string, artist: string): boolean =>
  FORMS.some((form) => {
    const by = form(artist);
    return !!by && timesIn(` ${form(title)} `, by) > 0;
  });

/** The folders a file is in, as one name. */
const foldersOf = (path: string): string =>
  path.replace(/\\/g, '/').split('/').slice(0, -1).join(' ');

/**
 * The song's file in a pack of the artist's releases: from the album's own
 * folder when the pack has one, else from wherever it is named so. Never
 * from a folder of another version than the album (a live album's "03 -
 * Song.mp3" is named just as the song).
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

/** A file's name without its folder or extension. */
const nameOf = (path: string): string =>
  (path.replace(/\\/g, '/').split('/').pop() ?? path).replace(AUDIO, '');

/**
 * The title of a file named in parts with its track number among them
 * ("Artist - Album - 03 - Song" is "song"), or '' for a name not so made.
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
 * A file's name as the song it may be, without its folder, extension,
 * track number or artist: "03 - Artist - Song (Live).flac" is "song live".
 * With the number kept too, for a song whose title starts with one ("99
 * Problems"). A name in parts with the track number among them ("Artist -
 * Album - 03 - Song") is the part after the number, first.
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
  // A disc and track number in front: "1 03", "103", "03", "a1".
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
 * The file in a release that is this song: the one named just as the
 * track, else the one whose name holds it, the shortest of those (not
 * "Song (Remix)" for "Song"), never one naming another version ("Song
 * (Live)", "Song - Take 37"). A name with its title in a part of its own
 * ("Album - 03 - Song") holds only that title, not the album's name before
 * it. Samples, tiny files and whole-album images (a .cue beside them) are
 * passed over.
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
  // Each way of reading the names: the song, and what each file can be.
  const readings = FORMS.map((form) => {
    const by = form(artist);
    return {
      want: form(track),
      named: audio.map((file) => {
        const titled = titleOfFile(file.path, form);
        return {
          file,
          songs: songsOfFile(file.path, artist, form),
          // What a name with its own title part can hold: that title only.
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
