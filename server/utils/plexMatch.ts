// Title disambiguation for the Plex Match Check, shared by the server and the
// title page. No imports: the browser bundle uses it too.

export interface MatchIds {
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
}

export type MatchKind = 'movie' | 'series' | 'music';

/** One id, as displayed and searched. */
export interface ShownId {
  name: 'tmdb' | 'tvdb' | 'imdb';
  id: number | string;
}

/** Ids compared, in the order `sameTitle` on the server compares them. */
const ORDER: Record<'movie' | 'series', (keyof MatchIds)[]> = {
  series: ['tvdbId', 'tmdbId', 'imdbId'],
  movie: ['tmdbId', 'imdbId', 'tvdbId'],
};

const NAME: Record<keyof MatchIds, ShownId['name']> = {
  tmdbId: 'tmdb',
  tvdbId: 'tvdb',
  imdbId: 'imdb',
};

/** Each side's primary id: TVDB for series, TMDB for movies. */
export const mainId = (
  kind: MatchKind,
  ids: MatchIds
): { name: 'tmdb' | 'tvdb'; id: number } | undefined => {
  if (kind === 'music') return undefined;
  const id = kind === 'series' ? ids.tvdbId : ids.tmdbId;
  return id ? { name: kind === 'series' ? 'tvdb' : 'tmdb', id } : undefined;
};

/**
 * The ids that told the sides apart: the first id both have, in comparison
 * order, so a server with only an IMDb id shows that rather than nothing. Each
 * side's first id when they share none.
 */
export const comparedIds = (
  kind: MatchKind,
  expected: MatchIds,
  matched: MatchIds
): { want?: ShownId; got?: ShownId } => {
  if (kind === 'music') return {};
  const order = ORDER[kind];
  const shared = order.find((key) => expected[key] && matched[key]);
  const first = (ids: MatchIds) =>
    shared && ids[shared] ? shared : order.find((key) => ids[key]);
  const shown = (ids: MatchIds): ShownId | undefined => {
    const key = first(ids);
    const id = key ? ids[key] : undefined;
    return key && id ? { name: NAME[key], id } : undefined;
  };
  return { want: shown(expected), got: shown(matched) };
};

/** "TMDB 123", "IMDb tt123". */
export const idLabel = (id: ShownId): string =>
  `${id.name === 'imdb' ? 'IMDb' : id.name.toUpperCase()} ${id.id}`;

/**
 * What to search in Plex's Fix Match or enter in Identify: the primary id, plus
 * the IMDb id when that's what told the sides apart.
 */
export const fixSearch = (
  kind: MatchKind,
  expected: MatchIds
): { want?: ShownId; also?: ShownId } => {
  const main = mainId(kind, expected);
  const imdb =
    kind !== 'music' && expected.imdbId
      ? ({ name: 'imdb', id: expected.imdbId } as ShownId)
      : undefined;
  return {
    want: main ?? imdb,
    also: main ? imdb : undefined,
  };
};

/**
 * Same name ignoring case, and same year when both have one (a missing year is
 * unknown, not different). Telling such titles apart needs the ids.
 */
export const sameName = (
  a: { title: string; year?: number },
  b: { title: string; year?: number }
): boolean =>
  a.title.trim().toLowerCase() === b.title.trim().toLowerCase() &&
  (!a.year || !b.year || a.year === b.year);

/** Minutes from Radarr's running time ("1:47:21", "47:21"). */
export const runtimeMinutes = (text?: string | null): number | undefined => {
  const parts = (text ?? '').split(':').map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) {
    return undefined;
  }
  const [h, m, s] = parts.length === 3 ? parts : [0, ...parts];
  const minutes = Math.round(h * 60 + m + s / 60);
  return minutes > 0 ? minutes : undefined;
};

/**
 * The file's length is far off the film Radarr has for its folder: more likely
 * another film (a same-named short) than a server mistake. Every wrong Plex
 * match checked was within a few minutes.
 */
export const fileLooksWrong = (expected: {
  runtime?: number;
  fileRuntime?: number;
}): boolean =>
  !!expected.runtime &&
  !!expected.fileRuntime &&
  (expected.fileRuntime < expected.runtime / 2 ||
    Math.abs(expected.fileRuntime - expected.runtime) > 25);

/** Letters and digits only, ignoring accents and case. */
const plain = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The file isn't named after the title (e.g. a foreign release title): the
 * media server matches by file name, so it can mismatch again until the file is
 * renamed.
 */
export const fileMisnamed = (expected: {
  title: string;
  file?: string;
}): boolean => {
  if (!expected.file) return false;
  const name = plain(expected.file.split(/[\\/]/).pop() ?? '');
  const title = plain(expected.title);
  return !!name && !!title && !name.startsWith(title);
};
