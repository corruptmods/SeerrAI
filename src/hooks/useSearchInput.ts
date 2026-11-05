/* eslint-disable react-hooks/exhaustive-deps */
import type { Nullable } from '@app/utils/typeHelpers';
import { useRouter } from 'next/router';
import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useState } from 'react';
import type { UrlObject } from 'url';
import useDebouncedState from './useDebouncedState';

type Url = string | UrlObject;

interface SearchObject {
  searchValue: string;
  searchOpen: boolean;
  setIsOpen: Dispatch<SetStateAction<boolean>>;
  setSearchValue: Dispatch<SetStateAction<string>>;
  clear: () => void;
}

const useSearchInput = (): SearchObject => {
  const router = useRouter();
  const [searchOpen, setIsOpen] = useState(false);
  const [lastRoute, setLastRoute] = useState<Nullable<Url>>(null);
  const [searchValue, debouncedValue, setSearchValue] = useDebouncedState(
    (router.query.query as string) ?? ''
  );

  // On debounced input: push /search, or replace history if already there.
  useEffect(() => {
    if (debouncedValue !== '' && searchOpen) {
      if (router.pathname.startsWith('/search')) {
        router.replace({
          pathname: router.pathname,
          query: {
            ...router.query,
            query: debouncedValue,
          },
        });
      } else {
        setLastRoute(router.asPath);
        router
          .push({
            pathname: '/search',
            query: { query: debouncedValue },
          })
          .then(() => window.scrollTo(0, 0));
      }
    }
  }, [debouncedValue]);

  // On close: return to lastRoute, or / when there is none (deep link).
  useEffect(() => {
    if (
      searchValue === '' &&
      router.pathname.startsWith('/search') &&
      !searchOpen
    ) {
      if (lastRoute) {
        router.push(lastRoute).then(() => window.scrollTo(0, 0));
      } else {
        router.replace('/').then(() => window.scrollTo(0, 0));
      }
    }
  }, [searchOpen]);

  // On route change: sync the input to the query (or empty), so it keeps the
  // last entry across detail pages. Close off /search with no query; always
  // open on /search.
  useEffect(() => {
    if (router.query.query !== debouncedValue) {
      setSearchValue(
        router.query.query
          ? decodeURIComponent(router.query.query as string)
          : ''
      );

      if (!router.pathname.startsWith('/search') && !router.query.query) {
        setIsOpen(false);
      }
    }

    if (router.pathname.startsWith('/search')) {
      setIsOpen(true);
    }
  }, [router, setSearchValue]);

  const clear = () => {
    setIsOpen(false);
    setSearchValue('');
  };

  return {
    searchValue,
    searchOpen,
    setIsOpen,
    setSearchValue,
    clear,
  };
};

export default useSearchInput;
