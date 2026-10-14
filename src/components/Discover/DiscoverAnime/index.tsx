import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import type { AnimeChoice } from '@app/components/Discover/animeChoices';
import {
  ANIME_COUNTRIES,
  animeQuery,
  choiceSeason,
  readAnimeChoice,
  readAnimeCountry,
} from '@app/components/Discover/animeChoices';
import useDiscover from '@app/hooks/useDiscover';
import { useUpdateQueryParams } from '@app/hooks/useUpdateQueryParams';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { CalendarDaysIcon, GlobeAltIcon } from '@heroicons/react/24/solid';
import type { Region } from '@server/lib/settings';
import type { MovieResult, TvResult } from '@server/models/Search';
import type { AnimeSeason } from '@server/utils/animeSeason';
import sortBy from 'lodash/sortBy';
import { useRouter } from 'next/router';
import { useCallback, useMemo } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.DiscoverAnime', {
  anime: 'Anime',
  show: 'Show',
  thisSeason: 'This Season',
  nextSeason: 'Next Season',
  lastSeason: 'Last Season',
  popular: 'Popular Series',
  films: 'Films',
  airingIn: 'Series airing in {season}',
  premieringIn: 'Series premiering in {season}',
  airedIn: 'Series that aired in {season}',
  winter: 'Winter {year}',
  spring: 'Spring {year}',
  summer: 'Summer {year}',
  fall: 'Fall {year}',
  madeIn: 'Made in',
  allCountries: 'All Countries',
  otherCountries: 'Other Countries',
});

const choiceLabels: Record<AnimeChoice, keyof typeof messages> = {
  this: 'thisSeason',
  next: 'nextSeason',
  last: 'lastSeason',
  popular: 'popular',
  films: 'films',
};

const DiscoverAnime = () => {
  const intl = useIntl();
  const router = useRouter();
  const updateQueryParams = useUpdateQueryParams({});

  // Kept in the page address, as the other Discover pages keep theirs, so
  // coming back from a title returns to the same list.
  const choice = readAnimeChoice(router.query.show);
  const country = readAnimeCountry(router.query.country);
  const season = choiceSeason(choice);
  const { data: regions } = useSWR<Region[]>('/api/v1/regions');

  const countryName = useCallback(
    (code: string) =>
      intl.formatDisplayName(code, { type: 'region', fallback: 'none' }) ??
      code,
    [intl]
  );
  // Every other country TMDB knows, after the ones most anime comes from.
  // One chosen in the address is offered even before the list arrives.
  const otherCountries = useMemo(
    () =>
      sortBy(
        [
          ...new Set([
            ...(regions ?? []).map((region) => region.iso_3166_1),
            ...(country ? [country] : []),
          ]),
        ]
          .filter(
            (code) => !(ANIME_COUNTRIES as readonly string[]).includes(code)
          )
          .map((code) => ({ code, name: countryName(code) })),
        'name'
      ),
    [regions, country, countryName]
  );
  const seasonName = (s: AnimeSeason) =>
    intl.formatMessage(messages[s.name], { year: s.year });

  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
  } = useDiscover<MovieResult | TvResult>(
    '/api/v1/discover/anime',
    animeQuery(choice, new Date(), country),
    // Titles from countries an admin leaves out are taken out of the page
    // they arrive in, so a short page is not always the last.
    { shortPages: true }
  );

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  const title = intl.formatMessage(messages.anime);
  const subtext = season
    ? intl.formatMessage(
        choice === 'next'
          ? messages.premieringIn
          : choice === 'last'
            ? messages.airedIn
            : messages.airingIn,
        { season: seasonName(season) }
      )
    : undefined;

  return (
    <>
      <PageTitle title={title} />
      <div className="mb-5 mt-1 flex flex-col justify-between lg:flex-row lg:items-end">
        <Header subtext={subtext}>{title}</Header>
        <div className="mt-2 flex flex-grow flex-col gap-2 sm:flex-row lg:flex-grow-0">
          <div className="flex flex-grow">
            <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-sm text-gray-100">
              <CalendarDaysIcon className="h-6 w-6" />
            </span>
            <select
              id="show"
              name="show"
              aria-label={intl.formatMessage(messages.show)}
              onChange={(e) =>
                updateQueryParams(
                  'show',
                  e.target.value === 'this' ? undefined : e.target.value
                )
              }
              value={choice}
              className="rounded-r-only"
            >
              {(Object.keys(choiceLabels) as AnimeChoice[]).map((option) => (
                <option key={option} value={option}>
                  {intl.formatMessage(messages[choiceLabels[option]])}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-grow">
            <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-sm text-gray-100">
              <GlobeAltIcon className="h-6 w-6" />
            </span>
            <select
              id="country"
              name="country"
              aria-label={intl.formatMessage(messages.madeIn)}
              onChange={(e) =>
                updateQueryParams('country', e.target.value || undefined)
              }
              value={country ?? ''}
              className="rounded-r-only"
            >
              <option value="">
                {intl.formatMessage(messages.allCountries)}
              </option>
              {ANIME_COUNTRIES.map((code) => (
                <option key={code} value={code}>
                  {countryName(code)}
                </option>
              ))}
              {otherCountries.length > 0 && (
                <optgroup label={intl.formatMessage(messages.otherCountries)}>
                  {otherCountries.map(({ code, name }) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
        </div>
      </div>
      <ListView
        items={titles}
        isEmpty={isEmpty}
        isReachingEnd={isReachingEnd}
        isLoading={
          isLoadingInitialData || (isLoadingMore && (titles?.length ?? 0) > 0)
        }
        onScrollBottom={fetchMore}
      />
    </>
  );
};

export default DiscoverAnime;
