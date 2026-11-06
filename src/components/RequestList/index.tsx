import type { BackfillLookup } from '@app/components/Backfill/RequestChip';
import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import MultiSelectFilter from '@app/components/Common/MultiSelectFilter';
import { CardListSkeleton } from '@app/components/Common/PageSkeleton';
import PageTitle from '@app/components/Common/PageTitle';
import Tooltip from '@app/components/Common/Tooltip';
import RequestItem from '@app/components/RequestList/RequestItem';
import useFeature from '@app/hooks/useFeature';
import useRequestEtas from '@app/hooks/useRequestEtas';
import { useUpdateQueryParams } from '@app/hooks/useUpdateQueryParams';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import {
  BarsArrowDownIcon,
  BarsArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleStackIcon,
  FunnelIcon,
  MagnifyingGlassIcon,
  UserIcon,
} from '@heroicons/react/24/solid';
import { MediaType } from '@server/constants/media';
import type { BackfillStatus } from '@server/interfaces/api/backfillStatus';
import type { RequestResultsResponse } from '@server/interfaces/api/requestInterfaces';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.RequestList', {
  pagination: 'Pagination',
  requests: 'Requests',
  allusers: 'All Users',
  showallrequests: 'Show All Requests',
  sortAdded: 'Most Recent',
  sortModified: 'Last Modified',
  sortDirection: 'Toggle Sort Direction',
  searchRequests: 'Search requests',
  unableToConnect: 'Can’t reach {services}, so some details may be missing.',
});

enum Filter {
  ALL = 'all',
  PENDING = 'pending',
  APPROVED = 'approved',
  PROCESSING = 'processing',
  AVAILABLE = 'available',
  UNAVAILABLE = 'unavailable',
  FAILED = 'failed',
  DELETED = 'deleted',
  COMPLETED = 'completed',
}

type Sort = 'added' | 'modified';

type SortDirection = 'asc' | 'desc';

const RequestList = () => {
  const router = useRouter();
  const intl = useIntl();
  const { user } = useUser({
    id: Number(router.query.userId),
  });
  const { user: currentUser, hasPermission } = useUser();
  const musicOn = useFeature('music');
  const [currentFilters, setCurrentFilters] = useState<string[]>([
    Filter.PENDING,
  ]);
  const [currentRequestedBy, setCurrentRequestedBy] = useState<string[]>([]);
  const [currentSort, setCurrentSort] = useState<Sort>('added');
  const [currentMediaTypes, setCurrentMediaTypes] = useState<string[]>([]);
  const [currentSortDirection, setCurrentSortDirection] =
    useState<SortDirection>('desc');
  const [currentPageSize, setCurrentPageSize] = useState<number>(10);
  // Raw input, and the debounced search term.
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');

  const page = router.query.page ? Number(router.query.page) : 1;
  const pageIndex = page - 1;
  const updateQueryParams = useUpdateQueryParams({ page: page.toString() });

  // Back to page one on filter change, keeping a userId scope.
  const resetPage = () => {
    router.push({
      pathname: router.pathname,
      query: router.query.userId ? { userId: router.query.userId } : {},
    });
  };

  // The user picker is hidden when scoped to one user, and only shown to
  // those who can view all requests; the server refuses it for others.
  const canFilterByUser =
    !router.pathname.startsWith('/profile') &&
    !router.query.userId &&
    hasPermission([Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW], {
      type: 'or',
    });
  // Even columns: the filters share a row under the search, and sit beside
  // the title in one row of equal widths on wide screens.
  const filterGrid = canFilterByUser
    ? {
        columns:
          'sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-[repeat(5,12.5rem)]',
        search: 'sm:col-span-2 xl:col-span-4 2xl:col-span-1',
      }
    : {
        columns: 'sm:grid-cols-3 2xl:grid-cols-[repeat(4,12.5rem)]',
        search: 'sm:col-span-3 2xl:col-span-1',
      };

  const { data: userData } = useSWR<{
    results: { id: number; displayName: string }[];
  }>(canFilterByUser ? '/api/v1/user?take=100&sort=displayname' : null);

  useEffect(() => {
    const words = searchText.trim();
    if (words === search) return;
    const timer = setTimeout(() => {
      setSearch(words);
      if (router.query.page && router.query.page !== '1') resetPage();
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<RequestResultsResponse>(
    `/api/v1/request?take=${currentPageSize}&skip=${
      pageIndex * currentPageSize
    }&filter=${encodeURIComponent(
      currentFilters.join(',') || 'all'
    )}&mediaType=${encodeURIComponent(currentMediaTypes.join(',') || 'all')}&sort=${currentSort}&sortDirection=${currentSortDirection}${
      router.pathname.startsWith('/profile')
        ? `&requestedBy=${currentUser?.id}`
        : router.query.userId
          ? `&requestedBy=${router.query.userId}`
          : // Also drops a filter another user saved on this device.
            canFilterByUser && currentRequestedBy.length
            ? `&requestedBy=${encodeURIComponent(currentRequestedBy.join(','))}`
            : ''
    }${search ? `&search=${encodeURIComponent(search)}` : ''}`,
    // Keep the list (and the box's focus) while the next search loads.
    { keepPreviousData: true }
  );
  // One ETA call for the page, not one per card.
  const etaFor = useRequestEtas(
    data?.results.map((request) => request.id) ?? []
  );
  // Admin Backfill lookup for the page in one call. Backfill doesn't cover
  // music.
  const tmdbIds = [
    ...new Set(
      (data?.results ?? [])
        .filter((request) => request.type !== MediaType.MUSIC)
        .map((request) => request.media.tmdbId)
    ),
  ];
  const { data: backfill } = useSWR<BackfillLookup[]>(
    hasPermission(Permission.ADMIN) && tmdbIds.length
      ? `/api/v1/backfill/lookup?tmdbIds=${tmdbIds.join(',')}`
      : null,
    {
      refreshInterval: (latest) =>
        latest?.some((row) => row.job)
          ? 5000
          : latest?.some((row) => row.workingRunId)
            ? 10000
            : 0,
    }
  );

  // Non-admins: Backfill status of their own requests.
  const { data: backfillStatus } = useSWR<BackfillStatus[]>(
    !hasPermission(Permission.ADMIN) && tmdbIds.length
      ? `/api/v1/backfill-status?tmdbIds=${tmdbIds.join(',')}`
      : null,
    {
      refreshInterval: (latest) =>
        latest?.some((s) => s.state === 'downloading' || s.agent) ? 10000 : 0,
    }
  );

  useEffect(() => {
    const filterString = window.localStorage.getItem('rl-filter-settings');

    if (filterString) {
      const filterSettings = JSON.parse(filterString);

      if (Array.isArray(filterSettings.currentFilters)) {
        setCurrentFilters(filterSettings.currentFilters);
      } else if (filterSettings.currentFilter) {
        // Legacy single-value format.
        setCurrentFilters([filterSettings.currentFilter]);
      }

      if (Array.isArray(filterSettings.currentMediaTypes)) {
        setCurrentMediaTypes(filterSettings.currentMediaTypes);
      } else if (
        filterSettings.currentMediaType &&
        filterSettings.currentMediaType !== 'all'
      ) {
        setCurrentMediaTypes([filterSettings.currentMediaType]);
      }

      if (Array.isArray(filterSettings.currentRequestedBy)) {
        setCurrentRequestedBy(filterSettings.currentRequestedBy);
      }

      setCurrentSort(filterSettings.currentSort);
      setCurrentPageSize(filterSettings.currentPageSize);
      if (['asc', 'desc'].includes(filterSettings.currentSortDirection)) {
        setCurrentSortDirection(filterSettings.currentSortDirection);
      }
    }

    // A filter in the query overrides the saved one.
    if (Object.values(Filter).includes(router.query.filter as Filter)) {
      setCurrentFilters([router.query.filter as Filter]);
    }
  }, [router.query.filter]);

  useEffect(() => {
    window.localStorage.setItem(
      'rl-filter-settings',
      JSON.stringify({
        currentFilters,
        currentMediaTypes,
        currentRequestedBy,
        currentSort,
        currentSortDirection,
        currentPageSize,
      })
    );
  }, [
    currentFilters,
    currentMediaTypes,
    currentRequestedBy,
    currentSort,
    currentSortDirection,
    currentPageSize,
  ]);

  if (!data && !error) {
    return <CardListSkeleton />;
  }

  if (!data) {
    return <CardListSkeleton />;
  }

  const hasNextPage = data.pageInfo.pages > pageIndex + 1;
  const hasPrevPage = pageIndex > 0;

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.requests),
          router.query.userId ? user?.displayName : '',
        ]}
      />
      <div className="mb-4 flex flex-col justify-between 2xl:flex-row 2xl:items-end 2xl:gap-4">
        <Header
          subtext={
            router.pathname.startsWith('/profile') ? (
              <Link href={`/profile`} className="hover:underline">
                {currentUser?.displayName}
              </Link>
            ) : router.query.userId ? (
              <Link href={`/users/${user?.id}`} className="hover:underline">
                {user?.displayName}
              </Link>
            ) : (
              ''
            )
          }
        >
          {intl.formatMessage(messages.requests)}
        </Header>
        <div className={`mt-2 grid grid-cols-1 gap-2 ${filterGrid.columns}`}>
          <div className={`flex min-w-0 ${filterGrid.search}`}>
            <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-sm text-gray-100">
              <MagnifyingGlassIcon className="h-6 w-6" />
            </span>
            <input
              type="text"
              aria-label={intl.formatMessage(messages.searchRequests)}
              placeholder={intl.formatMessage(messages.searchRequests)}
              className="rounded-r-only"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
          </div>
          <div className="flex min-w-0">
            <MultiSelectFilter
              icon={<CircleStackIcon className="h-6 w-6" />}
              name="mediaType"
              onChange={(values) => {
                setCurrentMediaTypes(values);
                resetPage();
              }}
              options={[
                {
                  value: 'movie',
                  label: intl.formatMessage(globalMessages.movies),
                },
                {
                  value: 'tv',
                  label: intl.formatMessage(globalMessages.tvshows),
                },
                ...(musicOn
                  ? [
                      {
                        value: 'music',
                        label: intl.formatMessage(globalMessages.music),
                      },
                    ]
                  : []),
              ]}
              selected={currentMediaTypes}
            />
          </div>
          {canFilterByUser && (
            <div className="flex min-w-0">
              <MultiSelectFilter
                allLabel={intl.formatMessage(messages.allusers)}
                icon={<UserIcon className="h-6 w-6" />}
                name="requestedBy"
                onChange={(values) => {
                  setCurrentRequestedBy(values);
                  resetPage();
                }}
                options={(userData?.results ?? []).map((user) => ({
                  value: String(user.id),
                  label: user.displayName,
                }))}
                selected={currentRequestedBy}
              />
            </div>
          )}
          <div className="flex min-w-0">
            <MultiSelectFilter
              icon={<FunnelIcon className="h-6 w-6" />}
              name="filter"
              onChange={(values) => {
                setCurrentFilters(values);
                resetPage();
              }}
              options={[
                {
                  value: 'pending',
                  label: intl.formatMessage(globalMessages.pending),
                },
                {
                  value: 'approved',
                  label: intl.formatMessage(globalMessages.approved),
                },
                {
                  value: 'completed',
                  label: intl.formatMessage(globalMessages.completed),
                },
                {
                  value: 'processing',
                  label: intl.formatMessage(globalMessages.processing),
                },
                {
                  value: 'failed',
                  label: intl.formatMessage(globalMessages.failed),
                },
                {
                  value: 'available',
                  label: intl.formatMessage(globalMessages.available),
                },
                {
                  value: 'unavailable',
                  label: intl.formatMessage(globalMessages.unavailable),
                },
              ]}
              selected={currentFilters}
            />
          </div>
          <div className="flex min-w-0">
            <Tooltip content={intl.formatMessage(messages.sortDirection)}>
              <button
                type="button"
                aria-label={intl.formatMessage(messages.sortDirection)}
                className="inline-flex flex-none items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 transition hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                onClick={() =>
                  setCurrentSortDirection(
                    currentSortDirection === 'asc' ? 'desc' : 'asc'
                  )
                }
              >
                {currentSortDirection === 'asc' ? (
                  <BarsArrowUpIcon className="h-6 w-6" />
                ) : (
                  <BarsArrowDownIcon className="h-6 w-6" />
                )}
              </button>
            </Tooltip>
            <select
              id="sort"
              aria-label={intl.formatMessage(globalMessages.sortBy)}
              name="sort"
              onChange={(e) => {
                setCurrentSort(e.target.value as Sort);
                router.push({
                  pathname: router.pathname,
                  query: router.query.userId
                    ? { userId: router.query.userId }
                    : {},
                });
              }}
              value={currentSort}
              className="rounded-r-only pr-8"
            >
              <option value="added">
                {intl.formatMessage(messages.sortAdded)}
              </option>
              <option value="modified">
                {intl.formatMessage(messages.sortModified)}
              </option>
            </select>
          </div>
        </div>
      </div>

      {data.serviceErrors &&
        (data.serviceErrors.radarr.length > 0 ||
          data.serviceErrors.sonarr.length > 0) &&
        (hasPermission(Permission.MANAGE_REQUESTS) ||
          hasPermission(Permission.REQUEST_ADVANCED)) && (
          <div className="service-error-banner">
            <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0" />
            <span>
              {intl.formatMessage(messages.unableToConnect, {
                services: [
                  ...data.serviceErrors.radarr.map((s) => s.name),
                  ...data.serviceErrors.sonarr.map((s) => s.name),
                ].join(', '),
              })}
            </span>
          </div>
        )}

      {data.results.map((request) => {
        return (
          <div className="list-row py-2" key={`request-list-${request.id}`}>
            <RequestItem
              eta={etaFor(request.id)}
              backfill={backfill?.find(
                (b) =>
                  b.tmdbId === request.media.tmdbId &&
                  b.kind === (request.type === 'tv' ? 'series' : 'movie')
              )}
              backfillStatus={backfillStatus?.find(
                (b) =>
                  b.tmdbId === request.media.tmdbId &&
                  b.mediaType === request.type
              )}
              request={request}
              revalidateList={() => revalidate()}
            />
          </div>
        );
      })}

      {data.results.length === 0 && (
        <div className="flex w-full flex-col items-center justify-center py-24 text-strong">
          <span className="text-2xl text-gray-400">
            {intl.formatMessage(globalMessages.noresults)}
          </span>
          {(currentFilters.length > 0 ||
            currentMediaTypes.length > 0 ||
            currentRequestedBy.length > 0) && (
            <div className="mt-4">
              <Button
                buttonType="primary"
                onClick={() => {
                  setCurrentFilters([]);
                  setCurrentMediaTypes([]);
                  setCurrentRequestedBy([]);
                }}
              >
                {intl.formatMessage(messages.showallrequests)}
              </Button>
            </div>
          )}
        </div>
      )}
      <div className="actions">
        <nav
          className="mb-3 flex flex-col items-center space-y-3 sm:flex-row sm:space-y-0"
          aria-label={intl.formatMessage(messages.pagination)}
        >
          <div className="hidden lg:flex lg:flex-1">
            <p className="text-sm">
              {data.results.length > 0 &&
                intl.formatMessage(globalMessages.showingresults, {
                  from: pageIndex * currentPageSize + 1,
                  to:
                    data.results.length < currentPageSize
                      ? pageIndex * currentPageSize + data.results.length
                      : (pageIndex + 1) * currentPageSize,
                  total: data.pageInfo.results,
                  strong: (msg: React.ReactNode) => (
                    <span className="font-medium">{msg}</span>
                  ),
                })}
            </p>
          </div>
          <div className="flex justify-center sm:flex-1 sm:justify-start lg:justify-center">
            <span className="-mt-3 items-center text-sm sm:mt-0">
              {intl.formatMessage(globalMessages.resultsperpage, {
                pageSize: (
                  <select
                    id="pageSize"
                    aria-label={intl.formatMessage(globalMessages.pageSize)}
                    name="pageSize"
                    onChange={(e) => {
                      setCurrentPageSize(Number(e.target.value));
                      router
                        .push({
                          pathname: router.pathname,
                          query: router.query.userId
                            ? { userId: router.query.userId }
                            : {},
                        })
                        .then(() => window.scrollTo(0, 0));
                    }}
                    value={currentPageSize}
                    className="short inline"
                  >
                    <option value="5">5</option>
                    <option value="10">10</option>
                    <option value="25">25</option>
                    <option value="50">50</option>
                    <option value="100">100</option>
                  </select>
                ),
              })}
            </span>
          </div>
          <div className="flex flex-auto justify-center space-x-2 sm:flex-1 sm:justify-end">
            <Button
              disabled={!hasPrevPage}
              onClick={() => updateQueryParams('page', (page - 1).toString())}
            >
              <ChevronLeftIcon />
              <span>{intl.formatMessage(globalMessages.previous)}</span>
            </Button>
            <Button
              disabled={!hasNextPage}
              onClick={() => updateQueryParams('page', (page + 1).toString())}
            >
              <span>{intl.formatMessage(globalMessages.next)}</span>
              <ChevronRightIcon />
            </Button>
          </div>
        </nav>
      </div>
    </>
  );
};

export default RequestList;
