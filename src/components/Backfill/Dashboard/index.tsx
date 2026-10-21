import { AgentPanel } from '@app/components/Backfill/Agent/parts';
import DownloadCheckPanel from '@app/components/Backfill/DownloadCheck';
import SearchAllPanel, {
  SearchAllButton,
} from '@app/components/Backfill/SearchAll';
import StartSearchModal from '@app/components/Backfill/StartSearchModal';
import {
  HEADER_BUTTON,
  HEADER_ICON,
  JobStatusBadge,
  ProgressBar,
  SCROLL_LIST,
  SeriesPoster,
  SeriesStatusBadge,
  TypeBadge,
  appName,
  formatBytes,
  formatDuration,
  jobStage,
  useCandidateLine,
} from '@app/components/Backfill/shared';
import type { Overview } from '@app/components/Backfill/types';
import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import useDebouncedState from '@app/hooks/useDebouncedState';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ClockIcon,
  MagnifyingGlassIcon,
  RectangleStackIcon,
  TvIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Backfill.Dashboard', {
  backfill: 'Backfill',
  description:
    'Finds what Sonarr and Radarr can’t, and imports only what you approve.',
  scan: 'Scan now',
  scanning: 'Scanning…',
  startSearch: 'Start search…',
  setUp: 'Set up Backfill',
  stuckSeries: 'Stuck titles',
  stuckHint: 'searched for, never grabbed',
  missing: 'Missing',
  missingHint: 'episodes and movies',
  awaiting: 'Awaiting approval',
  awaitingHint: 'packs found that would help',
  filled: 'Filled this week',
  filledHint: 'files imported',
  activeJobs: 'Running',
  noActiveJobs: 'Nothing is downloading.',
  awaitingApproval: 'Awaiting approval',
  noneAwaiting: 'No packs are waiting for approval.',
  review: 'Review',
  open: 'Open',
  tabActive: 'Stuck',
  tabFound: 'Pack found',
  tabIgnored: 'Ignored',
  tabDone: 'Complete',
  series: 'Title',
  gap: 'Gap',
  status: 'Status',
  missingCount: '{count} missing',
  belowCutoff: '{count} below cutoff',
  movieMissing: 'Missing',
  movieBelowCutoff: 'Below cutoff',
  lastSearch: '{app} last searched {when}',
  neverSearched: '{app} has not searched',
  searchNow: 'Search now',
  searching: 'Searching…',
  emptyActive: 'Nothing is stuck. Scans run every few hours, or use Scan now.',
  emptyOther: 'Nothing here.',
  searchTitles: 'Search titles',
  clearSearch: 'Clear the search',
  noMatch:
    'Nothing on this tab matches “{query}”. Tab counts show where it is.',
  left: '{size} left · {speed}/s',
  eta: '{time} left',
  searchFailed: 'The search could not be started.',
  scanFailed: 'The scan could not be started.',
});

type Filter = 'active' | 'found' | 'ignored' | 'done';
const FILTERS: Filter[] = ['active', 'found', 'ignored', 'done'];

const fromUrl = (value: unknown) => (typeof value === 'string' ? value : '');

const Stat = ({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
  tone: string;
}) => (
  <div className="flex h-full flex-col rounded-lg bg-gray-800 p-5 ring-1 ring-gray-700">
    <div className="flex items-start justify-between gap-3">
      <div className="text-sm font-medium text-gray-400">{label}</div>
      <div className={`rounded-lg p-2 ${tone}`}>{icon}</div>
    </div>
    <div className="mt-2 text-3xl font-bold text-strong">{value}</div>
    <div className="mt-auto truncate pt-1 text-sm text-gray-500">{hint}</div>
  </div>
);

const BackfillDashboard = () => {
  const intl = useIntl();
  const line = useCandidateLine();
  const router = useRouter();
  // The tab and the search live in the address too, so coming back from a
  // title finds the list as it was left.
  const [filter, setFilter] = useState<Filter>(() =>
    FILTERS.includes(router.query.tab as Filter)
      ? (router.query.tab as Filter)
      : 'active'
  );
  const [query, debouncedQuery, setQuery] = useDebouncedState(
    fromUrl(router.query.q)
  );
  const search = debouncedQuery.trim();
  const [starting, setStarting] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [searching, setSearching] = useState<number[]>([]);
  const { data, error, mutate, isLoading } = useSWR<Overview>(
    `/api/v1/backfill?filter=${filter}${
      search ? `&q=${encodeURIComponent(search)}` : ''
    }`,
    {
      // Switching tabs keeps the page in place: emptied while the next tab
      // loads, it would shrink and jump to the top.
      keepPreviousData: true,
      // Live while anything downloads; the server reads the client each time.
      refreshInterval: (latest) =>
        latest?.jobs.some((j) => j.status === 'downloading')
          ? 2000
          : latest?.scanning ||
              latest?.searchAll?.running ||
              latest?.jobs.length ||
              latest?.series.some((s) => s.status === 'searching')
            ? 4000
            : 30000,
    }
  );

  useEffect(() => {
    if (!router.isReady) return;
    const tab = filter === 'active' ? '' : filter;
    if (
      fromUrl(router.query.tab) === tab &&
      fromUrl(router.query.q) === search
    ) {
      return;
    }
    router.replace(
      {
        pathname: router.pathname,
        query: { ...(tab ? { tab } : {}), ...(search ? { q: search } : {}) },
      },
      undefined,
      { shallow: true, scroll: false }
    );
  }, [filter, search, router]);

  if (error && !data) return <ErrorPage statusCode={500} />;

  const scan = async () => {
    setProblem(undefined);
    try {
      await axios.post('/api/v1/backfill/scan');
      await mutate();
    } catch (e) {
      setProblem(
        axios.isAxiosError(e) && e.response?.data?.message
          ? String(e.response.data.message)
          : intl.formatMessage(messages.scanFailed)
      );
    }
  };

  const searchNow = async (id: number) => {
    setProblem(undefined);
    setSearching((s) => [...s, id]);
    try {
      await axios.post(`/api/v1/backfill/series/${id}/search`, {});
      await mutate();
    } catch (e) {
      setProblem(
        axios.isAxiosError(e) && e.response?.data?.message
          ? String(e.response.data.message)
          : intl.formatMessage(messages.searchFailed)
      );
    } finally {
      setSearching((s) => s.filter((x) => x !== id));
    }
  };

  const tabs: { id: Filter; label: string; count?: number }[] = [
    {
      id: 'active',
      label: intl.formatMessage(messages.tabActive),
      count: data?.counts.all,
    },
    {
      id: 'found',
      label: intl.formatMessage(messages.tabFound),
      count: data?.counts.found,
    },
    {
      id: 'ignored',
      label: intl.formatMessage(messages.tabIgnored),
      count: data?.counts.ignored,
    },
    {
      id: 'done',
      label: intl.formatMessage(messages.tabDone),
      count: data?.counts.done,
    },
  ];

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.backfill)} />
      <div className="mb-2 flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <Header subtext={intl.formatMessage(messages.description)}>
          {intl.formatMessage(messages.backfill)}
        </Header>
        {/* One even row at any width: three equal buttons on a phone,
            their names wrapping inside rather than the row wrapping. */}
        <div className="grid grid-cols-3 gap-2 lg:flex lg:flex-none">
          <Button
            buttonType="default"
            onClick={scan}
            disabled={!data?.readiness.ready || data?.scanning}
            className={HEADER_BUTTON}
          >
            <ArrowPathIcon
              className={`${HEADER_ICON} ${data?.scanning ? 'animate-spin' : ''}`}
            />
            <span>
              {intl.formatMessage(
                data?.scanning ? messages.scanning : messages.scan
              )}
            </span>
          </Button>
          <SearchAllButton
            onClick={() => setConfirmingAll(true)}
            disabled={
              !data?.readiness.ready ||
              !!data?.scanning ||
              !!data?.searchAll?.running
            }
          />
          <Button
            buttonType="primary"
            onClick={() => setStarting(true)}
            disabled={!data?.readiness.ready}
            className={HEADER_BUTTON}
          >
            <MagnifyingGlassIcon className={HEADER_ICON} />
            <span>{intl.formatMessage(messages.startSearch)}</span>
          </Button>
        </div>
      </div>
      <StartSearchModal show={starting} onClose={() => setStarting(false)} />

      {!data ? (
        <LoadingSpinner />
      ) : (
        <div className="mt-6 space-y-6">
          {!data.readiness.ready && (
            <Alert type="warning" title={data.readiness.problem}>
              <Link
                href="/settings/backfill"
                className="font-semibold text-yellow-100 underline light:text-warning-text"
              >
                {intl.formatMessage(messages.setUp)}
              </Link>
            </Alert>
          )}
          {problem && <Alert type="error" title={problem} />}
          {data.searchAll && (
            <SearchAllPanel
              status={data.searchAll}
              confirming={confirmingAll}
              onCancel={() => setConfirmingAll(false)}
              onChanged={() => mutate()}
            />
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label={intl.formatMessage(messages.stuckSeries)}
              value={intl.formatNumber(data.stats.stuck)}
              hint={intl.formatMessage(messages.stuckHint)}
              icon={<RectangleStackIcon className="h-5 w-5" />}
              tone="bg-yellow-500/15 text-yellow-400 light:text-warning-text"
            />
            <Stat
              label={intl.formatMessage(messages.missing)}
              value={intl.formatNumber(data.stats.missing)}
              hint={intl.formatMessage(messages.missingHint)}
              icon={<TvIcon className="h-5 w-5" />}
              tone="bg-red-500/15 text-red-400 light:text-danger-text"
            />
            <Stat
              label={intl.formatMessage(messages.awaiting)}
              value={intl.formatNumber(data.stats.awaiting)}
              hint={intl.formatMessage(messages.awaitingHint)}
              icon={<ClockIcon className="h-5 w-5" />}
              tone="bg-indigo-500/15 text-indigo-300 light:text-accent-text"
            />
            <Stat
              label={intl.formatMessage(messages.filled)}
              value={intl.formatNumber(data.stats.filledThisWeek)}
              hint={
                data.stats.filledTitles.join(', ') ||
                intl.formatMessage(messages.filledHint)
              }
              icon={<CheckCircleIcon className="h-5 w-5" />}
              tone="bg-green-500/15 text-success-text"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section className="rounded-lg bg-gray-800 ring-1 ring-gray-700">
              <h3 className="border-b border-gray-700 px-5 py-4 text-lg font-semibold text-strong">
                {intl.formatMessage(messages.activeJobs)}
              </h3>
              <div className={`space-y-2 p-4 ${SCROLL_LIST}`}>
                {!data.jobs.length && (
                  <p className="text-sm text-gray-400">
                    {intl.formatMessage(messages.noActiveJobs)}
                  </p>
                )}
                {data.jobs.map((job) => (
                  <Link
                    key={job.id}
                    href={`/backfill/jobs/${job.id}`}
                    className="-mx-2 flex gap-3 rounded-md px-2 py-1.5 hover:bg-gray-700/40"
                  >
                    <SeriesPoster
                      src={job.series?.poster}
                      title={job.series?.title ?? job.title}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="truncate font-semibold text-strong">
                          {job.series?.title}
                        </div>
                        <JobStatusBadge
                          status={job.status}
                          progress={job.progress}
                          kind={job.series?.kind}
                        />
                      </div>
                      <div className="mt-0.5 truncate text-xs text-gray-400">
                        {job.title}
                      </div>
                      {job.stage && (
                        <div className="truncate text-xs text-gray-500">
                          {jobStage(intl, job)}
                        </div>
                      )}
                      <div className="mt-2 flex justify-between text-xs text-gray-300">
                        <span>
                          {intl.formatMessage(messages.left, {
                            size: formatBytes(job.sizeLeft),
                            speed: formatBytes(job.speed),
                          })}
                        </span>
                        <span>
                          {job.secondsLeft
                            ? intl.formatMessage(messages.eta, {
                                time: formatDuration(intl, job.secondsLeft),
                              })
                            : `${job.progress}%`}
                        </span>
                      </div>
                      <div className="mt-1.5">
                        <ProgressBar value={job.progress} />
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </section>

            <section className="rounded-lg bg-gray-800 ring-1 ring-gray-700">
              <h3 className="border-b border-gray-700 px-5 py-4 text-lg font-semibold text-strong">
                {intl.formatMessage(messages.awaitingApproval)}
              </h3>
              <ul className={`space-y-4 p-5 ${SCROLL_LIST}`}>
                {!data.awaiting.length && (
                  <li className="text-sm text-gray-400">
                    {intl.formatMessage(messages.noneAwaiting)}
                  </li>
                )}
                {data.awaiting.map((c) => (
                  <li key={c.id} className="flex items-center gap-3">
                    <SeriesPoster
                      src={c.series?.poster}
                      title={c.series?.title ?? c.title}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold text-strong">
                        {c.series?.title}
                      </div>
                      <div className="truncate text-xs text-gray-400">
                        {[c.summary?.quality, line(c, c.series?.kind)]
                          .filter(Boolean)
                          .join(' · ')}
                        {c.summary
                          ? ` · ${c.summary.score > 0 ? '+' : ''}${intl.formatNumber(c.summary.score)}`
                          : ''}
                      </div>
                    </div>
                    <Link
                      href={`/backfill/series/${c.seriesId}`}
                      passHref
                      legacyBehavior
                    >
                      <Button buttonType="primary" buttonSize="sm" as="a">
                        {intl.formatMessage(messages.review)}
                      </Button>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <AgentPanel />

          <DownloadCheckPanel />

          <section className="rounded-lg bg-gray-800 ring-1 ring-gray-700">
            <div className="border-b border-gray-700 p-3">
              <div className="relative">
                <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setQuery('');
                  }}
                  placeholder={intl.formatMessage(messages.searchTitles)}
                  aria-label={intl.formatMessage(messages.searchTitles)}
                  autoComplete="off"
                  maxLength={100}
                  className="block w-full rounded-md border border-gray-600 bg-gray-900/60 py-2 pl-10 pr-10 text-sm text-strong placeholder-gray-400 hover:border-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-0"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-strong"
                    aria-label={intl.formatMessage(messages.clearSearch)}
                  >
                    <XMarkIcon className="h-5 w-5" />
                  </button>
                )}
              </div>
            </div>
            {/* One even row at any width: the count goes under the name on
                a phone, beside it on wider screens. */}
            <div
              className="grid grid-cols-4 border-b border-gray-700"
              role="tablist"
            >
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === tab.id}
                  onClick={() => setFilter(tab.id)}
                  className={`-mb-px flex min-w-0 flex-col items-center justify-center gap-1 border-b-2 px-1 py-3 text-xs font-medium sm:flex-row sm:gap-2 sm:text-sm ${
                    filter === tab.id
                      ? 'border-indigo-500 text-strong'
                      : 'border-transparent text-gray-400 hover:text-gray-200'
                  }`}
                >
                  <span className="whitespace-nowrap">{tab.label}</span>
                  {tab.count !== undefined && (
                    <span className="rounded-full bg-gray-700 px-2 py-0.5 text-xs tabular-nums text-gray-200">
                      {tab.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <ul
              className={`divide-y divide-gray-700 transition-opacity ${SCROLL_LIST} ${
                isLoading ? 'opacity-50' : ''
              }`}
              aria-busy={isLoading}
            >
              {!data.series.length && (
                <li className="px-5 py-6 text-sm text-gray-400">
                  {search
                    ? intl.formatMessage(messages.noMatch, { query: search })
                    : intl.formatMessage(
                        filter === 'active'
                          ? messages.emptyActive
                          : messages.emptyOther
                      )}
                </li>
              )}
              {data.series.map((row) => {
                const busy =
                  row.status === 'searching' || searching.includes(row.id);
                return (
                  <li
                    key={row.id}
                    className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <SeriesPoster src={row.poster} title={row.title} />
                      <div className="min-w-0">
                        <Link
                          href={`/backfill/series/${row.id}`}
                          className="block truncate font-semibold text-strong hover:underline"
                        >
                          {row.title}
                        </Link>
                        <div className="truncate text-xs text-gray-500">
                          {row.lastArrSearchAt
                            ? intl.formatMessage(messages.lastSearch, {
                                app: appName(row.kind),
                                when: (
                                  <FormattedRelativeTime
                                    value={Math.round(
                                      (new Date(row.lastArrSearchAt).getTime() -
                                        Date.now()) /
                                        1000
                                    )}
                                    updateIntervalInSeconds={60}
                                    numeric="auto"
                                  />
                                ),
                              })
                            : intl.formatMessage(messages.neverSearched, {
                                app: appName(row.kind),
                              })}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:w-[46%] sm:flex-nowrap">
                      <TypeBadge kind={row.kind} seriesType={row.seriesType} />
                      <span className="whitespace-nowrap text-sm text-gray-300">
                        {row.kind === 'movie'
                          ? intl.formatMessage(
                              row.missing
                                ? messages.movieMissing
                                : messages.movieBelowCutoff
                            )
                          : [
                              row.missing
                                ? intl.formatMessage(messages.missingCount, {
                                    count: row.missing,
                                  })
                                : '',
                              row.belowCutoff
                                ? intl.formatMessage(messages.belowCutoff, {
                                    count: row.belowCutoff,
                                  })
                                : '',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                      </span>
                      <span className="ml-auto">
                        {row.job ? (
                          <span className="inline-flex items-center gap-2">
                            <JobStatusBadge
                              status={row.job.status}
                              progress={row.job.progress}
                              kind={row.kind}
                            />
                            <span className="text-xs text-gray-400">
                              {row.job.progress}%
                            </span>
                          </span>
                        ) : (
                          <SeriesStatusBadge
                            status={busy ? 'searching' : row.status}
                          />
                        )}
                      </span>
                      <span className="flex-shrink-0">
                        {row.job ? (
                          <Link
                            href={`/backfill/jobs/${row.job.id}`}
                            passHref
                            legacyBehavior
                          >
                            <Button buttonSize="sm" as="a">
                              {intl.formatMessage(messages.open)}
                            </Button>
                          </Link>
                        ) : row.readyCount ? (
                          <Link
                            href={`/backfill/series/${row.id}`}
                            passHref
                            legacyBehavior
                          >
                            <Button buttonType="primary" buttonSize="sm" as="a">
                              {intl.formatMessage(messages.review)}
                            </Button>
                          </Link>
                        ) : (
                          <Button
                            buttonSize="sm"
                            disabled={busy || !data.readiness.ready}
                            onClick={() => searchNow(row.id)}
                          >
                            <MagnifyingGlassIcon />
                            <span>
                              {intl.formatMessage(
                                busy ? messages.searching : messages.searchNow
                              )}
                            </span>
                          </Button>
                        )}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      )}
    </>
  );
};

export default BackfillDashboard;
