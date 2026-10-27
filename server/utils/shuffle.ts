/*
 * A shuffle that comes out the same for the same seed: a list shown in
 * pages can be mixed anew for each visit and still give each page the
 * titles that follow the last, never one twice.
 */

/** The largest seed taken; a page picks one below it. */
export const SHUFFLE_SEED_LIMIT = 2 ** 32;

/**
 * A seed from a query value, or undefined when it is not one. The API's
 * validator hands it over as a number; read straight from a URL it is text.
 */
export const shuffleSeed = (value: unknown): number | undefined => {
  const seed = Number(value);
  return ((typeof value === 'string' && value !== '') ||
    typeof value === 'number') &&
    Number.isInteger(seed) &&
    seed >= 0 &&
    seed < SHUFFLE_SEED_LIMIT
    ? seed
    : undefined;
};

/** Numbers from 0 to 1, the same run of them for the same seed. */
const numbersFrom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / SHUFFLE_SEED_LIMIT;
  };
};

/** A new list of these, in an order set by the seed. */
export const seededShuffle = <T>(items: readonly T[], seed: number): T[] => {
  const next = numbersFrom(seed);
  const mixed = [...items];
  for (let i = mixed.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [mixed[i], mixed[j]] = [mixed[j], mixed[i]];
  }
  return mixed;
};
