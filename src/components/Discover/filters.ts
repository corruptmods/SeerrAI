import type { ParsedUrlQuery } from 'querystring';

/*
 * The Discover filters, read from the address. Kept apart from constants.ts,
 * which every Discover slider imports, and read without a schema library:
 * every field is an optional string, which needs no more than the check
 * below, and the filtered pages are the ones opened most.
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
  'status',
  'certification',
  'certificationGte',
  'certificationLte',
  'certificationCountry',
] as const;

export type FilterOptions = {
  [K in (typeof TEXT_FILTERS)[number]]?: string;
} & { certificationMode?: 'exact' | 'range' };

/**
 * A filter's value from the address. A parameter given twice arrives as a
 * list; the first is used rather than the page failing.
 */
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

  if (clonedFilters.watchProviders) {
    totalCount += 1;
    delete clonedFilters.watchProviders;
    delete clonedFilters.watchRegion;
  }

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
