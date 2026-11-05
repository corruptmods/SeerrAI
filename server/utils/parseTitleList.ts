/**
 * Turns pasted text (typically a notes app list) into searchable title lines.
 *
 * Strips bullets, numbering, dashes and trailing notes after a hyphen, and
 * extracts a year when present, since that makes matching far more reliable.
 */

export interface ParsedLine {
  /** The original line, shown so the user can see what was matched. */
  raw: string;
  /** The cleaned title used for searching. */
  title: string;
  /** A four-digit year found in the line, if any. */
  year?: number;
  /**
   * The line seemed to name a whole set ("Harmony Lane series", "the Kessler
   * trilogy"). Only a hint: "Grey Static series" means a TV show, so both
   * readings are offered.
   */
  collectionHint?: boolean;
}

/** Notes-app bullets, numbering and checkbox marks at a line's start. */
const LEADING_DECORATION = /^\s*(?:[-*•‣▪◦–—]|\[[ xX]\]|\d+[.)])\s*/;

/** A year in brackets or parentheses, e.g. "(1999)" or "[1999]". */
const BRACKETED_YEAR = /[([]\s*(19\d{2}|20\d{2}|21\d{2})\s*[)\]]/;

/** Words for a whole set of films. */
const COLLECTION_HINT =
  /\s+(?:the\s+)?(series|collection|trilogy|quadrilogy|saga|movies|films|franchise)\s*$/i;

/** "all Milo Thistle movies": the leading word isn't part of the title. */
const LEADING_ALL = /^all\s+(?:the\s+)?/i;

/** A bare year at the end of a line, e.g. "Scorch 1995". */
const TRAILING_YEAR = /\s+(19\d{2}|20\d{2}|21\d{2})\s*$/;

export const parseTitleList = (text: string): ParsedLine[] => {
  const seen = new Set<string>();
  const parsed: ParsedLine[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const raw = rawLine.trim();

    if (!raw) {
      continue;
    }

    let working = raw.replace(LEADING_DECORATION, '').trim();
    let year: number | undefined;

    const bracketed = working.match(BRACKETED_YEAR);

    if (bracketed) {
      year = Number(bracketed[1]);
      working = working.replace(BRACKETED_YEAR, ' ').trim();
    } else {
      const trailing = working.match(TRAILING_YEAR);

      if (trailing) {
        year = Number(trailing[1]);
        working = working.replace(TRAILING_YEAR, '').trim();
      }
    }

    // Anything after " - " is usually a personal note, not the title.
    working = working.split(/\s+[-–—]\s+/)[0].trim();

    // Trailing punctuation left by the trimming above.
    working = working.replace(/[,;:]+$/, '').trim();

    // Strip a trailing "series" / "trilogy" so the search matches the title,
    // but remember it.
    const collectionHint = COLLECTION_HINT.test(working);

    if (collectionHint) {
      working = working.replace(COLLECTION_HINT, '').trim();
      working = working.replace(LEADING_ALL, '').trim();
    }

    if (!working) {
      continue;
    }

    // A heading like "Movies:" is a section label, not a title.
    if (/^[A-Za-z ]+:$/.test(raw)) {
      continue;
    }

    const key = `${working.toLowerCase()}|${year ?? ''}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    parsed.push({
      raw,
      title: working,
      ...(year ? { year } : {}),
      ...(collectionHint ? { collectionHint } : {}),
    });
  }

  return parsed;
};

export default parseTitleList;
