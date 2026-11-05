// Custom CSS (Settings → Appearance and Profile → Settings → Appearance),
// shared by the server, which enforces it, and the Appearance page, which
// reports problems while typing.
//
// Server CSS (admin) applies to everyone, sign-in page included. It is trusted
// like other admin settings and may @import external stylesheets (e.g. a
// theme.park theme); the Content-Security-Policy allows exactly the hosts it
// names (server/lib/customCss.ts).
//
// Personal CSS (when allowed) affects only its owner but is often pasted from
// elsewhere. So it may not import stylesheets or run anything, and may only
// load images and fonts from this server's paths or data: URIs, so it can't
// send anything elsewhere. It's checked as the browser parses it: comments
// skipped, escapes such as `u\72l(` decoded.

/** Max personal stylesheet size. */
export const PERSONAL_CSS_MAX_BYTES = 32 * 1024;

/** Max Server CSS size. */
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

/**
 * Placeholder mark for the n-th string, in text that can't otherwise hold one.
 */
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
 * Reads the escape at css[at] (a backslash): the character it encodes and the
 * index after it.
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
  // One whitespace after a hex escape belongs to it.
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

/** Characters a CSS name may hold unescaped. */
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
 * Reads an unquoted url( address whose bracket is at css[open], as the browser
 * does: up to the closing bracket, with comments and quotes part of the
 * address. An address the browser would reject (a quote, bracket or space
 * inside) is returned as written, so it's rejected here too. Returns the
 * address and the index after it, or undefined when the argument is a string.
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
    // Skip the rest of a malformed address, up to its closing bracket.
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
   * The CSS as the browser reads it: comments removed, escapes decoded, and
   * each string and unquoted url() address replaced by a placeholder.
   */
  text: string;
  /** `text` with A–Z lowercased, position for position. */
  lower: string;
  /** The strings' decoded contents, by placeholder number. */
  strings: string[];
  /** Where each url() and src() argument starts in `text`. */
  calls: number[];
}

const readCss = (css: string): ReadCss => {
  // As the browser does, so no NUL in the CSS can pass for STRING_MARK.
  const source = css.replaceAll(STRING_MARK, '\ufffd');
  const strings: string[] = [];
  const calls: number[] = [];
  let text = '';
  // The name being read (escapes decoded) and the character before it: url(
  // starts an unquoted address only after a bare url name, not inside a #hash
  // or @rule.
  let name = '';
  let beforeName = '';
  const endName = (char: string) => {
    name = '';
    beforeName = char;
  };
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const called =
      char === '(' && beforeName !== '#' && beforeName !== '@'
        ? name.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
        : '';
    const url = called === 'url' ? readUrl(source, i) : undefined;
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      text += ' ';
      endName(' ');
    } else if (url) {
      // An unquoted address, kept like a string.
      text += '(';
      calls.push(text.length);
      text += `${stringPlaceholder(strings.length)})`;
      strings.push(url[0]);
      i = url[1];
      endName(')');
    } else if (source.startsWith('<!--', i)) {
      // The browser reads <!-- as one token; a name after it starts afresh.
      text += '<!--';
      i += 4;
      endName(' ');
    } else if (char === '"' || char === "'") {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== char) {
        if (isNewline(source[i])) {
          // An unterminated string ends at the line break, as in the browser.
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
      // An escaped character is always part of a name.
      const [decoded, next] = readEscape(source, i);
      text += decoded;
      name += decoded;
      i = next;
    } else {
      text += char;
      i += 1;
      if (called === 'url' || called === 'src') {
        calls.push(text.length);
      }
      if (isNameChar(char)) {
        name += char;
      } else {
        endName(char);
      }
    }
  }
  // Only A–Z, so positions match between text and lower.
  const lower = text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return { text, lower, strings, calls };
};

/**
 * The address passed to a function whose argument starts at `at`: a string, or
 * the unquoted text up to the closing bracket.
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
 * Anything that looks like url( or src(, a superset of what the browser treats
 * as such (extras only make the check stricter). Not after # or @, where #url(
 * and @url( are names, not functions.
 */
const LOOKS_CALLED = /(?<![a-z0-9_\-\u0080-￿#@])(url|src)\(/g;

/** Every address the CSS uses, in order, with imports flagged. */
const addressesIn = (
  read: ReadCss
): { address: string; imported: boolean }[] => {
  // Keyed by where each address starts in the text.
  const uses = new Map<number, { address: string; imported: boolean }>();
  const calls = new Set(read.calls);
  for (const match of read.lower.matchAll(LOOKS_CALLED)) {
    calls.add(match.index + match[0].length);
  }
  for (const at of calls) {
    uses.set(at, { address: addressAt(read, at), imported: false });
  }
  // @import followed by a string or url() makes that address an import.
  for (const match of read.lower.matchAll(/@import/g)) {
    let at = match.index + match[0].length;
    while (isSpace(read.text[at])) {
      at += 1;
    }
    if (read.lower.startsWith('url(', at)) {
      at += 4;
    } else if (!STRING_AT.test(read.text.slice(at))) {
      continue;
    }
    uses.set(at, { address: addressAt(read, at), imported: true });
  }
  return [...uses.entries()].sort(([a], [b]) => a - b).map(([, use]) => use);
};

/**
 * The addresses a stylesheet uses: imported stylesheets, and images and fonts
 * (others). Comments and strings that merely look like addresses aren't
 * counted.
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
 * Addresses personal CSS may use: a path on this server (not `//host`, another
 * server), a fragment of the page (`#id`, for filters and masks), or an inline
 * `data:` image or font.
 */
const ownAddress = (address: string): boolean =>
  /^\/(?![/\\])[^\s\\"'()<>]*$/.test(address) ||
  /^#[^\s\\"'()<>]*$/.test(address) ||
  /^data:(image|font)\//i.test(address);

/** Constructs that run code, outside strings. */
const RUNS: [RegExp, string][] = [
  [/(?<![a-z0-9_\-\u0080-￿])expression\s*\(/, 'expression()'],
  [/(?:^|[{;\s])(?:-ms-)?behavior\s*:/, 'behavior'],
  [/-moz-binding/, '-moz-binding'],
];

/** Script URL schemes, matched anywhere, strings included. */
const SCRIPT_ADDRESSES = ['javascript:', 'vbscript:'];

/** Personal CSS as stored (trimmed; '' for none), or its problem. */
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

/** Server CSS as stored (trimmed), or its problem. */
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
