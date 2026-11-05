import type { NextRouter } from 'next/router';
import { useRouter } from 'next/router';
import type { ParsedUrlQuery } from 'querystring';
import { useCallback } from 'react';

type UseQueryParamReturnedFunction = (
  query: ParsedUrlQuery,
  routerAction?: 'push' | 'replace'
) => void;

interface MergedQueryString {
  pathname: string;
  path: string;
}

/** The filters whose keys don't appear in the router pathname (route params). */
export const filterQueryString = (
  router: NextRouter,
  filters: ParsedUrlQuery
): ParsedUrlQuery => {
  const cleanedFilters: ParsedUrlQuery = {};

  Object.keys(filters).forEach((key) => {
    if (!router.pathname.match(new RegExp(`${key}`))) {
      cleanedFilters[key] = filters[key];
    }
  });

  return cleanedFilters;
};

/**
 * The router's pathname and path with `query` merged in. Existing keys are
 * updated; empty or null values remove the key.
 *
 * e.g. on `/foo?bar=test`, `{ newParam: 'value' }` gives
 * `/foo?bar=test&newParam=value` for both.
 */
export const mergeQueryString = (
  router: NextRouter,
  query: ParsedUrlQuery
): MergedQueryString => {
  const cleanedQuery = filterQueryString(router, router.query);

  const mergedQuery = Object.assign({}, cleanedQuery, query);

  const queryArray: string[] = [];

  Object.keys(mergedQuery).forEach((key) => {
    if (mergedQuery[key]) {
      queryArray.push(`${key}=${mergedQuery[key]}`);
    }
  });

  const pathWithoutQuery = router.asPath.match(/(.*)\?.*/);
  const asPath = pathWithoutQuery ? pathWithoutQuery[1] : router.asPath;
  const search = queryArray.length > 0 ? `?${queryArray.join('&')}` : '';

  const pathname = `${router.pathname}${search}`;
  const path = `${asPath}${search}`;

  return { pathname, path };
};

/** A callback that routes to the current page with the given query params merged in. */
export const useQueryParams = (): UseQueryParamReturnedFunction => {
  const router = useRouter();

  return useCallback(
    (query: ParsedUrlQuery, routerAction: 'push' | 'replace' = 'push') => {
      const newRoute = mergeQueryString(router, query);

      if (newRoute.path !== router.asPath) {
        if (routerAction === 'replace') {
          router.replace(newRoute.pathname, newRoute.path);
        } else {
          router.push(newRoute.pathname, newRoute.path);
        }
      }
    },
    [router]
  );
};

export const useUpdateQueryParams = (
  filter: ParsedUrlQuery
): ((key: string, value?: string) => void) => {
  const updateQueryParams = useQueryParams();

  return useCallback(
    (key: string, value?: string) => {
      const query = {
        ...filter,
        [key]: value,
      };
      updateQueryParams(query, 'replace');
    },
    [filter, updateQueryParams]
  );
};

export const useBatchUpdateQueryParams = (
  filter: ParsedUrlQuery
): ((items: Record<string, string | undefined>) => void) => {
  const updateQueryParams = useQueryParams();

  return useCallback(
    (items: Record<string, string | undefined>) => {
      const query = {
        ...filter,
        ...items,
      };
      updateQueryParams(query, 'replace');
    },
    [filter, updateQueryParams]
  );
};
