import {
  leftOutServices,
  readServiceIds,
} from '@server/constants/streamingServices';
import type { ParsedUrlQuery } from 'querystring';

/*
 * Discover filters read from the URL. Kept out of constants.ts (imported by
 * every slider) and free of a schema library, since every field is an
 * optional string and these pages are the most opened.
 */

const TEXT_FILTERS = [
  'sortBy',
  'primaryReleaseDateGte',
  'primaryReleaseDateLte',
  'firstAirDateGte',
  'firstAirDateLte',
  'studio',
  'genre',
  'keywords',
  'excludeKeywords',
  'language',
  'withRuntimeGte',
  'withRuntimeLte',
  'voteAverageGte',
  'voteAverageLte',
  'voteCountLte',
  'voteCountGte',
  'watchRegion',
  'watchProviders',
  'excludeWatchProviders',
  'status',
  'certification',
  'certificationGte',
  'certificationLte',
  'certificationCountry',
] as const;

export type FilterOptions = {
  [K in (typeof TEXT_FILTERS)[number]]?: string;
} & { certificationMode?: 'exact' | 'range' };

/** A URL filter value; a repeated parameter uses its first value. */
const textOf = (value: string | string[] | undefined): string | undefined => {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : undefined;
};

export const prepareFilterValues = (
  inputValues: ParsedUrlQuery
): FilterOptions => {
  const filterValues: FilterOptions = {};

  const values: FilterOptions = {};
  for (const name of TEXT_FILTERS) {
    values[name] = textOf(inputValues[name]);
  }
  const mode = textOf(inputValues.certificationMode);
  if (mode === 'exact' || mode === 'range') {
    values.certificationMode = mode;
  }

  if (values.sortBy) {
    filterValues.sortBy = values.sortBy;
  }

  if (values.primaryReleaseDateGte) {
    filterValues.primaryReleaseDateGte = values.primaryReleaseDateGte;
  }

  if (values.primaryReleaseDateLte) {
    filterValues.primaryReleaseDateLte = values.primaryReleaseDateLte;
  }

  if (values.firstAirDateGte) {
    filterValues.firstAirDateGte = values.firstAirDateGte;
  }

  if (values.firstAirDateLte) {
    filterValues.firstAirDateLte = values.firstAirDateLte;
  }

  if (values.studio) {
    filterValues.studio = values.studio;
  }

  if (values.genre) {
    filterValues.genre = values.genre;
  }

  if (values.status) {
    filterValues.status = values.status;
  }

  if (values.keywords) {
    filterValues.keywords = values.keywords;
  }

  if (values.excludeKeywords) {
    filterValues.excludeKeywords = values.excludeKeywords;
  }

  if (values.language) {
    filterValues.language = values.language;
  }

  if (values.withRuntimeGte) {
    filterValues.withRuntimeGte = values.withRuntimeGte;
  }

  if (values.withRuntimeLte) {
    filterValues.withRuntimeLte = values.withRuntimeLte;
  }

  if (values.voteAverageGte) {
    filterValues.voteAverageGte = values.voteAverageGte;
  }

  if (values.voteAverageLte) {
    filterValues.voteAverageLte = values.voteAverageLte;
  }

  if (values.voteCountGte) {
    filterValues.voteCountGte = values.voteCountGte;
  }

  if (values.voteCountLte) {
    filterValues.voteCountLte = values.voteCountLte;
  }

  if (values.watchProviders) {
    filterValues.watchProviders = values.watchProviders;
  }

  // Drop invalid or also-included IDs so a mistyped link still opens.
  const leftOut = leftOutServices(
    values.watchProviders,
    values.excludeWatchProviders
  );
  if (leftOut.length) {
    filterValues.excludeWatchProviders = leftOut.join('|');
  }

  if (values.watchRegion) {
    filterValues.watchRegion = values.watchRegion;
  }

  if (values.certification) {
    filterValues.certification = values.certification;
  }

  if (values.certificationGte) {
    filterValues.certificationGte = values.certificationGte;
  }

  if (values.certificationLte) {
    filterValues.certificationLte = values.certificationLte;
  }

  if (values.certificationCountry) {
    filterValues.certificationCountry = values.certificationCountry;
  }

  if (values.certificationMode) {
    filterValues.certificationMode = values.certificationMode;
  } else if (values.certification) {
    filterValues.certificationMode = 'exact';
  } else if (values.certificationGte || values.certificationLte) {
    filterValues.certificationMode = 'range';
  }

  return filterValues;
};

export const countActiveFilters = (filterValues: FilterOptions): number => {
  let totalCount = 0;
  const clonedFilters = Object.assign({}, filterValues);

  if (clonedFilters.voteAverageGte || filterValues.voteAverageLte) {
    totalCount += 1;
    delete clonedFilters.voteAverageGte;
    delete clonedFilters.voteAverageLte;
  }

  if (clonedFilters.voteCountGte || filterValues.voteCountLte) {
    totalCount += 1;
    delete clonedFilters.voteCountGte;
    delete clonedFilters.voteCountLte;
  }

  if (clonedFilters.withRuntimeGte || filterValues.withRuntimeLte) {
    totalCount += 1;
    delete clonedFilters.withRuntimeGte;
    delete clonedFilters.withRuntimeLte;
  }

  // The region belongs to the service filters, not a filter of its own.
  delete clonedFilters.watchRegion;

  if (
    clonedFilters.certification ||
    clonedFilters.certificationGte ||
    clonedFilters.certificationLte ||
    clonedFilters.certificationCountry
  ) {
    totalCount += 1;
    delete clonedFilters.certification;
    delete clonedFilters.certificationGte;
    delete clonedFilters.certificationLte;
    delete clonedFilters.certificationCountry;
  }

  delete clonedFilters.certificationMode;
  totalCount += Object.keys(clonedFilters).length;

  return totalCount;
};

/* Streaming services: each is included, excluded or neither; a click cycles. */

export type ServiceChoice = 'on' | 'notOn' | undefined;

export interface ChosenServices {
  on: number[];
  notOn: number[];
}

export const servicesOf = (filters: FilterOptions): ChosenServices => ({
  on: readServiceIds(filters.watchProviders),
  notOn: leftOutServices(filters.watchProviders, filters.excludeWatchProviders),
});

export const serviceChoiceOf = (
  services: ChosenServices,
  id: number
): ServiceChoice =>
  services.on.includes(id)
    ? 'on'
    : services.notOn.includes(id)
      ? 'notOn'
      : undefined;

/** Cycles included → excluded → neither. */
export const nextServiceChoice = (choice: ServiceChoice): ServiceChoice =>
  choice === undefined ? 'on' : choice === 'on' ? 'notOn' : undefined;

export const chooseService = (
  services: ChosenServices,
  id: number,
  choice: ServiceChoice
): ChosenServices => {
  const on = services.on.filter((other) => other !== id);
  const notOn = services.notOn.filter((other) => other !== id);
  if (choice === 'on') on.push(id);
  if (choice === 'notOn') notOn.push(id);
  return { on, notOn };
};

/** URL service filters; the region is dropped when no service is chosen. */
export const serviceFilters = (
  region: string,
  { on, notOn }: ChosenServices
): Pick<
  FilterOptions,
  'watchRegion' | 'watchProviders' | 'excludeWatchProviders'
> => ({
  watchRegion: on.length || notOn.length ? region : undefined,
  watchProviders: on.length ? on.join('|') : undefined,
  excludeWatchProviders: notOn.length ? notOn.join('|') : undefined,
});
