/**
 * Max rows per page of a list endpoint. The UI offers up to 100; more means
 * fetching the whole table, a slow query and large response on a big library.
 */
export const MAX_PAGE_SIZE = 100;

const wholeNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : undefined;
};

/**
 * `take` and `skip` from a query string, clamped: one to MAX_PAGE_SIZE rows,
 * from zero on. Invalid values fall back to defaults rather than reaching the
 * database as NaN.
 */
export const pageOf = (
  query: { take?: unknown; skip?: unknown },
  defaultSize: number
): { pageSize: number; skip: number } => {
  const take = wholeNumber(query.take);
  const skip = wholeNumber(query.skip);

  return {
    pageSize:
      take === undefined || take < 1
        ? defaultSize
        : Math.min(take, MAX_PAGE_SIZE),
    skip: skip === undefined || skip < 0 ? 0 : skip,
  };
};
