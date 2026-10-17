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
  ArrowDownIcon,
  ArrowUpIcon,
  Bars3BottomLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleStackIcon,
  FunnelIcon,
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
  unableToConnect:
    'Unable to connect to {services}. Some information may be unavailable.',
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

  const page = router.query.page ? Number(router.query.page) : 1;
  const pageIndex = page - 1;
  const updateQueryParams = useUpdateQueryParams({ page: page.toString() });

  // The user picker is only shown where the list is not already scoped to a
  // single person, so it never conflicts with the profile view.
  // Changing a filter returns to the first page, as the selects did.
  const resetPage = () => {
    router.push({
      pathname: router.pathname,
      query: router.query.userId ? { userId: router.query.userId } : {},
    });
  };

  // Only people who see everyone's requests can pick whose; everyone else
  // only ever sees their own, and the server refuses a filter for others.
  const canFilterByUser =
    !router.pathname.startsWith('/profile') &&
    !router.query.userId &&
    hasPermission([Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW], {
      type: 'or',
    });

  const { data: userData } = useSWR<{
    results: { id: number; displayName: string }[];
  }>(canFilterByUser ? '/api/v1/user?take=100&sort=displayname' : null);

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<RequestResultsResponse>(
    `/api/v1/request?take=${currentPageSize}&skip=${
      pageIndex * currentPageSize
    }&filter=${currentFilters.join(',') || 'all'}&mediaType=${
      currentMediaTypes.join(',') || 'all'
    }&sort=${currentSort}&sortDirection=${currentSortDirection}${
      router.pathname.startsWith('/profile')
        ? `&requestedBy=${currentUser?.id}`
        : router.query.userId
          ? `&requestedBy=${router.query.userId}`
          : // Also ignores a filter saved on this device by someone else.
            canFilterByUser && currentRequestedBy.length
            ? `&requestedBy=${currentRequestedBy.join(',')}`
            : ''
    }`
  );
  // Every card's estimate in one call, rather than one per card.
  const etaFor = useRequestEtas(
    data?.results.map((request) => request.id) ?? []
  );
  // Backfill's state for the titles on this page, in one call; admins only.
  // Films and series only: Backfill knows nothing of music.
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
      refreshInterval: (latest) => (latest?.some((row) => row.job) ? 5000 : 0),
    }
  );

  // Everyone else: whether Backfill is looking for their own requests.
  const { data: backfillStatus } = useSWR<BackfillStatus[]>(
    !hasPermission(Permission.ADMIN) && tmdbIds.length
      ? `/api/v1/backfill-status?tmdbIds=${tmdbIds.join(',')}`
      : null,
    {
      refreshInterval: (latest) =>
        latest?.some((s) => s.state === 'downloading') ? 10000 : 0,
    }
  );

  // Restore last set filter values on component mount
  useEffect(() => {
    const filterString = window.localStorage.getItem('rl-filter-settings');

    if (filterString) {
      const filterSettings = JSON.parse(filterString);

      if (Array.isArray(filterSettings.currentFilters)) {
        setCurrentFilters(filterSettings.currentFilters);
      } else if (filterSettings.currentFilter) {
        // Saved by an earlier version as a single value.
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

    // If filter value is provided in query, use that instead
    if (Object.values(Filter).includes(router.query.filter as Filter)) {
      setCurrentFilters([router.query.filter as Filter]);
    }
  }, [router.query.filter]);

  // Set filter values to local storage any time they are changed
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
      <div className="mb-4 flex flex-col justify-between lg:flex-row lg:items-end">
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
        <div className="mt-2 flex flex-grow flex-col sm:flex-row lg:flex-grow-0">
          <div className="mb-2 flex flex-grow sm:mb-0 sm:mr-2 lg:flex-grow-0">
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
            <div className="mb-2 flex flex-grow sm:mb-0 sm:mr-2 lg:flex-grow-0">
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
          <div className="mb-2 flex flex-grow sm:mb-0 sm:mr-2 lg:flex-grow-0">
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
          <div className="mb-2 flex flex-grow sm:mb-0 lg:flex-grow-0">
            <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 sm:text-sm">
              <Bars3BottomLeftIcon className="h-6 w-6" />
            </span>
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
              className="rounded-none border-r-0"
            >
              <option value="added">
                {intl.formatMessage(messages.sortAdded)}
              </option>
              <option value="modified">
                {intl.formatMessage(messages.sortModified)}
              </option>
            </select>
            <Tooltip content={intl.formatMessage(messages.sortDirection)}>
              <Button
                buttonType="default"
                className="z-40 mr-2 rounded-l-none border !border-gray-500 !bg-gray-800 !px-3 !text-gray-500 hover:!bg-gray-400 hover:!text-strong"
                buttonSize="md"
                onClick={() =>
                  setCurrentSortDirection(
                    currentSortDirection === 'asc' ? 'desc' : 'asc'
                  )
                }
              >
                {currentSortDirection === 'asc' ? (
                  <ArrowUpIcon className="h-6 w-6" />
                ) : (
                  <ArrowDownIcon className="h-6 w-6" />
                )}
              </Button>
            </Tooltip>
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
            <span className="-mt-3 items-center truncate text-sm sm:mt-0">
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
