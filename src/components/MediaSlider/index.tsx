import ShowMoreCard from '@app/components/MediaSlider/ShowMoreCard';
import PersonCard from '@app/components/PersonCard';
import Slider from '@app/components/Slider';
import TitleCard from '@app/components/TitleCard';
import { useNearObserver } from '@app/hooks/useNearScreen';
import useSettings from '@app/hooks/useSettings';
import useTitleChanged, { pageHolds } from '@app/hooks/useTitleChanged';
import { useUser } from '@app/hooks/useUser';
import { ArrowRightCircleIcon } from '@heroicons/react/24/outline';
import { MediaStatus } from '@server/constants/media';
import { Permission } from '@server/lib/permissions';
import type {
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import Link from 'next/link';
import { useEffect } from 'react';
import { useSWRConfig } from 'swr';
import useSWRInfinite from 'swr/infinite';

interface MixedResult {
  page: number;
  totalResults: number;
  totalPages: number;
  results: (TvResult | MovieResult | PersonResult)[];
}

interface MediaSliderProps {
  title: string;
  url: string;
  linkUrl?: string;
  sliderKey: string;
  hideWhenEmpty?: boolean;
  extraParams?: string;
  onNewTitles?: (titleCount: number) => void;
}

const MediaSlider = ({
  title,
  url,
  linkUrl,
  extraParams,
  sliderKey,
  hideWhenEmpty = false,
  onNewTitles,
}: MediaSliderProps) => {
  const settings = useSettings();
  const { hasPermission } = useUser();
  const pageUrl = (page: number) =>
    `${url}?page=${page}${extraParams ? `&${extraParams}` : ''}`;
  // Fetch once near the screen, so top rows aren't queued behind lower ones.
  // Cached rows (e.g. going back) show at once.
  const { ref: rowRef, near } = useNearObserver();
  const { cache } = useSWRConfig();
  const wanted = near || cache.get(pageUrl(1))?.data !== undefined;
  const { data, error, setSize, size, mutate } = useSWRInfinite<MixedResult>(
    (pageIndex: number, previousPageData: MixedResult | null) => {
      if (
        !wanted ||
        (previousPageData && pageIndex + 1 > previousPageData.totalPages)
      ) {
        return null;
      }

      return pageUrl(pageIndex + 1);
    },
    // One page first so its posters show on arrival; the next (for the
    // "see more" card) is requested after, below.
    { revalidateFirstPage: false }
  );

  // After a request, reload only the pages holding the title.
  useTitleChanged((title) => {
    if (data?.some((page) => pageHolds(page, title))) {
      mutate(undefined, { revalidate: (page) => pageHolds(page, title) });
    }
  });

  // Skip pages without results (a damaged cached copy) instead of breaking the row.
  let titles = (data ?? []).reduce(
    (a, v) => (Array.isArray(v?.results) ? [...a, ...v.results] : a),
    [] as (MovieResult | TvResult | PersonResult)[]
  );

  if (settings.currentSettings.hideAvailable) {
    titles = titles.filter(
      (i) =>
        !(i.mediaType === 'movie' || i.mediaType === 'tv') ||
        (i.mediaInfo?.status !== MediaStatus.AVAILABLE &&
          i.mediaInfo?.status !== MediaStatus.PARTIALLY_AVAILABLE)
    );
  }

  if (settings.currentSettings.hideBlocklisted) {
    titles = titles.filter(
      (i) =>
        !(i.mediaType === 'movie' || i.mediaType === 'tv') ||
        i.mediaInfo?.status !== MediaStatus.BLOCKLISTED
    );
  }

  if (settings.currentSettings.hideRequested) {
    titles = titles.filter((i) => {
      if (i.mediaType !== 'movie' && i.mediaType !== 'tv') {
        return true;
      }

      return !i.mediaInfo?.hasActiveRequest;
    });
  }

  useEffect(() => {
    // One more page at a time, once the last arrived.
    if (
      !!data &&
      data.length >= size &&
      titles.length < 24 &&
      size < 5 &&
      (data[0]?.totalResults ?? 0) > size * 20
    ) {
      setSize(size + 1);
    }

    if (onNewTitles) {
      // Only whether there are any titles matters.
      onNewTitles(titles.length);
    }
  }, [titles, setSize, size, data, onNewTitles]);

  // Hide only once known empty; before that the row must render to be observed.
  if (hideWhenEmpty && data && (data[0]?.results ?? []).length === 0) {
    return null;
  }

  const blocklistVisibility = hasPermission(
    [Permission.MANAGE_BLOCKLIST, Permission.VIEW_BLOCKLIST],
    { type: 'or' }
  );

  const finalTitles = titles
    .slice(0, 20)
    .filter((title) => {
      if (!blocklistVisibility)
        return (
          (title as TvResult | MovieResult).mediaInfo?.status !==
          MediaStatus.BLOCKLISTED
        );
      return title;
    })
    .map((title) => {
      switch (title.mediaType) {
        case 'movie':
          return (
            <TitleCard
              key={`${title.mediaType}-${title.id}`}
              id={title.id}
              isAddedToWatchlist={title.mediaInfo?.watchlists?.length ?? 0}
              image={title.posterPath}
              backdrop={title.backdropPath}
              status={title.mediaInfo?.status}
              outsideLibraries={title.mediaInfo?.outsideLibraries}
              summary={title.overview}
              title={title.title}
              userScore={title.voteAverage}
              year={title.releaseDate}
              mediaType={title.mediaType}
              inProgress={(title.mediaInfo?.downloadStatus ?? []).length > 0}
            />
          );
        case 'tv':
          return (
            <TitleCard
              key={`${title.mediaType}-${title.id}`}
              id={title.id}
              isAddedToWatchlist={title.mediaInfo?.watchlists?.length ?? 0}
              image={title.posterPath}
              backdrop={title.backdropPath}
              status={title.mediaInfo?.status}
              outsideLibraries={title.mediaInfo?.outsideLibraries}
              summary={title.overview}
              title={title.name}
              userScore={title.voteAverage}
              year={title.firstAirDate}
              mediaType={title.mediaType}
              inProgress={(title.mediaInfo?.downloadStatus ?? []).length > 0}
            />
          );
        case 'person':
          return (
            <PersonCard
              personId={title.id}
              name={title.name}
              profilePath={title.profilePath}
            />
          );
      }
    });

  if (linkUrl && titles.length > 20) {
    finalTitles.push(
      <ShowMoreCard
        url={linkUrl}
        posters={titles
          .slice(20, 24)
          .map((title) =>
            title.mediaType !== 'person' ? title.posterPath : undefined
          )}
      />
    );
  }

  return (
    <div ref={rowRef}>
      <div className="slider-header">
        {linkUrl ? (
          <Link href={linkUrl} className="slider-title min-w-0 pr-16">
            <span className="min-w-0 sm:truncate">{title}</span>
            <ArrowRightCircleIcon />
          </Link>
        ) : (
          <div className="slider-title">
            <span>{title}</span>
          </div>
        )}
      </div>
      <Slider
        sliderKey={sliderKey}
        isLoading={!data && !error}
        isEmpty={false}
        items={finalTitles}
      />
    </div>
  );
};

export default MediaSlider;
