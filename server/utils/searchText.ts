// Shared by the server, which builds each title's searchable text, and the
// page, which matches filters against it, so both normalize text the same way.

/**
 * Lowercases, drops accents and turns punctuation into spaces, so "Rosélie"
 * finds "roselie" and "Web-Weaver" finds "web weaver".
 */
export const normalizeSearchText = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** A filter's normalized words. */
export const searchWords = (query: string): string[] =>
  normalizeSearchText(query).split(' ').filter(Boolean);

/**
 * Whether every word matches the start of some word in the text: "ned barlow"
 * finds Ned Barlow, "tam" finds Tam Vexley but not Rustamson.
 */
export const matchesSearch = (haystack: string, words: string[]): boolean => {
  const padded = ` ${haystack} `;
  return words.every((word) => padded.includes(` ${word}`));
};
