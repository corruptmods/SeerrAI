/*
 * Custom CSS (Settings → Appearance and Profile → Settings → Appearance).
 *
 * An admin's Server CSS applies to everyone, the sign-in page included. It
 * is trusted like the rest of the admin's settings and may bring in a
 * stylesheet from elsewhere with @import (a theme.park theme, say); the
 * page's Content-Security-Policy allows the places it names, and only
 * those (server/lib/customCss.ts).
 *
 * A person's own CSS, when an admin allows it, changes only their own
 * screens, but it is often pasted from somewhere. So it may not bring in
 * other stylesheets, may not run anything, and may only use pictures and
 * fonts from this server's own paths (or written into the CSS as data:),
 * so a pasted style can't send anything elsewhere. It is checked as the
 * browser reads it, comments skipped and escapes such as `u\72l(` decoded.
 *
 * Shared by the server, which decides, and the Appearance page, which says
 * what is wrong while someone types.
 */

/** The largest personal stylesheet taken. */
export const PERSONAL_CSS_MAX_BYTES = 32 * 1024;

/** The largest Server CSS taken. */
export const SERVER_CSS_MAX_BYTES = 64 * 1024;

export type PersonalCssProblem =
  | { problem: 'notText' | 'tooLarge' | 'import' }
  /** detail: the address, or image-set() */
  | { problem: 'url'; detail: string }
  /** detail: what would run */
  | { problem: 'script'; detail: string };

export type ServerCssProblem = { problem: 'notText' | 'tooLarge' };

const byteLength = (text: string): number =>
  new TextEncoder().encode(text).length;

/** A placeholder for the n-th string, in text that can't otherwise hold one. */
const STRING_MARK = '\u0000';
const stringPlaceholder = (index: number) =>
  `${STRING_MARK}${index}${STRING_MARK}`;
const STRING_AT = new RegExp(`^${STRING_MARK}(\\d+)${STRING_MARK}`);

const isHex = (char: string | undefined) => !!char && /[0-9a-f]/i.test(char);
const isNewline = (char: string | undefined) =>
  char === '\n' || char === '\r' || char === '\f';
const isSpace = (char: string | undefined) =>
  char === ' ' || char === '\t' || isNewline(char);

/**
 * Reads the escape at css[at] (a backslash): the character it stands for,
 * and where reading carries on.
 */
const readEscape = (css: string, at: number): [string, number] => {
  let i = at + 1;
  if (i >= css.length) {
    return ['\ufffd', i];
  }
  if (!isHex(css[i])) {
    // Any other character stands for itself.
    const char = String.fromCodePoint(css.codePointAt(i) ?? 0xfffd);
    return [char, i + char.length];
  }
  let hex = '';
  while (hex.length < 6 && isHex(css[i])) {
    hex += css[i++];
  }
  // One space after a hex escape belongs to it.
  if (css[i] === '\r' && css[i + 1] === '\n') {
    i += 2;
  } else if (isSpace(css[i])) {
    i += 1;
  }
  const code = parseInt(hex, 16);
  const valid =
    code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
  return [valid ? String.fromCodePoint(code) : '\ufffd', i];
};

/** Characters CSS lets a name hold, besides escaped ones. */
const isNameChar = (char: string) => /[a-zA-Z0-9_\-\u0080-￿]/.test(char);

/** Characters an unquoted url() may not hold. */
const isNonPrintable = (char: string) => {
  const code = char.charCodeAt(0);
  return (
    code <= 0x08 ||
    code === 0x0b ||
    (code >= 0x0e && code <= 0x1f) ||
    code === 0x7f
  );
};

/**
 * Reads the unquoted address of a url( whose bracket is at css[open], as
 * the browser does: up to the closing bracket, where comments and quotes
 * are part of the address rather than starting anything. An address the
 * browser would refuse (a quote, a bracket or a space inside it) is given
 * as written, so it is refused here too. Gives the address and where
 * reading carries on, or nothing when the address is a string.
 */
const readUrl = (css: string, open: number): [string, number] | undefined => {
  let i = open + 1;
  while (isSpace(css[i])) {
    i += 1;
  }
  if (css[i] === '"' || css[i] === "'") {
    return undefined;
  }
  const start = i;
  let address = '';
  let bad = false;
  while (i < css.length && css[i] !== ')') {
    const char = css[i];
    if (isSpace(char)) {
      while (isSpace(css[i])) {
        i += 1;
      }
      bad = i < css.length && css[i] !== ')';
      break;
    }
    if (
      char === '"' ||
      char === "'" ||
      char === '(' ||
      isNonPrintable(char) ||
      (char === '\\' && isNewline(css[i + 1]))
    ) {
      bad = true;
      break;
    }
    if (char === '\\') {
      const [decoded, next] = readEscape(css, i);
      address += decoded;
      i = next;
    } else {
      address += char;
      i += 1;
    }
  }
  if (bad) {
    // The rest of a broken address, up to its closing bracket.
    while (i < css.length && css[i] !== ')') {
      i =
        css[i] === '\\' && !isNewline(css[i + 1])
          ? readEscape(css, i)[1]
          : i + 1;
    }
    address = css.slice(start, i).trim();
  }
  return [address, i < css.length ? i + 1 : i];
};

interface ReadCss {
  /**
   * The CSS as the browser reads it: comments gone, escapes decoded, and
   * each string, and each unquoted url() address, replaced by a
   * placeholder.
   */
  text: string;
  /** The same with A–Z in lower case, character for character. */
  lower: string;
  /** The strings' contents, escapes decoded, by placeholder number. */
  strings: string[];
}

const readCss = (css: string): ReadCss => {
  // As the browser does, so no NUL in the CSS can pass for STRING_MARK.
  const source = css.replaceAll(STRING_MARK, '\ufffd');
  const strings: string[] = [];
  let text = '';
  // The name being read (escapes decoded), and the character before it:
  // url( starts an unquoted address only after the name url on its own,
  // not part of a #hash or @rule.
  let name = '';
  let beforeName = '';
  const endName = (char: string) => {
    name = '';
    beforeName = char;
  };
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const url =
      char === '(' &&
      name.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) === 'url' &&
      beforeName !== '#' &&
      beforeName !== '@'
        ? readUrl(source, i)
        : undefined;
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      text += ' ';
      endName(' ');
    } else if (url) {
      // An unquoted address, kept like a string.
      text += `(${stringPlaceholder(strings.length)})`;
      strings.push(url[0]);
      i = url[1];
      endName(')');
    } else if (char === '"' || char === "'") {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== char) {
        if (isNewline(source[i])) {
          // An unfinished string ends at the line, as the browser has it.
          break;
        }
        if (source[i] === '\\') {
          if (isNewline(source[i + 1])) {
            i += source[i + 1] === '\r' && source[i + 2] === '\n' ? 3 : 2;
            continue;
          }
          const [decoded, next] = readEscape(source, i);
          value += decoded;
          i = next;
        } else {
          value += source[i++];
        }
      }
      if (source[i] === char) {
        i += 1;
      }
      text += stringPlaceholder(strings.length);
      strings.push(value);
      endName(STRING_MARK);
    } else if (char === '\\' && !isNewline(source[i + 1])) {
      // An escaped character is part of a name, whatever it is.
      const [decoded, next] = readEscape(source, i);
      text += decoded;
      name += decoded;
      i = next;
    } else {
      text += char;
      i += 1;
      if (isNameChar(char)) {
        name += char;
      } else {
        endName(char);
      }
    }
  }
  // Only A–Z, so every position in one is the same position in the other.
  const lower = text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return { text, lower, strings };
};

/**
 * The address given to a function whose argument starts at `at`: a string,
 * or the unquoted text up to the closing bracket.
 */
const addressAt = (read: ReadCss, at: number): string => {
  let i = at;
  while (isSpace(read.text[i])) {
    i += 1;
  }
  const quoted = STRING_AT.exec(read.text.slice(i));
  if (quoted) {
    return read.strings[Number(quoted[1])];
  }
  const end = read.text.indexOf(')', i);
  return read.text.slice(i, end < 0 ? undefined : end).trim();
};

/**
 * url(), src(), and @import with its address. Not after # or @, which
 * make #url( and @url( a name rather than a function.
 */
const ADDRESS_USES = /@import|(?<![a-z0-9_\-\u0080-￿#@])(url|src)\(/g;

/** Every address the CSS uses, in order: imported stylesheets apart. */
const addressesIn = (
  read: ReadCss
): { address: string; imported: boolean }[] => {
  const found: { address: string; imported: boolean }[] = [];
  // The url() of an @import url(…), counted as the import's.
  let importedUrlAt = -1;
  for (const match of read.lower.matchAll(ADDRESS_USES)) {
    if (match[0] !== '@import') {
      if (match.index !== importedUrlAt) {
        found.push({
          address: addressAt(read, match.index + match[0].length),
          imported: false,
        });
      }
      continue;
    }
    let at = match.index + match[0].length;
    while (isSpace(read.text[at])) {
      at += 1;
    }
    if (read.lower.startsWith('url(', at)) {
      importedUrlAt = at;
      found.push({ address: addressAt(read, at + 4), imported: true });
    } else if (STRING_AT.test(read.text.slice(at))) {
      found.push({ address: addressAt(read, at), imported: true });
    }
  }
  return found;
};

/**
 * The addresses a stylesheet uses: the stylesheets it imports, and the
 * pictures and fonts it uses (others). Comments and strings that merely
 * look like addresses are not counted.
 */
export const cssAddresses = (
  css: string
): { imports: string[]; others: string[] } => {
  const found = addressesIn(readCss(css));
  return {
    imports: found.filter((use) => use.imported).map((use) => use.address),
    others: found.filter((use) => !use.imported).map((use) => use.address),
  };
};

/**
 * Addresses a person's CSS may use: a path on this server (not `//host`,
 * which is another server), a part of the page itself (`#id`, as filters
 * and masks use), or a picture or font written into the CSS (`data:`),
 * which goes nowhere.
 */
const ownAddress = (address: string): boolean =>
  /^\/(?![/\\])[^\s\\"'()<>]*$/.test(address) ||
  /^#[^\s\\"'()<>]*$/.test(address) ||
  /^data:(image|font)\//i.test(address);

/** Written only to run something, in CSS outside strings. */
const RUNS: [RegExp, string][] = [
  [/(?<![a-z0-9_\-\u0080-￿])expression\s*\(/, 'expression()'],
  [/(?:^|[{;\s])(?:-ms-)?behavior\s*:/, 'behavior'],
  [/-moz-binding/, '-moz-binding'],
];

/** Addresses that run something, anywhere, strings included. */
const SCRIPT_ADDRESSES = ['javascript:', 'vbscript:'];

/**
 * A person's CSS as it is kept (trimmed; '' for none), or what is wrong
 * with it.
 */
export const checkPersonalCss = (
  css: unknown
): { css: string } | PersonalCssProblem => {
  if (typeof css !== 'string') {
    return { problem: 'notText' };
  }
  if (byteLength(css) > PERSONAL_CSS_MAX_BYTES) {
    return { problem: 'tooLarge' };
  }
  const read = readCss(css);
  if (read.lower.includes('@import')) {
    return { problem: 'import' };
  }
  for (const { address } of addressesIn(read)) {
    if (!ownAddress(address)) {
      return { problem: 'url', detail: address };
    }
  }
  // Its strings are addresses in their own right.
  if (read.lower.includes('image-set(')) {
    return { problem: 'url', detail: 'image-set()' };
  }
  for (const [pattern, detail] of RUNS) {
    if (pattern.test(read.lower)) {
      return { problem: 'script', detail };
    }
  }
  const everything = [read.lower, ...read.strings]
    .join(' ')
    .replace(/\s+/g, '')
    .toLowerCase();
  for (const detail of SCRIPT_ADDRESSES) {
    if (everything.includes(detail)) {
      return { problem: 'script', detail };
    }
  }
  return { css: css.trim() };
};

/** The server's CSS as it is kept (trimmed), or what is wrong with it. */
export const checkServerCss = (
  css: unknown
): { css: string } | ServerCssProblem => {
  if (typeof css !== 'string') {
    return { problem: 'notText' };
  }
  if (byteLength(css) > SERVER_CSS_MAX_BYTES) {
    return { problem: 'tooLarge' };
  }
  return { css: css.trim() };
};
