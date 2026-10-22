import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import ContainerResources from '@app/components/Settings/SettingsHealth/ContainerResources';
import { itemKeys } from '@app/components/Settings/SettingsHealth/itemKeys';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  Disclosure,
  DisclosureButton,
  DisclosurePanel,
} from '@headlessui/react';
import {
  ArrowPathIcon,
  ChevronDownIcon,
  MagnifyingGlassIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import type { HealthCheck, HealthItem, HealthStatus } from '@server/lib/health';
import type { HealthActivity } from '@server/lib/healthActivity';
import axios from 'axios';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsHealth', {
  health: 'Health',
  healthDescription:
    'Whether connected services answer, and what has quietly gone wrong.',
  checkAgain: 'Check Again',
  checking: 'Checking…',
  checkedAt: 'Checked {time}',
  allClear: 'All clear',
  problems:
    '{count, plural, one {# thing needs} other {# things need}} attention',
  services: 'Services',
  noServices: 'No services are connected yet.',
  requests: 'Requests',
  media: 'Titles',
  users: 'Users',
  none: 'None',
  failedRequests: 'Failed requests',
  neverSent: 'Approved but never sent to Radarr or Sonarr',
  unlinkedRequests: 'Requests no longer linked to a title',
  removeUnlinked:
    'Remove {count, plural, one {this request} other {these # requests}}',
  removedUnlinked:
    'Removed {count, plural, one {# request} other {# requests}} no longer linked to a title.',
  removeFailed: 'Could not remove the requests.',
  searchNow: 'Search now',
  searching: 'Searching…',
  searchDone: 'Search started',
  searchStarted:
    '{count, plural, one {Searching for # missing episode} other {Searching for # missing episodes}} in {service}.',
  searchStartedMovie: 'Searching for it in {service}.',
  searchStartedAlbums:
    '{count, plural, one {Searching for # missing album} other {Searching for # missing albums}} in {service}.',
  searchFailed: 'Could not start the search.',
  pageOf: 'Page {page} of {pages}',
  previous: 'Prev',
  next: 'Next',
  searchAll: 'Search all',
  searchAllConfirm: 'Search all now',
  searchAllExplain:
    'Searches every stuck title Radarr or Sonarr can act on, not just those shown. Many indexers cap daily searches.',
  searchAllStarted:
    'Searching for {titles, plural, one {# title} other {# titles}} ({episodes, plural, one {# episode or film} other {# episodes and films}}).',
  searchAllStartedWithFailures:
    'Searching for {titles, plural, one {# title} other {# titles}}; {failed, plural, one {# could not be started} other {# could not be started}}.',
  awaitingApproval: 'Waiting on approval for over a week',
  stuckProcessing: 'Processing for over a week',
  musicNotOnServer: 'Albums in Lidarr, not on your media server after a day',
  musicNoRelease: 'Requested albums with no release found after a week',
  missingTvdb: 'Requested series with no TVDB id',
  collectionGaps: 'Collections partly in your library',
  plexMatches: 'Folders matched to another title',
  recentRequests: 'Recent requests',
  nightlyCheck: 'Nightly check',
  foundAt: 'Found {time}',
  checkOnImport: 'Check new requests as they’re imported',
  checkOnImportTip:
    'Looks a few minutes after each import and tells admins once (Wrong Match notification).',
  settingFailed: 'Could not save the setting.',
  plexSignIn: 'Expired Plex sign-ins',
  backfill: 'Backfill',
  backfillSearchErrors: 'Titles Backfill could not search',
  backfillAwaiting: 'Packs waiting for approval',
  backfillFailed: 'Downloads that failed this week',
  downloadCheckWaiting: 'Download Check findings waiting for you',
  agentWaiting: 'Admin agent conversations waiting for you',
  thisWeek: 'This week',
  weekDownloadCheck:
    'Download Check: {rejected} rejected, {imported} imported, {cleared} cleared',
  weekDownloadCheckReport:
    'Download Check (Report only): would have acted on {count, plural, one {# download} other {# downloads}}',
  weekFailed: '{count} could not be done',
  weekAgent:
    'Admin agent: {conversations, plural, one {# conversation} other {# conversations}}, {downloads, plural, one {# download} other {# downloads}} started ({imported} imported, {failed} failed)',
  weekAgentChanges: '{count, plural, one {# change} other {# changes}} made',
  unreachable: 'Not answering',
  issues: '{count, plural, one {# issue} other {# issues}}',
  statusOk: 'OK',
  statusWarning: 'Needs attention',
  statusError: 'Problem',
});

interface HealthResponse {
  checkedAt: string;
  checks: HealthCheck[];
  activity?: HealthActivity;
}

const PAGE_SIZE = 10;

const DOT: Record<HealthStatus, string> = {
  ok: 'bg-green-500',
  warning: 'bg-yellow-500',
  error: 'bg-red-500',
};

const StatusDot = ({ status }: { status: HealthStatus }) => {
  const intl = useIntl();
  const label = {
    ok: messages.statusOk,
    warning: messages.statusWarning,
    error: messages.statusError,
  }[status];

  return (
    <span
      className={`h-2.5 w-2.5 flex-none rounded-full ${DOT[status]}`}
      role="img"
      aria-label={intl.formatMessage(label)}
    />
  );
};

/**
 * Asks Radarr, Sonarr or Lidarr to search now for what the title is
 * missing. After one press it says what was asked for and stays done, so
 * it is not sent again by a second tap.
 */
const SearchButton = ({
  mediaId,
  is4k,
  mediaType,
}: {
  mediaId: number;
  is4k: boolean;
  mediaType: string;
}) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');

  return (
    <Button
      buttonType="ghost"
      buttonSize="sm"
      className="mt-2"
      disabled={state !== 'idle'}
      onClick={async () => {
        setState('busy');
        try {
          const { data } = await axios.post<{
            service: string;
            searched: number;
          }>(`/api/v1/media/${mediaId}/search-missing`, { is4k });
          setState('done');
          addToast(
            mediaType === 'movie'
              ? intl.formatMessage(messages.searchStartedMovie, {
                  service: data.service,
                })
              : intl.formatMessage(
                  mediaType === 'music'
                    ? messages.searchStartedAlbums
                    : messages.searchStarted,
                  { count: data.searched, service: data.service }
                ),
            { appearance: 'success', autoDismiss: true }
          );
        } catch (e) {
          setState('idle');
          addToast(
            e?.response?.data?.message ??
              intl.formatMessage(messages.searchFailed),
            { appearance: 'error', autoDismiss: true }
          );
        }
      }}
    >
      <MagnifyingGlassIcon />
      <span>
        {intl.formatMessage(
          state === 'done'
            ? messages.searchDone
            : state === 'busy'
              ? messages.searching
              : messages.searchNow
        )}
      </span>
    </Button>
  );
};

/**
 * Searches for every stuck title Radarr or Sonarr can act on — not just the
 * ones on screen. Confirmed first, saying what it costs: each search is a
 * query to the indexers, which often cap queries a day.
 */
const SearchAll = ({ onDone }: { onDone: () => void }) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [state, setState] = useState<'idle' | 'confirming' | 'busy'>('idle');

  if (state === 'idle') {
    return (
      <div className="py-2">
        <Button
          buttonType="primary"
          buttonSize="sm"
          className="w-full sm:w-auto"
          onClick={() => setState('confirming')}
        >
          <MagnifyingGlassIcon />
          <span>{intl.formatMessage(messages.searchAll)}</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-md border border-gray-700 bg-gray-800 p-3">
      <p className="text-sm text-gray-300">
        {intl.formatMessage(messages.searchAllExplain)}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          buttonType="primary"
          buttonSize="sm"
          disabled={state === 'busy'}
          onClick={async () => {
            setState('busy');
            try {
              const { data } = await axios.post<{
                titles: number;
                episodes: number;
                failed: number;
              }>('/api/v1/settings/health/search-all-missing');
              addToast(
                intl.formatMessage(
                  data.failed
                    ? messages.searchAllStartedWithFailures
                    : messages.searchAllStarted,
                  {
                    titles: data.titles,
                    episodes: data.episodes,
                    failed: data.failed,
                  }
                ),
                {
                  appearance: data.failed ? 'warning' : 'success',
                  autoDismiss: true,
                }
              );
              onDone();
            } catch {
              addToast(intl.formatMessage(messages.searchFailed), {
                appearance: 'error',
                autoDismiss: true,
              });
            } finally {
              setState('idle');
            }
          }}
        >
          <MagnifyingGlassIcon />
          <span>
            {intl.formatMessage(
              state === 'busy' ? messages.searching : messages.searchAllConfirm
            )}
          </span>
        </Button>
        <Button
          buttonType="ghost"
          buttonSize="sm"
          disabled={state === 'busy'}
          onClick={() => setState('idle')}
        >
          {intl.formatMessage(globalMessages.cancel)}
        </Button>
      </div>
    </div>
  );
};

/**
 * Match Check's one setting: whether titles just requested and imported
 * are looked at as they arrive, as well as nightly.
 */
const MatchOnImport = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, mutate } = useSWR<{ matchCheckOnImport?: boolean }>(
    '/api/v1/settings/main',
    { revalidateOnFocus: false }
  );
  const [saving, setSaving] = useState(false);
  const on = data?.matchCheckOnImport !== false;

  return (
    <div className="flex items-start gap-3 border-b border-gray-700 py-2">
      <input
        type="checkbox"
        id="matchCheckOnImport"
        className="mt-0.5 flex-none"
        checked={on}
        disabled={!data || saving}
        onChange={async (e) => {
          const matchCheckOnImport = e.target.checked;
          setSaving(true);
          try {
            await axios.post('/api/v1/settings/main', { matchCheckOnImport });
            await mutate({ ...data, matchCheckOnImport }, false);
          } catch {
            addToast(intl.formatMessage(messages.settingFailed), {
              appearance: 'error',
              autoDismiss: true,
            });
          } finally {
            setSaving(false);
          }
        }}
      />
      <label htmlFor="matchCheckOnImport" className="min-w-0 text-sm">
        <span className="text-gray-100">
          {intl.formatMessage(messages.checkOnImport)}
        </span>
        <span className="block text-xs text-gray-400">
          {intl.formatMessage(messages.checkOnImportTip)}
        </span>
      </label>
    </div>
  );
};

/** One finding: its title (a link when it has a page) and its detail. */
const ItemText = ({ item }: { item: HealthItem }) => (
  <>
    {item.href ? (
      <Link
        href={item.href}
        className="line-clamp-2 break-words text-gray-100 hover:text-strong hover:underline"
      >
        {item.title}
      </Link>
    ) : (
      <span className="line-clamp-3 break-words text-gray-100">
        {item.title}
      </span>
    )}
    {item.detail && (
      <span className="mt-0.5 block break-words text-xs text-gray-400">
        {item.detail}
      </span>
    )}
  </>
);

const CheckRow = ({
  check,
  checkedAt,
  onChanged,
}: {
  check: HealthCheck;
  /** When the checks were last run; a new time means a fresh answer. */
  checkedAt: string;
  onChanged: () => void;
}) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  // Ten to a page. Page one comes with the check; others are fetched as they
  // are stepped to, keeping the current page on screen meanwhile.
  const [chosenPage, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(check.count / PAGE_SIZE));
  // A list that has shrunk since a later page was opened shows its last page.
  const page = Math.min(chosenPage, pages);
  const {
    data: paged,
    isValidating: pageLoading,
    mutate: refreshPage,
  } = useSWR<HealthCheck>(
    page > 1 ? `/api/v1/settings/health/checks/${check.id}?page=${page}` : null,
    { revalidateOnFocus: false, keepPreviousData: true }
  );
  // After Check Again, a later page is fetched again too, not left as it was.
  useEffect(() => {
    void refreshPage();
  }, [checkedAt, refreshPage]);
  const items = page > 1 && paged ? paged.items : check.items;
  const keys = itemKeys(items);

  const removeUnlinked = async () => {
    try {
      const { data } = await axios.delete<{ removed: number }>(
        '/api/v1/settings/health/unlinked-requests'
      );
      addToast(
        intl.formatMessage(messages.removedUnlinked, { count: data.removed }),
        { appearance: 'success', autoDismiss: true }
      );
      setPage(1);
      onChanged();
    } catch {
      addToast(intl.formatMessage(messages.removeFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };
  const name =
    check.name ??
    intl.formatMessage(
      messages[check.id as keyof typeof messages] ?? messages.none
    );
  const summary =
    check.group === 'services'
      ? check.status === 'ok'
        ? check.detail
        : check.reachable
          ? intl.formatMessage(messages.issues, { count: check.count })
          : intl.formatMessage(messages.unreachable)
      : check.count + (check.recentCount ?? 0) > 0
        ? String(check.count + (check.recentCount ?? 0))
        : intl.formatMessage(messages.none);
  const matchCheck = check.id === 'plexMatches';
  const recent = check.recent ?? [];
  // Match Check always opens: its setting is inside.
  const expandable =
    matchCheck ||
    check.items.length > 0 ||
    (check.status !== 'ok' && !!check.detail);

  const row = (open?: boolean) => (
    <div className="flex w-full items-center space-x-3 px-4 py-3 text-left">
      <StatusDot status={check.status} />
      <span className="min-w-0 flex-1 break-words text-sm font-medium text-gray-100">
        {name}
      </span>
      <span
        className={`flex-none text-sm ${
          check.status === 'ok' ? 'text-gray-400' : 'text-gray-200'
        }`}
      >
        {summary}
      </span>
      {expandable && (
        <ChevronDownIcon
          className={`h-4 w-4 flex-none text-gray-400 transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      )}
    </div>
  );

  if (!expandable) {
    return (
      <li className="border-b border-gray-700 last:border-b-0">{row()}</li>
    );
  }

  return (
    <li className="border-b border-gray-700 last:border-b-0">
      <Disclosure>
        {({ open }) => (
          <>
            <DisclosureButton className="w-full hover:bg-gray-700/40 focus:outline-none focus-visible:bg-gray-700/40">
              {row(open)}
            </DisclosureButton>
            <DisclosurePanel className="border-t border-gray-700 bg-gray-900/40 px-4 py-2">
              {matchCheck && <MatchOnImport />}
              {recent.length > 0 && (
                <div className="border-b border-gray-700 py-2">
                  <h5 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                    {intl.formatMessage(messages.recentRequests)}
                  </h5>
                  <ul>
                    {recent.map((item, index) => (
                      <li
                        key={`${item.at}-${index}`}
                        className="py-1.5 text-sm"
                      >
                        <ItemText item={item} />
                        {item.at && (
                          <span className="mt-0.5 block text-xs text-gray-500">
                            {intl.formatMessage(messages.foundAt, {
                              time: intl.formatDate(item.at, {
                                month: 'short',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                              }),
                            })}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {matchCheck && recent.length > 0 && (
                <h5 className="pt-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
                  {intl.formatMessage(messages.nightlyCheck)}
                </h5>
              )}
              {(check.group === 'services' || matchCheck) && check.detail && (
                <p
                  className={`py-1 text-sm ${
                    check.reachable || check.group !== 'services'
                      ? 'text-gray-400'
                      : 'text-red-300'
                  }`}
                >
                  {check.detail}
                </p>
              )}
              <ul className={pageLoading ? 'opacity-60' : undefined}>
                {items.map((item, index) => (
                  <li
                    key={keys[index]}
                    // Stacked: the title on its line, the detail wrapping
                    // beneath. Side by side, a long detail squeezed the
                    // title to a couple of letters on a phone.
                    className="py-1.5 text-sm"
                  >
                    <ItemText item={item} />
                    {item.searchable && (
                      <SearchButton
                        mediaId={item.searchable.mediaId}
                        is4k={item.searchable.is4k}
                        mediaType={item.searchable.mediaType}
                      />
                    )}
                  </li>
                ))}
              </ul>
              {check.group !== 'services' && pages > 1 && (
                <nav
                  className="mt-1 flex items-center justify-between py-1 text-xs"
                  aria-label={intl.formatMessage(messages.pageOf, {
                    page,
                    pages,
                  })}
                >
                  <button
                    type="button"
                    className="py-1 pr-3 text-indigo-400 hover:text-indigo-300 disabled:text-gray-600 light:text-accent-text light:hover:text-accent-text"
                    disabled={page === 1}
                    onClick={() => setPage(page - 1)}
                  >
                    ‹ {intl.formatMessage(messages.previous)}
                  </button>
                  <span className="text-gray-400">
                    {intl.formatMessage(messages.pageOf, { page, pages })}
                  </span>
                  <button
                    type="button"
                    className="py-1 pl-3 text-indigo-400 hover:text-indigo-300 disabled:text-gray-600 light:text-accent-text light:hover:text-accent-text"
                    disabled={page >= pages}
                    onClick={() => setPage(page + 1)}
                  >
                    {intl.formatMessage(messages.next)} ›
                  </button>
                </nav>
              )}
              {check.id === 'stuckProcessing' &&
                check.items.some((item) => item.searchable) && (
                  <SearchAll
                    onDone={() => {
                      setPage(1);
                      onChanged();
                    }}
                  />
                )}
              {check.id === 'unlinkedRequests' && check.count > 0 && (
                <div className="py-2">
                  <ConfirmButton
                    onClick={() => removeUnlinked()}
                    confirmText={intl.formatMessage(globalMessages.areyousure)}
                    className="w-full sm:w-auto"
                  >
                    <TrashIcon />
                    <span>
                      {intl.formatMessage(messages.removeUnlinked, {
                        count: check.count,
                      })}
                    </span>
                  </ConfirmButton>
                </div>
              )}
            </DisclosurePanel>
          </>
        )}
      </Disclosure>
    </li>
  );
};

/** What Download Check and the admin agent did this week, in a line each. */
const WeekActivity = ({ activity }: { activity: HealthActivity }) => {
  const intl = useIntl();
  const lines: string[] = [];
  const check = activity.downloadCheck;
  if (check) {
    const done =
      check.mode === 'report'
        ? intl.formatMessage(messages.weekDownloadCheckReport, {
            count: check.wouldHave,
          })
        : intl.formatMessage(messages.weekDownloadCheck, {
            rejected: check.rejected,
            imported: check.imported,
            cleared: check.cleared,
          });
    lines.push(
      check.failed
        ? `${done}, ${intl.formatMessage(messages.weekFailed, {
            count: check.failed,
          })}`
        : done
    );
  }
  const agent = activity.agent;
  if (agent) {
    const did = intl.formatMessage(messages.weekAgent, {
      conversations: agent.conversations,
      downloads: agent.downloads,
      imported: agent.imported,
      failed: agent.failed,
    });
    lines.push(
      agent.changes
        ? `${did}, ${intl.formatMessage(messages.weekAgentChanges, {
            count: agent.changes,
          })}`
        : did
    );
  }
  if (!lines.length) return null;
  return (
    <div className="mt-3 rounded-md border border-gray-700 bg-gray-800 px-4 py-3 text-sm shadow">
      <div className="mb-1 font-medium text-strong">
        {intl.formatMessage(messages.thisWeek)}
      </div>
      {lines.map((line) => (
        <p key={line} className="text-gray-400">
          {line}
        </p>
      ))}
    </div>
  );
};

const GROUPS: { id: HealthCheck['group']; label: keyof typeof messages }[] = [
  { id: 'services', label: 'services' },
  { id: 'backfill', label: 'backfill' },
  { id: 'requests', label: 'requests' },
  { id: 'media', label: 'media' },
  { id: 'users', label: 'users' },
];

/**
 * One screen for what is quietly wrong. Checked when opened and on demand,
 * not in the background: service checks make real calls, and a page nobody
 * is looking at should not be making them.
 */
const SettingsHealth = () => {
  const intl = useIntl();
  const { data, error, isValidating, mutate } = useSWR<HealthResponse>(
    '/api/v1/settings/health',
    { revalidateOnFocus: false }
  );

  const problems =
    data?.checks.filter((check) => check.status !== 'ok').length ?? 0;

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.health),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h3 className="heading">{intl.formatMessage(messages.health)}</h3>
          <p className="description">
            {intl.formatMessage(messages.healthDescription)}
          </p>
        </div>
        <Button
          buttonType="ghost"
          className="flex-none"
          disabled={isValidating}
          onClick={() => mutate()}
        >
          <ArrowPathIcon className={isValidating ? 'animate-spin' : ''} />
          <span>
            {intl.formatMessage(
              isValidating ? messages.checking : messages.checkAgain
            )}
          </span>
        </Button>
      </div>

      <ContainerResources />

      {!data && !error && <LoadingSpinner />}
      {error && !data && (
        <p className="text-sm text-red-300 light:text-danger-text">
          {error?.response?.data?.message ?? error.message}
        </p>
      )}

      {data && (
        <div className="section max-w-3xl space-y-8 xl:max-w-none">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusDot
              status={
                data.checks.some((check) => check.status === 'error')
                  ? 'error'
                  : problems > 0
                    ? 'warning'
                    : 'ok'
              }
            />
            <span className="text-lg font-semibold text-strong">
              {problems === 0
                ? intl.formatMessage(messages.allClear)
                : intl.formatMessage(messages.problems, { count: problems })}
            </span>
            <span className="basis-full text-sm text-gray-400 sm:basis-auto">
              {intl.formatMessage(messages.checkedAt, {
                time: intl.formatTime(data.checkedAt, {
                  hour: 'numeric',
                  minute: '2-digit',
                }),
              })}
            </span>
          </div>

          {/*
            One column on a phone; on a wide screen the groups sit side by
            side instead of leaving most of it empty.
          */}
          <div className="space-y-8 xl:grid xl:grid-cols-2 xl:items-start xl:gap-x-6 xl:gap-y-8 xl:space-y-0">
            {GROUPS.map((group) => {
              const checks = data.checks.filter((c) => c.group === group.id);
              // Backfill's group only shows while Backfill is on.
              if (!checks.length && group.id === 'backfill') {
                return null;
              }

              return (
                <div key={group.id}>
                  <h4 className="mb-2 text-sm font-semibold uppercase tracking-wider text-gray-400">
                    {intl.formatMessage(messages[group.label])}
                  </h4>
                  {checks.length === 0 ? (
                    group.id === 'services' && (
                      <p className="text-sm text-gray-400">
                        {intl.formatMessage(messages.noServices)}
                      </p>
                    )
                  ) : (
                    <ul className="overflow-hidden rounded-md border border-gray-700 bg-gray-800 shadow">
                      {checks.map((check) => (
                        <CheckRow
                          key={check.id}
                          check={check}
                          checkedAt={data.checkedAt}
                          onChanged={() => mutate()}
                        />
                      ))}
                    </ul>
                  )}
                  {group.id === 'backfill' && data.activity && (
                    <WeekActivity activity={data.activity} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
};

export default SettingsHealth;
