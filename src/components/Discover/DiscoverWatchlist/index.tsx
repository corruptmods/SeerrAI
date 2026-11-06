import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import useDiscover from '@app/hooks/useDiscover';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { BarsArrowDownIcon } from '@heroicons/react/24/solid';
import type { WatchlistSort } from '@server/constants/watchlistSort';
import { watchlistSortOf } from '@server/constants/watchlistSort';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.DiscoverWatchlist', {
  discoverwatchlist: 'Your Watchlist',
  watchlist: 'Plex Watchlist',
  sortDefault: 'Default order',
  sortNewest: 'Newest added',
  sortOldest: 'Oldest added',
  sortTitle: 'Title A–Z',
});

const SORT_OPTIONS: {
  value: WatchlistSort | 'default';
  label: keyof typeof messages;
}[] = [
  { value: 'default', label: 'sortDefault' },
  { value: 'added-desc', label: 'sortNewest' },
  { value: 'added-asc', label: 'sortOldest' },
  { value: 'title', label: 'sortTitle' },
];

const DiscoverWatchlist = () => {
  const intl = useIntl();
  const router = useRouter();
  const { user } = useUser({
    id: Number(router.query.userId),
  });
  const { user: currentUser } = useUser();
  // In the address, so it holds going to a title and back. Without one, the
  // watchlist's own order.
  const sort = watchlistSortOf(router.query.sort);

  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
    mutate,
  } = useDiscover<WatchlistItem>(
    `/api/v1/${
      router.pathname.startsWith('/profile')
        ? `user/${currentUser?.id}`
        : router.query.userId
          ? `user/${router.query.userId}`
          : 'discover'
    }/watchlist`,
    sort ? { sort } : undefined
  );

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  const title = intl.formatMessage(
    router.query.userId ? messages.watchlist : messages.discoverwatchlist
  );

  return (
    <>
      <PageTitle
        title={[title, router.query.userId ? user?.displayName : '']}
      />
      <div className="mb-5 mt-1 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <Header
          subtext={
            router.query.userId ? (
              <Link href={`/users/${user?.id}`} className="hover:underline">
                {user?.displayName}
              </Link>
            ) : (
              ''
            )
          }
        >
          {title}
        </Header>
        <div className="flex w-full min-w-0 sm:w-[12.5rem]">
          <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-sm text-gray-100">
            <BarsArrowDownIcon className="h-6 w-6" />
          </span>
          <select
            id="watchlistSort"
            name="watchlistSort"
            aria-label={intl.formatMessage(globalMessages.sortBy)}
            value={sort ?? 'default'}
            onChange={(e) => {
              const query = { ...router.query };
              const chosen = watchlistSortOf(e.target.value);
              if (chosen) {
                query.sort = chosen;
              } else {
                delete query.sort;
              }
              router.replace({ pathname: router.pathname, query }, undefined, {
                scroll: false,
              });
            }}
            className="rounded-r-only pr-8"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {intl.formatMessage(messages[option.label])}
              </option>
            ))}
          </select>
        </div>
      </div>
      <ListView
        plexItems={titles}
        isEmpty={isEmpty}
        isLoading={
          isLoadingInitialData || (isLoadingMore && (titles?.length ?? 0) > 0)
        }
        isReachingEnd={isReachingEnd}
        onScrollBottom={fetchMore}
        mutateParent={mutate}
      />
    </>
  );
};

export default DiscoverWatchlist;
