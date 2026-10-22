/**
 * Turns a block of pasted text — typically a notes app list — into title
 * lines that can be searched.
 *
 * People's lists are messy: bullets, numbering, dashes, years in brackets,
 * trailing notes after a hyphen. This strips the decoration and pulls out a
 * year when one is present, since that makes matching far more reliable.
 */

export interface ParsedLine {
  /** The original line, shown to the user so they can see what was matched. */
  raw: string;
  /** The cleaned title used for searching. */
  title: string;
  /** A four-digit year found in the line, if any. */
  year?: number;
  /**
   * The line looked like it referred to a whole set — "Harmony Lane series",
   * "the Kessler trilogy". Only a hint: "Grey Static series" means a TV show,
   * so both readings are offered rather than one being assumed.
   */
  collectionHint?: boolean;
}

/** Bullets, numbering and checkbox marks that lead a line in a notes app. */
const LEADING_DECORATION = /^\s*(?:[-*•‣▪◦–—]|\[[ xX]\]|\d+[.)])\s*/;

/** A year in brackets or parentheses, e.g. "(1999)" or "[1999]". */
const BRACKETED_YEAR = /[([]\s*(19\d{2}|20\d{2}|21\d{2})\s*[)\]]/;

/** Words people use for a whole set of films. */
const COLLECTION_HINT =
  /\s+(?:the\s+)?(series|collection|trilogy|quadrilogy|saga|movies|films|franchise)\s*$/i;

/** "all Milo Thistle movies" — the leading word is not part of the title. */
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

    // Anything after " - " is usually a personal note rather than the title.
    working = working.split(/\s+[-–—]\s+/)[0].trim();

    // Trailing punctuation left behind by the trimming above.
    working = working.replace(/[,;:]+$/, '').trim();

    // Strip a trailing "series" / "trilogy" so the search matches the title
    // itself, but remember that it was there.
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
