/*
 * Reads a release name to answer one question: is this download the series
 * or movie Sonarr or Radarr filed it under?
 *
 * Sonarr and Radarr decide that themselves when the name matches a title.
 * When it doesn't but the indexer gave an id (TVDB, TMDB or IMDb), they grab
 * it and then refuse to import it ("matched to series by ID"). Most are the
 * right title under another name: Snack.Kingdom.2013,
 * Bramble.&amp;.Finch-Trick.Us. Some aren't: The.Turnstile.AU is Australia's
 * version of The Turnstile; Gurneys.2026 is the revival, filed under the 2001
 * series' episodes. The name tells which.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
};

/** Unescapes HTML entities ("&amp;" → "&"); indexers send names escaped. */
export const unescapeName = (value: string): string =>
  value.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X'
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000
        ? String.fromCodePoint(n)
        : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });

/**
 * A name as words: lower case, no accents or punctuation, "&" as "and".
 * "Bramble & Finch: Trick Us" and "Bramble.&amp;.Finch-Trick.Us" both read
 * "bramble and finch trick us".
 */
export const normalize = (value: string): string =>
  wordsOf(value).join(' ').toLowerCase();

/**
 * A name's words with case kept, to tell "The.Turnstile.AU" (a country)
 * from "Trick.Us" (a word).
 */
const wordsOf = (value: string): string[] =>
  unescapeName(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/&/g, ' and ')
    .replace(/['’‘`´]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Country codes releases use to mark their own version of a show. */
const COUNTRIES = new Set([
  'us',
  'uk',
  'au',
  'nz',
  'ca',
  'ie',
  'za',
  'in',
  'de',
  'fr',
  'es',
  'it',
  'nl',
  'be',
  'se',
  'dk',
  'no',
  'fi',
  'br',
  'mx',
  'ar',
  'jp',
  'kr',
  'ph',
]);

/** Tokens that start a release's quality, source and group after its title. */
const TECHNICAL =
  /^(\d{3,4}[pi]|4k|uhd|hdr\d*|sdr|dv|web|webdl|web-dl|webrip|web-rip|hdtv|pdtv|sdtv|dsr|bluray|blu-ray|bdrip|brrip|bdremux|remux|dvd|dvdrip|dvd-rip|hdrip|x26[45]|h26[45]|h\.26[45]|hevc|avc|xvid|divx|aac\d*(\.\d)?|ac3|eac3|dd\+?\d*(\.\d)?|ddp\d*(\.\d)?|dts(-hd)?|truehd|atmos|flac|opus|amzn|nf|netflix|dsnp|hmax|atvp|pmtp|hulu|pcok|cr|crunchyroll|itunes|dscp|shahid|repack\d*|proper|internal|multi|dual|complete|extended|uncut|remastered|imax|hybrid|10bit|8bit|english|subbed|dubbed|\d+ch|\d\.\d)$/i;

export interface ReleaseName {
  /** The title before season, year and country, as words. */
  title: string;
  year?: number;
  /** Country marking the version ("au" in The.Turnstile.AU). */
  country?: string;
  /** The episode's own title as words, if the name has one. */
  episodeTitle?: string;
  /** Whether any season or episode marker was found. */
  hasEpisode: boolean;
}

/** Leading bracketed group or hash tags: "[Concur] ". */
const LEADING_TAGS = /^(\s*\[[^\]]*\]\s*)+/;

/** S01E02, S01, 1x02, Season 3; the first match splits title from the rest. */
const EPISODE_MARK =
  /(^|[\s._-])(s\d{1,4}([\s._-]?e\d{1,4})*([\s._-]?-?e\d{1,4})*|\d{1,2}x\d{2,3}|season[\s._]?\d{1,3})(?=$|[\s._-])/i;

/** A movie's year, which ends its title: "Scorch.1995.1080p", "Scorch (1995)". */
const MOVIE_YEAR = /(^|[\s._([-])((?:19|20)\d{2})(?=$|[\s._)\]-])/g;

/**
 * Strips a trailing year and country (either order). A country is two
 * capitals, as releases and Sonarr titles write it: "The.Turnstile.AU",
 * "The Schemers (US)"; "Trick.Us" ends in a word.
 */
const splitTail = (
  raw: string[]
): { words: string[]; year?: number; country?: string } => {
  let year: number | undefined;
  let country: string | undefined;
  const rest = [...raw];
  for (let i = 0; i < 2 && rest.length > 1; i++) {
    const last = rest[rest.length - 1];
    if (year === undefined && /^(19|20)\d{2}$/.test(last)) {
      year = Number(last);
      rest.pop();
    } else if (
      country === undefined &&
      /^[A-Z]{2}$/.test(last) &&
      COUNTRIES.has(last.toLowerCase())
    ) {
      country = last.toLowerCase();
      rest.pop();
    }
  }
  return { words: rest.map((w) => w.toLowerCase()), year, country };
};

/** Words after the episode marker, up to the quality or group. */
export const episodeTitleOf = (rest: string): string | undefined => {
  const words: string[] = [];
  for (const raw of rest.split(/[\s._]+/)) {
    if (!raw || raw === '-') continue;
    if (/^[([{]/.test(raw) || TECHNICAL.test(raw)) break;
    words.push(raw);
  }
  const title = normalize(words.join(' '));
  return title || undefined;
};

/** Parses a TV release name. */
export const readEpisodeRelease = (name: string): ReleaseName => {
  const clean = unescapeName(name).replace(LEADING_TAGS, '');
  const mark = EPISODE_MARK.exec(clean);
  if (!mark) {
    const { words, year, country } = splitTail(wordsOf(clean));
    return { title: words.join(' '), year, country, hasEpisode: false };
  }
  const head = clean.slice(0, mark.index + mark[1].length);
  const rest = clean.slice(mark.index + mark[0].length);
  const { words, year, country } = splitTail(wordsOf(head));
  return {
    title: words.join(' '),
    year,
    country,
    episodeTitle: episodeTitleOf(rest),
    hasEpisode: true,
  };
};

/** Parses a movie release name: the title is everything before its year. */
export const readMovieRelease = (name: string): ReleaseName => {
  const clean = unescapeName(name).replace(LEADING_TAGS, '');
  let found: RegExpExecArray | null = null;
  // Use the last year-like number with a title before it:
  // "2087.A.Tidal.Voyage.1968" has the title "2087 A Tidal Voyage".
  for (const match of clean.matchAll(MOVIE_YEAR)) {
    if (match.index > 0) found = match as RegExpExecArray;
  }
  if (!found) {
    const words = wordsOf(clean);
    const end = words.findIndex((w) => TECHNICAL.test(w));
    const { words: title, country } = splitTail(
      end > 0 ? words.slice(0, end) : words
    );
    return { title: title.join(' '), country, hasEpisode: false };
  }
  const head = clean.slice(0, found.index + found[1].length);
  const { words, country } = splitTail(wordsOf(head));
  return {
    title: words.join(' '),
    year: Number(found[2]),
    country,
    hasEpisode: false,
  };
};

/** One of a title's names, without a trailing year or country. */
interface TitleName {
  words: string;
  country?: string;
}

/** Splits "The Turnstile (2016)", "The Schemers (US)", "The Turnstile US" into parts. */
const nameOf = (title: string): TitleName => {
  const { words, country } = splitTail(wordsOf(title));
  return { words: words.join(' '), country };
};

const withoutThe = (words: string) => words.replace(/^(the|a|an) /, '');

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for']);

const meaningful = (words: string): string[] =>
  words.split(' ').filter((w) => w && !STOP.has(w));

/** Sonarr's placeholder titles for unnamed episodes (test normalized). */
export const GENERIC_EPISODE =
  /^((episode|chapter|part|ep|folge|episodio|episode n|capitulo|capitolo)\s*\d+|tba|tbd|pilot|special|untitled)$/;

/**
 * How alike two episode titles are: 1 if one contains the other, else the
 * share of words in common.
 */
export const episodeTitleLikeness = (a: string, b: string): number => {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  // "Taco Kingdom 2" is not "Taco Kingdom 3", nor "Taco Kingdom".
  const numbers = (s: string) =>
    s
      .split(' ')
      .filter((w) => /^\d+$/.test(w))
      .sort()
      .join(' ');
  if (numbers(x) !== numbers(y)) return 0;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (
    (short.length >= 6 || short.includes(' ')) &&
    ` ${long} `.includes(` ${short} `)
  ) {
    return 1;
  }
  const xs = new Set(meaningful(x));
  const ys = new Set(meaningful(y));
  if (!xs.size || !ys.size) return 0;
  const shared = [...xs].filter((w) => ys.has(w)).length;
  return shared / new Set([...xs, ...ys]).size;
};

export interface TitleFacts {
  title: string;
  year?: number;
  originalTitle?: string;
  alternateTitles?: { title: string }[];
}

export type Verdict =
  /** The name is this title; safe to import under it. */
  | 'same'
  /**
   * The right show, numbered differently: its episode title matches another
   * episode (`episode`). Snack.Kingdom.2013.S09E11.Pretzel.Champions is
   * Sonarr's S14E03, "Pretzel Champions".
   */
  | 'renumbered'
  /** The name is another title or another version of it. */
  | 'different'
  /** Can't tell from the name. */
  | 'unsure';

export type VerdictReason =
  | 'title'
  | 'episodeTitle'
  | 'country'
  | 'year'
  | 'extraWords'
  | 'otherName'
  | 'noName';

export interface Evidence {
  verdict: Verdict;
  reason: VerdictReason;
  /** What the release names, for display: title, year, country. */
  named: { title: string; year?: number; country?: string };
  /** The release's episode title, when it decided the verdict. */
  episodeTitle?: string;
  /** Sonarr's episode title, when the episode title decided. */
  expected?: string;
  /** Renumbered: the episode the release actually is. */
  episode?: SeriesEpisode;
}

/** A series episode as Sonarr lists it. */
export interface SeriesEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  hasFile: boolean;
}

/**
 * Whether a release a server matched only by indexer id is the title it was
 * filed under. `episodes` are those it was filed as, with Sonarr's titles;
 * none for a movie. `allEpisodes` (the whole series) lets a renumbered
 * single episode be found by its title.
 */
export const judgeName = (
  release: ReleaseName,
  title: TitleFacts,
  episodes: { id?: number; title?: string }[] = [],
  allEpisodes: SeriesEpisode[] = []
): Evidence => {
  const named = {
    title: release.title,
    year: release.year,
    country: release.country,
  };
  if (!release.title) return { verdict: 'unsure', reason: 'noName', named };

  const names = [
    title.title,
    title.originalTitle,
    ...(title.alternateTitles ?? []).map((a) => a.title),
  ]
    .filter((n): n is string => !!n)
    .map(nameOf)
    .filter((n) => n.words);
  const bare = withoutThe(release.title);
  const sameWords = names.filter((n) => withoutThe(n.words) === bare);
  const countries = new Set(
    names.map((n) => n.country).filter((c): c is string => !!c)
  );

  // Another country's version: The.Turnstile.AU for The Turnstile (2016).
  if (release.country && !countries.has(release.country)) {
    return { verdict: 'different', reason: 'country', named };
  }

  // The episode's own title, when present, decides.
  const releaseEpisode = release.episodeTitle;
  const known = episodes
    .map((e) => e.title)
    .filter((t): t is string => !!t && !GENERIC_EPISODE.test(normalize(t)));
  if (
    releaseEpisode &&
    known.length &&
    !GENERIC_EPISODE.test(releaseEpisode) &&
    (meaningful(releaseEpisode).length >= 2 || releaseEpisode.length >= 6)
  ) {
    const best = known.reduce(
      (top, t) => {
        const score = episodeTitleLikeness(releaseEpisode, t);
        return score > top.score ? { score, title: t } : top;
      },
      { score: -1, title: known[0] }
    );
    const sharesWords = names.some((n) =>
      meaningful(n.words).some((w) => meaningful(bare).includes(w))
    );
    if (best.score >= 0.5 && (sameWords.length || sharesWords)) {
      return {
        verdict: 'same',
        reason: 'episodeTitle',
        named,
        episodeTitle: releaseEpisode,
        expected: best.title,
      };
    }
    if (best.score < 0.2) {
      // A renumbered single episode: the one with this title, if exactly
      // one has it.
      const filed = new Set(episodes.map((e) => e.id));
      const elsewhere =
        episodes.length === 1 && (sameWords.length || sharesWords)
          ? allEpisodes.filter(
              (e) =>
                !filed.has(e.id) &&
                !!e.title &&
                !GENERIC_EPISODE.test(normalize(e.title)) &&
                episodeTitleLikeness(releaseEpisode, e.title) === 1
            )
          : [];
      if (elsewhere.length === 1) {
        return {
          verdict: 'renumbered',
          reason: 'episodeTitle',
          named,
          episodeTitle: releaseEpisode,
          expected: best.title,
          episode: elsewhere[0],
        };
      }
      return {
        verdict: 'different',
        reason: 'episodeTitle',
        named,
        episodeTitle: releaseEpisode,
        expected: best.title,
      };
    }
  }

  if (sameWords.length) {
    if (
      release.year !== undefined &&
      title.year &&
      Math.abs(release.year - title.year) > 1
    ) {
      return { verdict: 'different', reason: 'year', named };
    }
    return { verdict: 'same', reason: 'title', named };
  }

  // The title followed by more words: a spin-off, subtitle or longer name
  // of the same show. Only a person can tell.
  if (names.some((n) => bare.startsWith(`${withoutThe(n.words)} `))) {
    return { verdict: 'unsure', reason: 'extraWords', named };
  }
  return { verdict: 'unsure', reason: 'otherName', named };
};
