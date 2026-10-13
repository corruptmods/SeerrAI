import { AgentForTitle } from '@app/components/Backfill/Agent/parts';
import ApproveModal from '@app/components/Backfill/SeriesReview/ApproveModal';
import CoverageMap from '@app/components/Backfill/SeriesReview/CoverageMap';
import StartSearchModal from '@app/components/Backfill/StartSearchModal';
import {
  JobStatusBadge,
  ProtocolBadge,
  SCROLL_LIST,
  SeriesPoster,
  SeriesStatusBadge,
  TypeBadge,
  appName,
  episodeLabel,
  formatBytes,
} from '@app/components/Backfill/shared';
import type {
  CandidateView,
  SeriesDetail,
} from '@app/components/Backfill/types';
import { ACTIVE_JOB } from '@app/components/Backfill/types';
import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  EyeSlashIcon,
  FilmIcon,
  ForwardIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
import type { AgentOverview } from '@server/interfaces/api/agentInterfaces';
import axios from 'axios';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Backfill.SeriesReview', {
  backfill: 'Backfill',
  profile: 'Profile: {name}',
  episodes: '{count, plural, one {# episode} other {# episodes}}',
  searchAgain: 'Search again',
  searching: 'Searching…',
  ignore: 'Ignore series',
  mediaPage: 'Media page',
  askAgent: 'Get it with AI',
  askAgentFailed: 'The admin agent could not be started.',
  ignoreMovie: 'Ignore movie',
  unignore: 'Stop ignoring',
  openJob: 'Open the running backfill',
  searchingNow:
    'Searching Prowlarr and opening the likeliest packs. This takes a few minutes.',
  lastSearch: 'Backfill last searched {when}.',
  searchError: 'The last search had a problem: {error}',
  arrError: '{app} could not be read: {error}',
  coverage: 'Episodes',
  movieOnDisk: 'On disk',
  movieMissing: 'Radarr has no file for this movie.',
  movieNotOut: 'Radarr does not count this movie as released yet.',
  movieFile: '{quality}, score {score}',
  movieBelowCutoff: 'below the profile’s cutoff',
  why: 'Why {app} missed this',
  whyTitle:
    'The best pack’s title has no episode numbers Sonarr can read, so Sonarr’s own searches never saw it. Backfill matched it by the {count} file names inside.',
  whyMovieTitle:
    'Radarr does not match the best release’s title to this movie, so its own searches passed it over. Backfill matched it by the file inside.',
  whyNone:
    'Nothing on your indexers mentions this title under the names searched: {names}. Add the name release groups use and search again.',
  titleBadge: 'Title',
  whyRejected: '{count} {count, plural, one {pack} other {packs}}: {reason}',
  whyNotSearched: 'Backfill hasn’t searched for this yet.',
  candidates: 'Packs found',
  noCandidates: 'No packs yet.',
  release: 'Release',
  quality: 'Quality',
  score: 'Score',
  size: 'Size',
  seeds: 'Seeds',
  covers: 'Covers',
  verdict: 'Verdict',
  best: 'Best match',
  usable: 'Usable',
  approved: 'Approved',
  skipped: 'Skipped',
  failed: 'Could not be read',
  rejected: 'Not usable',
  dead: 'Download failed',
  showFiles: 'Show files',
  hideFiles: 'Hide files',
  fill: 'Fills',
  upgrade: 'Upgrades',
  skip: 'Skipped',
  reject: 'Rejected',
  plan: 'Plan for the selected pack',
  selectPack: 'Select a usable pack to see what it would do.',
  fillMissing: 'Fill missing',
  upgradeFiles: 'Upgrade files on disk',
  skipFiles: 'Skip (already better, or duplicates)',
  rejectFiles: 'Not usable',
  episodesCount: '{count, plural, one {# episode} other {# episodes}}',
  filesCount: '{count, plural, one {# file} other {# files}}',
  willDelete:
    '{count} existing {count, plural, one {file} other {files}} will be permanently deleted when their replacements import.',
  approve: 'Approve & download…',
  skipPack: 'Skip this pack',
  aiMatched:
    '{count} {count, plural, one {file was} other {files were}} placed by the AI second opinion, not by its name. Check {count, plural, one {it} other {them}} under Show files before approving.',
  aiBadge: 'AI',
  aiWhy: 'AI: {why}',
  matchedHow:
    'Files are matched by the episode number in their names and judged by Sonarr, so the pack’s own season split doesn’t matter.',
  movieMatchedHow:
    'Files are matched by the movie’s name and year and judged by Radarr; from a collection, only this movie is downloaded.',
  movieLabel: 'Movie',
  history: 'Backfills',
  noHistory: 'None yet.',
  imported: '{count} imported',
  actionFailed: 'That did not work.',
});

const verdictOf = (c: CandidateView, bestId?: number) => {
  switch (c.status) {
    case 'ready':
      return c.id === bestId ? 'best' : 'usable';
    default:
      return c.status;
  }
};

const ACTION_STYLE = {
  fill: 'bg-red-500/20 text-red-200',
  upgrade: 'bg-yellow-500/20 text-yellow-200',
  skip: 'bg-gray-600/40 text-gray-300',
  reject: 'bg-gray-700/60 text-gray-400',
} as const;

const SeriesReview = () => {
  const intl = useIntl();
  const router = useRouter();
  const id = Number(router.query.seriesId);
  const [selectedId, setSelectedId] = useState<number>();
  const [expanded, setExpanded] = useState<number>();
  const [approving, setApproving] = useState(false);
  // The pack the Approve dialog was opened for, as it was then.
  const [approveTarget, setApproveTarget] = useState<CandidateView>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [asking, setAsking] = useState(false);
  const { data, error, mutate } = useSWR<SeriesDetail>(
    Number.isInteger(id) && id > 0 ? `/api/v1/backfill/series/${id}` : null,
    {
      refreshInterval: (latest) =>
        latest?.series.status === 'searching' ||
        latest?.jobs.some((j) => ACTIVE_JOB.includes(j.status))
          ? 2000
          : 0,
    }
  );

  // The same answer the agent's section on the page reads.
  const { data: agentData } = useSWR<AgentOverview>(
    data
      ? `/api/v1/agent?kind=${data.series.kind}&serverId=${data.series.serverId}&arrId=${data.series.arrId}`
      : null
  );
  const agentOn = !!agentData && !agentData.problem;

  const ranked = useMemo(
    () =>
      [...(data?.candidates ?? [])]
        .filter((c) => c.status === 'ready' && c.summary)
        .sort(
          (a, b) =>
            (b.summary?.fill ?? 0) - (a.summary?.fill ?? 0) ||
            (b.summary?.upgrade ?? 0) - (a.summary?.upgrade ?? 0) ||
            (b.summary?.score ?? 0) - (a.summary?.score ?? 0) ||
            (b.seeders ?? 0) - (a.seeders ?? 0)
        ),
    [data]
  );
  const bestId = ranked[0]?.id;
  const selected =
    data?.candidates.find((c) => c.id === selectedId && c.status === 'ready') ??
    ranked[0];

  // Keep the pack on show, even when the page refreshes and another ranks
  // above it, so Approve and Skip act on the pack the admin is reading. It
  // changes only when they pick another, or when it stops being usable.
  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  if (error && !data) {
    return (
      <ErrorPage statusCode={error?.response?.status === 404 ? 404 : 500} />
    );
  }
  if (!data) return <LoadingSpinner />;

  const { series, sonarr, movie } = data;
  const app = appName(series.kind);
  const names = sonarr?.names ?? movie?.names;
  const activeJob = data.jobs.find((j) => ACTIVE_JOB.includes(j.status));
  // A series can have more than one download running, for other episodes;
  // a movie only the one.
  const blocked = !!activeJob && series.kind === 'movie';

  const act = async (fn: () => Promise<unknown>) => {
    setProblem(undefined);
    try {
      await fn();
      await mutate();
    } catch (e) {
      setProblem(
        axios.isAxiosError(e) && e.response?.data?.message
          ? String(e.response.data.message)
          : intl.formatMessage(messages.actionFailed)
      );
    }
  };

  const covered = new Set(
    (selected?.plan ?? [])
      .filter((e) => e.action === 'fill' || e.action === 'upgrade')
      .flatMap((e) => e.episodeIds)
  );

  const rejectedReasons = new Map<string, number>();
  for (const c of data.candidates) {
    if (['rejected', 'failed', 'dead'].includes(c.status) && c.reason) {
      rejectedReasons.set(c.reason, (rejectedReasons.get(c.reason) ?? 0) + 1);
    }
  }

  // The dialog's pack as it is now, while it can still be approved.
  const approveCandidate = data.candidates.find(
    (c) => c.id === approveTarget?.id && c.status === 'ready'
  );

  const fileCount = (c: CandidateView) =>
    (c.summary?.fill ?? 0) + (c.summary?.upgrade ?? 0);

  return (
    <>
      <PageTitle
        title={[series.title, intl.formatMessage(messages.backfill)]}
      />
      <div className="mt-6 text-sm text-gray-500">
        <Link href="/backfill" className="hover:text-gray-300">
          {intl.formatMessage(messages.backfill)}
        </Link>{' '}
        · <span className="text-gray-300">{series.title}</span>
      </div>
      <div className="mt-3 flex flex-col gap-5 lg:flex-row lg:items-start">
        <SeriesPoster src={series.poster} title={series.title} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-col justify-between gap-3 xl:flex-row">
            <div>
              <h1 className="text-3xl font-bold text-white">
                {series.title}
                {series.year && !series.title.includes(String(series.year)) && (
                  <span className="font-medium text-gray-400">
                    {' '}
                    ({series.year})
                  </span>
                )}
              </h1>
              <div className="mt-2 flex flex-wrap gap-2">
                <TypeBadge kind={series.kind} seriesType={series.seriesType} />
                <SeriesStatusBadge status={series.status} />
                {(sonarr ?? movie) && (
                  <Badge badgeType="dark">
                    {intl.formatMessage(messages.profile, {
                      name: (sonarr ?? movie)!.profile,
                    })}
                  </Badge>
                )}
                {sonarr && (
                  <Badge badgeType="dark">
                    {intl.formatMessage(messages.episodes, {
                      count: sonarr.coverage.length,
                    })}
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-start gap-2">
              {series.tmdbId && (
                <Link
                  href={`/${series.kind === 'movie' ? 'movie' : 'tv'}/${
                    series.tmdbId
                  }`}
                  passHref
                  legacyBehavior
                >
                  <Button as="a" buttonType="default">
                    <FilmIcon />
                    <span>{intl.formatMessage(messages.mediaPage)}</span>
                  </Button>
                </Link>
              )}
              {agentOn && (
                <Button
                  buttonType="primary"
                  disabled={asking}
                  onClick={async () => {
                    setAsking(true);
                    setProblem(undefined);
                    try {
                      const { data: run } = await axios.post<{ id: number }>(
                        '/api/v1/agent/ask',
                        {
                          title: {
                            kind: series.kind,
                            serverId: series.serverId,
                            arrId: series.arrId,
                          },
                        }
                      );
                      await router.push(`/backfill/agent/${run.id}`);
                    } catch (e) {
                      setProblem(
                        axios.isAxiosError(e) && e.response?.data?.message
                          ? String(e.response.data.message)
                          : intl.formatMessage(messages.askAgentFailed)
                      );
                      setAsking(false);
                    }
                  }}
                >
                  <SparklesIcon />
                  <span>{intl.formatMessage(messages.askAgent)}</span>
                </Button>
              )}
              {activeJob && (
                <Link
                  href={`/backfill/jobs/${activeJob.id}`}
                  passHref
                  legacyBehavior
                >
                  <Button as="a" buttonType="primary">
                    {intl.formatMessage(messages.openJob)}
                  </Button>
                </Link>
              )}
              {!blocked && (
                <Button
                  onClick={() => setSearchOpen(true)}
                  disabled={
                    !data.readiness.ready || series.status === 'searching'
                  }
                >
                  <ArrowPathIcon
                    className={
                      series.status === 'searching' ? 'animate-spin' : undefined
                    }
                  />
                  <span>
                    {intl.formatMessage(
                      series.status === 'searching'
                        ? messages.searching
                        : messages.searchAgain
                    )}
                  </span>
                </Button>
              )}
              <Button
                buttonType="ghost"
                onClick={() =>
                  act(() =>
                    axios.put(`/api/v1/backfill/series/${series.id}`, {
                      ignored: series.status !== 'ignored',
                    })
                  )
                }
              >
                <EyeSlashIcon />
                <span>
                  {intl.formatMessage(
                    series.status === 'ignored'
                      ? messages.unignore
                      : series.kind === 'movie'
                        ? messages.ignoreMovie
                        : messages.ignore
                  )}
                </span>
              </Button>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            {problem && <Alert type="error" title={problem} />}
            {!data.readiness.ready && (
              <Alert type="warning" title={data.readiness.problem} />
            )}
            {data.arrError && (
              <Alert
                type="error"
                title={intl.formatMessage(messages.arrError, {
                  app,
                  error: data.arrError,
                })}
              />
            )}
            {series.status === 'searching' ? (
              <Alert
                type="info"
                title={intl.formatMessage(messages.searchingNow)}
              />
            ) : (
              series.searchError && (
                <Alert
                  type="warning"
                  title={intl.formatMessage(messages.searchError, {
                    error: series.searchError,
                  })}
                />
              )
            )}
            {series.lastSearchedAt && series.status !== 'searching' && (
              <p className="text-sm text-gray-400">
                {intl.formatMessage(messages.lastSearch, {
                  when: (
                    <FormattedRelativeTime
                      value={Math.round(
                        (new Date(series.lastSearchedAt).getTime() -
                          Date.now()) /
                          1000
                      )}
                      updateIntervalInSeconds={60}
                      numeric="auto"
                    />
                  ),
                })}
              </p>
            )}
          </div>
        </div>
      </div>

      <StartSearchModal
        show={searchOpen}
        onClose={() => {
          setSearchOpen(false);
          void mutate();
        }}
        seriesId={series.id}
        knownNames={names?.filter((n) => !series.searchTerms.includes(n))}
        initialTerms={series.searchTerms}
      />
      {approveTarget && (
        <ApproveModal
          show={approving}
          kind={series.kind}
          seriesTitle={series.title}
          candidate={approveCandidate ?? approveTarget}
          unavailable={!approveCandidate}
          onClose={() => setApproving(false)}
          onApproved={(jobId) => router.push(`/backfill/jobs/${jobId}`)}
        />
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_370px]">
        <div className="flex min-w-0 flex-col gap-4">
          {sonarr && (
            <section className="rounded-lg bg-gray-800 ring-1 ring-gray-700">
              <h2 className="border-b border-gray-700 px-5 py-4 text-lg font-semibold text-white">
                {intl.formatMessage(messages.coverage)}
              </h2>
              <div className="p-5">
                <CoverageMap
                  episodes={sonarr.coverage}
                  covered={covered}
                  anime={sonarr.seriesType === 'anime'}
                />
              </div>
            </section>
          )}
          {movie && (
            <section className="rounded-lg bg-gray-800 ring-1 ring-gray-700">
              <h2 className="border-b border-gray-700 px-5 py-4 text-lg font-semibold text-white">
                {intl.formatMessage(messages.movieOnDisk)}
              </h2>
              <p className="p-5 text-sm text-gray-200">
                {movie.file
                  ? [
                      intl.formatMessage(messages.movieFile, {
                        quality: movie.file.quality,
                        score: intl.formatNumber(movie.file.score ?? 0),
                      }),
                      movie.file.belowCutoff
                        ? intl.formatMessage(messages.movieBelowCutoff)
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : intl.formatMessage(
                      movie.available
                        ? messages.movieMissing
                        : messages.movieNotOut
                    )}
              </p>
            </section>
          )}
          <section className="flex-1 rounded-lg bg-gray-800 ring-1 ring-gray-700">
            <h2 className="border-b border-gray-700 px-5 py-4 text-lg font-semibold text-white">
              {intl.formatMessage(messages.why, { app })}
            </h2>
            <ul className="space-y-3 p-5 text-sm text-gray-200">
              {!series.lastSearchedAt && series.status !== 'searching' && (
                <li>{intl.formatMessage(messages.whyNotSearched)}</li>
              )}
              {ranked[0]?.summary?.sonarrSeesTitle === false && (
                <li className="flex items-start gap-3">
                  <Badge badgeType="danger" className="shrink-0">
                    {intl.formatMessage(messages.titleBadge)}
                  </Badge>
                  <span>
                    {series.kind === 'movie'
                      ? intl.formatMessage(messages.whyMovieTitle)
                      : intl.formatMessage(messages.whyTitle, {
                          count: fileCount(ranked[0]),
                        })}
                  </span>
                </li>
              )}
              {[...rejectedReasons.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 4)
                .map(([reason, count]) => (
                  <li key={reason} className="flex items-start gap-3">
                    <Badge badgeType="warning" className="shrink-0">
                      ×{count}
                    </Badge>
                    <span>
                      {intl.formatMessage(messages.whyRejected, {
                        count,
                        reason,
                      })}
                    </span>
                  </li>
                ))}
              {series.lastSearchedAt &&
                !data.candidates.length &&
                series.status !== 'searching' && (
                  <li>
                    {intl.formatMessage(messages.whyNone, {
                      names: [...(names ?? []), ...series.searchTerms]
                        .filter((v, i, a) => a.indexOf(v) === i)
                        .join(', '),
                    })}
                  </li>
                )}
            </ul>
          </section>
        </div>

        <section className="rounded-lg bg-gray-800 ring-1 ring-gray-700">
          <h2 className="border-b border-gray-700 px-5 py-4 text-lg font-semibold text-white">
            {intl.formatMessage(messages.plan)}
          </h2>
          <div className="space-y-4 p-5">
            {!selected?.summary ? (
              <p className="text-sm text-gray-400">
                {intl.formatMessage(messages.selectPack)}
              </p>
            ) : (
              <>
                <div className="break-all text-sm font-semibold text-white">
                  {selected.title}
                </div>
                <div className="flex flex-wrap gap-2">
                  <ProtocolBadge protocol={selected.protocol} />
                  <Badge badgeType="dark">{selected.indexer}</Badge>
                  <Badge badgeType="dark">{formatBytes(selected.size)}</Badge>
                </div>
                <dl className="space-y-2 border-t border-gray-700 pt-4 text-sm">
                  {(
                    [
                      ['fill', messages.fillMissing, 'bg-red-500'],
                      ['upgrade', messages.upgradeFiles, 'bg-yellow-500'],
                      ['skip', messages.skipFiles, 'bg-gray-500'],
                      ['reject', messages.rejectFiles, 'bg-gray-700'],
                    ] as const
                  ).map(([key, label, dot]) => (
                    <div
                      key={key}
                      className="flex items-center justify-between gap-3"
                    >
                      <dt className="flex items-center gap-2 text-gray-300">
                        <span className={`h-3 w-3 rounded-sm ${dot}`} />
                        {intl.formatMessage(label)}
                      </dt>
                      <dd className="whitespace-nowrap font-semibold text-white">
                        {intl.formatMessage(
                          series.kind === 'movie'
                            ? messages.filesCount
                            : messages.episodesCount,
                          { count: selected.summary![key] }
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
                {!!selected.summary.aiMatched && (
                  <Alert
                    type="warning"
                    title={intl.formatMessage(messages.aiMatched, {
                      count: selected.summary.aiMatched,
                    })}
                  />
                )}
                {selected.summary.aiNote && (
                  <p className="text-xs text-gray-500">
                    {selected.summary.aiNote}
                  </p>
                )}
                {selected.summary.replaces > 0 && (
                  <Alert
                    type="error"
                    title={intl.formatMessage(messages.willDelete, {
                      count: selected.summary.replaces,
                    })}
                  />
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    buttonType="success"
                    disabled={blocked || !data.readiness.ready}
                    onClick={() => {
                      setApproveTarget(selected);
                      setApproving(true);
                    }}
                  >
                    <CheckIcon />
                    <span>{intl.formatMessage(messages.approve)}</span>
                  </Button>
                  <Button
                    buttonType="ghost"
                    onClick={() =>
                      act(() =>
                        axios.post(
                          `/api/v1/backfill/candidates/${selected.id}/skip`
                        )
                      )
                    }
                  >
                    <ForwardIcon />
                    <span>{intl.formatMessage(messages.skipPack)}</span>
                  </Button>
                </div>
                <p className="text-xs text-gray-500">
                  {intl.formatMessage(
                    series.kind === 'movie'
                      ? messages.movieMatchedHow
                      : messages.matchedHow
                  )}
                </p>
              </>
            )}
          </div>
        </section>
      </div>

      <AgentForTitle
        card
        autoRanAt={series.agentAutoRunAt}
        title={{
          kind: series.kind,
          serverId: series.serverId,
          arrId: series.arrId,
        }}
      />

      <section className="mt-4 rounded-lg bg-gray-800 ring-1 ring-gray-700">
        <h2 className="border-b border-gray-700 px-5 py-4 text-lg font-semibold text-white">
          {intl.formatMessage(messages.candidates)}
        </h2>
        {!data.candidates.length ? (
          <p className="p-5 text-sm text-gray-400">
            {intl.formatMessage(messages.noCandidates)}
          </p>
        ) : (
          <div className={`overflow-x-auto ${SCROLL_LIST}`}>
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 z-10 bg-gray-900 text-left text-xs uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="w-8 px-4 py-3" />
                  <th className="px-4 py-3">
                    {intl.formatMessage(messages.release)}
                  </th>
                  <th className="px-4 py-3">
                    {intl.formatMessage(messages.quality)}
                  </th>
                  <th className="px-4 py-3">
                    {intl.formatMessage(messages.score)}
                  </th>
                  <th className="px-4 py-3">
                    {intl.formatMessage(messages.size)}
                  </th>
                  <th className="px-4 py-3">
                    {intl.formatMessage(messages.seeds)}
                  </th>
                  <th className="px-4 py-3">
                    {intl.formatMessage(messages.covers)}
                  </th>
                  <th className="px-4 py-3">
                    {intl.formatMessage(messages.verdict)}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {[...data.candidates]
                  .sort(
                    (a, b) =>
                      Number(b.status === 'ready') -
                        Number(a.status === 'ready') ||
                      fileCount(b) - fileCount(a)
                  )
                  .map((c) => {
                    const verdict = verdictOf(c, bestId);
                    const isSelected = selected?.id === c.id;
                    return [
                      <tr
                        key={c.id}
                        className={isSelected ? 'bg-indigo-600/10' : undefined}
                      >
                        <td className="px-4 py-3 align-top">
                          <input
                            type="radio"
                            name="backfill-candidate"
                            aria-label={c.title}
                            disabled={c.status !== 'ready'}
                            checked={isSelected}
                            onChange={() => setSelectedId(c.id)}
                          />
                        </td>
                        <td className="min-w-[16rem] max-w-xl px-4 py-3 align-top">
                          <div className="break-all font-semibold text-white">
                            {c.title}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-400">
                            <ProtocolBadge protocol={c.protocol} />
                            <span>{c.indexer}</span>
                            {c.reason && <span>· {c.reason}</span>}
                            {!!c.plan?.length && (
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300"
                                onClick={() =>
                                  setExpanded(
                                    expanded === c.id ? undefined : c.id
                                  )
                                }
                              >
                                {expanded === c.id ? (
                                  <ChevronUpIcon className="h-3 w-3" />
                                ) : (
                                  <ChevronDownIcon className="h-3 w-3" />
                                )}
                                {intl.formatMessage(
                                  expanded === c.id
                                    ? messages.hideFiles
                                    : messages.showFiles
                                )}
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 align-top text-gray-200">
                          {c.summary?.quality ?? '—'}
                        </td>
                        <td
                          className={`whitespace-nowrap px-4 py-3 align-top font-semibold ${
                            (c.summary?.score ?? 0) > 0
                              ? 'text-green-400'
                              : (c.summary?.score ?? 0) < 0
                                ? 'text-red-400'
                                : 'text-gray-400'
                          }`}
                        >
                          {c.summary
                            ? `${c.summary.score > 0 ? '+' : ''}${intl.formatNumber(c.summary.score)}`
                            : '—'}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 align-top text-gray-300">
                          {formatBytes(c.size)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 align-top text-gray-300">
                          {c.protocol === 'usenet' ? '—' : (c.seeders ?? '—')}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 align-top text-gray-200">
                          {c.summary ? `${c.summary.covered}` : '—'}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 align-top">
                          <Badge
                            badgeType={
                              verdict === 'best'
                                ? 'success'
                                : verdict === 'usable' || verdict === 'approved'
                                  ? 'primary'
                                  : verdict === 'skipped'
                                    ? 'default'
                                    : 'danger'
                            }
                          >
                            {intl.formatMessage(messages[verdict])}
                          </Badge>
                        </td>
                      </tr>,
                      expanded === c.id && (
                        <tr key={`${c.id}-files`}>
                          <td />
                          <td colSpan={7} className="px-4 pb-4">
                            <ul className="max-h-96 divide-y divide-gray-700 overflow-y-auto rounded-md border border-gray-700 bg-gray-900/40">
                              {c.plan!.map((entry) => (
                                <li
                                  key={entry.index}
                                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs"
                                >
                                  <span className="w-28 whitespace-nowrap font-mono text-gray-300">
                                    {episodeLabel(entry) ||
                                      (entry.episodeIds.length &&
                                      series.kind === 'movie'
                                        ? intl.formatMessage(
                                            messages.movieLabel
                                          )
                                        : '—')}
                                  </span>
                                  <span className="min-w-0 flex-1 break-all text-gray-400">
                                    {entry.name}
                                  </span>
                                  <span className="whitespace-nowrap text-gray-300">
                                    {entry.quality}
                                    {entry.version && entry.version > 1
                                      ? ` v${entry.version}`
                                      : ''}{' '}
                                    · {entry.score > 0 ? '+' : ''}
                                    {entry.score}
                                  </span>
                                  {entry.matchedBy === 'ai' && (
                                    <span className="rounded bg-purple-500/20 px-2 py-0.5 text-purple-200">
                                      {intl.formatMessage(messages.aiBadge)}
                                    </span>
                                  )}
                                  <span
                                    className={`rounded px-2 py-0.5 ${ACTION_STYLE[entry.action]}`}
                                  >
                                    {intl.formatMessage(messages[entry.action])}
                                  </span>
                                  {entry.matchedBy === 'ai' && entry.why && (
                                    <span className="basis-full pl-[7.75rem] text-purple-200/80">
                                      {intl.formatMessage(messages.aiWhy, {
                                        why: entry.why,
                                      })}
                                    </span>
                                  )}
                                  {entry.reason && (
                                    <span className="basis-full pl-[7.75rem] text-gray-500">
                                      {entry.reason}
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      ),
                    ];
                  })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-4 rounded-lg bg-gray-800 ring-1 ring-gray-700">
        <h2 className="border-b border-gray-700 px-5 py-4 text-lg font-semibold text-white">
          {intl.formatMessage(messages.history)}
        </h2>
        <ul className={`divide-y divide-gray-700 ${SCROLL_LIST}`}>
          {!data.jobs.length && (
            <li className="px-5 py-4 text-sm text-gray-400">
              {intl.formatMessage(messages.noHistory)}
            </li>
          )}
          {data.jobs.map((job) => (
            <li
              key={job.id}
              className="flex items-center gap-3 px-5 py-3 text-sm"
            >
              <JobStatusBadge
                status={job.status}
                progress={job.progress}
                kind={series.kind}
              />
              <Link
                href={`/backfill/jobs/${job.id}`}
                className="min-w-0 flex-1 truncate text-gray-200 hover:underline"
              >
                {job.title}
              </Link>
              <span className="whitespace-nowrap text-gray-400">
                {intl.formatMessage(messages.imported, { count: job.imported })}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
};

export default SeriesReview;
