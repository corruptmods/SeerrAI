/*
 * The files in an NZB, read from each <file>'s subject line, where posters
 * put the file name in quotes, and sized from its segments. Posts packed as
 * RAR archives name the archives, not the episodes inside them, and posts
 * with scrambled names name nothing but their PAR2 repair files, so neither
 * can be matched file by file.
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

const decode = (value: string): string =>
  value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) {
      return String.fromCodePoint(parseInt(entity.slice(1), 10));
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });

export const nameFromSubject = (subject: string): string | undefined => {
  const quoted = subject.match(/"([^"]+\.[a-z0-9]{2,4})"/i);
  if (quoted) return quoted[1].trim();
  const bare = subject.match(/([^\s"/\\]+\.[a-z0-9]{2,4})(?=\s|$)/i);
  return bare?.[1];
};

/** More files than any real post has: the rest of the NZB is ignored. */
const MAX_FILES = 5000;

export interface NzbContents {
  /** The files whose subjects give a name. */
  files: NzbFile[];
  /** The size of those whose subjects give none: scrambled names. */
  unnamedBytes: number;
}

/**
 * Walks the <file> elements with indexOf, not one regular expression over
 * the whole document, which a file with no closing tag makes quadratic.
 */
export const readNzb = (data: Buffer | string): NzbContents => {
  const xml = typeof data === 'string' ? data : data.toString('utf8');
  const lower = xml.toLowerCase();
  const files: NzbFile[] = [];
  let unnamedBytes = 0;
  let seen = 0;
  let at = 0;
  while (seen < MAX_FILES) {
    const start = lower.indexOf('<file', at);
    if (start === -1) break;
    const tagEnd = lower.indexOf('>', start);
    const end = lower.indexOf('</file>', start);
    if (tagEnd === -1 || end === -1) break;
    at = end + 7;
    const subject = xml
      .slice(start, tagEnd)
      .match(/subject\s*=\s*"([^"]*)"/i)?.[1];
    seen++;
    let size = 0;
    for (const segment of xml
      .slice(tagEnd, end)
      .matchAll(/bytes\s*=\s*"(\d+)"/gi)) {
      size += Number(segment[1]);
    }
    const name = subject ? nameFromSubject(decode(subject)) : undefined;
    if (name) files.push({ index: files.length, name, size });
    else unnamedBytes += size;
  }
  return { files, unnamedBytes };
};

export const parseNzb = (data: Buffer | string): NzbFile[] =>
  readNzb(data).files;

const VIDEO = /\.(mkv|mp4|avi|m4v|ts|wmv)$/i;
const ARCHIVE = /\.(rar|r\d{2}|7z|zip|\d{3})$/i;
/** What a post carries beside its videos: repair data, notes, subtitles. */
const SIDECAR = /\.(par2|nfo|sfv|srr|nzb|txt|jpe?g|png|srt|sub|idx|ass|ssa)$/i;

/**
 * Why an NZB's videos can't be listed before it is downloaded, if they
 * can't: they are inside archives, or their names are scrambled (most of
 * the post is files with no name, or none a video or archive would have,
 * and only its PAR2 repair files are named; SABnzbd puts the real names
 * back from those). Undefined when it names its videos.
 */
export const packingOf = ({
  files,
  unnamedBytes,
}: NzbContents): 'archives' | 'scrambled' | undefined => {
  if (files.some((file) => VIDEO.test(file.name))) return undefined;
  if (files.some((file) => ARCHIVE.test(file.name))) return 'archives';
  const total = files.reduce((sum, f) => sum + f.size, unnamedBytes);
  const unknown = files
    .filter((file) => !SIDECAR.test(file.name))
    .reduce((sum, f) => sum + f.size, unnamedBytes);
  return total > 0 && unknown * 2 >= total ? 'scrambled' : undefined;
};
