/** Requests newest first, without mutating the input. */
export const newestFirst = <T extends { id: number; createdAt: Date }>(
  requests: T[]
): T[] =>
  [...requests].sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
      b.id - a.id
  );

/**
 * A request's seasons as ranges ("1–3, 5"). Specials (season 0) are
 * separate, to be named in words.
 */
export const seasonGroups = (
  seasonNumbers: number[]
): { specials: boolean; count: number; list: string } => {
  const numbered = [...new Set(seasonNumbers)]
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const n of numbered) {
    const last = runs[runs.length - 1];
    if (last && last[1] === n - 1) {
      last[1] = n;
    } else {
      runs.push([n, n]);
    }
  }
  return {
    specials: seasonNumbers.includes(0),
    count: numbered.length,
    list: runs
      .map(([first, last]) =>
        first === last ? `${first}` : `${first}–${last}`
      )
      .join(', '),
  };
};
