/*
 * Shared by the server, which builds each title's searchable text, and the
 * page, which matches a filter against it — so both read text the same way.
 */

/**
 * Lower case, accents dropped and punctuation as spaces, so "Rosélie" finds
 * "roselie" and "Web-Weaver" finds "web weaver".
 */
export const normalizeSearchText = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** The words of a filter, normalized. */
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
