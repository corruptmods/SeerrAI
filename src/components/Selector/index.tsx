import CachedImage from '@app/components/Common/CachedImage';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import Tag from '@app/components/Common/Tag';
import Tooltip from '@app/components/Common/Tooltip';
import type {
  ChosenServices,
  ServiceChoice,
} from '@app/components/Discover/filters';
import {
  chooseService,
  nextServiceChoice,
  serviceChoiceOf,
} from '@app/components/Discover/filters';
import RegionSelector from '@app/components/RegionSelector';
import { encodeURIExtraParams } from '@app/hooks/useDiscover';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownIcon, ArrowUpIcon } from '@heroicons/react/20/solid';
import {
  CheckCircleIcon,
  NoSymbolIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import type {
  TmdbCompanySearchResponse,
  TmdbGenre,
  TmdbKeywordSearchResponse,
} from '@server/api/themoviedb/interfaces';
import { readStreamingRow } from '@server/constants/streamingServices';
import type { UserResultsResponse } from '@server/interfaces/api/userInterfaces';
import type {
  Keyword,
  ProductionCompany,
  WatchProviderDetails,
} from '@server/models/common';
import axios from 'axios';
import orderBy from 'lodash/orderBy';
import { useEffect, useId, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import type { MultiValue, SingleValue } from 'react-select';
import AsyncSelect from 'react-select/async';
import useSWR from 'swr';

const messages = defineMessages('components.Selector', {
  searchKeywords: 'Search keywords…',
  searchGenres: 'Select genres…',
  searchStudios: 'Search studios…',
  searchUsers: 'Select users…',
  starttyping: 'Starting typing to search.',
  nooptions: 'No results.',
  showmore: 'Show More',
  showless: 'Show Less',
  searchStatus: 'Select status...',
  returningSeries: 'Returning Series',
  planned: 'Planned',
  inProduction: 'In Production',
  ended: 'Ended',
  canceled: 'Canceled',
  pilot: 'Pilot',
  onServices: 'Only on',
  notOnServices: 'Not on',
  servicesHint:
    'Pick a service once to show only it, twice to leave it out, three times to clear.',
  serviceOn: 'Only on {service}',
  serviceNotOn: 'Not on {service}',
  serviceCleared: 'No longer filtering by {service}',
  clearOn: 'Stop showing only what’s on {service}',
  clearNotOn: 'Stop leaving out {service}',
});

type SingleVal = {
  label: string;
  value: number;
};

type BaseSelectorMultiProps = {
  /** The id of the text box, for a label to point at. */
  inputId?: string;
  defaultValue?: string;
  isMulti: true;
  isDisabled?: boolean;
  onChange: (value: MultiValue<SingleVal> | null) => void;
};

type BaseSelectorSingleProps = {
  /** The id of the text box, for a label to point at. */
  inputId?: string;
  defaultValue?: string;
  isMulti?: false;
  isDisabled?: boolean;
  onChange: (value: SingleValue<SingleVal> | null) => void;
};

export const CompanySelector = ({
  defaultValue,
  isMulti,
  isDisabled,
  onChange,
}: BaseSelectorSingleProps | BaseSelectorMultiProps) => {
  const intl = useIntl();
  const [defaultDataValue, setDefaultDataValue] = useState<
    { label: string; value: number }[] | null
  >(null);

  useEffect(() => {
    const loadDefaultCompany = async (): Promise<void> => {
      if (!defaultValue) {
        return;
      }

      const response = await axios.get<ProductionCompany>(
        `/api/v1/studio/${defaultValue}`
      );

      const studio = response.data;

      setDefaultDataValue([
        {
          label: studio.name ?? '',
          value: studio.id ?? 0,
        },
      ]);
    };

    loadDefaultCompany();
  }, [defaultValue]);

  const loadCompanyOptions = async (inputValue: string) => {
    if (inputValue === '') {
      return [];
    }

    const results = await axios.get<TmdbCompanySearchResponse>(
      '/api/v1/search/company',
      {
        params: {
          query: encodeURIExtraParams(inputValue),
        },
      }
    );

    return results.data.results.map((result) => ({
      label: result.name,
      value: result.id,
    }));
  };

  return (
    <AsyncSelect
      key={`company-selector-${defaultDataValue}`}
      className="react-select-container"
      classNamePrefix="react-select"
      isMulti={isMulti}
      isDisabled={isDisabled}
      defaultValue={defaultDataValue}
      defaultOptions
      cacheOptions
      isClearable
      noOptionsMessage={({ inputValue }) =>
        inputValue === ''
          ? intl.formatMessage(messages.starttyping)
          : intl.formatMessage(messages.nooptions)
      }
      loadOptions={loadCompanyOptions}
      placeholder={intl.formatMessage(messages.searchStudios)}
      onChange={(value) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onChange(value as any);
      }}
    />
  );
};

type GenreSelectorProps = (BaseSelectorMultiProps | BaseSelectorSingleProps) & {
  type: 'movie' | 'tv';
};

export const GenreSelector = ({
  inputId,
  isMulti,
  defaultValue,
  isDisabled,
  onChange,
  type,
}: GenreSelectorProps) => {
  const intl = useIntl();
  const [defaultDataValue, setDefaultDataValue] = useState<
    { label: string; value: number }[] | null
  >(null);

  useEffect(() => {
    const loadDefaultGenre = async (): Promise<void> => {
      if (!defaultValue) {
        return;
      }

      const genres = defaultValue.split(',');

      const response = await axios.get<TmdbGenre[]>(`/api/v1/genres/${type}`);

      const genreData = genres
        .filter((genre) => response.data.find((gd) => gd.id === Number(genre)))
        .map((g) => response.data.find((gd) => gd.id === Number(g)))
        .map((g) => ({
          label: g?.name ?? '',
          value: g?.id ?? 0,
        }));

      setDefaultDataValue(genreData);
    };

    loadDefaultGenre();
  }, [defaultValue, type]);

  const loadGenreOptions = async (inputValue: string) => {
    const results = await axios.get<TmdbGenre[]>(`/api/v1/genres/${type}`);

    return results.data
      .map((result) => ({
        label: result.name,
        value: result.id,
      }))
      .filter(({ label }) =>
        label.toLowerCase().includes(inputValue.toLowerCase())
      );
  };

  return (
    <AsyncSelect
      key={`genre-select-${type}-${defaultDataValue}`}
      inputId={inputId}
      className="react-select-container"
      classNamePrefix="react-select"
      defaultValue={isMulti ? defaultDataValue : defaultDataValue?.[0]}
      defaultOptions
      cacheOptions
      isMulti={isMulti}
      isDisabled={isDisabled}
      loadOptions={loadGenreOptions}
      placeholder={intl.formatMessage(messages.searchGenres)}
      onChange={(value) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onChange(value as any);
      }}
    />
  );
};

export const StatusSelector = ({
  isMulti,
  isDisabled,
  defaultValue,
  onChange,
}: BaseSelectorMultiProps | BaseSelectorSingleProps) => {
  const intl = useIntl();
  const [defaultDataValue, setDefaultDataValue] = useState<
    { label: string; value: number }[] | null
  >(null);

  const options = useMemo(
    () => [
      { name: intl.formatMessage(messages.returningSeries), id: 0 },
      { name: intl.formatMessage(messages.planned), id: 1 },
      { name: intl.formatMessage(messages.inProduction), id: 2 },
      { name: intl.formatMessage(messages.ended), id: 3 },
      { name: intl.formatMessage(messages.canceled), id: 4 },
      { name: intl.formatMessage(messages.pilot), id: 5 },
    ],
    [intl]
  );

  useEffect(() => {
    const loadDefaultStatus = async (): Promise<void> => {
      if (!defaultValue) {
        return;
      }
      const statuses = defaultValue.split('|');

      const statusData = options
        .filter((opt) => statuses.find((s) => Number(s) === opt.id))
        .map((o) => ({
          label: o.name,
          value: o.id,
        }));

      setDefaultDataValue(statusData);
    };

    loadDefaultStatus();
  }, [defaultValue, options]);

  const loadStatusOptions = async () => {
    return options
      .map((result) => ({
        label: result.name,
        value: result.id,
      }))
      .filter(({ label }) => label.toLowerCase());
  };

  return (
    <AsyncSelect
      key={`status-select-${defaultDataValue}`}
      className="react-select-container"
      classNamePrefix="react-select"
      defaultValue={isMulti ? defaultDataValue : defaultDataValue?.[0]}
      defaultOptions
      isMulti={isMulti}
      isDisabled={isDisabled}
      loadOptions={loadStatusOptions}
      placeholder={intl.formatMessage(messages.searchStatus)}
      onChange={(value) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onChange(value as any);
      }}
    />
  );
};

export const KeywordSelector = ({
  inputId = 'data',
  isMulti,
  isDisabled,
  defaultValue,
  onChange,
}: BaseSelectorMultiProps | BaseSelectorSingleProps) => {
  const intl = useIntl();
  const [selectedValue, setSelectedValue] = useState<
    MultiValue<SingleVal> | SingleValue<SingleVal> | null
  >(null);

  useEffect(() => {
    const loadDefaultKeywords = async (): Promise<void> => {
      if (!defaultValue) {
        setSelectedValue(null);
        return;
      }

      const keywords = await Promise.all(
        defaultValue.split(',').map(async (keywordId) => {
          const keyword = await axios.get<Keyword | null>(
            `/api/v1/keyword/${keywordId}`
          );
          return keyword.data;
        })
      );

      const validKeywords: Keyword[] = keywords.filter(
        (keyword): keyword is Keyword => keyword !== null
      );

      const nextValue = validKeywords.map((keyword) => ({
        label: keyword.name,
        value: keyword.id,
      }));

      setSelectedValue(isMulti ? nextValue : (nextValue[0] ?? null));
    };

    loadDefaultKeywords();
  }, [defaultValue, isMulti]);

  const loadKeywordOptions = async (inputValue: string) => {
    const results = await axios.get<TmdbKeywordSearchResponse>(
      '/api/v1/search/keyword',
      {
        params: {
          query: encodeURIExtraParams(inputValue),
        },
      }
    );

    return results.data.results.map((result) => ({
      label: result.name,
      value: result.id,
    }));
  };

  return (
    <AsyncSelect
      inputId={inputId}
      isMulti={isMulti}
      isDisabled={isDisabled}
      className="react-select-container"
      classNamePrefix="react-select"
      noOptionsMessage={({ inputValue }) =>
        inputValue === ''
          ? intl.formatMessage(messages.starttyping)
          : intl.formatMessage(messages.nooptions)
      }
      value={selectedValue}
      loadOptions={loadKeywordOptions}
      placeholder={intl.formatMessage(messages.searchKeywords)}
      onChange={(value) => {
        setSelectedValue(value);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onChange(value as any);
      }}
    />
  );
};

type WatchProviderSelectorProps = {
  type: 'movie' | 'tv';
  region?: string;
  /** Services to show only what is on. */
  activeProviders?: number[];
  /** Services to leave out. */
  excludedProviders?: number[];
  onChange: (region: string, on: number[], notOn: number[]) => void;
};

/*
 * Each service is shown only, left out, or neither: picking it moves it
 * along. The legend says so up front, every tile says which it is (with a
 * mark, not only a colour), and what is chosen is listed above the logos,
 * so a choice in the hidden "Show More" part is never out of sight.
 */
export const WatchProviderSelector = ({
  type,
  onChange,
  region,
  activeProviders,
  excludedProviders,
}: WatchProviderSelectorProps) => {
  const intl = useIntl();
  const hintId = useId();
  const onLabelId = useId();
  const notOnLabelId = useId();
  const { currentSettings } = useSettings();
  const [showMore, setShowMore] = useState(false);
  const [watchRegion, setWatchRegion] = useState(
    region
      ? region
      : currentSettings.discoverRegion
        ? currentSettings.discoverRegion
        : 'US'
  );
  const [services, setServices] = useState<ChosenServices>(() => {
    const on = activeProviders ?? [];
    return {
      on,
      notOn: (excludedProviders ?? []).filter((id) => !on.includes(id)),
    };
  });
  // Said to screen readers after each choice.
  const [announcement, setAnnouncement] = useState('');
  const { data, isLoading } = useSWR<WatchProviderDetails[]>(
    `/api/v1/watchproviders/${
      type === 'movie' ? 'movies' : 'tv'
    }?watchRegion=${watchRegion}`
  );

  useEffect(() => {
    onChange(watchRegion, services.on, services.notOn);
    // removed onChange as a dependency as we only need to call it when the value(s) change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, watchRegion]);

  const orderedData = useMemo(() => {
    if (!data) {
      return [];
    }

    return orderBy(data, ['display_priority'], ['asc']);
  }, [data]);

  const nameOf = (id: number) =>
    orderedData.find((provider) => provider.id === id)?.name ?? `#${id}`;

  const describe = (service: string, choice: ServiceChoice) =>
    choice === 'on'
      ? intl.formatMessage(messages.serviceOn, { service })
      : choice === 'notOn'
        ? intl.formatMessage(messages.serviceNotOn, { service })
        : service;

  const choose = (id: number, choice: ServiceChoice) => {
    setServices((current) => chooseService(current, id, choice));
    setAnnouncement(
      choice
        ? describe(nameOf(id), choice)
        : intl.formatMessage(messages.serviceCleared, { service: nameOf(id) })
    );
  };

  const tile = (provider: WatchProviderDetails) => {
    const choice = serviceChoiceOf(services, provider.id);
    const label = describe(provider.name, choice);

    return (
      <Tooltip content={label} key={`provider-${provider.id}`}>
        <button
          type="button"
          aria-label={label}
          aria-describedby={hintId}
          className={`provider-container relative w-full cursor-pointer rounded-lg transition ${
            choice === 'on'
              ? 'bg-gray-600 ring-2 ring-indigo-500 hover:bg-gray-500'
              : choice === 'notOn'
                ? 'bg-gray-700 ring-2 ring-danger hover:bg-gray-600'
                : 'bg-gray-700 ring-1 ring-gray-500 hover:bg-gray-600'
          }`}
          onClick={() => choose(provider.id, nextServiceChoice(choice))}
        >
          <div
            className={`relative m-2 aspect-1 transition ${
              choice === 'notOn' ? 'opacity-40 grayscale' : ''
            }`}
          >
            <CachedImage
              type="tmdb"
              src={`https://image.tmdb.org/t/p/w154${provider.logoPath}`}
              alt=""
              fill
              className="rounded-lg object-contain"
            />
          </div>
          {choice === 'on' && (
            <div className="pointer-events-none absolute -left-1 -top-1 flex items-center justify-center text-indigo-100 opacity-90 light:text-accent-text light:opacity-100">
              <CheckCircleIcon className="h-6 w-6" />
            </div>
          )}
          {choice === 'notOn' && (
            <div className="pointer-events-none absolute -left-1 -top-1 flex items-center justify-center rounded-full bg-page text-danger-text">
              <NoSymbolIcon className="h-6 w-6" />
            </div>
          )}
        </button>
      </Tooltip>
    );
  };

  const chosen = (choice: 'on' | 'notOn') => {
    const ids = services[choice];
    if (!ids.length || !data) return null;
    const labelId = choice === 'on' ? onLabelId : notOnLabelId;

    return (
      <div
        role="group"
        aria-labelledby={labelId}
        className="flex flex-wrap items-center gap-2"
      >
        <span id={labelId} className="text-sm font-semibold text-default">
          {intl.formatMessage(
            choice === 'on' ? messages.onServices : messages.notOnServices
          )}
        </span>
        {ids.map((id) => (
          <button
            type="button"
            key={`chosen-${choice}-${id}`}
            aria-label={intl.formatMessage(
              choice === 'on' ? messages.clearOn : messages.clearNotOn,
              { service: nameOf(id) }
            )}
            onClick={() => choose(id, undefined)}
            className={`inline-flex min-h-[2rem] items-center gap-1 rounded-full px-3 py-1 text-sm ring-1 ring-inset transition ${
              choice === 'on'
                ? 'bg-accent-chip/accent-fill text-on-accent-chip ring-accent-chip hover:bg-accent-chip'
                : 'bg-danger/20 text-red-200 ring-danger hover:bg-danger/30 light:text-danger-text'
            }`}
          >
            {choice === 'on' ? (
              <CheckCircleIcon className="h-4 w-4 flex-none" />
            ) : (
              <NoSymbolIcon className="h-4 w-4 flex-none" />
            )}
            <span>{nameOf(id)}</span>
            <XMarkIcon className="h-4 w-4 flex-none" />
          </button>
        ))}
      </div>
    );
  };

  const initialProviders = orderedData.slice(0, 24);
  const otherProviders = orderedData.slice(24);

  return (
    <>
      <RegionSelector
        value={watchRegion}
        name="watchRegion"
        onChange={(_name, value) => {
          if (value !== watchRegion) {
            setServices({ on: [], notOn: [] });
          }
          setWatchRegion(value);
        }}
        disableAll
        watchProviders
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
        <span className="inline-flex items-center gap-1">
          <CheckCircleIcon className="h-4 w-4 text-accent-text" />
          {intl.formatMessage(messages.onServices)}
        </span>
        <span className="inline-flex items-center gap-1">
          <NoSymbolIcon className="h-4 w-4 text-danger-text" />
          {intl.formatMessage(messages.notOnServices)}
        </span>
        <span id={hintId}>{intl.formatMessage(messages.servicesHint)}</span>
      </div>
      {chosen('on')}
      {chosen('notOn')}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
      {isLoading ? (
        <SmallLoadingSpinner />
      ) : (
        <div className="grid">
          <div className="provider-icons grid gap-2">
            {initialProviders.map(tile)}
          </div>
          {showMore && otherProviders.length > 0 && (
            <div className="provider-icons relative top-2 grid gap-2">
              {otherProviders.map(tile)}
            </div>
          )}
          {otherProviders.length > 0 && (
            <button
              className="relative top-4 flex items-center justify-center space-x-2 text-sm text-gray-400 transition hover:text-gray-200"
              type="button"
              onClick={() => setShowMore(!showMore)}
            >
              <div className="h-0.5 flex-1 bg-gray-600" />
              {showMore ? (
                <>
                  <ArrowUpIcon className="h-4 w-4" />
                  <span>{intl.formatMessage(messages.showless)}</span>
                  <ArrowUpIcon className="h-4 w-4" />
                </>
              ) : (
                <>
                  <ArrowDownIcon className="h-4 w-4" />
                  <span>{intl.formatMessage(messages.showmore)}</span>
                  <ArrowDownIcon className="h-4 w-4" />
                </>
              )}
              <div className="h-0.5 flex-1 bg-gray-600" />
            </button>
          )}
        </div>
      )}
    </>
  );
};

export const UserSelector = ({
  inputId,
  isMulti,
  isDisabled,
  defaultValue,
  onChange,
}: BaseSelectorMultiProps | BaseSelectorSingleProps) => {
  const intl = useIntl();
  const [defaultDataValue, setDefaultDataValue] = useState<
    { label: string; value: number }[] | null
  >(null);

  useEffect(() => {
    const loadUsers = async (): Promise<void> => {
      if (!defaultValue) {
        return;
      }

      const users = defaultValue.split(',');

      const res = await axios.get(
        `/api/v1/user?includeIds=${encodeURIComponent(defaultValue)}`
      );
      const response: UserResultsResponse = res.data;

      const genreData = users
        .filter((u) => response.results.find((user) => user.id === Number(u)))
        .map((u) => response.results.find((user) => user.id === Number(u)))
        .map((u) => ({
          label: u?.displayName ?? '',
          value: u?.id ?? 0,
        }));

      setDefaultDataValue(genreData);
    };

    loadUsers();
  }, [defaultValue]);

  const loadUserOptions = async (inputValue: string) => {
    const res = await axios.get(
      `/api/v1/user${inputValue ? `?q=${encodeURIComponent(inputValue)}` : ''}`
    );
    const results: UserResultsResponse = res.data;

    return results.results
      .map((result) => ({
        label: result.displayName,
        value: result.id,
      }))
      .filter(({ label }) =>
        label.toLowerCase().includes(inputValue.toLowerCase())
      );
  };

  return (
    <AsyncSelect
      key={`user-select-${defaultDataValue}`}
      inputId={inputId}
      className="react-select-container"
      classNamePrefix="react-select"
      defaultValue={isMulti ? defaultDataValue : defaultDataValue?.[0]}
      defaultOptions
      cacheOptions
      isMulti={isMulti}
      isDisabled={isDisabled}
      loadOptions={loadUserOptions}
      placeholder={intl.formatMessage(messages.searchUsers)}
      onChange={(value) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onChange(value as any);
      }}
    />
  );
};

export { default as USCertificationSelector } from './USCertificationSelector';

/**
 * A streaming services row's services, by name, as its card shows them
 * while Discover is being customized: those shown only and those left out.
 */
export const WatchProviderTags = ({
  type,
  data,
}: {
  type: 'movie' | 'tv';
  data?: string;
}) => {
  const intl = useIntl();
  const { region, on, notOn } = readStreamingRow(data);
  const { data: providers } = useSWR<WatchProviderDetails[]>(
    region && (on.length || notOn.length)
      ? `/api/v1/watchproviders/${
          type === 'movie' ? 'movies' : 'tv'
        }?watchRegion=${region}`
      : null
  );

  if (!providers) {
    return null;
  }

  const nameOf = (id: number) =>
    providers.find((provider) => provider.id === id)?.name ?? `#${id}`;

  return (
    <div className="flex flex-wrap gap-2">
      {on.map((id) => (
        <Tag key={`on-${id}`} iconSvg={<CheckCircleIcon />}>
          {intl.formatMessage(messages.serviceOn, { service: nameOf(id) })}
        </Tag>
      ))}
      {notOn.map((id) => (
        <Tag key={`not-on-${id}`} iconSvg={<NoSymbolIcon />}>
          {intl.formatMessage(messages.serviceNotOn, { service: nameOf(id) })}
        </Tag>
      ))}
    </div>
  );
};
