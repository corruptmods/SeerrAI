/*
 * Lists an NZB's files: names from each <file>'s subject line (posters quote
 * them), sizes from its segments. RAR posts name only the archives, and
 * scrambled posts name only their PAR2 files, so neither can be matched per
 * file.
 */

export interface NzbFile {
  index: number;
  name: string;
  size: number;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** The character for a code point; undefined if out of range. */
const character = (code: number): string | undefined =>
  Number.isInteger(code) && code >= 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : undefined;

const decode = (value: string): string =>
  value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return character(parseInt(entity.slice(2), 16)) ?? whole;
    }
    if (entity.startsWith('#')) {
      return character(parseInt(entity.slice(1), 10)) ?? whole;
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });

export const nameFromSubject = (subject: string): string | undefined => {
  const quoted = subject.match(/"([^"]+\.[a-z0-9]{2,4})"/i);
  if (quoted) return quoted[1].trim();
  const bare = subject.match(/([^\s"/\\]+\.[a-z0-9]{2,4})(?=\s|$)/i);
  return bare?.[1];
};

/** More than any real post has; later files are ignored. */
const MAX_FILES = 5000;

export interface NzbContents {
  /** Files whose subject gives a name. */
  files: NzbFile[];
  /** Total size of files whose subject gives none (scrambled). */
  unnamedBytes: number;
}

/**
 * Each <file> element, up to MAX_FILES, with its name and size. Uses
 * indexOf, not one regex over the document, which an unclosed tag makes
 * quadratic.
 */
function* fileElements(xml: string) {
  const lower = xml.toLowerCase();
  let at = 0;
  for (let seen = 0; seen < MAX_FILES; seen++) {
    const start = lower.indexOf('<file', at);
    if (start === -1) return;
    const tagEnd = lower.indexOf('>', start);
    const end = lower.indexOf('</file>', start);
    if (tagEnd === -1 || end === -1) return;
    at = end + 7;
    const subject = xml
      .slice(start, tagEnd)
      .match(/subject\s*=\s*"([^"]*)"/i)?.[1];
    let size = 0;
    for (const segment of xml
      .slice(tagEnd, end)
      .matchAll(/bytes\s*=\s*"(\d+)"/gi)) {
      size += Number(segment[1]);
    }
    const name = subject ? nameFromSubject(decode(subject)) : undefined;
    yield { start, end: at, name, size };
  }
}

export const readNzb = (data: Buffer | string): NzbContents => {
  const xml = typeof data === 'string' ? data : data.toString('utf8');
  const files: NzbFile[] = [];
  let unnamedBytes = 0;
  for (const { name, size } of fileElements(xml)) {
    if (name) files.push({ index: files.length, name, size });
    else unnamedBytes += size;
  }
  return { files, unnamedBytes };
};

/**
 * The NZB with only the kept named files (numbered as `readNzb` does), so
 * the client downloads just those. Keeps the head. Undefined if none are
 * kept.
 */
export const nzbWith = (
  data: Buffer | string,
  keep: (file: NzbFile) => boolean
): string | undefined => {
  const xml = typeof data === 'string' ? data : data.toString('utf8');
  const kept: string[] = [];
  let first = -1;
  let last = -1;
  let named = 0;
  for (const { start, end, name, size } of fileElements(xml)) {
    if (first === -1) first = start;
    last = end;
    if (!name) continue;
    if (keep({ index: named, name, size })) kept.push(xml.slice(start, end));
    named++;
  }
  if (!kept.length || first === -1) return undefined;
  return `${xml.slice(0, first)}${kept.join('\n')}${xml.slice(last)}`;
};

export const parseNzb = (data: Buffer | string): NzbFile[] =>
  readNzb(data).files;

const VIDEO = /\.(mkv|mp4|avi|m4v|ts|wmv)$/i;
/** Audio files, which a music post names as a video post names its videos. */
const AUDIO = /\.(flac|mp3|m4a|aac|ogg|oga|opus|wav|aiff?|alac|ape|wv|wma)$/i;
const ARCHIVE = /\.(rar|r\d{2}|7z|zip|\d{3})$/i;
/** Files a post carries beside its media: repair data, notes, subtitles. */
const SIDECAR = /\.(par2|nfo|sfv|srr|nzb|txt|jpe?g|png|srt|sub|idx|ass|ssa)$/i;

/**
 * Why an NZB's videos (or songs) can't be listed before download: they are
 * in archives, or scrambled (most of the post is unnamed or not media or
 * archive names, and only PAR2 files are named; the Usenet client restores
 * real names from those). Undefined when it names its videos.
 */
export const packingOf = ({
  files,
  unnamedBytes,
}: NzbContents): 'archives' | 'scrambled' | undefined => {
  if (files.some((file) => VIDEO.test(file.name) || AUDIO.test(file.name))) {
    return undefined;
  }
  if (files.some((file) => ARCHIVE.test(file.name))) return 'archives';
  const total = files.reduce((sum, f) => sum + f.size, unnamedBytes);
  const unknown = files
    .filter((file) => !SIDECAR.test(file.name))
    .reduce((sum, f) => sum + f.size, unnamedBytes);
  return total > 0 && unknown * 2 >= total ? 'scrambled' : undefined;
};
