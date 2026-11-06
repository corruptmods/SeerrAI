import usePageReturn from '@app/hooks/usePageReturn';
import useTitleChanged, { pageHolds } from '@app/hooks/useTitleChanged';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import { START_PAGES, listProgress } from '@app/utils/discoverPages';
import { MediaStatus } from '@server/constants/media';
import { useEffect } from 'react';
import { useIntl } from 'react-intl';
import useSWRInfinite from 'swr/infinite';
import useSettings from './useSettings';
import { Permission, useUser } from './useUser';

export interface BaseSearchResult<T> {
  page: number;
  totalResults: number;
  totalPages: number;
  results: T[];
}

interface BaseMedia {
  id: number;
  mediaType: string;
  mediaInfo?: {
    status: MediaStatus;
    hasActiveRequest?: boolean;
  };
}

interface DiscoverResult<T, S> {
  isLoadingInitialData: boolean;
  isLoadingMore: boolean;
  fetchMore: () => void;
  isEmpty: boolean;
  isReachingEnd: boolean;
  error: unknown;
  titles: T[];
  /** Pages of results loaded. */
  pagesLoaded: number;
  firstResultData?: BaseSearchResult<T> & S;
  mutate?: () => void;
}

const extraEncodes: [RegExp, string][] = [
  [/\(/g, '%28'],
  [/\)/g, '%29'],
  [/!/g, '%21'],
  [/\*/g, '%2A'],
];

export const encodeURIExtraParams = (string: string): string => {
  let finalString = encodeURIComponent(string);

  extraEncodes.forEach((encode) => {
    finalString = finalString.replace(encode[0], encode[1]);
  });

  return finalString;
};

const useDiscover = <
  T extends BaseMedia,
  S = Record<string, never>,
  O = Record<string, unknown>,
>(
  endpoint: string,
  options?: O,
  {
    hideAvailable = true,
    hideBlocklisted = true,
    hideRequested = true,
    shortPages = false,
  }: {
    hideAvailable?: boolean;
    hideBlocklisted?: boolean;
    hideRequested?: boolean;
    /** Pages may hold fewer than 20 without being last, so only the page count marks the end. */
    shortPages?: boolean;
  } = {}
): DiscoverResult<T, S> => {
  const settings = useSettings();
  const { hasPermission } = useUser();
  const { addToast } = useToasts();
  const intl = useIntl();
  const { data, error, size, setSize, isValidating, mutate } = useSWRInfinite<
    BaseSearchResult<T> & S
  >(
    (pageIndex: number, previousPageData) => {
      if (previousPageData && pageIndex + 1 > previousPageData.totalPages) {
        return null;
      }

      const params: Record<string, unknown> = {
        page: pageIndex + 1,
        ...options,
      };

      const finalQueryString = Object.keys(params)
        .map(
          (paramKey) =>
            `${paramKey}=${encodeURIExtraParams(params[paramKey] as string)}`
        )
        .join('&');

      return `${endpoint}?${finalQueryString}`;
    },
    {
      revalidateFirstPage: false,
      dedupingInterval: 30000,
      revalidateOnFocus: false,
    }
  );

  // After a request, reload only the pages holding the title.
  useTitleChanged((title) => {
    if (data?.some((page) => pageHolds(page, title))) {
      mutate(undefined, { revalidate: (page) => pageHolds(page, title) });
    }
  });

  // A film and a series can share a TMDB id; keep both.
  const resultIds = new Set<string>();

  const isLoadingInitialData = !data && !error;
  const loadingPages =
    isLoadingInitialData ||
    (size > 0 &&
      !!data &&
      typeof data[size - 1] === 'undefined' &&
      isValidating);

  let titles = (data ?? []).reduce((a, v) => {
    // Skip pages without results, as in MediaSlider.
    if (!Array.isArray(v?.results)) {
      return a;
    }

    const results: T[] = [];

    for (const result of v.results) {
      const key = `${(result as { mediaType?: string }).mediaType ?? ''}:${
        result.id
      }`;
      if (!resultIds.has(key)) {
        resultIds.add(key);
        results.push(result);
      }
    }

    return [...a, ...results];
  }, [] as T[]);

  if (settings.currentSettings.hideAvailable && hideAvailable) {
    titles = titles.filter(
      (i) =>
        !(i.mediaType === 'movie' || i.mediaType === 'tv') ||
        (i.mediaInfo?.status !== MediaStatus.AVAILABLE &&
          i.mediaInfo?.status !== MediaStatus.PARTIALLY_AVAILABLE)
    );
  }

  if (
    settings.currentSettings.hideBlocklisted &&
    hideBlocklisted &&
    hasPermission(Permission.MANAGE_BLOCKLIST)
  ) {
    titles = titles.filter(
      (i) =>
        !(i.mediaType === 'movie' || i.mediaType === 'tv') ||
        i.mediaInfo?.status !== MediaStatus.BLOCKLISTED
    );
  }

  if (settings.currentSettings.hideRequested && hideRequested) {
    titles = titles.filter((i) => {
      if (i.mediaType !== 'movie' && i.mediaType !== 'tv') {
        return true;
      }

      return !i.mediaInfo?.hasActiveRequest;
    });
  }

  const { starting, isEmpty, isReachingEnd } = listProgress({
    pages: data,
    loadingFirst: isLoadingInitialData,
    size,
    titlesShown: titles.length,
    shortPages,
  });

  // Once the first page shows, request the rest of the initial pages.
  useEffect(() => {
    if (starting && size < START_PAGES) {
      setSize(START_PAGES);
    }
  }, [starting, size, setSize]);

  // Coming back to the list: the pages it had, then where it was scrolled.
  const loadedPages = data?.length ?? 0;
  const returnPages = usePageReturn('list', {
    pages: loadedPages,
    isReady: (wanted) =>
      !isLoadingInitialData &&
      (!!error || isReachingEnd || loadedPages >= (wanted ?? 0)),
  });
  useEffect(() => {
    if (
      returnPages &&
      returnPages > START_PAGES &&
      loadedPages > 0 &&
      size < returnPages &&
      !isReachingEnd &&
      !error
    ) {
      setSize(returnPages);
    }
  }, [returnPages, loadedPages, size, isReachingEnd, error, setSize]);

  // Initial pages count as loading more, so scrolling doesn't re-request page 2.
  const isLoadingMore = loadingPages || (starting && !error);

  const fetchMore = () => {
    setSize(starting ? Math.max(size, START_PAGES) : size + 1);
  };

  // Too few titles to scroll: request the next page now (a few pages at most).
  useEffect(() => {
    if (
      shortPages &&
      !starting &&
      !isReachingEnd &&
      !isLoadingMore &&
      !error &&
      titles.length < 20 &&
      size < 5
    ) {
      setSize(size + 1);
    }
  }, [
    shortPages,
    starting,
    isReachingEnd,
    isLoadingMore,
    error,
    titles.length,
    size,
    setSize,
  ]);

  useEffect(() => {
    if (error && titles.length) {
      addToast(intl.formatMessage(globalMessages.error), {
        appearance: 'error',
        autoDismiss: true,
      });
      console.error('Error while fetching discover titles:', error);
    }
  }, [data, error, addToast, intl, titles.length]);

  return {
    isLoadingInitialData,
    isLoadingMore,
    fetchMore,
    isEmpty,
    isReachingEnd,
    error: error && titles.length ? null : error,
    titles,
    pagesLoaded: loadedPages,
    firstResultData: data?.[0],
    mutate,
  };
};

export default useDiscover;
