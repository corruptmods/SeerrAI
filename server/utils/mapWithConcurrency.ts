/**
 * Like Promise.all(items.map(fn)) but with at most `limit` calls in flight.
 *
 * Results are in input order. Use it wherever a list of external requests would
 * otherwise fire at once: third-party APIs throttle or time out under unbounded
 * bursts, and a slow item stalls nothing else.
 */
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => worker()
  );

  await Promise.all(workers);

  return results;
};

export default mapWithConcurrency;
