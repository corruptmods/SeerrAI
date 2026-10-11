/**
 * The most rows one page of a list endpoint returns. The interface offers
 * pages of up to a hundred; anything larger is someone asking for the whole
 * table at once, which on a big library is a slow query and a large reply.
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
 * `take` and `skip` from a query string, kept to sensible values: a page of
 * one to MAX_PAGE_SIZE rows, starting at zero or later. Nonsense falls back
 * to the default rather than reaching the database as NaN.
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
