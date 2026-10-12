import SuggestionReasons from '@app/components/Ai/SuggestionReasons';
import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import useDiscover from '@app/hooks/useDiscover';
import { useUpdateQueryParams } from '@app/hooks/useUpdateQueryParams';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { CircleStackIcon } from '@heroicons/react/24/solid';
import type { MovieResult, TvResult } from '@server/models/Search';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.Suggested', {
  suggested: 'Suggested for You',
  subtitle: 'Like what you have been watching lately. Updated once a day.',
  nothing:
    'Nothing to suggest yet. Suggestions come from what you have finished watching.',
});

type MediaType = 'all' | 'movie' | 'tv';

/**
 * Everything suggested from what this person has been watching: the full
 * list behind the home page row.
 */
const Suggested = () => {
  const intl = useIntl();
  const router = useRouter();
  const updateQueryParams = useUpdateQueryParams({});

  // In the address, as on the other Discover pages, so it survives going to
  // a title and back.
  const currentMediaType: MediaType = (['movie', 'tv'] as const).includes(
    router.query.mediaType as 'movie' | 'tv'
  )
    ? (router.query.mediaType as MediaType)
    : 'all';

  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
  } = useDiscover<MovieResult | TvResult>('/api/v1/discover/suggested', {
    mediaType: currentMediaType,
  });

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.suggested)} />
      <div className="mb-5 mt-1 flex flex-col justify-between lg:flex-row lg:items-end">
        <Header subtext={intl.formatMessage(messages.subtitle)}>
          {intl.formatMessage(messages.suggested)}
        </Header>
        <div className="mt-2 flex flex-grow flex-col sm:flex-row lg:flex-grow-0">
          <div className="mb-2 flex flex-grow sm:mb-0 lg:flex-grow-0">
            <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-sm text-gray-100">
              <CircleStackIcon className="h-6 w-6" />
            </span>
            <select
              id="mediaType"
              name="mediaType"
              onChange={(e) =>
                updateQueryParams(
                  'mediaType',
                  e.target.value === 'all' ? undefined : e.target.value
                )
              }
              value={currentMediaType}
              className="rounded-r-only"
            >
              <option value="all">
                {intl.formatMessage(globalMessages.all)}
              </option>
              <option value="movie">
                {intl.formatMessage(globalMessages.movies)}
              </option>
              <option value="tv">
                {intl.formatMessage(globalMessages.tvshows)}
              </option>
            </select>
          </div>
          <SuggestionReasons
            // A fresh explanation for each filter, as the list differs.
            key={currentMediaType}
            titles={titles ?? []}
            mediaType={currentMediaType}
          />
        </div>
      </div>
      {isEmpty && currentMediaType === 'all' ? (
        <p className="mt-8 text-center text-gray-400">
          {intl.formatMessage(messages.nothing)}
        </p>
      ) : (
        <ListView
          items={titles}
          isEmpty={isEmpty}
          isLoading={
            isLoadingInitialData || (isLoadingMore && (titles?.length ?? 0) > 0)
          }
          isReachingEnd={isReachingEnd}
          onScrollBottom={fetchMore}
        />
      )}
    </>
  );
};

export default Suggested;
